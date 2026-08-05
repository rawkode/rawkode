import EnchiridionCore
import Foundation
import Observation
@preconcurrency import UserNotifications

/// Foreground-only bridge from calendar projections to meeting prompts. It never
/// starts capture from a notification callback; an app supplies the foreground
/// action after the occurrence has been resolved again from its current calendar
/// projection.
@MainActor
@Observable
final class MeetingTranscriptionRuntime {
  static let shared = MeetingTranscriptionRuntime()

  private let scheduler = MeetingTranscriptionPromptScheduler.shared
  private var generation: UInt64 = 0
  private var resolver: MeetingPromptCalendarResolver?
  private var store: LibraryStore?
  private var repository: LibraryRepository?
  private var credentialStore: OpenAICredentialStore?
  private var providerSettings: AssistantProviderSettingsController?
  private var captureFactory: (() -> any MeetingAudioCapturing)?
  private(set) var activeEventPageID: PageID?
  private var active: Active?
  private(set) var failureMessage: String?

  func configure(
    store: LibraryStore,
    repository: LibraryRepository?,
    credentialStore: OpenAICredentialStore,
    providerSettings: AssistantProviderSettingsController,
    captureFactory: @escaping () -> any MeetingAudioCapturing
  ) {
    if active != nil { Task { await self.cancelActive() } }
    generation &+= 1
    let expected = generation
    self.store = store; self.repository = repository; self.credentialStore = credentialStore
    self.providerSettings = providerSettings; self.captureFactory = captureFactory
    let resolver = MeetingPromptCalendarResolver(
      vaultID: store.vaultID,
      events: { @MainActor in store.calendarEvents },
      scheduler: scheduler
    )
    self.resolver = resolver
    MeetingPromptNotificationCoordinator.shared.configure { [weak self, weak resolver] route in
      guard let self, let resolver else { return }
      await self.handle(route: route, resolver: resolver, generation: expected)
    }
    sweepTransientCloudAudio()
    reconcile(store: store, generation: expected)
  }

  func reconcile(store: LibraryStore) {
    reconcile(store: store, generation: generation)
  }

  func reconcileCurrent() {
    if let store { reconcile(store: store, generation: generation) }
  }

  func sweepTransientCloudAudio() {
    let activeSessionIDs = active.map { Set([$0.authority.sessionID]) } ?? []
    Task {
      guard let transientStore = try? MeetingTransientAudioStore() else { return }
      await transientStore.sweepStaleLeases(activeSessionIDs: activeSessionIDs)
    }
  }

  private func reconcile(store: LibraryStore, generation expected: UInt64) {
    let occurrences = store.calendarEvents.map { event in
      MeetingPromptOccurrence(
        vaultID: store.vaultID,
        eventPageID: .calendarOccurrence(event.identity),
        occurrenceKey: event.identity.canonicalOccurrenceKey,
        revision: Int(event.startDate.timeIntervalSinceReferenceDate.rounded()),
        startsAt: event.startDate,
        title: event.title
      )
    }
    let payload = currentSettings()
    Task { [scheduler] in
      if payload.promptsEnabled {
        let center = UNUserNotificationCenter.current()
        let notificationSettings = await center.notificationSettings()
        if notificationSettings.authorizationStatus == .notDetermined {
          _ = try? await center.requestAuthorization(options: [.alert, .sound])
        }
      }
      await scheduler.reconcile(occurrences, promptsEnabled: payload.promptsEnabled)
      guard !Task.isCancelled else { return }
      await MainActor.run {
        guard self.generation == expected else { return }
      }
    }
  }

  private func handle(
    route: MeetingPromptNotificationRoute,
    resolver: MeetingPromptCalendarResolver,
    generation expected: UInt64
  ) async {
    // A Skip is intentionally terminal and needs no page lookup. A Start is
    // revalidated by the Core scheduler before it reaches the foreground owner.
    guard route.action == .start else { return }
    let payload = currentSettings()
    guard let occurrence = await MeetingTranscriptionPromptScheduler.revalidatedAction(
      route, resolver: resolver, settings: payload
    ) else { return }
    guard generation == expected else { return }
    await begin(occurrence: occurrence, expectedGeneration: expected)
  }

  func isActive(eventPageID: PageID) -> Bool { activeEventPageID == eventPageID }

  func stopActiveSession() {
    Task { await stop() }
  }

