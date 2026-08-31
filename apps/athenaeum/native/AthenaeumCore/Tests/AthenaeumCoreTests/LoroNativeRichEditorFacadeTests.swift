import XCTest
import Loro
import AthenaeumDomain
@testable import AthenaeumCore

final class LoroNativeRichEditorFacadeTests: XCTestCase {
    func testCanonicalTaskListAcceptsCheckedUncheckedEmptyAndAdjacentMarkedReferences() throws {
        let id = try EntityId(validating: "00000000-0000-4000-8000-000000000001")
        let reference = LoroCanonicalSemanticValueV1.InlineReference(kind: .supertag, id: id, label: "Project")
        let value = LoroCanonicalSemanticValueV1(blocks: [
            .paragraph([.init(text: "Before")]),
            .taskList([
                .init(checked: true, runs: [.init(text: "Done", marks: [.strong])]),
                .init(checked: false, runs: [.init(text: "Project", marks: [.emphasis], reference: reference)]),
                .init(checked: false, runs: [])
            ]),
            .paragraph([.init(text: "After")])
        ])
        XCTAssertEqual(try value.validated(), value)
    }

    func testCanonicalTaskListRejectsEmptyListNestedRunsAndNoncanonicalRuns() {
        XCTAssertThrowsError(try LoroCanonicalSemanticValueV1(blocks: [.taskList([])]).validated())
        XCTAssertThrowsError(try LoroCanonicalSemanticValueV1(blocks: [.taskList([
            .init(checked: false, runs: [.init(text: "A"), .init(text: "B")])
        ])]).validated())
        XCTAssertThrowsError(try LoroCanonicalSemanticValueV1(blocks: [.taskList([
            .init(checked: false, runs: [.init(text: "A", marks: [.strong, .code])])
        ])]).validated())
        XCTAssertThrowsError(try LoroCanonicalSemanticValueV1(blocks: [.taskList([
            .init(checked: false, runs: [.init(text: "A\nB")])
        ])]).validated())
    }

    func testCanonicalValueAcceptsOrderedBlocksMarksAndUnicode() throws {
        let value = LoroCanonicalSemanticValueV1(blocks: [
            .paragraph([.init(text: "e\u{301} 😀", marks: [.code, .emphasis, .strong])]),
            .heading(level: 3, runs: [.init(text: "Heading", marks: [.strong])])
        ])
        XCTAssertEqual(try value.validated(), value)
    }

    func testCanonicalValueAcceptsValueOnlyInlineReferenceAndCountsItsPayload() throws {
        let id = try EntityId(validating: "00000000-0000-4000-8000-000000000001")
        let reference = LoroCanonicalSemanticValueV1.InlineReference(kind: .entity, id: id, label: "Alice")
        let value = LoroCanonicalSemanticValueV1(blocks: [.paragraph([.init(text: "Alice", marks: [.strong], reference: reference)])])
        XCTAssertEqual(try value.validated(), value)
        XCTAssertThrowsError(try LoroCanonicalSemanticValueV1(blocks: [.paragraph([.init(text: "Alias", reference: reference)])]).validated())
        let oversized = LoroCanonicalSemanticValueV1.InlineReference(kind: .supertag, id: id, label: String(repeating: "x", count: 501))
        XCTAssertThrowsError(try LoroCanonicalSemanticValueV1(blocks: [.paragraph([.init(text: String(repeating: "x", count: 501), reference: oversized)])]).validated())
    }

    func testCanonicalValueRejectsAdjacentEqualMarksMalformedAndBounds() {
        XCTAssertThrowsError(try LoroCanonicalSemanticValueV1(blocks: [.paragraph([.init(text: "a"), .init(text: "b")])]).validated())
        XCTAssertThrowsError(try LoroCanonicalSemanticValueV1(blocks: [.heading(level: 4, runs: [.init(text: "x")])]).validated())
        XCTAssertThrowsError(try LoroCanonicalSemanticValueV1(blocks: [.paragraph([.init(text: "x", marks: [.strong, .code])])]).validated())
        XCTAssertThrowsError(try LoroCanonicalSemanticValueV1(blocks: Array(repeating: .paragraph([.init(text: "x")]), count: LoroPageProjectionLimits().maxChildren + 1)).validated())
        let marks: [[LoroCanonicalSemanticValueV1.Mark]] = [[], [.strong], [.emphasis], [.code], [.code, .strong], [.code, .emphasis], [.emphasis, .strong], [.code, .emphasis, .strong]]
        let runs: [LoroCanonicalSemanticValueV1.TextRun] = (0...LoroPageProjectionLimits().maxTextRuns).map { .init(text: "x", marks: marks[$0 % marks.count]) }
        XCTAssertThrowsError(try LoroCanonicalSemanticValueV1(blocks: [.paragraph(runs)]).validated())
        XCTAssertThrowsError(try LoroCanonicalSemanticValueV1(blocks: [.paragraph([.init(text: String(repeating: "x", count: LoroPageProjectionLimits().maxUTF8Bytes + 1))])]).validated())
    }

