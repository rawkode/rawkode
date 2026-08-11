// TaskWriteService.swift
// EnchiridionUI
//
// Task #82. The task list/kanban screens' ONLY write path — a kanban
// column move and a list-view completion toggle both go through here,
// which performs the exact same real, CRDT-snapshot-persisting sequence
// `PageEditorController.flush()` (this target) and
// `EnchiridionSync.AssistantTaskMutationApplier.apply(...)` (P5's
// assistant write path) already use to commit a change:
//
//   1. `PageDocument.setProperties(...)` — mutates the page's CRDT
//      document, returning a new snapshot/version/projection.
//   2. `LocalGraphStore.saveDocumentSnapshotIfCurrentVersion(...)` —
//      compare-and-swap persist of the new CRDT snapshot (task #78's
//      durable-local-document table, `_local_page_snapshots`) — see (*)
//      below.
//   3. `LocalGraphStore.writeProjection(...)` — persists the derived
//      read-side projection (`graph_nodes`/`graph_facts`/...) this
//      package's `fetchAllTasks()` (TaskBrowserQuery.swift) itself queries.
//
// Both (2) and (3) always run together — never just the projection. A
// write that only updated (3) would make a kanban move LOOK persisted
// (the board would show the card in its new column after a reload) while
// silently leaving the underlying CRDT document unchanged, which is
// exactly the class of bug task #78 closed for the page editor; this
// service does not reintroduce it for the task board.
//
// (*) TASK #90 — CONCURRENT WRITE SAFETY: step 1 reads a base snapshot,
// then this function's own `await` back into step 2 is a real suspension
// point another `applyTaskPropertyUpdates` call for the SAME `pageID` can
// land in (e.g. a completion-toggle tap immediately followed by a kanban
// drag on the same still-visually-stale card, each firing its own bare
// `Task { ... }` from the UI). Step 2 is therefore a compare-and-swap,
// not a plain upsert: it only persists if the store's current version
// still matches the version step 1 read, and reports back whether it
// won. The loser throws `.staleVersion` before step 3 ever runs, rather
// than silently overwriting the winner's change with a snapshot computed
// from the same stale base. This mirrors
// `AssistantTaskMutationApplier.requireCurrentVersion`'s stale-version
// stance, but as a real atomic actor-level CAS rather than an in-memory
// check — see `LocalGraphStore.saveDocumentSnapshotIfCurrentVersion`'s
// doc comment for why an in-memory check alone (mirroring
// `requireCurrentVersion` exactly) would NOT close this particular race:
// `documentSnapshot(for:)`/`saveDocumentSnapshot` are two separate actor
// entry points, so the TOCTOU window spans an actor suspension no matter
// where the check itself is performed — only checking and writing inside
// one `database.write` transaction actually closes it.
//
// NOT using `AssistantTaskMutationProposal`/`AssistantTaskMutationApplier`
// directly: that machinery exists to satisfy P5's "a write's proposer must
// never also be able to confirm it" rule for MODEL-authored writes (an
// assistant tool call records a proposal; a separate, explicit in-app
// confirm action applies it). A user dragging a card or tapping a checkbox
// in this UI IS the human confirmation — there is no model in the loop to
// guard against here, so gating a direct user action behind a
// propose/confirm ledger would add ceremony with no safety benefit. This
// service calls the same underlying `PageDocument`/`LocalGraphStore`
// primitives `AssistantTaskMutationApplier` calls, just without the
// proposal-ledger layer built for a different threat model.

import EnchiridionCore
import EnchiridionSchema
import EnchiridionStore
import EnchiridionSync
import Foundation

public enum TaskWriteServiceError: Error, LocalizedError, Equatable, Sendable {
  /// No persisted CRDT snapshot (or no `graph_nodes` row) exists for the
  /// given page — it doesn't exist locally, or hasn't synced yet. Never
  /// treated as "create a new page instead," matching
  /// `AssistantTaskMutationApplyError.missingExistingSnapshot`'s identical
  /// stance.
  case pageNotFound
  /// Task-supertagged pages in this codebase are always `.free` pages —
  /// nothing materializes the task supertag onto a daily/calendar page.
  /// Guarded explicitly rather than silently guessed, since
  /// `writeProjection`'s `kind` parameter has no way to reconstruct a
  /// non-`.free` `PageKind`'s associated identity from the bare storage
  /// string `LocalGraphNodeRow.kind` carries.
  case unsupportedPageKind(String)
  /// The page's persisted CRDT snapshot changed between this write's read
  /// and its persist — i.e. another `applyTaskPropertyUpdates` call for
  /// the SAME page landed first (see
  /// `LocalGraphStore.saveDocumentSnapshotIfCurrentVersion`'s doc comment
  /// for the exact race this closes). Mirrors
  /// `AssistantTaskMutationApplyError.staleVersion`'s identical stance: a
  /// caller sees a real conflict and can retry against the latest state,
  /// never a silent clobber of the other write.
  case staleVersion
  case documentError(String)

