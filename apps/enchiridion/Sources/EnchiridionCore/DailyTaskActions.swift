import Foundation

/// Pure transformations used by the daily-note task context.
public enum DailyTaskActions {
  /// Creates a task deliberately attached to a calendar day, without inventing
  /// a time of day.
  public static func draft(
    title: String,
    on day: Date,
    calendar: Calendar = .current
  ) -> TaskDraft {
    TaskDraft(
      title: title.trimmingCharacters(in: .whitespacesAndNewlines),
      data: TaskData(
        placement: .anytime,
        scheduledAt: calendar.startOfDay(for: day),
        scheduleGranularity: .dateOnly
      )
    )
  }

  /// Moves a task to another day. Existing timed tasks retain their local
  /// clock time; date-only tasks remain date-only. An unscheduled task becomes
  /// date-only because the action selected a day rather than a time.
  public static func deferred(
    _ data: TaskData,
    to day: Date,
    calendar: Calendar = .current
  ) -> TaskData {
    var result = data
    let targetDay = calendar.startOfDay(for: day)

    guard let scheduledAt = data.scheduledAt else {
      result.scheduledAt = targetDay
      result.scheduleGranularity = .dateOnly
      return result
    }

    switch data.scheduleGranularity {
    case .dateOnly:
      result.scheduledAt = targetDay
    case .dateTime:
      let time = calendar.dateComponents([.hour, .minute, .second], from: scheduledAt)
      result.scheduledAt =
        calendar.date(
          bySettingHour: time.hour ?? 0,
          minute: time.minute ?? 0,
          second: time.second ?? 0,
          of: targetDay
        ) ?? targetDay
    }
    return result
  }

  public static func deferredToTomorrow(
    _ data: TaskData,
    now: Date = Date(),
    calendar: Calendar = .current
  ) -> TaskData {
    let tomorrow =
      calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))
      ?? now.addingTimeInterval(86_400)
    return deferred(data, to: tomorrow, calendar: calendar)
  }
}
