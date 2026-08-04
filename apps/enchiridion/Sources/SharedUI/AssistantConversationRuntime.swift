import EnchiridionCore
import Foundation

#if os(iOS)
  import AVFoundation

  enum HandheldConversationAudioSessionError: Error, Equatable {
    case leaseUnavailable
  }

  /// Process-wide ownership is deliberately separate from each controller's
  /// lifecycle. A controller can release only its own opaque lease.
  actor HandheldConversationAudioLeaseCoordinator {
    static let shared = HandheldConversationAudioLeaseCoordinator()
    private var owner: UUID?
    private var generation: UInt64 = 0

    func acquire(_ candidate: UUID) throws -> UInt64 {
      guard owner == nil || owner == candidate else {
        throw HandheldConversationAudioSessionError.leaseUnavailable
      }
      owner = candidate
      generation &+= 1
      return generation
    }

    func release(_ candidate: UUID, generation expected: UInt64) {
      guard owner == candidate, generation == expected else { return }
      owner = nil
    }

    func reset(_ candidate: UUID, generation expected: UInt64?) {
      guard owner == candidate, expected == generation else { return }
      owner = nil
      generation &+= 1
    }
  }

  protocol HandheldConversationAudioSessionBacking: AnyObject, Sendable {
    func setCategory(
      _ category: AVAudioSession.Category,
      mode: AVAudioSession.Mode,
      options: AVAudioSession.CategoryOptions
    ) throws
    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws
    func activateConfigured() async throws
    func deactivateConfigured() async throws
  }

  private final class SystemHandheldConversationAudioSessionBackend:
    HandheldConversationAudioSessionBacking, @unchecked Sendable
  {
    private let audioSession: AVAudioSession
    private let fallbackQueue = DispatchQueue(label: "dev.rawkode.enchiridion.audio-session.fallback")

    init(audioSession: AVAudioSession = .sharedInstance()) {
      self.audioSession = audioSession
    }

    func setCategory(
      _ category: AVAudioSession.Category,
      mode: AVAudioSession.Mode,
      options: AVAudioSession.CategoryOptions
    ) throws {
      try audioSession.setCategory(category, mode: mode, options: options)
    }

    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
      try audioSession.setActive(active, options: options)
    }

    func activateConfigured() async throws {
      if #available(iOS 27.0, *) {
        try await withCheckedThrowingContinuation { continuation in
          audioSession.activate(options: []) { activated, error in
            if activated { continuation.resume() }
            else { continuation.resume(throwing: error ?? HandheldConversationAudioSessionError.leaseUnavailable) }
          }
        }
      } else {
        try await onFallbackQueue { try self.audioSession.setActive(true, options: []) }
      }
    }

    func deactivateConfigured() async throws {
      if #available(iOS 27.0, *) {
        try await withCheckedThrowingContinuation { continuation in
          audioSession.deactivate(options: [.notifyOthersOnDeactivation]) { deactivated, error in
            if deactivated { continuation.resume() }
            else { continuation.resume(throwing: error ?? HandheldConversationAudioSessionError.leaseUnavailable) }
          }
        }
      } else {
        try await onFallbackQueue { try self.audioSession.setActive(false, options: .notifyOthersOnDeactivation) }
      }
    }


    private func onFallbackQueue(_ work: @escaping @Sendable () throws -> Void) async throws {
      try await withCheckedThrowingContinuation { continuation in
        fallbackQueue.async {
          do { try work(); continuation.resume() }
          catch { continuation.resume(throwing: error) }
        }
      }
    }
  }

  @MainActor
  final class HandheldConversationAudioSessionController:
    AssistantConversationAudioSessionControlling, RealtimeAudioSessionControlling
  {
    private let backend: any HandheldConversationAudioSessionBacking
    private var lifecycle = AssistantAudioSessionLifecycleState()
    private let ownerID = UUID()
    private var leaseGeneration: UInt64?
    private enum Phase: Equatable { case idle, activating, active, deactivating }
    private var phase: Phase = .idle
    private let operationQueue = DispatchQueue(
      label: "dev.rawkode.enchiridion.audio-session", qos: .userInitiated
    )
    private var operationGeneration: UInt64 = 0
    private let forceLegacyActivationForTesting: Bool

    var isActiveForTesting: Bool { lifecycle.isActive }

    init(
      backend: any HandheldConversationAudioSessionBacking =
        SystemHandheldConversationAudioSessionBackend(),
      forceLegacyActivationForTesting: Bool = false
    ) {
      self.backend = backend
      self.forceLegacyActivationForTesting = forceLegacyActivationForTesting
    }

    func activate() async throws {
      guard phase == .idle else {
        if phase == .active { return }
        throw HandheldConversationAudioSessionError.leaseUnavailable
      }
      phase = .activating
      operationGeneration &+= 1
      let activationGeneration = operationGeneration
      let lease: UInt64
      do {
        lease = try await HandheldConversationAudioLeaseCoordinator.shared.acquire(ownerID)
      } catch {
        // A contender which failed to acquire must remain retryable. Do not
        // overwrite a newer reset/transition that occurred while awaiting the
        // process-wide coordinator.
        if activationGeneration == operationGeneration, phase == .activating {
          phase = .idle
        }
        throw error
      }
      guard activationGeneration == operationGeneration, phase == .activating else {
        await HandheldConversationAudioLeaseCoordinator.shared.release(ownerID, generation: lease)
        if phase == .activating { phase = .idle }
        throw CancellationError()
      }
      var acquired = true
      defer {
        if acquired {
          // Ownership becomes durable only after AVAudioSession succeeds.
          Task { await HandheldConversationAudioLeaseCoordinator.shared.release(self.ownerID, generation: lease) }
          self.phase = .idle
        }
      }
      if !lifecycle.isConfigured {
        try await performOnAudioQueue { backend in
          try backend.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        }
        lifecycle.didConfigure()
      }
      if forceLegacyActivationForTesting {
        try await performOnAudioQueue { backend in try backend.setActive(true, options: []) }
      } else {
        try await backend.activateConfigured()
      }
      guard activationGeneration == operationGeneration, phase == .activating else {
        // A reset/newer owner may now control the process-wide session. Never
        // compensate a stale completion by deactivating physical audio here.
        throw CancellationError()
      }
      lifecycle.didActivate()
      leaseGeneration = lease
      phase = .active
      acquired = false
    }

    func deactivate() async {
      guard phase == .active else { return }
      phase = .deactivating
      operationGeneration &+= 1
      try? await backend.deactivateConfigured()
      lifecycle.didDeactivate()
      if let leaseGeneration {
        await HandheldConversationAudioLeaseCoordinator.shared.release(ownerID, generation: leaseGeneration)
        self.leaseGeneration = nil
      }
      phase = .idle
    }

    func resetAfterMediaServicesReset() async {
      lifecycle.resetAfterMediaServicesReset()
      operationGeneration &+= 1
      // Native activation/deactivation can still be in flight. Keep its lease
      // until that callback completes so another controller cannot overlap the
      // physical AVAudioSession transition.
      guard phase != .activating && phase != .deactivating else { return }
      phase = .idle
      let lease = leaseGeneration
      leaseGeneration = nil
      await HandheldConversationAudioLeaseCoordinator.shared.reset(ownerID, generation: lease)
    }

    private func performOnAudioQueue(
      _ operation: @escaping @Sendable (any HandheldConversationAudioSessionBacking) throws -> Void
    ) async throws {
      let backend = backend
      try await withCheckedThrowingContinuation { continuation in
        operationQueue.async {
          do {
            try operation(backend)
            continuation.resume()
          } catch {
            continuation.resume(throwing: error)
          }
        }
      }
    }
  }

  private final class NotificationObserverLifetime: @unchecked Sendable {
    private let notificationCenter: NotificationCenter
    private let lock = NSLock()
    private var observers: [NSObjectProtocol] = []

    init(notificationCenter: NotificationCenter) {
      self.notificationCenter = notificationCenter
    }

    func append(_ observer: NSObjectProtocol) {
      lock.withLock { observers.append(observer) }
    }

    func cancel() {
      let removed = lock.withLock {
        let removed = observers
        observers.removeAll()
        return removed
      }
      for observer in removed {
        notificationCenter.removeObserver(observer)
      }
    }

    deinit {
      cancel()
    }
  }

  final class HandheldConversationAudioEventSource:
    AssistantVoiceSafetyEventSource, @unchecked Sendable
  {
    private let notificationCenter: NotificationCenter
    private let audioSession: AVAudioSession

    init(
      notificationCenter: NotificationCenter = .default,
      audioSession: AVAudioSession = .sharedInstance()
    ) {
      self.notificationCenter = notificationCenter
      self.audioSession = audioSession
    }

    func events() -> AsyncStream<AssistantVoiceSafetyEvent> {
      AsyncStream { continuation in
        let lifetime = NotificationObserverLifetime(notificationCenter: notificationCenter)
        observe(AVAudioSession.interruptionNotification, lifetime: lifetime) { notification in
          guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let event = AssistantVoiceSafetyNotificationParser.interruption(rawType: rawType)
          else { return }
          continuation.yield(event)
        }
        observe(AVAudioSession.routeChangeNotification, lifetime: lifetime) {
          [weak self] notification in
          guard let self,
            let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
          else { return }
          let previous =
            (notification.userInfo?[AVAudioSessionRouteChangePreviousRouteKey]
            as? AVAudioSessionRouteDescription).map(Self.snapshot)
          let current = Self.snapshot(audioSession.currentRoute)
          if let event = AssistantVoiceSafetyNotificationParser.routeChange(
            rawReason: rawReason,
            previous: previous,
            current: current
          ) {
            continuation.yield(event)
          }
        }
        observe(AVAudioSession.mediaServicesWereLostNotification, lifetime: lifetime) { _ in
          continuation.yield(.mediaServicesLost)
        }
        observe(AVAudioSession.mediaServicesWereResetNotification, lifetime: lifetime) { _ in
          continuation.yield(.mediaServicesReset)
        }
        continuation.onTermination = { _ in lifetime.cancel() }
      }
    }

    private func observe(
      _ name: Notification.Name,
      lifetime: NotificationObserverLifetime,
      using block: @escaping @Sendable (Notification) -> Void
    ) {
      lifetime.append(
        notificationCenter.addObserver(
          forName: name, object: audioSession, queue: nil, using: block)
      )
    }

    private static func snapshot(
      _ route: AVAudioSessionRouteDescription
    ) -> AssistantAudioRouteSnapshot {
      AssistantAudioRouteSnapshot(
        inputs: route.inputs.map { port($0.portType) },
        outputs: route.outputs.map { port($0.portType) }
      )
    }

    private static func port(_ type: AVAudioSession.Port) -> AssistantAudioPort {
      switch type {
      case .builtInMic: .builtInMic
      case .builtInReceiver: .builtInReceiver
      case .builtInSpeaker: .builtInSpeaker
      case .headphones: .headphones
      case .headsetMic: .headsetMic
      case .bluetoothA2DP: .bluetoothA2DP
      case .bluetoothHFP: .bluetoothHFP
      case .bluetoothLE: .bluetoothLE
      case .usbAudio: .usbAudio
      case .airPlay: .airPlay
      case .carAudio: .carAudio
      case .HDMI: .hdmi
      case .lineIn: .lineIn
      case .lineOut: .lineOut
      default: .other
      }
    }
  }
