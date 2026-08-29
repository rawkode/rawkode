import XCTest
import AthenaeumDomain
import AthenaeumRPC
@testable import AthenaeumCore

final class LoroWorkspaceSyncClientTests: XCTestCase {
    func testMissingCreationIntentFailsBeforeNativeCreateTransport() async throws {
        let workspace = try id(), node = try id()
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        let transport = LoroTransportFake(descriptor: descriptor(node), pageNotFound: true)
        let client = WorkspaceSyncClient(localStore: local, loroTransport: transport, workspaceId: workspace)

        await assertThrowsAsync(try await client.resolveOrCreateLoroPageReadOnly(nodeId: node, creationIntent: nil)) { error in
            XCTAssertEqual(error as? WorkspaceSyncClientError, .missingLoroCreationIntent(node))
        }
        let creates = await transport.createCount()
        let starts = await transport.startCount()
        XCTAssertEqual(creates, 0)
        XCTAssertEqual(starts, 0)
    }

    func testLegacyDescriptorNeverStartsLoroTransport() async throws {
        let workspace = try id()
        let node = try id()
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        let transport = LoroTransportFake(descriptor: .legacy(
            nodeId: node, storageVersion: 1,
            automerge: .init(docId: node.rawValue, headsHash: "heads", bytesSha256: String(repeating: "a", count: 64))
        ))
        let client = WorkspaceSyncClient(localStore: local, loroTransport: transport, workspaceId: workspace)

        await assertThrowsAsync(try await client.syncLoroPageReadOnly(nodeId: node)) { error in
            XCTAssertEqual(error as? WorkspaceSyncClientError, .invalidLoroDescriptor(node))
        }
        let starts = await transport.startCount()
        let messages = await transport.messageCount()
        XCTAssertEqual(starts, 0)
        XCTAssertEqual(messages, 0)
    }

    func testDescriptorNodeMismatchFailsBeforeLoroHandshake() async throws {
        let workspace = try id()
        let node = try id()
        let other = try id()
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        let transport = LoroTransportFake(descriptor: .nativeLoro(
            nodeId: other, storageVersion: 1,
            loro: .init(schemaVersion: 1, snapshotSha256: String(repeating: "a", count: 64))
        ))
        let client = WorkspaceSyncClient(localStore: local, loroTransport: transport, workspaceId: workspace)

        await assertThrowsAsync(try await client.syncLoroPageReadOnly(nodeId: node)) { error in
            XCTAssertEqual(error as? WorkspaceSyncClientError, .invalidLoroDescriptor(node))
        }
        let starts = await transport.startCount()
        XCTAssertEqual(starts, 0)
    }

    func testProjectionCarriesRouteWitnessAndFailsClosedWhenDescriptorChangesDuringSync() async throws {
        let workspace = try id(), node = try id()
        let seed = try await prepared(node: node)
        let selected = descriptor(node)
        let changed = PageDocumentDescriptor.nativeLoro(
            nodeId: node,
            storageVersion: 2,
            loro: .init(schemaVersion: 1, snapshotSha256: String(repeating: "b", count: 64))
        )
        let transport = LoroTransportFake(
            descriptor: selected,
            descriptorSequence: [selected, changed],
            start: .init(sessionId: "", message: seed.snapshotBytes, serverVersion: seed.versionBytes),
            plans: [.response(.init(sessionId: "", ordinal: 0, update: Data(), serverVersion: seed.versionBytes, converged: true, reset: false))]
        )
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        try await addNode(node, workspace: workspace, to: local)
        let client = WorkspaceSyncClient(localStore: local, loroTransport: transport, workspaceId: workspace)

        await assertThrowsAsync(try await client.syncLoroPageProjectionReadOnly(nodeId: node)) { error in
            XCTAssertEqual(error as? WorkspaceSyncClientError, .invalidLoroDescriptor(node))
        }
        let starts = await transport.startCount()
        let descriptorRequests = await transport.descriptorCount()
        XCTAssertEqual(starts, 1)
        XCTAssertEqual(descriptorRequests, 2)
    }