  private func begin(occurrence: MeetingPromptOccurrence, expectedGeneration: UInt64) async {
    guard generation == expectedGeneration, active == nil,
      let store, let captureFactory
    else { return }
    failureMessage = nil
    guard let event = store.calendarEvents.first(where: { $0.identity.canonicalOccurrenceKey == occurrence.occurrenceKey }),
      let pageID = await store.openCalendarEventPage(event), pageID == occurrence.eventPageID
    else { failureMessage = "This calendar event is no longer available."; return }
    var resource: MeetingTranscriptResource?
    do {
      let authority = try makeAuthority(event: event, pageID: pageID, store: store)
      let initialResource = MeetingTranscriptResource(
        eventPageID: pageID,
        provenance: .init(captureAlgorithm: "meeting-audio", captureAlgorithmVersion: "1", transcriptionAlgorithm: authority.transcriptionRoute.route == .cloud ? "openai-diarize" : "apple-speech", transcriptionAlgorithmVersion: "1"),
        transcriptState: .inProgress,
        analysisState: .pending,
        semanticState: .pending
      )
      resource = initialResource
      _ = try await store.upsertMeetingTranscript(initialResource, for: event)
      let capture = captureFactory()
      if authority.transcriptionRoute.route == .cloud {
        guard let credentialStore else { throw MeetingAudioCaptureError.unavailable("Cloud transcription is not configured.") }
        let transientStore = try MeetingTransientAudioStore()
        await transientStore.sweepStaleLeases()
        let cloud = MeetingCloudTranscriber(store: transientStore, writer: MeetingCompressedAudioWriter(), credentialStore: credentialStore)
        let pipeline = MeetingCloudCapturePipeline(capture: capture, transcriber: cloud) { [weak self] error in
          await self?.unexpectedEnd(sessionID: authority.sessionID, error: error)
        }
        try await pipeline.start(authority: authority)
        active = .cloud(event: event, resource: initialResource, authority: authority, pipeline: pipeline)
      } else {
        let frames = try await capture.startCapture()
        let transcriber = MeetingOnDeviceSpeechTranscriber()
        let task = Task { try await transcriber.transcribe(frames) }
        active = .onDevice(event: event, resource: initialResource, authority: authority, capture: capture, task: task)
        Task { [weak self] in
          _ = await task.result
          await self?.unexpectedEnd(sessionID: authority.sessionID)
        }
      }
      activeEventPageID = pageID
    } catch {
      failureMessage = error.localizedDescription
      if var resource {
        resource.transcriptState = processingState(for: error)
        _ = try? await store.upsertMeetingTranscript(resource, for: event)
      }
    }
  }

  private func stop() async {
    guard let active, let store else { return }
    self.active = nil; activeEventPageID = nil
    var resource = active.resource
    do {
      let segments: [MeetingTranscriptSegment]
      switch active {
      case .cloud(_, _, _, let pipeline): segments = try await pipeline.stop().segments
      case .onDevice(_, _, _, let capture, let task): await capture.stopCapture(); segments = try await task.value
      }
      guard !segments.isEmpty else { throw MeetingSessionError.finalTranscriptRequired }
      resource.segments = segments; resource.transcriptState = .complete; resource.analysisState = .inProgress
      _ = try await store.upsertMeetingTranscript(resource, for: active.event)
      let snapshot = MeetingTranscriptSnapshot(resource: resource)
      guard let completion = active.authority.completion(transcriptHash: snapshot.hash) else { throw MeetingSessionError.staleAuthority }
      let allowed = analysisTags(from: active.authority, store: store)
      let analyzer: any MeetingAnalyzing
      if active.authority.analysisRoute.route == .cloud {
        guard let credentialStore else { throw MeetingAnalysisError.unauthorized }
        analyzer = MeetingCloudAnalyzer(credentialStore: credentialStore)
      } else { analyzer = MeetingOnDeviceAnalyzer() }
      guard let repository else { throw MeetingAnalysisError.unauthorized }
      let analysisCoordinator = MeetingAnalysisCoordinator(
        analyzer: analyzer,
        persistence: LibraryMeetingAnalysisStore(repository: repository, vaultID: store.vaultID)
      )
      let analysis = try await analysisCoordinator.analyze(
        final: snapshot,
        completion: completion,
        allowedSuperTags: allowed
      )
      resource.analysis = analysis; resource.analysisState = .complete; resource.semanticState = .inProgress
      _ = try await store.upsertMeetingTranscript(resource, for: active.event)
      guard !analysis.entityProposals.isEmpty else {
        resource.semanticState = .complete
        _ = try await store.upsertMeetingTranscript(resource, for: active.event)
        return
      }
      let semantic = MeetingSemanticMutationCoordinator(persistence: LibraryMeetingSemanticStore(repository: repository, vaultID: store.vaultID))
      let receipt = try await semantic.apply(.init(completion: completion, analysis: analysis, snapshot: snapshot))
      resource.semanticReceipt = receipt; resource.semanticState = .complete
      _ = try await store.upsertMeetingTranscript(resource, for: active.event)
    } catch {
      failureMessage = error.localizedDescription
      let state = processingState(for: error)
      if resource.transcriptState != .complete { resource.transcriptState = state }
      else if resource.analysisState != .complete { resource.analysisState = state }
      else { resource.semanticState = state }
      _ = try? await store.upsertMeetingTranscript(resource, for: active.event)
    }
  }

