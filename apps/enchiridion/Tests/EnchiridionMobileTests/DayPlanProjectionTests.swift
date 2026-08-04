import EnchiridionCore
import Foundation
import XCTest

@testable import Enchiridion

@available(iOS 26.0, *)
final class DayPlanProjectionTests: XCTestCase {
  private var calendar: Calendar {
    var value = Calendar(identifier: .gregorian)
    value.timeZone = TimeZone(identifier: "America/Los_Angeles")!
    return value
  }

  func testTodayProjectionIncludesOverdueButExactDaysDoNot() {
    let day = date(2026, 8, 3)
    let overdue = task("Overdue", scheduled: date(2026, 8, 2, 9))
    let scheduled = task("Scheduled", scheduled: date(2026, 8, 3, 9))
    let future = task("Future", scheduled: date(2026, 8, 4, 9))

    let today = DayPlanProjection(
      day: day, pages: [overdue, scheduled, future], events: [], calendar: calendar,
      includeOverdue: true)
    let historical = DayPlanProjection(
      day: day, pages: [overdue, scheduled, future], events: [], calendar: calendar,
      includeOverdue: false)

    XCTAssertEqual(taskTitles(today.agendaItems), ["Overdue", "Scheduled"])
    XCTAssertEqual(taskTitles(historical.agendaItems), ["Scheduled"])
  }

  func testFutureAndHistoricalDatesUseExactDayOnly() {
    let day = date(2026, 8, 5)
    let prior = task("Prior", deadline: date(2026, 8, 4))
    let exact = task("Exact", deadline: day)
    XCTAssertEqual(
      taskTitles(
        DayPlanProjection(
          day: day, pages: [prior, exact], events: [], calendar: calendar, includeOverdue: false
        ).agendaItems), ["Exact"])
  }

  func testScheduleAndDeadlineOnSameDayProducesOneTaskAndCapacityEntry() {
    let day = date(2026, 8, 3)
    let both = task("One", scheduled: date(2026, 8, 3, 10), deadline: day)
    let projection = DayPlanProjection(
      day: day, pages: [both], events: [], calendar: calendar, includeOverdue: true)
    XCTAssertEqual(taskTitles(projection.agendaItems), ["One"])
    XCTAssertEqual(projection.capacityTasks.count, 1)
  }

  func testAnytimeIsTodayOnlyDeduplicatedAndCapped() {
    let day = date(2026, 8, 3)
    let datedAnytime = task("Dated", placement: .anytime, scheduled: date(2026, 8, 3, 8))
    let anytime = (1...7).map { task("Anytime \($0)", placement: .anytime) }
    let today = DayPlanProjection(
      day: day, pages: [datedAnytime] + anytime, events: [], calendar: calendar,
      includeOverdue: true)
    let other = DayPlanProjection(
      day: day, pages: [datedAnytime] + anytime, events: [], calendar: calendar,
      includeOverdue: false)
    XCTAssertEqual(today.anytimeTasks.count, 6)
    XCTAssertTrue(today.hasMoreAnytime)
    XCTAssertFalse(today.anytimeTasks.contains { $0.page.displayTitle == "Dated" })
    XCTAssertTrue(other.anytimeTasks.isEmpty)
    XCTAssertFalse(other.hasMoreAnytime)
  }

  func testAgendaOrderingIsStableForTiesAndIncludesAllDayAndSpanningEvents() {
    let day = date(2026, 8, 3)
    let allDay = event(
      "All day", start: day, end: date(2026, 8, 4), allDay: true, identifier: "all")
    let spanning = event(
      "Spanning", start: date(2026, 8, 2, 22), end: date(2026, 8, 3, 2), identifier: "span")
    let first = event(
      "Same", start: date(2026, 8, 3, 9), end: date(2026, 8, 3, 10), identifier: "a")
    let second = event(
      "Same", start: date(2026, 8, 3, 9), end: date(2026, 8, 3, 10), identifier: "b")
    let once = CalendarAgendaDate.events(
      on: day, in: [second, spanning, first, allDay], calendar: calendar)
    let twice = CalendarAgendaDate.events(
      on: day, in: [second, spanning, first, allDay], calendar: calendar)
    XCTAssertEqual(once.map(\.id), twice.map(\.id))
    XCTAssertEqual(once.map(\.title), ["All day", "Spanning", "Same", "Same"])
    XCTAssertEqual(once.suffix(2).map(\.id), [first.id, second.id])
  }

  private func task(
    _ title: String, placement: TaskPlacement = .inbox, scheduled: Date? = nil,
    deadline: Date? = nil
  ) -> PageSnapshot {
    let data = TaskData(
      placement: placement, scheduledAt: scheduled, scheduleGranularity: .dateTime,
      deadline: deadline)
    return PageSnapshot(
      id: .free(), kind: .free, title: title, plainText: "", document: Data(), heads: .empty,
      createdAt: date(2026, 1, 1), modifiedAt: date(2026, 1, 1),
      objectMetadata: .init(
        supertagIDs: [BuiltInSupertags.task], properties: TaskFields.properties(for: data)))
  }
  private func event(
    _ title: String, start: Date, end: Date, allDay: Bool = false, identifier: String
  ) -> CalendarEventSnapshot {
    CalendarEventSnapshot(
      identity: .init(externalIdentifier: identifier, occurrenceStart: start), title: title,
      startDate: start, endDate: end, isAllDay: allDay, location: nil, notes: nil, url: nil,
      calendarTitle: "Work")
  }
  private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 0) -> Date {
    calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
  }
  private func taskTitles(_ items: [CalendarAgendaItem]) -> [String] {
    items.compactMap { if case .task(let task, _) = $0 { task.page.displayTitle } else { nil } }
  }
}