    func testDescriptorToStartRacePreservesLocalState() async throws {
        let workspace = try id(), node = try id()
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        try await addNode(node, workspace: workspace, to: local)
        let transport = LoroTransportFake(descriptor: descriptor(node), failStarts: true)
        let client = WorkspaceSyncClient(localStore: local, loroTransport: transport, workspaceId: workspace)
        await assertThrowsAsync(try await client.syncLoroPageReadOnly(nodeId: node)) { _ in }
        let state = try await local.loroPage(nodeId: node)
        let messages = await transport.messageCount()
        XCTAssertNil(state)
        XCTAssertEqual(messages, 0)
    }

    func testUncertainTransportRetriesExactImmutableFrame() async throws {
        let workspace = try id(), node = try id()
        let seed = try await prepared(node: node)
        let transport = LoroTransportFake(
            descriptor: descriptor(node),
            start: .init(sessionId: "", message: seed.snapshotBytes, serverVersion: seed.versionBytes),
            plans: [.transportFailure, .response(.init(sessionId: "", ordinal: 0, update: Data(), serverVersion: seed.versionBytes, converged: true, reset: false))]
        )
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        try await addNode(node, workspace: workspace, to: local)
        let client = WorkspaceSyncClient(localStore: local, loroTransport: transport, workspaceId: workspace)

        await assertThrowsAsync(try await client.syncLoroPageReadOnly(nodeId: node)) { _ in }
        _ = try await client.syncLoroPageReadOnly(nodeId: node)
        let frames = await transport.frames()
        let starts = await transport.startCount()
        let state = try await local.loroPage(nodeId: node)
        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(frames[0], frames[1])
        XCTAssertTrue(frames.allSatisfy { $0.update.isEmpty })
        XCTAssertEqual(starts, 1)
        XCTAssertFalse(try XCTUnwrap(state).dirty)
    }

    func testResetRehandshakesAndRecomputesFromDirtyCandidate() async throws {
        let workspace = try id(), node = try id()
        let seed = try await prepared(node: node)
        let transport = LoroTransportFake(
            descriptor: descriptor(node),
            start: .init(sessionId: "", message: seed.snapshotBytes, serverVersion: seed.versionBytes),
            plans: [.response(.init(sessionId: "", ordinal: 0, update: nil, serverVersion: seed.versionBytes, converged: false, reset: true)), .response(.init(sessionId: "", ordinal: 0, update: Data(), serverVersion: seed.versionBytes, converged: true, reset: false))]
        )
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        try await addNode(node, workspace: workspace, to: local)
        let client = WorkspaceSyncClient(localStore: local, loroTransport: transport, workspaceId: workspace)

        let result = try await client.syncLoroPageReadOnly(nodeId: node)
        XCTAssertFalse(result.isDirty)
        let starts = await transport.startCount()
        let messages = await transport.messageCount()
        XCTAssertEqual(starts, 2)
        XCTAssertEqual(messages, 2)
    }

    func testMismatchedResponseDoesNotAdvanceOrClearDurableState() async throws {
        let workspace = try id(), node = try id(), otherSession = UUID().uuidString
        let seed = try await prepared(node: node)
        let transport = LoroTransportFake(
            descriptor: descriptor(node),
            start: .init(sessionId: "", message: seed.snapshotBytes, serverVersion: seed.versionBytes),
            plans: [.response(.init(sessionId: otherSession, ordinal: 0, update: Data(), serverVersion: seed.versionBytes, converged: true, reset: false))]
        )
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        try await addNode(node, workspace: workspace, to: local)
        let client = WorkspaceSyncClient(localStore: local, loroTransport: transport, workspaceId: workspace)

        await assertThrowsAsync(try await client.syncLoroPageReadOnly(nodeId: node)) { error in
            XCTAssertEqual(error as? WorkspaceSyncClientError, .invalidLoroSyncResponse)
        }
        let persisted = try await local.loroPage(nodeId: node)
        let state = try XCTUnwrap(persisted)
        XCTAssertTrue(state.dirty)
        XCTAssertEqual(state.snapshotBytes, seed.snapshotBytes)
    }

