import Foundation
import Observation

@MainActor
@Observable
public final class LibraryStore {
  public private(set) var pages: [PageSnapshot] = []
  public private(set) var calendarEvents: [CalendarEventSnapshot] = []
  public private(set) var calendarPageContexts: [PageID: CalendarPageContext] = [:]
  public private(set) var supertags: [SupertagDefinition] = []
  public private(set) var savedViews: [LiveQueryDefinition] = []
  public private(set) var liveViewItems: [LiveQueryID: [LiveQueryItem]] = [:]
  public private(set) var whiteboardDocuments: [LiveQueryID: WhiteboardDocument] = [:]
  public private(set) var omissionPrefixes: [String] = CalendarEventOmissionRules.defaultPrefixes
  public private(set) var otherPeople: [PageSnapshot] = []
  public private(set) var contactLinks: [PageID: PersonContactLink] = [:]
  public private(set) var syncStatus: SyncStatus = .localOnly
  public private(set) var isLoading = true
  public private(set) var startupError: String?
  public private(set) var calendarError: String?
  public private(set) var whiteboardError: String?
  public var selectedPageID: PageID?

  @ObservationIgnored private let repository: LibraryRepository?
  @ObservationIgnored private var syncCoordinator: CloudSyncCoordinator?
  @ObservationIgnored private var calendarProvider: EventKitCalendarProvider?
  @ObservationIgnored private var googleCalendarProvider: GoogleCalendarProvider?
  @ObservationIgnored private var contactResolver: (any DeviceContactResolving)?
  @ObservationIgnored private let calendar: Calendar
  @ObservationIgnored private var reloadGeneration: UInt64 = 0
  @ObservationIgnored private var taskMutationCoordinator: TaskMutationCoordinator?

  public init(
    repository: LibraryRepository? = nil,
    calendar: Calendar = .current,
    contactResolver: (any DeviceContactResolving)? = nil,
    startImmediately: Bool = true
  ) {
    self.calendar = calendar
    self.contactResolver = contactResolver
    if let repository {
      self.repository = repository
    } else {
      do {
        self.repository = try LibraryRepository(path: LibraryRepository.defaultLocalPath())
      } catch {
        self.repository = nil
        startupError = error.localizedDescription
      }
    }
    if let repository = self.repository {
      taskMutationCoordinator = TaskMutationCoordinator(
        repository: repository,
        calendar: calendar,
        effects: .live(
          surface: .application,
          reload: { [weak self] in
            guard let self else { return .failed("The library is unavailable.") }
            guard await self.reload() != nil else {
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
      )
    }
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
    guard let repository else {
      isLoading = false
      return
    }
    do {
      let today = try await repository.dailyPage(for: DayKey(date: Date(), calendar: calendar))
      selectedPageID = selectedPageID ?? today.id
      _ = await taskMutationCoordinator?.drainPendingEffects()
      await reload()
      let now = Date()
      let calendarStart = calendar.date(byAdding: .year, value: -1, to: now) ?? now
      let calendarEnd = calendar.date(byAdding: .year, value: 1, to: now) ?? now
      calendarEvents = try await repository.calendarEvents(
        from: calendarStart, through: calendarEnd)
      if CloudSyncCoordinator.hasRequiredEntitlement {
        let coordinator = CloudSyncCoordinator(
          repository: repository,
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
    }
  }

  @discardableResult
  public func reload() async -> [PageSnapshot]? {
    guard let repository else { return nil }
    reloadGeneration &+= 1
    let generation = reloadGeneration
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
      let now = Date()
      let calendarStart = calendar.date(byAdding: .year, value: -1, to: now) ?? now
      let calendarEnd = calendar.date(byAdding: .year, value: 1, to: now) ?? now
      let loadedCalendarEvents = try await repository.calendarEvents(
        from: calendarStart,
        through: calendarEnd
      )
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
      calendarEvents = loadedCalendarEvents
      otherPeople = loadedOtherPeople
      contactLinks = loadedContactLinks
      await TaskSystemReconciliationCoordinator.shared.submit(live)
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
      pages(with: BuiltInSupertags.person)
      + (includingOtherPeople ? otherPeople : [])
    return candidates.sorted {
      personDisplayName(for: $0).localizedStandardCompare(personDisplayName(for: $1))
        == .orderedAscending
    }
  }

  public func personDisplayName(for page: PageSnapshot) -> String {
    let contactName = contactLinks[page.id]?.record.displayName
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if let contactName, !contactName.isEmpty { return contactName }
    return page.displayTitle
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
  public func reopenTask(_ pageID: PageID) async -> PageSnapshot? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(from: await taskMutationCoordinator.reopen(pageID))
  }

  @discardableResult
  public func cancelTask(_ pageID: PageID) async -> PageSnapshot? {
    guard let taskMutationCoordinator else { return nil }
    return taskMutationValue(from: await taskMutationCoordinator.cancel(pageID))
  }

  private func taskMutationValue<Value: Sendable>(
    from result: TaskMutationResult<Value>
  ) -> Value? {
    switch result {
    case .success(let success):
      startupError = nil
      return success.value
    case .failure(let failure):
      startupError = failure.localizedDescription
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
      contactLinks = Dictionary(
        uniqueKeysWithValues: try await repository.contactLinks().map { ($0.pageID, $0) }
      )
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

  public func saveSupertag(_ definition: SupertagDefinition) {
    Task {
      do {
        try await repository?.saveSupertag(definition)
        await reload()
        await syncCoordinator?.supertagDidChange(definition.id)
      } catch { startupError = error.localizedDescription }
    }
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
      let result = try await repository.calendarEventPages(for: event)
      selectedPageID = result.occurrence.id
      await reload()
      for pageID in result.createdPageIDs {
        await syncCoordinator?.pageDidChange(pageID)
      }
      return result.occurrence.id
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
    await reload()
    await syncCoordinator?.pageDidChange(commit.pageID)
    return receipt
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
    let now = Date()
    let start = calendar.date(byAdding: .year, value: -1, to: now) ?? now
    let end = calendar.date(byAdding: .year, value: 1, to: now) ?? now
    let events = try calendarProvider.events(from: start, through: end)
    try await repository.replaceCalendarProjection(events, provider: "eventkit")
    await syncCoordinator?.enqueueDirtyChanges()
    calendarEvents = try await repository.calendarEvents(from: start, through: end)
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
    let now = Date()
    let start = calendar.date(byAdding: .year, value: -1, to: now) ?? now
    let end = calendar.date(byAdding: .year, value: 1, to: now) ?? now
    let events = try await provider.events(from: start, through: end)
    try await repository.replaceCalendarProjection(events, provider: "google")
    await syncCoordinator?.enqueueDirtyChanges()
    calendarEvents = try await repository.calendarEvents(from: start, through: end)
    calendarPageContexts = try await repository.calendarPageContexts()
    if contactResolver != nil { await refreshContactEnrichments() }
  }

  public func syncNow() async {
    await syncCoordinator?.syncNow()
    await reload()
  }
}
