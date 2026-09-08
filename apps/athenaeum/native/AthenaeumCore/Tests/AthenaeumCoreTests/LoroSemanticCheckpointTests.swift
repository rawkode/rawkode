import XCTest
import Loro
import AthenaeumDomain
@testable import AthenaeumCore

final class LoroSemanticCheckpointTests: XCTestCase {
    func testV7RetentionSQLNeverUsesDestructiveOrReplaceOperations() throws {
        let package = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // AthenaeumCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // AthenaeumCore
        let source = try String(contentsOf: package.appendingPathComponent("Sources/AthenaeumCore/LocalWorkspaceStore.swift"))
        // Audit executable SQL fragments, not prose comments explaining the retention policy.
        let uncommented = source.replacingOccurrences(
            of: #"(?s)/\*.*?\*/|//[^\r\n]*"#,
            with: "",
            options: .regularExpression
        )
        let v7Statements = uncommented
            .split(separator: ";", omittingEmptySubsequences: false)
            .filter { $0.localizedCaseInsensitiveContains("loro_semantic_candidates_v7") || $0.localizedCaseInsensitiveContains("loro_semantic_checkpoint_archive_v7") }
        let prohibited = try NSRegularExpression(pattern: "(?i)\\b(delete|truncate|drop)\\b|\\binsert\\s+or\\s+replace\\b")
        for statement in v7Statements {
            let sql = String(statement)
            let range = NSRange(sql.startIndex..., in: sql)
            XCTAssertEqual(
                prohibited.numberOfMatches(in: sql, range: range),
                0,
                "v7 retention SQL must be append/CAS-only: \(sql)"
            )
        }
    }

    func testCheckpointRoundTripsTypedAttributionAndRejectsTamperedEvidence() async throws {
        let workspace = try EntityId(validating: UUID().uuidString.lowercased())
        let node = try EntityId(validating: UUID().uuidString.lowercased())
        let snapshot = try nativePlainSnapshot()
        let prepared = try await LoroPageDocumentStore().prepare(nodeId: node, snapshot: snapshot)
        let checkpoint = try LoroSemanticCheckpoint(
            workspaceId: workspace, nodeId: node, state: .inFlight,
            intent: try .init(requestId: " request-1 ", commitMessage: " Commit text ", attribution: .agentJob(jobId: "job", runId: "run")),
            route: .init(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: prepared.localSnapshotSHA256),
            update: Data([1, 2, 3]), baseVersionVector: prepared.versionBytes
        )
        let reconstructed = try LoroSemanticCheckpoint.reconstruct(
            workspaceId: workspace,
            nodeId: node,
            state: LoroSemanticCheckpointState.inFlight.rawValue,
            requestId: checkpoint.intent.requestId,
            commitMessage: checkpoint.intent.commitMessage,
            attributionKind: "agentJob",
            attributionOne: "job",
            attributionTwo: "run",
            storageVersion: checkpoint.route.storageVersion,
            schemaVersion: checkpoint.route.schemaVersion,
            snapshotSHA256: checkpoint.route.snapshotSHA256,
            update: checkpoint.update,
            updateSHA256: checkpoint.updateSHA256,
            baseVersionVector: checkpoint.baseVersionVector,
            baseVersionVectorSHA256: checkpoint.baseVersionVectorSHA256
        )
        XCTAssertEqual(reconstructed, checkpoint)

        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        try await fixture.local.persistFrozenLiteralCandidate(actorIssued: fixture.candidate)
        let persisted = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertEqual(persisted, fixture.candidate.checkpoint)
        _ = try await fixture.local.transitionLoroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node, from: .inFlight, to: .retainedConflict)
        do {
            _ = try await fixture.local.transitionLoroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node, from: .retainedConflict, to: .inFlight)
            XCTFail("closed transition graph must reject conflict retry")
        } catch { XCTAssertEqual(error as? LocalWorkspaceStoreError, .invalidLoroCheckpoint) }

        let connection = try SQLite3Connection(path: fixture.local.path)
        try connection.run("UPDATE loro_semantic_candidates_v7 SET candidate_snapshot_sha256 = ?;", [.text(String(repeating: "0", count: 64))])
        do {
            _ = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
            XCTFail("expected tampered checkpoint rejection")
        } catch { XCTAssertEqual(error as? LocalWorkspaceStoreError, .invalidLoroCandidate) }
    }

    func testNativePlainCandidateTokenRejectsSchemaOnlyAndNewlines() async throws {
        let node = try EntityId(validating: UUID().uuidString.lowercased())
        let snapshot = try nativePlainSnapshot(text: "plain")
        let prepared = try await LoroPageDocumentStore().prepare(nodeId: node, snapshot: snapshot)
        let store = LoroPageDocumentStore()
        let token = try await store.validateNativePlainLoroCandidateV1(nodeId: node, snapshot: snapshot)
        XCTAssertEqual(token.localSnapshotSHA256, prepared.localSnapshotSHA256)
        do {
            _ = try await store.validateNativePlainLoroCandidateV1(nodeId: node, snapshot: Data([0]))
            XCTFail("expected malformed candidate rejection")
        } catch { XCTAssertEqual(error as? LoroPageDocumentStoreError, .malformedSnapshot) }
        XCTAssertThrowsError(try nativePlainSnapshot(text: "not\nplain"))
    }

    private func nativePlainSnapshot(text: String = "") throws -> Data {
        guard !text.contains("\n") else { throw LoroPageDocumentStoreError.nativePlainTextIneligible }
        let doc = LoroDoc()
        try doc.getMap(id: "athenaeum-page-meta-v1").insert(key: "schemaVersion", v: 1)
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        try root.insert(key: "nodeName", v: "doc")
        try root.getOrCreateMapContainer(key: "attributes", child: LoroMap()).insert(key: "isAmgBlock", v: false)
        let children = try root.getOrCreateListContainer(key: "children", child: LoroList())
        let paragraph = try children.insertMapContainer(pos: 0, child: LoroMap())
        try paragraph.insert(key: "nodeName", v: "paragraph")
        try paragraph.getOrCreateMapContainer(key: "attributes", child: LoroMap()).insert(key: "isAmgBlock", v: false)
        let inline = try paragraph.getOrCreateListContainer(key: "children", child: LoroList())
        if !text.isEmpty { try inline.insertTextContainer(pos: 0, child: LoroText()).pushStr(s: text) }
        doc.commit()
        return try doc.export(mode: .snapshot)
    }
}
