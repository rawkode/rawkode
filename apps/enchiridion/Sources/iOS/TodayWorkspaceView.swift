import EnchiridionCore
import SwiftUI

struct TodayWorkspaceView: View {
  let store: LibraryStore

  @State private var presentedPanel: TodayPanel?
  @State private var path: [PageID] = []
  @State private var flushController = EditorFlushController()
  @State private var day = Calendar.current.startOfDay(for: Date())
  @State private var datePicker: TodayDatePickerSelection?
  @State private var isOpeningDay = false
  @State private var openDayTask: Task<Void, Never>?

  private let calendar = Calendar.current

  init(store: LibraryStore) {
    self.store = store
  }

  var body: some View {
    NavigationStack(path: $path) {
      Group {
        if store.page(id: dailyPageID) != nil {
          PageEditorView(
            store: store,
            pageID: dailyPageID,
            presentation: .dailyWorkspace {
              TodayWorkspaceHeader(
                day: day,
                isToday: calendar.isDateInToday(day),
                previousDay: { moveDay(by: -1) },
                nextDay: { moveDay(by: 1) },
                taskContext: DailyTaskContext(
                  store: store,
                  day: day,
                  includingOverdue: calendar.isDateInToday(day),
                  openTask: openPage,
                  viewAll: showTodayTasks,
                  flushBeforeChange: flushController.flush
                )
                .id(dailyPageID)
              )
            },
            flushController: flushController,
            onOpenPage: navigate,
            showsPageActions: false
          )
        } else if store.isLoading || isOpeningDay {
          ProgressView("Opening daily note")
        } else {
          ContentUnavailableView(
            "Daily note unavailable",
            systemImage: "doc.badge.exclamationmark",
            description: Text(store.startupError ?? "Try reopening Enchiridion.")
          )
        }
      }
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button {
            presentedPanel = .events
          } label: {
            Label("Show events for this day", systemImage: "calendar")
          }
        }

        ToolbarItemGroup(placement: .topBarTrailing) {
          Menu {
            Section("Date") {
              Button("Choose Date", systemImage: "calendar.badge.clock") {
                showDatePicker()
              }
              if !calendar.isDateInToday(day) {
                Button("Return to Today", systemImage: "arrow.uturn.backward") {
                  selectDay(Date())
                }
              }
            }

            Button("Changed Pages", systemImage: "clock.arrow.circlepath") {
              presentedPanel = .pages
            }
          } label: {
            Label("More Today actions", systemImage: "ellipsis.circle")
          }
        }
      }
      .navigationDestination(for: PageID.self) { pageID in
        PageDestinationView(
          store: store,
          pageID: pageID,
          flushController: flushController,
          onOpenPage: navigate
        )
      }
    }
    .sheet(item: $datePicker) { selection in
      TodayDatePicker(initialDate: selection.date, selectDate: selectDay)
    }
    .sheet(item: $presentedPanel) { panel in
      NavigationStack {
        panelContent(panel)
          .navigationTitle(panel.navigationTitle(for: day, calendar: calendar))
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Done") { presentedPanel = nil }
            }
          }
      }
      .presentationDetents([.medium, .large])
    }
    .onDisappear { openDayTask?.cancel() }
  }

  private var dailyPageID: PageID {
    .daily(DayKey(date: day))
  }

  private func showTodayTasks() {
    Task { @MainActor in
      guard await flushController.flush() else { return }
      presentedPanel = .tasks
    }
  }

  @ViewBuilder
  private func panelContent(_ panel: TodayPanel) -> some View {
    switch panel {
    case .events:
      TodayEventsList(
        store: store,
        day: day,
        flushBeforeOpening: flushController.flush,
        openPage: openPageAfterFlush
      )
    case .tasks:
      DailyTaskListScreen(
        store: store,
        day: day,
        includingOverdue: calendar.isDateInToday(day)
      )
    case .pages:
      TodayChangedPagesList(
        store: store,
        day: day,
        excluding: dailyPageID,
        openPage: openPage
      )
    }
  }

  private func openPage(_ pageID: PageID) {
    Task { @MainActor in
      guard await flushController.flush() else { return }
      openPageAfterFlush(pageID)
    }
  }

  private func openPageAfterFlush(_ pageID: PageID) {
    presentedPanel = nil
    navigate(pageID)
  }

  private func navigate(_ pageID: PageID) {
    guard path.last != pageID else { return }
    path.append(pageID)
  }

  private func moveDay(by value: Int) {
    guard let destination = calendar.date(byAdding: .day, value: value, to: day) else { return }
    selectDay(destination)
  }

  private func selectDay(_ date: Date) {
    let destination = calendar.startOfDay(for: date)
    guard !calendar.isDate(destination, inSameDayAs: day) else { return }
    openDayTask?.cancel()
    openDayTask = Task { @MainActor in
      guard await flushController.flush(), !Task.isCancelled else { return }
      datePicker = nil
      path.removeAll()
      day = destination
      isOpeningDay = true
      _ = await store.openDailyPage(for: destination)
      guard !Task.isCancelled else { return }
      isOpeningDay = false
    }
  }

  private func showDatePicker() {
    Task { @MainActor in
      guard await flushController.flush() else { return }
      datePicker = TodayDatePickerSelection(date: day)
    }
  }
}

