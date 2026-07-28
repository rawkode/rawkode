import EnchiridionCore
import SwiftUI

struct MacRootView: View {
  @State private var store = LibraryStore()
  @State private var selection: MacSidebarSelection = .section(.today)
  @State private var query = ""
  @State private var editingTag: SupertagDefinition?
  @State private var editingView: LiveQueryDefinition?
  @State private var todayPresentedPageID: PageID?
  @State private var selectedDay = Calendar.current.startOfDay(for: Date())

  var body: some View {
    NavigationSplitView {
      List(selection: $selection) {
        Section {
          ForEach(LibrarySection.allCases) { item in
            Label(item.title, systemImage: item.systemImage)
              .tag(MacSidebarSelection.section(item))
          }
        }
        if !store.supertags.isEmpty {
          Section("Supertags") {
            ForEach(store.supertags) { tag in
              Label(tag.name, systemImage: tag.symbol)
                .tag(MacSidebarSelection.supertag(tag.id))
            }
            Button { editingTag = .draft() } label: {
              Label("New Supertag", systemImage: "plus")
            }
            .buttonStyle(.plain)
          }
        }
        Section("Views") {
          ForEach(store.savedViews) { view in
            Label(view.name, systemImage: view.viewKind.systemImage)
              .tag(MacSidebarSelection.view(view.id))
          }
          Button { editingView = .init(name: "New View", source: .pages) } label: {
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
        MacTodayEventsSidebar(store: store, day: selectedDay) { pageID in
          todayPresentedPageID = pageID
        }
        .navigationTitle("Events")
      } else {
        pageList
          .navigationTitle(selection.title(in: store))
          .searchable(text: $query, prompt: "Search pages")
      }
    } detail: {
      if isTodaySelection {
        MacTodayWorkspace(store: store, day: selectedDay) { pageID in
          todayPresentedPageID = pageID
        }
      } else if let selectedPageID = store.selectedPageID {
        PageEditorView(store: store, pageID: selectedPageID)
      } else {
        ContentUnavailableView(
          "Choose a page",
          systemImage: "doc.text",
          description: Text("Select a page or create a new one.")
        )
      }
    }
    .toolbar {
      if isTodaySelection {
        ToolbarItemGroup {
          Button {
            moveSelectedDay(by: -1)
          } label: {
            Label("Previous Day", systemImage: "chevron.left")
          }
          .help("Previous day")

          DatePicker("Date", selection: $selectedDay, displayedComponents: .date)
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
              selectedDay = Calendar.current.startOfDay(for: Date())
            }
            .help("Return to today's daily note")
          }
        }
      }
      if case .supertag(let tagID) = selection,
        let tag = store.supertags.first(where: { $0.id == tagID })
      {
        ToolbarItem {
          Button { editingTag = tag } label: {
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
      ToolbarItem(placement: .primaryAction) {
        Button { editingView = .init(name: "New View", source: .pages) } label: {
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
    .focusedSceneValue(\.newPageAction, createPage)
    .sheet(item: $editingTag) { tag in
      SupertagSchemaEditor(store: store, definition: tag)
    }
    .sheet(item: $editingView) { view in
      LiveViewEditor(store: store, definition: view)
    }
    .sheet(item: $todayPresentedPageID) { pageID in
      NavigationStack {
        PageEditorView(store: store, pageID: pageID)
          .frame(minWidth: 720, minHeight: 560)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Done") { todayPresentedPageID = nil }
            }
          }
      }
    }
    .onChange(of: store.savedViews) { _, views in
      if case .view(let id) = selection, !views.contains(where: { $0.id == id }) {
        selection = .section(.allPages)
      }
    }
    .task(id: selectedDay) {
      guard isTodaySelection else { return }
      _ = await store.openDailyPage(for: selectedDay)
    }
  }

  private var isTodaySelection: Bool {
    selection == .section(.today)
  }

  @ViewBuilder
  private var pageList: some View {
    if case .view(let viewID) = selection,
      let view = store.savedViews.first(where: { $0.id == viewID })
    {
      LiveViewScreen(store: store, definition: view) { pageID in
        store.selectedPageID = pageID
      }
    } else {
      let section = selection.librarySection
      let pages = section.map { store.pages(in: $0, matching: query) } ?? []
      let todaysEvents = store.events(on: Date())
      List(selection: $store.selectedPageID) {
        if case .supertag(let tagID) = selection {
          let taggedPages = store.pages(with: tagID).filter {
            query.isEmpty || $0.title.localizedStandardContains(query) || $0.plainText.localizedStandardContains(query)
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
                description: Text(store.calendarError ?? "Connect a calendar or refresh its events.")
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
                    Task { await store.openCalendarSeriesPage(first) }
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
                Task { await store.openCalendarEventPage(event) }
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
                Label(section == .trash ? "Trash is empty" : "Create a page", systemImage: "doc.badge.plus")
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
      Task { await store.openCalendarEventPage(event) }
    } label: {
      CalendarEventRow(event: event, showsDate: showsDate)
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private func contextMenu(for page: PageSnapshot) -> some View {
    if page.deletedAt == nil {
      Button(page.isPinned ? "Unpin" : "Pin") { store.togglePinned(pageID: page.id) }
      Divider()
      Button("Move to Trash", role: .destructive) { store.moveToTrash(pageID: page.id) }
    } else {
      Button("Restore") { store.restore(pageID: page.id) }
      Divider()
      Button("Delete Permanently", role: .destructive) { store.purge(pageID: page.id) }
    }
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
    query = ""
    switch selection {
    case .supertag(let tagID):
      let name = store.supertags.first(where: { $0.id == tagID })?.name ?? "Page"
      Task { await store.createTaggedPage(title: "Untitled \(name)", supertagID: tagID) }
    case .section:
      selection = .section(.allPages)
      Task { await store.createFreePage() }
    case .view:
      Task { await store.createFreePage() }
    }
  }

  private func moveSelectedDay(by value: Int) {
    guard let day = Calendar.current.date(byAdding: .day, value: value, to: selectedDay) else { return }
    selectedDay = Calendar.current.startOfDay(for: day)
  }
}

private struct MacTodayEventsSidebar: View {
  let store: LibraryStore
  let day: Date
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
  let openPage: (PageID) -> Void

  var body: some View {
    HSplitView {
      Group {
        if store.page(id: dailyPageID) != nil {
          PageEditorView(store: store, pageID: dailyPageID)
            .navigationTitle(day.formatted(.dateTime.weekday(.wide).month(.wide).day().year()))
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
            Button { openPage(page.id) } label: {
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
  case supertag(SupertagID)
  case view(LiveQueryID)

  var librarySection: LibrarySection? {
    guard case .section(let section) = self else { return nil }
    return section
  }

  func title(in store: LibraryStore) -> String {
    switch self {
    case .section(let section): section.title
    case .supertag(let id): store.supertags.first(where: { $0.id == id })?.name ?? "Supertag"
    case .view(let id): store.savedViews.first(where: { $0.id == id })?.name ?? "View"
    }
  }
}