    func testSameNodeOperationsAreSerialized() async throws {
        let workspace = try id(), node = try id()
        let seed = try await prepared(node: node)
        let transport = LoroTransportFake(descriptor: descriptor(node), start: .init(sessionId: "", message: seed.snapshotBytes, serverVersion: seed.versionBytes), plans: [.response(.init(sessionId: "", ordinal: 0, update: Data(), serverVersion: seed.versionBytes, converged: true, reset: false)), .response(.init(sessionId: "", ordinal: 0, update: Data(), serverVersion: seed.versionBytes, converged: true, reset: false))], startDelayNanoseconds: 50_000_000)
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        try await addNode(node, workspace: workspace, to: local)
        let client = WorkspaceSyncClient(localStore: local, loroTransport: transport, workspaceId: workspace)

        async let first = client.syncLoroPageReadOnly(nodeId: node)
        async let second = client.syncLoroPageReadOnly(nodeId: node)
        _ = try await (first, second)
        let maximumStarts = await transport.maximumConcurrentStarts()
        XCTAssertEqual(maximumStarts, 1)
    }

    func testDifferentNodesMayStartConcurrently() async throws {
        let workspace = try id(), firstNode = try id(), secondNode = try id()
        let seed = try await prepared(node: firstNode)
        let transport = LoroTransportFake(descriptor: descriptor(firstNode), descriptors: [secondNode.rawValue: descriptor(secondNode)], start: .init(sessionId: "", message: seed.snapshotBytes, serverVersion: seed.versionBytes), plans: [.response(.init(sessionId: "", ordinal: 0, update: Data(), serverVersion: seed.versionBytes, converged: true, reset: false)), .response(.init(sessionId: "", ordinal: 0, update: Data(), serverVersion: seed.versionBytes, converged: true, reset: false))], startDelayNanoseconds: 50_000_000)
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        try await addNode(firstNode, workspace: workspace, to: local)
        try await addNode(secondNode, workspace: workspace, to: local)
        let client = WorkspaceSyncClient(localStore: local, loroTransport: transport, workspaceId: workspace)
        async let first = client.syncLoroPageReadOnly(nodeId: firstNode)
        async let second = client.syncLoroPageReadOnly(nodeId: secondNode)
        _ = try await (first, second)
        let maximumStarts = await transport.maximumConcurrentStarts()
        XCTAssertEqual(maximumStarts, 2)
    }

    func testPersistenceFailureLeavesExistingDirtyRowUntouched() async throws {
        let workspace = try id(), node = try id()
        let seed = try await prepared(node: node)
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let writable = try LocalWorkspaceStore(path: path)
        try await writable.upsertNode(Node(id: node, workspaceId: workspace, title: "Loro", createdAt: "2026-08-20T00:00:00Z"), dirty: false)
        try await writable.upsertLoroPage(.init(prepared: seed, dirty: true, observedDescriptorStorageVersion: 1, observedDescriptorSnapshotSHA256: String(repeating: "a", count: 64)))
        let failing = try LocalWorkspaceStore(path: path, failLoroPageWrites: true)
        let transport = LoroTransportFake(descriptor: descriptor(node), start: .init(sessionId: "", message: seed.snapshotBytes, serverVersion: seed.versionBytes), plans: [])
        let client = WorkspaceSyncClient(localStore: failing, loroTransport: transport, workspaceId: workspace)

        await assertThrowsAsync(try await client.syncLoroPageReadOnly(nodeId: node)) { error in
            XCTAssertEqual(error as? LocalWorkspaceStoreError, .injectedLoroWriteFailure)
        }
        let persisted = try await writable.loroPage(nodeId: node)
        let state = try XCTUnwrap(persisted)
        let messages = await transport.messageCount()
        XCTAssertTrue(state.dirty)
        XCTAssertEqual(state.snapshotBytes, seed.snapshotBytes)
        XCTAssertEqual(messages, 0)
    }

