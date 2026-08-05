import Foundation
import Observation

public enum LibraryReloadPolicy: Equatable, Sendable {
  case refreshOnly
  case reconcileSystemState
}

public struct TaskCompletionUndoOffer: Equatable, Sendable {
  public let taskTitle: String
  public let receipt: TaskCompletionUndoReceipt

  public init(taskTitle: String, receipt: TaskCompletionUndoReceipt) {
    self.taskTitle = taskTitle
    self.receipt = receipt
  }

  public init?(completion: TaskCompletionResult) {
    guard let receipt = completion.undoReceipt else { return nil }
    self.init(taskTitle: completion.completed.displayTitle, receipt: receipt)
  }
}

public struct ProjectClosureUndoOffer: Equatable, Sendable {
  public let projectTitle: String
  public let resolution: ProjectClosureResolution
  public let affectedTaskCount: Int
  public let receipt: ProjectClosureUndoReceipt

  public init?(_ outcome: ProjectClosureOutcome) {
    guard let receipt = outcome.undoReceipt else { return nil }
    projectTitle = outcome.project.displayTitle
    resolution = receipt.resolution
    affectedTaskCount = outcome.affectedTasks.count
    self.receipt = receipt
  }
}

public struct TaskClarificationUndoOffer: Equatable, Sendable {
  public let taskTitle: String
  public let action: TaskClarificationActionKind
  public let receipt: TaskClarificationUndoReceipt

  public init(_ result: TaskClarificationMutationResult) {
    taskTitle = result.task.displayTitle
    action = result.undoReceipt.action
    receipt = result.undoReceipt
  }
}

/// The contact-link shape that can affect a Tasks-home person row. Refresh
/// timestamps are deliberately excluded: refreshing unchanged device data
/// must not invalidate every observing SwiftUI view.
private struct ContactLinkUIPresentation: Hashable {
  let pageID: PageID
  let contactIdentifier: String
  let matchedEmail: String
  let recordIdentifier: String
  let displayName: String
  let organizationName: String?
  let jobTitle: String?
  let emails: [String]
  let phoneNumbers: [String]
  let birthday: ContactBirthday?
  let thumbnailData: Data?

  init(_ link: PersonContactLink) {
    pageID = link.pageID
    contactIdentifier = link.contactIdentifier
    matchedEmail = link.matchedEmail
    recordIdentifier = link.record.identifier
    displayName = link.record.displayName
    organizationName = link.record.organizationName
    jobTitle = link.record.jobTitle
    emails = link.record.emails.sorted()
    phoneNumbers = link.record.phoneNumbers.sorted()
    birthday = link.record.birthday
    thumbnailData = link.record.thumbnailData
  }
}

public enum TaskClarificationMutationResponse: Sendable {
  case applied(TaskClarificationMutationResult)
  case stale(String)
  case failed(String)
}

@MainActor
@Observable
public final class LibraryStore {
  public private(set) var vaultID: VaultID
  public private(set) var pages: [PageSnapshot] = []
  public private(set) var calendarEvents: [CalendarEventSnapshot] = []
  /// Whether the initial local calendar agenda query has reached a terminal state.
  /// This is intentionally independent from provider and full-library reload state.
  public private(set) var calendarAgendaIsReady = false
  public private(set) var calendarAgendaLoadError: String?
  /// Changes whenever the provider-backed calendar projection is refreshed or reloaded.
  /// Relationship screens use this as a cheap observable invalidation token.
  public private(set) var calendarRelationshipGeneration: UInt64 = 0
  public private(set) var calendarPageContexts: [PageID: CalendarPageContext] = [:]
  public private(set) var supertags: [SupertagDefinition] = []
  public private(set) var savedViews: [LiveQueryDefinition] = []
  public private(set) var liveViewItems: [LiveQueryID: [LiveQueryItem]] = [:]
  public private(set) var whiteboardDocuments: [LiveQueryID: WhiteboardDocument] = [:]
  public private(set) var omissionPrefixes: [String] = CalendarEventOmissionRules.defaultPrefixes
  public private(set) var calendarEventMaterializationEnabled = false
  public private(set) var otherPeople: [PageSnapshot] = []
  public private(set) var contactLinks: [PageID: PersonContactLink] = [:]
  public private(set) var syncStatus: SyncStatus = .localOnly
  public private(set) var isLoading = true
  public private(set) var startupError: String?
  public private(set) var taskMutationWarnings: [TaskMutationWarning] = []
  public private(set) var latestTaskCompletionUndoOffer: TaskCompletionUndoOffer?
  public private(set) var taskCompletionUndoFailure: String?
  public private(set) var latestProjectClosureUndoOffer: ProjectClosureUndoOffer?
  public private(set) var projectClosureUndoFailure: String?
  public private(set) var latestTaskClarificationUndoOffer: TaskClarificationUndoOffer?
  public private(set) var taskClarificationUndoFailure: String?
  public private(set) var taskClarificationError: String?
  public private(set) var calendarError: String?
  public private(set) var whiteboardError: String?
  public var selectedPageID: PageID?

  @ObservationIgnored var repository: LibraryRepository?
  @ObservationIgnored private var syncCoordinator: CloudSyncCoordinator?
  @ObservationIgnored private var calendarProvider: EventKitCalendarProvider?
  @ObservationIgnored private var googleCalendarProvider: GoogleCalendarProvider?
  @ObservationIgnored private var contactResolver: (any DeviceContactResolving)?
  @ObservationIgnored private let calendar: Calendar
  @ObservationIgnored private let taskInterpreter: any TaskInputInterpreting
  @ObservationIgnored private let taskSystemReconciliationCoordinator:
    TaskSystemReconciliationCoordinator
  @ObservationIgnored private var reloadGeneration: UInt64 = 0
  @ObservationIgnored private var editorLiveViewRefreshGeneration: UInt64 = 0
  @ObservationIgnored private var calendarRefreshGenerations: [String: UInt64] = [:]
  @ObservationIgnored private var taskMutationCoordinator: TaskMutationCoordinator?
  @ObservationIgnored private var undoOfferGeneration: UInt64 = 0
  @ObservationIgnored private let requestedVaultID: VaultID?
  @ObservationIgnored private let taskMutationEffects: TaskMutationEffectExecutor?
  @ObservationIgnored private let pageSynchronizationObserver: (@Sendable (PageID) async -> Void)?
  @ObservationIgnored private let shouldOpenRepository: Bool
  @ObservationIgnored private var isOpeningRepository = false

  public init(
    vaultID: VaultID? = nil,
    repository: LibraryRepository? = nil,
    calendar: Calendar = .current,
    contactResolver: (any DeviceContactResolving)? = nil,
    startImmediately: Bool = true,
    taskSystemReconciliationCoordinator: TaskSystemReconciliationCoordinator = .shared,
    taskMutationEffects: TaskMutationEffectExecutor? = nil,
    taskInterpreter: any TaskInputInterpreting = FoundationTaskInterpreter(),
    pageSynchronizationObserver: (@Sendable (PageID) async -> Void)? = nil
  ) {
    self.vaultID = vaultID ?? .standalone
    self.calendar = calendar
    self.taskInterpreter = taskInterpreter
    self.contactResolver = contactResolver
    self.taskSystemReconciliationCoordinator = taskSystemReconciliationCoordinator
    self.repository = repository
    requestedVaultID = vaultID
    self.taskMutationEffects = taskMutationEffects
    self.pageSynchronizationObserver = pageSynchronizationObserver
    shouldOpenRepository = repository == nil
    startupError = nil
    if let repository { configureTaskMutationCoordinator(repository: repository) }
    if startImmediately {
      Task { await start() }
    }
  }

  public var selectedPage: PageSnapshot? {
    guard let selectedPageID else { return nil }
    return page(id: selectedPageID)
  }

  public func page(id: PageID) -> PageSnapshot? {
    pages.first { $0.id == id } ?? otherPeople.first { $0.id == id }
  }

  public func calendarPageContext(for pageID: PageID) -> CalendarPageContext? {
    calendarPageContexts[pageID]
  }

