import Foundation
import XCTest

@testable import EnchiridionCore

final class DayCapacityPlanningTests: XCTestCase {
  func testTimedEventsAreClippedMergedAndAllDayEventsAreIgnored() throws {
    let plan = DayCapacityPlanner.plan(
      day: date(hour: 12),
      events: [
        event(from: 7, to: 9),
        event(from: 8, minute: 30, to: 10),
        event(from: 10, to: 11),
        DayCapacityEvent(start: date(hour: 0), end: date(day: 30, hour: 0), isAllDay: true),
      ],
      tasks: [],
      calendar: calendar,
      now: date(day: 28, hour: 12)
    )

    XCTAssertEqual(plan.busyIntervals, [try interval(from: 8, to: 11)])
    XCTAssertEqual(plan.freeIntervals, [try interval(from: 11, to: 18)])
    XCTAssertEqual(plan.availableMinutes, 420)
  }

  func testEstimatedTimedTasksReserveSpaceAndCapacityUsesContiguousGaps() throws {
    let timedTask = task(
      "timed", scheduledAt: date(hour: 8, minute: 30), granularity: .dateTime, estimate: 60)
    let longTask = task("long", scheduledAt: date(hour: 0), granularity: .dateOnly, estimate: 300)
    let overflowTask = task("overflow", scheduledAt: nil, granularity: .dateOnly, estimate: 240)
    let unknownTask = task(
      "unknown", scheduledAt: date(hour: 0), granularity: .dateOnly, estimate: nil)

    let plan = DayCapacityPlanner.plan(
      day: date(hour: 12),
      events: [event(from: 10, to: 11)],
      tasks: [timedTask, longTask, overflowTask, unknownTask],
      calendar: calendar,
      now: date(day: 28, hour: 12)
    )

    XCTAssertEqual(plan.plannedMinutes, 60)
    XCTAssertEqual(plan.unscheduledMinutes, 540)
    XCTAssertEqual(plan.availableMinutes, 480)
    XCTAssertEqual(plan.overCapacityMinutes, 60)
    XCTAssertEqual(plan.tasksWithoutEstimates, 1)
    XCTAssertEqual(plan.suggestion(for: longTask.id)?.interval, try interval(from: 11, to: 16))
    XCTAssertNil(plan.suggestion(for: overflowTask.id))
    XCTAssertNil(plan.suggestion(for: unknownTask.id))
  }

  func testSuggestionsAreDeterministicForInputOrderAndNeverCrossBusyTime() throws {
    let first = task("first", scheduledAt: date(hour: 0), granularity: .dateOnly, estimate: 90)
    let second = task("second", scheduledAt: nil, granularity: .dateOnly, estimate: 30)

    let plan = DayCapacityPlanner.plan(
      day: date(hour: 12),
      events: [event(from: 9, to: 10), event(from: 12, to: 18)],
      tasks: [first, second],
      calendar: calendar,
      now: date(day: 28, hour: 12)
    )

    XCTAssertEqual(plan.suggestions.map(\.taskID), [first.id, second.id])
    XCTAssertEqual(
      plan.suggestion(for: first.id)?.interval, try interval(from: 10, to: 11, endMinute: 30))
    XCTAssertEqual(
      plan.suggestion(for: second.id)?.interval, try interval(from: 8, to: 8, endMinute: 30))
  }

  func testInvalidEstimatesRemainUnknownInsteadOfInventingDurations() {
    let zero = task("zero", scheduledAt: date(hour: 9), granularity: .dateTime, estimate: 0)
    let negative = task("negative", scheduledAt: nil, granularity: .dateOnly, estimate: -15)

    let plan = DayCapacityPlanner.plan(
      day: date(hour: 12),
      events: [],
      tasks: [zero, negative],
      calendar: calendar,
      now: date(day: 28, hour: 12)
    )

    XCTAssertEqual(plan.plannedMinutes, 0)
    XCTAssertEqual(plan.unscheduledMinutes, 0)
    XCTAssertEqual(plan.availableMinutes, 600)
    XCTAssertEqual(plan.tasksWithoutEstimates, 2)
    XCTAssertTrue(plan.suggestions.isEmpty)
  }

  func testTodaySuggestionsStartAtNextFiveMinuteBoundary() throws {
    let flexible = task("flexible", scheduledAt: nil, granularity: .dateOnly, estimate: 60)

    let plan = DayCapacityPlanner.plan(
      day: date(hour: 9),
      events: [],
      tasks: [flexible],
      calendar: calendar,
      now: date(hour: 12, minute: 12)
    )

    XCTAssertEqual(plan.availableMinutes, 345)
    XCTAssertEqual(
      plan.suggestion(for: flexible.id)?.interval,
      try interval(from: 12, minute: 15, to: 13, endMinute: 15)
    )
  }

  func testTaskScheduledOnAnotherDayIsNotReplannedOnItsDeadlineDay() {
    let alreadyScheduled = task(
      "scheduled-tomorrow",
      scheduledAt: date(day: 30, hour: 0),
      granularity: .dateOnly,
      estimate: 60
    )

    let plan = DayCapacityPlanner.plan(
      day: date(hour: 9),
      events: [],
      tasks: [alreadyScheduled],
      calendar: calendar,
      now: date(day: 28, hour: 12)
    )

    XCTAssertEqual(plan.plannedMinutes, 0)
    XCTAssertEqual(plan.unscheduledMinutes, 0)
    XCTAssertNil(plan.suggestion(for: alreadyScheduled.id))
  }

  func testPastDaysNeverOfferSchedulingSuggestions() {
    let flexible = task("past", scheduledAt: nil, granularity: .dateOnly, estimate: 60)

    let plan = DayCapacityPlanner.plan(
      day: date(hour: 9),
      events: [],
      tasks: [flexible],
      calendar: calendar,
      now: date(day: 30, hour: 9)
    )

    XCTAssertEqual(plan.availableMinutes, 0)
    XCTAssertEqual(plan.overCapacityMinutes, 60)
    XCTAssertTrue(plan.suggestions.isEmpty)
  }

  private var calendar: Calendar {
    var value = Calendar(identifier: .gregorian)
    value.timeZone = TimeZone(secondsFromGMT: 0)!
    return value
  }

  private func date(day: Int = 29, hour: Int, minute: Int = 0) -> Date {
    calendar.date(
      from: DateComponents(
        year: 2026,
        month: 7,
        day: day,
        hour: hour,
        minute: minute
      ))!
  }

  private func event(
    from startHour: Int,
    minute startMinute: Int = 0,
    to endHour: Int,
    endMinute: Int = 0
  ) -> DayCapacityEvent {
    DayCapacityEvent(
      start: date(hour: startHour, minute: startMinute),
      end: date(hour: endHour, minute: endMinute),
      isAllDay: false
    )
  }

  private func interval(
    from startHour: Int,
    minute startMinute: Int = 0,
    to endHour: Int,
    endMinute: Int = 0
  ) throws -> DayCapacityInterval {
    try XCTUnwrap(
      DayCapacityInterval(
        start: date(hour: startHour, minute: startMinute),
        end: date(hour: endHour, minute: endMinute)
      ))
  }

  private func task(
    _ id: String,
    scheduledAt: Date?,
    granularity: TaskScheduleGranularity,
    estimate: Int?
  ) -> DayCapacityTask {
    DayCapacityTask(
      id: PageID(rawValue: id),
      scheduledAt: scheduledAt,
      scheduleGranularity: granularity,
      estimatedMinutes: estimate
    )
  }
}
