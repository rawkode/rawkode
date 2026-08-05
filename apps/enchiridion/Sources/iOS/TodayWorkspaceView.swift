import EnchiridionCore
import SwiftUI
import UIKit

struct TodayWorkspaceView: View {
  let store: LibraryStore
  let returnToTodayRequest: Int

  @Environment(\.layoutDirection) private var layoutDirection
  @State private var day: Date
  @State private var panel: TodayPanel = .plan
  @State private var path: [PageID] = []
  @State private var flushController = EditorFlushController()
  @State private var transition: TodayWorkspaceTransitionCoordinator
  @State private var datePicker: TodayDatePickerSelection?
  @State private var presentedSheet: TodaySheet?
  @State private var searchText = ""
  @State private var isSearchPresented = false
  @State private var selectedCalendarTitles: Set<String> = []
  @State private var isEditorFocused = false
  @State private var isOpeningNote = false
  @State private var transitionError: String?
  @State private var transitionAlertMessage: String?
  @State private var lastConsumedReturnToTodayRequest: Int

  private let calendar = Calendar.current

  init(store: LibraryStore, returnToTodayRequest: Int = 0) {
    self.store = store
    self.returnToTodayRequest = returnToTodayRequest
    let today = Calendar.current.startOfDay(for: Date())
    _day = State(initialValue: today)
    _transition = State(initialValue: TodayWorkspaceTransitionCoordinator(day: today))
    _lastConsumedReturnToTodayRequest = State(initialValue: returnToTodayRequest)
  }

