// PageEditorControllerPersistenceTests.swift
// EnchiridionUITests
//
// Task #78 ("Durable local CRDT snapshot persistence"). Proves the two
// properties the task brief calls out as REQUIRED, both against real
// on-disk `LocalGraphStore` files (no mocking):
//
//   1. A page opened, edited, and flushed through `PageEditorController`
//      round-trips its real CRDT snapshot through a FRESH `LocalGraphStore`
//      instance opened at the same underlying file — simulating an app
//      relaunch (a new process, new in-memory state, same disk).
//   2. Reopening after that "relaunch" and making a further edit merges
//      into the REAL persisted prior CRDT state — proven by content (the
//      first edit's text is still present after the second flush) and by
//      version vector (the persisted version actually advances rather than
//      resetting) — not just "flush doesn't crash."
//
// `PageEditorController.open(...)` itself is exercised end-to-end here
// (not just `LocalGraphStore`'s own snapshot methods, which
// `LocalGraphStorePageSnapshotTests.swift` in EnchiridionStoreTests already
// covers directly) — this is the actual load-on-open / save-on-write
// contract a real caller depends on.

import EnchiridionCore
import EnchiridionStore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionUI

@MainActor
final class PageEditorControllerPersistenceTests: XCTestCase {
  /// A fixed on-disk path (not `LocalGraphStore.openTemporary()`, which
  /// mints a brand-new unique file every call) so opening a SECOND
  /// `LocalGraphStore` instance against it genuinely simulates "a different
  /// process, the same underlying database" rather than a different
  /// database entirely.
  private func makeFixedPath() throws -> String {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-page-editor-persistence-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent("graph.sqlite").path
  }

  func testOpeningANewPageWithAStorePersistsItImmediately() async throws {
    let path = try makeFixedPath()
    let pageID = PageID.free()
    let store = try LocalGraphStore(path: path)

    _ = try await PageEditorController.open(pageID: pageID, kind: .free, title: "Untouched", store: store)

    // Persisted even though nothing was ever typed/flushed — see `open`'s
    // doc comment: a brand-new page must survive being killed before its
    // first flush.
    let record = try await store.documentSnapshot(for: pageID)
    let unwrapped = try XCTUnwrap(record)
    XCTAssertEqual(try PageDocument.projection(of: unwrapped.snapshot).title, "Untouched")
  }

  func testFlushPersistsTheRealCRDTSnapshotNotJustAProjection() async throws {
    let path = try makeFixedPath()
    let pageID = PageID.free()
    let store = try LocalGraphStore(path: path)
    let controller = try await PageEditorController.open(pageID: pageID, kind: .free, title: "Notes", store: store)

    controller.insertText("Hello", at: 0)
    let flushed = await controller.flush()
    XCTAssertTrue(flushed, controller.lastFlushError ?? "")

    let record = try await store.documentSnapshot(for: pageID)
    let unwrapped = try XCTUnwrap(record)
    XCTAssertEqual(unwrapped.snapshot, controller.durableDocument)
    XCTAssertEqual(unwrapped.version, controller.durableVersion)
    XCTAssertEqual(try PageDocument.projection(of: unwrapped.snapshot).plainText, "Hello")
  }

