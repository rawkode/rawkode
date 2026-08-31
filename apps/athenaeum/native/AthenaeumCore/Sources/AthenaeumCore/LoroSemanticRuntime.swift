import AthenaeumDomain
@_spi(AthenaeumCore) import AthenaeumRPC
import Foundation

/// Authenticated composition-root capability. The semantic runtime cannot be constructed without
/// this explicit, unexpired binding; the server remains the authority for the actual principal.
public struct LoroSemanticCustody: Sendable, Equatable {
    fileprivate let workspaceId: EntityId
    fileprivate let intent: LoroMutationIntentV1
    fileprivate let expiresAt: Date
    /// Deliberately Core-only: only `WorkspaceSyncClient` creates this after `whoami` proves an
    /// authenticated RPC session. A caller cannot mint a future-dated local authorization token.
    init(workspaceId: EntityId, intent: LoroMutationIntentV1, expiresAt: Date) {
        self.workspaceId = workspaceId; self.intent = intent; self.expiresAt = expiresAt
    }
    fileprivate func permits(workspaceId: EntityId, intent: LoroMutationIntentV1, now: Date = Date()) -> Bool {
        self.workspaceId == workspaceId && self.intent == intent && expiresAt > now
    }
}

public enum LoroSemanticRuntimeError: Error, Sendable, Equatable { case custodyDenied }

/// Production-only bridge for semantic commits.  This is the sole Core call site allowed to send
/// a nonempty Loro update; read recovery uses the public empty-frame protocol.
private struct LoroSemanticRPCTransport: LoroSemanticCheckpointTransport {
    let rpc: WorkspaceRPCClient
    let documents: LoroPageDocumentStore
    let custody: LoroSemanticCustody
    let now: @Sendable () -> Date

    func submit(_ checkpoint: LoroSemanticCheckpoint) async throws -> LoroSemanticCheckpointReceipt {
        guard custody.permits(workspaceId: checkpoint.workspaceId, intent: checkpoint.intent, now: now()) else { throw LoroSemanticCheckpointTransportError.authorizationDenied }
        do {
            let output = try await rpc.commitLoroPageContent(.init(
                workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId, intent: checkpoint.intent,
                expectedStorageVersion: checkpoint.route.storageVersion,
                expectedSnapshotSHA256: checkpoint.route.snapshotSHA256,
                expectedVersionVector: checkpoint.baseVersionVector,
                expectedVersionVectorIdentitySHA256: checkpoint.baseVersionVectorSHA256,
                update: checkpoint.update
            ))
            let route = try route(output.descriptor, expectedNode: checkpoint.nodeId)
            return .init(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId,
                         intent: checkpoint.intent, baseRoute: checkpoint.route, resultRoute: route,
                         updateSHA256: output.updateSHA256, baseVersionVectorSHA256: output.baseVersionVectorSHA256,
                         resultSnapshotSHA256: output.resultSnapshotSHA256, resultVersionVectorSHA256: output.resultVersionVectorSHA256)
        } catch let error as AthenaeumDomainError {
            switch error {
            case .loroContentConflict(let nodeId, _, _, _, _, _, _, _) where nodeId == checkpoint.nodeId.rawValue:
                throw LoroSemanticCheckpointTransportError.contentConflict
            case .loroRequestIdentityConflict(let nodeId, let requestId) where nodeId == checkpoint.nodeId.rawValue && requestId == checkpoint.intent.requestId:
                throw LoroSemanticCheckpointTransportError.requestIdentityConflict
            case .unauthorized, .workspaceNotFound, .workspaceAccessDenied:
                throw LoroSemanticCheckpointTransportError.authorizationDenied
            default: throw LoroSemanticCheckpointTransportError.unknown
            }
        } catch { throw LoroSemanticCheckpointTransportError.unknown }
    }

