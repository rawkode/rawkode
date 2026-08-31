import Foundation
import Loro
import XCTest
import AthenaeumDomain
@testable import AthenaeumCore

final class LoroNativeRichCrossClientJoinTests: XCTestCase {
    func testCheckedInWebReferenceSnapshotsInspectWriteAndReload() async throws {
        let corpus = try Self.checkedInWebCorpus()
        XCTAssertEqual(corpus.format, "athenaeum-native-rich-loro-v1-source-corpus")
        XCTAssertEqual(corpus.corpusVersion, 1)

        let fixtures = corpus.cases.filter {
            $0.id == "entity-reference-surrounding-edit" || $0.id == "supertag-reference-surrounding-edit"
        }
        XCTAssertEqual(Set(fixtures.map(\.id)), ["entity-reference-surrounding-edit", "supertag-reference-surrounding-edit"])

        for fixture in fixtures {
            XCTAssertEqual(fixture.classification, "eligible", fixture.id)
            let snapshot = try XCTUnwrap(Data(base64Encoded: fixture.baseSnapshotBase64), "invalid base64 for \(fixture.id)")

            // The source artifact is an official Web-produced Loro snapshot. Decode it directly
            // before passing the same bytes through the native structural/projection boundary.
            let sourceDocument = LoroDoc()
            _ = try sourceDocument.import(bytes: snapshot)

            let workspaceId = try entityId()
            let nodeId = try entityId()
            let store = LoroPageDocumentStore()
            let prepared = try await store.prepare(nodeId: nodeId, snapshot: snapshot)
            try await store.publish(nodeId: nodeId, prepared: prepared)
            try await installAcceptedRichLiteral(store, workspaceId: workspaceId, nodeId: nodeId, prepared: prepared)

            let base = try await richEditable(store, nodeId: nodeId, storageVersion: 1)
            let expected = try expectedSemantic(for: fixture.id, proposed: false)
            XCTAssertEqual(base.document.semantic, expected, fixture.id)
            try assertReferenceContract(in: base.document.semantic, fixtureId: fixture.id)

            let proposed = try expectedSemantic(for: fixture.id, proposed: true)
            let candidate = try await store.prepareNativeRichSemanticCandidateV1(
                nodeId: nodeId,
                route: base.route,
                persistedReplica: base.replica,
                publishedReplica: base.replica,
                isDirty: false,
                workspaceId: workspaceId,
                intent: try .init(
                    requestId: "cross-client-\(fixture.id)",
                    commitMessage: "preserve Web reference while updating surrounding prose",
                    attribution: .humanUi(surface: "macos")
                ),
                proposed: .init(semantic: proposed)
            )
            XCTAssertEqual(candidate.semantic, proposed, fixture.id)

            // Exported native candidate bytes must be independently decodable and then retain the
            // exact value-only semantic form after a separate store imports and reloads them.
            let nativeDocument = LoroDoc()
            _ = try nativeDocument.import(bytes: candidate.literal.snapshotBytes)
            let reloadedStore = LoroPageDocumentStore()
            let reloadedPrepared = try await reloadedStore.prepare(nodeId: nodeId, snapshot: candidate.literal.snapshotBytes)
            try await reloadedStore.publish(nodeId: nodeId, prepared: reloadedPrepared)
            try await installAcceptedRichLiteral(
                reloadedStore,
                workspaceId: workspaceId,
                nodeId: nodeId,
                prepared: reloadedPrepared,
                storageVersion: candidate.literal.route.storageVersion
            )
            let reloaded = try await richEditable(
                reloadedStore,
                nodeId: nodeId,
                storageVersion: candidate.literal.route.storageVersion
            )
            XCTAssertEqual(reloaded.document.semantic, proposed, fixture.id)
            try assertReferenceContract(in: reloaded.document.semantic, fixtureId: fixture.id)
        }
    }

    private func assertReferenceContract(
        in semantic: LoroCanonicalSemanticValueV1,
        fixtureId: String
    ) throws {
        let runs = semantic.blocks.flatMap { block -> [LoroCanonicalSemanticValueV1.TextRun] in
            switch block {
            case let .paragraph(value): return value
            case let .heading(_, value): return value
            case let .taskList(items): return items.flatMap(\.runs)
            }
        }
        let referenceRun = try XCTUnwrap(runs.first(where: { $0.reference != nil }), fixtureId)
        let reference = try XCTUnwrap(referenceRun.reference, fixtureId)

        switch fixtureId {
        case "entity-reference-surrounding-edit":
            XCTAssertEqual(reference.kind, .entity)
            XCTAssertEqual(reference.id, try EntityId(validating: "10000000-0000-4000-8000-000000000001"))
            XCTAssertEqual(reference.label, "Alice")
            XCTAssertEqual(referenceRun.text, "Alice")
            XCTAssertEqual(referenceRun.marks, [.strong])
        case "supertag-reference-surrounding-edit":
            XCTAssertEqual(reference.kind, .supertag)
            XCTAssertEqual(reference.id, try EntityId(validating: "10000000-0000-4000-8000-000000000002"))
            XCTAssertEqual(reference.label, "Project")
            XCTAssertEqual(referenceRun.text, "Project")
            XCTAssertEqual(referenceRun.marks, [.emphasis])
        default:
            XCTFail("unexpected reference fixture \(fixtureId)")
        }
    }