#elseif os(macOS)
  import AVFoundation

  private final class MacNotificationObserverLifetime: @unchecked Sendable {
    private let notificationCenter: NotificationCenter
    private let lock = NSLock()
    private var observer: NSObjectProtocol?

    init(notificationCenter: NotificationCenter) {
      self.notificationCenter = notificationCenter
    }

    func store(_ observer: NSObjectProtocol) {
      lock.withLock { self.observer = observer }
    }

    func cancel() {
      let removed = lock.withLock {
        defer { observer = nil }
        return observer
      }
      if let removed {
        notificationCenter.removeObserver(removed)
      }
    }

    deinit {
      cancel()
    }
  }

  final class MacVoiceDeviceChangeEventSource:
    AssistantVoiceSafetyEventSource, @unchecked Sendable
  {
    private let notificationCenter: NotificationCenter

    init(notificationCenter: NotificationCenter = .default) {
      self.notificationCenter = notificationCenter
    }

    func events() -> AsyncStream<AssistantVoiceSafetyEvent> {
      AsyncStream { continuation in
        let lifetime = MacNotificationObserverLifetime(notificationCenter: notificationCenter)
        lifetime.store(
          notificationCenter.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: nil,
            queue: nil
          ) { _ in
            continuation.yield(.mediaServicesReset)
          }
        )
        continuation.onTermination = { _ in lifetime.cancel() }
      }
    }
  }
