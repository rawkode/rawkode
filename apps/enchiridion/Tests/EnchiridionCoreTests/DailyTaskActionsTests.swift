import Foundation
import XCTest
@testable import EnchiridionCore

final class DailyTaskActionsTests: XCTestCase {
  private var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    return calendar
  }

  func testDraftSchedulesSelectedDayWithoutInventingATime() throws {
    let day = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 8, day: 4, hour: 17, minute: 30))
    )

    let draft = DailyTaskActions.draft(title: "  Prepare roadmap  ", on: day, calendar: calendar)

    XCTAssertEqual(draft.title, "Prepare roadmap")
    XCTAssertEqual(draft.data.placement, .anytime)
    XCTAssertEqual(draft.data.scheduleGranularity, .dateOnly)
    XCTAssertEqual(draft.data.scheduledAt, calendar.startOfDay(for: day))
  }

  func testDeferringDateOnlyTaskPreservesDateOnlyGranularity() throws {
    let originalDay = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 8, day: 4))
    )
    let targetDay = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 8, day: 8, hour: 14))
    )
    let original = TaskData(
      placement: .anytime,
      scheduledAt: originalDay,
      scheduleGranularity: .dateOnly,
      priority: .high,
      tags: ["work"]
    )

    let deferred = DailyTaskActions.deferred(original, to: targetDay, calendar: calendar)

    XCTAssertEqual(deferred.scheduleGranularity, .dateOnly)
    XCTAssertEqual(deferred.scheduledAt, calendar.startOfDay(for: targetDay))
    XCTAssertEqual(deferred.priority, .high)
    XCTAssertEqual(deferred.tags, ["work"])
  }

  func testDeferringTimedTaskPreservesClockTimeAndHardDeadline() throws {
    let original = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 8, day: 4, hour: 16, minute: 45))
    )
    let targetDay = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 8, day: 8))
    )
    let deadline = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 8, day: 7))
    )
    let data = TaskData(
      placement: .anytime,
      scheduledAt: original,
      scheduleGranularity: .dateTime,
      deadline: deadline
    )

    let deferred = DailyTaskActions.deferred(data, to: targetDay, calendar: calendar)
    let components = calendar.dateComponents(
      [.year, .month, .day, .hour, .minute],
      from: try XCTUnwrap(deferred.scheduledAt)
    )

    XCTAssertEqual(components.year, 2026)
    XCTAssertEqual(components.month, 8)
    XCTAssertEqual(components.day, 8)
    XCTAssertEqual(components.hour, 16)
    XCTAssertEqual(components.minute, 45)
    XCTAssertEqual(deferred.scheduleGranularity, .dateTime)
    XCTAssertEqual(deferred.deadline, deadline)
  }

  func testDeferringUnscheduledTaskUsesDateOnlySchedule() throws {
    let targetDay = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 8, day: 8, hour: 19))
    )

    let deferred = DailyTaskActions.deferred(TaskData(), to: targetDay, calendar: calendar)

    XCTAssertEqual(deferred.scheduledAt, calendar.startOfDay(for: targetDay))
    XCTAssertEqual(deferred.scheduleGranularity, .dateOnly)
  }

  func testTomorrowUsesTheNextCalendarDay() throws {
    let now = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 8, day: 4, hour: 23, minute: 50))
    )

    let deferred = DailyTaskActions.deferredToTomorrow(TaskData(), now: now, calendar: calendar)

    XCTAssertEqual(
      deferred.scheduledAt,
      calendar.date(from: DateComponents(year: 2026, month: 8, day: 5))
    )
  }
}
