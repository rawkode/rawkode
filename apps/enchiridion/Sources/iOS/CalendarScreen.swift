import EnchiridionCore
import SwiftUI

struct CalendarScreen: View {
  let store: LibraryStore
  @State private var path: [PageID] = []
  private let calendar = Calendar.current

  var body: some View {
    NavigationStack(path: $path) {
      ScrollViewReader { proxy in
        List {
          if daySections.isEmpty {
            ContentUnavailableView {
              Label("No Calendar Events", systemImage: "calendar.badge.exclamationmark")
            } description: {
              Text(store.calendarError ?? "Connect EventKit or Google Calendar from Settings.")
            }
          } else {
            ForEach(daySections) { section in
              Section {
                ForEach(section.events) { event in
                  eventRow(event)
                }
              } header: {
                Text(sectionTitle(section.day))
                  .id(section.id)
              }
            }
          }
        }
        .onAppear { scrollToInitialDay(using: proxy) }
        .onChange(of: initialDayID) { _, _ in scrollToInitialDay(using: proxy) }
        .refreshable { try? await store.refreshCalendar() }
      }
      .navigationTitle("Calendar")
      .navigationDestination(for: PageID.self) { pageID in
        PageEditorView(store: store, pageID: pageID)
      }
    }
  }

  private var daySections: [CalendarDaySection] {
    let events = store.calendarEvents.sorted {
      if $0.startDate != $1.startDate { return $0.startDate < $1.startDate }
      return $0.title.localizedStandardCompare($1.title) == .orderedAscending
    }
    return Dictionary(grouping: events) { calendar.startOfDay(for: $0.startDate) }
      .map { CalendarDaySection(day: $0.key, events: $0.value) }
      .sorted { $0.day < $1.day }
  }

  private var initialDayID: Date? {
    let today = calendar.startOfDay(for: Date())
    return daySections.first(where: { $0.day >= today })?.id ?? daySections.last?.id
  }

  private func scrollToInitialDay(using proxy: ScrollViewProxy) {
    guard let initialDayID else { return }
    Task { @MainActor in
      await Task.yield()
      proxy.scrollTo(initialDayID, anchor: .top)
    }
  }

  private func sectionTitle(_ day: Date) -> String {
    if calendar.isDateInToday(day) { return "Today" }
    return day.formatted(.dateTime.weekday(.wide).month(.wide).day())
  }

  private func eventRow(_ event: CalendarEventSnapshot) -> some View {
    HStack(spacing: 12) {
      Button {
        Task {
          if let id = await store.openCalendarEventPage(event) { path.append(id) }
        }
      } label: {
        CalendarEventRow(event: event)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)

      Spacer(minLength: 0)

      if event.identity.series != nil {
        Button {
          Task {
            if let id = await store.openCalendarSeriesPage(event) { path.append(id) }
          }
        } label: {
          Image(systemName: "rectangle.stack")
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Open series notes")
      }
    }
  }
}

private struct CalendarDaySection: Identifiable {
  let day: Date
  let events: [CalendarEventSnapshot]

  var id: Date { day }
}