#endif

enum AssistantConversationSurface: Equatable {
  case app
  case carPlay
}

#if DEBUG
  private actor DelayedOptimisticChatFixtureAnswerer: AssistantConversationAnswering {
    func respond(to request: AssistantConversationRequest) async -> GroundedAssistantResponse {
      let route = request.routeOverride ?? .appleOnDevice
      let routeLabel: String
      if route.provider == .openAI {
        routeLabel = route.modelID.map { "OpenAI · \($0)" } ?? "OpenAI"
      } else {
        routeLabel = "Apple On Device"
      }
      do {
        try await Task.sleep(for: .seconds(30))
      } catch {
        return GroundedAssistantResponse(
          answer: "Response stopped",
          status: .unavailable,
          metadata: AssistantResponseMetadata(
            requestedProvider: route.provider,
            requestedModelID: route.modelID,
            routeLabel: routeLabel,
            requestIDs: ["debug_delayed_cancelled"],
            completion: .incomplete,
            recoveryAction: .retry
          )
        )
      }
      return GroundedAssistantResponse(
        answer: "This delayed response replaced the pending bubble without adding another turn.",
        status: .answered,
        metadata: AssistantResponseMetadata(
          requestedProvider: route.provider,
          requestedModelID: route.modelID,
          actualModelID: route.modelID,
          routeLabel: routeLabel,
          requestIDs: ["debug_delayed_completed"]
        )
      )
    }

    func resetConversation() async {}
  }
