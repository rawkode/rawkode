// WidgetEntryDataSourceTests.swift
// EnchiridionWidgetKitTests
//
// P6 "Widgets" task. Exercises `WidgetEntryDataSource.loadTodayTasksEntry`/
// `loadNextEventEntry` against a REAL temporary `LocalGraphStore` — same
// fixture-writing pattern as
// `EnchiridionStoreTests/AssistantReadToolsTests.swift` (real
// `writeProjection` calls, real bounded-SQL reads underneath, nothing
// mocked). These functions are thin wrappers over `searchTasks`/
// `findCalendarEvents` (already covered by that file's own tests), so
// coverage here focuses on what THIS layer adds: the fixed/hardcoded
// authorization construction, result-to-entry shaping, and the
// lookahead-window/ongoing-event selection for the next-event widget —
// not re-proving `searchTasks`/`findCalendarEvents`'s own scope semantics.

import EnchiridionCore
import EnchiridionSchema
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionStore
@testable import EnchiridionWidgetKit

final class WidgetEntryDataSourceTests: XCTestCase {
  private func makeStore() throws -> LocalGraphStore {
    try LocalGraphStore.openTemporary()
  }

  private func page(_ n: Int) -> PageID {
    PageID.free(UUID(uuidString: String(format: "00000000-0000-0000-0000-%012d", n))!)
  }

  // MARK: - Today's tasks

  private func taskProjection(
    title: String, status: CoreTaskStatus, placement: CoreTaskPlacement?, scheduled: Date? = nil
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
    return .init(
      title: title, plainText: title, deletedAt: nil, isPinned: false, references: [], graphEdges: [],
      objectMetadata: .init(supertagIDs: [CoreTaskFieldIDs.supertagID], properties: properties))
  }

