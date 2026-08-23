import XCTest
import AthenaeumDomain
import AthenaeumRPC
@testable import AthenaeumCore

/// **Live end-to-end smoke test** — task item 4's own mandate: "boot the real Phase 1 backend
/// locally (wrangler dev), and from a Swift test/small CLI driver, create a node+page via the
/// native client, apply a local edit, sync it, then independently verify via a direct RPC call...
/// that the edit landed server-side."
///
/// Gated behind `ATHENAEUM_TEST_BACKEND_URL`, same convention as `AthenaeumRPC`'s own
/// `WorkspaceRPCClientLiveTests` (unset in ordinary `swift test`/CI, so this file never fails a build
/// with no backend to talk to). Run manually with a real `wrangler dev` instance up:
///
/// ```
/// cd apps/athenaeum/packages/backend && pnpm dev   # or: wrangler dev
/// ATHENAEUM_TEST_BACKEND_URL=http://127.0.0.1:8787 swift test --filter WorkspaceSyncClientLiveTests
/// ```
///
/// See this stage's report for the actual transcript from running exactly this against a real
/// local backend.
final class WorkspaceSyncClientLiveTests: XCTestCase {
    private func makeClient(workspaceId: String) throws -> WorkspaceRPCClient {
        guard let urlString = ProcessInfo.processInfo.environment["ATHENAEUM_TEST_BACKEND_URL"] else {
            throw XCTSkip("ATHENAEUM_TEST_BACKEND_URL not set — skipping live backend integration test")
        }
        guard let baseURL = URL(string: "\(urlString)/api/workspace/\(workspaceId)") else {
            XCTFail("invalid ATHENAEUM_TEST_BACKEND_URL: \(urlString)")
            throw CapnWebError.malformedMessage("invalid base URL")
        }
        return WorkspaceRPCClient(baseURL: baseURL, workspaceId: workspaceId)
    }

    private func freshWorkspaceId() -> String {
        UUID().uuidString.lowercased()
    }

    /// The full task-item-4 smoke test: create node+page via `WorkspaceSyncClient`, apply a local
    /// edit, sync it, then verify server-side state through a **second, independent**
    /// `WorkspaceRPCClient` instance (never reusing `WorkspaceSyncClient`'s own client, so a bug that only
    /// fooled the client used to write couldn't also fool the client used to verify).
    func testCreateNodeAndPageApplyLocalEditSyncsAndLandsServerSide() async throws {
        let workspaceId = freshWorkspaceId()
        let writeClient = try makeClient(workspaceId: workspaceId)
        let localStore = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath())
        let pageStore = PageDocumentStore()
        let workspaceIdTyped = try EntityId(validating: workspaceId)
        let syncClient = WorkspaceSyncClient(
            localStore: localStore, pageStore: pageStore, rpcClient: writeClient, workspaceId: workspaceIdTyped
        )

        let node = try await syncClient.createNode(title: "Native smoke-test node")
        XCTAssertEqual(node.workspaceId, workspaceIdTyped)

        let localNodeRow = try await localStore.node(id: node.id)
        XCTAssertEqual(localNodeRow?.title, "Native smoke-test node")

        let session = SyncSessionHandle()
        let initialText = try await syncClient.resolveOrCreatePage(nodeId: node.id, session: session)
        XCTAssertEqual(initialText, "")

        let afterLocalEdit = try await syncClient.applyLocalEdit(
            nodeId: node.id, index: 0, deleteCount: 0, insertText: "Hello from AthenaeumCore"
        )
        XCTAssertEqual(afterLocalEdit, "Hello from AthenaeumCore")

        // Durable-before-sync: the local snapshot must already reflect the edit even though no
        // sync round trip has happened yet.
        let localBytesBeforeSync = try await localStore.pageDocBytes(nodeId: node.id)
        XCTAssertNotNil(localBytesBeforeSync)
        XCTAssertFalse(localBytesBeforeSync!.isEmpty)

        let afterSync = try await syncClient.syncPage(nodeId: node.id, session: session)
        XCTAssertEqual(afterSync, "Hello from AthenaeumCore")

        // Independent verification: a *second* `WorkspaceRPCClient`, never touched by `syncClient`.
        let verifyClient = try makeClient(workspaceId: workspaceId)
        let (_, serverText) = try await verifyClient.getPageText(nodeId: node.id.rawValue)
        XCTAssertEqual(serverText, "Hello from AthenaeumCore")