  public var errorDescription: String? {
    switch self {
    case .pageNotFound:
      "This task could not be found."
    case .unsupportedPageKind(let kind):
      "This task's page kind (\(kind)) isn't supported by the task board."
    case .staleVersion:
      "This task changed elsewhere while this edit was being saved. Please try again."
    case .documentError(let message):
      "The task edit could not be applied: \(message)"
    }
  }
}

public enum TaskWriteService {
  /// The shared real write path — see this file's header. Every other
  /// method below is a thin caller of this one.
  public static func applyTaskPropertyUpdates(
    _ updates: [SupertagPropertyKey: [SupertagValue]],
    to pageID: PageID,
    in store: LocalGraphStore,
    now: Date = Date()
  ) async throws -> PageDocumentProjection {
    guard let snapshotRecord = try await store.documentSnapshot(for: pageID) else {
      throw TaskWriteServiceError.pageNotFound
    }
    guard let node = try await store.node(for: pageID) else {
      throw TaskWriteServiceError.pageNotFound
    }
    guard node.kind == "free" else {
      throw TaskWriteServiceError.unsupportedPageKind(node.kind)
    }
    do {
      let result = try PageDocument.setProperties(
        updates, ensuring: CoreTaskFieldIDs.supertagID, in: snapshotRecord.snapshot)
      // Compare-and-swap, not a plain upsert: guards against two
      // concurrent `applyTaskPropertyUpdates` calls for this same
      // `pageID` (e.g. a completion-toggle tap immediately followed by a
      // kanban drag on the same still-stale card) each computing a new
      // snapshot from the same base and one silently clobbering the
      // other's change. See
      // `LocalGraphStore.saveDocumentSnapshotIfCurrentVersion`'s doc
      // comment for why this must be a single atomic actor call rather
      // than a version check performed here before re-entering the actor.
      let saved = try await store.saveDocumentSnapshotIfCurrentVersion(
        pageID: pageID, expectedVersion: snapshotRecord.version, snapshot: result.document,
        version: result.version, updatedAt: now)
      guard saved else { throw TaskWriteServiceError.staleVersion }
      try await store.writeProjection(
        pageID: pageID, kind: .free, createdAt: node.createdAt, modifiedAt: now,
        projection: result.projection)
      return result.projection
    } catch let error as PageDocumentError {
      throw TaskWriteServiceError.documentError(error.localizedDescription)
    }
  }

  /// List-view "mark complete" checkbox — a genuine toggle: an active task
  /// becomes `.done` (with `completedAt = now`); an already-finished task
  /// (`.done`/`.cancelled`) goes back to `.toDo` (clearing `completedAt`).
  @discardableResult
  public static func toggleCompletion(
    for item: TaskListItem, in store: LocalGraphStore, now: Date = Date()
  ) async throws -> PageDocumentProjection {
    let statusKey = SupertagPropertyKey(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.status)
    let completedAtKey = SupertagPropertyKey(
      supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.completedAt)
    let updates: [SupertagPropertyKey: [SupertagValue]]
    if item.isActive {
      updates = [statusKey: [.select(CoreTaskStatus.done.rawValue)], completedAtKey: [.dateTime(now)]]
    } else {
      updates = [statusKey: [.select(CoreTaskStatus.toDo.rawValue)], completedAtKey: []]
    }
    return try await applyTaskPropertyUpdates(updates, to: item.pageID, in: store, now: now)
  }

  /// Kanban drag-and-drop move — writes `column.propertyUpdates(...)`
  /// (TaskBrowserModels.swift) for `pageID`. `currentStatus` is the task's
  /// status BEFORE the move (needed only to decide whether moving out of
  /// `.done` must also reset `status`/`completedAt` — see
  /// `TaskBoardColumn.propertyUpdates`'s doc comment).
  @discardableResult
  public static func move(
    _ pageID: PageID,
    currentStatus: CoreTaskStatus?,
    to column: TaskBoardColumn,
    in store: LocalGraphStore,
    now: Date = Date(),
    calendar: Calendar = .current
  ) async throws -> PageDocumentProjection {
    let updates = column.propertyUpdates(now: now, calendar: calendar, currentStatus: currentStatus)
    return try await applyTaskPropertyUpdates(updates, to: pageID, in: store, now: now)
  }
}
