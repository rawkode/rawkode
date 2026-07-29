import Foundation

public struct DayCapacityInterval: Hashable, Sendable {
  public fileprivate(set) var start: Date
  public fileprivate(set) var end: Date

  public init?(start: Date, end: Date) {
    guard end > start else { return nil }
    self.start = start
    self.end = end
  }

  public var minutes: Int {
    max(0, Int(end.timeIntervalSince(start) / 60))
  }
}

public struct DayCapacityEvent: Hashable, Sendable {
  public var start: Date
  public var end: Date
  public var isAllDay: Bool

  public init(start: Date, end: Date, isAllDay: Bool) {
    self.start = start
    self.end = end
    self.isAllDay = isAllDay
  }
}

public struct DayCapacityTask: Hashable, Sendable {
  public var id: PageID
  public var scheduledAt: Date?
  public var scheduleGranularity: TaskScheduleGranularity
  public var estimatedMinutes: Int?

  public init(
    id: PageID,
    scheduledAt: Date?,
    scheduleGranularity: TaskScheduleGranularity,
    estimatedMinutes: Int?
  ) {
    self.id = id
    self.scheduledAt = scheduledAt
    self.scheduleGranularity = scheduleGranularity
    self.estimatedMinutes = estimatedMinutes
  }
}

public struct DayCapacitySuggestion: Hashable, Sendable {
  public var taskID: PageID
  public var interval: DayCapacityInterval

  public init(taskID: PageID, interval: DayCapacityInterval) {
    self.taskID = taskID
    self.interval = interval
  }
}

public struct DayCapacityPlan: Hashable, Sendable {
  public var planningInterval: DayCapacityInterval
  public var busyIntervals: [DayCapacityInterval]
  public var freeIntervals: [DayCapacityInterval]
  public var plannedMinutes: Int
  public var unscheduledMinutes: Int
  public var availableMinutes: Int
  public var overCapacityMinutes: Int
  public var tasksWithoutEstimates: Int
  public var suggestions: [DayCapacitySuggestion]

  public init(
    planningInterval: DayCapacityInterval,
    busyIntervals: [DayCapacityInterval],
    freeIntervals: [DayCapacityInterval],
    plannedMinutes: Int,
    unscheduledMinutes: Int,
    availableMinutes: Int,
    overCapacityMinutes: Int,
    tasksWithoutEstimates: Int,
    suggestions: [DayCapacitySuggestion]
  ) {
    self.planningInterval = planningInterval
    self.busyIntervals = busyIntervals
    self.freeIntervals = freeIntervals
    self.plannedMinutes = plannedMinutes
    self.unscheduledMinutes = unscheduledMinutes
    self.availableMinutes = availableMinutes
    self.overCapacityMinutes = overCapacityMinutes
    self.tasksWithoutEstimates = tasksWithoutEstimates
    self.suggestions = suggestions
  }

  public func suggestion(for taskID: PageID) -> DayCapacitySuggestion? {
    suggestions.first { $0.taskID == taskID }
  }
}