  func testLoadTodayTasksEntryReturnsTodaysActiveTaskTitles() async throws {
    let store = try makeStore()
    let calendar = Calendar(identifier: .gregorian)
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let today = calendar.startOfDay(for: now)
    let tomorrow = calendar.date(byAdding: .day, value: 1, to: today)!

    try await store.writeProjection(
      pageID: page(1), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Due today", status: .toDo, placement: nil, scheduled: today))
    try await store.writeProjection(
      pageID: page(2), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Due tomorrow", status: .toDo, placement: nil, scheduled: tomorrow))
    try await store.writeProjection(
      pageID: page(3), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Already done today", status: .done, placement: nil, scheduled: today))

    let entry = WidgetEntryDataSource.loadTodayTasksEntry(store: store, now: now, calendar: calendar)

    XCTAssertEqual(entry.taskTitles, ["Due today"])
    XCTAssertFalse(entry.truncated)
    XCTAssertNil(entry.statusMessage)
  }

  func testLoadTodayTasksEntryReturnsEmptyNotFailedWhenThereAreNoTasksToday() async throws {
    let store = try makeStore()
    let entry = WidgetEntryDataSource.loadTodayTasksEntry(store: store)

    XCTAssertEqual(entry.taskTitles, [])
    XCTAssertFalse(entry.truncated)
    XCTAssertNil(entry.statusMessage, "an empty-but-successful read must not be reported as a failure")
  }

  func testLoadTodayTasksEntryTruncatesAtTheFixedResultCapAndSetsTruncated() async throws {
    let store = try makeStore()
    let calendar = Calendar(identifier: .gregorian)
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let today = calendar.startOfDay(for: now)

    for index in 0..<(WidgetEntryDataSource.maximumTaskTitles + 3) {
      try await store.writeProjection(
        pageID: page(10 + index), kind: .free, createdAt: Date(), modifiedAt: Date(),
        projection: taskProjection(
          title: "Task \(index)", status: .toDo, placement: nil, scheduled: today))
    }

    let entry = WidgetEntryDataSource.loadTodayTasksEntry(store: store, now: now, calendar: calendar)

    XCTAssertEqual(entry.taskTitles.count, WidgetEntryDataSource.maximumTaskTitles)
    XCTAssertTrue(entry.truncated)
  }

  // MARK: - Next event

  private func eventProjection(
    title: String, start: Date, end: Date, location: String?
  ) -> PageDocumentProjection {
    var properties: [SupertagPropertyKey: [SupertagValue]] = [
      .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.start): [.dateTime(start)],
      .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.end): [.dateTime(end)],
      .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.allDay): [.boolean(false)],
    ]
    if let location {
      properties[.init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.location)] = [
        .text(location)
      ]
    }
    return .init(
      title: title, plainText: title, deletedAt: nil, isPinned: false, references: [], graphEdges: [],
      objectMetadata: .init(supertagIDs: [CoreEventFieldIDs.supertagID], properties: properties))
  }

  func testLoadNextEventEntryReturnsTheSoonestUpcomingEventInTheLookaheadWindow() async throws {
    let store = try makeStore()
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let soon = now.addingTimeInterval(3_600)
    let later = now.addingTimeInterval(7_200)

    try await store.writeProjection(
      pageID: page(20), kind: .calendarMaterializedEvent(.init(uidDigest: "d1", occurrenceToken: "1")),
      createdAt: Date(), modifiedAt: Date(),
      projection: eventProjection(
        title: "Later meeting", start: later, end: later.addingTimeInterval(1_800), location: nil))
    try await store.writeProjection(
      pageID: page(21), kind: .calendarMaterializedEvent(.init(uidDigest: "d2", occurrenceToken: "1")),
      createdAt: Date(), modifiedAt: Date(),
      projection: eventProjection(
        title: "Soon meeting", start: soon, end: soon.addingTimeInterval(1_800), location: "Room 2"))

    let entry = WidgetEntryDataSource.loadNextEventEntry(store: store, now: now)

    XCTAssertEqual(entry.title, "Soon meeting")
    XCTAssertEqual(entry.startDate, soon)
    XCTAssertEqual(entry.location, "Room 2")
    XCTAssertNil(entry.statusMessage)
  }

  func testLoadNextEventEntryIncludesAnEventAlreadyInProgress() async throws {
    let store = try makeStore()
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let start = now.addingTimeInterval(-600)
    let end = now.addingTimeInterval(1_800)

    try await store.writeProjection(
      pageID: page(22), kind: .calendarMaterializedEvent(.init(uidDigest: "d3", occurrenceToken: "1")),
      createdAt: Date(), modifiedAt: Date(),
      projection: eventProjection(title: "Ongoing standup", start: start, end: end, location: nil))

    let entry = WidgetEntryDataSource.loadNextEventEntry(store: store, now: now)

    XCTAssertEqual(entry.title, "Ongoing standup")
  }

  func testLoadNextEventEntryReturnsNilTitleNotAFailureWhenNothingIsUpcoming() async throws {
    let store = try makeStore()
    let entry = WidgetEntryDataSource.loadNextEventEntry(store: store)

    XCTAssertNil(entry.title)
    XCTAssertNil(entry.statusMessage, "no upcoming events is a real, successful empty result")
  }

  func testLoadNextEventEntryExcludesEventsOutsideTheLookaheadWindow() async throws {
    let store = try makeStore()
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let farFuture = now.addingTimeInterval(
      TimeInterval((WidgetEntryDataSource.calendarLookaheadDays + 5) * 24 * 60 * 60))

    try await store.writeProjection(
      pageID: page(23), kind: .calendarMaterializedEvent(.init(uidDigest: "d4", occurrenceToken: "1")),
      createdAt: Date(), modifiedAt: Date(),
      projection: eventProjection(
        title: "Far future event", start: farFuture, end: farFuture.addingTimeInterval(1_800), location: nil))

    let entry = WidgetEntryDataSource.loadNextEventEntry(store: store, now: now)

    XCTAssertNil(entry.title)
  }
}
