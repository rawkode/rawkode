import XCTest
@testable import AthenaeumRPC

/// **Live integration tests** — the actual proof, per this stage's mandate, that "a minimal
/// working [Cap'n Web client] can complete one real RPC call against the real backend." These
/// hit a genuinely running `@athenaeum/backend` (`wrangler dev`), not a mock/stub transport.
///
/// Gated behind `ATHENAEUM_TEST_BACKEND_URL` (unset in ordinary `swift test`/CI runs, so this
/// file never fails a build that has no backend to talk to) rather than always-on, matching how
/// the backend's own `test/`-directory integration tests are the minority of its suite. Run
/// manually with a real `wrangler dev` instance up:
///
/// ```
/// ATHENAEUM_TEST_BACKEND_URL=http://127.0.0.1:8799 swift test --filter WorkspaceRPCClientLiveTests
/// ```
///
/// See `apps/athenaeum/native/docs/decisions.md` for the actual transcript from running exactly
/// this against a real local backend during the Decisions stage.
final class WorkspaceRPCClientLiveTests: XCTestCase {
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

    /// A fresh random UUID per test run — `EntityId` (`packages/domain/src/node.ts`) accepts a
    /// ULID or UUID, and a fresh workspace per test avoids cross-test interference against a
    /// long-running dev server.
    private func freshWorkspaceId() -> String {
        UUID().uuidString.lowercased()
    }

