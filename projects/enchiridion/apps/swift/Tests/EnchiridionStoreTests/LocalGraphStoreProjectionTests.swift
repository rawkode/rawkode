// LocalGraphStoreProjectionTests.swift
// EnchiridionStoreTests
//
// `LocalGraphStore.writeProjection` round-trip: write a
// `PageDocumentProjection`, read it back through both the typed accessors
// AND the bounded query surface (`graph_nodes`/`graph_facts`/`graph_edges`
// views), and assert the row shape matches what was written. Also covers
// re-write (replace, not accumulate) and `removeProjection` (tombstone
// purge).

import EnchiridionCore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionStore

final class LocalGraphStoreProjectionTests: XCTestCase {
  private func makeStore() throws -> LocalGraphStore {
    try LocalGraphStore.openTemporary()
  }

  func testWriteProjectionThenReadBackNodeRowShape() async throws {
    let store = try makeStore()
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000001")!)
    let createdAt = Date(timeIntervalSince1970: 1_700_000_000)
    let modifiedAt = Date(timeIntervalSince1970: 1_700_000_100)

    let projection = PageDocumentProjection(
      title: "Groceries",
      plainText: "Groceries\nMilk, eggs, bread",
      deletedAt: nil,
      isPinned: true,
      references: [],
      graphEdges: [],
      objectMetadata: .init(supertagIDs: [SupertagID(rawValue: "task")])
    )

    try await store.writeProjection(
      pageID: pageID, kind: .free, createdAt: createdAt, modifiedAt: modifiedAt,
      projection: projection)

    let node = try await store.node(for: pageID)
    let unwrapped = try XCTUnwrap(node)
    XCTAssertEqual(unwrapped.nodeID, pageID)
    XCTAssertEqual(unwrapped.title, "Groceries")
    XCTAssertEqual(unwrapped.plainText, "Groceries\nMilk, eggs, bread")
    XCTAssertEqual(unwrapped.kind, "free")
    XCTAssertTrue(unwrapped.isPinned)
    XCTAssertNil(unwrapped.deletedAt)
    // Epoch-millisecond round trip (LocalGraphSchema's documented
    // timestamp convention — see that file's header) loses sub-millisecond
    // precision only, so compare with a generous tolerance.
    XCTAssertEqual(unwrapped.createdAt.timeIntervalSince1970, createdAt.timeIntervalSince1970, accuracy: 0.001)
    XCTAssertEqual(unwrapped.modifiedAt.timeIntervalSince1970, modifiedAt.timeIntervalSince1970, accuracy: 0.001)
  }

  func testWriteProjectionIsReadableThroughTheBoundedQuerySurface() async throws {
    let store = try makeStore()
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000002")!)
    let projection = PageDocumentProjection(
      title: "Trip planning", plainText: "Trip planning", deletedAt: nil, isPinned: false,
      references: [], graphEdges: [], objectMetadata: .init())

    try await store.writeProjection(
      pageID: pageID, kind: .free, createdAt: Date(), modifiedAt: Date(), projection: projection)

    let result = try store.query(
      sql: "SELECT title FROM graph_nodes WHERE node_id = :id",
      arguments: [":id": .text(pageID.rawValue)]
    )
    XCTAssertEqual(result.rows.count, 1)
    XCTAssertEqual(result.rows.first?.values.first, .text("Trip planning"))
  }

  func testWriteProjectionPopulatesFactsForScalarProperties() async throws {
    let store = try makeStore()
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000003")!)
    let key = SupertagPropertyKey(
      supertagID: SupertagID(rawValue: "task"), fieldID: SupertagFieldID(rawValue: "priority"))
    let projection = PageDocumentProjection(
      title: "Ship the report", plainText: "Ship the report", deletedAt: nil, isPinned: false,
      references: [], graphEdges: [],
      objectMetadata: .init(
        supertagIDs: [SupertagID(rawValue: "task")],
        properties: [key: [.select("high")]]
      ))

    try await store.writeProjection(
      pageID: pageID, kind: .free, createdAt: Date(), modifiedAt: Date(), projection: projection)

    let facts = try await store.facts(for: pageID)
    XCTAssertEqual(facts.count, 1)
    let fact = try XCTUnwrap(facts.first)
    XCTAssertEqual(fact.tagID, SupertagID(rawValue: "task"))
    XCTAssertEqual(fact.fieldID, SupertagFieldID(rawValue: "priority"))
    XCTAssertEqual(fact.valueType, "select")
    XCTAssertEqual(fact.textValue, "high")
  }

  func testWriteProjectionPopulatesEdgesFromGraphEdges() async throws {
    let store = try makeStore()
    let sourceID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000004")!)
    let targetID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000005")!)
    let edge = KnowledgeEdge(
      relationID: RelationID(rawValue: "property-relation:project:owner"),
      sourceNodeID: sourceID, targetNodeID: targetID)
    let projection = PageDocumentProjection(
      title: "Project X", plainText: "Project X", deletedAt: nil, isPinned: false,
      references: [], graphEdges: [edge], objectMetadata: .init())

    try await store.writeProjection(
      pageID: sourceID, kind: .free, createdAt: Date(), modifiedAt: Date(), projection: projection)

    let edges = try await store.edges(from: sourceID)
    XCTAssertEqual(edges.count, 1)
    XCTAssertEqual(edges.first?.toNodeID, targetID)
    XCTAssertEqual(edges.first?.direction, "forward")
  }

  func testRewritingAProjectionReplacesRatherThanAccumulates() async throws {
    let store = try makeStore()
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000006")!)
    let key = SupertagPropertyKey(
      supertagID: SupertagID(rawValue: "task"), fieldID: SupertagFieldID(rawValue: "status"))

    try await store.writeProjection(
      pageID: pageID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "A", plainText: "A", deletedAt: nil, isPinned: false, references: [],
        graphEdges: [], objectMetadata: .init(properties: [key: [.select("todo")]])))

    try await store.writeProjection(
      pageID: pageID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "A", plainText: "A", deletedAt: nil, isPinned: false, references: [],
        graphEdges: [], objectMetadata: .init(properties: [key: [.select("done")]])))

    let facts = try await store.facts(for: pageID)
    XCTAssertEqual(facts.count, 1, "re-writing must replace the old fact, not append a second one")
    XCTAssertEqual(facts.first?.textValue, "done")
  }

  func testRemoveProjectionPurgesAllRows() async throws {
    let store = try makeStore()
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000007")!)
    try await store.writeProjection(
      pageID: pageID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Gone soon", plainText: "Gone soon", deletedAt: nil, isPinned: false,
        references: [], graphEdges: [], objectMetadata: .init()))

    try await store.removeProjection(pageID: pageID)

    let node = try await store.node(for: pageID)
    XCTAssertNil(node)
    let searchResult = try store.query(
      sql: "SELECT node_id FROM graph_text_search WHERE graph_text_search MATCH 'Gone'")
    XCTAssertTrue(searchResult.rows.isEmpty)
  }

  func testDeletedPageIsExcludedFromFullTextSearch() async throws {
    let store = try makeStore()
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000008")!)
    try await store.writeProjection(
      pageID: pageID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Deleted page", plainText: "Deleted page", deletedAt: Date(), isPinned: false,
        references: [], graphEdges: [], objectMetadata: .init()))

    let searchResult = try store.query(
      sql: "SELECT node_id FROM graph_text_search WHERE graph_text_search MATCH 'Deleted'")
    XCTAssertTrue(searchResult.rows.isEmpty)

    let node = try await store.node(for: pageID)
    XCTAssertNotNil(node?.deletedAt, "the node row itself is soft-deleted, still present")
  }
}