    func testServerAppliedResponseLostThenResetRehandshakesWithoutClearingDirtyEarly() async throws {
        let workspace = try id(), node = try id()
        let seed = try await prepared(node: node)
        let transport = LoroTransportFake(
            descriptor: descriptor(node), start: .init(sessionId: "", message: seed.snapshotBytes, serverVersion: seed.versionBytes),
            plans: [.appliedThenTransportFailure, .response(.init(sessionId: "", ordinal: 0, update: nil, serverVersion: seed.versionBytes, converged: false, reset: true)), .response(.init(sessionId: "", ordinal: 0, update: Data(), serverVersion: seed.versionBytes, converged: true, reset: false))]
        )
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        try await addNode(node, workspace: workspace, to: local)
        let client = WorkspaceSyncClient(localStore: local, loroTransport: transport, workspaceId: workspace)

        await assertThrowsAsync(try await client.syncLoroPageReadOnly(nodeId: node)) { _ in }
        let afterLoss = try await local.loroPage(nodeId: node)
        XCTAssertTrue(try XCTUnwrap(afterLoss).dirty)
        let result = try await client.syncLoroPageReadOnly(nodeId: node)
        let frames = await transport.frames()
        let starts = await transport.startCount()
        let applied = await transport.appliedFrameCount()
        XCTAssertEqual(frames.count, 3)
        XCTAssertEqual(frames[0], frames[1])
        XCTAssertEqual(starts, 2)
        XCTAssertEqual(applied, 1)
        XCTAssertFalse(result.isDirty)
    }

    func testPostAcceptancePersistenceFailureLeavesDurableCandidateDirty() async throws {
        let workspace = try id(), node = try id()
        let seed = try await prepared(node: node)
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString), failLoroPageWrites: false, failLoroPageWritesAfter: 1)
        try await addNode(node, workspace: workspace, to: local)
        let transport = LoroTransportFake(descriptor: descriptor(node), start: .init(sessionId: "", message: seed.snapshotBytes, serverVersion: seed.versionBytes), plans: [.response(.init(sessionId: "", ordinal: 0, update: Data(), serverVersion: seed.versionBytes, converged: true, reset: false))])
        let client = WorkspaceSyncClient(localStore: local, loroTransport: transport, workspaceId: workspace)

        await assertThrowsAsync(try await client.syncLoroPageReadOnly(nodeId: node)) { error in
            XCTAssertEqual(error as? LocalWorkspaceStoreError, .injectedLoroWriteFailure)
        }
        let persisted = try await local.loroPage(nodeId: node)
        let state = try XCTUnwrap(persisted)
        XCTAssertTrue(state.dirty)
    }

    func testCancelledGateWaiterRacingReleaseDoesNotBlockLaterLease() async throws {
        let gate = LoroNodeOperationGate()
        let key = "workspace:node"
        try await gate.acquire(key)
        let waiter = Task { try await gate.acquire(key) }
        try await Task.sleep(nanoseconds: 10_000_000)
        waiter.cancel()
        // Deliberately release without awaiting cancellation delivery: this is the handoff race
        // that must not leave the key owned by the cancelled task.
        await gate.release(key)
        do {
            try await waiter.value
            XCTFail("cancelled waiter acquired a lease")
        } catch is CancellationError {}
        try await gate.acquire(key)
        await gate.release(key)
    }

    func testCancelledSyncAtReleaseHandoffMakesNoTransportCallsAndUnblocksLaterWork() async throws {
        let workspace = try id(), node = try id()
        let seed = try await prepared(node: node)
        let transport = LoroTransportFake(
            descriptor: descriptor(node),
            start: .init(sessionId: "", message: seed.snapshotBytes, serverVersion: seed.versionBytes),
            plans: [
                .response(.init(sessionId: "", ordinal: 0, update: Data(), serverVersion: seed.versionBytes, converged: true, reset: false)),
                .response(.init(sessionId: "", ordinal: 0, update: Data(), serverVersion: seed.versionBytes, converged: true, reset: false)),
            ],
            startDelayNanoseconds: 100_000_000
        )
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        try await addNode(node, workspace: workspace, to: local)
        let client = WorkspaceSyncClient(localStore: local, loroTransport: transport, workspaceId: workspace)

        let first = Task { try await client.syncLoroPageReadOnly(nodeId: node) }
        try await waitUntil { await transport.startCount() == 1 }

        let cancelled = Task { try await client.syncLoroPageReadOnly(nodeId: node) }
        try await Task.sleep(nanoseconds: 20_000_000)
        cancelled.cancel()
        await assertThrowsAsync(try await cancelled.value) { error in
            XCTAssertTrue(error is CancellationError)
        }
        _ = try await first.value

        let firstDescriptorCount = await transport.descriptorCount()
        let firstStartCount = await transport.startCount()
        let firstMessageCount = await transport.messageCount()
        XCTAssertEqual(firstDescriptorCount, 1)
        XCTAssertEqual(firstStartCount, 1)
        XCTAssertEqual(firstMessageCount, 1)

        _ = try await client.syncLoroPageReadOnly(nodeId: node)
        let finalDescriptorCount = await transport.descriptorCount()
        let finalStartCount = await transport.startCount()
        let finalMessageCount = await transport.messageCount()
        XCTAssertEqual(finalDescriptorCount, 2)
        XCTAssertEqual(finalStartCount, 2)
        XCTAssertEqual(finalMessageCount, 2)
    }
}

