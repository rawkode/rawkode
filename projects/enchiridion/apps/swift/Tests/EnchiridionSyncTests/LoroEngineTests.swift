// LoroEngineTests.swift
// EnchiridionSyncTests
//
// Basic create-doc / apply-mutation / export-import round trip against the
// REAL loro-swift 1.13.3 API (not a mock) — every call `LoroEngine` makes
// is verified per the citations in LoroEngine.swift, so this test exercises
// the actual FFI, not a stand-in for it.

import Foundation
import XCTest

@testable import EnchiridionCore
@testable import EnchiridionSync

final class LoroEngineTests: XCTestCase {
  func testCreateApplyExportImportRoundTrip() async throws {
    let sourcePage = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000A1")!)

    let sourceEngine = LoroEngine()
    try await sourceEngine.createDocument(id: sourcePage)
    try await sourceEngine.apply(
      .textInsert(container: "body", position: 0, text: "Hello, Enchiridion"),
      to: sourcePage
    )

    let snapshot = try await sourceEngine.exportSnapshot(of: sourcePage)
    XCTAssertGreaterThan(snapshot.count, 0)

    // A second, independent engine — simulating a different device —
    // imports the snapshot with no prior knowledge of the document.
    let destinationEngine = LoroEngine()
    let outcome = try await destinationEngine.importBytes(snapshot, into: sourcePage)
    XCTAssertTrue(outcome.changedState)
    XCTAssertFalse(outcome.hasPendingDependencies)

    let importedText = await destinationEngine.debugTextContent(of: sourcePage, container: "body")
    XCTAssertEqual(importedText, "Hello, Enchiridion")
  }

  func testIncrementalUpdateExportOnlyContainsNewOps() async throws {
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000A2")!)
    let engine = LoroEngine()
    try await engine.createDocument(id: pageID)
    try await engine.apply(.textInsert(container: "body", position: 0, text: "abc"), to: pageID)

    // The peer receives the doc's lineage up through "abc" via a snapshot
    // at this point — a peer must share causal history with the source
    // (same underlying peer IDs/op IDs), not just coincidentally-equal
    // text, for a later incremental update to apply cleanly. A peer built
    // from an independently-created LoroDoc with its own "abc" insert
    // would have the right *text* but the wrong *history*, and the
    // incremental update below would be left pending on dependencies it
    // can never find.
    let earlySnapshot = try await engine.exportSnapshot(of: pageID)
    let peerVersionVector = try await engine.versionVector(of: pageID)

    try await engine.apply(.textInsert(container: "body", position: 3, text: "def"), to: pageID)

    let update = try await engine.exportUpdates(of: pageID, since: peerVersionVector)
    XCTAssertGreaterThan(update.count, 0)

    let peerEngine = LoroEngine()
    try await peerEngine.importBytes(earlySnapshot, into: pageID)
    let outcome = try await peerEngine.importBytes(update, into: pageID)
    XCTAssertTrue(outcome.changedState)
    XCTAssertFalse(outcome.hasPendingDependencies)

    let text = await peerEngine.debugTextContent(of: pageID, container: "body")
    XCTAssertEqual(text, "abcdef")
  }

  func testReimportingSameSnapshotIsANoOp() async throws {
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000A3")!)
    let source = LoroEngine()
    try await source.createDocument(id: pageID)
    try await source.apply(.textInsert(container: "body", position: 0, text: "idempotent"), to: pageID)
    let snapshot = try await source.exportSnapshot(of: pageID)

    let destination = LoroEngine()
    let first = try await destination.importBytes(snapshot, into: pageID)
    XCTAssertTrue(first.changedState)

    let second = try await destination.importBytes(snapshot, into: pageID)
    XCTAssertFalse(second.changedState)
  }

  func testMapSetAndDeleteRoundTrip() async throws {
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000A4")!)
    let engine = LoroEngine()
    try await engine.createDocument(id: pageID)

    try await engine.apply(
      .mapSet(container: "objectMetadata", key: "title", value: .string("Grocery list")),
      to: pageID
    )
    try await engine.apply(
      .mapSet(container: "objectMetadata", key: "priority", value: .int(2)),
      to: pageID
    )

    let snapshot = try await engine.exportSnapshot(of: pageID)
    let peer = LoroEngine()
    try await peer.importBytes(snapshot, into: pageID)

    try await engine.apply(.mapDelete(container: "objectMetadata", key: "priority"), to: pageID)
    let deleteUpdate = try await engine.exportUpdates(
      of: pageID, since: try await peer.versionVector(of: pageID))
    let outcome = try await peer.importBytes(deleteUpdate, into: pageID)
    XCTAssertTrue(outcome.changedState)
  }

  func testTextMarkWithUnregisteredKeyThrows() async throws {
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000A5")!)
    let engine = LoroEngine()
    try await engine.createDocument(id: pageID)
    try await engine.apply(.textInsert(container: "body", position: 0, text: "hello"), to: pageID)

    do {
      try await engine.apply(
        .textMark(container: "body", range: 0..<5, key: "not-a-real-mark", value: .bool(true)),
        to: pageID
      )
      XCTFail("expected engineFailure for an unregistered mark key")
    } catch let error as CRDTEngineError {
      guard case .engineFailure = error else {
        return XCTFail("expected .engineFailure, got \(error)")
      }
    }
  }

  func testTextMarkWithRegisteredKeySucceeds() async throws {
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000A6")!)
    let engine = LoroEngine()
    try await engine.createDocument(id: pageID)
    try await engine.apply(.textInsert(container: "body", position: 0, text: "hello"), to: pageID)

    try await engine.apply(
      .textMark(container: "body", range: 0..<5, key: LoroEngine.MarkStyle.bold.rawValue, value: .bool(true)),
      to: pageID
    )
    // No throw is the assertion; content is unaffected by marks.
    let text = await engine.debugTextContent(of: pageID, container: "body")
    XCTAssertEqual(text, "hello")
  }

  func testChangedDocumentsTracksSequence() async throws {
    let pageA = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000A7")!)
    let pageB = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000A8")!)
    let engine = LoroEngine()

    let (initialIDs, initialSequence) = await engine.changedDocuments(since: 0)
    XCTAssertTrue(initialIDs.isEmpty)
    XCTAssertEqual(initialSequence, 0)

    try await engine.createDocument(id: pageA)
    try await engine.apply(.textInsert(container: "body", position: 0, text: "a"), to: pageA)
    let (afterA, sequenceAfterA) = await engine.changedDocuments(since: 0)
    XCTAssertEqual(afterA, [pageA])
    XCTAssertGreaterThan(sequenceAfterA, 0)

    try await engine.apply(.textInsert(container: "body", position: 0, text: "b"), to: pageB)
    let (afterB, _) = await engine.changedDocuments(since: sequenceAfterA)
    XCTAssertEqual(afterB, [pageB])
  }
}
