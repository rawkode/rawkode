// WorkoutCapture.swift
// EnchiridionWatchKit
//
// P6 "watchOS workout capture" task (plan §Platform parity). The actual
// persistence logic: turns a completed `WorkoutRecord` into a brand-new
// `dev.rawkode.enchiridion.workouts.workout` page, via the SAME real
// local-write path task #78's editor/#77's share capture are built on
// (`PageDocument.create`/`setProperties` — `EnchiridionSync/PageDocument.swift`
// — plus `PageDocument.setProperties(_:ensuring:in:)`'s exact call shape,
// mirrored from `EnchiridionSync/AssistantTaskMutationApplier.swift`'s
// `applyCreate`), then persists it via `LocalGraphStore.saveDocumentSnapshot`
// + `writeProjection` — the identical pair `EnchiridionShareKit/ShareCapture.swift`
// calls (task #78's "durably persist the raw CRDT snapshot, not just its
// derived projection" fix, reused here verbatim, not reinvented).
//
// WHERE THIS STORE LIVES (task #79's investigation #2 — watch/phone data
// sharing is NOT the same mechanism as the widget/share-extension App
// Group case): a watchOS app runs on a physically separate device from
// its iPhone companion — there is no shared filesystem container between
// them the way `LocalGraphStoreLocation.openAppGroupStore()` gives an
// app and its own in-process extension. `WorkoutCapture.capture` below
// takes a `LocalGraphStore` as a parameter (same shape as
// `ShareCapture.capture`) rather than opening one itself, so this file
// stays store-location-agnostic; the watch app's actual production call
// site (`Sources/watchOS/WorkoutCaptureRootView.swift`) opens the watch's
// OWN local store via `LocalGraphStore.openWatchLocalStore()`
// (`WatchLocalStoreLocation.swift`, this same target) — a private,
// on-device-only SQLite file under the watch app's own Application
// Support directory, NOT the phone's App-Group-shared store (which a
// watchOS process cannot see at all). Reconciling a workout page created
// here with the phone's own graph is the (still-unwired, tracked
// separately) `VaultSyncClient` sync path's job once that exists — out of
// this task's scope; see this package's plan §Platform parity for the
// explicit deferral.

import EnchiridionCore
import EnchiridionSchema
import EnchiridionStore
import EnchiridionSync
import Foundation

public enum WorkoutCaptureError: Error, LocalizedError, Equatable, Sendable {
  case invalidDuration

  public var errorDescription: String? {
    switch self {
    case .invalidDuration:
      "A workout's duration must be greater than zero minutes."
    }
  }
}

public enum WorkoutCapture {
  /// Builds a new `.free` page carrying the `dev.rawkode.enchiridion.workouts.workout`
  /// supertag with `activity`/`duration-minutes`/`started-at` set (and
  /// `calories` if `record.calories` is non-nil), and persists it into
  /// `store` — both the raw CRDT snapshot (`saveDocumentSnapshot`) and its
  /// derived projection (`writeProjection`), exactly as
  /// `ShareCapture.capture` does for its own new pages.
  ///
  /// `pageID` defaults to a fresh random `PageID.free()` — a completed
  /// workout has no stable external key the way a calendar day or a
  /// person's email does (same reasoning `ShareCapture.capture`'s own doc
  /// comment gives for shares). Exposed as a parameter purely so tests can
  /// assert against a known ID.
  @discardableResult
  public static func capture(
    _ record: WorkoutRecord,
    into store: LocalGraphStore,
    pageID: PageID = .free(),
    createdAt: Date = Date()
  ) async throws -> PageID {
    guard record.durationMinutes > 0 else { throw WorkoutCaptureError.invalidDuration }

    let created = try PageDocument.create(
      id: pageID, kind: .free, title: title(for: record), createdAt: createdAt)

    var updates: [SupertagPropertyKey: [SupertagValue]] = [
      SupertagPropertyKey(
        supertagID: WorkoutsWorkoutFieldIDs.supertagID, fieldID: WorkoutsWorkoutFieldIDs.activity
      ): [.select(record.activity.rawValue)],
      SupertagPropertyKey(
        supertagID: WorkoutsWorkoutFieldIDs.supertagID,
        fieldID: WorkoutsWorkoutFieldIDs.durationMinutes
      ): [.number(record.durationMinutes)],
      SupertagPropertyKey(
        supertagID: WorkoutsWorkoutFieldIDs.supertagID, fieldID: WorkoutsWorkoutFieldIDs.startedAt
      ): [.dateTime(record.startedAt)],
    ]
    if let calories = record.calories {
      updates[
        SupertagPropertyKey(
          supertagID: WorkoutsWorkoutFieldIDs.supertagID, fieldID: WorkoutsWorkoutFieldIDs.calories)
      ] = [.number(calories)]
    }

    let result = try PageDocument.setProperties(
      updates, ensuring: WorkoutsWorkoutFieldIDs.supertagID, in: created.document)

    try await store.saveDocumentSnapshot(pageID: pageID, snapshot: result.document, version: result.version)
    try await store.writeProjection(
      pageID: pageID, kind: .free, createdAt: createdAt, modifiedAt: createdAt, projection: result.projection)

    return pageID
  }

  /// e.g. "Run — 6 Aug 2026 at 07:32". `DateFormatter` (not
  /// `Date.formatted()`) so this stays usable pre-iOS 15/watchOS 8 API
  /// availability concerns — matches this codebase's own convention of
  /// not assuming the newest formatting API is always available (see
  /// `PageDocument.swift`'s `enchiridionISO8601` for the same caution).
  static func title(for record: WorkoutRecord) -> String {
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return "\(record.activity.displayName) — \(formatter.string(from: record.startedAt))"
  }
}
