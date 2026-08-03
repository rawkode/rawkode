import EnchiridionCore
import SwiftUI
import UIKit

struct TodayWorkspaceView: View {
  let store: LibraryStore

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.layoutDirection) private var layoutDirection
  @State private var day: Date
  @State private var panel: TodayPanel = .plan
  @State private var path: [PageID] = []
  @State private var flushController = EditorFlushController()
  @State private var transition: TodayWorkspaceTransitionCoordinator
  @State private var datePicker: TodayDatePickerSelection?
  @State private var presentedSheet: TodaySheet?
  @State private var searchText = ""
  @State private var selectedCalendarTitles: Set<String> = []
  @State private var isEditorFocused = false
  @State private var isOpeningNote = false
  @State private var transitionError: String?
  @State private var transitionAlertMessage: String?

  private let calendar = Calendar.current

  init(store: LibraryStore) {
    self.store = store
    let today = Calendar.current.startOfDay(for: Date())
    _day = State(initialValue: today)
    _transition = State(initialValue: TodayWorkspaceTransitionCoordinator(day: today))
  }

  var body: some View {
    NavigationStack(path: $path) {
      VStack(spacing: 0) {
        TodayWorkspaceChrome(
          day: day,
          panel: $panel,
          events: filteredEvents,
          calendar: calendar,
          showDatePicker: { requestDatePicker() },
          selectDay: requestDay,
          selectPanel: requestPanel
        )
        .padding(.horizontal)
        .padding(.top, 8)

        Group {
          switch panel {
          case .plan:
            DayPlanView(
              store: store,
              day: day,
              events: filteredEvents,
              selectedCalendarEvents: eventsInSelectedCalendars,
              searchText: searchText,
              calendar: calendar,
              scheduleTask: scheduleTask,
              openOccurrenceNote: openOccurrenceNote,
              openSeriesNote: openSeriesNote,
              viewAllAnytime: { presentedSheet = .tasks },
              refresh: { try? await store.refreshCalendar() }
            )
            .searchable(
              text: $searchText, placement: .navigationBarDrawer(displayMode: .automatic),
              prompt: "Search this day")
          case .note:
            note
          }
        }
        .contentShape(Rectangle())
        .gesture(panelSwipe)
      }
      .overlay(alignment: .topTrailing) {
        if isOpeningNote {
          ProgressView("Opening note")
            .font(.caption)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule())
            .padding()
        }
      }
      .background(RosePinePalette.background)
      .navigationTitle("Today")
      .navigationBarTitleDisplayMode(.inline)
      .navigationDestination(for: PageID.self) { pageID in
        PageDestinationView(
          store: store, pageID: pageID, flushController: flushController, onOpenPage: navigate)
      }
      .disabled(isOpeningNote)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Today") { requestDay(Date()) }
            .disabled(calendar.isDateInToday(day))
        }
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            CalendarFilterMenu(
              calendarTitles: calendarTitles, selectedCalendarTitles: $selectedCalendarTitles)
            Button("Changed Pages", systemImage: "clock.arrow.circlepath") {
              presentedSheet = .pages
            }
          } label: {
            Label("More Today actions", systemImage: "ellipsis.circle")
          }
        }
      }
    }
    .sheet(item: $datePicker) { selection in
      TodayDatePicker(initialDate: selection.date, selectDate: requestDay)
    }
    .sheet(item: $presentedSheet) { sheet in
      NavigationStack {
        Group {
          switch sheet {
          case .tasks:
            TaskListScreen(store: store, selection: .smart(.anytime))
          case .pages:
            TodayChangedPagesList(
              store: store, day: day, excluding: dailyPageID, openPage: openPage
            )
            .navigationTitle("Changed Pages")
          }
        }
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Done") { presentedSheet = nil } }
        }
      }
      .presentationDetents([.medium, .large])
    }
    .alert("Unable to Change Workspace", isPresented: transitionAlertBinding) {
      Button("Dismiss Error", role: .cancel) {}
    } message: {
      Text(transitionAlertMessage ?? "The daily note could not be saved.")
    }
    .onReceive(NotificationCenter.default.publisher(for: .enchiridionEditorFocusDidChange)) {
      note in
      isEditorFocused = note.userInfo?["isFocused"] as? Bool ?? false
    }
  }

  @ViewBuilder private var note: some View {
    if store.page(id: dailyPageID) != nil {
      PageEditorView(
        store: store, pageID: dailyPageID,
        presentation: .dailyWorkspace { EmptyView() },
        flushController: flushController, onOpenPage: navigate, showsPageActions: false
      )
    } else if store.isLoading || isOpeningNote {
      ProgressView("Opening daily note")
    } else {
      ContentUnavailableView(
        "Daily note unavailable", systemImage: "doc.badge.exclamationmark",
        description: Text(transitionError ?? store.startupError ?? "Try reopening Enchiridion."))
    }
  }

  private var dailyPageID: PageID { .daily(DayKey(date: day)) }
  private var transitionAlertBinding: Binding<Bool> {
    Binding(
      get: { transitionAlertMessage != nil },
      set: { if !$0 { transitionAlertMessage = nil } }
    )
  }
  private var eventsInSelectedCalendars: [CalendarEventSnapshot] {
    store.calendarEvents.filter {
      selectedCalendarTitles.isEmpty || selectedCalendarTitles.contains($0.calendarTitle)
    }
  }
  private var filteredEvents: [CalendarEventSnapshot] {
    eventsInSelectedCalendars.filter(eventMatchesSearch)
  }
  private var calendarTitles: [String] {
    Array(Set(store.calendarEvents.map(\.calendarTitle))).sorted()
  }

  private var panelSwipe: some Gesture {
    DragGesture(minimumDistance: 20).onEnded { value in
      guard !isEditorFocused, abs(value.translation.width) > abs(value.translation.height) * 1.5,
        abs(value.translation.width) > 56
      else { return }
      let movingForward =
        layoutDirection == .rightToLeft ? value.translation.width > 0 : value.translation.width < 0
      if movingForward, panel == .plan { requestPanel(.note) }
      if !movingForward, panel == .note { requestPanel(.plan) }
    }
  }

  private func requestDatePicker() {
    requestTransition(.init(day: day, panel: transitionPanel(panel)), presentPicker: true)
  }
  private func requestDay(_ date: Date) {
    requestTransition(.init(day: calendar.startOfDay(for: date), panel: transitionPanel(panel)))
  }
  private func requestPanel(_ panel: TodayPanel) {
    requestTransition(.init(day: day, panel: transitionPanel(panel)))
  }

  private func requestTransition(
    _ target: TodayWorkspaceTransitionCoordinator.Target, presentPicker: Bool = false
  ) {
    transition.request(target) { generation, target in
      if presentPicker {
        guard await flushController.flush(), transition.isCurrent(generation, target: target) else {
          return
        }
        datePicker = TodayDatePickerSelection(date: day)
        return
      }
      if panel == .note {
        guard await flushController.flush(), transition.isCurrent(generation, target: target) else {
          if transition.isCurrent(generation, target: target) {
            transitionAlertMessage = "Couldn’t save the daily note. Please try again."
          }
          return
        }
      }
      guard transition.isCurrent(generation, target: target) else { return }
      transitionError = nil
      datePicker = nil
      if target.panel == .note {
        isOpeningNote = true
        let pageID = await store.openDailyPage(for: target.day)
        guard transition.isCurrent(generation, target: target) else { return }
        guard pageID != nil else {
          isOpeningNote = false
          transitionAlertMessage =
            store.startupError ?? "Couldn’t open this daily note. Please try again."
          return
        }
        transition.commitIfCurrent(generation, target: target) {
          path.removeAll()
          day = target.day
          panel = .note
          isOpeningNote = false
        }
      } else {
        transition.commitIfCurrent(generation, target: target) {
          path.removeAll()
          day = target.day
          panel = .plan
          isOpeningNote = false
        }
      }
    }
  }

  private func transitionPanel(_ panel: TodayPanel) -> TodayWorkspaceTransitionCoordinator.Panel {
    panel == .plan ? .plan : .note
  }

  private func eventMatchesSearch(_ event: CalendarEventSnapshot) -> Bool {
    guard !searchText.isEmpty else { return true }
    return [event.title, event.location, event.calendarTitle].compactMap { $0 }.contains {
      $0.localizedCaseInsensitiveContains(searchText)
    }
  }
  private func scheduleTask(_ task: TaskItem, at date: Date) {
    Task { @MainActor in
      guard await flushController.flush() else { return }
      var data = task.data
      data.scheduledAt = date
      data.scheduleGranularity = .dateTime
      await store.updateTask(pageID: task.id, data: data)
    }
  }
  private func openOccurrenceNote(_ event: CalendarEventSnapshot) {
    openEvent(event, series: false)
  }
  private func openSeriesNote(_ event: CalendarEventSnapshot) { openEvent(event, series: true) }
  private func openEvent(_ event: CalendarEventSnapshot, series: Bool) {
    Task { @MainActor in
      guard await flushController.flush() else { return }
      let id =
        series
        ? await store.openCalendarSeriesPage(event) : await store.openCalendarEventPage(event)
      if let id { navigate(id) }
    }
  }
  private func openPage(_ pageID: PageID) {
    Task { @MainActor in
      guard await flushController.flush() else { return }
      presentedSheet = nil
      navigate(pageID)
    }
  }
  private func navigate(_ pageID: PageID) {
    guard path.last != pageID else { return }
    path.append(pageID)
  }
}

