// LocalGraphStorePageSnapshotTests.swift
// EnchiridionStoreTests
//
// Task #78 ("Durable local CRDT snapshot persistence"). Covers
// `LocalGraphStore.saveDocumentSnapshot`/`documentSnapshot(for:)`/
// `removeProjection`'s new snapshot purge directly, against a REAL
// `LocalGraphStore` (no mocking — same convention every other test in this
// target already uses). `LocalGraphStorePageSnapshotRelaunchTests.swift`
// (this target) covers the "survives a real relaunch, merges into prior
// state" property against a fixed on-disk path; this file covers the
// store's own API contract in isolation.

import EnchiridionCore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionStore

final class LocalGraphStorePageSnapshotTests: XCTestCase {
  private func makeStore() throws -> LocalGraphStore {
    try LocalGraphStore.openTemporary()
  }

  func testDocumentSnapshotIsNilWhenNoneHasBeenSaved() async throws {
    let store = try makeStore()
    let record = try await store.documentSnapshot(for: .free())
    XCTAssertNil(record)
  }

  func testSaveDocumentSnapshotRoundTripsBytesAndVersion() async throws {
    let store = try makeStore()
    let pageID = PageID.free()
    let created = try PageDocument.create(id: pageID, kind: .free, title: "Notes")
    let version = try PageDocument.currentVersion(of: created.document)

    try await store.saveDocumentSnapshot(pageID: pageID, snapshot: created.document, version: version)

    let record = try await store.documentSnapshot(for: pageID)
    let unwrapped = try XCTUnwrap(record)
    XCTAssertEqual(unwrapped.pageID, pageID)
    XCTAssertEqual(unwrapped.snapshot, created.document)
    XCTAssertEqual(unwrapped.version, version)
    // The loaded snapshot must decode into the same real document — not
    // merely byte-equal, but genuinely a valid, readable PageDocument.
    XCTAssertEqual(try PageDocument.projection(of: unwrapped.snapshot).title, "Notes")
  }

  func testSaveDocumentSnapshotUpsertsRatherThanAccumulates() async throws {
    let store = try makeStore()
    let pageID = PageID.free()
    let created = try PageDocument.create(id: pageID, kind: .free, title: "First")
    try await store.saveDocumentSnapshot(
      pageID: pageID, snapshot: created.document, version: try PageDocument.currentVersion(of: created.document))

    let edited = try PageDocument.insertText(.body, at: 0, text: "edited", in: created.document)
    try await store.saveDocumentSnapshot(pageID: pageID, snapshot: edited.document, version: edited.version)

    let record = try await store.documentSnapshot(for: pageID)
    let unwrapped = try XCTUnwrap(record)
    XCTAssertEqual(unwrapped.snapshot, edited.document)
    XCTAssertEqual(try PageDocument.projection(of: unwrapped.snapshot).plainText, "edited")
  }

  func testSaveDocumentSnapshotPublishesItsCommittedLocalChange() async throws {
    let store = try makeStore()
    let pageID = PageID.free()
    let created = try PageDocument.create(id: pageID, kind: .free, title: "Sync me")
    let stream = await store.documentSnapshotChanges()
    var changes = stream.makeAsyncIterator()

    try await store.saveDocumentSnapshot(
      pageID: pageID, snapshot: created.document, version: created.version)

    let nextChange = await changes.next()
    let change = try XCTUnwrap(nextChange)
    XCTAssertEqual(change.pageID, pageID)
    XCTAssertEqual(change.snapshot, created.document)
    XCTAssertEqual(change.version, created.version)
    XCTAssertEqual(change.origin, .local)
  }

  func testDocumentSnapshotChangesBroadcastToMultipleSubscribers() async throws {
    let store = try makeStore()
    let pageID = PageID.free()
    let created = try PageDocument.create(id: pageID, kind: .free, title: "Both subscribers")
    let firstStream = await store.documentSnapshotChanges()
    let secondStream = await store.documentSnapshotChanges()
    var firstChanges = firstStream.makeAsyncIterator()
    var secondChanges = secondStream.makeAsyncIterator()

    try await store.saveDocumentSnapshot(
      pageID: pageID, snapshot: created.document, version: created.version)

    let firstNext = await firstChanges.next()
    let secondNext = await secondChanges.next()
    let firstChange = try XCTUnwrap(firstNext)
    let secondChange = try XCTUnwrap(secondNext)
    XCTAssertEqual(firstChange.snapshot, created.document)
    XCTAssertEqual(secondChange.snapshot, created.document)
  }

  // MARK: - Compare-and-swap persist (task #90)

  func testSaveDocumentSnapshotIfCurrentVersionSucceedsWhenVersionMatches() async throws {
    let store = try makeStore()
    let pageID = PageID.free()
    let created = try PageDocument.create(id: pageID, kind: .free, title: "First")
    let baseVersion = try PageDocument.currentVersion(of: created.document)
    try await store.saveDocumentSnapshot(pageID: pageID, snapshot: created.document, version: baseVersion)

    let edited = try PageDocument.insertText(.body, at: 0, text: "edited", in: created.document)
    let succeeded = try await store.saveDocumentSnapshotIfCurrentVersion(
      pageID: pageID, expectedVersion: baseVersion, snapshot: edited.document, version: edited.version)

    XCTAssertTrue(succeeded)
    let record = try await store.documentSnapshot(for: pageID)
    XCTAssertEqual(try XCTUnwrap(record).snapshot, edited.document)
  }

