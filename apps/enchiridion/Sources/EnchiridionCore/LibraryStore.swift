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
  @ObservationIgnored private let calendar: Calendar

  public init(
    repository: LibraryRepository? = nil,
    calendar: Calendar = .current,
    startImmediately: Bool = true
  ) {
    self.calendar = calendar
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
    if startImmediately {
      Task { await start() }
    }
  }

  public var selectedPage: PageSnapshot? {
    guard let selectedPageID else { return nil }
    return page(id: selectedPageID)
  }

  public func page(id: PageID) -> PageSnapshot? {
    pages.first { $0.id == id }
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
      ($0.events.first?.startDate ?? .distantFuture) < ($1.events.first?.startDate ?? .distantFuture)
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

  public func start() async {
    guard let repository else {
      isLoading = false
      return
    }
    do {
      let today = try await repository.dailyPage(for: DayKey(date: Date(), calendar: calendar))
      selectedPageID = selectedPageID ?? today.id
      await reload()
      let now = Date()
      let calendarStart = calendar.date(byAdding: .year, value: -1, to: now) ?? now
      let calendarEnd = calendar.date(byAdding: .year, value: 1, to: now) ?? now
      calendarEvents = try await repository.calendarEvents(from: calendarStart, through: calendarEnd)
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

  public func reload() async {
    guard let repository else { return }
    do {
      let live = try await repository.pages(in: .allPages)
      let trash = try await repository.pages(in: .trash)
      pages = (live + trash).sorted { $0.modifiedAt > $1.modifiedAt }
      supertags = try await repository.supertags()
      let loadedSavedViews = try await repository.savedViews()
      var viewItems: [LiveQueryID: [LiveQueryItem]] = [:]
      for view in loadedSavedViews { viewItems[view.id] = try await repository.run(view) }
      let loadedWhiteboards = try await repository.whiteboardDocuments()
      savedViews = loadedSavedViews
      liveViewItems = viewItems
      whiteboardDocuments = loadedWhiteboards
      calendarPageContexts = try await repository.calendarPageContexts()
      if let selectedPageID, page(id: selectedPageID) == nil {
        self.selectedPageID = live.first?.id
      }
      startupError = nil
    } catch {
      startupError = error.localizedDescription
    }
    isLoading = false
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

  public func taggedSuggestions(matching query: String, supertagID: SupertagID) async -> [PageSuggestion] {
    guard let repository else { return [] }
    return (try? await repository.taggedSuggestions(matching: query, supertagID: supertagID)) ?? []
  }

  public func pages(with supertagID: SupertagID) -> [PageSnapshot] {
    pages.filter { $0.deletedAt == nil && $0.hasSupertag(supertagID) }
      .sorted { $0.displayTitle.localizedStandardCompare($1.displayTitle) == .orderedAscending }
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

  public func backlinks(to pageID: PageID) async -> [PageSnapshot] {
    guard let repository else { return [] }
    return (try? await repository.backlinks(to: pageID)) ?? []
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
    Task {
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
    Task {
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
    Task {
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
    calendarEvents = try await repository.calendarEvents(from: start, through: end)
    calendarPageContexts = try await repository.calendarPageContexts()
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
      let now = Date()
      let start = calendar.date(byAdding: .year, value: -1, to: now) ?? now
      let end = calendar.date(byAdding: .year, value: 1, to: now) ?? now
      let events = try await provider.events(from: start, through: end)
      try await repository.replaceCalendarProjection(events, provider: "google")
      calendarEvents = try await repository.calendarEvents(from: start, through: end)
      calendarPageContexts = try await repository.calendarPageContexts()
      calendarError = nil
    } catch {
      calendarError = error.localizedDescription
    }
  }

  public func syncNow() async {
    await syncCoordinator?.syncNow()
    await reload()
  }
}
