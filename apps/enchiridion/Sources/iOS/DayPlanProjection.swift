import EnchiridionCore
import Foundation

/// The read-only projection shared by the Today plan and its tests.
struct DayPlanProjection {
  let agendaItems: [CalendarAgendaItem]
  let capacityTasks: [(task: TaskItem, placement: CalendarTaskPlacement)]
  let anytimeTasks: [TaskItem]
  let hasMoreAnytime: Bool

  init(
    day: Date,
    now: Date = Date(),
    pages: [PageSnapshot],
    events: [CalendarEventSnapshot],
    calendar: Calendar = .current,
    includeOverdue: Bool,
    anytimeLimit: Int = 6
  ) {
    let exactTasks = CalendarAgendaDate.tasks(on: day, from: pages, calendar: calendar)
    let dateTasks = TaskQuery.items(
      from: pages, on: day, includingOverdue: includeOverdue, calendar: calendar
    )
    let placements = Dictionary(uniqueKeysWithValues: exactTasks.map { ($0.task.id, $0.placement) })
    let projectedTasks = dateTasks.map { task in
      (
        task,
        placements[task.id]
          ?? CalendarTaskPlacement(
            scheduledAt: task.data.scheduledAt,
            scheduleGranularity: task.data.scheduleGranularity,
            isScheduledOnDisplayedDay: false,
            deadline: task.data.deadline,
            estimatedMinutes: task.data.estimatedMinutes
          )
      )
    }
    capacityTasks = exactTasks
    agendaItems = CalendarAgendaDate.items(
      events: CalendarAgendaDate.events(on: day, in: events, calendar: calendar),
      tasks: projectedTasks
    )

    guard includeOverdue else {
      anytimeTasks = []
      hasMoreAnytime = false
      return
    }
    let datedIDs = Set(dateTasks.map(\.id))
    let allAnytime = TaskQuery.items(
      from: pages, selection: .smart(.anytime), now: now, calendar: calendar
    ).filter { !datedIDs.contains($0.id) }
    anytimeTasks = Array(allAnytime.prefix(anytimeLimit))
    hasMoreAnytime = allAnytime.count > anytimeTasks.count
  }
}
