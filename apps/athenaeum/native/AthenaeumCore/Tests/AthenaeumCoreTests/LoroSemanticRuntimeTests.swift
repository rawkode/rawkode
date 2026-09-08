import XCTest
import Loro
import AthenaeumDomain
@testable import AthenaeumCore

final class LoroSemanticRuntimeTests: XCTestCase {
    func testCustodyExpiryWhileQueuedIsDeniedInsideLeaseWithoutSideEffects() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let base = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: base)
        let start = Date(timeIntervalSinceReferenceDate: 1_000)
        let clock = TestClock(start)
        let gate = LoroNodeOperationGate()
        let key = "\(fixture.workspace.rawValue):\(fixture.node.rawValue)"
        try await gate.acquire(key)
        let runtime = LoroSemanticRuntime(
            local: fixture.local, documents: fixture.documents, gate: gate, workspaceId: fixture.workspace,
            custody: LoroSemanticCustody(workspaceId: fixture.workspace, intent: fixture.candidate.intent, expiresAt: start.addingTimeInterval(1)),
            transport: fixture.fake, now: clock.read
        )
        let task = Task { try await runtime.replacePlainText(nodeId: fixture.node, scalarRange: 0..<0, replacement: "x") }
        await clock.waitForFirstRead()
        clock.set(start.addingTimeInterval(2))
        await gate.release(key)
        let outcome = try await task.value
        XCTAssertEqual(outcome, .deniedAuthorizationOrSession)
        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let candidate = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let calls = await fixture.fake.calls()
        XCTAssertNil(checkpoint)
        XCTAssertNil(candidate)
        XCTAssertTrue(calls.isEmpty)
    }
    func testRuntimePersistsFrozenCandidateBeforeDispatchWithoutMutatingPublishedAuthority() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make(error: .unknown)
        let base = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: base)
        let custody = LoroSemanticCustody(
            workspaceId: fixture.workspace,
            intent: fixture.candidate.intent,
            expiresAt: Date(timeIntervalSinceNow: 60)
        )
        let runtime = LoroSemanticRuntime(
            local: fixture.local,
            documents: fixture.documents,
            gate: LoroNodeOperationGate(),
            workspaceId: fixture.workspace,
            custody: custody,
            transport: fixture.fake
        )

        let outcome = try await runtime.replacePlainText(nodeId: fixture.node, scalarRange: 0..<0, replacement: "x")
        XCTAssertEqual(outcome, .retainedRetry)

        let checkpointValue = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let frozenValue = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let localAuthorityValue = try await fixture.local.loroPage(nodeId: fixture.node)
        let publishedAuthorityValue = try await fixture.documents.publishedState(nodeId: fixture.node)
        let checkpoint = try XCTUnwrap(checkpointValue)
        let frozen = try XCTUnwrap(frozenValue)
        let localAuthority = try XCTUnwrap(localAuthorityValue)
        let publishedAuthority = try XCTUnwrap(publishedAuthorityValue)
        let durable = await fixture.fake.observedDurableCandidate()
        let calls = await fixture.fake.calls()
        XCTAssertEqual(checkpoint.state, .retainedRetry)
        XCTAssertNotEqual(frozen.snapshot, fixture.baseSnapshot)
        XCTAssertEqual(localAuthority.snapshotBytes, fixture.baseSnapshot)
        XCTAssertEqual(publishedAuthority.snapshotBytes, fixture.baseSnapshot)
        XCTAssertTrue(durable)
        XCTAssertEqual(calls.count, 1)
    }

    func testMismatchedCustodyHasNoCandidateOrTransportSideEffects() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let base = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: base)
        let otherWorkspace = try EntityId(validating: UUID().uuidString.lowercased())
        let runtime = LoroSemanticRuntime(
            local: fixture.local,
            documents: fixture.documents,
            gate: LoroNodeOperationGate(),
            workspaceId: fixture.workspace,
            custody: LoroSemanticCustody(workspaceId: otherWorkspace, intent: fixture.candidate.intent, expiresAt: Date(timeIntervalSinceNow: 60)),
            transport: fixture.fake
        )

        let outcome = try await runtime.replacePlainText(nodeId: fixture.node, scalarRange: 0..<0, replacement: "x")
        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let candidate = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let calls = await fixture.fake.calls()
        XCTAssertEqual(outcome, .deniedAuthorizationOrSession)
        XCTAssertNil(checkpoint)
        XCTAssertNil(candidate)
        XCTAssertTrue(calls.isEmpty)
    }

    func testRecoverInFlightAfterReopenRetriesTheExactFrozenCheckpoint() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make(error: .unknown)
        _ = try await fixture.machine.submit(fixture.candidate)
        _ = try await fixture.local.transitionLoroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node, from: .retainedRetry, to: .inFlight)
        let beforeValue = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let before = try XCTUnwrap(beforeValue)
        let reopened = try LocalWorkspaceStore(path: fixture.local.path)
        let runtime = LoroSemanticRuntime(
            local: reopened, documents: fixture.documents, gate: LoroNodeOperationGate(), workspaceId: fixture.workspace,
            custody: .init(workspaceId: fixture.workspace, intent: fixture.candidate.intent, expiresAt: Date(timeIntervalSinceNow: 60)), transport: fixture.fake
        )

        let outcome = try await runtime.recoverInFlight(nodeId: fixture.node)
        let calls = await fixture.fake.calls()
        let retained = try await reopened.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertEqual(outcome, .retainedRetry)
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[1].intent, before.intent)
        XCTAssertEqual(calls[1].update, before.update)
        XCTAssertEqual(calls[1].baseVersionVectorSHA256, before.baseVersionVectorSHA256)
        XCTAssertEqual(retained?.state, .retainedRetry)
    }

    func testRecoverInFlightDeniesMismatchedCustodyWithoutMutatingOrDispatching() async throws {
        let mismatchedIntent = try LoroMutationIntentV1(requestId: "different-request", commitMessage: "message", attribution: .humanUi(surface: "macos"))
        for initialState in [LoroSemanticCheckpointState.inFlight, .retainedRetry] {
            let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make(error: .unknown)
            _ = try await fixture.machine.submit(fixture.candidate)
            if initialState == .inFlight {
                _ = try await fixture.local.transitionLoroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node, from: .retainedRetry, to: .inFlight)
            }
            let callsBefore = await fixture.fake.calls()
            let runtime = LoroSemanticRuntime(
                local: fixture.local, documents: fixture.documents, gate: LoroNodeOperationGate(), workspaceId: fixture.workspace,
                custody: .init(workspaceId: fixture.workspace, intent: mismatchedIntent, expiresAt: Date(timeIntervalSinceNow: 60)), transport: fixture.fake
            )

            let outcome = try await runtime.recoverInFlight(nodeId: fixture.node)
            let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
            let callsAfter = await fixture.fake.calls()
            XCTAssertEqual(outcome, .deniedAuthorizationOrSession, "\(initialState)")
            XCTAssertEqual(checkpoint?.state, initialState, "\(initialState)")
            XCTAssertEqual(callsAfter, callsBefore, "\(initialState)")
        }
    }

    func testMarkedPageRejectsBeforeCandidateOrTransport() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let marked = try markedSnapshot()
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: marked)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: prepared)
        try await fixture.local.upsertLoroPage(.init(prepared: prepared, dirty: false, observedDescriptorStorageVersion: 1, observedDescriptorSnapshotSHA256: prepared.localSnapshotSHA256))
        // A raw observation cannot retain the previous literal token. Explicit accepted-row
        // recovery then performs the strict native-plain check and rejects the marked page.
        await fixture.documents.invalidateLiteralCache(nodeId: fixture.node)
        let maybeAccepted = try await fixture.local.acceptedLoroPageEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let accepted = try XCTUnwrap(maybeAccepted)
        do {
            try await fixture.documents.installAcceptedLiteral(accepted)
            XCTFail("a marked page must not mint literal authority")
        } catch {
            XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativePlainTextIneligible)
        }
        let runtime = LoroSemanticRuntime(
            local: fixture.local, documents: fixture.documents, gate: LoroNodeOperationGate(), workspaceId: fixture.workspace,
            custody: .init(workspaceId: fixture.workspace, intent: fixture.candidate.intent, expiresAt: Date(timeIntervalSinceNow: 60)), transport: fixture.fake
        )

        do {
            _ = try await runtime.replacePlainText(nodeId: fixture.node, scalarRange: 0..<0, replacement: "x")
            XCTFail("marked page must reject native editing")
        } catch {
            XCTAssertEqual(error as? LoroPageProjectionError, .pageNotPublished(fixture.node))
        }
        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let candidate = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let calls = await fixture.fake.calls()
        XCTAssertNil(checkpoint)
        XCTAssertNil(candidate)
        XCTAssertTrue(calls.isEmpty)
    }

    private func markedSnapshot() throws -> Data {
        let doc = LoroDoc()
        try doc.getMap(id: "athenaeum-page-meta-v1").insert(key: "schemaVersion", v: 1)
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        try root.insert(key: "nodeName", v: "doc")
        try root.getOrCreateMapContainer(key: "attributes", child: LoroMap()).insert(key: "isAmgBlock", v: true)
        let paragraph = try root.getOrCreateListContainer(key: "children", child: LoroList()).insertMapContainer(pos: 0, child: LoroMap())
        try paragraph.insert(key: "nodeName", v: "paragraph")
        try paragraph.getOrCreateMapContainer(key: "attributes", child: LoroMap()).insert(key: "isAmgBlock", v: false)
        _ = try paragraph.getOrCreateListContainer(key: "children", child: LoroList()).insertTextContainer(pos: 0, child: LoroText())
        doc.commit()
        return try doc.export(mode: .snapshot)
    }
}

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date
    private var readCount = 0
    private var firstReadWaiter: CheckedContinuation<Void, Never>?
    init(_ value: Date) { self.value = value }
    func read() -> Date {
        let signal: CheckedContinuation<Void, Never>? = lock.withLock {
            readCount += 1
            defer { firstReadWaiter = nil }
            return readCount == 1 ? firstReadWaiter : nil
        }
        signal?.resume()
        return lock.withLock { value }
    }
    func set(_ value: Date) { lock.withLock { self.value = value } }
    func waitForFirstRead() async {
        if lock.withLock({ readCount > 0 }) { return }
        await withCheckedContinuation { continuation in
            let immediatelyReady = lock.withLock { () -> Bool in
                if readCount > 0 { return true }
                firstReadWaiter = continuation
                return false
            }
            if immediatelyReady { continuation.resume() }
        }
    }
}