    func reload(workspaceId: EntityId, nodeId: EntityId) async throws -> LoroSemanticCheckpointAuthority {
        guard custody.workspaceId == workspaceId, custody.expiresAt > now() else { throw LoroSemanticCheckpointTransportError.authorizationDenied }
        let requestedSessionId = UUID().uuidString
        let started: StartLoroPageSyncOutput
        do { started = try await rpc.startLoroPageSync(nodeId: nodeId.rawValue, sessionId: requestedSessionId) }
        catch { throw LoroSemanticCheckpointTransportError.unknown }
        guard started.sessionId == requestedSessionId, !started.sessionId.isEmpty else {
            throw LoroSemanticCheckpointTransportError.unknown
        }
        var prepared: LoroPreparedPageState
        do {
            let blank = try await documents.loadEmptyReplica()
            prepared = try await documents.prepare(nodeId: nodeId, snapshot: blank.snapshotBytes, applying: started.message, serverVersion: started.serverVersion)
            var ordinal = 0
            var converged = false
            while ordinal < 50 {
                let response = try await rpc.loroPageReadSyncMessage(nodeId: nodeId.rawValue, sessionId: started.sessionId, ordinal: ordinal, clientVersion: prepared.versionBytes)
                guard response.sessionId == started.sessionId, response.ordinal == ordinal, !response.reset else { throw LoroSemanticCheckpointTransportError.unknown }
                prepared = try await documents.prepare(nodeId: nodeId, snapshot: prepared.snapshotBytes, applying: response.update, serverVersion: response.serverVersion)
                if response.converged { converged = true; break }
                ordinal += 1
            }
            guard converged else { throw LoroSemanticCheckpointTransportError.unknown }
            let descriptor = try await rpc.getPageDocumentDescriptor(nodeId: nodeId.rawValue)
            let witness = try route(descriptor, expectedNode: nodeId)
            // Loro snapshot exports are not canonical wire values. This raw reconstructed
            // snapshot is semantic proof for the receipt path only; the descriptor route stays
            // separately bound and no raw-byte comparison can promote it to literal authority.
            return .init(workspaceId: workspaceId, nodeId: nodeId, route: witness, snapshot: prepared.snapshotBytes, versionVector: prepared.versionBytes)
        } catch let error as LoroSemanticCheckpointTransportError { throw error }
        catch { throw LoroSemanticCheckpointTransportError.unknown }
    }

    private func route(_ descriptor: PageDocumentDescriptor, expectedNode: EntityId) throws -> LoroPageRouteWitness {
        guard descriptor.nodeId == expectedNode else { throw LoroSemanticCheckpointTransportError.unknown }
        let loro: LoroPageDocumentDescriptor
        switch descriptor { case .nativeLoro(_, _, let value), .migratedLoro(_, _, _, let value): loro = value; case .legacy: throw LoroSemanticCheckpointTransportError.unknown }
        return .init(nodeId: expectedNode, format: .loroV1, storageVersion: descriptor.storageVersion, schemaVersion: loro.schemaVersion, snapshotSHA256: loro.snapshotSha256)
    }
}