private actor LoroTransportFake: LoroWorkspaceTransport {
    let descriptor: PageDocumentDescriptor
    private let descriptors: [String: PageDocumentDescriptor]
    private var descriptorSequence: [PageDocumentDescriptor]
    private let startTemplate: StartLoroPageSyncOutput
    private var plans: [MessagePlan]
    private let startDelayNanoseconds: UInt64
    private let failStarts: Bool
    private var starts = 0
    private var descriptorsRequested = 0
    private var messages = 0
    private var creates = 0
    private let pageNotFound: Bool
    private var activeStarts = 0
    private var maximumStarts = 0
    private var sentFrames: [LoroFrame] = []
    private var appliedFrames: [LoroFrame] = []

    init(descriptor: PageDocumentDescriptor, descriptors: [String: PageDocumentDescriptor] = [:], descriptorSequence: [PageDocumentDescriptor] = [], start: StartLoroPageSyncOutput? = nil, plans: [MessagePlan] = [], startDelayNanoseconds: UInt64 = 0, failStarts: Bool = false, pageNotFound: Bool = false) {
        self.descriptor = descriptor
        self.descriptors = descriptors
        self.descriptorSequence = descriptorSequence
        self.startTemplate = start ?? .init(sessionId: "", message: Data(), serverVersion: Data())
        self.plans = plans
        self.startDelayNanoseconds = startDelayNanoseconds
        self.failStarts = failStarts
        self.pageNotFound = pageNotFound
    }
    func getPageDocumentDescriptor(nodeId: String) async throws -> PageDocumentDescriptor {
        if pageNotFound { throw AthenaeumDomainError.pageNotFound(nodeId: nodeId) }
        descriptorsRequested += 1
        if !descriptorSequence.isEmpty { return descriptorSequence.removeFirst() }
        return descriptors[nodeId] ?? descriptor
    }
    func createLoroPage(nodeId: String, creationIntent: CreationIntent) async throws -> PageDocumentDescriptor { creates += 1; return descriptor }
    func startLoroPageSync(nodeId: String, sessionId: String) async throws -> StartLoroPageSyncOutput {
        starts += 1
        if failStarts { throw TestError.unexpected }
        activeStarts += 1
        maximumStarts = max(maximumStarts, activeStarts)
        if startDelayNanoseconds > 0 { try? await Task.sleep(nanoseconds: startDelayNanoseconds) }
        activeStarts -= 1
        return .init(sessionId: sessionId, message: startTemplate.message, serverVersion: startTemplate.serverVersion)
    }
    func loroPageReadSyncMessage(nodeId: String, sessionId: String, ordinal: Int, clientVersion: Data) async throws -> LoroPageSyncMessageOutput {
        messages += 1
        sentFrames.append(.init(sessionId: sessionId, ordinal: ordinal, update: Data(), clientVersion: clientVersion))
        guard !plans.isEmpty else { throw TestError.unexpected }
        switch plans.removeFirst() {
        case .transportFailure: throw TestError.unexpected
        case .appliedThenTransportFailure:
            appliedFrames.append(sentFrames[sentFrames.count - 1])
            throw TestError.unexpected
        case .response(let response): return .init(sessionId: response.sessionId.isEmpty ? sessionId : response.sessionId, ordinal: response.ordinal, update: response.update, serverVersion: response.serverVersion, converged: response.converged, reset: response.reset)
        }
    }
    func startCount() -> Int { starts }
    func descriptorCount() -> Int { descriptorsRequested }
    func messageCount() -> Int { messages }
    func createCount() -> Int { creates }
    func maximumConcurrentStarts() -> Int { maximumStarts }
    func frames() -> [LoroFrame] { sentFrames }
    func appliedFrameCount() -> Int { appliedFrames.count }
}

