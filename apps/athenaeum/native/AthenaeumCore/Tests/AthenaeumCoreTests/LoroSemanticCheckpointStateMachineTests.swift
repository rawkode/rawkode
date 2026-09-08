import XCTest
import Loro
import AthenaeumDomain
@testable import AthenaeumCore

final class LoroSemanticCheckpointStateMachineTests: XCTestCase {
    func testRuntimeExpiredCustodyDeniesBeforeCandidateOrTransport() async throws {
        let fixture = try await Fixture.make()
        let base = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: base)
        let gate = LoroNodeOperationGate()
        let expired = LoroSemanticCustody(workspaceId: fixture.workspace, intent: fixture.candidate.intent, expiresAt: Date(timeIntervalSinceNow: -1))
        let runtime = LoroSemanticRuntime(local: fixture.local, documents: fixture.documents, gate: gate, workspaceId: fixture.workspace, custody: expired, transport: fixture.fake)
        let outcome = try await runtime.replacePlainText(nodeId: fixture.node, scalarRange: 0..<0, replacement: "x")
        XCTAssertEqual(outcome, .deniedAuthorizationOrSession)
        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertNil(checkpoint)
        let calls = await fixture.fake.calls()
        XCTAssertTrue(calls.isEmpty)
    }
    func testRealLoroUpdatePersistsBeforeDispatchThenAcceptsFreshAuthorityAndPublishes() async throws {
        let fixture = try await Fixture.make()
        let committed = try await fixture.machine.submit(fixture.candidate)
        XCTAssertEqual(committed, .committed)
        let calls = await fixture.fake.calls()
        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let page = try await fixture.local.loroPage(nodeId: fixture.node)
        let published = try await fixture.documents.publishedState(nodeId: fixture.node)
        let observedDurable = await fixture.fake.observedDurableCandidate()
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].update, fixture.candidate.update)
        XCTAssertTrue(observedDurable)
        XCTAssertNil(checkpoint)
        XCTAssertFalse(try XCTUnwrap(page).dirty)
        XCTAssertEqual(page?.snapshotBytes, fixture.candidate.snapshot)
        XCTAssertEqual(published?.snapshotBytes, fixture.candidate.snapshot)
    }

    func testExactAcceptedFlowArchivesImmutableEvidenceAndLeavesTerminalNonDispatchable() async throws {
        let fixture = try await Fixture.make()
        let outcome = try await fixture.machine.submit(fixture.candidate)

        XCTAssertEqual(outcome, .committed)
        let working = try v7RawEvidence(
            path: fixture.local.path,
            table: "loro_semantic_candidates_v7",
            workspaceId: fixture.workspace,
            nodeId: fixture.node,
            requestId: fixture.candidate.intent.requestId
        )
        let archive = try v7RawEvidence(
            path: fixture.local.path,
            table: "loro_semantic_checkpoint_archive_v7",
            workspaceId: fixture.workspace,
            nodeId: fixture.node,
            requestId: fixture.candidate.intent.requestId
        )
        XCTAssertEqual(working.first, LoroSemanticCheckpointState.acceptedArchived.rawValue)
        XCTAssertEqual(archive.first, LoroSemanticCheckpointState.inFlight.rawValue)
        XCTAssertEqual(Array(working.dropFirst()), Array(archive.dropFirst()), "terminal marker may change state only")
        XCTAssertEqual(try archiveCount(fixture.local, workspaceId: fixture.workspace, nodeId: fixture.node), 1)
        let terminalCheckpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let terminalEvidence = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let terminalDisposition = try await fixture.local.loroCheckpointDisposition(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertNil(terminalCheckpoint)
        XCTAssertNil(terminalEvidence)
        XCTAssertEqual(terminalDisposition, .none)

        let callsBeforeRetry = await fixture.fake.calls()
        do {
            _ = try await fixture.machine.retry(workspaceId: fixture.workspace, nodeId: fixture.node)
            XCTFail("acceptedArchived must not be dispatchable")
        } catch {
            XCTAssertEqual(error as? LoroSemanticCheckpointStateMachineError, .retryNotAvailable)
        }
        let callsAfterRetry = await fixture.fake.calls()
        XCTAssertEqual(callsAfterRetry, callsBeforeRetry)
    }

    func testVerifiedTerminalReusePreservesPriorArchiveByteIdentity() async throws {
        let fixture = try await Fixture.make()
        let firstOutcome = try await fixture.machine.submit(fixture.candidate)
        XCTAssertEqual(firstOutcome, .committed)
        let firstArchive = try v7RawEvidence(
            path: fixture.local.path,
            table: "loro_semantic_checkpoint_archive_v7",
            workspaceId: fixture.workspace,
            nodeId: fixture.node,
            requestId: fixture.candidate.intent.requestId
        )
        let second = try await mintNextCandidate(fixture, requestId: "id-2", replacement: "!")
        let secondOutcome = try await fixture.machine.submit(second)
        XCTAssertEqual(secondOutcome, .committed)

        let firstArchiveAfter = try v7RawEvidence(
            path: fixture.local.path,
            table: "loro_semantic_checkpoint_archive_v7",
            workspaceId: fixture.workspace,
            nodeId: fixture.node,
            requestId: fixture.candidate.intent.requestId
        )
        XCTAssertEqual(firstArchiveAfter, firstArchive)
        XCTAssertEqual(try archiveCount(fixture.local, workspaceId: fixture.workspace, nodeId: fixture.node), 2)
        let working = try v7RawEvidence(
            path: fixture.local.path,
            table: "loro_semantic_candidates_v7",
            workspaceId: fixture.workspace,
            nodeId: fixture.node,
            requestId: second.intent.requestId
        )
        XCTAssertEqual(working.first, LoroSemanticCheckpointState.acceptedArchived.rawValue)
    }

    func testTerminalReuseRejectsArchiveCollisionAndCorruptionWithoutMutation() async throws {
        let collision = try await Fixture.make()
        let collisionAcceptance = try await collision.machine.submit(collision.candidate)
        XCTAssertEqual(collisionAcceptance, .committed)
        let beforeCollision = try v7RawEvidence(path: collision.local.path, table: "loro_semantic_candidates_v7", workspaceId: collision.workspace, nodeId: collision.node, requestId: collision.candidate.intent.requestId)
        let colliding = try await mintNextCandidate(collision, requestId: collision.candidate.intent.requestId, replacement: "!")
        do {
            _ = try await collision.machine.submit(colliding)
            XCTFail("an archive request id cannot be reused")
        } catch {
            XCTAssertEqual(error as? LoroSemanticCheckpointStateMachineError, .checkpointAlreadyExists)
        }
        XCTAssertEqual(try v7RawEvidence(path: collision.local.path, table: "loro_semantic_candidates_v7", workspaceId: collision.workspace, nodeId: collision.node, requestId: collision.candidate.intent.requestId), beforeCollision)
        XCTAssertEqual(try archiveCount(collision.local, workspaceId: collision.workspace, nodeId: collision.node), 1)

        let corrupted = try await Fixture.make()
        let corruptionAcceptance = try await corrupted.machine.submit(corrupted.candidate)
        XCTAssertEqual(corruptionAcceptance, .committed)
        let replacement = try await mintNextCandidate(corrupted, requestId: "id-2", replacement: "!")
        let connection = try SQLite3Connection(path: corrupted.local.path)
        try connection.run(
            "UPDATE loro_semantic_checkpoint_archive_v7 SET base_snapshot_sha256=? WHERE workspace_id=? AND node_id=? AND request_id=?;",
            [.text(String(repeating: "0", count: 64)), .text(corrupted.workspace.rawValue), .text(corrupted.node.rawValue), .text(corrupted.candidate.intent.requestId)]
        )
        let workingBefore = try v7RawEvidence(path: corrupted.local.path, table: "loro_semantic_candidates_v7", workspaceId: corrupted.workspace, nodeId: corrupted.node, requestId: corrupted.candidate.intent.requestId)
        let pageBefore = try await corrupted.local.loroPage(nodeId: corrupted.node)
        do {
            _ = try await corrupted.machine.submit(replacement)
            XCTFail("a corrupt terminal archive must block slot reuse")
        } catch {}
        XCTAssertEqual(try v7RawEvidence(path: corrupted.local.path, table: "loro_semantic_candidates_v7", workspaceId: corrupted.workspace, nodeId: corrupted.node, requestId: corrupted.candidate.intent.requestId), workingBefore)
        let pageAfter = try await corrupted.local.loroPage(nodeId: corrupted.node)
        XCTAssertEqual(pageAfter, pageBefore)
        XCTAssertEqual(try archiveCount(corrupted.local, workspaceId: corrupted.workspace, nodeId: corrupted.node), 1)
    }

    func testStrictlyCausallyNewerAuthorityIsRetainedWithoutMutation() async throws {
        let fixture = try await Fixture.make(freshAuthority: true)
        let outcome = try await fixture.machine.submit(fixture.candidate)

        XCTAssertEqual(outcome, .retainedRetry)
        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let page = try await fixture.local.loroPage(nodeId: fixture.node)
        let published = try await fixture.documents.publishedState(nodeId: fixture.node)
        let frozen = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertEqual(checkpoint?.state, .retainedRetry)
        XCTAssertEqual(page?.snapshotBytes, fixture.baseSnapshot)
        XCTAssertNil(published)
        XCTAssertEqual(frozen?.snapshot, fixture.candidate.snapshot)
        XCTAssertEqual(try archiveCount(fixture.local, workspaceId: fixture.workspace, nodeId: fixture.node), 0)
        XCTAssertGreaterThan(fixture.freshAuthority.route.storageVersion, fixture.candidate.route.storageVersion + 1)
        let includesCandidate = try await fixture.documents.versionVectorStrictlyIncludes(fixture.freshAuthority.versionVector, fixture.candidateResultVersionVector)
        XCTAssertTrue(includesCandidate)
    }

    func testCausallyNewerAuthorityRejectsReceiptWithTamperedCandidateResultWitness() async throws {
        for tamper in [ReceiptResultWitnessTamper.snapshot, .versionVector] {
            let fixture = try await Fixture.make(receiptResultWitnessTamper: tamper, freshAuthority: true)
            let outcome = try await fixture.machine.submit(fixture.candidate)
            let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
            let frozen = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
            let durable = try await fixture.local.loroPage(nodeId: fixture.node)
            let published = try await fixture.documents.publishedState(nodeId: fixture.node)

            XCTAssertEqual(outcome, LoroSemanticCheckpointOutcome.retainedRetry, "\(tamper)")
            XCTAssertEqual(checkpoint?.state, .retainedRetry, "\(tamper)")
            XCTAssertEqual(frozen?.snapshot, fixture.candidate.snapshot, "\(tamper)")
            XCTAssertEqual(durable?.snapshotBytes, fixture.baseSnapshot, "\(tamper)")
            XCTAssertNil(published, "\(tamper)")
        }
    }

    func testEveryReturnedReceiptReloadsCheckpointTargetBeforeReceiptClassification() async throws {
        let malformed = try await Fixture.make(receiptTampered: true)
        let mismatched = try await Fixture.make(receiptTargetMismatch: true)

        for fixture in [malformed, mismatched] {
            let outcome = try await fixture.machine.submit(fixture.candidate)
            let reloads = await fixture.fake.reloadCalls()
            let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
            let page = try await fixture.local.loroPage(nodeId: fixture.node)
            XCTAssertEqual(outcome, .retainedRetry)
            XCTAssertEqual(reloads.count, 1)
            XCTAssertEqual(reloads.first?.0, fixture.workspace)
            XCTAssertEqual(reloads.first?.1, fixture.node)
            XCTAssertEqual(checkpoint?.state, .retainedRetry)
            XCTAssertEqual(page?.snapshotBytes, fixture.baseSnapshot)
            XCTAssertEqual(try archiveCount(fixture.local, workspaceId: fixture.workspace, nodeId: fixture.node), 0)
        }
    }

    func testHigherStorageAuthorityWithoutCandidateHistoryRetainsFrozenCandidate() async throws {
        let fixture = try await Fixture.make(unrelatedAuthority: true)
        let outcome = try await fixture.machine.submit(fixture.candidate)

        XCTAssertEqual(outcome, .retainedRetry)
        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let frozen = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let oldAuthority = try await fixture.local.loroPage(nodeId: fixture.node)
        let published = try await fixture.documents.publishedState(nodeId: fixture.node)
        XCTAssertEqual(checkpoint?.state, .retainedRetry)
        XCTAssertEqual(frozen?.snapshot, fixture.candidate.snapshot)
        XCTAssertEqual(oldAuthority?.snapshotBytes, fixture.baseSnapshot)
        XCTAssertNil(published)
        let includesCandidate = try await fixture.documents.versionVectorStrictlyIncludes(fixture.unrelatedAuthority.versionVector, fixture.candidateResultVersionVector)
        XCTAssertFalse(includesCandidate)
    }

    func testDuplicateSubmitIsRejectedBeforeFakeCallAndRetryReplaysFrozenCheckpoint() async throws {
        let fixture = try await Fixture.make(error: .unknown)
        try await fixture.machine.submit(fixture.candidate)
        let retainedOptional = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let retained = try XCTUnwrap(retainedOptional)
        let persistedCandidateOptional = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let acceptedBaseOptional = try await fixture.local.loroPage(nodeId: fixture.node)
        let persistedCandidate = try XCTUnwrap(persistedCandidateOptional)
        let acceptedBase = try XCTUnwrap(acceptedBaseOptional)
        XCTAssertEqual(retained.state, .retainedRetry)
        XCTAssertEqual(acceptedBase.snapshotBytes, fixture.baseSnapshot)
        XCTAssertFalse(acceptedBase.dirty)
        XCTAssertEqual(persistedCandidate.snapshot, fixture.candidate.snapshot)
        XCTAssertNotEqual(persistedCandidate.snapshot, acceptedBase.snapshotBytes)
        XCTAssertEqual(persistedCandidate.expectedResultRoute.storageVersion, fixture.candidate.route.storageVersion + 1)
        XCTAssertEqual(persistedCandidate.resultVersionVectorSHA256, try VersionVectorIdentity.digest(encodedVersionVector: persistedCandidate.resultVersionVector))
        let reopened = try LocalWorkspaceStore(path: fixture.local.path)
        let reopenedCandidateOptional = try await reopened.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let reopenedBaseOptional = try await reopened.loroPage(nodeId: fixture.node)
        let reopenedCandidate = try XCTUnwrap(reopenedCandidateOptional)
        let reopenedBase = try XCTUnwrap(reopenedBaseOptional)
        XCTAssertEqual(reopenedCandidate, persistedCandidate)
        XCTAssertEqual(reopenedBase, acceptedBase)
        let firstCalls = await fixture.fake.calls()
        XCTAssertEqual(firstCalls.count, 1)
        XCTAssertEqual(firstCalls[0].state, .inFlight)
        XCTAssertEqual(firstCalls[0].intent, retained.intent)
        XCTAssertEqual(firstCalls[0].update, retained.update)

        do { try await fixture.machine.submit(fixture.candidate); XCTFail("expected duplicate rejection") }
        catch { XCTAssertEqual(error as? LoroSemanticCheckpointStateMachineError, .checkpointAlreadyExists) }
        let duplicateCalls = await fixture.fake.calls()
        XCTAssertEqual(duplicateCalls.count, 1)

        try await fixture.machine.retry(workspaceId: fixture.workspace, nodeId: fixture.node)
        let calls = await fixture.fake.calls()
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].intent, calls[1].intent)
        XCTAssertEqual(calls[0].update, calls[1].update)
        XCTAssertEqual(calls[0].baseVersionVectorSHA256, calls[1].baseVersionVectorSHA256)
        XCTAssertEqual(calls[1].state, .inFlight)
    }

    func testRetryTransitionsBeforeRemintThenRetainsWithoutTransportOnSemanticFailure() async throws {
        let fixture = try await Fixture.make(error: .unknown)
        _ = try await fixture.machine.submit(fixture.candidate)
        let callsBefore = await fixture.fake.calls()
        XCTAssertEqual(callsBefore.count, 1)

        // Keep the SQL row structurally valid while making its candidate snapshot incompatible
        // with its retained result vector. `beginRetry` must CAS first; remint then fails and
        // restores retainedRetry without allowing any candidate bytes to the transport.
        let connection = try SQLite3Connection(path: fixture.local.path)
        let baseHash = LoroMutationWire.sha256Hex(fixture.baseSnapshot)
        try connection.run("""
            UPDATE loro_semantic_candidates_v7
            SET candidate_snapshot=?, candidate_snapshot_sha256=?, expected_result_snapshot_sha256=?
            WHERE workspace_id=? AND node_id=?;
            """, [
                .blob(fixture.baseSnapshot), .text(baseHash), .text(baseHash),
                .text(fixture.workspace.rawValue), .text(fixture.node.rawValue)
            ])

        let outcome = try await fixture.machine.retry(workspaceId: fixture.workspace, nodeId: fixture.node)
        let retained = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let callsAfter = await fixture.fake.calls()
        XCTAssertEqual(outcome, .retainedRetry)
        XCTAssertEqual(retained?.state, .retainedRetry)
        XCTAssertEqual(callsAfter.count, callsBefore.count)
    }

    func testConflictsRemainRetainedAndTamperedReceiptRetainsCheckpoint() async throws {
        let conflict = try await Fixture.make(error: .contentConflict)
        let conflictOutcome = try await conflict.machine.submit(conflict.candidate)
        XCTAssertEqual(conflictOutcome, .retainedConflict)
        let conflictCheckpoint = try await conflict.local.loroCheckpoint(workspaceId: conflict.workspace, nodeId: conflict.node)
        XCTAssertEqual(conflictCheckpoint?.state, .retainedConflict)
        do {
            try await conflict.machine.discardAndReload(workspaceId: conflict.workspace, nodeId: conflict.node)
            XCTFail("v7 conflict evidence must not be deleted")
        } catch {
            XCTAssertEqual(error as? LoroSemanticCheckpointStateMachineError, .discardNotAvailable)
        }
        let stillRetainedConflict = try await conflict.local.loroCheckpoint(workspaceId: conflict.workspace, nodeId: conflict.node)
        XCTAssertEqual(stillRetainedConflict, conflictCheckpoint)

        let requestIdentity = try await Fixture.make(error: .requestIdentityConflict)
        let identityOutcome = try await requestIdentity.machine.submit(requestIdentity.candidate)
        XCTAssertEqual(identityOutcome, .retainedRequestIdentity)
        let requestIdentityCheckpoint = try await requestIdentity.local.loroCheckpoint(workspaceId: requestIdentity.workspace, nodeId: requestIdentity.node)
        XCTAssertEqual(requestIdentityCheckpoint?.state, .retainedRequestIdentity)
        do {
            try await requestIdentity.machine.discardAndReload(workspaceId: requestIdentity.workspace, nodeId: requestIdentity.node)
            XCTFail("v7 request-identity evidence must not be deleted")
        } catch {
            XCTAssertEqual(error as? LoroSemanticCheckpointStateMachineError, .discardNotAvailable)
        }
        let stillRetainedIdentity = try await requestIdentity.local.loroCheckpoint(workspaceId: requestIdentity.workspace, nodeId: requestIdentity.node)
        XCTAssertEqual(stillRetainedIdentity, requestIdentityCheckpoint)

        let retry = try await Fixture.make(error: .unknown)
        try await retry.machine.submit(retry.candidate)
        do { try await retry.machine.discardAndReload(workspaceId: retry.workspace, nodeId: retry.node); XCTFail("retry must not discard") }
        catch { XCTAssertEqual(error as? LoroSemanticCheckpointStateMachineError, .discardNotAvailable) }

        let badReceipt = try await Fixture.make(receiptTampered: true)
        try await badReceipt.machine.submit(badReceipt.candidate)
        let retainedBadReceipt = try await badReceipt.local.loroCheckpoint(workspaceId: badReceipt.workspace, nodeId: badReceipt.node)
        let badReceiptPublished = try await badReceipt.documents.publishedState(nodeId: badReceipt.node)
        XCTAssertEqual(retainedBadReceipt?.state, .retainedRetry)
        XCTAssertNil(badReceiptPublished)
    }

    func testCorruptCandidateOwnershipFailsClosedBeforeRetryDispatchOrStateMutation() async throws {
        let fixture = try await Fixture.make(error: .unknown)
        try await fixture.machine.submit(fixture.candidate)
        let callsBeforeCorruption = await fixture.fake.calls()
        XCTAssertEqual(callsBeforeCorruption.count, 1)
        let foreignWorkspace = try EntityId(validating: UUID().uuidString.lowercased())
        let connection = try SQLite3Connection(path: fixture.local.path)
        try connection.run("UPDATE nodes SET workspace_id = ? WHERE id = ?;", [.text(foreignWorkspace.rawValue), .text(fixture.node.rawValue)])

        let reopened = try LocalWorkspaceStore(path: fixture.local.path)
        // `retry` begins with this guarded transition; using a fresh state machine proves a
        // reopened corrupt candidate cannot reach its transport seam.
        let reopenedMachine = LoroSemanticCheckpointStateMachine(local: reopened, documents: fixture.documents, transport: fixture.fake)
        do {
            try await reopenedMachine.retry(workspaceId: fixture.workspace, nodeId: fixture.node)
            XCTFail("corrupt candidate ownership must fail closed")
        } catch {
            XCTAssertEqual(error as? LocalWorkspaceStoreError, .invalidLoroCandidate)
        }
        let callsAfterRejectedRetry = await fixture.fake.calls()
        XCTAssertEqual(callsAfterRejectedRetry.count, 1)
        let state = try connection.query("SELECT state FROM loro_semantic_candidates_v7 WHERE workspace_id = ? AND node_id = ?;", [.text(fixture.workspace.rawValue), .text(fixture.node.rawValue)]) { columnText($0, 0) }.first
        XCTAssertEqual(state, LoroSemanticCheckpointState.retainedRetry.rawValue)
    }

    func testArchivePageAndTerminalFailpointsRollBackExactAcceptedTransaction() async throws {
        let failures: [(String, Fixture)] = [
            ("after archive", try await Fixture.make(failAfterV7ArchiveWrite: true)),
            ("after page", try await Fixture.make(failAfterV7AcceptedPageWrite: true)),
            ("before terminal", try await Fixture.make(failBeforeV7TerminalUpdate: true))
        ]

        for (name, fixture) in failures {
            let outcome = try await fixture.machine.submit(fixture.candidate)
            let retained = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
            let evidence = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
            let page = try await fixture.local.loroPage(nodeId: fixture.node)
            let published = try await fixture.documents.publishedState(nodeId: fixture.node)
            XCTAssertEqual(outcome, .retainedRetry, name)
            XCTAssertEqual(retained?.state, .retainedRetry, name)
            XCTAssertEqual(evidence?.snapshot, fixture.candidate.snapshot, name)
            XCTAssertEqual(page?.snapshotBytes, fixture.baseSnapshot, name)
            XCTAssertNil(published, name)
            XCTAssertEqual(try archiveCount(fixture.local, workspaceId: fixture.workspace, nodeId: fixture.node), 0, name)
        }
    }

    func testCancellationRetainsFrozenEvidenceWithoutPublishing() async throws {
        let cancelled = try await Fixture.make(cancel: true)
        try await cancelled.machine.submit(cancelled.candidate)
        let cancelledCheckpoint = try await cancelled.local.loroCheckpoint(workspaceId: cancelled.workspace, nodeId: cancelled.node)
        let cancelledCalls = await cancelled.fake.calls()
        XCTAssertEqual(cancelledCheckpoint?.state, .retainedRetry)
        XCTAssertEqual(cancelledCalls.count, 1)

    }

    private func archiveCount(_ local: LocalWorkspaceStore, workspaceId: EntityId, nodeId: EntityId) throws -> Int {
        let connection = try SQLite3Connection(path: local.path)
        return try connection.query(
            "SELECT COUNT(*) FROM loro_semantic_checkpoint_archive_v7 WHERE workspace_id=? AND node_id=?;",
            [.text(workspaceId.rawValue), .text(nodeId.rawValue)]
        ) { Int(columnInt($0, 0)) }.first ?? 0
    }

    private func v7RawEvidence(
        path: String,
        table: String,
        workspaceId: EntityId,
        nodeId: EntityId,
        requestId: String
    ) throws -> [String] {
        precondition(table == "loro_semantic_candidates_v7" || table == "loro_semantic_checkpoint_archive_v7")
        let connection = try SQLite3Connection(path: path)
        let rows = try connection.query("""
            SELECT state,request_id,commit_message,attribution_kind,attribution_one,COALESCE(attribution_two,'<nil>'),
                   route_storage_version,route_schema_version,route_snapshot_sha256,hex(update_bytes),update_sha256,
                   hex(base_version_vector),base_version_vector_sha256,hex(base_snapshot),base_snapshot_sha256,
                   hex(candidate_snapshot),candidate_snapshot_sha256,hex(candidate_result_version_vector),candidate_result_version_vector_sha256,
                   expected_result_storage_version,expected_result_schema_version,expected_result_snapshot_sha256
            FROM \(table) WHERE workspace_id=? AND node_id=? AND request_id=?;
            """, [.text(workspaceId.rawValue), .text(nodeId.rawValue), .text(requestId)]) { statement in
                (0...21).map { index in
                    switch index {
                    case 6, 7, 19, 20: return String(columnInt(statement, Int32(index)))
                    default: return columnText(statement, Int32(index))
                    }
                }
            }
        return try XCTUnwrap(rows.first)
    }

    private func mintNextCandidate(
        _ fixture: Fixture,
        requestId: String,
        replacement: String
    ) async throws -> LoroFrozenLiteralCandidate {
        // A later edit crosses the same explicit accepted-row recovery boundary as production.
        // Do not derive authoring authority from the raw durable page observation.
        let maybeAccepted = try await fixture.local.acceptedLoroPageEvidence(
            workspaceId: fixture.workspace,
            nodeId: fixture.node
        )
        let accepted = try XCTUnwrap(maybeAccepted)
        try await fixture.documents.installAcceptedLiteral(accepted)
        let pageOptional = try await fixture.local.loroPage(nodeId: fixture.node)
        let page = try XCTUnwrap(pageOptional)
        let inspection = try await fixture.documents.inspectPersistedReplicaV1(snapshot: page.snapshotBytes)
        let route = LoroPageRouteWitness(
            nodeId: fixture.node,
            format: .loroV1,
            storageVersion: page.observedDescriptorStorageVersion,
            schemaVersion: page.pageSchemaVersion,
            snapshotSHA256: page.observedDescriptorSnapshotSHA256
        )
        let replica = LoroPageReplicaWitness(
            snapshotSHA256: inspection.snapshotSHA256,
            versionVectorSHA256: inspection.versionVectorSHA256
        )
        let editable = try await fixture.documents.nativePlainLoroEditableV1(
            nodeId: fixture.node,
            route: route,
            persistedReplica: replica,
            publishedReplica: replica,
            isDirty: false
        )
        return try await fixture.documents.prepareNativePlainSemanticCandidateV1(
            nodeId: fixture.node,
            route: route,
            persistedReplica: replica,
            publishedReplica: replica,
            isDirty: false,
            scalarRange: editable.scalarCount..<editable.scalarCount,
            replacement: replacement,
            workspaceId: fixture.workspace,
            intent: try .init(requestId: requestId, commitMessage: "next", attribution: .humanUi(surface: "macos"))
        )
    }

    struct Fixture {
        let workspace: EntityId; let node: EntityId; let candidate: LoroFrozenLiteralCandidate; let baseSnapshot: Data
        let candidateResultVersionVector: Data; let freshAuthority: LoroSemanticCheckpointAuthority; let unrelatedAuthority: LoroSemanticCheckpointAuthority
        let local: LocalWorkspaceStore; let documents: LoroPageDocumentStore; let fake: Fake; let machine: LoroSemanticCheckpointStateMachine

        static func make(
            error: LoroSemanticCheckpointTransportError? = nil,
            receiptTampered: Bool = false,
            receiptTargetMismatch: Bool = false,
            receiptResultWitnessTamper: ReceiptResultWitnessTamper? = nil,
            cancel: Bool = false,
            failLoroPageWrites: Bool = false,
            failAfterV7ArchiveWrite: Bool = false,
            failAfterV7AcceptedPageWrite: Bool = false,
            failBeforeV7TerminalUpdate: Bool = false,
            freshAuthority: Bool = false,
            unrelatedAuthority: Bool = false
        ) async throws -> Self {
            let workspace = try EntityId(validating: UUID().uuidString.lowercased())
            let node = try EntityId(validating: UUID().uuidString.lowercased())
            let documents = LoroPageDocumentStore()
            let baseSnapshot = try snapshot()
            let base = try await documents.prepare(nodeId: node, snapshot: baseSnapshot)
            let route = LoroPageRouteWitness(
                nodeId: node,
                format: .loroV1,
                storageVersion: 1,
                schemaVersion: 1,
                snapshotSHA256: base.localSnapshotSHA256
            )
            let seeded = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(), failLoroPageWrites: false)
            try await seeded.upsertNode(.init(id: node, workspaceId: workspace, title: "node", createdAt: "2026-08-20T00:00:00Z"), dirty: false)
            try await seeded.upsertLoroPage(.init(
                prepared: base,
                dirty: false,
                observedDescriptorStorageVersion: route.storageVersion,
                observedDescriptorSnapshotSHA256: route.snapshotSHA256
            ))
            guard let accepted = try await seeded.acceptedLoroPageEvidence(workspaceId: workspace, nodeId: node) else {
                throw LocalWorkspaceStoreError.invalidLoroPageState
            }
            // Fixture setup crosses the same explicit durable accepted-row recovery boundary
            // exposed to production callers; it never fabricates a literal token.
            try await documents.installAcceptedLiteral(accepted)
            let replica = LoroPageReplicaWitness(
                snapshotSHA256: base.localSnapshotSHA256,
                versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: base.versionBytes)
            )
            let candidate = try await documents.prepareNativePlainSemanticCandidateV1(
                nodeId: node,
                route: route,
                persistedReplica: replica,
                publishedReplica: replica,
                isDirty: false,
                scalarRange: 0..<0,
                replacement: "changed",
                workspaceId: workspace,
                intent: try .init(requestId: "id", commitMessage: "message", attribution: .humanUi(surface: "macos"))
            )
            let candidateAuthority = LoroSemanticCheckpointAuthority(
                workspaceId: workspace,
                nodeId: node,
                route: candidate.literal.route,
                snapshot: candidate.literal.snapshotBytes,
                versionVector: candidate.literal.versionBytes
            )
            let causallyFreshAuthority = try causallyNewerAuthority(for: candidate)
            let unrelatedSnapshot = try snapshot(text: "unrelated")
            let unrelatedPrepared = try await documents.prepare(nodeId: node, snapshot: unrelatedSnapshot)
            let unrelatedRoute = LoroPageRouteWitness(
                nodeId: node,
                format: .loroV1,
                storageVersion: candidate.literal.route.storageVersion + 1,
                schemaVersion: 1,
                snapshotSHA256: unrelatedPrepared.localSnapshotSHA256
            )
            let nonIncludingAuthority = LoroSemanticCheckpointAuthority(
                workspaceId: workspace,
                nodeId: node,
                route: unrelatedRoute,
                snapshot: unrelatedSnapshot,
                versionVector: unrelatedPrepared.versionBytes
            )
            let authority = error == nil
                ? (freshAuthority ? causallyFreshAuthority : unrelatedAuthority ? nonIncludingAuthority : candidateAuthority)
                : LoroSemanticCheckpointAuthority(workspaceId: workspace, nodeId: node, route: route, snapshot: baseSnapshot, versionVector: base.versionBytes)
            let receiptWorkspace = receiptTargetMismatch
                ? try EntityId(validating: UUID().uuidString.lowercased())
                : workspace
            let receiptNode = receiptTargetMismatch
                ? try EntityId(validating: UUID().uuidString.lowercased())
                : node
            let receipt = LoroSemanticCheckpointReceipt(
                workspaceId: receiptWorkspace,
                nodeId: receiptNode,
                intent: candidate.intent,
                baseRoute: candidate.route,
                resultRoute: candidate.expectedResultRoute,
                updateSHA256: receiptTampered ? String(repeating: "0", count: 64) : candidate.updateSHA256,
                baseVersionVectorSHA256: candidate.baseVersionVectorSHA256,
                resultSnapshotSHA256: receiptResultWitnessTamper == .snapshot ? String(repeating: "0", count: 64) : candidate.snapshotSHA256,
                resultVersionVectorSHA256: receiptResultWitnessTamper == .versionVector ? String(repeating: "0", count: 64) : candidate.resultVersionVectorSHA256
            )
            let fake = Fake(error: error, cancel: cancel, receipt: receipt, authority: authority)
            if error == nil, !receiptTampered, !receiptTargetMismatch, receiptResultWitnessTamper == nil, !freshAuthority, !unrelatedAuthority {
                await fake.acceptSubmittedIntent()
            }
            let usesFailureStore = failLoroPageWrites || failAfterV7ArchiveWrite || failAfterV7AcceptedPageWrite || failBeforeV7TerminalUpdate
            let machineLocal = usesFailureStore
                ? try LocalWorkspaceStore(
                    path: seeded.path,
                    failLoroPageWrites: failLoroPageWrites,
                    failAfterV7ArchiveWrite: failAfterV7ArchiveWrite,
                    failAfterV7AcceptedPageWrite: failAfterV7AcceptedPageWrite,
                    failBeforeV7TerminalUpdate: failBeforeV7TerminalUpdate
                )
                : seeded
            await fake.setDurabilityProbe(machineLocal)
            return .init(
                workspace: workspace,
                node: node,
                candidate: candidate,
                baseSnapshot: baseSnapshot,
                candidateResultVersionVector: candidate.literal.versionBytes,
                freshAuthority: causallyFreshAuthority,
                unrelatedAuthority: nonIncludingAuthority,
                local: machineLocal,
                documents: documents,
                fake: fake,
                machine: .init(local: machineLocal, documents: documents, transport: fake)
            )
        }

        static func snapshot(text: String = "") throws -> Data {
            let doc = LoroDoc(); try doc.getMap(id: "athenaeum-page-meta-v1").insert(key: "schemaVersion", v: 1)
            let root = doc.getMap(id: "athenaeum-prosemirror-v1"); try root.insert(key: "nodeName", v: "doc"); try root.getOrCreateMapContainer(key: "attributes", child: LoroMap()).insert(key: "isAmgBlock", v: false)
            let child = try root.getOrCreateListContainer(key: "children", child: LoroList()).insertMapContainer(pos: 0, child: LoroMap()); try child.insert(key: "nodeName", v: "paragraph"); try child.getOrCreateMapContainer(key: "attributes", child: LoroMap()).insert(key: "isAmgBlock", v: false); let inline = try child.getOrCreateListContainer(key: "children", child: LoroList()); if !text.isEmpty { try inline.insertTextContainer(pos: 0, child: LoroText()).pushStr(s: text) }; doc.commit(); return try doc.export(mode: .snapshot)
        }

        static func causallyNewerAuthority(for candidate: LoroFrozenLiteralCandidate) throws -> LoroSemanticCheckpointAuthority {
            let doc = LoroDoc()
            _ = try doc.import(bytes: candidate.literal.snapshotBytes)
            let text = try nativePlainText(in: doc)
            try text.insert(pos: text.lenUnicode(), s: "!")
            doc.commit()
            try text.delete(pos: text.lenUnicode() - 1, len: 1)
            doc.commit()
            let snapshot = try doc.export(mode: .snapshot)
            return .init(
                workspaceId: candidate.workspaceId,
                nodeId: candidate.nodeId,
                route: .init(
                    nodeId: candidate.nodeId,
                    format: .loroV1,
                    storageVersion: candidate.expectedResultRoute.storageVersion + 1,
                    schemaVersion: candidate.expectedResultRoute.schemaVersion,
                    snapshotSHA256: LoroMutationWire.sha256Hex(snapshot)
                ),
                snapshot: snapshot,
                versionVector: doc.oplogVv().encode()
            )
        }

        private static func nativePlainText(in doc: LoroDoc) throws -> LoroText {
            let root = doc.getMap(id: "athenaeum-prosemirror-v1")
            let children = try XCTUnwrap(root.get(key: "children")?.asLoroList())
            let paragraph = try XCTUnwrap(children.get(index: 0)?.asLoroMap())
            let inline = try XCTUnwrap(paragraph.get(key: "children")?.asLoroList())
            return try XCTUnwrap(inline.get(index: 0)?.asLoroText())
        }
    }

    enum ReceiptResultWitnessTamper { case snapshot, versionVector }

    actor Fake: LoroSemanticCheckpointTransport {
        enum AcceptedSubmissionAuthorityTamper { case routeClaimsCandidateSnapshotForDifferentBytes }

        let error: LoroSemanticCheckpointTransportError?; let cancel: Bool; let receipt: LoroSemanticCheckpointReceipt; var authority: LoroSemanticCheckpointAuthority; var recorded: [LoroSemanticCheckpoint] = []; var reloadTargets: [(EntityId, EntityId)] = []; var local: LocalWorkspaceStore?; var observedDurable = false
        init(error: LoroSemanticCheckpointTransportError?, cancel: Bool, receipt: LoroSemanticCheckpointReceipt, authority: LoroSemanticCheckpointAuthority) { self.error = error; self.cancel = cancel; self.receipt = receipt; self.authority = authority }
        func setDurabilityProbe(_ local: LocalWorkspaceStore) { self.local = local }
        var acceptsSubmittedIntent = false
        var acceptedSubmissionAuthorityTamper: AcceptedSubmissionAuthorityTamper?
        func submit(_ checkpoint: LoroSemanticCheckpoint) async throws -> LoroSemanticCheckpointReceipt { recorded.append(checkpoint); if let local { let stored = try await local.loroCheckpoint(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId); let page = try await local.loroPage(nodeId: checkpoint.nodeId); observedDurable = stored == checkpoint && page?.dirty == false }; if cancel { throw CancellationError() }; if let error { throw error }; if acceptsSubmittedIntent, let local, let frozen = try await local.frozenCandidateEvidence(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId) { if acceptedSubmissionAuthorityTamper == .routeClaimsCandidateSnapshotForDifferentBytes, let accepted = try await local.loroPage(nodeId: checkpoint.nodeId) { authority = .init(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId, route: frozen.expectedResultRoute, snapshot: accepted.snapshotBytes, versionVector: frozen.candidateResultVersionVector) } else { authority = .init(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId, route: frozen.expectedResultRoute, snapshot: frozen.candidateSnapshot, versionVector: frozen.candidateResultVersionVector) }; return LoroSemanticCheckpointReceipt(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId, intent: checkpoint.intent, baseRoute: checkpoint.route, resultRoute: frozen.expectedResultRoute, updateSHA256: checkpoint.updateSHA256, baseVersionVectorSHA256: checkpoint.baseVersionVectorSHA256, resultSnapshotSHA256: frozen.candidateSnapshotSHA256, resultVersionVectorSHA256: frozen.candidateResultVersionVectorSHA256) }; return receipt }
        func acceptSubmittedIntent() { acceptsSubmittedIntent = true }
        func tamperAcceptedSubmissionAuthority(_ tamper: AcceptedSubmissionAuthorityTamper) { acceptedSubmissionAuthorityTamper = tamper }
        func reload(workspaceId: EntityId, nodeId: EntityId) async throws -> LoroSemanticCheckpointAuthority { reloadTargets.append((workspaceId, nodeId)); return authority }
        func setAuthority(_ authority: LoroSemanticCheckpointAuthority) { self.authority = authority }
        func calls() -> [LoroSemanticCheckpoint] { recorded }
        func reloadCalls() -> [(EntityId, EntityId)] { reloadTargets }
        func observedDurableCandidate() -> Bool { observedDurable }
    }

}

