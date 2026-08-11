// TaskBrowserQueryTests.swift
// EnchiridionUITests
//
// Task #82. Exercises `LocalGraphStore.fetchAllTasks()`
// (TaskBrowserQuery.swift) against a REAL temporary `LocalGraphStore` —
// real `writeProjection` writes, real bounded-SQL reads — matching
// `AssistantReadToolsTests.swift`'s established fixture convention
// (`makeStore()`/`page(_:)`/a `taskProjection(...)` helper building real
// `PageDocumentProjection` fixtures). Confirms:
//   1. Every seeded task round-trips with its real field values.
//   2. `TaskBoardColumn.assigned(to:today:calendar:)`, applied to
//      `fetchAllTasks()`'s real output, groups tasks into the correct
//      column — this is the actual "list/kanban correctly groups/filters
//      real tasks" property the task brief requires, proven end-to-end
//      from a real store rather than only against hand-built
//      `TaskListItem` values (see `TaskBoardColumnTests.swift` for the
//      pure-logic half of that coverage).
//   3. A deleted (soft-deleted) task page is excluded, matching every
//      other read path in this package.
//   4. This is a genuinely unbounded browse — no result cap — unlike
//      `AssistantReadTools.searchTasks`.

import EnchiridionCore
import EnchiridionSchema
import EnchiridionStore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionUI

final class TaskBrowserQueryTests: XCTestCase {
  private func makeStore() throws -> LocalGraphStore {
    try LocalGraphStore.openTemporary()
  }

  private func page(_ n: Int) -> PageID {
    PageID.free(UUID(uuidString: String(format: "00000000-0000-0000-0000-%012d", n))!)
  }

  private func taskProjection(
    title: String, status: CoreTaskStatus, placement: CoreTaskPlacement?, scheduled: Date? = nil,
    deadline: Date? = nil, completedAt: Date? = nil, priority: CoreTaskPriority? = nil,
    deletedAt: Date? = nil
  ) -> PageDocumentProjection {
    var properties: [SupertagPropertyKey: [SupertagValue]] = [
      .init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.status): [
        .select(status.rawValue)
      ]
    ]
    if let placement {
      properties[.init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.placement)] = [
        .select(placement.rawValue)
      ]
    }
    if let scheduled {
      properties[.init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.scheduled)] = [
        .dateTime(scheduled)
      ]
    }
    if let deadline {
      properties[.init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.deadline)] = [
        .date(deadline)
      ]
    }
    if let completedAt {
      properties[.init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.completedAt)] = [
        .dateTime(completedAt)
      ]
    }
    if let priority {
      properties[.init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.priority)] = [
        .select(priority.rawValue)
      ]
    }
    return .init(
      title: title, plainText: title, deletedAt: deletedAt, isPinned: false, references: [],
      graphEdges: [],
      objectMetadata: .init(supertagIDs: [CoreTaskFieldIDs.supertagID], properties: properties))
  }

  func testFetchAllTasksReturnsEveryTaskWithItsRealFieldValues() async throws {
    let store = try makeStore()
    let scheduled = Date(timeIntervalSince1970: 1_800_000_000)
    try await store.writeProjection(
      pageID: page(1), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(
        title: "Write report", status: .toDo, placement: .anytime, scheduled: scheduled,
        priority: .high))
    try await store.writeProjection(
      pageID: page(2), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Read book", status: .toDo, placement: .someday))

    let tasks = try store.fetchAllTasks()

    XCTAssertEqual(tasks.count, 2)
    let writeReport = try XCTUnwrap(tasks.first { $0.title == "Write report" })
    XCTAssertEqual(writeReport.status, .toDo)
    XCTAssertEqual(writeReport.placement, .anytime)
    XCTAssertEqual(writeReport.priority, .high)
    XCTAssertEqual(writeReport.scheduledAt, scheduled)
    XCTAssertTrue(writeReport.isActive)
  }

  func testFetchAllTasksExcludesSoftDeletedPages() async throws {
    let store = try makeStore()
    try await store.writeProjection(
      pageID: page(3), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(
        title: "Deleted task", status: .toDo, placement: .inbox, deletedAt: Date()))
    try await store.writeProjection(
      pageID: page(4), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Live task", status: .toDo, placement: .inbox))

    let tasks = try store.fetchAllTasks()

    XCTAssertEqual(tasks.map(\.title), ["Live task"])
  }

  func testFetchAllTasksIsUnbounded() async throws {
    let store = try makeStore()
    for index in 0..<25 {
      try await store.writeProjection(
        pageID: page(100 + index), kind: .free, createdAt: Date(), modifiedAt: Date(),
        projection: taskProjection(title: "Task \(index)", status: .toDo, placement: .anytime))
    }

    let tasks = try store.fetchAllTasks()

    XCTAssertEqual(
      tasks.count, 25,
      "unlike AssistantReadTools.searchTasks (task #66's caps), this is a full local browse with no result cap")
  }

  func testFetchAllTasksGroupedByTaskBoardColumnMatchesExpectedLanes() async throws {
    let store = try makeStore()
    let calendar = Calendar(identifier: .gregorian)
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let today = calendar.startOfDay(for: now)
    let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
    let tomorrow = calendar.date(byAdding: .day, value: 1, to: today)!

    try await store.writeProjection(
      pageID: page(10), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Inbox item", status: .toDo, placement: .inbox))
    try await store.writeProjection(
      pageID: page(11), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Overdue item", status: .toDo, placement: nil, scheduled: yesterday))
    try await store.writeProjection(
      pageID: page(12), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Upcoming item", status: .toDo, placement: nil, scheduled: tomorrow))
    try await store.writeProjection(
      pageID: page(13), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Anytime item", status: .toDo, placement: .anytime))
    try await store.writeProjection(
      pageID: page(14), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Someday item", status: .toDo, placement: .someday))
    try await store.writeProjection(
      pageID: page(15), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Done item", status: .done, placement: .inbox, completedAt: now))
    try await store.writeProjection(
      pageID: page(16), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Cancelled item", status: .cancelled, placement: .anytime))

    let tasks = try store.fetchAllTasks()
    XCTAssertEqual(tasks.count, 7)

    let grouped = Dictionary(grouping: tasks) {
      TaskBoardColumn.assigned(to: $0, today: today, calendar: calendar)
    }

    XCTAssertEqual(grouped[.inbox]?.map(\.title), ["Inbox item"])
    XCTAssertEqual(grouped[.today]?.map(\.title), ["Overdue item"])
    XCTAssertEqual(grouped[.upcoming]?.map(\.title), ["Upcoming item"])
    XCTAssertEqual(grouped[.anytime]?.map(\.title), ["Anytime item"])
    XCTAssertEqual(grouped[.someday]?.map(\.title), ["Someday item"])
    XCTAssertEqual(Set(grouped[.done]?.map(\.title) ?? []), ["Done item", "Cancelled item"])
  }
}