private enum TodayPanel: String, CaseIterable, Identifiable {
  case plan = "Plan"
  case note = "Note"
  var id: Self { self }
}
private enum TodaySheet: Identifiable {
  case tasks, pages
  var id: Self { self }
}
private struct TodayDatePickerSelection: Identifiable {
  let id = UUID()
  let date: Date
}

private struct TodayWorkspaceChrome: View {
  let day: Date
  @Binding var panel: TodayPanel
  let events: [CalendarEventSnapshot]
  let calendar: Calendar
  let showDatePicker: () -> Void
  let selectDay: (Date) -> Void
  let selectPanel: (TodayPanel) -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button(action: showDatePicker) {
        VStack(alignment: .leading, spacing: 2) {
          Text(calendar.isDateInToday(day) ? "Today" : day.formatted(.dateTime.weekday(.wide)))
            .font(.title2.weight(.bold))
          Text(day.formatted(.dateTime.month(.wide).day().year()))
            .font(.subheadline)
            .foregroundStyle(RosePinePalette.secondaryText)
        }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
      }.buttonStyle(.plain).accessibilityLabel(
        "Choose date, currently \(day.formatted(date: .long, time: .omitted))")
      CalendarDayStrip(selectedDay: day, events: events, calendar: calendar, selectDay: selectDay)
      Picker("Today workspace", selection: Binding(get: { panel }, set: { selectPanel($0) })) {
        ForEach(TodayPanel.allCases) { Text($0.rawValue).tag($0) }
      }.pickerStyle(.segmented)
        .accessibilityLabel("Today workspace panel")
    }
  }
}