    func testCanonicalValueRejectsLineFeedAndCarriageReturnInsideAnyTextRun() {
        for separator in ["\n", "\r"] {
            let value = LoroCanonicalSemanticValueV1(blocks: [
                .paragraph([.init(text: "before\(separator)after", marks: [.strong])])
            ])
            XCTAssertThrowsError(try value.validated()) { error in
                XCTAssertEqual(error as? LoroNativeRichEditorError, .malformed)
            }
        }
    }

    func testRichCandidateMintsFromAcceptedLiteralAndPreservesSemanticValue() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let route = fixture.candidate.route
        let replica = LoroPageReplicaWitness(snapshotSHA256: route.snapshotSHA256, versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: fixture.candidate.checkpoint.baseVersionVector))
        let reference = try EntityId(validating: "00000000-0000-4000-8000-000000000001")
        let semantic = LoroCanonicalSemanticValueV1(blocks: [
            .paragraph([.init(text: "Alice", marks: [.strong], reference: .init(kind: .entity, id: reference, label: "Alice")), .init(text: " bold", marks: [.strong])]),
            .heading(level: 2, runs: [.init(text: "e\u{301} 😀", marks: [.code, .emphasis])])
        ])
        let forged = LoroPageReplicaWitness(snapshotSHA256: replica.snapshotSHA256, versionVectorSHA256: String(repeating: "0", count: 64))
        do {
            _ = try await fixture.documents.prepareNativeRichSemanticCandidateV1(nodeId: fixture.node, route: route, persistedReplica: forged, publishedReplica: forged, isDirty: false, workspaceId: fixture.workspace, intent: try .init(requestId: "forged", commitMessage: "rich", attribution: .humanUi(surface: "macos")), proposed: .init(semantic: semantic))
            XCTFail("forged version witness must fail before candidate compilation")
        } catch { XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativePlainTextWitnessMismatch) }
        let minted = try await fixture.documents.prepareNativeRichSemanticCandidateV1(
            nodeId: fixture.node, route: route, persistedReplica: replica, publishedReplica: replica,
            isDirty: false, workspaceId: fixture.workspace,
            intent: try .init(requestId: "rich", commitMessage: "rich", attribution: .humanUi(surface: "macos")),
            proposed: .init(semantic: semantic)
        )
        XCTAssertEqual(minted.semantic, semantic)
        XCTAssertNotEqual(minted.baseSnapshot, minted.literal.snapshotBytes)
        let document = LoroDoc()
        _ = try document.import(bytes: minted.literal.snapshotBytes)
        var projector = LoroPageProjector(limits: .init())
        XCTAssertEqual(try projector.project(document), .document([
            .paragraph([.text("Alice", marks: [.strong, .unsupported]), .text(" bold", marks: [.strong])]),
            .heading(level: 2, children: [.text("e\u{301} 😀", marks: [.emphasis, .code])])
        ]))
        do {
            _ = try await fixture.documents.prepareNativeRichSemanticCandidateV1(
                nodeId: fixture.node, route: route, persistedReplica: replica, publishedReplica: replica,
                isDirty: false, workspaceId: fixture.workspace,
                intent: try .init(requestId: "same", commitMessage: "rich", attribution: .humanUi(surface: "macos")),
                proposed: .init(semantic: LoroCanonicalSemanticValueV1(blocks: [.paragraph([])]))
            )
            XCTFail("empty rich semantic value is a no-op")
        } catch {}
    }

    func testTaskListRichCandidateRoundTripsCheckedStateEmptyItemMarksAndReference() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let id = try EntityId(validating: "00000000-0000-4000-8000-000000000001")
        let semantic = LoroCanonicalSemanticValueV1(blocks: [
            .paragraph([.init(text: "Before")]),
            .taskList([
                .init(checked: true, runs: [.init(text: "Done", marks: [.strong])]),
                .init(checked: false, runs: [.init(text: "Project", marks: [.emphasis], reference: .init(kind: .supertag, id: id, label: "Project"))]),
                .init(checked: false, runs: [])
            ]),
            .paragraph([.init(text: "After")])
        ])
        let candidate = try await mintRichCandidate(fixture, requestId: "task-list", semantic: semantic)
        XCTAssertEqual(candidate.semantic, semantic)
        let document = LoroDoc()
        _ = try document.import(bytes: candidate.literal.snapshotBytes)
        let root = document.getMap(id: "athenaeum-prosemirror-v1")
        let children = try XCTUnwrap(root.get(key: "children")?.asLoroList())
        let task = try XCTUnwrap(children.get(index: 1)?.asLoroMap())
        XCTAssertEqual(task.get(key: "nodeName")?.asValue(), .string(value: "task_list"))
        let items = try XCTUnwrap(task.get(key: "children")?.asLoroList())
        XCTAssertEqual(items.len(), 3)
        XCTAssertEqual(items.get(index: 0)?.asLoroMap()?.get(key: "attributes")?.asLoroMap()?.get(key: "checked")?.asValue(), .bool(value: true))
        XCTAssertEqual(items.get(index: 1)?.asLoroMap()?.get(key: "attributes")?.asLoroMap()?.get(key: "checked")?.asValue(), .bool(value: false))
    }

    func testTaskToggleCandidateMutatesOnlyWitnessedCheckedStateFromAcceptedLiteral() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let semantic = LoroCanonicalSemanticValueV1(blocks: [.taskList([
            .init(checked: false, runs: [.init(text: "one")]),
            .init(checked: true, runs: [.init(text: "two", marks: [.strong])]),
        ])])
        let baseReplica = LoroPageReplicaWitness(
            snapshotSHA256: fixture.candidate.route.snapshotSHA256,
            versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: fixture.candidate.checkpoint.baseVersionVector)
        )
        let rich = try await fixture.documents.prepareNativeRichSemanticCandidateV1(
            nodeId: fixture.node,
            route: fixture.candidate.route,
            persistedReplica: baseReplica,
            publishedReplica: baseReplica,
            isDirty: false,
            workspaceId: fixture.workspace,
            intent: try .init(requestId: "task-base", commitMessage: "task base", attribution: .humanUi(surface: "macos")),
            proposed: .init(semantic: semantic)
        )
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: rich.literal.snapshotBytes)
        try await fixture.local.upsertLoroPage(.init(
            prepared: prepared,
            dirty: false,
            observedDescriptorStorageVersion: rich.literal.route.storageVersion,
            observedDescriptorSnapshotSHA256: rich.literal.route.snapshotSHA256
        ))
        let maybeEvidence = try await fixture.local.acceptedLoroPageEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let evidence = try XCTUnwrap(maybeEvidence)
        try await fixture.documents.installAcceptedRichLiteral(evidence)
        let replica = LoroPageReplicaWitness(
            snapshotSHA256: rich.literal.route.snapshotSHA256,
            versionVectorSHA256: rich.literal.versionVectorSHA256
        )
        let command = LoroNativeRichTaskItemToggleCommand(
            commandID: UUID(uuidString: "00000000-0000-4000-8000-000000000099")!,
            editorGeneration: 1,
            taskListIndex: 0,
            itemIndex: 0,
            expectedItem: semantic.blocks.first.flatMap { block in
                guard case let .taskList(items) = block else { return nil }
                return items.first
            }!
        )
        let toggled = try await fixture.documents.prepareNativeRichTaskToggleCandidateV1(
            nodeId: fixture.node,
            route: rich.literal.route,
            persistedReplica: replica,
            publishedReplica: replica,
            isDirty: false,
            workspaceId: fixture.workspace,
            intent: try .init(requestId: command.commandID.uuidString, commitMessage: "toggle task", attribution: .humanUi(surface: "macos")),
            command: command
        )
        XCTAssertEqual(toggled.semantic, .init(blocks: [.taskList([
            .init(checked: true, runs: [.init(text: "one")]),
            .init(checked: true, runs: [.init(text: "two", marks: [.strong])]),
        ])]))
        let toggledDocument = LoroDoc()
        _ = try toggledDocument.import(bytes: toggled.literal.snapshotBytes)
        let taskList = try XCTUnwrap(toggledDocument.getMap(id: "athenaeum-prosemirror-v1").get(key: "children")?.asLoroList()?.get(index: 0)?.asLoroMap())
        let items = try XCTUnwrap(taskList.get(key: "children")?.asLoroList())
        XCTAssertEqual(items.get(index: 0)?.asLoroMap()?.get(key: "attributes")?.asLoroMap()?.get(key: "checked")?.asValue(), .bool(value: true))
        XCTAssertEqual(items.get(index: 1)?.asLoroMap()?.get(key: "attributes")?.asLoroMap()?.get(key: "checked")?.asValue(), .bool(value: true))

        let stale = LoroNativeRichTaskItemToggleCommand(
            commandID: UUID(), editorGeneration: 1, taskListIndex: 0, itemIndex: 0,
            expectedItem: .init(checked: true, runs: [.init(text: "wrong")])
        )
        do {
            _ = try await fixture.documents.prepareNativeRichTaskToggleCandidateV1(
                nodeId: fixture.node, route: rich.literal.route, persistedReplica: replica, publishedReplica: replica,
                isDirty: false, workspaceId: fixture.workspace,
                intent: try .init(requestId: "stale", commitMessage: "toggle task", attribution: .humanUi(surface: "macos")), command: stale
            )
            XCTFail("stale item fingerprint must be rejected")
        } catch {
            XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativePlainTextWitnessMismatch)
        }
    }

    func testSameFlattenedTextWithDifferentRichStructureIsNotEqual() throws {
        let paragraph = LoroCanonicalSemanticValueV1(blocks: [.paragraph([.init(text: "same", marks: [.strong])])])
        let heading = LoroCanonicalSemanticValueV1(blocks: [.heading(level: 1, runs: [.init(text: "same", marks: [.code])])])
        XCTAssertNotEqual(try paragraph.validated(), try heading.validated())
    }

    func testAcceptancePredicateRejectsSameTextWithDifferentRichMarksAndBlocks() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let expected = LoroCanonicalSemanticValueV1(blocks: [.paragraph([.init(text: "same", marks: [.strong])])])
        let different = LoroCanonicalSemanticValueV1(blocks: [.heading(level: 1, runs: [.init(text: "same", marks: [.code])])])
        let matches = await fixture.machine.matchesAcceptedSemanticResult(
            proofRoute: fixture.candidate.literal.route, proofSemantic: different,
            proofVersionVectorSHA256: fixture.candidate.literal.versionVectorSHA256,
            expectedRoute: fixture.candidate.literal.route, expectedSemantic: expected,
            expectedVersionVectorSHA256: fixture.candidate.literal.versionVectorSHA256
        )
        XCTAssertFalse(matches)
    }

    func testRichCandidateTraversesFrozenV7ReceiptReloadAndSemanticAcceptance() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let acceptedRichSemantic = LoroCanonicalSemanticValueV1(blocks: [
            .paragraph([.init(text: "accepted", marks: [.strong])])
        ])
        let acceptedRich = try await mintRichCandidate(fixture, requestId: "rich-base", semantic: acceptedRichSemantic)
        try await fixture.local.persistFrozenLiteralCandidate(actorIssued: acceptedRich)
        try await fixture.local.acceptFrozenLiteralCandidate(actorIssued: acceptedRich, dispatched: acceptedRich.checkpoint)
        let acceptedEvidence = try await fixture.local.acceptedLoroPageEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        try await fixture.documents.installAcceptedRichLiteral(try XCTUnwrap(acceptedEvidence))
        let semantic = LoroCanonicalSemanticValueV1(blocks: [
            .paragraph([.init(text: "same", marks: [.strong])]),
            .heading(level: 2, runs: [.init(text: "heading", marks: [.code, .emphasis])])
        ])
        let richReplica = LoroPageReplicaWitness(
            snapshotSHA256: acceptedRich.literal.localSnapshotSHA256,
            versionVectorSHA256: acceptedRich.literal.versionVectorSHA256
        )
        let rich = try await fixture.documents.prepareNativeRichSemanticCandidateV1(
            nodeId: fixture.node,
            route: acceptedRich.literal.route,
            persistedReplica: richReplica,
            publishedReplica: richReplica,
            isDirty: false,
            workspaceId: fixture.workspace,
            intent: try .init(requestId: "rich-accept", commitMessage: "rich", attribution: .humanUi(surface: "macos")),
            proposed: .init(semantic: semantic)
        )

        await fixture.fake.acceptSubmittedIntent()
        let outcome = try await fixture.machine.submit(rich)
        XCTAssertEqual(outcome, .committed)

        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let acceptedValue = try await fixture.local.loroPage(nodeId: fixture.node)
        let publishedValue = try await fixture.documents.publishedState(nodeId: fixture.node)
        let accepted = try XCTUnwrap(acceptedValue)
        let published = try XCTUnwrap(publishedValue)
        XCTAssertNil(checkpoint)
        XCTAssertEqual(accepted.snapshotBytes, rich.literal.snapshotBytes)
        XCTAssertEqual(published.snapshotBytes, rich.literal.snapshotBytes)
        XCTAssertEqual(accepted.observedDescriptorSnapshotSHA256, rich.literal.route.snapshotSHA256)
        let archiveCount = try SQLite3Connection(path: fixture.local.path).query(
            "SELECT COUNT(*) FROM loro_semantic_checkpoint_archive_v7 WHERE workspace_id=? AND node_id=? AND request_id=?;",
            [.text(fixture.workspace.rawValue), .text(fixture.node.rawValue), .text(rich.intent.requestId)]
        ) { Int(columnInt($0, 0)) }.first
        XCTAssertEqual(archiveCount, 1)
        let reloads = await fixture.fake.reloadCalls()
        XCTAssertEqual(reloads.count, 1)
        XCTAssertEqual(reloads.first?.0, fixture.workspace)
        XCTAssertEqual(reloads.first?.1, fixture.node)
    }

    func testRichAcceptanceSemanticMismatchRetainsCandidateWithoutPublishing() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let expected = LoroCanonicalSemanticValueV1(blocks: [.paragraph([.init(text: "same", marks: [.strong])])])
        let different = LoroCanonicalSemanticValueV1(blocks: [.heading(level: 1, runs: [.init(text: "same", marks: [.code])])])
        let rich = try await mintRichCandidate(fixture, requestId: "rich-semantic-mismatch", semantic: expected)
        await fixture.machine.installTestOnlyProofTransform { proof in
            .init(route: proof.route, versionVector: proof.versionVector, versionVectorSHA256: proof.versionVectorSHA256, text: "same", semantic: different)
        }
        await fixture.fake.acceptSubmittedIntent()

        let outcome = try await fixture.machine.submit(rich)
        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let frozen = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let page = try await fixture.local.loroPage(nodeId: fixture.node)
        let published = try await fixture.documents.publishedState(nodeId: fixture.node)
        XCTAssertEqual(outcome, .retainedRetry)
        XCTAssertEqual(checkpoint?.state, .retainedRetry)
        XCTAssertEqual(frozen?.snapshot, rich.literal.snapshotBytes)
        XCTAssertEqual(page?.snapshotBytes, fixture.baseSnapshot)
        XCTAssertNil(published)
        let reloads = await fixture.fake.reloadCalls()
        XCTAssertEqual(reloads.count, 1)
        XCTAssertEqual(reloads.first?.0, fixture.workspace)
        XCTAssertEqual(reloads.first?.1, fixture.node)
        let archiveCount = try SQLite3Connection(path: fixture.local.path).query(
            "SELECT COUNT(*) FROM loro_semantic_checkpoint_archive_v7 WHERE workspace_id=? AND node_id=?;",
            [.text(fixture.workspace.rawValue), .text(fixture.node.rawValue)]
        ) { Int(columnInt($0, 0)) }.first
        XCTAssertEqual(archiveCount, 0)
    }

    func testRichRouteSnapshotDigestMismatchRetainsCandidateWithoutPublishing() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let rich = try await mintRichCandidate(
            fixture, requestId: "rich-route-digest-mismatch",
            semantic: .init(blocks: [.paragraph([.init(text: "digest", marks: [.emphasis])])])
        )
        await fixture.fake.acceptSubmittedIntent()
        await fixture.fake.tamperAcceptedSubmissionAuthority(.routeClaimsCandidateSnapshotForDifferentBytes)

        let outcome = try await fixture.machine.submit(rich)
        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let frozen = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let page = try await fixture.local.loroPage(nodeId: fixture.node)
        let published = try await fixture.documents.publishedState(nodeId: fixture.node)
        XCTAssertEqual(outcome, .retainedRetry)
        XCTAssertEqual(checkpoint?.state, .retainedRetry)
        XCTAssertEqual(frozen?.snapshot, rich.literal.snapshotBytes)
        XCTAssertEqual(page?.snapshotBytes, fixture.baseSnapshot)
        XCTAssertNil(published)
        let reloads = await fixture.fake.reloadCalls()
        XCTAssertEqual(reloads.count, 1)
        XCTAssertEqual(reloads.first?.0, fixture.workspace)
        XCTAssertEqual(reloads.first?.1, fixture.node)
        let archiveCount = try SQLite3Connection(path: fixture.local.path).query(
            "SELECT COUNT(*) FROM loro_semantic_checkpoint_archive_v7 WHERE workspace_id=? AND node_id=?;",
            [.text(fixture.workspace.rawValue), .text(fixture.node.rawValue)]
        ) { Int(columnInt($0, 0)) }.first
        XCTAssertEqual(archiveCount, 0)
    }

    private func mintRichCandidate(
        _ fixture: LoroSemanticCheckpointStateMachineTests.Fixture,
        requestId: String,
        semantic: LoroCanonicalSemanticValueV1
    ) async throws -> LoroFrozenLiteralCandidate {
        let replica = LoroPageReplicaWitness(
            snapshotSHA256: fixture.candidate.route.snapshotSHA256,
            versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: fixture.candidate.checkpoint.baseVersionVector)
        )
        return try await fixture.documents.prepareNativeRichSemanticCandidateV1(
            nodeId: fixture.node,
            route: fixture.candidate.route,
            persistedReplica: replica,
            publishedReplica: replica,
            isDirty: false,
            workspaceId: fixture.workspace,
            intent: try .init(requestId: requestId, commitMessage: "rich", attribution: .humanUi(surface: "macos")),
            proposed: .init(semantic: semantic)
        )
    }

    func testRichMintUsesDistinctProductionPeersNotR0CorpusPeer() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let route = fixture.candidate.route
        let replica = LoroPageReplicaWitness(snapshotSHA256: route.snapshotSHA256, versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: fixture.candidate.checkpoint.baseVersionVector))
        func mint(_ id: String) async throws -> LoroFrozenLiteralCandidate {
            return try await fixture.documents.prepareNativeRichSemanticCandidateV1(
                nodeId: fixture.node, route: route, persistedReplica: replica, publishedReplica: replica,
                isDirty: false, workspaceId: fixture.workspace,
                intent: try .init(requestId: id, commitMessage: "rich", attribution: .humanUi(surface: "macos")),
                proposed: .init(semantic: .init(blocks: [.paragraph([.init(text: id, marks: [.strong])])]))
            )
        }
        let first = try await mint("one"), second = try await mint("two")
        let base = try VersionVector.decode(bytes: fixture.candidate.checkpoint.baseVersionVector).toHashmap().map { $0.key }
        let firstPeers = Set(try VersionVector.decode(bytes: first.literal.versionBytes).toHashmap().map { $0.key }).subtracting(base)
        let secondPeers = Set(try VersionVector.decode(bytes: second.literal.versionBytes).toHashmap().map { $0.key }).subtracting(base)
        XCTAssertEqual(firstPeers.count, 1); XCTAssertEqual(secondPeers.count, 1)
        XCTAssertNotEqual(firstPeers, secondPeers)
        XCTAssertFalse(firstPeers.contains(424242)); XCTAssertFalse(secondPeers.contains(424242))
    }

    func testAcceptedRichBaseInstallsOnlyThroughRichSeamThenMintsNextRichCandidate() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let route = fixture.candidate.route
        let replica = LoroPageReplicaWitness(snapshotSHA256: route.snapshotSHA256, versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: fixture.candidate.checkpoint.baseVersionVector))
        let firstSemantic = LoroCanonicalSemanticValueV1(blocks: [.heading(level: 1, runs: [.init(text: "same", marks: [.strong])])])
        let first = try await fixture.documents.prepareNativeRichSemanticCandidateV1(
            nodeId: fixture.node, route: route, persistedReplica: replica, publishedReplica: replica, isDirty: false,
            workspaceId: fixture.workspace, intent: try .init(requestId: "rich-base", commitMessage: "rich", attribution: .humanUi(surface: "macos")), proposed: .init(semantic: firstSemantic))
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: first.literal.snapshotBytes)
        try await fixture.local.upsertLoroPage(.init(prepared: prepared, dirty: false, observedDescriptorStorageVersion: first.literal.route.storageVersion, observedDescriptorSnapshotSHA256: first.literal.route.snapshotSHA256))
        let maybeEvidence = try await fixture.local.acceptedLoroPageEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let evidence = try XCTUnwrap(maybeEvidence)

        let legacy = LoroPageDocumentStore()
        do { try await legacy.installAcceptedLiteral(evidence); XCTFail("legacy plain installation must reject a rich base") }
        catch { XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativePlainTextIneligible) }

        let rich = LoroPageDocumentStore()
        try await rich.installAcceptedRichLiteral(evidence)
        let richReplica = LoroPageReplicaWitness(snapshotSHA256: prepared.localSnapshotSHA256, versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: prepared.versionBytes))
        let second = try await rich.prepareNativeRichSemanticCandidateV1(
            nodeId: fixture.node, route: first.literal.route, persistedReplica: richReplica, publishedReplica: richReplica, isDirty: false,
            workspaceId: fixture.workspace, intent: try .init(requestId: "rich-next", commitMessage: "rich", attribution: .humanUi(surface: "macos")),
            proposed: .init(semantic: .init(blocks: [.paragraph([.init(text: "same", marks: [.code])])]))
        )
        XCTAssertNotEqual(first.semantic, second.semantic)
    }

    func testClosedWorldRichProbeRejectsUnsupportedNodesAndMalformedHeadingBeforeMinting() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        for name in ["bullet_list", "task_list", "blockquote", "code_block", "horizontal_rule", "unknown"] {
            let doc = LoroDoc(); _ = try doc.import(bytes: fixture.baseSnapshot)
            let root = doc.getMap(id: "athenaeum-prosemirror-v1")
            let children = try XCTUnwrap(root.get(key: "children")?.asLoroList())
            try children.delete(pos: 0, len: children.len())
            let node = try children.insertMapContainer(pos: 0, child: LoroMap())
            try node.insert(key: "nodeName", v: name)
            let attrs = try node.getOrCreateMapContainer(key: "attributes", child: LoroMap())
            try attrs.insert(key: "isAmgBlock", v: false)
            _ = try node.getOrCreateListContainer(key: "children", child: LoroList())
            doc.commit()
            do { _ = try await fixture.documents.validateNativeRichLoroCandidateV1(nodeId: fixture.node, snapshot: try doc.export(mode: .snapshot)); XCTFail("\(name) must reject before mint") }
            catch { XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativeRichTextIneligible) }
        }
        let malformedHeading = LoroDoc(); _ = try malformedHeading.import(bytes: fixture.baseSnapshot)
        let root = malformedHeading.getMap(id: "athenaeum-prosemirror-v1")
        let child = try XCTUnwrap(root.get(key: "children")?.asLoroList()?.get(index: 0)?.asLoroMap())
        try child.insert(key: "nodeName", v: "heading")
        try child.getOrCreateMapContainer(key: "attributes", child: LoroMap()).insert(key: "level", v: 4)
        malformedHeading.commit()
        do { _ = try await fixture.documents.validateNativeRichLoroCandidateV1(nodeId: fixture.node, snapshot: try malformedHeading.export(mode: .snapshot)); XCTFail("heading level four must reject") }
        catch { XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativeRichTextIneligible) }
        let extraHeading = LoroDoc(); _ = try extraHeading.import(bytes: fixture.baseSnapshot)
        let extraRoot = extraHeading.getMap(id: "athenaeum-prosemirror-v1")
        let extraChild = try XCTUnwrap(extraRoot.get(key: "children")?.asLoroList()?.get(index: 0)?.asLoroMap())
        try extraChild.insert(key: "nodeName", v: "heading")
        let extraAttrs = try extraChild.getOrCreateMapContainer(key: "attributes", child: LoroMap())
        try extraAttrs.insert(key: "level", v: 1); try extraAttrs.insert(key: "unknown", v: true)
        extraHeading.commit()
        do { _ = try await fixture.documents.validateNativeRichLoroCandidateV1(nodeId: fixture.node, snapshot: try extraHeading.export(mode: .snapshot)); XCTFail("heading extra attribute must reject") }
        catch { XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativeRichTextIneligible) }
    }

    func testRichProbeAcceptsEmptyMapMarksAndRejectsMalformedMarkAndAttributes() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        func marked(_ key: String = "strong", _ value: LoroValue) throws -> LoroDoc {
            let doc = LoroDoc(); _ = try doc.import(bytes: fixture.baseSnapshot)
            let styles = StyleConfigMap.defaultRichTextConfig(); styles.insert(key: "strong", value: styles.get(key: "bold")!); styles.insert(key: key, value: StyleConfig(expand: .none)); doc.configTextStyle(textStyle: styles)
            let root = doc.getMap(id: "athenaeum-prosemirror-v1")
            let paragraph = try XCTUnwrap(root.get(key: "children")?.asLoroList()?.get(index: 0)?.asLoroMap())
            let inline = try XCTUnwrap(paragraph.get(key: "children")?.asLoroList())
            let text = try inline.insertTextContainer(pos: 0, child: LoroText()); try text.pushStr(s: "x"); try text.mark(from: 0, to: 1, key: key, value: value); doc.commit(); return doc
        }
        let accepted = try marked("strong", .map(value: [:]))
        _ = try await fixture.documents.validateNativeRichLoroCandidateV1(nodeId: fixture.node, snapshot: try accepted.export(mode: .snapshot))
        let malformed = try marked("strong", .bool(value: true))
        do { _ = try await fixture.documents.validateNativeRichLoroCandidateV1(nodeId: fixture.node, snapshot: try malformed.export(mode: .snapshot)); XCTFail("bool mark payload must reject") }
        catch { XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativeRichTextIneligible) }
        for key in ["link", "entityRef", "supertagRef", "strike", "unknownMark"] {
            let rejected = try marked(key, .map(value: [:]))
            do { _ = try await fixture.documents.validateNativeRichLoroCandidateV1(nodeId: fixture.node, snapshot: try rejected.export(mode: .snapshot)); XCTFail("\(key) must reject") }
            catch { XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativeRichTextIneligible) }
        }
        let extra = LoroDoc(); _ = try extra.import(bytes: fixture.baseSnapshot)
        let root = extra.getMap(id: "athenaeum-prosemirror-v1")
        let paragraph = try XCTUnwrap(root.get(key: "children")?.asLoroList()?.get(index: 0)?.asLoroMap())
        try paragraph.getOrCreateMapContainer(key: "attributes", child: LoroMap()).insert(key: "link", v: "https://invalid")
        extra.commit()
        do { _ = try await fixture.documents.validateNativeRichLoroCandidateV1(nodeId: fixture.node, snapshot: try extra.export(mode: .snapshot)); XCTFail("extra attrs must reject") }
        catch { XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativeRichTextIneligible) }
    }

    func testRichProbeRejectsImportedGraphWithOnePastRunLimit() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let doc = LoroDoc(); _ = try doc.import(bytes: fixture.baseSnapshot)
        let styles = StyleConfigMap.defaultRichTextConfig(); styles.insert(key: "strong", value: styles.get(key: "bold")!); styles.insert(key: "em", value: styles.get(key: "italic")!); doc.configTextStyle(textStyle: styles)
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        let paragraph = try XCTUnwrap(root.get(key: "children")?.asLoroList()?.get(index: 0)?.asLoroMap())
        let inline = try XCTUnwrap(paragraph.get(key: "children")?.asLoroList())
        let text = try inline.insertTextContainer(pos: 0, child: LoroText())
        let count = LoroPageProjectionLimits().maxTextRuns + 1
        try text.pushStr(s: String(repeating: "x", count: count))
        for index in 0..<count {
            let start = UInt32(index), end = start + 1
            if index.isMultiple(of: 2) { try text.mark(from: start, to: end, key: "strong", value: LoroValue.map(value: [:])) }
        }
        doc.commit()
        do { _ = try await fixture.documents.validateNativeRichLoroCandidateV1(nodeId: fixture.node, snapshot: try doc.export(mode: .snapshot)); XCTFail("one-past rich run graph must reject") }
        catch { XCTAssertEqual(error as? LoroPageDocumentStoreError, .inputTooLarge) }
    }

    func testRichProbeRejectsImportedGraphWithOnePastBlockAndUTF8Limits() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let blockOverflow = LoroDoc(); _ = try blockOverflow.import(bytes: fixture.baseSnapshot)
        let root = blockOverflow.getMap(id: "athenaeum-prosemirror-v1")
        let children = try XCTUnwrap(root.get(key: "children")?.asLoroList())
        for index in 0..<LoroPageProjectionLimits().maxChildren {
            let paragraph = try children.insertMapContainer(pos: children.len(), child: LoroMap())
            try paragraph.insert(key: "nodeName", v: "paragraph")
            try paragraph.getOrCreateMapContainer(key: "attributes", child: LoroMap()).insert(key: "isAmgBlock", v: false)
            let inline = try paragraph.getOrCreateListContainer(key: "children", child: LoroList())
            let text = try inline.insertTextContainer(pos: 0, child: LoroText())
            try text.pushStr(s: "\(index)")
        }
        blockOverflow.commit()
        do { _ = try await fixture.documents.validateNativeRichLoroCandidateV1(nodeId: fixture.node, snapshot: try blockOverflow.export(mode: .snapshot)); XCTFail("one-past rich block graph must reject") }
        catch { XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativeRichTextIneligible) }

        let byteOverflow = LoroDoc(); _ = try byteOverflow.import(bytes: fixture.baseSnapshot)
        let byteRoot = byteOverflow.getMap(id: "athenaeum-prosemirror-v1")
        let paragraph = try XCTUnwrap(byteRoot.get(key: "children")?.asLoroList()?.get(index: 0)?.asLoroMap())
        let inline = try XCTUnwrap(paragraph.get(key: "children")?.asLoroList())
        let text = try inline.insertTextContainer(pos: 0, child: LoroText())
        try text.pushStr(s: String(repeating: "x", count: LoroPageProjectionLimits().maxUTF8Bytes + 1))
        byteOverflow.commit()
        do { _ = try await fixture.documents.validateNativeRichLoroCandidateV1(nodeId: fixture.node, snapshot: try byteOverflow.export(mode: .snapshot)); XCTFail("one-past UTF-8 graph must reject") }
        catch { XCTAssertEqual(error as? LoroPageDocumentStoreError, .inputTooLarge) }
    }
}