// Test-only inspection conveniences.  These expose no constructors and deliberately preserve
// the production distinction between actor-minted literal tokens and sealed durable evidence.
extension LoroFrozenLiteralCandidate {
    var nodeId: EntityId { checkpoint.nodeId }
    var intent: LoroMutationIntentV1 { checkpoint.intent }
    var route: LoroPageRouteWitness { checkpoint.route }
    var update: Data { checkpoint.update }
    var updateSHA256: String { checkpoint.updateSHA256 }
    var baseVersionVector: Data { checkpoint.baseVersionVector }
    var baseVersionVectorSHA256: String { checkpoint.baseVersionVectorSHA256 }
    var snapshot: Data { literal.snapshotBytes }
    var snapshotSHA256: String { literal.localSnapshotSHA256 }
    var resultVersionVector: Data { literal.versionBytes }
    var resultVersionVectorSHA256: String { literal.versionVectorSHA256 }
    var expectedResultRoute: LoroPageRouteWitness { literal.route }
}

extension LoroFrozenCandidateEvidence {
    var snapshot: Data { candidateSnapshot }
    var snapshotSHA256: String { candidateSnapshotSHA256 }
    var resultVersionVector: Data { candidateResultVersionVector }
    var resultVersionVectorSHA256: String { candidateResultVersionVectorSHA256 }
}