private enum MessagePlan: Sendable { case transportFailure, appliedThenTransportFailure, response(LoroPageSyncMessageOutput) }
private struct LoroFrame: Sendable, Equatable { let sessionId: String; let ordinal: Int; let update: Data; let clientVersion: Data }
private enum TestError: Error { case unexpected }

private func id() throws -> EntityId { try EntityId(validating: UUID().uuidString.lowercased()) }

private func descriptor(_ node: EntityId) -> PageDocumentDescriptor {
    .nativeLoro(nodeId: node, storageVersion: 1, loro: .init(schemaVersion: 1, snapshotSha256: String(repeating: "a", count: 64)))
}

private func prepared(node: EntityId) async throws -> LoroPreparedPageState {
    let snapshot = try XCTUnwrap(Data(base64Encoded: "bG9ybwAAAAAAAAAAAAAAAL+XJWMAA0QBAABMT1JPAAALAAsBEAH8oDxkq4HFHgEBAAAAAAAFAQAAAQAkBwQBAAAKBAEAAAwEAAAABAQAAQAIBAAAAAoEAAAADgQAAQASZg1zY2hlbWFWZXJzaW9uCG5vZGVOYW1lCmF0dHJpYnV0ZXMKaXNBbWdCbG9jawhjaGlsZHJlbhZhdGhlbmFldW0tcGFnZS1tZXRhLXYxGGF0aGVuYWV1bS1wcm9zZW1pcnJvci12MQAgAQQMFQACAAIBBAIAAgEECgEACAIBBwgCAQcCFgsCFgEAJAMBBQNkb2MJAAIJAQcBCQAFCXBhcmFncmFwaAkAAgkBBwEJAgACAGZyAfzB8qG2teDiHhQAAgB2dgH8wfKhtrXg4h4WAADwAAABAwCypM5TAQAAAAUAAAAMAB7FgatkPKD8AAAAAAACAHZ2qjcHnSEBAACrAQAATE9STwAEIk0YYECCVwEAAPd1AAIBABhhdGhlbmFldW0tcHJvc2VtaXJyb3ItdjEBAQppc0FtZ0Jsb2NrAQAAAfygPGSrgcUeAAMJBAAFAAAAAAMBAfzB8qG2teDiHggCAwphdHRyaWJ1dGVzBwH8wfKhtrXg4h4OAQhub2RlTmFtZQQJcGFyYWdyYXBoCGNoaWxkcmVuKgAnEgJlAOcHAAkABgkEAAcAAAAABGkAHwqZAAc2CAANQgBfBAAAAAHhAAsHfAAlCgF7ALgBAwIBAAIBCgIBAFAAEAlQAAuJAAdBABYUegADQQASFEEAFAI4AWcKAAAAAgXKAFASAgAAA6cAAAIARxgAgBaLAfgPYWdlLW1ldGEtdjEAAQABDXNjaGVtYVZlcnNpb24DKQFfAAAaAIDGAQY/AAEAmAEEFwSYAU8DZG9jkgEBGAhpAPAIAgAEAAEAADgAoQDRACEBYgGLAcYBCAAAAAAANH9LUAEAAAAFAAAADQAA/KA8ZKuBxR4CAAAAARoAgBhhdGhlbmFldW0tcHJvc2VtaXJyb3ItdjEcZA0VbwEAAAAAAAA="))
    return try await LoroPageDocumentStore().prepare(nodeId: node, snapshot: snapshot)
}

private func addNode(_ node: EntityId, workspace: EntityId, to local: LocalWorkspaceStore) async throws {
    try await local.upsertNode(Node(id: node, workspaceId: workspace, title: "Loro", createdAt: "2026-08-20T00:00:00Z"), dirty: false)
}

private func assertThrowsAsync<T>(_ expression: @autoclosure () async throws -> T, _ handler: (Error) -> Void) async {
    do { _ = try await expression(); XCTFail("expected error") } catch { handler(error) }
}

private func waitUntil(_ predicate: @escaping @Sendable () async -> Bool) async throws {
    for _ in 0 ..< 100 {
        if await predicate() { return }
        try await Task.sleep(nanoseconds: 1_000_000)
    }
    XCTFail("timed out waiting for test condition")
}