    func testCreateNodeThenGetNodeRoundTrip() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)

        let created = try await client.createNode(title: "Hello from AthenaeumRPC (Swift)")
        XCTAssertEqual(created.workspaceId, workspaceId)
        XCTAssertEqual(created.title, "Hello from AthenaeumRPC (Swift)")

        let fetched = try await client.getNode(nodeId: created.id)
        XCTAssertEqual(fetched.id, created.id)

        let listed = try await client.listNodes()
        XCTAssertTrue(listed.contains(where: { $0.id == created.id }))
    }

    func testGetNodeNotFoundSurfacesTypedDomainError() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)
        let missingNodeId = UUID().uuidString.lowercased()

        do {
            _ = try await client.getNode(nodeId: missingNodeId)
            XCTFail("expected NodeNotFound")
        } catch let AthenaeumDomainError.nodeNotFound(nodeId) {
            XCTAssertEqual(nodeId, missingNodeId)
        }
    }

    func testPageBodyCreateEditReadRoundTrip() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)
        let node = try await client.createNode(title: "Page host node")

        let (_, initialText) = try await client.createPage(nodeId: node.id)
        XCTAssertEqual(initialText, "")

        let (_, edited) = try await client.applyPageEdit(
            nodeId: node.id,
            index: 0,
            deleteCount: 0,
            insertText: "Hello CRDT from Swift"
        )
        XCTAssertEqual(edited, "Hello CRDT from Swift")

        let (_, reread) = try await client.getPageText(nodeId: node.id)
        XCTAssertEqual(reread, "Hello CRDT from Swift")
    }

    func testPageSyncStartProducesBytes() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)
        let node = try await client.createNode(title: "Sync host node")
        _ = try await client.createPage(nodeId: node.id)
        _ = try await client.applyPageEdit(nodeId: node.id, index: 0, deleteCount: 0, insertText: "synced")

        let message = try await client.startPageSync(nodeId: node.id, sessionId: "swift-test-session")
        XCTAssertNotNil(message)
        XCTAssertGreaterThan(message?.count ?? 0, 0)
    }

    func testSyncFeedReturnsAppendedEntries() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)
        let node = try await client.createNode(title: "Feed host node")

        let page = try await client.syncFeed(knownEpoch: nil, afterCounter: nil, limit: 10)
        XCTAssertFalse(page.epochMismatch)
        XCTAssertTrue(page.entries.contains(where: { $0.entityId == node.id && $0.entityKind == "node" }))
    }

    /// Adversarial-review fix: `WorkspaceRPCClient.listTags()` (`WorkspaceRPCClient+Graph.swift`) called
    /// a `listTags` backend RPC method that did not exist — confirmed live via a raw
    /// `TypeError`, and confirmed as the only one of `WorkspaceRPCClient+Graph.swift`'s six methods
    /// with zero test coverage anywhere in the native tree. `workspace-durable-object.ts` now wires
    /// a real `listTags` shim onto `GraphService.listTags`/`TagsRepository.list`
    /// (`graph-rpc.ts`'s `ListTagsInput`/`ListTagsOutput` schemas already existed but were never
    /// called from any `WorkspaceRpcApi` method before this fix). This test exercises the exact
    /// client method the finding flagged, directly, against a real backend.
    func testCreateTagThenListTagsRoundTrip() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)

        let created = try await client.createTag(name: "Live listTags test tag")
        XCTAssertEqual(created.name, "Live listTags test tag")
        XCTAssertFalse(created.builtin)

        let tags = try await client.listTags()
        // The 8 seeded Base Tags plus the one just created.
        XCTAssertTrue(tags.contains(where: { $0.id == created.id && $0.name == created.name }))
        XCTAssertTrue(tags.contains(where: { $0.builtin }), "expected seeded Base Tags to be present")
        XCTAssertGreaterThanOrEqual(tags.count, 9)
    }

    /// Adversarial-review fix: `WorkspaceRPCClient` had zero `forkChatEdit`/`chatForkPreview`/
    /// `acceptChatFork`/`revertChatFork` methods at all — confirmed by grep, not just a missing
    /// test. This exercises the full accept round trip for real, against a real backend: fork
    /// mainline, edit the fork (via a raw batch call to `applyChatForkEdit` — deliberately not a
    /// public `WorkspaceRPCClient` method, see `WorkspaceRPCClient+AgentEdit.swift`'s own doc comment for
    /// why; this test still needs SOME way to produce a non-trivial fork to accept), confirm the
    /// live preview reflects the fork (not mainline), accept, and confirm mainline itself now
    /// carries the edit while the fork is gone.
    func testChatForkAcceptRoundTrip() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)
        let chatId = "swift-live-test-chat-\(UUID().uuidString.lowercased())"
        let node = try await client.createNode(title: "Chat-fork host node")
        _ = try await client.createPage(nodeId: node.id)
        _ = try await client.applyPageEdit(nodeId: node.id, index: 0, deleteCount: 0, insertText: "Mainline content")

        let forkedText = try await client.forkChatEdit(chatId: chatId, nodeId: node.id)
        XCTAssertEqual(forkedText, "Mainline content")

        // Mainline is untouched by the fork alone.
        let (_, mainlineBeforeAccept) = try await client.getPageText(nodeId: node.id)
        XCTAssertEqual(mainlineBeforeAccept, "Mainline content")

        // Edit the fork only, via a raw batch call — see this test's own doc comment.
        let raw = CapnWebBatchClient(baseURL: URL(
            string: "\(ProcessInfo.processInfo.environment["ATHENAEUM_TEST_BACKEND_URL"]!)/api/workspace/\(workspaceId)"
        )!)
        let editResults = try await raw.sendBatch([
            CapnWebCall(method: "applyChatForkEdit", args: .object([
                "workspaceId": .string(workspaceId),
                "chatId": .string(chatId),
                "nodeId": .string(node.id),
                "index": .number(0),
                "deleteCount": .number(0),
                "insertText": .string("Agent-drafted: ")
            ]))
        ])
        _ = try editResults[0].get()

        let preview = try await client.chatForkPreview(chatId: chatId, nodeId: node.id)
        XCTAssertTrue(preview.forked)
        XCTAssertEqual(preview.text, "Agent-drafted: Mainline content")

        // Mainline STILL untouched — the fork edit hasn't been accepted yet.
        let (_, mainlineStillBeforeAccept) = try await client.getPageText(nodeId: node.id)
        XCTAssertEqual(mainlineStillBeforeAccept, "Mainline content")

        let (_, acceptedText) = try await client.acceptChatFork(chatId: chatId, nodeId: node.id)
        XCTAssertEqual(acceptedText, "Agent-drafted: Mainline content")

        let (_, mainlineAfterAccept) = try await client.getPageText(nodeId: node.id)
        XCTAssertEqual(mainlineAfterAccept, "Agent-drafted: Mainline content")

        let previewAfterAccept = try await client.chatForkPreview(chatId: chatId, nodeId: node.id)
        XCTAssertFalse(previewAfterAccept.forked)
    }

    /// The "Revert" half — a fork with a real edit applied is discarded via `revertChatFork` with
    /// zero effect on mainline, and `chatForkPreview` afterward reports `forked == false`.
    func testChatForkRevertLeavesMainlineUntouched() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)
        let chatId = "swift-live-test-chat-\(UUID().uuidString.lowercased())"
        let node = try await client.createNode(title: "Chat-fork revert host node")
        _ = try await client.createPage(nodeId: node.id)
        _ = try await client.applyPageEdit(nodeId: node.id, index: 0, deleteCount: 0, insertText: "Mainline content")

        _ = try await client.forkChatEdit(chatId: chatId, nodeId: node.id)

        let raw = CapnWebBatchClient(baseURL: URL(
            string: "\(ProcessInfo.processInfo.environment["ATHENAEUM_TEST_BACKEND_URL"]!)/api/workspace/\(workspaceId)"
        )!)
        let editResults = try await raw.sendBatch([
            CapnWebCall(method: "applyChatForkEdit", args: .object([
                "workspaceId": .string(workspaceId),
                "chatId": .string(chatId),
                "nodeId": .string(node.id),
                "index": .number(0),
                "deleteCount": .number(0),
                "insertText": .string("Should never land: ")
            ]))
        ])
        _ = try editResults[0].get()

        try await client.revertChatFork(chatId: chatId, nodeId: node.id)

        let (_, mainlineAfterRevert) = try await client.getPageText(nodeId: node.id)
        XCTAssertEqual(mainlineAfterRevert, "Mainline content")

        let previewAfterRevert = try await client.chatForkPreview(chatId: chatId, nodeId: node.id)
        XCTAssertFalse(previewAfterRevert.forked)
    }

    func testTwoIndependentCallsInOneBatchCorrelateCorrectly() async throws {
        // Proves this client's id-correlation assumption (see `CapnWebBatchClient`'s doc
        // comment) for real, against a real server, not just by inspecting capnweb's source: two
        // independent calls in one HTTP round trip must come back matched to the right call, not
        // swapped.
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)
        let nodeA = try await client.createNode(title: "Batch A")
        let nodeB = try await client.createNode(title: "Batch B")

        let raw = CapnWebBatchClient(baseURL: URL(
            string: "\(ProcessInfo.processInfo.environment["ATHENAEUM_TEST_BACKEND_URL"]!)/api/workspace/\(workspaceId)"
        )!)
        let results = try await raw.sendBatch([
            CapnWebCall(method: "getNode", args: .object(["workspaceId": .string(workspaceId), "nodeId": .string(nodeA.id)])),
            CapnWebCall(method: "getNode", args: .object(["workspaceId": .string(workspaceId), "nodeId": .string(nodeB.id)]))
        ])
        XCTAssertEqual(results.count, 2)
        let firstValue = try results[0].get()
        let secondValue = try results[1].get()
        let firstNode = try RPCNode(firstValue.field("node"))
        let secondNode = try RPCNode(secondValue.field("node"))
        XCTAssertEqual(firstNode.id, nodeA.id)
        XCTAssertEqual(secondNode.id, nodeB.id)
    }
}
