// ShareCaptureTests.swift
// EnchiridionShareKitTests
//
// P6 "Share extensions" task's required test bar (task brief: "Test the
// capture logic ... against a real temporary LocalGraphStore — prove a
// captured share creates a real page with the expected content, matching
// this package's established test-fixture conventions"). Same pattern
// `EnchiridionStoreTests/AssistantReadToolsTests.swift` and
// `EnchiridionWidgetKitTests/WidgetEntryDataSourceTests.swift` already
// established: real `LocalGraphStore.openTemporary()`, real
// `writeProjection`/read calls underneath, nothing mocked.

import EnchiridionCore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionShareKit
@testable import EnchiridionStore

final class ShareCaptureTests: XCTestCase {
  private func makeStore() throws -> LocalGraphStore {
    try LocalGraphStore.openTemporary()
  }

  func testCaptureWritesANewPageWithTheFirstLineAsTitleAndTheFullTextAsBody() async throws {
    let store = try makeStore()
    let pageID = PageID.free()

    let returnedID = try await ShareCapture.capture(
      ShareCaptureInput(text: "Remember to buy milk\nand eggs"), into: store, pageID: pageID,
      createdAt: Date(timeIntervalSince1970: 1_800_000_000))

    XCTAssertEqual(returnedID, pageID)
    let node = try await store.node(for: pageID)
    XCTAssertEqual(node?.nodeID, pageID)
    XCTAssertEqual(node?.title, "Remember to buy milk")
    XCTAssertEqual(node?.plainText, "Remember to buy milk\nand eggs")
    XCTAssertEqual(node?.kind, "free")
    XCTAssertNil(node?.deletedAt)
  }

  func testCaptureWithOnlyAURLUsesItAsBothTitleAndBody() async throws {
    let store = try makeStore()
    let url = URL(string: "https://rawkode.academy/some-article")!

    let pageID = try await ShareCapture.capture(ShareCaptureInput(url: url), into: store)

    let node = try await store.node(for: pageID)
    XCTAssertEqual(node?.title, url.absoluteString)
    XCTAssertEqual(node?.plainText, url.absoluteString)
  }

  func testCaptureWithTextAndURLCombinesBothIntoTheBody() async throws {
    let store = try makeStore()
    let url = URL(string: "https://example.com")!

    let pageID = try await ShareCapture.capture(
      ShareCaptureInput(text: "Worth reading", url: url), into: store)

    let node = try await store.node(for: pageID)
    XCTAssertEqual(node?.title, "Worth reading")
    XCTAssertEqual(node?.plainText, "Worth reading\n\nhttps://example.com")
  }

  func testCapturePrefersAnExplicitPageTitleOverAnyDerivedOne() async throws {
    let store = try makeStore()

    let pageID = try await ShareCapture.capture(
      ShareCaptureInput(text: "Body text here", pageTitle: "A Real Page Title"), into: store)

    let node = try await store.node(for: pageID)
    XCTAssertEqual(node?.title, "A Real Page Title")
    XCTAssertEqual(node?.plainText, "Body text here")
  }

  func testCaptureThrowsEmptyContentAndWritesNothingWhenInputIsEmpty() async throws {
    let store = try makeStore()
    let pageID = PageID.free()

    do {
      _ = try await ShareCapture.capture(ShareCaptureInput(), into: store, pageID: pageID)
      XCTFail("expected ShareCaptureError.emptyContent")
    } catch ShareCaptureError.emptyContent {
      // expected
    }

    let node = try await store.node(for: pageID)
    XCTAssertNil(node, "a rejected empty capture must not write any page")
  }

  func testCaptureIsQueryableThroughTheBoundedSQLSurfaceLikeAnyOtherPage() async throws {
    let store = try makeStore()

    let pageID = try await ShareCapture.capture(
      ShareCaptureInput(text: "Searchable capture content"), into: store)

    let result = try store.query(
      sql: "SELECT node_id, title FROM graph_nodes WHERE node_id = :id",
      arguments: [":id": .text(pageID.rawValue)])
    XCTAssertEqual(result.rows.count, 1)

    let searchResult = try store.query(
      sql: "SELECT node_id FROM graph_text_search WHERE graph_text_search MATCH 'Searchable'")
    XCTAssertEqual(searchResult.rows.count, 1)
  }

  func testCapturingTwiceWithTheSamePageIDReplacesThePreviousProjection() async throws {
    let store = try makeStore()
    let pageID = PageID.free()

    _ = try await ShareCapture.capture(ShareCaptureInput(text: "First capture"), into: store, pageID: pageID)
    _ = try await ShareCapture.capture(ShareCaptureInput(text: "Second capture"), into: store, pageID: pageID)

    let node = try await store.node(for: pageID)
    XCTAssertEqual(node?.plainText, "Second capture")
  }

  func testCaptureAssignsADistinctRandomPageIDPerCallWhenNoneIsSupplied() async throws {
    let store = try makeStore()

    let first = try await ShareCapture.capture(ShareCaptureInput(text: "One"), into: store)
    let second = try await ShareCapture.capture(ShareCaptureInput(text: "Two"), into: store)

    XCTAssertNotEqual(first, second)
    let firstNode = try await store.node(for: first)
    let secondNode = try await store.node(for: second)
    XCTAssertEqual(firstNode?.plainText, "One")
    XCTAssertEqual(secondNode?.plainText, "Two")
  }

  // MARK: - Task #78: durable CRDT snapshot persistence

  /// A captured share must persist a real, mergeable CRDT snapshot
  /// alongside its projection — not just the projection, which is all this
  /// path wrote before task #78 (see this file's header).
  func testCapturePersistsARealCRDTSnapshotAlongsideTheProjection() async throws {
    let store = try makeStore()
    let pageID = PageID.free()

    _ = try await ShareCapture.capture(
      ShareCaptureInput(text: "Remember to buy milk\nand eggs"), into: store, pageID: pageID,
      createdAt: Date(timeIntervalSince1970: 1_800_000_000))

    let record = try await store.documentSnapshot(for: pageID)
    let unwrapped = try XCTUnwrap(record, "ShareCapture must persist a durable CRDT snapshot, not just a projection")
    let projection = try PageDocument.projection(of: unwrapped.snapshot)
    XCTAssertEqual(projection.title, "Remember to buy milk")
    XCTAssertEqual(projection.plainText, "Remember to buy milk\nand eggs")

    // The snapshot must be a REAL, further-mutable PageDocument — proven by
    // successfully applying one more real CRDT operation on top of it.
    let edited = try PageDocument.insertText(.body, at: 0, text: "URGENT: ", in: unwrapped.snapshot)
    XCTAssertEqual(try PageDocument.projection(of: edited.document).plainText, "URGENT: Remember to buy milk\nand eggs")
  }

  func testCapturingTwiceWithTheSamePageIDReplacesThePreviousSnapshotToo() async throws {
    let store = try makeStore()
    let pageID = PageID.free()

    _ = try await ShareCapture.capture(ShareCaptureInput(text: "First capture"), into: store, pageID: pageID)
    _ = try await ShareCapture.capture(ShareCaptureInput(text: "Second capture"), into: store, pageID: pageID)

    let record = try await store.documentSnapshot(for: pageID)
    let unwrapped = try XCTUnwrap(record)
    XCTAssertEqual(try PageDocument.projection(of: unwrapped.snapshot).plainText, "Second capture")
  }
}
