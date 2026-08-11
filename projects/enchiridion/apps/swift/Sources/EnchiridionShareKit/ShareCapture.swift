// ShareCapture.swift
// EnchiridionShareKit
//
// The actual capture logic (task point 2): turns a `ShareCaptureInput`
// into a brand-new page, via the SAME real local-write path P1's page
// editor is built on (`PageDocument.create`/`insertText` —
// `EnchiridionSync/PageDocument.swift`, `EnchiridionUI/PageEditorController.swift`),
// then persists it into the App-Group-shared `LocalGraphStore`
// (`EnchiridionStore/LocalGraphStoreLocation.swift`'s
// `LocalGraphStore.openAppGroupStore()` — the P6 "Widgets" task's own
// opening pattern, reused verbatim here, not reinvented).
//
// TASK #78 UPDATE: the gap this comment used to describe — nothing in this
// package durably persisted a page's raw CRDT document bytes — is now
// fixed. `capture(_:into:...)` below calls `store.saveDocumentSnapshot`
// (`EnchiridionStore/LocalGraphStore.swift`, task #78) alongside
// `writeProjection`, so a captured share's underlying `PageDocument`
// snapshot survives a relaunch and can genuinely be merged into (via
// `PageDocument.merge`) by a future sync/reprojection consumer, not just
// its derived projection. See `LocalGraphStore.swift`'s "Design note"
// section for what remains out of scope (wiring `VaultSyncClient`'s
// `docUpdate`/`docFullSnapshot` frames into a reprojection loop) —
// unrelated to this local-capture path, which now persists its own write
// completely on its own.

import EnchiridionCore
import EnchiridionStore
import EnchiridionSync
import Foundation

public enum ShareCapture {
  /// Builds a new `.free` page from `input` (via `PageDocument.create` +
  /// one `insertText` into the body, exactly the calls
  /// `PageEditorController.create`/`insertText` make — see that file),
  /// derives its projection, and writes it into `store` via
  /// `LocalGraphStore.writeProjection` — the identical write call a future
  /// reprojection-from-sync pipeline will make for every other page (see
  /// `LocalGraphStore.swift`'s design note).
  ///
  /// `pageID` defaults to a fresh random `PageID.free()` — shares are the
  /// "most pages" random-ID case per `Identity.swift`'s own doc comment,
  /// not a deterministic identity (there is no stable external key for an
  /// arbitrary shared text selection the way there is for a calendar day
  /// or a person's email). Exposed as a parameter (not hardcoded) purely
  /// so tests can assert against a known ID.
  @discardableResult
  public static func capture(
    _ input: ShareCaptureInput,
    into store: LocalGraphStore,
    pageID: PageID = .free(),
    createdAt: Date = Date()
  ) async throws -> PageID {
    guard !input.isEmpty else { throw ShareCaptureError.emptyContent }

    let title = ShareCaptureBody.title(for: input)
    let body = ShareCaptureBody.body(for: input)

    let created = try PageDocument.create(id: pageID, kind: .free, title: title, createdAt: createdAt)
    var snapshot = created.document
    if !body.isEmpty {
      snapshot = try PageDocument.insertText(.body, at: 0, text: body, in: snapshot).document
    }
    let projection = try PageDocument.projection(of: snapshot)
    let version = try PageDocument.currentVersion(of: snapshot)

    // Task #78: persist the real CRDT snapshot, not just its derived
    // projection — see this file's header.
    try await store.saveDocumentSnapshot(pageID: pageID, snapshot: snapshot, version: version)
    try await store.writeProjection(
      pageID: pageID, kind: .free, createdAt: createdAt, modifiedAt: createdAt, projection: projection)

    return pageID
  }

  /// Convenience for the per-platform extension UIs
  /// (`Sources/iOSShareExtension`, `Sources/macOSShareExtension`): opens
  /// the App-Group-shared store (`LocalGraphStore.openAppGroupStore()`,
  /// the P6 "Widgets" task's own resolution path — same App Group
  /// identifier, same container, so a share captured here is immediately
  /// visible to the widgets and a future main-app read of the same store)
  /// and captures in one call. Production-only: tests call
  /// `capture(_:into:...)` directly against a real temporary store instead
  /// (`LocalGraphStore.openTemporary()`), so a missing/unentitled App
  /// Group in the test process (which cannot be granted one — see
  /// `LocalGraphStoreLocation.swift`'s header) never masks a real
  /// capture-logic bug behind a resolution failure.
  @discardableResult
  public static func captureIntoAppGroupStore(
    _ input: ShareCaptureInput,
    pageID: PageID = .free(),
    createdAt: Date = Date()
  ) async throws -> PageID {
    let store = try LocalGraphStore.openAppGroupStore()
    return try await capture(input, into: store, pageID: pageID, createdAt: createdAt)
  }
}