  var body: some View {
    NavigationStack(path: $path) {
      VStack(spacing: 0) {
        TodayWorkspaceChrome(
          day: day,
          panel: $panel,
          events: filteredEvents,
          calendar: calendar,
          searchText: $searchText,
          isSearchPresented: $isSearchPresented,
          calendarTitles: calendarTitles,
          selectedCalendarTitles: $selectedCalendarTitles,
          showDatePicker: { requestDatePicker() },
          selectDay: requestDay,
          selectPanel: requestPanel,
          showChangedPages: { presentedSheet = .pages }
        )

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
            .safeAreaInset(edge: .bottom, spacing: 0) {
              TodaySavedLinksSection(
                links: store.savedLinks(on: DayKey(date: day, calendar: calendar), timeZoneIdentifier: timeZoneIdentifier),
                openPage: openPage
              )
            }
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
      .background(RosePinePalette.calendarBackground)
      .tint(RosePinePalette.calendarAccent)
      .navigationTitle("")
      .toolbar(path.isEmpty ? .hidden : .visible, for: .navigationBar)
      .navigationDestination(for: PageID.self) { pageID in
        PageDestinationView(
          store: store, pageID: pageID, flushController: flushController, onOpenPage: navigate)
      }
      .disabled(isOpeningNote)
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
    .onChange(of: returnToTodayRequest) { _, request in
      guard request > lastConsumedReturnToTodayRequest else { return }
      lastConsumedReturnToTodayRequest = request
      requestReturnToToday()
    }
    .onChange(of: Set(store.suppressedBookmarkTrash.keys)) { _, _ in
      path.removeAll { !store.canOpenPage($0) }
    }
  }

  @ViewBuilder private var note: some View {
    if store.page(id: dailyPageID) != nil {
      PageEditorView(
        store: store, pageID: dailyPageID,
        presentation: .dailyWorkspace(canvas: RosePinePalette.calendarBackground) { EmptyView() },
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
  private var timeZoneIdentifier: String { calendar.timeZone.identifier }

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
    if panel == .plan {
      datePicker = TodayDatePickerSelection(date: day)
      return
    }
    requestTransition(.init(day: day, panel: transitionPanel(panel)), presentPicker: true)
  }
  private func requestDay(_ date: Date) {
    let targetDay = calendar.startOfDay(for: date)
    guard !calendar.isDate(targetDay, inSameDayAs: day) else {
      datePicker = nil
      return
    }

    if panel == .plan {
      let target = TodayWorkspaceTransitionCoordinator.Target(day: targetDay, panel: .plan)
      transition.showImmediately(target)
      transitionError = nil
      datePicker = nil
      path.removeAll()
      isOpeningNote = false
      day = targetDay
      return
    }

    requestTransition(.init(day: targetDay, panel: .note))
  }
  private func requestPanel(_ panel: TodayPanel) {
    requestTransition(.init(day: day, panel: transitionPanel(panel)))
  }

  private func requestReturnToToday() {
    let today = calendar.startOfDay(for: Date())
    let target = TodayWorkspaceTransitionCoordinator.Target(
      day: today, panel: transitionPanel(panel))

    transition.request(target, force: true) { generation, target in
      guard await flushController.flush(), transition.isCurrent(generation, target: target) else {
        if transition.isCurrent(generation, target: target) {
          transitionAlertMessage = "Couldn’t save the daily note. Please try again."
        }
        return
      }

      guard transition.isCurrent(generation, target: target) else { return }
      transitionError = nil
      if target.panel == .note {
        isOpeningNote = true
        let pageID = await store.openDailyPage(for: target.day)
        guard transition.isCurrent(generation, target: target) else { return }
        guard pageID != nil else {
          isOpeningNote = false
          transitionAlertMessage = store.startupError ?? "Couldn’t open this daily note. Please try again."
          return
        }
      }

      transition.commitIfCurrent(generation, target: target) {
        datePicker = nil
        presentedSheet = nil
        path.removeAll()
        day = target.day
        panel = target.panel == .plan ? .plan : .note
        isOpeningNote = false
      }
    }
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
          datePicker = nil
          path.removeAll()
          day = target.day
          panel = .note
          isOpeningNote = false
        }
      } else {
        transition.commitIfCurrent(generation, target: target) {
          datePicker = nil
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
    guard store.canOpenPage(pageID) else { return }
    guard path.last != pageID else { return }
    path.append(pageID)
  }
}

private struct TodaySavedLinksSection: View {
  let links: [BookmarkSavedLink]
  let openPage: (PageID) -> Void

  var body: some View {
    if !links.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        Text("Saved Links")
          .font(.headline)
          .padding(.horizontal, 16)
          .padding(.top, 12)
        ForEach(links) { link in
          BookmarkPageRow(page: link.page, saveCount: link.saveCount) { openPage(link.page.id) }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Saved Links")
    }
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
  @Binding var searchText: String
  @Binding var isSearchPresented: Bool
  let calendarTitles: [String]
  @Binding var selectedCalendarTitles: Set<String>
  let showDatePicker: () -> Void
  let selectDay: (Date) -> Void
  let selectPanel: (TodayPanel) -> Void
  let showChangedPages: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Button {
          showDatePicker()
        } label: {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(day.formatted(.dateTime.month(.wide)))
              .font(.system(size: 38, weight: .bold, design: .rounded))
              .foregroundStyle(.primary)
            Text(day.formatted(.dateTime.year()))
              .font(.system(size: 38, weight: .regular, design: .rounded))
              .foregroundStyle(RosePinePalette.calendarAccent)
          }
          .minimumScaleFactor(0.75)
          .lineLimit(1)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
          "Choose date, currently \(day.formatted(date: .long, time: .omitted))")
        .accessibilityHint("Opens a calendar to choose another date")

        Spacer(minLength: 8)

        HStack(spacing: 4) {
          Button {
            if isSearchPresented {
              searchText = ""
              isSearchPresented = false
            } else {
              isSearchPresented = true
            }
          } label: {
            Image(systemName: isSearchPresented ? "xmark" : "magnifyingglass")
              .font(.body.weight(.semibold))
              .frame(width: 34, height: 34)
          }
          .buttonStyle(.plain)
          .foregroundStyle(.secondary)
          .accessibilityLabel(isSearchPresented ? "Close search" : "Search this day")

          Menu {
            Button {
              selectedCalendarTitles.removeAll()
            } label: {
              Label(
                "All calendars",
                systemImage: selectedCalendarTitles.isEmpty ? "checkmark" : "calendar")
            }
            if !calendarTitles.isEmpty {
              Divider()
              ForEach(calendarTitles, id: \.self) { title in
                Button {
                  if selectedCalendarTitles.contains(title) {
                    selectedCalendarTitles.remove(title)
                  } else {
                    selectedCalendarTitles.insert(title)
                  }
                } label: {
                  Label(
                    title,
                    systemImage: selectedCalendarTitles.contains(title) ? "checkmark" : "calendar")
                }
              }
            }
            Divider()
            Button("Choose Date…", systemImage: "calendar") {
              showDatePicker()
            }
            Button("Changed Pages", systemImage: "clock.arrow.circlepath", action: showChangedPages)
          } label: {
            Image(systemName: "ellipsis.circle")
              .font(.title3.weight(.semibold))
              .frame(width: 34, height: 34)
          }
          .foregroundStyle(.secondary)
          .accessibilityLabel("More Today actions")
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, isSearchPresented ? 8 : 12)

      if isSearchPresented {
        HStack(spacing: 8) {
          Image(systemName: "magnifyingglass")
            .foregroundStyle(.secondary)
          TextField("Search this day", text: $searchText)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          if !searchText.isEmpty {
            Button {
              searchText = ""
            } label: {
              Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Clear search")
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
          RosePinePalette.calendarControlSurface,
          in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
      }

      CalendarDayStrip(selectedDay: day, events: events, calendar: calendar, selectDay: selectDay)
      TodayPanelSwitcher(panel: panel, selectPanel: selectPanel)
    }
    .background(RosePinePalette.calendarBackground)
  }
}

private struct TodayPanelSwitcher: View {
  let panel: TodayPanel
  let selectPanel: (TodayPanel) -> Void

  var body: some View {
    HStack(spacing: 24) {
      ForEach(TodayPanel.allCases) { option in
        Button {
          selectPanel(option)
        } label: {
          VStack(spacing: 7) {
            Text(option.rawValue)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(panel == option ? .primary : .secondary)
            Rectangle()
              .fill(panel == option ? RosePinePalette.calendarAccent : .clear)
              .frame(height: 2)
          }
          .frame(maxWidth: .infinity)
          .padding(.top, 10)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(panel == option ? .isSelected : [])
      }
    }
    .padding(.horizontal, 20)
    .frame(height: 48)
    .overlay(alignment: .bottom) { Divider() }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Today workspace panel")
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
