// TaskWriteServiceTests.swift
// EnchiridionUITests
//
// Task #82. Proves `TaskWriteService`'s writes are REAL, not
// projection-only shortcuts — matching task #78's "relaunch" rigor
// (`PageEditorControllerPersistenceTests.swift`'s pattern): every
// persistence assertion below opens a FRESH `LocalGraphStore` instance
// against the same on-disk file after the write, simulating a genuine app
// relaunch, rather than only asserting against the same in-memory store
// instance that performed the write (which would not distinguish a real
// persisted write from an in-memory-only one).
//
// Required coverage per the task brief:
//   1. A kanban column move genuinely persists (CRDT snapshot AND
//      projection), reloadable from a fresh store instance.
//   2. A list-view completion toggle persists the same way.
//   3. Both round-trip through `PageDocument.setProperties`'s real merge
//      machinery, not a shortcut — proven by decoding the persisted CRDT
//      snapshot directly (`PageDocument.projection(of:)`), not just
//      reading back the derived projection table.

import EnchiridionCore
import EnchiridionSchema
import EnchiridionStore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionUI

final class TaskWriteServiceTests: XCTestCase {
  /// A fixed on-disk path (not `LocalGraphStore.openTemporary()`, which
  /// mints a new unique file every call) so a SECOND `LocalGraphStore`
  /// instance opened against it genuinely simulates a relaunch — same
  /// convention as `PageEditorControllerPersistenceTests.swift`.
  private func makeFixedPath() throws -> String {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-task-write-service-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent("graph.sqlite").path
  }