  public var calendarEventGroups: [CalendarEventGroup] {
    let grouped = Dictionary(grouping: calendarEvents) { event in
      event.identity.series?.canonicalKey ?? "occurrence\u{0}\(event.identity.stableKey)"
    }
    return grouped.map { key, events in
      let ordered = events.sorted { $0.startDate < $1.startDate }
      return CalendarEventGroup(
        id: key,
        title: ordered.first?.title ?? "Untitled event",
        series: ordered.first?.identity.series,
        events: ordered
      )
    }.sorted {
      ($0.events.first?.startDate ?? .distantFuture)
        < ($1.events.first?.startDate ?? .distantFuture)
    }
  }

  public func pages(in section: LibrarySection, matching query: String = "") -> [PageSnapshot] {
    let today = DayKey(date: Date(), calendar: calendar)
    let scoped = pages.filter { page in
      switch section {
      case .today:
        guard page.deletedAt == nil, case .daily(let day) = page.kind else { return false }
        return day == today
      case .calendar:
        return false
      case .allPages:
        return page.deletedAt == nil
      case .pinned:
        return page.deletedAt == nil && page.isPinned
      case .trash:
        return page.deletedAt != nil
      }
    }
    let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return scoped }
    return scoped.filter {
      $0.title.localizedStandardContains(value) || $0.plainText.localizedStandardContains(value)
    }
  }

  public func pagesCreatedOrModified(on date: Date) -> [PageSnapshot] {
    guard let interval = calendar.dateInterval(of: .day, for: date) else { return [] }
    return
      pages
      .filter { page in
        page.deletedAt == nil
          && (interval.contains(page.createdAt) || interval.contains(page.modifiedAt))
      }
      .sorted { lhs, rhs in
        if lhs.modifiedAt != rhs.modifiedAt { return lhs.modifiedAt < rhs.modifiedAt }
        return lhs.displayTitle.localizedStandardCompare(rhs.displayTitle) == .orderedAscending
      }
  }

  public func start() async {
    if repository == nil, shouldOpenRepository {
      guard !isOpeningRepository else { return }
      isOpeningRepository = true
      do {
        let selection = requestedVaultID.map(VaultSelection.vault) ?? .selected
        let context = try await Task.detached(priority: .userInitiated) {
          try VaultRepositoryContext.open(selection)
        }.value
        repository = context.repository
        vaultID = context.vault.id
        configureTaskMutationCoordinator(repository: context.repository)
      } catch {
        startupError = error.localizedDescription
        isLoading = false
        resolveCalendarAgendaInitialLoad(error: startupError)
      }
      isOpeningRepository = false
    }
    guard let repository else {
      isLoading = false
      resolveCalendarAgendaInitialLoad(error: startupError)
      return
    }
    do {
      let today = try await repository.dailyPage(for: DayKey(date: Date(), calendar: calendar))
      selectedPageID = selectedPageID ?? today.id
      let pendingEffectOutcomes = await taskMutationCoordinator?.drainPendingEffects() ?? []
      taskMutationWarnings = pendingEffectOutcomes.compactMap(\.warning)
      guard await reload() != nil else { return }
      // Legacy local projections predate Event pages. Adopt them on startup so
      // the normal dirty-page/CloudKit path sees existing calendar content.
      let upgradeReceipt = try await repository.materializeActiveCalendarProjectionForUpgrade()
      calendarEventMaterializationEnabled = true
      for pageID in upgradeReceipt.changedPageIDs {
        await syncCoordinator?.pageDidChange(pageID)
      }
      if !upgradeReceipt.changedPageIDs.isEmpty {
        guard await reload() != nil else { return }
      }
      // Restore only already-authorized providers; startup must never prompt.
      let restoredEventKit = EventKitCalendarProvider()
      if restoredEventKit.authorizationStatus == .fullAccess {
        calendarProvider = restoredEventKit
        try? await refreshCalendar()
        restoredEventKit.startObserving { [weak self] in
          Task { @MainActor in try? await self?.refreshCalendar() }
        }
      }
      if GoogleCalendarProvider.isRestorable(), let google = try? GoogleCalendarProvider.fromBundle() {
        googleCalendarProvider = google
        try? await refreshGoogleCalendar(using: google, repository: repository)
      }
      let now = Date()
      let calendarStart = calendar.date(byAdding: .year, value: -1, to: now) ?? now
      let calendarEnd = calendar.date(byAdding: .year, value: 1, to: now) ?? now
      calendarEvents = try await repository.calendarEvents(
        from: calendarStart, through: calendarEnd)
      if CloudSyncCoordinator.hasRequiredEntitlement {
        let coordinator = CloudSyncCoordinator(
          repository: repository,
          zoneName: vaultID.cloudZoneName,
          statusHandler: { [weak self] status in
            Task { @MainActor in self?.syncStatus = status }
          },
          changeHandler: { [weak self] in
            Task { @MainActor in await self?.reload() }
          }
        )
        syncCoordinator = coordinator
        await coordinator.start()
      } else {
        syncStatus = .localOnly
      }
    } catch {
      startupError = error.localizedDescription
      isLoading = false
      if !calendarAgendaIsReady {
        resolveCalendarAgendaInitialLoad(error: startupError)
      }
    }
  }

  public func stop() async {
    reloadGeneration &+= 1
    await syncCoordinator?.stop()
    syncCoordinator = nil
    taskMutationCoordinator = nil
  }

  private func configureTaskMutationCoordinator(repository: LibraryRepository) {
    let effects =
      taskMutationEffects
      ?? TaskMutationEffectExecutor.live(
        surface: .application,
        vaultID: vaultID,
        reload: { [weak self] in
          guard let self else { return .failed("The library is unavailable.") }
          guard await self.reload(policy: .refreshOnly) != nil else {
            return .failed(self.startupError ?? "The library could not be refreshed.")
          }
          return .applied
        },
        sync: { [weak self] pageID in
          guard let coordinator = self?.syncCoordinator else { return .notNeeded }
          await coordinator.pageDidChange(pageID)
          return .applied
        },
        purgeSync: { [weak self] pageID in
          guard let coordinator = self?.syncCoordinator else { return .notNeeded }
          await coordinator.pageWasPurged(pageID)
          return .applied
        }
      )
    taskMutationCoordinator = TaskMutationCoordinator(
      repository: repository,
      calendar: calendar,
      effects: effects
    )
  }

  /// Creates a session-scoped realtime tool executor that reuses the store's
  /// single task-write boundary and its durable side-effect handling.
  public func makeAssistantRealtimeToolCoordinator()
    -> AssistantRealtimeToolCoordinator?
  {
    guard let repository, let taskMutationCoordinator else { return nil }
    return AssistantRealtimeToolCoordinator(
      repository: repository,
      mutations: taskMutationCoordinator
    )
  }

  /// Dismisses the current presentation only. Durable side effects remain queued.
  public func acknowledgeTaskMutationWarnings() {
    taskMutationWarnings = []
  }

  /// Retries the existing durable outbox without replaying the persisted task mutation.
  @discardableResult
  public func retryPendingTaskEffects() async -> Bool {
    guard let taskMutationCoordinator else { return false }
    let outcomes = await taskMutationCoordinator.drainPendingEffects()
    taskMutationWarnings = outcomes.compactMap(\.warning)
    return taskMutationWarnings.isEmpty
  }

  @discardableResult
  public func reload(
    policy: LibraryReloadPolicy = .reconcileSystemState
  ) async -> [PageSnapshot]? {
    guard let repository else {
      startupError = startupError ?? "The library is unavailable."
      resolveCalendarAgendaInitialLoad(error: startupError)
      isLoading = false
      return nil
    }
    reloadGeneration &+= 1
    let generation = reloadGeneration
    let now = Date()
    let calendarStart = calendar.date(byAdding: .year, value: -1, to: now) ?? now
    let calendarEnd = calendar.date(byAdding: .year, value: 1, to: now) ?? now

    let loadedCalendarEvents: [CalendarEventSnapshot]
    do {
      loadedCalendarEvents = try await repository.calendarEvents(
        from: calendarStart,
        through: calendarEnd
      )
      guard generation == reloadGeneration else { return nil }
      calendarEvents = loadedCalendarEvents
      calendarAgendaLoadError = nil
      calendarAgendaIsReady = true
    } catch {
      guard generation == reloadGeneration else { return nil }
      resolveCalendarAgendaInitialLoad(error: error.localizedDescription)
      startupError = error.localizedDescription
      isLoading = false
      return nil
    }

    do {
      let live = try await repository.pages(in: .allPages)
      let trash = try await repository.pages(in: .trash)
      let loadedPages = (live + trash).sorted { $0.modifiedAt > $1.modifiedAt }
      let loadedSupertags = try await repository.supertags()
      let loadedSavedViews = try await repository.savedViews()
      var viewItems: [LiveQueryID: [LiveQueryItem]] = [:]
      for view in loadedSavedViews { viewItems[view.id] = try await repository.run(view) }
      let loadedWhiteboards = try await repository.whiteboardDocuments()
      let loadedCalendarPageContexts = try await repository.calendarPageContexts()
      let loadedOmissionPrefixes = try await repository.calendarEventOmissionPrefixes()
      let loadedCalendarEventMaterializationEnabled = try await repository.calendarEventMaterializationEnabled()
      let loadedOtherPeople = try await repository.otherPeople()
      let loadedContactLinks = Dictionary(
        uniqueKeysWithValues: try await repository.contactLinks().map { ($0.pageID, $0) }
      )

      guard generation == reloadGeneration else { return nil }
      pages = loadedPages
      supertags = loadedSupertags
      savedViews = loadedSavedViews
      liveViewItems = viewItems
      whiteboardDocuments = loadedWhiteboards
      calendarPageContexts = loadedCalendarPageContexts
      omissionPrefixes = loadedOmissionPrefixes
      calendarEventMaterializationEnabled = loadedCalendarEventMaterializationEnabled
      calendarEvents = loadedCalendarEvents
      calendarRelationshipGeneration &+= 1
      otherPeople = loadedOtherPeople
      publishContactLinksIfChanged(loadedContactLinks)
      if policy == .reconcileSystemState {
        await taskSystemReconciliationCoordinator.submit(vaultID: vaultID, pages: live)
      }
      if let selectedPageID, page(id: selectedPageID) == nil {
        self.selectedPageID = live.first?.id
      }
      startupError = nil
      isLoading = false
      return loadedPages
    } catch {
      guard generation == reloadGeneration else { return nil }
      startupError = error.localizedDescription
      isLoading = false
      return nil
    }
  }

  private func resolveCalendarAgendaInitialLoad(error: String?) {
    calendarAgendaLoadError = error ?? calendarAgendaLoadError ?? "The calendar agenda is unavailable."
    calendarAgendaIsReady = true
  }

  @discardableResult
  public func createFreePage(title: String = "Untitled") async -> PageID? {
    guard let repository else { return nil }
    do {
      let page = try await repository.createFreePage(title: title)
      selectedPageID = page.id
      await reload()
      await syncCoordinator?.pageDidChange(page.id)
      return page.id
    } catch {
      startupError = error.localizedDescription
      return nil
    }
  }

  @discardableResult
  public func createReferencePage(title: String) async -> PageID? {
    guard let repository else { return nil }
    do {
      let page = try await repository.createFreePage(title: title)
      await reload()
      await syncCoordinator?.pageDidChange(page.id)
      return page.id
    } catch {
      startupError = error.localizedDescription
      return nil
    }
  }

  @discardableResult
  public func createTaggedPage(title: String, supertagID: SupertagID) async -> PageID? {
    guard let repository else { return nil }
    do {
      let page = try await repository.createTaggedPage(title: title, supertagID: supertagID)
      await reload()
      await syncCoordinator?.pageDidChange(page.id)
      return page.id
    } catch {
      startupError = error.localizedDescription
      return nil
    }
  }

  public func taggedSuggestions(matching query: String, supertagID: SupertagID) async
    -> [PageSuggestion]
  {
    guard let repository else { return [] }
    return (try? await repository.taggedSuggestions(matching: query, supertagID: supertagID)) ?? []
  }

  public func pages(with supertagID: SupertagID) -> [PageSnapshot] {
    pages.filter { $0.deletedAt == nil && $0.hasSupertag(supertagID) }
      .sorted { $0.displayTitle.localizedStandardCompare($1.displayTitle) == .orderedAscending }
  }

  public var taskProjects: [PageSnapshot] { pages(with: BuiltInSupertags.project) }
  public var taskAreas: [PageSnapshot] { pages(with: BuiltInSupertags.area) }
  public var taskPeople: [PageSnapshot] { taskPeople(includingOtherPeople: false) }

  public func taskPeople(includingOtherPeople: Bool) -> [PageSnapshot] {
    let candidates =
      pages(with: BuiltInSupertags.person).filter {
        $0.objectMetadata.personVisibility == .promoted
      }
      + (includingOtherPeople ? otherPeople : [])
    return candidates.sorted {
      let comparison = personDisplayName(for: $0).localizedStandardCompare(personDisplayName(for: $1))
      if comparison != .orderedSame { return comparison == .orderedAscending }
      return $0.id.rawValue < $1.id.rawValue
    }
  }

  /// A single render-ready projection for the Tasks home. It has no per-row
  /// task queries, and intentionally includes only explicitly promoted people.
  public func taskHomeSnapshot(now: Date = Date()) -> TaskHomeSnapshot {
    return TaskHomeSnapshot.make(
      pages: pages,
      personTitle: personDisplayName(for:),
      now: now,
      calendar: calendar
    )
  }

  public func personDisplayName(for page: PageSnapshot) -> String {
    let emailKey = SupertagPropertyKey(
      supertagID: BuiltInSupertags.person,
      fieldID: .init(rawValue: "email")
    )
    let emails = (page.objectMetadata.properties[emailKey] ?? []).compactMap { value -> String? in
      guard case .email(let email) = value else { return nil }
      return email
    }
    return PersonDisplayName.resolved(
      title: page.title,
      emails: emails,
      origin: page.personOrigin,
      contactLink: contactLinks[page.id]
    )
  }

  public func suggestedLinkedContactName(for page: PageSnapshot) -> String? {
    let emailKey = SupertagPropertyKey(
      supertagID: BuiltInSupertags.person,
      fieldID: .init(rawValue: "email")
    )
    let emails = (page.objectMetadata.properties[emailKey] ?? []).compactMap { value -> String? in
      guard case .email(let email) = value else { return nil }
      return email
    }
    return PersonDisplayName.contactNameSuggestion(
      title: page.title,
      emails: emails,
      origin: page.personOrigin,
      contactLink: contactLinks[page.id]
    )
  }

  public func personDisplayName(for pageID: PageID) -> String? {
    page(id: pageID).map(personDisplayName(for:))
  }

  public func weeklyReview(now: Date = Date()) -> WeeklyReviewSnapshot {
    WeeklyReviewSnapshot.make(pages: pages, now: now, calendar: calendar)
  }

  public var taskTags: [String] {
    Array(Set(pages.compactMap(\.taskData).flatMap(\.tags))).sorted()
  }

  public func tasks(
    in selection: TaskListSelection,
    now: Date = Date()
  ) -> [TaskItem] {
    TaskQuery.items(from: pages, selection: selection, now: now, calendar: calendar)
  }

  public func taskCount(_ list: TaskSmartList, now: Date = Date()) -> Int {
    TaskQuery.count(list, in: pages, now: now, calendar: calendar)
  }

  /// Active literal captures waiting for one-at-a-time clarification, oldest first.
  public var clarificationInboxTasks: [TaskItem] {
    pages.compactMap(TaskItem.init(page:))
      .filter { $0.data.state == .active && $0.data.placement == .inbox }
      .sorted { lhs, rhs in
        if lhs.page.createdAt != rhs.page.createdAt {
          return lhs.page.createdAt < rhs.page.createdAt
        }
        return lhs.id.rawValue < rhs.id.rawValue
      }
  }

  public var clarificationAvailability: AssistantAvailability {
    FoundationTaskInterpreter.availability()
  }

  /// Produces the complete manual editing path without consulting a language model.
  public func manualClarificationProposal(
    for taskID: PageID
  ) async -> TaskClarificationManualFallback? {
    guard let repository else { return nil }
    do {
      let seed = try await repository.taskClarificationSeed(pageID: taskID)
      taskClarificationError = nil
      return TaskClarificationManualFallback(
        taskID: seed.taskID,
        expectedVersion: seed.expectedVersion,
        draft: seed.literalDraft
      )
    } catch {
      taskClarificationError = error.localizedDescription
      return nil
    }
  }

  /// The interpreter runs only when this explicit method is called. The repository contributes a
  /// read-only seed before interpretation and is checked again afterward so the UI never reviews a
  /// proposal already known to be stale.
  public func clarificationProposal(
    for taskID: PageID,
    now: Date = Date(),
    locale: Locale = .current
  ) async -> TaskClarificationProposalResult {
    guard let repository else {
      return .ineligible(startupError ?? "The library is unavailable.")
    }
    do {
      let seed = try await repository.taskClarificationSeed(pageID: taskID)
      let response = await taskInterpreter.interpret(
        seed.input,
        context: seed.references.interpretationContext,
        now: now,
        calendar: calendar,
        locale: locale
      )
      let current = try await repository.page(id: taskID)
      let currentVersion = current.map(TaskPageVersion.init)
      guard currentVersion == seed.expectedVersion else {
        return .stale(expected: seed.expectedVersion, current: currentVersion)
      }
      taskClarificationError = nil
      return TaskClarificationProposalBuilder.result(seed: seed, response: response)
    } catch {
      taskClarificationError = error.localizedDescription
      return .ineligible(error.localizedDescription)
    }
  }

  @discardableResult
  public func createProject(title: String, data: ProjectData = .init()) async -> PageID? {
    guard let repository else { return nil }
    do {
      let project = try await repository.createProject(title: title, data: data)
      await reload()
      await syncCoordinator?.pageDidChange(project.id)
      return project.id
    } catch {
      startupError = error.localizedDescription
      return nil
    }
  }

  public func updateProject(pageID: PageID, data: ProjectData) async {
    guard let repository else { return }
    do {
      _ = try await repository.updateProject(pageID: pageID, data: data)
      await reload()
      await syncCoordinator?.pageDidChange(pageID)
    } catch {
      startupError = error.localizedDescription
    }
  }

  @discardableResult
  public func closeProject(
    pageID: PageID,
    resolution: ProjectClosureResolution = .strict
  ) async -> ProjectCloseResult {
    undoOfferGeneration &+= 1
    let offerGeneration = undoOfferGeneration
    guard let taskMutationCoordinator else {
      return .failed(message: startupError ?? "The library is unavailable.")
    }
    switch await taskMutationCoordinator.closeProject(
      pageID: pageID,
      resolution: resolution
    ) {
    case .success(let success):
      startupError = nil
      taskMutationWarnings = success.warnings
      let result = success.value
      guard offerGeneration == undoOfferGeneration,
        case .closed(let outcome) = result,
        let offer = ProjectClosureUndoOffer(outcome)
      else { return result }
      latestProjectClosureUndoOffer = offer
      projectClosureUndoFailure = nil
      latestTaskCompletionUndoOffer = nil
      taskCompletionUndoFailure = nil
      latestTaskClarificationUndoOffer = nil
      taskClarificationUndoFailure = nil
      return result
    case .failure(let failure):
      let message = failure.localizedDescription
      startupError = message
      taskMutationWarnings = []
      return .failed(message: message)
    }
  }

  @discardableResult
  public func undoProjectClosure(
    _ receipt: ProjectClosureUndoReceipt
  ) async -> ProjectClosureUndoResult? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(
      from: await taskMutationCoordinator.undoProjectClosure(receipt)
    )
  }

  @discardableResult
  public func undoLatestProjectClosure() async -> ProjectClosureUndoResult? {
    guard let offer = latestProjectClosureUndoOffer else { return nil }
    let result = await undoProjectClosure(offer.receipt)
    guard latestProjectClosureUndoOffer?.receipt == offer.receipt else { return result }
    if result != nil {
      dismissLatestProjectClosureUndo()
    } else {
      projectClosureUndoFailure =
        startupError ?? "The project or one of its tasks changed, so Undo was not applied."
    }
    return result
  }

  public func dismissLatestProjectClosureUndo() {
    undoOfferGeneration &+= 1
    latestProjectClosureUndoOffer = nil
    projectClosureUndoFailure = nil
  }

  @discardableResult
  public func reopenProject(pageID: PageID) async -> PageSnapshot? {
    guard let repository else { return nil }
    do {
      let project = try await repository.reopenProject(pageID: pageID)
      await reload()
      await syncCoordinator?.pageDidChange(project.id)
      return project
    } catch {
      startupError = error.localizedDescription
      return nil
    }
  }

  public func tasks(on day: Date, includingOverdue: Bool = false) -> [TaskItem] {
    TaskQuery.items(
      from: pages,
      on: day,
      includingOverdue: includingOverdue,
      calendar: calendar
    )
  }

  @discardableResult
  public func createTask(_ draft: TaskDraft) async -> PageID? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(from: await taskMutationCoordinator.create(draft))?.id
  }

  @discardableResult
  public func createTask(from quickEntry: String) async -> PageID? {
    await createTask(QuickTaskParser.parse(quickEntry, calendar: calendar).draft)
  }

  @discardableResult
  public func updateTask(
    pageID: PageID,
    data: TaskData,
    title: String? = nil,
    notes: String? = nil
  ) async -> PageSnapshot? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(
      from: await taskMutationCoordinator.update(
        pageID: pageID,
        data: data,
        title: title,
        notes: notes
      )
    )
  }

  @discardableResult
  public func completeTask(_ pageID: PageID) async -> TaskCompletionResult? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(from: await taskMutationCoordinator.complete(pageID))
  }

  @discardableResult
  public func completeTaskOfferingUndo(_ pageID: PageID) async -> TaskCompletionResult? {
    undoOfferGeneration &+= 1
    let offerGeneration = undoOfferGeneration
    guard let result = await completeTask(pageID) else { return nil }
    guard offerGeneration == undoOfferGeneration else { return result }
    latestTaskCompletionUndoOffer = TaskCompletionUndoOffer(completion: result)
    taskCompletionUndoFailure = nil
    latestProjectClosureUndoOffer = nil
    projectClosureUndoFailure = nil
    latestTaskClarificationUndoOffer = nil
    taskClarificationUndoFailure = nil
    return result
  }

  @discardableResult
  public func undoTaskCompletion(
    _ receipt: TaskCompletionUndoReceipt
  ) async -> TaskCompletionUndoResult? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(from: await taskMutationCoordinator.undoCompletion(receipt))
  }

  @discardableResult
  public func undoLatestTaskCompletion() async -> TaskCompletionUndoResult? {
    guard let offer = latestTaskCompletionUndoOffer else { return nil }
    let result = await undoTaskCompletion(offer.receipt)
    guard latestTaskCompletionUndoOffer?.receipt == offer.receipt else { return result }
    if result != nil {
      dismissLatestTaskCompletionUndo()
    } else {
      taskCompletionUndoFailure =
        startupError ?? "The task changed after completion, so Undo was not applied."
    }
    return result
  }

  public func dismissLatestTaskCompletionUndo() {
    undoOfferGeneration &+= 1
    latestTaskCompletionUndoOffer = nil
    taskCompletionUndoFailure = nil
  }

  @discardableResult
  public func reopenTask(_ pageID: PageID) async -> PageSnapshot? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(from: await taskMutationCoordinator.reopen(pageID))
  }

  @discardableResult
  public func cancelTask(_ pageID: PageID) async -> PageSnapshot? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(from: await taskMutationCoordinator.cancel(pageID))
  }

  @discardableResult
  public func completeTasks(_ pageIDs: [PageID]) async -> TaskBatchMutationResult? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(from: await taskMutationCoordinator.completeTasks(pageIDs))
  }

  @discardableResult
  public func reopenTasks(_ pageIDs: [PageID]) async -> TaskBatchMutationResult? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(from: await taskMutationCoordinator.reopenTasks(pageIDs))
  }

  @discardableResult
  public func cancelTasks(_ pageIDs: [PageID]) async -> TaskBatchMutationResult? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(from: await taskMutationCoordinator.cancelTasks(pageIDs))
  }

  @discardableResult
  public func patchTasks(
    _ pageIDs: [PageID],
    patch: TaskMetadataPatch
  ) async -> TaskBatchMutationResult? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(
      from: await taskMutationCoordinator.patchTasks(pageIDs, patch: patch)
    )
  }

  @discardableResult
  public func trashTasks(_ pageIDs: [PageID]) async -> TaskBatchMutationResult? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(from: await taskMutationCoordinator.trashTasks(pageIDs))
  }

  @discardableResult
  public func undoTaskBatch(_ receipt: TaskBatchUndoReceipt) async -> TaskBatchUndoResult? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(from: await taskMutationCoordinator.undoTaskBatch(receipt))
  }

  @discardableResult
  public func applyClarification(
    taskID: PageID,
    draft: TaskClarificationDraft,
    expectedVersion: TaskPageVersion
  ) async -> TaskClarificationMutationResponse {
    guard let taskMutationCoordinator else {
      return .failed(startupError ?? "The library is unavailable.")
    }
    undoOfferGeneration &+= 1
    let offerGeneration = undoOfferGeneration
    let response = await taskMutationCoordinator.applyClarification(
      taskID: taskID,
      draft: draft,
      expectedVersion: expectedVersion
    )
    return recordClarificationMutation(response, offerGeneration: offerGeneration)
  }

  @discardableResult
  public func moveClarificationTaskToSomeday(
    taskID: PageID,
    expectedVersion: TaskPageVersion
  ) async -> TaskClarificationMutationResponse {
    guard let taskMutationCoordinator else {
      return .failed(startupError ?? "The library is unavailable.")
    }
    undoOfferGeneration &+= 1
    let offerGeneration = undoOfferGeneration
    let response = await taskMutationCoordinator.moveClarificationTaskToSomeday(
      taskID: taskID,
      expectedVersion: expectedVersion
    )
    return recordClarificationMutation(response, offerGeneration: offerGeneration)
  }

  @discardableResult
  public func undoTaskClarification(
    _ receipt: TaskClarificationUndoReceipt
  ) async -> TaskClarificationUndoResult? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(from: await taskMutationCoordinator.undoClarification(receipt))
  }

  @discardableResult
  public func undoLatestTaskClarification() async -> TaskClarificationUndoResult? {
    guard let offer = latestTaskClarificationUndoOffer else { return nil }
    let result = await undoTaskClarification(offer.receipt)
    guard latestTaskClarificationUndoOffer?.receipt == offer.receipt else { return result }
    if result != nil {
      dismissLatestTaskClarificationUndo()
    } else {
      taskClarificationUndoFailure =
        startupError ?? "The task changed after clarification, so Undo was not applied."
    }
    return result
  }

  public func dismissLatestTaskClarificationUndo() {
    undoOfferGeneration &+= 1
    latestTaskClarificationUndoOffer = nil
    taskClarificationUndoFailure = nil
  }

  private func recordClarificationMutation(
    _ response: TaskMutationResult<TaskClarificationMutationResult>,
    offerGeneration: UInt64
  ) -> TaskClarificationMutationResponse {
    switch response {
    case .success(let success):
      startupError = nil
      taskClarificationError = nil
      taskMutationWarnings = success.warnings
      if offerGeneration == undoOfferGeneration {
        latestTaskClarificationUndoOffer = TaskClarificationUndoOffer(success.value)
        taskClarificationUndoFailure = nil
        latestTaskCompletionUndoOffer = nil
        taskCompletionUndoFailure = nil
        latestProjectClosureUndoOffer = nil
        projectClosureUndoFailure = nil
      }
      return .applied(success.value)
    case .failure(let failure):
      let message = failure.localizedDescription
      startupError = message
      taskClarificationError = message
      taskMutationWarnings = []
      if failure.reason == .clarificationStale { return .stale(message) }
      return .failed(message)
    }
  }

  private func taskMutationValue<Value: Sendable>(
    from result: TaskMutationResult<Value>
  ) -> Value? {
    switch result {
    case .success(let success):
      startupError = nil
      taskMutationWarnings = success.warnings
      return success.value
    case .failure(let failure):
      startupError = failure.localizedDescription
      taskMutationWarnings = []
      return nil
    }
  }

  public func setCalendarEventOmissionPrefixes(_ prefixes: [String]) async {
    guard let repository else { return }
    do {
      try await repository.setCalendarEventOmissionPrefixes(prefixes)
      omissionPrefixes = try await repository.calendarEventOmissionPrefixes()
      try await refreshEnabledCalendarProviders()
      await reload()
      calendarError = nil
    } catch {
      calendarError = error.localizedDescription
    }
  }

  public func setCalendarEventMaterializationEnabled(_ enabled: Bool) async {
    guard let repository else { return }
    do {
      try await repository.setCalendarEventMaterializationEnabled(enabled)
      calendarEventMaterializationEnabled = enabled
      guard enabled else { return }
      var receipts: [CalendarEventMaterializationReceipt] = []
      for events in Dictionary(grouping: calendarEvents, by: { $0.identity.provider }).values {
        guard let first = events.first else { continue }
        receipts.append(try await repository.materializeCalendarEvents(
          events, provider: first.identity.provider
        ))
      }
      for pageID in receipts.flatMap(\.changedPageIDs) { await syncCoordinator?.pageDidChange(pageID) }
      if receipts.contains(where: { !$0.changedPageIDs.isEmpty }) { await reload() }
    } catch {
      calendarError = error.localizedDescription
    }
  }

  public func addCalendarEventOmissionPrefix(_ prefix: String) async {
    await setCalendarEventOmissionPrefixes(omissionPrefixes + [prefix])
  }

  public func updateCalendarEventOmissionPrefix(at index: Int, to prefix: String) async {
    guard omissionPrefixes.indices.contains(index) else { return }
    var updated = omissionPrefixes
    updated[index] = prefix
    await setCalendarEventOmissionPrefixes(updated)
  }

  public func removeCalendarEventOmissionPrefixes(at offsets: IndexSet) async {
    let updated = omissionPrefixes.enumerated().compactMap { index, prefix in
      offsets.contains(index) ? nil : prefix
    }
    await setCalendarEventOmissionPrefixes(updated)
  }

  public func promotePerson(_ pageID: PageID) async {
    guard let repository else { return }
    do {
      _ = try await repository.promotePerson(pageID: pageID)
      await reload()
      await syncCoordinator?.pageDidChange(pageID)
    } catch {
      startupError = error.localizedDescription
    }
  }

  public func movePersonToOther(_ pageID: PageID) async {
    guard let repository else { return }
    do {
      _ = try await repository.movePersonToOther(pageID: pageID)
      await reload()
      await syncCoordinator?.pageDidChange(pageID)
    } catch {
      startupError = error.localizedDescription
    }
  }

  public func configureDeviceContactResolver(_ resolver: (any DeviceContactResolving)?) {
    contactResolver = resolver
  }

  /// Applies a platform authorization transition while retaining the configured resolver for
  /// subsequent foreground and authorization-change refreshes.
  public func deviceContactsAuthorizationDidChange(
    _ authorization: DeviceContactsAuthorization
  ) async {
    guard let repository else { return }
    guard authorization.permitsEnrichment else {
      do {
        try await repository.removeAllContactLinks()
        contactLinks.removeAll()
        startupError = nil
      } catch {
        startupError = error.localizedDescription
      }
      return
    }
    await refreshContactEnrichments()
  }

  public func refreshContactEnrichments() async {
    guard let contactResolver else { return }
    await refreshContactEnrichment(using: contactResolver)
  }

  public func refreshContactEnrichment(using resolver: any DeviceContactResolving) async {
    guard let repository else { return }
    do {
      let candidates = try await repository.contactCandidates()
      let candidatesByPage = Dictionary(grouping: candidates, by: \.pageID)
      let existingLinks = try await repository.contactLinks()
      for link in existingLinks where candidatesByPage[link.pageID] == nil {
        try await repository.removeContactLink(for: link.pageID)
      }
      for (pageID, pageCandidates) in candidatesByPage {
        if let existingLink = existingLinks.first(where: { $0.pageID == pageID }) {
          if pageCandidates.contains(where: { $0.email == existingLink.matchedEmail }),
            let selectedContact = try await resolver.contact(
              identifier: existingLink.contactIdentifier
            ),
            selectedContact.identifier == existingLink.contactIdentifier,
            selectedContact.normalizedEmails.contains(existingLink.matchedEmail)
          {
            _ = try await repository.saveContactLink(
              selectedContact,
              for: pageID,
              matchedEmail: existingLink.matchedEmail
            )
          } else {
            try await repository.removeContactLink(for: pageID)
          }
          continue
        }
        var exactMatches: [(record: DeviceContactRecord, email: String)] = []
        for candidate in pageCandidates {
          guard let contact = try await resolver.contact(matchingEmail: candidate.email),
            contact.normalizedEmails.contains(candidate.email)
          else { continue }
          exactMatches.append((contact, candidate.email))
        }
        let identifiers = Set(exactMatches.map(\.record.identifier))
        guard identifiers.count == 1, let match = exactMatches.first else {
          try await repository.removeContactLink(for: pageID)
          continue
        }
        _ = try await repository.saveContactLink(
          match.record,
          for: pageID,
          matchedEmail: match.email
        )
      }
      let loadedContactLinks = Dictionary(
        uniqueKeysWithValues: try await repository.contactLinks().map { ($0.pageID, $0) }
      )
      publishContactLinksIfChanged(loadedContactLinks)
      startupError = nil
    } catch {
      startupError = error.localizedDescription
    }
  }

  public func saveContactLink(
    _ record: DeviceContactRecord,
    for pageID: PageID,
    matchedEmail: String
  ) async {
    guard let repository else { return }
    do {
      let link = try await repository.saveContactLink(
        record,
        for: pageID,
        matchedEmail: matchedEmail
      )
      contactLinks[pageID] = link
      startupError = nil
    } catch {
      startupError = error.localizedDescription
    }
  }

  public func removeContactLink(for pageID: PageID) async {
    guard let repository else { return }
    do {
      try await repository.removeContactLink(for: pageID)
      contactLinks.removeValue(forKey: pageID)
      startupError = nil
    } catch {
      startupError = error.localizedDescription
    }
  }

  private func publishContactLinksIfChanged(_ updatedLinks: [PageID: PersonContactLink]) {
    guard !Self.contactLinksHaveSameUIPresentation(contactLinks, updatedLinks) else { return }
    contactLinks = updatedLinks
  }

  static func contactLinksHaveSameUIPresentation(
    _ lhs: [PageID: PersonContactLink],
    _ rhs: [PageID: PersonContactLink]
  ) -> Bool {
    Set(lhs.values.map(ContactLinkUIPresentation.init))
      == Set(rhs.values.map(ContactLinkUIPresentation.init))
  }

  public func addSupertag(_ supertagID: SupertagID, to pageID: PageID) {
    Task {
      do {
        try await repository?.addSupertag(supertagID, to: pageID)
        await reload()
        await syncCoordinator?.pageDidChange(pageID)
      } catch { startupError = error.localizedDescription }
    }
  }

  public func removeSupertag(_ supertagID: SupertagID, from pageID: PageID) {
    Task {
      do {
        try await repository?.removeSupertag(supertagID, from: pageID)
        await reload()
        await syncCoordinator?.pageDidChange(pageID)
      } catch { startupError = error.localizedDescription }
    }
  }

  public func setProperty(
    pageID: PageID,
    supertagID: SupertagID,
    fieldID: SupertagFieldID,
    values: [SupertagValue]
  ) {
    Task {
      do {
        try await repository?.setProperty(
          pageID: pageID,
          key: .init(supertagID: supertagID, fieldID: fieldID),
          values: values
        )
        await reload()
        await syncCoordinator?.pageDidChange(pageID)
      } catch { startupError = error.localizedDescription }
    }
  }

  public func saveSupertag(_ definition: SupertagDefinition) async throws {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    try await repository.saveSupertag(definition)
    await reload()
    await syncCoordinator?.supertagDidChange(definition.id)
  }

  func synchronizeRelationDefinition(_ id: RelationID) async {
    await syncCoordinator?.relationDefinitionDidChange(id)
  }

  func synchronizeGraphQuery(_ id: GraphQueryID) async {
    await syncCoordinator?.graphQueryDidChange(id)
  }

  func synchronizePage(_ id: PageID) async {
    await pageSynchronizationObserver?(id)
    await syncCoordinator?.pageDidChange(id)
  }

  public func saveView(_ definition: LiveQueryDefinition) {
    Task {
      do {
        try await repository?.saveView(definition)
        await reload()
        await syncCoordinator?.viewDidChange(definition.id)
      } catch { startupError = error.localizedDescription }
    }
  }

  public func duplicateView(_ definition: LiveQueryDefinition) {
    var copy = definition
    copy.id = .random()
    copy.name = "\(definition.name) Copy"
    Task {
      do {
        try await repository?.duplicateView(copy, from: definition.id)
        await reload()
        await syncCoordinator?.viewDidChange(copy.id)
      } catch { startupError = error.localizedDescription }
    }
  }

  public func deleteView(_ id: LiveQueryID) {
    Task {
      do {
        try await repository?.deleteView(id)
        await reload()
        await syncCoordinator?.viewDidChange(id)
      } catch { startupError = error.localizedDescription }
    }
  }

  public func replaceWhiteboardDocument(
    _ document: WhiteboardDocument,
    for viewID: LiveQueryID,
    expectedRevision: Int64? = nil
  ) async -> WhiteboardMutationReceipt? {
    await commitWhiteboardMutation(viewID: viewID) { repository in
      try await repository.replaceWhiteboardDocument(
        document,
        for: viewID,
        expectedRevision: expectedRevision
      )
    }
  }

  public func upsertWhiteboardElements(
    _ elements: [WhiteboardElement],
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil
  ) async -> WhiteboardMutationReceipt? {
    await commitWhiteboardMutation(viewID: viewID) { repository in
      try await repository.upsertWhiteboardElements(
        elements,
        in: viewID,
        expectedRevision: expectedRevision
      )
    }
  }

  public func moveWhiteboardElements(
    _ moves: [WhiteboardElementMove],
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil
  ) async -> WhiteboardMutationReceipt? {
    await commitWhiteboardMutation(viewID: viewID) { repository in
      try await repository.moveWhiteboardElements(
        moves,
        in: viewID,
        expectedRevision: expectedRevision
      )
    }
  }

  public func deleteWhiteboardElements(
    _ elementIDs: Set<WhiteboardElementID>,
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil
  ) async -> WhiteboardMutationReceipt? {
    await commitWhiteboardMutation(viewID: viewID) { repository in
      try await repository.deleteWhiteboardElements(
        elementIDs,
        in: viewID,
        expectedRevision: expectedRevision
      )
    }
  }

  public func connectWhiteboardArrow(
    _ arrowID: WhiteboardElementID,
    start: WhiteboardConnectionEndpoint?,
    end: WhiteboardConnectionEndpoint?,
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil
  ) async -> WhiteboardMutationReceipt? {
    await commitWhiteboardMutation(viewID: viewID) { repository in
      try await repository.connectWhiteboardArrow(
        arrowID,
        start: start,
        end: end,
        in: viewID,
        expectedRevision: expectedRevision
      )
    }
  }

  public func disconnectWhiteboardArrow(
    _ arrowID: WhiteboardElementID,
    endpoint: WhiteboardArrowEndpoint,
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil
  ) async -> WhiteboardMutationReceipt? {
    await commitWhiteboardMutation(viewID: viewID) { repository in
      try await repository.disconnectWhiteboardArrow(
        arrowID,
        endpoint: endpoint,
        in: viewID,
        expectedRevision: expectedRevision
      )
    }
  }

  public func ensureWhiteboardPageCards(
    _ pageIDs: [PageID],
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil
  ) async -> WhiteboardMutationReceipt? {
    await commitWhiteboardMutation(viewID: viewID) { repository in
      try await repository.ensureWhiteboardPageCards(
        pageIDs,
        in: viewID,
        expectedRevision: expectedRevision
      )
    }
  }

  public func resetWhiteboardPageCards(
    _ pageIDs: [PageID],
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil
  ) async -> WhiteboardMutationReceipt? {
    await commitWhiteboardMutation(viewID: viewID) { repository in
      try await repository.resetWhiteboardPageCards(
        pageIDs,
        in: viewID,
        expectedRevision: expectedRevision
      )
    }
  }

  public func reconcileWhiteboardPageCards(
    _ pageIDs: [PageID],
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil
  ) async -> WhiteboardMutationReceipt? {
    await commitWhiteboardMutation(viewID: viewID) { repository in
      try await repository.reconcileWhiteboardPageCards(
        pageIDs,
        in: viewID,
        expectedRevision: expectedRevision
      )
    }
  }

  public func updateWhiteboardViewport(
    _ viewport: WhiteboardViewport,
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil
  ) async -> WhiteboardMutationReceipt? {
    await commitWhiteboardMutation(viewID: viewID) { repository in
      try await repository.updateWhiteboardViewport(
        viewport,
        in: viewID,
        expectedRevision: expectedRevision
      )
    }
  }

  public func whiteboardFitMetadata(
    for viewID: LiveQueryID,
    viewportSize: WhiteboardSize,
    padding: Double = 48
  ) async -> WhiteboardFitMetadata? {
    do {
      let metadata = try await repository?.whiteboardFitMetadata(
        for: viewID,
        viewportSize: viewportSize,
        padding: padding
      )
      whiteboardError = nil
      return metadata
    } catch {
      whiteboardError = error.localizedDescription
      return nil
    }
  }

  private func commitWhiteboardMutation(
    viewID: LiveQueryID,
    operation: @escaping @Sendable (LibraryRepository) async throws -> WhiteboardMutationReceipt
  ) async -> WhiteboardMutationReceipt? {
    guard let repository else { return nil }
    do {
      let receipt = try await operation(repository)
      whiteboardDocuments[viewID] = receipt.after
      whiteboardError = nil
      if receipt.after.revision != receipt.before.revision {
        await syncCoordinator?.viewDidChange(viewID)
      }
      return receipt
    } catch {
      whiteboardError = error.localizedDescription
      return nil
    }
  }

  @discardableResult
  public func openDailyPage(for date: Date = Date()) async -> PageID? {
    guard let repository else { return nil }
    do {
      let page = try await repository.dailyPage(for: DayKey(date: date, calendar: calendar))
      selectedPageID = page.id
      await reload()
      await syncCoordinator?.pageDidChange(page.id)
      return page.id
    } catch {
      startupError = error.localizedDescription
      return nil
    }
  }

  @discardableResult
  public func openCalendarEventPage(_ event: CalendarEventSnapshot) async -> PageID? {
    guard let repository else { return nil }
    do {
      let result = try await repository.resolveCalendarEventPage(for: event)
      selectedPageID = result.pageID
      await reload()
      for pageID in result.changedPageIDs {
        await synchronizePage(pageID)
      }
      return result.pageID
    } catch {
      startupError = error.localizedDescription
      return nil
    }
  }

  @discardableResult
  public func openCalendarSeriesPage(_ event: CalendarEventSnapshot) async -> PageID? {
    guard let repository else { return nil }
    do {
      guard let page = try await repository.calendarSeriesPage(for: event) else { return nil }
      selectedPageID = page.id
      await reload()
      await syncCoordinator?.pageDidChange(page.id)
      return page.id
    } catch {
      startupError = error.localizedDescription
      return nil
    }
  }

  public func persistEditorCommit(_ commit: EditorCommit) async throws -> EditorCommitReceipt {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "Unknown error")
    }
    let receipt = try await repository.persistEditorCommit(commit)
    guard let page = try await repository.page(id: commit.pageID) else {
      throw LibraryRepositoryError.pageNotFound
    }
    cacheEditorPage(page)
    scheduleEditorLiveViewRefresh()
    await syncCoordinator?.pageDidChange(commit.pageID)
    return receipt
  }

  @discardableResult
  public func persistRichTextEditor(
    pageID: PageID,
    title: String,
    body: AttributedString
  ) async throws -> PageSnapshot {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "Unknown error")
    }
    let page = try await repository.persistRichTextEditor(pageID: pageID, title: title, body: body)
    cacheEditorPage(page)
    scheduleEditorLiveViewRefresh()
    await syncCoordinator?.pageDidChange(pageID)
    return page
  }

  public func createTaggedPageAndPersistReference(
    _ request: TaggedPageReferenceInsertionRequest
  ) async throws -> TaggedPageReferenceInsertionResult {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "Unknown error")
    }
    let result = try await repository.createTaggedPageAndPersistReference(request)
    cacheEditorPages([result.source, result.target])
    scheduleEditorLiveViewRefresh()
    await syncCoordinator?.pageDidChange(result.source.id)
    await syncCoordinator?.pageDidChange(result.target.id)
    return result
  }

  public func personEmailCandidates(matchingEmail email: String) async throws -> [PersonEmailCandidate] {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "Unknown error")
    }
    return try await repository.personEmailCandidates(matchingEmail: email)
  }

  @discardableResult
  public func renamePage(pageID: PageID, title: String) async throws -> PageSnapshot {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "Unknown error")
    }
    let page = try await repository.renamePage(pageID: pageID, title: title)
    if let index = otherPeople.firstIndex(where: { $0.id == page.id }) {
      otherPeople[index] = page
    } else {
      cacheEditorPage(page)
    }
    scheduleEditorLiveViewRefresh()
    await syncCoordinator?.pageDidChange(pageID)
    return page
  }

  public func adoptLinkedContactName(
    pageID: PageID
  ) async throws -> PersonContactNameAdoptionOutcome {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "Unknown error")
    }
    let outcome = try await repository.adoptLinkedContactName(pageID: pageID)
    switch outcome {
    case .adopted(let page):
      cachePerson(page)
      scheduleEditorLiveViewRefresh()
      await syncCoordinator?.pageDidChange(page.id)
    case .unchanged(let page):
      cachePerson(page)
    case .unavailable:
      break
    }
    return outcome
  }

  private func cachePerson(_ page: PageSnapshot) {
    if page.effectivePersonVisibility == .other {
      pages.removeAll { $0.id == page.id }
      if let index = otherPeople.firstIndex(where: { $0.id == page.id }) {
        otherPeople[index] = page
      } else {
        otherPeople.append(page)
      }
      return
    }

    otherPeople.removeAll { $0.id == page.id }
    cacheEditorPage(page)
  }

  private func cacheEditorPage(_ page: PageSnapshot) {
    cacheEditorPages([page])
  }

  private func cacheEditorPages(_ changedPages: [PageSnapshot]) {
    let replacements = Dictionary(uniqueKeysWithValues: changedPages.map { ($0.id, $0) })
    var updatedPages = pages.map { replacements[$0.id] ?? $0 }
    let existingIDs = Set(pages.map(\.id))
    updatedPages.append(contentsOf: changedPages.filter { !existingIDs.contains($0.id) })
    updatedPages.sort { $0.modifiedAt > $1.modifiedAt }
    pages = updatedPages
  }

  private func scheduleEditorLiveViewRefresh() {
    guard !savedViews.isEmpty else { return }
    editorLiveViewRefreshGeneration &+= 1
    let generation = editorLiveViewRefreshGeneration
    Task { @MainActor [weak self] in
      await self?.refreshLiveViews(afterEditorCommit: generation)
    }
  }

  private func refreshLiveViews(afterEditorCommit generation: UInt64) async {
    guard let repository else { return }
    let views = savedViews
    var refreshedItems = liveViewItems
    for view in views {
      guard let items = try? await repository.run(view) else { continue }
      refreshedItems[view.id] = items
    }
    guard generation == editorLiveViewRefreshGeneration else { return }
    liveViewItems = refreshedItems
  }

  public func suggestions(matching query: String) async -> [PageSuggestion] {
    guard let repository else { return [] }
    return (try? await repository.suggestions(matching: query)) ?? []
  }

  public func backlinks(
    to pageID: PageID,
    includeOthers: Bool = false
  ) async -> [PageSnapshot] {
    guard let repository else { return [] }
    return (try? await repository.backlinks(to: pageID, includeOthers: includeOthers)) ?? []
  }

  public func togglePinned(pageID: PageID) {
    Task {
      do {
        try await repository?.togglePinned(pageID: pageID)
        await reload()
        await syncCoordinator?.pageDidChange(pageID)
      } catch {
        startupError = error.localizedDescription
      }
    }
  }

  public func moveToTrash(pageID: PageID) {
    let isTask = page(id: pageID)?.hasSupertag(BuiltInSupertags.task) == true
    Task {
      if isTask, let taskMutationCoordinator {
        guard
          taskMutationValue(
            from: await taskMutationCoordinator.moveToTrash(pageID)
          ) != nil
        else { return }
        if selectedPageID == pageID {
          selectedPageID = pages.first { $0.id != pageID && $0.deletedAt == nil }?.id
        }
        return
      }
      do {
        try await repository?.moveToTrash(pageID: pageID)
        if selectedPageID == pageID {
          selectedPageID = pages.first { $0.id != pageID && $0.deletedAt == nil }?.id
        }
        await reload()
        await syncCoordinator?.pageDidChange(pageID)
      } catch {
        startupError = error.localizedDescription
      }
    }
  }

  public func restore(pageID: PageID) {
    let isTask = page(id: pageID)?.hasSupertag(BuiltInSupertags.task) == true
    Task {
      if isTask, let taskMutationCoordinator {
        guard
          taskMutationValue(
            from: await taskMutationCoordinator.restore(pageID)
          ) != nil
        else { return }
        selectedPageID = pageID
        return
      }
      do {
        try await repository?.restore(pageID: pageID)
        selectedPageID = pageID
        await reload()
        await syncCoordinator?.pageDidChange(pageID)
      } catch {
        startupError = error.localizedDescription
      }
    }
  }

  public func purge(pageID: PageID) {
    let isTask = page(id: pageID)?.hasSupertag(BuiltInSupertags.task) == true
    Task {
      if isTask, let taskMutationCoordinator {
        guard
          taskMutationValue(
            from: await taskMutationCoordinator.purge(pageID)
          ) != nil
        else { return }
        if selectedPageID == pageID { selectedPageID = nil }
        return
      }
      do {
        try await repository?.purge(pageID: pageID)
        if selectedPageID == pageID { selectedPageID = nil }
        await reload()
        await syncCoordinator?.pageWasPurged(pageID)
      } catch {
        startupError = error.localizedDescription
      }
    }
  }

  public func enableCalendar() async {
    guard let repository else { return }
    let provider = calendarProvider ?? EventKitCalendarProvider()
    calendarProvider = provider
    do {
      try await provider.requestAccess()
      try await repository.setCalendarEventMaterializationEnabled(true)
      calendarEventMaterializationEnabled = true
      try await repository.markCalendarEventMaterializationBackfillNeeded(provider: "eventkit")
      try await refreshCalendar()
      provider.startObserving { [weak self] in
        Task { @MainActor in try? await self?.refreshCalendar() }
      }
    } catch {
      calendarError = error.localizedDescription
    }
    _ = repository
  }

  public func refreshCalendar() async throws {
    guard let repository, let calendarProvider else { return }
    let generation = nextCalendarRefreshGeneration(for: "eventkit")
    let now = Date()
    let start = calendar.date(byAdding: .year, value: -1, to: now) ?? now
    let end = calendar.date(byAdding: .month, value: 18, to: now) ?? now
    do {
      let token = try await repository.beginAuthoritativeCalendarRefresh(provider: "eventkit")
      let projection = try calendarProvider.authoritativeProjection(from: start, through: end)
      guard isCurrentCalendarRefresh(generation, provider: "eventkit") else { return }
      let receipt = try await repository.applyAuthoritativeCalendarProjection(projection, token: token)
      for pageID in receipt.changedPageIDs { await syncCoordinator?.pageDidChange(pageID) }
      await syncCoordinator?.enqueueDirtyChanges()
    } catch {
      throw error
    }
    guard isCurrentCalendarRefresh(generation, provider: "eventkit") else { return }
    calendarEvents = try await repository.calendarEvents(from: start, through: end)
    calendarRelationshipGeneration &+= 1
    calendarPageContexts = try await repository.calendarPageContexts()
    if contactResolver != nil { await refreshContactEnrichments() }
    calendarError = nil
  }

  public func events(on date: Date) -> [CalendarEventSnapshot] {
    calendarEvents.filter { event in
      calendar.isDate(event.startDate, inSameDayAs: date)
        || (event.startDate < date && event.endDate > date)
    }
  }

  public func enableGoogleCalendar() async {
    guard let repository else { return }
    do {
      let provider = try googleCalendarProvider ?? GoogleCalendarProvider.fromBundle()
      googleCalendarProvider = provider
      try await provider.authorize()
      try await repository.setCalendarEventMaterializationEnabled(true)
      calendarEventMaterializationEnabled = true
      try await repository.markCalendarEventMaterializationBackfillNeeded(provider: "google")
      try await refreshGoogleCalendar(using: provider, repository: repository)
      calendarError = nil
    } catch {
      calendarError = error.localizedDescription
    }
  }

  private func refreshEnabledCalendarProviders() async throws {
    if calendarProvider != nil { try await refreshCalendar() }
    if let repository, let googleCalendarProvider {
      try await refreshGoogleCalendar(using: googleCalendarProvider, repository: repository)
    }
  }

  private func refreshGoogleCalendar(
    using provider: GoogleCalendarProvider,
    repository: LibraryRepository
  ) async throws {
    let generation = nextCalendarRefreshGeneration(for: "google")
    let now = Date()
    let start = calendar.date(byAdding: .year, value: -1, to: now) ?? now
    let end = calendar.date(byAdding: .month, value: 18, to: now) ?? now
    do {
      let token = try await repository.beginAuthoritativeCalendarRefresh(provider: "google")
      let projection = try await provider.authoritativeProjection(from: start, through: end)
      guard isCurrentCalendarRefresh(generation, provider: "google") else { return }
      let receipt = try await repository.applyAuthoritativeCalendarProjection(projection, token: token)
      for pageID in receipt.changedPageIDs { await syncCoordinator?.pageDidChange(pageID) }
      await syncCoordinator?.enqueueDirtyChanges()
    } catch {
      throw error
    }
    guard isCurrentCalendarRefresh(generation, provider: "google") else { return }
    calendarEvents = try await repository.calendarEvents(from: start, through: end)
    calendarRelationshipGeneration &+= 1
    calendarPageContexts = try await repository.calendarPageContexts()
    if contactResolver != nil { await refreshContactEnrichments() }
  }

  public func syncNow() async {
    await syncCoordinator?.syncNow()
    await reload()
  }

  private func nextCalendarRefreshGeneration(for provider: String) -> UInt64 {
    let next = (calendarRefreshGenerations[provider] ?? 0) &+ 1
    calendarRefreshGenerations[provider] = next
    return next
  }

  private func isCurrentCalendarRefresh(_ generation: UInt64, provider: String) -> Bool {
    calendarRefreshGenerations[provider] == generation
  }
}
