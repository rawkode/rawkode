import EnchiridionCore
import SwiftUI

struct CalendarScreen: View {
  let store: LibraryStore

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var path: [PageID] = []
  @State private var selectedDay = Calendar.current.startOfDay(for: Date())
  @State private var searchText = ""
  @State private var selectedCalendarTitles: Set<String> = []
  @State private var isDatePickerPresented = false

  private let calendar = Calendar.current

  private var filteredCalendarEvents: [CalendarEventSnapshot] {
    store.calendarEvents.filter { event in
      (selectedCalendarTitles.isEmpty || selectedCalendarTitles.contains(event.calendarTitle))
        && eventMatchesSearch(event)
    }
  }

  private var selectedDayEvents: [CalendarEventSnapshot] {
    CalendarAgendaDate.events(on: selectedDay, in: filteredCalendarEvents, calendar: calendar)
  }

  private var selectedDayTasks: [(task: TaskItem, placement: CalendarTaskPlacement)] {
    CalendarAgendaDate.tasks(on: selectedDay, from: store.pages, calendar: calendar)
      .filter { taskMatchesSearch($0.task) }
  }

  private var agendaItems: [CalendarAgendaItem] {
    CalendarAgendaDate.items(events: selectedDayEvents, tasks: selectedDayTasks)
  }

  private var calendarTitles: [String] {
    Array(Set(store.calendarEvents.map(\.calendarTitle))).sorted()
  }

  var body: some View {
    NavigationStack(path: $path) {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 20) {
          CalendarHeader(selectedDay: selectedDay, showDatePicker: showDatePicker)
          CalendarDayStrip(
            selectedDay: selectedDay,
            events: filteredCalendarEvents,
            calendar: calendar,
            selectDay: select
          )
          CalendarAgendaView(
            selectedDay: selectedDay,
            items: agendaItems,
            isLoading: store.isLoading,
            error: store.calendarError,
            isSearching: !searchText.isEmpty,
            calendar: calendar,
            openOccurrenceNote: openOccurrenceNote,
            openSeriesNote: openSeriesNote
          )
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
        .frame(maxWidth: 760, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .center)
      }
      .background(Color(uiColor: .systemGroupedBackground))
      .navigationTitle("Calendar")
      .navigationBarTitleDisplayMode(.inline)
      .navigationDestination(for: PageID.self) { pageID in
        PageEditorView(store: store, pageID: pageID)
      }
      .searchable(text: $searchText, prompt: "Search selected day")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Today", action: selectToday)
            .disabled(calendar.isDateInToday(selectedDay))
            .accessibilityHint("Show today’s agenda")
        }
        ToolbarItem(placement: .topBarTrailing) {
          CalendarFilterMenu(
            calendarTitles: calendarTitles,
            selectedCalendarTitles: $selectedCalendarTitles
          )
        }
      }
      .sheet(isPresented: $isDatePickerPresented) {
        CalendarDatePicker(selectedDay: Binding(get: { selectedDay }, set: select)) {
          isDatePickerPresented = false
        }
      }
      .refreshable { try? await store.refreshCalendar() }
    }
  }

  private func eventMatchesSearch(_ event: CalendarEventSnapshot) -> Bool {
    guard !searchText.isEmpty else { return true }
    return [event.title, event.location, event.calendarTitle]
      .compactMap { $0 }
      .contains { $0.localizedCaseInsensitiveContains(searchText) }
  }

  private func taskMatchesSearch(_ task: TaskItem) -> Bool {
    guard !searchText.isEmpty else { return true }
    return [task.page.displayTitle, task.page.plainText]
      .contains { $0.localizedCaseInsensitiveContains(searchText) }
  }

  private func showDatePicker() { isDatePickerPresented = true }

  private func selectToday() { select(Date()) }

  private func select(_ day: Date) {
    let nextDay = calendar.startOfDay(for: day)
    guard !calendar.isDate(nextDay, inSameDayAs: selectedDay) else { return }
    if reduceMotion {
      selectedDay = nextDay
    } else {
      withAnimation(.easeInOut(duration: 0.2)) { selectedDay = nextDay }
    }
  }

  private func openOccurrenceNote(for event: CalendarEventSnapshot) {
    Task {
      if let id = await store.openCalendarEventPage(event) { path.append(id) }
    }
  }

  private func openSeriesNote(for event: CalendarEventSnapshot) {
    Task {
      if let id = await store.openCalendarSeriesPage(event) { path.append(id) }
    }
  }
}