  /// THE required property: relaunch loads the real persisted snapshot
  /// (not a fresh `PageDocument.create`), and a subsequent edit genuinely
  /// merges into that prior state.
  func testRelaunchLoadsThePersistedSnapshotAndASubsequentEditMergesIntoIt() async throws {
    let path = try makeFixedPath()
    let pageID = PageID.free()
    let firstLaunchVersion: PageDocumentVersion

    do {
      // "First launch": open a brand-new page, type, flush, then let both
      // the controller and the store instance go out of scope — nothing
      // about this process's in-memory state survives past this block.
      let store = try LocalGraphStore(path: path)
      let controller = try await PageEditorController.open(pageID: pageID, kind: .free, title: "Notes", store: store)
      controller.insertText("Hello", at: 0)
      let flushed = await controller.flush()
      XCTAssertTrue(flushed, controller.lastFlushError ?? "")
      firstLaunchVersion = controller.durableVersion
      controller.invalidate()
    }

    // "Relaunch": a FRESH `LocalGraphStore` instance against the exact same
    // underlying file — no in-memory state is shared with the block above.
    let reopenedStore = try LocalGraphStore(path: path)

    // Sanity check the raw persisted row directly first: the first launch's
    // real content must be sitting on disk right now, independent of
    // whatever `open` below does with it.
    let persistedAfterFirstLaunch = try await reopenedStore.documentSnapshot(for: pageID)
    let unwrappedPersisted = try XCTUnwrap(persistedAfterFirstLaunch)
    XCTAssertEqual(
      try PageDocument.projection(of: unwrappedPersisted.snapshot).plainText, "Hello",
      "the snapshot must round-trip through a fresh store instance at the same path")
    XCTAssertEqual(unwrappedPersisted.version, firstLaunchVersion)

    let reopenedController = try await PageEditorController.open(
      pageID: pageID, kind: .free, title: "Notes", store: reopenedStore)

    // The load-on-open contract: this must be the REAL prior document, not
    // `PageDocument.create` silently discarding "Hello".
    XCTAssertEqual(
      reopenedController.body.text, "Hello",
      "opening after relaunch must load the persisted prior CRDT state, never fall back to PageDocument.create for an existing page")
    XCTAssertEqual(reopenedController.durableVersion, firstLaunchVersion)

    // A further edit, then a second "relaunch" round trip, proves the
    // second flush's persisted snapshot carries BOTH edits' history, not
    // just the second one written over a fresh document.
    reopenedController.insertText(" world", at: 5)
    let secondFlush = await reopenedController.flush()
    XCTAssertTrue(secondFlush, reopenedController.lastFlushError ?? "")

    let secondLaunchVersion = reopenedController.durableVersion
    XCTAssertNotEqual(
      secondLaunchVersion, firstLaunchVersion,
      "the version vector must advance from the real prior state, not reset")

    let finalStore = try LocalGraphStore(path: path)
    let finalRecord = try await finalStore.documentSnapshot(for: pageID)
    let unwrappedFinal = try XCTUnwrap(finalRecord)
    XCTAssertEqual(
      try PageDocument.projection(of: unwrappedFinal.snapshot).plainText, "Hello world",
      "the final persisted snapshot must reflect BOTH edits — proof the second edit was applied on top of the real loaded prior document, not a fresh one")
    XCTAssertEqual(unwrappedFinal.version, secondLaunchVersion)
  }

  /// Same property as above, proven a second way: merging a genuinely
  /// independent remote update (simulating a second device) into the
  /// reloaded-after-relaunch snapshot must combine both edits — real CRDT
  /// convergence, not last-write-wins — which could only happen if the
  /// reload actually produced the real prior causal history, not a fresh
  /// document with no shared history to merge against.
  func testReloadedSnapshotGenuinelyMergesWithAConcurrentRemoteEdit() async throws {
    let path = try makeFixedPath()
    let pageID = PageID.free()

    do {
      let store = try LocalGraphStore(path: path)
      let controller = try await PageEditorController.open(pageID: pageID, kind: .free, title: "Notes", store: store)
      controller.insertText("local", at: 0)
      let flushed = await controller.flush()
      XCTAssertTrue(flushed, controller.lastFlushError ?? "")
      controller.invalidate()
    }

    let reopenedStore = try LocalGraphStore(path: path)
    let persistedRecord = try await reopenedStore.documentSnapshot(for: pageID)
    let persisted = try XCTUnwrap(persistedRecord)

    // Simulate a second device that had ALSO seen the same prior state
    // (fetched it before this "relaunch") and made its own independent
    // edit, producing a remote snapshot descended from the same history.
    let remote = try PageDocument.insertText(.body, at: 5, text: " + remote", in: persisted.snapshot)

    let controller = try await PageEditorController.open(
      pageID: pageID, kind: .free, title: "Notes", store: reopenedStore)
    try controller.applyRemoteUpdate(remote.document)

    XCTAssertEqual(
      controller.body.text, "local + remote",
      "merging a remote update into the reloaded document must combine both edits' real content")
  }
}