  /// Seeds a real task page through the same path a page editor would:
  /// `PageDocument.create` -> `setProperties` (Task supertag + initial
  /// field values) -> persist BOTH the CRDT snapshot and the projection.
  /// Returns the new page's ID.
  @discardableResult
  private func makeTaskPage(
    title: String, status: CoreTaskStatus, placement: CoreTaskPlacement?, store: LocalGraphStore,
    now: Date = Date()
  ) async throws -> PageID {
    let pageID = PageID.free()
    let created = try PageDocument.create(id: pageID, kind: .free, title: title, createdAt: now)
    var properties: [SupertagPropertyKey: [SupertagValue]] = [
      .init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.status): [.select(status.rawValue)]
    ]
    if let placement {
      properties[.init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.placement)] = [
        .select(placement.rawValue)
      ]
    }
    let tagged = try PageDocument.setProperties(
      properties, ensuring: CoreTaskFieldIDs.supertagID, in: created.document)
    try await store.saveDocumentSnapshot(pageID: pageID, snapshot: tagged.document, version: tagged.version)
    try await store.writeProjection(
      pageID: pageID, kind: .free, createdAt: now, modifiedAt: now, projection: tagged.projection)
    return pageID
  }

  // MARK: - Kanban move

  func testKanbanMoveGenuinelyPersistsAcrossAFreshStoreInstance() async throws {
    let path = try makeFixedPath()
    let pageID: PageID

    do {
      let store = try LocalGraphStore(path: path)
      pageID = try await makeTaskPage(title: "Plan trip", status: .toDo, placement: .inbox, store: store)

      _ = try await TaskWriteService.move(pageID, currentStatus: .toDo, to: .someday, in: store)
    }

    // "Relaunch": a fresh store instance against the same file.
    let reopened = try LocalGraphStore(path: path)

    let record = try await reopened.documentSnapshot(for: pageID)
    let unwrapped = try XCTUnwrap(record, "the moved task's CRDT snapshot must be persisted, not held only in memory")
    let projection = try PageDocument.projection(of: unwrapped.snapshot)
    let placementKey = SupertagPropertyKey(
      supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.placement)
    XCTAssertEqual(
      projection.objectMetadata.properties[placementKey], [.select(CoreTaskPlacement.someday.rawValue)],
      "the real persisted CRDT document must reflect the move, decoded independently of the projection table")

    let tasksAfterReload = try reopened.fetchAllTasks()
    let moved = try XCTUnwrap(tasksAfterReload.first { $0.pageID == pageID })
    XCTAssertEqual(moved.placement, .someday)
    let today = Calendar.current.startOfDay(for: Date())
    XCTAssertEqual(
      TaskBoardColumn.assigned(to: moved, today: today, calendar: .current), .someday,
      "a fresh store instance's own read query must place the task in its new column")
  }

  func testKanbanMoveIntoTodaySetsScheduledAndPersists() async throws {
    let path = try makeFixedPath()
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let calendar = Calendar(identifier: .gregorian)
    let pageID: PageID

    do {
      let store = try LocalGraphStore(path: path)
      pageID = try await makeTaskPage(title: "Call dentist", status: .toDo, placement: .anytime, store: store)
      _ = try await TaskWriteService.move(
        pageID, currentStatus: .toDo, to: .today, in: store, now: now, calendar: calendar)
    }

    let reopened = try LocalGraphStore(path: path)
    let record = try await reopened.documentSnapshot(for: pageID)
    let unwrapped = try XCTUnwrap(record)
    let projection = try PageDocument.projection(of: unwrapped.snapshot)
    let scheduledKey = SupertagPropertyKey(
      supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.scheduled)
    XCTAssertEqual(
      projection.objectMetadata.properties[scheduledKey], [.dateTime(calendar.startOfDay(for: now))])
  }

  func testKanbanMoveOutOfDoneResetsStatusAndPersists() async throws {
    let path = try makeFixedPath()
    let pageID: PageID

    do {
      let store = try LocalGraphStore(path: path)
      pageID = try await makeTaskPage(title: "Ship release", status: .done, placement: .inbox, store: store)
      _ = try await TaskWriteService.move(pageID, currentStatus: .done, to: .anytime, in: store)
    }

    let reopened = try LocalGraphStore(path: path)
    let tasksAfterReload = try reopened.fetchAllTasks()
    let moved = try XCTUnwrap(tasksAfterReload.first { $0.pageID == pageID })
    XCTAssertEqual(moved.status, .toDo, "moving a finished task to a non-Done column must persist a reset status")
    XCTAssertNil(moved.completedAt)
  }

  // MARK: - List completion toggle

  func testListCompletionToggleGenuinelyPersistsAcrossAFreshStoreInstance() async throws {
    let path = try makeFixedPath()
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let pageID: PageID

    do {
      let store = try LocalGraphStore(path: path)
      pageID = try await makeTaskPage(title: "Renew passport", status: .toDo, placement: .inbox, store: store)
      let item = TaskListItem(
        pageID: pageID, title: "Renew passport", status: .toDo, placement: .inbox, priority: nil,
        scheduledAt: nil, deadlineAt: nil, dueAt: nil, completedAt: nil, modifiedAt: nil)

      _ = try await TaskWriteService.toggleCompletion(for: item, in: store, now: now)
    }

    let reopened = try LocalGraphStore(path: path)
    let record = try await reopened.documentSnapshot(for: pageID)
    let unwrapped = try XCTUnwrap(record)
    let projection = try PageDocument.projection(of: unwrapped.snapshot)
    let statusKey = SupertagPropertyKey(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.status)
    let completedAtKey = SupertagPropertyKey(
      supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.completedAt)
    XCTAssertEqual(
      projection.objectMetadata.properties[statusKey], [.select(CoreTaskStatus.done.rawValue)],
      "the real persisted CRDT document must reflect the completion, decoded independently of the projection table")
    XCTAssertEqual(projection.objectMetadata.properties[completedAtKey], [.dateTime(now)])

    let tasksAfterReload = try reopened.fetchAllTasks()
    let toggled = try XCTUnwrap(tasksAfterReload.first { $0.pageID == pageID })
    XCTAssertFalse(toggled.isActive)
    let today = Calendar.current.startOfDay(for: now)
    XCTAssertEqual(TaskBoardColumn.assigned(to: toggled, today: today, calendar: .current), .done)
  }

  func testTogglingAnAlreadyCompletedTaskReopensItAndPersists() async throws {
    let path = try makeFixedPath()
    let pageID: PageID

    do {
      let store = try LocalGraphStore(path: path)
      pageID = try await makeTaskPage(title: "Old task", status: .done, placement: .inbox, store: store)
      let item = TaskListItem(
        pageID: pageID, title: "Old task", status: .done, placement: .inbox, priority: nil,
        scheduledAt: nil, deadlineAt: nil, dueAt: nil, completedAt: Date(), modifiedAt: nil)

      _ = try await TaskWriteService.toggleCompletion(for: item, in: store)
    }

    let reopened = try LocalGraphStore(path: path)
    let tasksAfterReload = try reopened.fetchAllTasks()
    let toggled = try XCTUnwrap(tasksAfterReload.first { $0.pageID == pageID })
    XCTAssertEqual(toggled.status, .toDo)
    XCTAssertNil(toggled.completedAt)
    XCTAssertTrue(toggled.isActive)
  }

  // MARK: - Concurrent writes (task #90)

  /// `static` (not an instance method) so `async let`'s two racing calls
  /// below don't implicitly capture `self` (a non-`Sendable` `XCTestCase`)
  /// — the compiler's strict-concurrency check for "sending `self` into
  /// async let" otherwise rejects the call.
  private static func attemptApply(
    _ updates: [SupertagPropertyKey: [SupertagValue]], to pageID: PageID, in store: LocalGraphStore
  ) async -> Result<PageDocumentProjection, Error> {
    do {
      return .success(try await TaskWriteService.applyTaskPropertyUpdates(updates, to: pageID, in: store))
    } catch {
      return .failure(error)
    }
  }

  /// Two REAL, concurrently-executing `applyTaskPropertyUpdates` calls for
  /// the SAME page (different property changes each) — genuinely raced via
  /// `async let`, not called sequentially. Each call independently reads
  /// the page's snapshot (`store.documentSnapshot`), computes its own full
  /// new snapshot off-actor (`PageDocument.setProperties`), then re-enters
  /// the actor to persist — exactly the "two separate actor entry points
  /// with a real suspension in between" shape that let one call silently
  /// clobber the other before this fix (see `TaskWriteService.swift`'s
  /// header, "(*) TASK #90"). Because both child tasks are launched
  /// together and each does non-trivial off-actor CRDT work between its
  /// read and its write, the second call's read reliably lands before the
  /// first call's write — a genuine interleaving, not a manufactured one.
  ///
  /// Asserts exactly one call wins (persists) and the other throws
  /// `TaskWriteServiceError.staleVersion` — never both silently
  /// succeeding with one clobbering the other, and never the loser's error
  /// going uncaught. Also proves the loser's change isn't lost forever: a
  /// retry against the now-current version applies cleanly, and the final
  /// document carries BOTH changes.
  func testConcurrentApplyTaskPropertyUpdatesForSamePageDoesNotSilentlyLoseAWrite() async throws {
    let store = try LocalGraphStore.openTemporary()
    let pageID = try await makeTaskPage(title: "Race me", status: .toDo, placement: .inbox, store: store)

    let priorityKey = SupertagPropertyKey(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.priority)
    let notesKey = SupertagPropertyKey(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.notes)

    async let firstOutcome = Self.attemptApply([priorityKey: [.select("urgent")]], to: pageID, in: store)
    async let secondOutcome = Self.attemptApply([notesKey: [.text("racing note")]], to: pageID, in: store)
    let outcomes = await [firstOutcome, secondOutcome]

    let successCount = outcomes.filter { if case .success = $0 { return true }; return false }.count
    let failures: [TaskWriteServiceError] = outcomes.compactMap {
      if case .failure(let error) = $0 { return error as? TaskWriteServiceError }
      return nil
    }

    XCTAssertEqual(successCount, 1, "exactly one of the two concurrent writes for the same page must win")
    XCTAssertEqual(
      failures, [.staleVersion],
      "the losing concurrent write must surface a real, catchable staleVersion error — not silently vanish")

    // The winner's change must have actually landed, and ONLY the
    // winner's — the loser never reached `writeProjection`, so no mixed
    // or partially-applied state either.
    let record = try await store.documentSnapshot(for: pageID)
    let persisted = try PageDocument.projection(of: try XCTUnwrap(record).snapshot)
    let hasPriority = persisted.objectMetadata.properties[priorityKey] == [.select("urgent")]
    let hasNotes = persisted.objectMetadata.properties[notesKey] == [.text("racing note")]
    XCTAssertTrue(
      hasPriority != hasNotes,
      """
      exactly one property change should be visible in the persisted document right after the race — \
      both present would mean no real race occurred (or the loser's data was merged in unsafely), \
      neither present would mean a write vanished
      """
    )

    // The loser's change is not lost forever: retrying against the now-
    // current version applies it cleanly, and both changes end up
    // persisted.
    let retriedUpdates: [SupertagPropertyKey: [SupertagValue]] =
      hasPriority ? [notesKey: [.text("racing note")]] : [priorityKey: [.select("urgent")]]
    _ = try await TaskWriteService.applyTaskPropertyUpdates(retriedUpdates, to: pageID, in: store)

    let reRecord = try await store.documentSnapshot(for: pageID)
    let reprojected = try PageDocument.projection(of: try XCTUnwrap(reRecord).snapshot)
    XCTAssertEqual(reprojected.objectMetadata.properties[priorityKey], [.select("urgent")])
    XCTAssertEqual(reprojected.objectMetadata.properties[notesKey], [.text("racing note")])
  }

  // MARK: - Error paths

  func testApplyTaskPropertyUpdatesThrowsPageNotFoundForAnUnknownPage() async throws {
    let store = try LocalGraphStore.openTemporary()
    let unknownPageID = PageID.free()

    do {
      _ = try await TaskWriteService.applyTaskPropertyUpdates([:], to: unknownPageID, in: store)
      XCTFail("expected pageNotFound")
    } catch let error as TaskWriteServiceError {
      XCTAssertEqual(error, .pageNotFound)
    }
  }
}
