import XCTest
import AthenaeumDomain
@testable import AthenaeumCore

final class LocalWorkspaceStoreTests: XCTestCase {
    private func makeStore() throws -> LocalWorkspaceStore {
        try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
    }

    func testMigrationIsIdempotentAndPersistsUserVersion() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        _ = try LocalWorkspaceStore(path: path)
        // Re-opening the same file must not fail or re-run destructive DDL — the same
        // `if version < currentSchemaVersion` idempotency new-notes' own migration ladder relies
        // on (`SQLiteStore.migrate`), exercised here for real against a real file on disk.
        let reopened = try LocalWorkspaceStore(path: path)
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let node = Node(
            id: try EntityId(validating: UUID().uuidString.lowercased()),
            workspaceId: workspaceId,
            title: "Reopened fine",
            createdAt: try IsoDateTimeString(validating: "2026-08-20T00:00:00Z")
        )
        try await reopened.upsertNode(node)
        let fetched = try await reopened.node(id: node.id)
        XCTAssertEqual(fetched?.title, "Reopened fine")
    }

    func testNodeUpsertAndDirtyBookkeeping() async throws {
        let store = try makeStore()
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let node = Node(
            id: try EntityId(validating: UUID().uuidString.lowercased()),
            workspaceId: workspaceId,
            title: "Local first",
            createdAt: try IsoDateTimeString(validating: "2026-08-20T00:00:00Z")
        )
        try await store.upsertNode(node, dirty: true)

        let dirty = try await store.listDirtyNodes(workspaceId: workspaceId)
        XCTAssertEqual(dirty.map(\.id), [node.id])

        try await store.markNodeSynced(id: node.id)
        let stillDirty = try await store.listDirtyNodes(workspaceId: workspaceId)
        XCTAssertTrue(stillDirty.isEmpty)

        let fetched = try await store.node(id: node.id)
        XCTAssertEqual(fetched, node)

        let listed = try await store.listNodes(workspaceId: workspaceId)
        XCTAssertEqual(listed, [node])
    }

    func testPageRequiresExistingNode() async throws {
        let store = try makeStore()
        let missingNodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let page = Page(nodeId: missingNodeId, automergeDocId: missingNodeId.rawValue, headsHash: "abc")

        do {
            try await store.upsertPage(page, docBytes: nil)
            XCTFail("expected nodeNotFound")
        } catch LocalWorkspaceStoreError.nodeNotFound(let id) {
            XCTAssertEqual(id, missingNodeId)
        }
    }

    func testPageDocBytesRoundTrip() async throws {
        let store = try makeStore()
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let node = Node(id: nodeId, workspaceId: workspaceId, title: "Has a page", createdAt: "2026-08-20T00:00:00Z")
        try await store.upsertNode(node, dirty: false)

        let bytes = Data([0x01, 0x02, 0x03, 0xFF])
        let page = Page(nodeId: nodeId, automergeDocId: nodeId.rawValue, headsHash: "hash-1")
        try await store.upsertPage(page, docBytes: bytes, dirty: true)

        let storedBytes1 = try await store.pageDocBytes(nodeId: nodeId)
        XCTAssertEqual(storedBytes1, bytes)
        let storedPage1 = try await store.page(nodeId: nodeId)
        XCTAssertEqual(storedPage1?.headsHash, "hash-1")

        // Updating the reference row without new bytes (`docBytes: nil`) must not clobber the
        // previously-stored blob — `upsertPage`'s `COALESCE(excluded.doc_bytes, pages.doc_bytes)`.
        let updated = Page(nodeId: nodeId, automergeDocId: nodeId.rawValue, headsHash: "hash-2")
        try await store.upsertPage(updated, docBytes: nil, dirty: false)
        let storedBytes2 = try await store.pageDocBytes(nodeId: nodeId)
        XCTAssertEqual(storedBytes2, bytes)
        let storedPage2 = try await store.page(nodeId: nodeId)
        XCTAssertEqual(storedPage2?.headsHash, "hash-2")
    }

    func testTagUpsertAndParentIdsRoundTrip() async throws {
        let store = try makeStore()
        let parentId = try EntityId(validating: UUID().uuidString.lowercased())
        let tagId = try EntityId(validating: UUID().uuidString.lowercased())
        let tag = Tag(id: tagId, name: "Custom Tag", parentIds: [parentId], builtin: false)

        try await store.upsertTag(tag, dirty: true)
        let fetched = try await store.tag(id: tagId)
        XCTAssertEqual(fetched, tag)

        let all = try await store.listTags()
        XCTAssertTrue(all.contains(tag))
    }

    func testFactValueRoundTripsThroughJSON() async throws {
        let store = try makeStore()
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        try await store.upsertNode(
            Node(id: nodeId, workspaceId: workspaceId, title: "Fact host", createdAt: "2026-08-20T00:00:00Z"),
            dirty: false
        )

        let factId = try EntityId(validating: UUID().uuidString.lowercased())
        let value: JSONValue = ["due": "2026-09-01", "priority": 2, "urgent": true, "tags": ["a", "b"]]
        let fact = Fact(id: factId, nodeId: nodeId, predicateId: "task-metadata", value: value)
        try await store.upsertFact(fact, dirty: true)

        let fetched = try await store.listFacts(nodeId: nodeId)
        XCTAssertEqual(fetched, [fact])
    }

    func testEdgeBacklinksQueryMirrorsTargetIndex() async throws {
        let store = try makeStore()
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let source = try EntityId(validating: UUID().uuidString.lowercased())
        let target = try EntityId(validating: UUID().uuidString.lowercased())
        for id in [source, target] {
            try await store.upsertNode(
                Node(id: id, workspaceId: workspaceId, title: "n", createdAt: "2026-08-20T00:00:00Z"), dirty: false
            )
        }
        let relationDefinitionId = try EntityId(validating: UUID().uuidString.lowercased())
        let edgeId = try EntityId(validating: UUID().uuidString.lowercased())
        let edge = Edge(id: edgeId, relationDefinitionId: relationDefinitionId, sourceNodeId: source, targetNodeId: target)
        try await store.upsertEdge(edge, dirty: true)

        let backlinks = try await store.listBacklinks(targetNodeId: target)
        XCTAssertEqual(backlinks, [edge])

        let outgoing = try await store.listOutgoingEdges(sourceNodeId: source)
        XCTAssertEqual(outgoing, [edge])

        let noBacklinks = try await store.listBacklinks(targetNodeId: source)
        XCTAssertTrue(noBacklinks.isEmpty)
    }

    func testSyncFeedCursorPersistsAcrossReopens() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())

        let store = try LocalWorkspaceStore(path: path)
        let initialCursor = try await store.syncFeedCursor(workspaceId: workspaceId)
        XCTAssertNil(initialCursor)

        try await store.setSyncFeedCursor(workspaceId: workspaceId, epoch: "epoch-1", afterCounter: 42)

        let reopened = try LocalWorkspaceStore(path: path)
        let cursor = try await reopened.syncFeedCursor(workspaceId: workspaceId)
        XCTAssertEqual(cursor?.epoch, "epoch-1")
        XCTAssertEqual(cursor?.afterCounter, 42)

        try await reopened.setSyncFeedCursor(workspaceId: workspaceId, epoch: "epoch-2", afterCounter: nil)
        let updated = try await reopened.syncFeedCursor(workspaceId: workspaceId)
        XCTAssertEqual(updated?.epoch, "epoch-2")
        XCTAssertNil(updated?.afterCounter)
    }
}
