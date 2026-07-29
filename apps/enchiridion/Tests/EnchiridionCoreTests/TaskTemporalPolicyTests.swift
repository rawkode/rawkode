import Foundation
import XCTest

@testable import EnchiridionCore

final class TaskTemporalPolicyTests: XCTestCase {
  func testSelectedWeekdayRecurrencePreservesLocalClockTime() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Europe/London")!
    let monday = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 8, day: 3, hour: 9, minute: 30))
    )
    let rule = TaskRecurrenceRule(
      mode: .fixedSchedule,
      unit: .week,
      weekdays: [.wednesday]
    )

    let next = try XCTUnwrap(rule.nextDate(after: monday, calendar: calendar))

    XCTAssertEqual(
      calendar.dateComponents([.year, .month, .day, .hour, .minute], from: next),
      DateComponents(year: 2026, month: 8, day: 5, hour: 9, minute: 30)
    )
  }

  func testNonWeeklyRecurrenceCannotRetainWeekdays() {
    var rule = TaskRecurrenceRule(
      mode: .fixedSchedule,
      interval: 2,
      unit: .month,
      weekdays: [.monday, .wednesday]
    )
    rule.interval = 200

    let normalized = TaskTemporalPolicy.normalized(rule)

    XCTAssertEqual(normalized.unit, .month)
    XCTAssertEqual(normalized.interval, 99)
    XCTAssertTrue(normalized.weekdays.isEmpty)
  }

  func testLateFixedRecurrenceAdvancesToFirstOccurrenceAfterCompletion() throws {
    let calendar = utcCalendar
    let scheduled = try date(2026, 7, 1, 9, calendar: calendar)
    let reminder = try date(2026, 7, 1, 8, calendar: calendar)
    let completed = try date(2026, 7, 29, 11, calendar: calendar)
    let data = TaskData(
      placement: .anytime,
      scheduledAt: scheduled,
      reminder: reminder,
      recurrence: .init(mode: .fixedSchedule, unit: .day)
    )

    let successor = try XCTUnwrap(
      TaskTemporalPolicy.successorData(
        from: data,
        createdAt: scheduled,
        completedAt: completed,
        calendar: calendar
      )
    )

    XCTAssertEqual(successor.scheduledAt, try date(2026, 7, 30, 9, calendar: calendar))
    XCTAssertEqual(successor.reminder, try date(2026, 7, 30, 8, calendar: calendar))
  }

  func testVeryStaleDailyRecurrenceFastForwardsWithoutWalkingEveryMissedDay() throws {
    let calendar = utcCalendar
    let scheduled = try date(1900, 1, 1, 9, calendar: calendar)
    let completed = try date(2026, 7, 29, 11, calendar: calendar)
    let data = TaskData(
      placement: .anytime,
      scheduledAt: scheduled,
      recurrence: .init(mode: .fixedSchedule, unit: .day)
    )

    let successor = try XCTUnwrap(
      TaskTemporalPolicy.successorData(
        from: data,
        createdAt: scheduled,
        completedAt: completed,
        calendar: calendar
      )
    )

    XCTAssertEqual(successor.scheduledAt, try date(2026, 7, 30, 9, calendar: calendar))
  }

  func testStaleMonthlyRecurrencePreservesRepeatedMonthEndClamping() throws {
    let calendar = utcCalendar
    let scheduled = try date(2026, 1, 31, 9, calendar: calendar)
    let completed = try date(2026, 7, 29, 11, calendar: calendar)
    let data = TaskData(
      placement: .anytime,
      scheduledAt: scheduled,
      recurrence: .init(mode: .fixedSchedule, unit: .month)
    )

    let successor = try XCTUnwrap(
      TaskTemporalPolicy.successorData(
        from: data,
        createdAt: scheduled,
        completedAt: completed,
        calendar: calendar
      )
    )

    XCTAssertEqual(successor.scheduledAt, try date(2026, 8, 28, 9, calendar: calendar))
  }

  func testStaleYearlyRecurrencePreservesRepeatedLeapDayClamping() throws {
    let calendar = utcCalendar
    let scheduled = try date(2000, 2, 29, 9, calendar: calendar)
    let completed = try date(2397, 3, 1, 12, calendar: calendar)
    let data = TaskData(
      placement: .anytime,
      scheduledAt: scheduled,
      recurrence: .init(mode: .fixedSchedule, interval: 4, unit: .year)
    )

    let successor = try XCTUnwrap(
      TaskTemporalPolicy.successorData(
        from: data,
        createdAt: scheduled,
        completedAt: completed,
        calendar: calendar
      )
    )

    XCTAssertEqual(successor.scheduledAt, try date(2400, 2, 28, 9, calendar: calendar))
  }

  func testDeadlineAndReminderOffsetsRemainWallClockStableAcrossDST() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
    let scheduled = try date(2026, 3, 7, 9, calendar: calendar)
    let deadline = try date(2026, 3, 8, 0, calendar: calendar)
    let reminder = try date(2026, 3, 7, 8, calendar: calendar)
    let completed = try date(2026, 3, 7, 10, calendar: calendar)
    let data = TaskData(
      placement: .anytime,
      scheduledAt: scheduled,
      deadline: deadline,
      reminder: reminder,
      recurrence: .init(mode: .fixedSchedule, unit: .day)
    )

    let successor = try XCTUnwrap(
      TaskTemporalPolicy.successorData(
        from: data,
        createdAt: scheduled,
        completedAt: completed,
        calendar: calendar
      )
    )

    XCTAssertEqual(successor.scheduledAt, try date(2026, 3, 8, 9, calendar: calendar))
    XCTAssertEqual(successor.deadline, try date(2026, 3, 9, 0, calendar: calendar))
    XCTAssertEqual(successor.reminder, try date(2026, 3, 8, 8, calendar: calendar))
  }

  func testAfterCompletionDeadlinePreservesCalendarDayDistanceWhenClockChanges() throws {
    let calendar = utcCalendar
    let scheduled = try date(2026, 7, 28, 18, calendar: calendar)
    let deadline = try date(2026, 7, 29, 0, calendar: calendar)
    let completed = try date(2026, 7, 29, 1, calendar: calendar)
    let data = TaskData(
      placement: .anytime,
      scheduledAt: scheduled,
      deadline: deadline,
      recurrence: .init(mode: .afterCompletion, unit: .day)
    )

    let successor = try XCTUnwrap(
      TaskTemporalPolicy.successorData(
        from: data,
        createdAt: scheduled,
        completedAt: completed,
        calendar: calendar
      )
    )

    XCTAssertEqual(successor.scheduledAt, try date(2026, 7, 30, 1, calendar: calendar))
    XCTAssertEqual(successor.deadline, try date(2026, 7, 31, 0, calendar: calendar))
  }

  func testDateOnlyScheduleAndDeadlineNormalizeToStartOfDay() throws {
    let calendar = utcCalendar
    let data = TaskData(
      scheduledAt: try date(2026, 8, 4, 17, calendar: calendar),
      scheduleGranularity: .dateOnly,
      deadline: try date(2026, 8, 7, 19, calendar: calendar)
    )

    let normalized = TaskTemporalPolicy.normalized(data, calendar: calendar)

    XCTAssertEqual(normalized.scheduledAt, try date(2026, 8, 4, 0, calendar: calendar))
    XCTAssertEqual(normalized.deadline, try date(2026, 8, 7, 0, calendar: calendar))
  }

  func testRecurrenceEndDateIncludesTheEntireCalendarDay() throws {
    let calendar = utcCalendar
    let endDate = try date(2026, 7, 30, 20, calendar: calendar)
    let rule = TaskRecurrenceRule(mode: .fixedSchedule, unit: .day, endDate: endDate)
    let july29 = try date(2026, 7, 29, 9, calendar: calendar)
    let july30 = try date(2026, 7, 30, 9, calendar: calendar)

    XCTAssertEqual(rule.nextDate(after: july29, calendar: calendar), july30)
    XCTAssertNil(rule.nextDate(after: july30, calendar: calendar))
  }

  private var utcCalendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    return calendar
  }

  private func date(
    _ year: Int,
    _ month: Int,
    _ day: Int,
    _ hour: Int,
    _ minute: Int = 0,
    calendar: Calendar
  ) throws -> Date {
    try XCTUnwrap(
      calendar.date(
        from: DateComponents(
          year: year,
          month: month,
          day: day,
          hour: hour,
          minute: minute
        )
      )
    )
  }
}
