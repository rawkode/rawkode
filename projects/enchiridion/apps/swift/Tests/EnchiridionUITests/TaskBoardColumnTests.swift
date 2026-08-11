// TaskBoardColumnTests.swift
// EnchiridionUITests
//
// Task #82. Pure logic tests for `TaskBoardColumn` (TaskBrowserModels.swift)
// — no `LocalGraphStore`, no SwiftUI: `assigned(to:today:calendar:)` (read
// direction: which single column a task belongs in) and
// `propertyUpdates(now:calendar:currentStatus:)` (write direction: what a
// drag-and-drop move into a column actually writes), including the
// "moving out of Done resets status" and "a stale deadline doesn't outrank
// a fresh Today/Upcoming move" cases the header comment documents.

import EnchiridionCore
import EnchiridionSchema
import Foundation
import XCTest

@testable import EnchiridionUI

final class TaskBoardColumnTests: XCTestCase {
  private let calendar = Calendar(identifier: .gregorian)
  private let now = Date(timeIntervalSince1970: 1_800_000_000)

  private func item(
    title: String = "Task",
    status: CoreTaskStatus? = .toDo,
    placement: CoreTaskPlacement? = nil,
    scheduledAt: Date? = nil,
    deadlineAt: Date? = nil
  ) -> TaskListItem {
    TaskListItem(
      pageID: .free(), title: title, status: status, placement: placement, priority: nil,
      scheduledAt: scheduledAt, deadlineAt: deadlineAt, dueAt: nil, completedAt: nil, modifiedAt: nil)
  }

  // MARK: - assigned(to:today:calendar:) — read direction

  func testDoneOrCancelledStatusAlwaysWinsRegardlessOfPlacementOrDates() {
    let today = calendar.startOfDay(for: now)
    let done = item(status: .done, placement: .inbox, scheduledAt: today)
    let cancelled = item(status: .cancelled, placement: .someday)
    XCTAssertEqual(TaskBoardColumn.assigned(to: done, today: today, calendar: calendar), .done)
    XCTAssertEqual(TaskBoardColumn.assigned(to: cancelled, today: today, calendar: calendar), .done)
  }

  func testScheduledOrDeadlineTodayOrEarlierMapsToToday() {
    let today = calendar.startOfDay(for: now)
    let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
    let scheduledToday = item(scheduledAt: today)
    let overdue = item(deadlineAt: yesterday)
    XCTAssertEqual(TaskBoardColumn.assigned(to: scheduledToday, today: today, calendar: calendar), .today)
    XCTAssertEqual(TaskBoardColumn.assigned(to: overdue, today: today, calendar: calendar), .today)
  }

  func testScheduledOrDeadlineAfterTodayMapsToUpcoming() {
    let today = calendar.startOfDay(for: now)
    let tomorrow = calendar.date(byAdding: .day, value: 1, to: today)!
    let scheduled = item(scheduledAt: tomorrow)
    let deadline = item(deadlineAt: tomorrow)
    XCTAssertEqual(TaskBoardColumn.assigned(to: scheduled, today: today, calendar: calendar), .upcoming)
    XCTAssertEqual(TaskBoardColumn.assigned(to: deadline, today: today, calendar: calendar), .upcoming)
  }

  func testPlacementDecidesWhenNoDatesAreSet() {
    let today = calendar.startOfDay(for: now)
    XCTAssertEqual(
      TaskBoardColumn.assigned(to: item(placement: .inbox), today: today, calendar: calendar), .inbox)
    XCTAssertEqual(
      TaskBoardColumn.assigned(to: item(placement: .someday), today: today, calendar: calendar), .someday)
    XCTAssertEqual(
      TaskBoardColumn.assigned(to: item(placement: .anytime), today: today, calendar: calendar), .anytime)
  }

  func testNoPlacementAtAllFallsBackToAnytime() {
    let today = calendar.startOfDay(for: now)
    XCTAssertEqual(
      TaskBoardColumn.assigned(to: item(placement: nil), today: today, calendar: calendar), .anytime)
  }

  // MARK: - propertyUpdates(now:calendar:currentStatus:) — write direction