  private func makeAuthority(event: CalendarEventSnapshot, pageID: PageID, store: LibraryStore) throws -> MeetingAutomationAuthority {
    let now = Date()
    let allowed = store.supertags.filter { !$0.isDeleted }.map { definition in
      MeetingAllowedSupertagSnapshot(supertagID: definition.id, schemaFingerprint: MeetingSemanticSchemaFingerprint.value(for: definition), allowedFieldIDs: definition.fields.filter { !$0.isDeleted }.map(\.id), allowedRelationIDs: definition.relationIDs)
    }
    let expires = min(now.addingTimeInterval(MeetingTranscriptResource.maximumDurationSeconds), max(event.endDate.addingTimeInterval(60 * 60), now.addingTimeInterval(60 * 60)))
    if currentSettings().route == .cloud {
      let route = providerSettings?.textRouteSnapshot(for: .init(provider: .openAI))
      guard let route, route.provider == .openAI, route.authorizationFailure == nil,
        let model = route.modelID, let binding = route.credentialBinding
      else { throw MeetingAudioCaptureError.unavailable("Cloud transcription needs a verified OpenAI text provider in Settings.") }
      return .init(vaultID: store.vaultID, eventPageID: pageID, occurrenceKey: event.identity.canonicalOccurrenceKey, transcriptionRoute: .init(route: .cloud, cloudReadiness: .notRequired, cloudModelID: "gpt-4o-transcribe-diarize", credentialBinding: binding), analysisRoute: .init(route: .cloud, cloudModelID: model, credentialBinding: binding), issuedAt: now, expiresAt: expires, allowedSupertags: allowed)
    }
    return .init(vaultID: store.vaultID, eventPageID: pageID, occurrenceKey: event.identity.canonicalOccurrenceKey, transcriptionRoute: .init(route: .onDevice, cloudReadiness: .notRequired), analysisRoute: .init(route: .onDevice), issuedAt: now, expiresAt: expires, allowedSupertags: allowed)
  }

  private func analysisTags(from authority: MeetingAutomationAuthority, store: LibraryStore) -> [MeetingAnalysisSuperTag] {
    authority.allowedSupertags.compactMap { allowed in
      guard let definition = store.supertags.first(where: { $0.id == allowed.supertagID && !$0.isDeleted }) else { return nil }
      return .init(id: PageID(rawValue: definition.id.rawValue), name: definition.name, propertyNames: definition.fields.filter { !$0.isDeleted }.map(\.name))
    }
  }

  /// Settings owns persistence; fetching a fresh value here makes a Settings
  /// change affect the next foreground Start immediately while the authority of
  /// an already-active meeting remains immutable.
  private func currentSettings() -> MeetingTranscriptionSettingsPayload {
    let settings = MeetingTranscriptionSettings()
    return .init(promptsEnabled: settings.promptsEnabled, route: settings.route)
  }

  private func processingState(for error: Error) -> MeetingProcessingState {
    if let error = error as? MeetingCloudTranscriptionError, error == .audioTooLarge { return .resourceLimit }
    if let error = error as? MeetingTranscriptError, error == .resourceLimit || error == .changeTooLarge { return .resourceLimit }
    return .failed
  }