  func testSaveDocumentSnapshotIfCurrentVersionFailsAndDoesNotWriteWhenVersionIsStale() async throws {
    let store = try makeStore()
    let pageID = PageID.free()
    let created = try PageDocument.create(id: pageID, kind: .free, title: "First")
    let baseVersion = try PageDocument.currentVersion(of: created.document)
    try await store.saveDocumentSnapshot(pageID: pageID, snapshot: created.document, version: baseVersion)

    // Someone else's write lands first, moving the store's current version.
    let intervening = try PageDocument.insertText(.body, at: 0, text: "intervening", in: created.document)
    try await store.saveDocumentSnapshot(pageID: pageID, snapshot: intervening.document, version: intervening.version)

    // A late writer that computed its change from the ORIGINAL (now stale)
    // base attempts to persist against the version it read, not the
    // current one.
    let stale = try PageDocument.insertText(.title, at: 0, text: "late-", in: created.document)
    let succeeded = try await store.saveDocumentSnapshotIfCurrentVersion(
      pageID: pageID, expectedVersion: baseVersion, snapshot: stale.document, version: stale.version)

    XCTAssertFalse(succeeded, "a CAS write against a stale expected version must not succeed")
    let record = try await store.documentSnapshot(for: pageID)
    XCTAssertEqual(
      try XCTUnwrap(record).snapshot, intervening.document,
      "a failed CAS must leave the intervening writer's snapshot completely untouched — not partially overwritten"
    )
  }

  /// Deterministically proves the CAS is atomic under REAL concurrent
  /// execution: both racing calls share the exact same `expectedVersion`
  /// (constructed to guarantee a genuine conflict, unlike the
  /// timing-dependent race one level up in `TaskWriteServiceTests`), then
  /// are fired via a `TaskGroup` so they genuinely race for the actor.
  /// Because `LocalGraphStore` is an actor, the two calls' bodies cannot
  /// literally execute simultaneously — but that is exactly what closes
  /// the real-world race (see `LocalGraphStore.
  /// saveDocumentSnapshotIfCurrentVersion`'s doc comment): regardless of
  /// which one the actor's executor happens to run first, exactly one
  /// must observe the version still matching and win, and the other must
  /// observe it already moved and lose — never both winning (silently
  /// corrupting the store with a mixed/overwritten result) and never both
  /// losing (a legitimate write vanishing for no reason).
  func testSaveDocumentSnapshotIfCurrentVersionUnderRealConcurrencyExactlyOneWinner() async throws {
    let store = try makeStore()
    let pageID = PageID.free()
    let created = try PageDocument.create(id: pageID, kind: .free, title: "Race")
    let baseVersion = try PageDocument.currentVersion(of: created.document)
    try await store.saveDocumentSnapshot(pageID: pageID, snapshot: created.document, version: baseVersion)

    let candidateA = try PageDocument.insertText(.title, at: 0, text: "A-", in: created.document)
    let candidateB = try PageDocument.insertText(.title, at: 0, text: "B-", in: created.document)
    let candidateADocument = candidateA.document
    let candidateAVersion = candidateA.version
    let candidateBDocument = candidateB.document
    let candidateBVersion = candidateB.version

    let results = await withTaskGroup(of: Bool.self) { group in
      group.addTask {
        (try? await store.saveDocumentSnapshotIfCurrentVersion(
          pageID: pageID, expectedVersion: baseVersion, snapshot: candidateADocument, version: candidateAVersion))
          ?? false
      }
      group.addTask {
        (try? await store.saveDocumentSnapshotIfCurrentVersion(
          pageID: pageID, expectedVersion: baseVersion, snapshot: candidateBDocument, version: candidateBVersion))
          ?? false
      }
      var collected: [Bool] = []
      for await result in group { collected.append(result) }
      return collected
    }

    XCTAssertEqual(
      results.filter { $0 }.count, 1,
      "exactly one of two racing CAS writes sharing the same expected version must win")

    let record = try await store.documentSnapshot(for: pageID)
    let persistedTitle = try PageDocument.projection(of: try XCTUnwrap(record).snapshot).title
    XCTAssertTrue(
      persistedTitle == "A-Race" || persistedTitle == "B-Race",
      "the persisted snapshot must be exactly one racer's full document, never a mix of both")
  }

  func testRemoveProjectionAlsoPurgesTheDocumentSnapshot() async throws {
    let store = try makeStore()
    let pageID = PageID.free()
    let created = try PageDocument.create(id: pageID, kind: .free, title: "Gone soon")
    try await store.saveDocumentSnapshot(
      pageID: pageID, snapshot: created.document, version: try PageDocument.currentVersion(of: created.document))
    try await store.writeProjection(
      pageID: pageID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: try PageDocument.projection(of: created.document))

    try await store.removeProjection(pageID: pageID)

    let record = try await store.documentSnapshot(for: pageID)
    XCTAssertNil(record, "a catalog-tombstoned page must have no persisted CRDT snapshot left locally either")
  }

  /// A page's raw CRDT snapshot bytes must never be reachable through the
  /// bounded SQL surface — see `LocalGraphSchema.swift`'s
  /// "v3-page-document-snapshots" migration comment.
  func testDocumentSnapshotTableIsNotReachableThroughTheBoundedQuerySurface() async throws {
    let store = try makeStore()
    let pageID = PageID.free()
    let created = try PageDocument.create(id: pageID, kind: .free, title: "Secret bytes")
    try await store.saveDocumentSnapshot(
      pageID: pageID, snapshot: created.document, version: try PageDocument.currentVersion(of: created.document))

    XCTAssertThrowsError(
      try store.query(sql: "SELECT snapshot FROM _local_page_snapshots WHERE page_id = :id", arguments: [":id": .text(pageID.rawValue)])
    )
  }
}
