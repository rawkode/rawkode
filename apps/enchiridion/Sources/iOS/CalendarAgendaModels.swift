import EnchiridionCore
import Foundation

struct CalendarTaskPlacement: Hashable {
  let scheduledAt: Date?
  let scheduleGranularity: TaskScheduleGranularity?
  let isScheduledOnDisplayedDay: Bool
  let deadline: Date?
  let estimatedMinutes: Int?

  var isAllDay: Bool {
    !isScheduledOnDisplayedDay || scheduleGranularity == .dateOnly
  }

  var sortDate: Date {
    isScheduledOnDisplayedDay
      ? scheduledAt ?? deadline ?? .distantFuture : deadline ?? .distantFuture
  }

  var accessibilitySummary: String {
    var values: [String] = []
    if let scheduledAt {
      if isScheduledOnDisplayedDay {
        values.append(
          scheduleGranularity == .dateOnly
            ? "Scheduled, date only"
            : "Scheduled, \(scheduledAt.formatted(date: .omitted, time: .shortened))")
      } else {
        values.append("Scheduled, \(scheduledAt.formatted(date: .abbreviated, time: .shortened))")
      }
    }
    if deadline != nil { values.append("Deadline") }
    if let estimatedMinutes, estimatedMinutes > 0 {
      values.append("Estimated, \(estimatedMinutes) minutes")
    }
    return values.joined(separator: ", ")
  }
}

enum CalendarAgendaItem: Identifiable {
  case event(CalendarEventSnapshot)
  case task(TaskItem, CalendarTaskPlacement)

  var id: String {
    switch self {
    case .event(let event): "event:\(event.id)"
    case .task(let task, _): "task:\(task.id.rawValue)"
    }
  }

  var isAllDay: Bool {
    switch self {
    case .event(let event): event.isAllDay
    case .task(_, let placement): placement.isAllDay
    }
  }

  var sortDate: Date {
    switch self {
    case .event(let event): event.startDate
    case .task(_, let placement): placement.sortDate
    }
  }
}

enum CalendarAgendaDate {
  static func events(
    on day: Date,
    in events: [CalendarEventSnapshot],
    calendar: Calendar
  ) -> [CalendarEventSnapshot] {
    let start = calendar.startOfDay(for: day)
    return events.filter { event in
      calendar.isDate(event.startDate, inSameDayAs: start)
        || (event.startDate < start && event.endDate > start)
    }
    .sorted {
      if $0.isAllDay != $1.isAllDay { return $0.isAllDay }
      if $0.startDate != $1.startDate { return $0.startDate < $1.startDate }
      return $0.title.localizedStandardCompare($1.title) == .orderedAscending
    }
  }

  static func eventDensity(
    on day: Date,
    in events: [CalendarEventSnapshot],
    calendar: Calendar
  ) -> Int {
    CalendarAgendaDate.events(on: day, in: events, calendar: calendar).count
  }

  static func tasks(
    on day: Date,
    from pages: [PageSnapshot],
    calendar: Calendar
  ) -> [(task: TaskItem, placement: CalendarTaskPlacement)] {
    pages.compactMap(TaskItem.init)
      .filter { $0.data.isActive }
      .compactMap { task in
        let scheduledAt = task.data.scheduledAt
        let isScheduledOnDisplayedDay =
          scheduledAt.map {
            calendar.isDate($0, inSameDayAs: day)
          } ?? false
        let deadline = task.data.deadline.flatMap {
          calendar.isDate($0, inSameDayAs: day) ? $0 : nil
        }
        guard isScheduledOnDisplayedDay || deadline != nil else { return nil }
        return (
          task,
          CalendarTaskPlacement(
            scheduledAt: scheduledAt,
            scheduleGranularity: scheduledAt == nil ? nil : task.data.scheduleGranularity,
            isScheduledOnDisplayedDay: isScheduledOnDisplayedDay,
            deadline: deadline,
            estimatedMinutes: task.data.estimatedMinutes
          )
        )
      }
      .sorted { lhs, rhs in
        if lhs.placement.isAllDay != rhs.placement.isAllDay { return lhs.placement.isAllDay }
        if lhs.placement.sortDate != rhs.placement.sortDate {
          return lhs.placement.sortDate < rhs.placement.sortDate
        }
        return lhs.task.page.displayTitle.localizedStandardCompare(rhs.task.page.displayTitle)
          == .orderedAscending
      }
  }

  static func items(
    events: [CalendarEventSnapshot],
    tasks: [(task: TaskItem, placement: CalendarTaskPlacement)]
  ) -> [CalendarAgendaItem] {
    (events.map(CalendarAgendaItem.event) + tasks.map { .task($0.task, $0.placement) })
      .sorted { lhs, rhs in
        if lhs.isAllDay != rhs.isAllDay { return lhs.isAllDay }
        return lhs.sortDate < rhs.sortDate
      }
  }
}
