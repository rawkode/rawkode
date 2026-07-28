import EnchiridionCore
import SwiftUI

struct TodayWorkspaceView: View {
  let store: LibraryStore

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var drawer: TodayDrawer?
  @State private var path: [PageID] = []
  @State private var day = Calendar.current.startOfDay(for: Date())
  @State private var datePicker: TodayDatePickerSelection?
  @State private var isOpeningDay = false
  @State private var openDayTask: Task<Void, Never>?

  private let calendar = Calendar.current

  var body: some View {
    NavigationStack(path: $path) {
      Group {
        if store.page(id: dailyPageID) != nil {
          PageEditorView(store: store, pageID: dailyPageID, onOpenPage: navigate)
            .navigationBarTitleDisplayMode(.large)
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
            show(.events)
          } label: {
            Label("Show events for this day", systemImage: "calendar")
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            show(.pages)
          } label: {
            Label("Show changed pages for this day", systemImage: "clock.arrow.circlepath")
          }
        }
        ToolbarItemGroup(placement: .bottomBar) {
          Button {
            moveDay(by: -1)
          } label: {
            Label("Previous day", systemImage: "chevron.left")
          }

          Spacer()

          Button {
            datePicker = TodayDatePickerSelection(date: day)
          } label: {
            Label("Choose date", systemImage: "calendar.badge.clock")
          }
          .accessibilityLabel("Choose date, currently \(day.formatted(date: .long, time: .omitted))")

          if !calendar.isDateInToday(day) {
            Button("Today") {
              selectDay(Date())
            }
            .accessibilityHint("Open today’s daily note")
          }

          Spacer()

          Button {
            moveDay(by: 1)
          } label: {
            Label("Next day", systemImage: "chevron.right")
          }
        }
      }
      .navigationDestination(for: PageID.self) { pageID in
        PageEditorView(store: store, pageID: pageID, onOpenPage: navigate)
      }
    }
    .overlay {
      GeometryReader { geometry in
        ZStack {
          if let drawer {
            Color.black.opacity(0.22)
              .ignoresSafeArea()
              .onTapGesture { dismissDrawer() }
              .accessibilityHidden(true)

            drawerPanel(drawer)
              .frame(width: min(geometry.size.width * 0.86, 380))
              .frame(
                maxWidth: .infinity,
                maxHeight: .infinity,
                alignment: drawer == .events ? .leading : .trailing
              )
              .transition(.move(edge: drawer.edge))
          } else {
            HStack(spacing: 0) {
              edgeTarget(for: .events)
              Spacer(minLength: 0)
              edgeTarget(for: .pages)
            }
          }
        }
      }
    }
    .sheet(item: $datePicker) { selection in
      TodayDatePicker(initialDate: selection.date, selectDate: selectDay)
    }
    .onDisappear { openDayTask?.cancel() }
  }

  private var dailyPageID: PageID {
    .daily(DayKey(date: day))
  }

  @ViewBuilder
  private func drawerPanel(_ drawer: TodayDrawer) -> some View {
    VStack(spacing: 0) {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(drawer.title)
            .font(.headline)
          Text(day.formatted(.dateTime.weekday(.wide).month(.wide).day()))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        Button("Close", systemImage: "xmark") { dismissDrawer() }
          .labelStyle(.iconOnly)
          .buttonStyle(.borderless)
      }
      .padding()

      Divider()

      switch drawer {
      case .events:
        TodayEventsList(store: store, day: day, openPage: openPage)
      case .pages:
        TodayChangedPagesList(
          store: store,
          day: day,
          excluding: dailyPageID,
          openPage: openPage
        )
      }
    }
    .background(.regularMaterial)
    .contentShape(.rect)
    .gesture(closeGesture(for: drawer))
    .accessibilityAddTraits(.isModal)
  }

  private func edgeTarget(for drawer: TodayDrawer) -> some View {
    Color.clear
      .frame(width: 24)
      .contentShape(.rect)
      .gesture(openGesture(for: drawer))
      .accessibilityHidden(true)
  }

  private func openGesture(for drawer: TodayDrawer) -> some Gesture {
    DragGesture(minimumDistance: 18)
      .onEnded { value in
        let crossedThreshold =
          drawer == .events
          ? value.translation.width > 48
          : value.translation.width < -48
        if crossedThreshold { show(drawer) }
      }
  }

  private func closeGesture(for drawer: TodayDrawer) -> some Gesture {
    DragGesture(minimumDistance: 18)
      .onEnded { value in
        let crossedThreshold =
          drawer == .events
          ? value.translation.width < -48
          : value.translation.width > 48
        if crossedThreshold { dismissDrawer() }
      }
  }

  private func show(_ drawer: TodayDrawer) {
    withAnimation(reduceMotion ? nil : .smooth(duration: 0.2)) {
      self.drawer = drawer
    }
  }

  private func dismissDrawer() {
    withAnimation(reduceMotion ? nil : .smooth(duration: 0.2)) {
      drawer = nil
    }
  }

  private func openPage(_ pageID: PageID) {
    dismissDrawer()
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
    datePicker = nil
    guard !calendar.isDate(destination, inSameDayAs: day) else { return }
    openDayTask?.cancel()
    path.removeAll()
    day = destination
    isOpeningDay = true
    openDayTask = Task { @MainActor in
      _ = await store.openDailyPage(for: destination)
      guard !Task.isCancelled else { return }
      isOpeningDay = false
    }
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

private enum TodayDrawer: Equatable {
  case events
  case pages

  var title: String {
    switch self {
    case .events: "Events"
    case .pages: "Changed Pages"
    }
  }

  var edge: Edge {
    switch self {
    case .events: .leading
    case .pages: .trailing
    }
  }
}

private struct TodayEventsList: View {
  let store: LibraryStore
  let day: Date
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