#endif

@MainActor
func makeAssistantConversationSession(
  assistant: (any AssistantConversationAnswering)?,
  voicePreferences: AssistantVoicePreferences,
  surface: AssistantConversationSurface = .app
) -> AssistantConversationSession? {
  #if DEBUG
    if surface == .app,
      ProcessInfo.processInfo.arguments.contains("-AssistantOptimisticChatFixture")
    {
      return AssistantConversationSession(answerer: DelayedOptimisticChatFixtureAnswerer())
    }
  #endif
  guard let assistant else { return nil }
  if #available(iOS 26.0, macOS 26.0, *) {
    #if os(iOS)
      let audioSessionController: (any AssistantConversationAudioSessionControlling)? =
        surface == .app ? HandheldConversationAudioSessionController() : nil
      let voiceSafetyEventSource: (any AssistantVoiceSafetyEventSource)? =
        surface == .app ? HandheldConversationAudioEventSource() : nil
    #else
      let audioSessionController: (any AssistantConversationAudioSessionControlling)? = nil
      let voiceSafetyEventSource: (any AssistantVoiceSafetyEventSource)? =
        surface == .app ? MacVoiceDeviceChangeEventSource() : nil
    #endif
    return AssistantConversationSession(
      transcriber: OnDeviceSpeechTranscriber(),
      answerer: assistant,
      speaker: AppleSystemSpeechOutput(
        voicePreferences: voicePreferences,
        speechOwner: surface == .carPlay ? .carPlay : .assistant
      ),
      audioSessionController: audioSessionController,
      voiceSafetyEventSource: voiceSafetyEventSource,
      speaksResponses: true
    )
  }
  return AssistantConversationSession(answerer: assistant)
}

func assistantUnavailabilityMessage(
  assistant: FoundationModelAssistant?,
  repositoryError: String?
) -> String? {
  if let repositoryError { return "Your local library could not be opened: \(repositoryError)" }
  guard assistant != nil else { return "Your local library is unavailable." }
  let availability = FoundationModelAssistant.availability()
  return availability == .available ? nil : availability.message
}
