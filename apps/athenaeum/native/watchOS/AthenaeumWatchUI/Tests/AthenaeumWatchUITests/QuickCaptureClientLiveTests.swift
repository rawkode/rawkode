import XCTest
import AthenaeumDomain
import AthenaeumRPC
@testable import AthenaeumWatchUI

/// **Live end-to-end smoke test**, same gating convention as `AthenaeumRPC`'s
/// `WorkspaceRPCClientLiveTests` and `AthenaeumCore`'s `WorkspaceSyncClientLiveTests` — skipped unless
/// `ATHENAEUM_TEST_BACKEND_URL` is set, so it never fails an ordinary `swift test`/CI run with no
/// backend to talk to. Run manually with a real `wrangler dev` instance up:
///
/// ```
/// cd apps/athenaeum/packages/backend && pnpm dev   # or: wrangler dev
/// ATHENAEUM_TEST_BACKEND_URL=http://127.0.0.1:8787 swift test --filter QuickCaptureClientLiveTests
/// ```
final class QuickCaptureClientLiveTests: XCTestCase {
    private func makeRPCClient(workspaceId: String) throws -> WorkspaceRPCClient {
        guard let urlString = ProcessInfo.processInfo.environment["ATHENAEUM_TEST_BACKEND_URL"] else {
            throw XCTSkip("ATHENAEUM_TEST_BACKEND_URL not set — skipping live backend integration test")
        }
        guard let baseURL = URL(string: "\(urlString)/api/workspace/\(workspaceId)") else {
            XCTFail("invalid ATHENAEUM_TEST_BACKEND_URL: \(urlString)")
            throw CapnWebError.malformedMessage("invalid base URL")
        }
        return WorkspaceRPCClient(
            baseURL: baseURL,
            workspaceId: workspaceId,
            bearerCredential: ProcessInfo.processInfo.environment["ATHENAEUM_TEST_BEARER_CREDENTIAL"]
        )
    }

    private func freshWorkspaceId() -> String {
        UUID().uuidString.lowercased()
    }

    private func requireBearerCredential() throws -> String {
        guard let credential = ProcessInfo.processInfo.environment["ATHENAEUM_TEST_BEARER_CREDENTIAL"], !credential.isEmpty else {
            throw XCTSkip("ATHENAEUM_TEST_BEARER_CREDENTIAL not set — authenticated addFact live test skipped")
        }
        return credential
    }

    /// The watchOS-flow analog of `WorkspaceSyncClientLiveTests`'s smoke test: capture a piece of
    /// dictation-length text via `QuickCaptureClient`, then verify server-side through a
    /// **second, independent** `WorkspaceRPCClient` — the node exists, is tagged `Task`, and its
    /// full untruncated text survived in the `quick-capture-text` fact.
    func testCaptureCreatesTaskTaggedNodeWithFullTextFactServerSide() async throws {
        let workspaceId = freshWorkspaceId()
        let workspaceIdTyped = try EntityId(validating: workspaceId)
        let credential = try requireBearerCredential()
        let writeClient = try makeRPCClient(workspaceId: workspaceId)
        let quickCapture = QuickCaptureClient(rpcClient: writeClient, workspaceId: workspaceIdTyped, bearerCredential: credential)

        let longText = "Call the vet about \(String(repeating: "the dog's ", count: 20))follow-up appointment  \n"
        let result = try await quickCapture.capture(text: longText)

        XCTAssertTrue(result.node.title.hasSuffix("…"))
        XCTAssertNotEqual(result.node.title, longText.trimmingCharacters(in: .whitespacesAndNewlines))
        XCTAssertEqual(result.fact.value, .string(longText.trimmingCharacters(in: .whitespacesAndNewlines)))

        let verifyClient = try makeRPCClient(workspaceId: workspaceId)
        let serverNode = try await verifyClient.getNode(nodeId: result.node.id.rawValue)
        XCTAssertEqual(serverNode.id, result.node.id.rawValue)

        let feedPage = try await verifyClient.syncFeed(knownEpoch: nil, afterCounter: nil, limit: 50)
        let sawTaggedNode = feedPage.entries.contains { entry in
            entry.entityKind == "node" && entry.entityId == result.node.id.rawValue
        }
        XCTAssertTrue(sawTaggedNode, "expected the captured node to appear in the sync feed")
    }

    func testCaptureOfShortTextLeavesTitleUntruncated() async throws {
        let workspaceId = freshWorkspaceId()
        let workspaceIdTyped = try EntityId(validating: workspaceId)
        let credential = try requireBearerCredential()
        let writeClient = try makeRPCClient(workspaceId: workspaceId)
        let quickCapture = QuickCaptureClient(rpcClient: writeClient, workspaceId: workspaceIdTyped, bearerCredential: credential)

        let result = try await quickCapture.capture(text: "Buy milk")
        XCTAssertEqual(result.node.title, "Buy milk")
        XCTAssertEqual(result.fact.value, .string("Buy milk"))
    }

    func testCaptureOfBlankTextThrows() async throws {
        let workspaceId = freshWorkspaceId()
        let workspaceIdTyped = try EntityId(validating: workspaceId)
        let writeClient = try makeRPCClient(workspaceId: workspaceId)
        let quickCapture = QuickCaptureClient(rpcClient: writeClient, workspaceId: workspaceIdTyped)

        do {
            _ = try await quickCapture.capture(text: "   \n  ")
            XCTFail("expected QuickCaptureError.emptyText")
        } catch QuickCaptureError.emptyText {
            // expected
        }
    }
}
