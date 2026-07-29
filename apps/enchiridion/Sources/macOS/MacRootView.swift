import EnchiridionCore
import SwiftUI

struct MacRootView: View {
  @Environment(\.openWindow) private var openWindow
  @Environment(\.scenePhase) private var scenePhase

  @State private var store: LibraryStore
  @State private var selection: MacSidebarSelection = .section(.today)
  @State private var query = ""
  @State private var editingTag: SupertagDefinition?
  @State private var editingView: LiveQueryDefinition?
  @State private var showsQuickTaskCapture = false
  @State private var taskCollectionDraft: TaskCollectionDraft?
  @State private var todayPresentedPageID: PageID?
  @State private var selectedDay = Calendar.current.startOfDay(for: Date())
  @State private var editorFlushController = EditorFlushController()
  @State private var systemHandoffCoordinator = TaskSystemHandoffCoordinator()
  @State private var pagePendingPermanentDeletion: PageSnapshot?

  init(store: LibraryStore = LibraryStore()) {
    _store = State(initialValue: store)
  }

  var body: some View {
    NavigationSplitView {
      List(selection: sidebarSelectionBinding) {
        Section("Tasks") {
          ForEach(TaskSmartList.allCases) { list in
            HStack {
              Label(list.title, systemImage: list.systemImage)
              Spacer()
              if list == .inbox || list == .today || list == .upcoming {
                let count = store.taskCount(list)
                if count > 0 {
                  Text(count, format: .number)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                }
              }
            }
            .tag(MacSidebarSelection.task(.smart(list)))
          }
          Button {
            showsQuickTaskCapture = true
          } label: {
            Label("New Task", systemImage: "plus")
          }
          .buttonStyle(.plain)
        }
        if !taskPerspectives.isEmpty {
          Section("Perspectives") {
            ForEach(taskPerspectives) { view in
              Label(view.name, systemImage: view.viewKind.systemImage)
                .tag(MacSidebarSelection.view(view.id))
            }
          }
        }
        Section("Projects") {
          ForEach(store.taskProjects) { project in
            Label(project.displayTitle, systemImage: "folder")
              .tag(MacSidebarSelection.task(.project(project.id)))
          }
          Button {
            taskCollectionDraft = .init(kind: .project)
          } label: {
            Label("New Project", systemImage: "plus")
          }
          .buttonStyle(.plain)
        }
        Section("Areas") {
          ForEach(store.taskAreas) { area in
            Label(area.displayTitle, systemImage: "square.grid.2x2")
              .tag(MacSidebarSelection.task(.area(area.id)))
          }
          Button {
            taskCollectionDraft = .init(kind: .area)
          } label: {
            Label("New Area", systemImage: "plus")
          }
          .buttonStyle(.plain)
        }
        if !store.taskPeople.isEmpty {
          Section("People") {
            ForEach(store.taskPeople) { person in
              HStack {
                Label(store.personDisplayName(for: person), systemImage: "person")
                Spacer()
                let count = store.tasks(in: .person(person.id)).count
                if count > 0 {
                  Text(count, format: .number)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                }
              }
              .tag(MacSidebarSelection.task(.person(person.id)))
            }
          }
        }
        Section {
          ForEach(LibrarySection.allCases) { item in
            Label(item.title, systemImage: item.systemImage)
              .tag(MacSidebarSelection.section(item))
          }
        }
        let librarySupertags = store.supertags.filter {
          $0.id != BuiltInSupertags.task
            && $0.id != BuiltInSupertags.project
            && $0.id != BuiltInSupertags.area
        }
        if !librarySupertags.isEmpty {
          Section("Supertags") {
            ForEach(librarySupertags) { tag in
              Label(tag.name, systemImage: tag.symbol)
                .tag(MacSidebarSelection.supertag(tag.id))
            }
            Button {
              presentTagEditor(.draft())
            } label: {
              Label("New Supertag", systemImage: "plus")
            }
            .buttonStyle(.plain)
          }
        }
        Section("Views") {
          ForEach(store.savedViews.filter { !$0.isTaskListPerspective }) { view in
            Label(view.name, systemImage: view.viewKind.systemImage)
              .tag(MacSidebarSelection.view(view.id))
          }
          Button {
            presentViewEditor(.init(name: "New View", source: .pages))
          } label: {
            Label("New View", systemImage: "plus")
          }
          .buttonStyle(.plain)
        }
      }
      .listStyle(.sidebar)
      .navigationTitle("Enchiridion")
      .safeAreaInset(edge: .bottom) {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 6) {
            Image(systemName: syncSymbol)
              .accessibilityHidden(true)
            Text(store.syncStatus.title)
            Spacer()
            Button {
              Task { await store.syncNow() }
            } label: {
              if isSyncing {
                ProgressView()
                  .controlSize(.small)
              } else {
                Image(systemName: "arrow.triangle.2.circlepath")
              }
            }
            .buttonStyle(.borderless)
            .disabled(!canRequestSync)
            .help(syncActionHint)
            .accessibilityLabel(isSyncing ? "Syncing" : "Sync now")
            .accessibilityHint(syncActionHint)
          }
          Text(store.syncStatus.detail)
            .lineLimit(3)
            .truncationMode(.tail)
            .help(store.syncStatus.detail)
            .accessibilityLabel("Sync details: \(store.syncStatus.detail)")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(10)
      }
      .overlay(alignment: .bottomLeading) {
        if let calendarError = store.calendarError {
          Text(calendarError)
            .font(.caption)
            .foregroundStyle(.red)
            .padding(.horizontal, 10)
            .padding(.bottom, 36)
        }
      }
    } content: {
      if isTodaySelection {
        MacTodayEventsSidebar(
          store: store,
          day: selectedDay,
          flushController: editorFlushController,
          openPage: presentTodayPageAfterFlush
        )
        .navigationTitle("Events")
      } else if case .task(let taskSelection) = selection {
        TaskListContent(
          store: store,
          selection: taskSelection,
          query: query,
          openTask: selectPage
        )
        .navigationTitle(selection.title(in: store))
        .searchable(text: $query, prompt: "Search tasks")
      } else if let taskPerspective {
        TaskListContent(
          store: store,
          perspective: taskPerspective,
          query: query,
          openTask: selectPage
        )
        .navigationTitle(taskPerspective.name)
        .searchable(text: $query, prompt: "Search tasks")
      } else {
        pageList
          .navigationTitle(selection.title(in: store))
          .searchable(text: $query, prompt: "Search pages")
      }
    } detail: {
      if isTodaySelection {
        MacTodayWorkspace(
          store: store,
          day: selectedDay,
          flushController: editorFlushController,
          openPage: presentTodayPage
        )
      } else if let selectedPageID = store.selectedPageID {
        if case .task = selection, store.page(id: selectedPageID)?.taskData != nil {
          TaskDetailScreen(store: store, pageID: selectedPageID)
        } else {
          PageEditorView(
            store: store,
            pageID: selectedPageID,
            flushController: editorFlushController
          )
        }
      } else {
        ContentUnavailableView(
          "Choose a page",
          systemImage: "doc.text",
          description: Text("Select a page or create a new one.")
        )
      }
    }
    .toolbar {
      ToolbarItem {
        Button {
          Task { @MainActor in
            guard await editorFlushController.flush() else { return }
            openWindow(id: "assistant")
          }
        } label: {
          Label("Assistant", systemImage: "waveform.circle")
        }
        .help("Open Assistant")
      }
      if isTodaySelection {
        ToolbarItemGroup {
          Button {
            moveSelectedDay(by: -1)
          } label: {
            Label("Previous Day", systemImage: "chevron.left")
          }
          .help("Previous day")

          DatePicker("Date", selection: selectedDayBinding, displayedComponents: .date)
            .labelsHidden()
            .frame(maxWidth: 130)
            .accessibilityLabel("Daily note date")

          Button {
            moveSelectedDay(by: 1)
          } label: {
            Label("Next Day", systemImage: "chevron.right")
          }
          .help("Next day")

          if !Calendar.current.isDateInToday(selectedDay) {
            Button("Today") {
              selectDay(Date())
            }
            .help("Return to today's daily note")
          }
        }
      }
      if case .supertag(let tagID) = selection,
        let tag = store.supertags.first(where: { $0.id == tagID })
      {
        ToolbarItem {
          Button {
            presentTagEditor(tag)
          } label: {
            Label("Edit Schema", systemImage: "slider.horizontal.3")
          }
        }
      }
      ToolbarItem {
        Menu {
          Button("Enable Local Calendars", systemImage: "calendar") {
            Task { await store.enableCalendar() }
          }
          Button("Connect Google Calendar", systemImage: "globe") {
            Task { await store.enableGoogleCalendar() }
          }
        } label: {
          Label("Calendars", systemImage: "calendar.badge.plus")
        }
        .help("Connect read-only calendars")
      }
      if case .task = selection {
        ToolbarItem(placement: .primaryAction) {
          Button {
            showsQuickTaskCapture = true
          } label: {
            Label("New Task", systemImage: "plus")
          }
          .help("New Task (Command-Shift-N)")
        }
      } else {
        ToolbarItem(placement: .primaryAction) {
          Button {
            presentViewEditor(.init(name: "New View", source: .pages))
          } label: {
            Label("New View", systemImage: "rectangle.stack.badge.plus")
          }
          .help("New saved view")
        }
        ToolbarItem(placement: .primaryAction) {
          Button(action: createPage) {
            Label("New Page", systemImage: "square.and.pencil")
          }
          .help("New Page")
        }
      }
    }
    .focusedSceneValue(\.newPageAction, createPage)
    .focusedSceneValue(\.newTaskAction, { showsQuickTaskCapture = true })
    .focusedSceneValue(\.openTaskListAction, openTaskList)
    .sheet(item: $editingTag) { tag in
      SupertagSchemaEditor(store: store, definition: tag)
    }
    .sheet(item: $editingView) { view in
      LiveViewEditor(store: store, definition: view)
    }
    .sheet(item: $todayPresentedPageID) { pageID in
      NavigationStack {
        PageEditorView(
          store: store,
          pageID: pageID,
          flushController: editorFlushController,
          onOpenPage: presentTodayPage
        )
        .frame(minWidth: 720, minHeight: 560)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") { dismissTodayPage() }
          }
        }
      }
    }
    .sheet(isPresented: $showsQuickTaskCapture) {
      TaskQuickCaptureSheet(store: store, selection: selection.taskSelection ?? .smart(.inbox))
    }
    .sheet(item: $taskCollectionDraft) { draft in
      TaskCollectionCreator(store: store, draft: draft)
    }
    .onChange(of: store.savedViews) { _, views in
      if case .view(let id) = selection, !views.contains(where: { $0.id == id }) {
        selectSidebar(.section(.allPages))
      }
    }
    .task(id: selectedDay) {
      guard isTodaySelection else { return }
      _ = await store.openDailyPage(for: selectedDay)
    }
    .onOpenURL { url in
      guard let route = TaskDeepLinkRoute(url: url) else { return }
      Task { await receive(route) }
    }
    .onChange(of: scenePhase) { _, phase in
      guard phase == .active else { return }
      Task { await refreshForActivation() }
    }
    .task { await refreshForActivation() }
    .confirmsPermanentPageDeletion(page: $pagePendingPermanentDeletion) {
      store.purge(pageID: $0)
    }
  }

  private var isTodaySelection: Bool {
    selection == .section(.today)
  }

  private var taskPerspectives: [LiveQueryDefinition] {
    store.savedViews.filter(\.isTaskListPerspective)
  }

  private var taskPerspective: LiveQueryDefinition? {
    guard case .view(let viewID) = selection else { return nil }
    return taskPerspectives.first { $0.id == viewID }
  }

  @ViewBuilder
  private var pageList: some View {
    if case .view(let viewID) = selection,
      let view = store.savedViews.first(where: { $0.id == viewID })
    {
      LiveViewScreen(store: store, definition: view) { pageID in
        selectPage(pageID)
      }
    } else {
      let section = selection.librarySection
      let pages = section.map { store.pages(in: $0, matching: query) } ?? []
      let todaysEvents = store.events(on: Date())
      List(selection: pageSelectionBinding) {
        if case .supertag(let tagID) = selection {
          let taggedPages = store.pages(with: tagID).filter {
            query.isEmpty || $0.title.localizedStandardContains(query)
              || $0.plainText.localizedStandardContains(query)
          }
          if taggedPages.isEmpty {
            ContentUnavailableView(
              "No tagged pages",
              systemImage: "number",
              description: Text("Apply this Supertag to a page or selected text.")
            )
          } else {
            ForEach(taggedPages) { page in
              PageRowView(page: page, calendarContext: store.calendarPageContext(for: page.id))
                .tag(page.id)
                .contextMenu { contextMenu(for: page) }
            }
          }
        } else if section == .calendar {
          if store.calendarEvents.isEmpty {
            Section("Imported Events") {
              ContentUnavailableView(
                "No Calendar Events",
                systemImage: "calendar.badge.exclamationmark",
                description: Text(
                  store.calendarError ?? "Connect a calendar or refresh its events.")
              )
            }
          } else {
            ForEach(store.calendarEventGroups) { group in
              if group.series != nil, let first = group.events.first {
                Section {
                  ForEach(group.events) { event in
                    calendarEventButton(event, showsDate: true)
                  }
                } header: {
                  Button {
                    openCalendarSeries(first)
                  } label: {
                    HStack {
                      Text(group.title)
                      Spacer()
                      Label("Series notes", systemImage: "rectangle.stack")
                        .font(.caption)
                    }
                  }
                  .buttonStyle(.plain)
                }
              } else {
                Section("One-off event") {
                  ForEach(group.events) { event in
                    calendarEventButton(event, showsDate: true)
                  }
                }
              }
            }
          }
        }
        if section == .today, !todaysEvents.isEmpty {
          Section("Agenda") {
            ForEach(todaysEvents) { event in
              Button {
                openCalendarEvent(event)
              } label: {
                CalendarEventRow(event: event)
              }
              .buttonStyle(.plain)
            }
          }
        }
        if let section, section != .calendar {
          Section(section == .today ? "Notes" : section.title) {
            if pages.isEmpty {
              Button(action: createPage) {
                Label(
                  section == .trash ? "Trash is empty" : "Create a page",
                  systemImage: "doc.badge.plus")
              }
              .disabled(section == .trash)
            } else {
              ForEach(pages) { page in
                PageRowView(page: page, calendarContext: store.calendarPageContext(for: page.id))
                  .tag(page.id)
                  .contextMenu { contextMenu(for: page) }
              }
            }
          }
        }
      }
    }
  }

  private func calendarEventButton(_ event: CalendarEventSnapshot, showsDate: Bool) -> some View {
    Button {
      openCalendarEvent(event)
    } label: {
      CalendarEventRow(event: event, showsDate: showsDate)
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private func contextMenu(for page: PageSnapshot) -> some View {
    PageLifecycleMenuActions(
      store: store,
      page: page,
      requestPermanentDeletion: { pagePendingPermanentDeletion = $0 }
    )
  }

  private var syncSymbol: String {
    switch store.syncStatus {
    case .syncing: "arrow.triangle.2.circlepath"
    case .synced: "checkmark.icloud"
    case .offline: "icloud.slash"
    case .localOnly: "internaldrive"
    case .iCloudUnavailable, .attentionRequired: "exclamationmark.icloud"
    }
  }

  private var isSyncing: Bool {
    if case .syncing = store.syncStatus { return true }
    return false
  }

  private var canRequestSync: Bool {
    switch store.syncStatus {
    case .synced, .offline, .attentionRequired:
      true
    case .localOnly, .syncing, .iCloudUnavailable:
      false
    }
  }

  private var syncActionHint: String {
    if isSyncing { return "A sync is already in progress." }
    if canRequestSync { return "Checks iCloud now for updates and retries any pending work." }
    return store.syncStatus.detail
  }

  private func createPage() {
    Task { @MainActor in
      guard await editorFlushController.flush() else { return }
      query = ""
      switch selection {
      case .supertag(let tagID):
        let name = store.supertags.first(where: { $0.id == tagID })?.name ?? "Page"
        await store.createTaggedPage(title: "Untitled \(name)", supertagID: tagID)
      case .section:
        selection = .section(.allPages)
        await store.createFreePage()
      case .view:
        await store.createFreePage()
      case .task:
        showsQuickTaskCapture = true
      }
    }
  }

  private func moveSelectedDay(by value: Int) {
    guard let day = Calendar.current.date(byAdding: .day, value: value, to: selectedDay) else {
      return
    }
    selectDay(day)
  }

  private var sidebarSelectionBinding: Binding<MacSidebarSelection> {
    Binding(
      get: { selection },
      set: { selectSidebar($0) }
    )
  }

  private var pageSelectionBinding: Binding<PageID?> {
    Binding(
      get: { store.selectedPageID },
      set: { destination in
        Task { @MainActor in
          guard await editorFlushController.flush() else { return }
          store.selectedPageID = destination
        }
      }
    )
  }

  private var selectedDayBinding: Binding<Date> {
    Binding(
      get: { selectedDay },
      set: { selectDay($0) }
    )
  }

  private func selectSidebar(_ destination: MacSidebarSelection) {
    Task { @MainActor in
      guard await editorFlushController.flush() else { return }
      selection = destination
    }
  }

  private func openTaskList(_ list: TaskSmartList) {
    query = ""
    selectSidebar(.task(.smart(list)))
  }

  private func receive(_ route: TaskDeepLinkRoute) async {
    let outcome = await systemHandoffCoordinator.open(route) {
      guard await editorFlushController.flush() else { return nil }
      return await store.reload()
    }
    guard let route = outcome?.route else { return }
    apply(route)
  }

  private func refreshForActivation() async {
    let outcome = await systemHandoffCoordinator.activate {
      guard await editorFlushController.flush() else { return nil }
      return await store.reload()
    }
    guard let route = outcome?.route else { return }
    apply(route)
  }

  private func apply(_ route: TaskDeepLinkRoute) {
    query = ""
    selection = .task(.smart(route.list))

    switch route {
    case .list:
      showsQuickTaskCapture = false
      store.selectedPageID = nil
    case .task(let pageID, list: _):
      showsQuickTaskCapture = false
      store.selectedPageID = pageID
    case .quickAdd:
      store.selectedPageID = nil
      showsQuickTaskCapture = true
    }
  }

  private func selectPage(_ pageID: PageID) {
    Task { @MainActor in
      guard await editorFlushController.flush() else { return }
      store.selectedPageID = pageID
    }
  }

  private func selectDay(_ date: Date) {
    let destination = Calendar.current.startOfDay(for: date)
    guard !Calendar.current.isDate(destination, inSameDayAs: selectedDay) else { return }
    Task { @MainActor in
      guard await editorFlushController.flush() else { return }
      selectedDay = destination
    }
  }

  private func presentTodayPage(_ pageID: PageID) {
    Task { @MainActor in
      guard await editorFlushController.flush() else { return }
      presentTodayPageAfterFlush(pageID)
    }
  }

  private func presentTodayPageAfterFlush(_ pageID: PageID) {
    todayPresentedPageID = pageID
  }

  private func dismissTodayPage() {
    Task { @MainActor in
      guard await editorFlushController.flush() else { return }
      todayPresentedPageID = nil
    }
  }

  private func presentTagEditor(_ definition: SupertagDefinition) {
    Task { @MainActor in
      guard await editorFlushController.flush() else { return }
      editingTag = definition
    }
  }

  private func presentViewEditor(_ definition: LiveQueryDefinition) {
    Task { @MainActor in
      guard await editorFlushController.flush() else { return }
      editingView = definition
    }
  }

  private func openCalendarEvent(_ event: CalendarEventSnapshot) {
    Task { @MainActor in
      guard await editorFlushController.flush() else { return }
      await store.openCalendarEventPage(event)
    }
  }

  private func openCalendarSeries(_ event: CalendarEventSnapshot) {
    Task { @MainActor in
      guard await editorFlushController.flush() else { return }
      await store.openCalendarSeriesPage(event)
    }
  }
}

private struct MacTodayEventsSidebar: View {
  let store: LibraryStore
  let day: Date
  let flushController: EditorFlushController
  let openPage: (PageID) -> Void

  var body: some View {
    let events = store.events(on: day)
    List {
      Section(day.formatted(.dateTime.weekday(.wide).month(.wide).day())) {
        if events.isEmpty {
          ContentUnavailableView(
            "No events",
            systemImage: "calendar",
            description: Text("Your calendar is clear for this day.")
          )
        } else {
          ForEach(events) { event in
            Button {
              Task {
                guard await flushController.flush() else { return }
                if let pageID = await store.openCalendarEventPage(event) { openPage(pageID) }
              }
            } label: {
              CalendarEventRow(event: event)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
    .listStyle(.sidebar)
    .navigationSplitViewColumnWidth(min: 220, ideal: 280, max: 360)
  }
}

private struct MacTodayWorkspace: View {
  let store: LibraryStore
  let day: Date
  let flushController: EditorFlushController
  let openPage: (PageID) -> Void

  var body: some View {
    HSplitView {
      Group {
        if store.page(id: dailyPageID) != nil {
          PageEditorView(
            store: store,
            pageID: dailyPageID,
            flushController: flushController,
            onOpenPage: openPage
          )
          .safeAreaInset(edge: .top, spacing: 0) {
            MacDailyTaskContext(
              store: store,
              day: day,
              openTask: openPage,
              flushBeforeChange: flushController.flush
            )
            .id(dailyPageID)
          }
        } else if store.isLoading {
          ProgressView("Opening today’s note")
        } else {
          ContentUnavailableView(
            "Today’s note is unavailable",
            systemImage: "doc.badge.exclamationmark",
            description: Text(store.startupError ?? "Try reopening Enchiridion.")
          )
        }
      }
      .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)

      MacTodayChangedPagesSidebar(
        store: store,
        day: day,
        excluding: dailyPageID,
        openPage: openPage
      )
      .frame(minWidth: 240, idealWidth: 300, maxWidth: 380, maxHeight: .infinity)
    }
  }

  private var dailyPageID: PageID {
    .daily(DayKey(date: day))
  }
}

private struct MacTodayChangedPagesSidebar: View {
  let store: LibraryStore
  let day: Date
  let excluding: PageID
  let openPage: (PageID) -> Void

  var body: some View {
    let pages = store.pagesCreatedOrModified(on: day).filter { $0.id != excluding }
    List {
      Section("Changed Pages") {
        if pages.isEmpty {
          ContentUnavailableView(
            "No changed pages",
            systemImage: "clock.arrow.circlepath",
            description: Text("Pages you create or edit today appear here, earliest first.")
          )
        } else {
          ForEach(pages) { page in
            Button {
              openPage(page.id)
            } label: {
              VStack(alignment: .leading, spacing: 3) {
                Text(page.displayTitle)
                  .lineLimit(2)
                Text(activityLabel(for: page))
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(.rect)
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
    .listStyle(.sidebar)
  }

  private func activityLabel(for page: PageSnapshot) -> String {
    let action = abs(page.modifiedAt.timeIntervalSince(page.createdAt)) < 1 ? "Created" : "Edited"
    return "\(action) \(page.modifiedAt.formatted(date: .omitted, time: .shortened))"
  }
}

@MainActor
private enum MacSidebarSelection: Hashable {
  case section(LibrarySection)
  case task(TaskListSelection)
  case supertag(SupertagID)
  case view(LiveQueryID)

  var librarySection: LibrarySection? {
    guard case .section(let section) = self else { return nil }
    return section
  }

  var taskSelection: TaskListSelection? {
    guard case .task(let selection) = self else { return nil }
    return selection
  }

  func title(in store: LibraryStore) -> String {
    switch self {
    case .section(let section): section.title
    case .task(.smart(let list)): list.title
    case .task(.project(let id)): store.page(id: id)?.displayTitle ?? "Project"
    case .task(.area(let id)): store.page(id: id)?.displayTitle ?? "Area"
    case .task(.person(let id)): store.personDisplayName(for: id) ?? "Person"
    case .task(.tag(let value)): value
    case .task(.search): "Search"
    case .supertag(let id): store.supertags.first(where: { $0.id == id })?.name ?? "Supertag"
    case .view(let id): store.savedViews.first(where: { $0.id == id })?.name ?? "View"
    }
  }
}