/// Core-owned semantic editor/checkpoint runtime.  It borrows the sync client's exact document
/// store and node gate, preventing a read-sync and a semantic dispatch/recovery from overlapping.
actor LoroSemanticRuntime {
    private let local: LocalWorkspaceStore
    private let documents: LoroPageDocumentStore
    private let gate: LoroNodeOperationGate
    private let workspaceId: EntityId
    private let custody: LoroSemanticCustody
    private let now: @Sendable () -> Date
    private let machine: LoroSemanticCheckpointStateMachine

    init(local: LocalWorkspaceStore, documents: LoroPageDocumentStore, gate: LoroNodeOperationGate, rpc: WorkspaceRPCClient, workspaceId: EntityId, custody: LoroSemanticCustody, now: @escaping @Sendable () -> Date = { Date() }) {
        self.local = local; self.documents = documents; self.gate = gate; self.workspaceId = workspaceId; self.custody = custody; self.now = now
        self.machine = LoroSemanticCheckpointStateMachine(local: local, documents: documents, transport: LoroSemanticRPCTransport(rpc: rpc, documents: documents, custody: custody, now: now))
    }

    /// Internal fake seam for Core tests. It deliberately accepts only the checkpoint contract,
    /// never a raw-update function or a Loro handle.
    init(local: LocalWorkspaceStore, documents: LoroPageDocumentStore, gate: LoroNodeOperationGate, workspaceId: EntityId, custody: LoroSemanticCustody, transport: any LoroSemanticCheckpointTransport, now: @escaping @Sendable () -> Date = { Date() }) {
        self.local = local; self.documents = documents; self.gate = gate; self.workspaceId = workspaceId; self.custody = custody; self.now = now
        self.machine = LoroSemanticCheckpointStateMachine(local: local, documents: documents, transport: transport)
    }

    /// A nonempty edit is cloned, frozen, and persisted before this method can cross the RPC
    /// boundary. No raw update or Loro object is exposed from the public API.
    public func replacePlainText(nodeId: EntityId, scalarRange: Range<Int>, replacement: String) async throws -> LoroSemanticCheckpointOutcome {
        // This preflight deliberately precedes acquiring a candidate, touching SQLite, or
        // crossing transport. Expiry later in an in-flight operation retains its frozen evidence.
        guard custody.permits(workspaceId: workspaceId, intent: custody.intent, now: now()) else { return .deniedAuthorizationOrSession }
        return try await gate.withLease(key(nodeId)) { [local, documents, machine, workspaceId, custody, now] in
            guard custody.permits(workspaceId: workspaceId, intent: custody.intent, now: now()) else { return .deniedAuthorizationOrSession }
            guard let node = try await local.node(id: nodeId), node.workspaceId == workspaceId else { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
            guard let state = try await local.loroPage(nodeId: nodeId), state.nodeId == nodeId, !state.dirty,
                  state.pageSchemaVersion == 1, state.observedDescriptorStorageVersion > 0,
                  state.localSnapshotSHA256 == state.observedDescriptorSnapshotSHA256 else { throw LoroPageDocumentStoreError.nativePlainTextDirty }
            // Authoring consumes only a pre-installed literal cache. In particular, a
            // `committedCacheInvalidated` result must fail closed here until the caller invokes
            // the explicit accepted-row recovery operation; a next edit may not silently load
            // bytes from SQLite into literal authority.
            let vector = try await documents.prepare(nodeId: nodeId, snapshot: state.snapshotBytes).versionBytes
            let replica = LoroPageReplicaWitness(snapshotSHA256: state.localSnapshotSHA256, versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: vector))
            let route = LoroPageRouteWitness(nodeId: nodeId, format: .loroV1, storageVersion: state.observedDescriptorStorageVersion, schemaVersion: state.pageSchemaVersion, snapshotSHA256: state.observedDescriptorSnapshotSHA256)
            let candidate = try await documents.prepareNativePlainSemanticCandidateV1(nodeId: nodeId, route: route, persistedReplica: replica, publishedReplica: replica, isDirty: state.dirty, scalarRange: scalarRange, replacement: replacement, workspaceId: workspaceId, intent: custody.intent)
            return try await machine.submit(candidate)
        }
    }

    /// The value-only editor facade has already acquired this runtime's node gate. Keeping this
    /// separate avoids a second lease acquisition between state validation and candidate freeze.
    func replacePlainTextAssumingLease(nodeId: EntityId, scalarRange: Range<Int>, replacement: String) async throws -> LoroSemanticCheckpointOutcome {
        guard custody.permits(workspaceId: workspaceId, intent: custody.intent, now: now()) else { return .deniedAuthorizationOrSession }
        guard let node = try await local.node(id: nodeId), node.workspaceId == workspaceId else { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
        guard let state = try await local.loroPage(nodeId: nodeId), state.nodeId == nodeId, !state.dirty,
              state.pageSchemaVersion == 1, state.observedDescriptorStorageVersion > 0,
              state.localSnapshotSHA256 == state.observedDescriptorSnapshotSHA256 else { throw LoroPageDocumentStoreError.nativePlainTextDirty }
        // See `replacePlainText`: the literal cache is an explicit recovery boundary, not an
        // implicit side effect of a new editor submission.
        let vector = try await documents.prepare(nodeId: nodeId, snapshot: state.snapshotBytes).versionBytes
        let replica = LoroPageReplicaWitness(snapshotSHA256: state.localSnapshotSHA256, versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: vector))
        let route = LoroPageRouteWitness(nodeId: nodeId, format: .loroV1, storageVersion: state.observedDescriptorStorageVersion, schemaVersion: state.pageSchemaVersion, snapshotSHA256: state.observedDescriptorSnapshotSHA256)
        let candidate = try await documents.prepareNativePlainSemanticCandidateV1(nodeId: nodeId, route: route, persistedReplica: replica, publishedReplica: replica, isDirty: state.dirty, scalarRange: scalarRange, replacement: replacement, workspaceId: workspaceId, intent: custody.intent)
        return try await machine.submit(candidate)
    }

    /// Rich facade hook: caller already owns the node lease and passes semantic values only.
    func replaceRichDocumentAssumingLease(nodeId: EntityId, proposed: LoroNativeRichDocumentV1) async throws -> LoroSemanticCheckpointOutcome {
        guard custody.permits(workspaceId: workspaceId, intent: custody.intent, now: now()) else { return .deniedAuthorizationOrSession }
        guard let node = try await local.node(id: nodeId), node.workspaceId == workspaceId else { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
        guard let state = try await local.loroPage(nodeId: nodeId), state.nodeId == nodeId, !state.dirty,
              state.pageSchemaVersion == 1, state.observedDescriptorStorageVersion > 0,
              state.localSnapshotSHA256 == state.observedDescriptorSnapshotSHA256 else { throw LoroPageDocumentStoreError.nativePlainTextDirty }
        let vector = try await documents.prepare(nodeId: nodeId, snapshot: state.snapshotBytes).versionBytes
        let replica = LoroPageReplicaWitness(snapshotSHA256: state.localSnapshotSHA256, versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: vector))
        let route = LoroPageRouteWitness(nodeId: nodeId, format: .loroV1, storageVersion: state.observedDescriptorStorageVersion, schemaVersion: state.pageSchemaVersion, snapshotSHA256: state.observedDescriptorSnapshotSHA256)
        let candidate = try await documents.prepareNativeRichSemanticCandidateV1(nodeId: nodeId, route: route, persistedReplica: replica, publishedReplica: replica, isDirty: state.dirty, workspaceId: workspaceId, intent: custody.intent, proposed: proposed)
        return try await machine.submit(candidate)
    }

    /// Dedicated checklist mutation path. The semantic command is structural and idempotent;
    /// `LoroPageDocumentStore` applies it in place so a one-bit toggle never falls back to the
    /// generic full-document reconstruction writer.
    func toggleRichTaskItemAssumingLease(
        nodeId: EntityId,
        command: LoroNativeRichTaskItemToggleCommand
    ) async throws -> LoroSemanticCheckpointOutcome {
        guard custody.permits(workspaceId: workspaceId, intent: custody.intent, now: now()) else { return .deniedAuthorizationOrSession }
        guard let node = try await local.node(id: nodeId), node.workspaceId == workspaceId else { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
        guard let state = try await local.loroPage(nodeId: nodeId), state.nodeId == nodeId, !state.dirty,
              state.pageSchemaVersion == 1, state.observedDescriptorStorageVersion > 0,
              state.localSnapshotSHA256 == state.observedDescriptorSnapshotSHA256 else { throw LoroPageDocumentStoreError.nativePlainTextDirty }
        let vector = try await documents.prepare(nodeId: nodeId, snapshot: state.snapshotBytes).versionBytes
        let replica = LoroPageReplicaWitness(snapshotSHA256: state.localSnapshotSHA256, versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: vector))
        let route = LoroPageRouteWitness(nodeId: nodeId, format: .loroV1, storageVersion: state.observedDescriptorStorageVersion, schemaVersion: state.pageSchemaVersion, snapshotSHA256: state.observedDescriptorSnapshotSHA256)
        let candidate = try await documents.prepareNativeRichTaskToggleCandidateV1(
            nodeId: nodeId,
            route: route,
            persistedReplica: replica,
            publishedReplica: replica,
            isDirty: state.dirty,
            workspaceId: workspaceId,
            intent: custody.intent,
            command: command
        )
        return try await machine.submit(candidate)
    }

    public func recoverInFlight(nodeId: EntityId) async throws -> LoroSemanticCheckpointOutcome? {
        guard custody.permits(workspaceId: workspaceId, intent: custody.intent, now: now()) else { return .deniedAuthorizationOrSession }
        return try await gate.withLease(key(nodeId)) { [local, machine, workspaceId, custody, now] in
            guard custody.permits(workspaceId: workspaceId, intent: custody.intent, now: now()) else { return .deniedAuthorizationOrSession }
            guard let node = try await local.node(id: nodeId), node.workspaceId == workspaceId else { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
            guard let checkpoint = try await local.loroCheckpoint(workspaceId: workspaceId, nodeId: nodeId) else { return nil }
            guard checkpoint.state == .inFlight || checkpoint.state == .retainedRetry else { return nil }
            guard checkpoint.intent == custody.intent else { return .deniedAuthorizationOrSession }
            if checkpoint.state == .inFlight { _ = try await local.transitionLoroCheckpoint(workspaceId: workspaceId, nodeId: nodeId, from: .inFlight, to: .retainedRetry) }
            return try await machine.retry(workspaceId: workspaceId, nodeId: nodeId)
        }
    }

    /// Internal facade hook: the caller already owns this runtime's exact node lease.
    func recoverInFlightAssumingLease(nodeId: EntityId) async throws -> LoroSemanticCheckpointOutcome? {
        guard custody.permits(workspaceId: workspaceId, intent: custody.intent, now: now()) else { return .deniedAuthorizationOrSession }
        guard let node = try await local.node(id: nodeId), node.workspaceId == workspaceId else { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
        guard let checkpoint = try await local.loroCheckpoint(workspaceId: workspaceId, nodeId: nodeId), checkpoint.state == .inFlight else { return nil }
        guard checkpoint.intent == custody.intent else { return .deniedAuthorizationOrSession }
        _ = try await local.transitionLoroCheckpoint(workspaceId: workspaceId, nodeId: nodeId, from: .inFlight, to: .retainedRetry)
        return try await machine.retry(workspaceId: workspaceId, nodeId: nodeId)
    }

    /// Internal facade hook for an explicitly selected retained-retry row.
    func retryRetainedAssumingLease(nodeId: EntityId) async throws -> LoroSemanticCheckpointOutcome? {
        guard custody.permits(workspaceId: workspaceId, intent: custody.intent, now: now()) else { return .deniedAuthorizationOrSession }
        guard let node = try await local.node(id: nodeId), node.workspaceId == workspaceId else { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
        guard let checkpoint = try await local.loroCheckpoint(workspaceId: workspaceId, nodeId: nodeId), checkpoint.state == .retainedRetry else { return nil }
        guard checkpoint.intent == custody.intent else { return .deniedAuthorizationOrSession }
        return try await machine.retry(workspaceId: workspaceId, nodeId: nodeId)
    }

    private func key(_ nodeId: EntityId) -> String { "\(workspaceId.rawValue):\(nodeId.rawValue)" }
}