    private func expectedSemantic(
        for fixtureId: String,
        proposed: Bool
    ) throws -> LoroCanonicalSemanticValueV1 {
        let reference: LoroCanonicalSemanticValueV1.InlineReference
        let before: String
        let after: String
        let marks: [LoroCanonicalSemanticValueV1.Mark]
        let text: String

        switch fixtureId {
        case "entity-reference-surrounding-edit":
            reference = .init(
                kind: .entity,
                id: try EntityId(validating: "10000000-0000-4000-8000-000000000001"),
                label: "Alice"
            )
            before = proposed ? "Met with " : "Met "
            after = proposed ? " today." : " today"
            marks = [.strong]
            text = "Alice"
        case "supertag-reference-surrounding-edit":
            reference = .init(
                kind: .supertag,
                id: try EntityId(validating: "10000000-0000-4000-8000-000000000002"),
                label: "Project"
            )
            before = proposed ? "Review the " : "Review "
            after = proposed ? " scope today." : " scope"
            marks = [.emphasis]
            text = "Project"
        default:
            throw CrossClientJoinError.unknownFixture
        }

        return try .init(blocks: [
            .paragraph([
                .init(text: before),
                .init(text: text, marks: marks, reference: reference),
                .init(text: after)
            ])
        ]).validated()
    }

    private func richEditable(
        _ store: LoroPageDocumentStore,
        nodeId: EntityId,
        storageVersion: Int
    ) async throws -> NativeRichLoroEditableV1 {
        let publishedState = try await store.publishedState(nodeId: nodeId)
        let state = try XCTUnwrap(publishedState)
        let replica = LoroPageReplicaWitness(
            snapshotSHA256: state.localSnapshotSHA256,
            versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: state.versionBytes)
        )
        return try await store.nativeRichLoroEditableV1(
            nodeId: nodeId,
            route: .init(
                nodeId: nodeId,
                format: .loroV1,
                storageVersion: storageVersion,
                schemaVersion: 1,
                snapshotSHA256: state.localSnapshotSHA256
            ),
            persistedReplica: replica,
            publishedReplica: replica,
            isDirty: false
        )
    }

    private func installAcceptedRichLiteral(
        _ documents: LoroPageDocumentStore,
        workspaceId: EntityId,
        nodeId: EntityId,
        prepared: LoroPreparedPageState,
        storageVersion: Int = 1
    ) async throws {
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        try await local.upsertNode(
            .init(
                id: nodeId,
                workspaceId: workspaceId,
                title: "cross-client native rich fixture",
                createdAt: try IsoDateTimeString(validating: "2026-08-30T00:00:00Z")
            ),
            dirty: false
        )
        try await local.upsertLoroPage(.init(
            prepared: prepared,
            dirty: false,
            observedDescriptorStorageVersion: storageVersion,
            observedDescriptorSnapshotSHA256: prepared.localSnapshotSHA256
        ))
        let acceptedEvidence = try await local.acceptedLoroPageEvidence(workspaceId: workspaceId, nodeId: nodeId)
        let evidence = try XCTUnwrap(acceptedEvidence)
        try await documents.installAcceptedRichLiteral(evidence)
    }

    private static func checkedInWebCorpus() throws -> CheckedInNativeRichSourceCorpus {
        let testFile = URL(fileURLWithPath: #filePath)
        let corpusURL = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("packages/web/src/fixtures/native-rich-loro-v1-source-corpus.json")
        return try JSONDecoder().decode(CheckedInNativeRichSourceCorpus.self, from: Data(contentsOf: corpusURL))
    }

    private func entityId() throws -> EntityId {
        try EntityId(validating: UUID().uuidString.lowercased())
    }
}

private struct CheckedInNativeRichSourceCorpus: Decodable {
    let format: String
    let corpusVersion: Int
    let cases: [Case]

    struct Case: Decodable {
        let id: String
        let classification: String
        let baseSnapshotBase64: String
    }
}

private enum CrossClientJoinError: Error {
    case unknownFixture
}