        // Local durable state after a successful sync should agree with the server too.
        let localPageAfterSync = try await localStore.page(nodeId: node.id)
        XCTAssertNotNil(localPageAfterSync)
        let localTextAfterSync = try await pageStore.text(nodeId: node.id)
        XCTAssertEqual(localTextAfterSync, "Hello from AthenaeumCore")
    }

    /// A second edit + second sync round, reusing the same `SyncSessionHandle` — exercises the
    /// "stable session id across calls" discipline `WorkspaceSyncClient.syncPage`'s doc comment
    /// claims, not just a single round trip.
    func testSecondEditReusesSameSessionAndConverges() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)
        let localStore = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath())
        let pageStore = PageDocumentStore()
        let syncClient = WorkspaceSyncClient(
            localStore: localStore, pageStore: pageStore, rpcClient: client,
            workspaceId: try EntityId(validating: workspaceId)
        )

        let node = try await syncClient.createNode(title: "Two edits")
        let session = SyncSessionHandle()
        let firstSessionId = session.id

        _ = try await syncClient.resolveOrCreatePage(nodeId: node.id, session: session)
        _ = try await syncClient.applyLocalEdit(nodeId: node.id, index: 0, deleteCount: 0, insertText: "one")
        _ = try await syncClient.syncPage(nodeId: node.id, session: session)

        _ = try await syncClient.applyLocalEdit(nodeId: node.id, index: 3, deleteCount: 0, insertText: " two")
        let converged = try await syncClient.syncPage(nodeId: node.id, session: session)

        XCTAssertEqual(converged, "one two")
        // No `reset: true` should have been needed across two back-to-back calls against a live
        // (not evicted) session — the session id should be unchanged.
        XCTAssertEqual(session.id, firstSessionId)

        let (_, serverText) = try await client.getPageText(nodeId: node.id.rawValue)
        XCTAssertEqual(serverText, "one two")
    }

    /// Proves the "second, independent" structured-record half of task item 4 works too:
    /// `createTag`/`addFact`/`createEdge` pushed via `WorkspaceSyncClient`, verified server-side
    /// through `listBacklinks`/`syncFeed` on a fresh client.
    func testStructuredMutationsLandServerSideAndAppearInSyncFeed() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)
        let localStore = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath())
        let pageStore = PageDocumentStore()
        let syncClient = WorkspaceSyncClient(
            localStore: localStore, pageStore: pageStore, rpcClient: client,
            workspaceId: try EntityId(validating: workspaceId)
        )

        let source = try await syncClient.createNode(title: "Source node")
        let target = try await syncClient.createNode(title: "Target node")
        let tag = try await syncClient.createTag(name: "SmokeTestTag")
        let fact = try await syncClient.addFact(nodeId: source.id, predicateId: "note", value: "hello")
        let relationDefinition = try await client.createRelationDefinition(
            forwardName: "relates-to", inverseName: "related-from",
            sourceTagId: tag.id.rawValue, targetTagId: tag.id.rawValue, cardinality: "many-to-many"
        )
        let edge = try await syncClient.createEdge(
            relationDefinitionId: try EntityId(validating: relationDefinition.id),
            sourceNodeId: source.id, targetNodeId: target.id
        )

        let verifyClient = try makeClient(workspaceId: workspaceId)
        let backlinks = try await verifyClient.listBacklinks(nodeId: target.id.rawValue)
        XCTAssertTrue(backlinks.contains(where: { $0.id == edge.id.rawValue }))

        let feedPage = try await verifyClient.syncFeed(knownEpoch: nil, afterCounter: nil, limit: 100)
        XCTAssertTrue(feedPage.entries.contains(where: { $0.entityId == source.id.rawValue && $0.entityKind == "node" }))
        XCTAssertTrue(feedPage.entries.contains(where: { $0.entityId == fact.id.rawValue && $0.entityKind == "fact" }))

        let catchUp = try await syncClient.catchUpStructuredSync()
        XCTAssertGreaterThan(catchUp.entriesSeen, 0)

        let localTags = try await localStore.listTags()
        XCTAssertTrue(localTags.contains(where: { $0.id == tag.id }))
    }
}