private struct TodayWorkspaceHeader<TaskContext: View>: View {
  let day: Date
  let isToday: Bool
  let previousDay: () -> Void
  let nextDay: () -> Void
  @ViewBuilder let taskContext: () -> TaskContext

  init(
    day: Date,
    isToday: Bool,
    previousDay: @escaping () -> Void,
    nextDay: @escaping () -> Void,
    taskContext: TaskContext
  ) {
    self.day = day
    self.isToday = isToday
    self.previousDay = previousDay
    self.nextDay = nextDay
    self.taskContext = { taskContext }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .center, spacing: 12) {
        VStack(alignment: .leading, spacing: 3) {
          Text(isToday ? "Today" : "Daily Note")
            .font(.title2.weight(.bold))
            .accessibilityIdentifier("today-workspace-title")
          Text(day.formatted(.dateTime.weekday(.wide).month(.wide).day().year()))
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(dailyIdentityAccessibilityLabel)
        .accessibilityIdentifier("today-workspace-heading")

        Spacer(minLength: 8)

        HStack(spacing: 4) {
          Button(action: previousDay) {
            Image(systemName: "chevron.left")
          }
          .frame(minWidth: 44, minHeight: 44)
          .accessibilityLabel("Previous day")
          .accessibilityHint("Open the previous daily note")
          .accessibilityIdentifier("today-previous-day")

          Button(action: nextDay) {
            Image(systemName: "chevron.right")
          }
          .frame(minWidth: 44, minHeight: 44)
          .accessibilityLabel("Next day")
          .accessibilityHint("Open the next daily note")
          .accessibilityIdentifier("today-next-day")
        }
        .font(.body.weight(.semibold))
      }

      taskContext()
    }
    .padding(.bottom, 10)
  }

  private var dailyIdentityAccessibilityLabel: String {
    let formattedDay = day.formatted(.dateTime.weekday(.wide).month(.wide).day().year())
    return isToday ? "Today, \(formattedDay)" : "Daily note for \(formattedDay)"
  }
}

private struct TodayDatePickerSelection: Identifiable {
  let id = UUID()
  let date: Date
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
      DatePicker("Daily note date", selection: $date, displayedComponents: .date)
        .datePickerStyle(.graphical)
        .labelsHidden()
        .padding()
        .navigationTitle("Choose Date")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { dismiss() }
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Open Date") {
              selectDate(date)
              dismiss()
            }
          }
        }
    }
    .presentationDetents([.medium])
  }
}

private enum TodayPanel: String, Hashable, Identifiable {
  case events
  case tasks
  case pages

  var id: Self { self }

  func navigationTitle(for day: Date, calendar: Calendar) -> String {
    let date = calendar.isDateInToday(day)
      ? "Today"
      : day.formatted(.dateTime.month(.abbreviated).day())
    return switch self {
    case .events: "\(date) Events"
    case .tasks: "\(date) Tasks"
    case .pages: "\(date) Changes"
    }
  }
}

private struct TodayEventsList: View {
  let store: LibraryStore
  let day: Date
  let flushBeforeOpening: @MainActor () async -> Bool
  let openPage: (PageID) -> Void

  var body: some View {
    let events = store.events(on: day)
    Group {
      if events.isEmpty {
        ContentUnavailableView(
          "No events",
          systemImage: "calendar",
          description: Text("Your calendar is clear for this day.")
        )
      } else {
        List(events) { event in
          Button {
            Task {
              guard await flushBeforeOpening() else { return }
              if let pageID = await store.openCalendarEventPage(event) { openPage(pageID) }
            }
          } label: {
            CalendarEventRow(event: event)
              .contentShape(.rect)
          }
          .buttonStyle(.plain)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
      }
    }
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
          "No changed pages",
          systemImage: "clock.arrow.circlepath",
          description: Text("Pages you create or edit today appear here, earliest first.")
        )
      } else {
        List(pages) { page in
          Button {
            openPage(page.id)
          } label: {
            VStack(alignment: .leading, spacing: 4) {
              Text(page.displayTitle)
                .font(.body.weight(.medium))
                .foregroundStyle(.primary)
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
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
      }
    }
  }

  private func activityLabel(for page: PageSnapshot) -> String {
    let action = abs(page.modifiedAt.timeIntervalSince(page.createdAt)) < 1 ? "Created" : "Edited"
    return "\(action) \(page.modifiedAt.formatted(date: .omitted, time: .shortened))"
  }
}