  private func cancelActive() async {
    guard let active else { return }
    self.active = nil; activeEventPageID = nil
    switch active {
    case .cloud(_, _, _, let pipeline): await pipeline.cancel()
    case .onDevice(_, _, _, let capture, let task): await capture.stopCapture(); task.cancel()
    }
    if let store {
      var resource = active.resource
      resource.transcriptState = .incomplete
      _ = try? await store.upsertMeetingTranscript(resource, for: active.event)
    }
  }

  private func unexpectedEnd(sessionID: UUID, error: Error? = nil) async {
    guard let active, active.authority.sessionID == sessionID else { return }
    self.active = nil; activeEventPageID = nil
    switch active {
    case .cloud(_, _, _, let pipeline): await pipeline.cancel()
    case .onDevice(_, _, _, let capture, _): await capture.stopCapture()
    }
    var resource = active.resource
    resource.transcriptState = error.map(processingState(for:)) ?? .incomplete
    failureMessage = error?.localizedDescription ?? "Meeting capture ended before you stopped it."
    if let store { _ = try? await store.upsertMeetingTranscript(resource, for: active.event) }
  }

  private enum Active {
    case cloud(event: CalendarEventSnapshot, resource: MeetingTranscriptResource, authority: MeetingAutomationAuthority, pipeline: MeetingCloudCapturePipeline)
    case onDevice(event: CalendarEventSnapshot, resource: MeetingTranscriptResource, authority: MeetingAutomationAuthority, capture: any MeetingAudioCapturing, task: Task<[MeetingTranscriptSegment], Error>)
    var event: CalendarEventSnapshot { switch self { case .cloud(let event, _, _, _), .onDevice(let event, _, _, _, _): event } }
    var resource: MeetingTranscriptResource { switch self { case .cloud(_, let resource, _, _), .onDevice(_, let resource, _, _, _): resource } }
    var authority: MeetingAutomationAuthority { switch self { case .cloud(_, _, let authority, _), .onDevice(_, _, let authority, _, _): authority } }
  }
}

/// Reconstructs the opaque notification identifier from authoritative current
/// CalendarEventSnapshots. It deliberately ignores notification content.
private actor MeetingPromptCalendarResolver: MeetingPromptOccurrenceResolving {
  private let vaultID: VaultID
  private let events: @MainActor @Sendable () -> [CalendarEventSnapshot]
  private let scheduler: MeetingTranscriptionPromptScheduler

  init(
    vaultID: VaultID,
    events: @escaping @MainActor @Sendable () -> [CalendarEventSnapshot],
    scheduler: MeetingTranscriptionPromptScheduler
  ) {
    self.vaultID = vaultID
    self.events = events
    self.scheduler = scheduler
  }

  func occurrence(forNotificationID identifier: String) async -> MeetingPromptOccurrence? {
    let currentEvents = await MainActor.run(body: events)
    for event in currentEvents {
      let occurrence = MeetingPromptOccurrence(
        vaultID: vaultID,
        eventPageID: .calendarOccurrence(event.identity),
        occurrenceKey: event.identity.canonicalOccurrenceKey,
        revision: occurrenceRevision(event),
        startsAt: event.startDate,
        title: event.title
      )
      if scheduler.identifier(for: occurrence) == identifier { return occurrence }
    }
    return nil
  }

  private func occurrenceRevision(_ event: CalendarEventSnapshot) -> Int {
    Int(event.startDate.timeIntervalSinceReferenceDate.rounded())
  }
}

/// The app has one UserNotifications delegate. This small router lets the task
/// reminder delegate also forward meeting actions without allowing either action
/// to touch microphone or ScreenCaptureKit while backgrounded.
@MainActor
final class MeetingPromptNotificationCoordinator {
  static let shared = MeetingPromptNotificationCoordinator()
  private var handler: (@Sendable (MeetingPromptNotificationRoute) async -> Void)?

  func configure(handler: @escaping @Sendable (MeetingPromptNotificationRoute) async -> Void) {
    self.handler = handler
  }

  nonisolated func handle(_ response: UNNotificationResponse) async -> Bool {
    guard let route = MeetingTranscriptionPromptScheduler.route(
      actionIdentifier: response.actionIdentifier,
      userInfo: response.notification.request.content.userInfo,
      defaultActionIdentifier: UNNotificationDefaultActionIdentifier
    ) else { return false }
    let handler = await MainActor.run { self.handler }
    await handler?(route)
    return true
  }
}
