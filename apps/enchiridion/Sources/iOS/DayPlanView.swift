import EnchiridionCore
import SwiftUI

/// The agenda half of Today. It deliberately has no selected-date state.
struct DayPlanView: View {
  let store: LibraryStore
  let day: Date
  let events: [CalendarEventSnapshot]
  let selectedCalendarEvents: [CalendarEventSnapshot]
  let searchText: String
  let calendar: Calendar
  let scheduleTask: (TaskItem, Date) -> Void
  let openOccurrenceNote: (CalendarEventSnapshot) -> Void
  let openSeriesNote: (CalendarEventSnapshot) -> Void
  let viewAllAnytime: () -> Void
  let refresh: () async -> Void

  private var projection: DayPlanProjection {
    DayPlanProjection(
      day: day, pages: store.pages, events: events, calendar: calendar,
      includeOverdue: calendar.isDateInToday(day),
      anytimeLimit: searchText.isEmpty ? 6 : .max
    )
  }
  private var visibleItems: [CalendarAgendaItem] {
    guard !searchText.isEmpty else { return projection.agendaItems }
    return projection.agendaItems.filter { item in
      switch item {
      case .event(let event):
        [event.title, event.location, event.calendarTitle].compactMap { $0 }.contains {
          $0.localizedCaseInsensitiveContains(searchText)
        }
      case .task(let task, _):
        [task.page.displayTitle, task.page.plainText].contains {
          $0.localizedCaseInsensitiveContains(searchText)
        }
      }
    }
  }
  private var visibleAnytime: [TaskItem] {
    guard !searchText.isEmpty else { return projection.anytimeTasks }
    return projection.anytimeTasks.filter {
      $0.page.displayTitle.localizedCaseInsensitiveContains(searchText)
        || $0.page.plainText.localizedCaseInsensitiveContains(searchText)
    }
  }
  private var capacityPlan: DayCapacityPlan {
    DayCapacityPlanner.plan(
      day: day,
      events: CalendarAgendaDate.events(on: day, in: selectedCalendarEvents, calendar: calendar).map
      { .init(start: $0.startDate, end: $0.endDate, isAllDay: $0.isAllDay) },
      tasks: projection.capacityTasks.map {
        .init(
          id: $0.task.id, scheduledAt: $0.placement.scheduledAt,
          scheduleGranularity: $0.placement.scheduleGranularity ?? .dateOnly,
          estimatedMinutes: $0.placement.estimatedMinutes)
      },
      calendar: calendar, now: Date()
    )
  }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 16) {
        CalendarAgendaView(
          selectedDay: day, items: visibleItems, isLoading: store.isLoading,
          error: store.calendarError, isSearching: !searchText.isEmpty, calendar: calendar,
          showsTitle: false,
          capacityPlan: capacityPlan, scheduleTask: scheduleTask,
          openOccurrenceNote: openOccurrenceNote, openSeriesNote: openSeriesNote
        )
        if !visibleAnytime.isEmpty {
          CalendarAgendaSection(title: "Anytime") {
            ForEach(visibleAnytime, id: \.id) { task in
              NavigationLink(value: task.id) {
                HStack(spacing: 12) {
                  Image(systemName: "checklist")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                  Text(task.page.displayTitle).foregroundStyle(.primary).lineLimit(2)
                  Spacer(minLength: 0)
                  Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary).accessibilityHidden(true)
                }.padding(12).contentShape(Rectangle())
              }
              .accessibilityLabel("Anytime task, \(task.page.displayTitle)")
            }
            if projection.hasMoreAnytime && searchText.isEmpty {
              Button("View All Anytime Tasks", action: viewAllAnytime)
                .frame(maxWidth: .infinity, minHeight: 44)
            }
          }
        }
      }
      .padding(.horizontal)
      .padding(.vertical, 12)
      .frame(maxWidth: 760, alignment: .leading)
      .frame(maxWidth: .infinity, alignment: .center)
    }
    .refreshable { await refresh() }
  }
}