private struct TodayDatePicker: View {
  @Environment(\.dismiss) private var dismiss
  @State private var date: Date
  let selectDate: (Date) -> Void
  init(initialDate: Date, selectDate: @escaping (Date) -> Void) {
    _date = State(initialValue: initialDate)
    self.selectDate = selectDate
  }
  var body: some View {
    NavigationStack {
      DatePicker("Selected day", selection: $date, displayedComponents: .date).datePickerStyle(
        .graphical
      ).padding().navigationTitle("Choose Date").toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Open Date") {
            selectDate(date)
            dismiss()
          }
        }
      }
    }.presentationDetents([.medium])
  }
}

private struct TodayChangedPagesList: View {
  let store: LibraryStore
  let day: Date
  let excluding: PageID
  let openPage: (PageID) -> Void
  var body: some View {
    let pages = store.pagesCreatedOrModified(on: day).filter { $0.id != excluding }
    Group {
      if pages.isEmpty {
        ContentUnavailableView(
          "No changed pages", systemImage: "clock.arrow.circlepath",
          description: Text("Pages you create or edit today appear here, earliest first."))
      } else {
        List(pages) { page in
          Button {
            openPage(page.id)
          } label: {
            VStack(alignment: .leading, spacing: 4) {
              Text(page.displayTitle).font(.body.weight(.medium)).foregroundStyle(.primary)
                .lineLimit(2)
              Text(activityLabel(for: page)).font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
          }.buttonStyle(.plain)
        }.listStyle(.plain).scrollContentBackground(.hidden)
      }
    }
  }
  private func activityLabel(for page: PageSnapshot) -> String {
    let action = abs(page.modifiedAt.timeIntervalSince(page.createdAt)) < 1 ? "Created" : "Edited"
    return "\(action) \(page.modifiedAt.formatted(date: .omitted, time: .shortened))"
  }
}