public enum DayCapacityPlanner {
  public static func plan(
    day: Date,
    events: [DayCapacityEvent],
    tasks: [DayCapacityTask],
    calendar: Calendar,
    now: Date = Date(),
    startHour: Int = 8,
    endHour: Int = 18
  ) -> DayCapacityPlan {
    let dayStart = calendar.startOfDay(for: day)
    let start =
      calendar.date(bySettingHour: startHour, minute: 0, second: 0, of: dayStart) ?? dayStart
    let end =
      calendar.date(bySettingHour: endHour, minute: 0, second: 0, of: dayStart)
      ?? calendar.date(byAdding: .hour, value: max(1, endHour - startHour), to: start)!
    let planningInterval = DayCapacityInterval(
      start: start, end: max(end, start.addingTimeInterval(60)))!

    let eventIntervals = events.compactMap { event -> DayCapacityInterval? in
      guard !event.isAllDay else { return nil }
      return clippedInterval(start: event.start, end: event.end, to: planningInterval)
    }
    let busyIntervals = merged(eventIntervals)

    let estimatedTasks = tasks.compactMap { task -> (task: DayCapacityTask, minutes: Int)? in
      guard let minutes = task.estimatedMinutes, minutes > 0 else { return nil }
      return (task, minutes)
    }
    let scheduledTasks = estimatedTasks.filter {
      guard let scheduledAt = $0.task.scheduledAt else { return false }
      return $0.task.scheduleGranularity == .dateTime
        && calendar.isDate(scheduledAt, inSameDayAs: day)
    }
    let unscheduledTasks = estimatedTasks.filter {
      guard let scheduledAt = $0.task.scheduledAt else { return true }
      return $0.task.scheduleGranularity == .dateOnly
        && calendar.isDate(scheduledAt, inSameDayAs: day)
    }

    let scheduledIntervals = scheduledTasks.compactMap { value -> DayCapacityInterval? in
      guard let scheduledAt = value.task.scheduledAt else { return nil }
      return clippedInterval(
        start: scheduledAt,
        end: scheduledAt.addingTimeInterval(TimeInterval(value.minutes * 60)),
        to: planningInterval
      )
    }
    let elapsedIntervals =
      elapsedInterval(on: day, now: now, calendar: calendar, within: planningInterval)
      .map { [$0] } ?? []
    let occupiedIntervals = merged(busyIntervals + scheduledIntervals + elapsedIntervals)
    let freeIntervals = complement(of: occupiedIntervals, within: planningInterval)
    let availableMinutes = freeIntervals.reduce(0) { $0 + $1.minutes }
    let unscheduledMinutes = unscheduledTasks.reduce(0) { $0 + $1.minutes }

    return DayCapacityPlan(
      planningInterval: planningInterval,
      busyIntervals: busyIntervals,
      freeIntervals: freeIntervals,
      plannedMinutes: scheduledTasks.reduce(0) { $0 + $1.minutes },
      unscheduledMinutes: unscheduledMinutes,
      availableMinutes: availableMinutes,
      overCapacityMinutes: max(0, unscheduledMinutes - availableMinutes),
      tasksWithoutEstimates: tasks.count - estimatedTasks.count,
      suggestions: suggestions(for: unscheduledTasks, in: freeIntervals)
    )
  }

  private static func clippedInterval(
    start: Date,
    end: Date,
    to bounds: DayCapacityInterval
  ) -> DayCapacityInterval? {
    DayCapacityInterval(start: max(start, bounds.start), end: min(end, bounds.end))
  }

  private static func elapsedInterval(
    on day: Date,
    now: Date,
    calendar: Calendar,
    within bounds: DayCapacityInterval
  ) -> DayCapacityInterval? {
    let selectedDay = calendar.startOfDay(for: day)
    let currentDay = calendar.startOfDay(for: now)
    if selectedDay < currentDay { return bounds }
    guard selectedDay == currentDay else { return nil }

    let fiveMinutes: TimeInterval = 5 * 60
    let roundedNow = Date(
      timeIntervalSinceReferenceDate:
        ceil(now.timeIntervalSinceReferenceDate / fiveMinutes) * fiveMinutes
    )
    return DayCapacityInterval(
      start: bounds.start,
      end: min(max(roundedNow, bounds.start), bounds.end)
    )
  }

  private static func merged(_ intervals: [DayCapacityInterval]) -> [DayCapacityInterval] {
    let sorted = intervals.sorted {
      $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start
    }
    return sorted.reduce(into: []) { result, interval in
      guard let previous = result.last else {
        result.append(interval)
        return
      }
      if interval.start <= previous.end {
        result[result.count - 1].end = max(previous.end, interval.end)
      } else {
        result.append(interval)
      }
    }
  }

  private static func complement(
    of intervals: [DayCapacityInterval],
    within bounds: DayCapacityInterval
  ) -> [DayCapacityInterval] {
    var cursor = bounds.start
    var result: [DayCapacityInterval] = []
    for interval in intervals {
      if let gap = DayCapacityInterval(start: cursor, end: interval.start) {
        result.append(gap)
      }
      cursor = max(cursor, interval.end)
    }
    if let gap = DayCapacityInterval(start: cursor, end: bounds.end) {
      result.append(gap)
    }
    return result
  }

  private static func suggestions(
    for tasks: [(task: DayCapacityTask, minutes: Int)],
    in freeIntervals: [DayCapacityInterval]
  ) -> [DayCapacitySuggestion] {
    var remaining = freeIntervals
    var result: [DayCapacitySuggestion] = []

    for value in tasks {
      guard let index = remaining.firstIndex(where: { $0.minutes >= value.minutes }) else {
        continue
      }
      let slotStart = remaining[index].start
      let slotEnd = slotStart.addingTimeInterval(TimeInterval(value.minutes * 60))
      guard let slot = DayCapacityInterval(start: slotStart, end: slotEnd) else { continue }
      result.append(DayCapacitySuggestion(taskID: value.task.id, interval: slot))

      if slotEnd < remaining[index].end {
        remaining[index].start = slotEnd
      } else {
        remaining.remove(at: index)
      }
    }
    return result
  }
}