  func testMovingToTodaySetsScheduledToStartOfTodayAndClearsDeadline() {
    let updates = TaskBoardColumn.today.propertyUpdates(now: now, calendar: calendar, currentStatus: .toDo)
    let scheduledKey = SupertagPropertyKey(
      supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.scheduled)
    let deadlineKey = SupertagPropertyKey(
      supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.deadline)
    XCTAssertEqual(updates[scheduledKey], [.dateTime(calendar.startOfDay(for: now))])
    XCTAssertEqual(updates[deadlineKey], [])
    XCTAssertNil(updates[SupertagPropertyKey(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.status)])
  }

  func testMovingToUpcomingSetsScheduledToStartOfTomorrow() {
    let updates = TaskBoardColumn.upcoming.propertyUpdates(now: now, calendar: calendar, currentStatus: .toDo)
    let scheduledKey = SupertagPropertyKey(
      supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.scheduled)
    let expectedTomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))!
    XCTAssertEqual(updates[scheduledKey], [.dateTime(expectedTomorrow)])
  }

  func testMovingToInboxSetsPlacementAndClearsBothDates() {
    let updates = TaskBoardColumn.inbox.propertyUpdates(now: now, calendar: calendar, currentStatus: .toDo)
    let placementKey = SupertagPropertyKey(
      supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.placement)
    let scheduledKey = SupertagPropertyKey(
      supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.scheduled)
    let deadlineKey = SupertagPropertyKey(
      supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.deadline)
    XCTAssertEqual(updates[placementKey], [.select(CoreTaskPlacement.inbox.rawValue)])
    XCTAssertEqual(updates[scheduledKey], [])
    XCTAssertEqual(updates[deadlineKey], [])
  }

  func testMovingToAnytimeSetsPlacementAnytime() {
    let updates = TaskBoardColumn.anytime.propertyUpdates(now: now, calendar: calendar, currentStatus: .toDo)
    let placementKey = SupertagPropertyKey(
      supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.placement)
    XCTAssertEqual(updates[placementKey], [.select(CoreTaskPlacement.anytime.rawValue)])
  }

  func testMovingToSomedaySetsPlacementSomeday() {
    let updates = TaskBoardColumn.someday.propertyUpdates(now: now, calendar: calendar, currentStatus: .toDo)
    let placementKey = SupertagPropertyKey(
      supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.placement)
    XCTAssertEqual(updates[placementKey], [.select(CoreTaskPlacement.someday.rawValue)])
  }

  func testMovingToDoneSetsStatusDoneAndCompletedAt() {
    let updates = TaskBoardColumn.done.propertyUpdates(now: now, calendar: calendar, currentStatus: .toDo)
    let statusKey = SupertagPropertyKey(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.status)
    let completedAtKey = SupertagPropertyKey(
      supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.completedAt)
    XCTAssertEqual(updates[statusKey], [.select(CoreTaskStatus.done.rawValue)])
    XCTAssertEqual(updates[completedAtKey], [.dateTime(now)])
  }

  func testMovingOutOfDoneResetsStatusAndClearsCompletedAt() {
    for column: TaskBoardColumn in [.inbox, .today, .upcoming, .anytime, .someday] {
      let updates = column.propertyUpdates(now: now, calendar: calendar, currentStatus: .done)
      let statusKey = SupertagPropertyKey(
        supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.status)
      let completedAtKey = SupertagPropertyKey(
        supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.completedAt)
      XCTAssertEqual(
        updates[statusKey], [.select(CoreTaskStatus.toDo.rawValue)],
        "\(column) must reset a finished task's status back to to-do")
      XCTAssertEqual(updates[completedAtKey], [], "\(column) must clear completedAt")
    }
  }

  func testMovingBetweenTwoNonDoneColumnsDoesNotTouchStatus() {
    let updates = TaskBoardColumn.someday.propertyUpdates(now: now, calendar: calendar, currentStatus: .toDo)
    let statusKey = SupertagPropertyKey(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.status)
    XCTAssertNil(updates[statusKey], "an already-active task moving between non-Done columns must not rewrite status")
  }
}
