import AthenaeumDomain
import Foundation

/// The only durable states for a semantic Loro operation. Absence of a row means clean.
public enum LoroSemanticCheckpointState: String, Sendable, Equatable {
    case inFlight
    case retainedRetry
    case retainedConflict
    case retainedRequestIdentity
    /// A terminal, non-dispatchable working-slot marker. The immutable pre-terminal evidence is
    /// retained separately in `loro_semantic_checkpoint_archive_v7`; this marker merely lets the
    /// slot be reused without deleting history.
    case acceptedArchived
}

/// A v5 checkpoint is evidence only: it lacks an independently durable clone snapshot and can
/// therefore never be replayed by the v6 runtime.
public enum LoroSemanticCheckpointDisposition: Sendable, Equatable {
    case none
    case active(LoroSemanticCheckpoint)
    case migratedV5Quarantined(LoroLegacySemanticCheckpointEvidence)
    case migratedV6Quarantined(LoroV6SemanticCheckpointEvidence)
}

/// Deliberately opaque evidence retained from the pre-v6 layout. It carries no replayable update
/// or intent material into the production candidate path.
public struct LoroLegacySemanticCheckpointEvidence: Sendable, Equatable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public let disposition = "migrated-v5-quarantined"
    init(workspaceId: EntityId, nodeId: EntityId) { self.workspaceId = workspaceId; self.nodeId = nodeId }
}

/// v6 included a candidate snapshot but not the frozen literal base bytes.  It is intentionally
/// retained as forensic evidence and can never be upgraded into v7 dispatch material.
public struct LoroV6SemanticCheckpointEvidence: Sendable, Equatable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public let disposition = "migrated-v6-quarantined"
    init(workspaceId: EntityId, nodeId: EntityId) { self.workspaceId = workspaceId; self.nodeId = nodeId }
}

/// Immutable evidence retained before a semantic submit crosses its test-only transport seam.
/// This is intentionally value-only: Loro handles and arbitrary attribution JSON cannot enter it.
public struct LoroSemanticCheckpoint: Sendable, Equatable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public let state: LoroSemanticCheckpointState
    public let intent: LoroMutationIntentV1
    public let route: LoroPageRouteWitness
    public let update: Data
    public let updateSHA256: String
    public let baseVersionVector: Data
    public let baseVersionVectorSHA256: String

    public init(
        workspaceId: EntityId,
        nodeId: EntityId,
        state: LoroSemanticCheckpointState,
        intent: LoroMutationIntentV1,
        route: LoroPageRouteWitness,
        update: Data,
        baseVersionVector: Data
    ) throws {
        guard route.nodeId == nodeId, route.format == .loroV1,
              LoroWireSafeInteger.contains(route.storageVersion),
              LoroWireSafeInteger.contains(route.schemaVersion),
              LoroMutationWire.isDigest(route.snapshotSHA256),
              !update.isEmpty, update.count <= 2 * 1024 * 1024,
              !baseVersionVector.isEmpty, baseVersionVector.count <= LoroPageProjectionLimits().maxVersionVectorBytes else {
            throw LocalWorkspaceStoreError.invalidLoroCheckpoint
        }
        let baseDigest: String
        do { baseDigest = try VersionVectorIdentity.digest(encodedVersionVector: baseVersionVector) }
        catch { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
        self.workspaceId = workspaceId
        self.nodeId = nodeId
        self.state = state
        self.intent = intent
        self.route = route
        self.update = update
        self.updateSHA256 = LoroMutationWire.sha256Hex(update)
        self.baseVersionVector = baseVersionVector
        self.baseVersionVectorSHA256 = baseDigest
    }

    func changing(state: LoroSemanticCheckpointState) -> LoroSemanticCheckpoint {
        // The initializer has already sealed all immutable material.
        var copy = self
        copy = LoroSemanticCheckpoint(uncheckedWorkspaceId: workspaceId, nodeId: nodeId, state: state, intent: intent, route: route, update: update, updateSHA256: updateSHA256, baseVersionVector: baseVersionVector, baseVersionVectorSHA256: baseVersionVectorSHA256)
        return copy
    }

    private init(uncheckedWorkspaceId: EntityId, nodeId: EntityId, state: LoroSemanticCheckpointState, intent: LoroMutationIntentV1, route: LoroPageRouteWitness, update: Data, updateSHA256: String, baseVersionVector: Data, baseVersionVectorSHA256: String) {
        self.workspaceId = uncheckedWorkspaceId; self.nodeId = nodeId; self.state = state; self.intent = intent; self.route = route; self.update = update; self.updateSHA256 = updateSHA256; self.baseVersionVector = baseVersionVector; self.baseVersionVectorSHA256 = baseVersionVectorSHA256
    }

    static func reconstruct(workspaceId: EntityId, nodeId: EntityId, state: String, requestId: String, commitMessage: String, attributionKind: String, attributionOne: String, attributionTwo: String?, storageVersion: Int, schemaVersion: Int, snapshotSHA256: String, update: Data, updateSHA256: String, baseVersionVector: Data, baseVersionVectorSHA256: String) throws -> Self {
        let attribution: LoroMutationAttributionV1
        switch (attributionKind, attributionTwo) {
        case ("humanUi", nil): attribution = .humanUi(surface: attributionOne)
        case ("agentJob", let runId?): attribution = .agentJob(jobId: attributionOne, runId: runId)
        case ("system", nil): attribution = .system(source: attributionOne)
        default: throw LocalWorkspaceStoreError.invalidLoroCheckpoint
        }
        guard let state = LoroSemanticCheckpointState(rawValue: state) else { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
        let intent: LoroMutationIntentV1
        do { intent = try .init(requestId: requestId, commitMessage: commitMessage, attribution: attribution) }
        catch { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
        let candidate = try Self(workspaceId: workspaceId, nodeId: nodeId, state: state, intent: intent, route: .init(nodeId: nodeId, format: .loroV1, storageVersion: storageVersion, schemaVersion: schemaVersion, snapshotSHA256: snapshotSHA256), update: update, baseVersionVector: baseVersionVector)
        guard candidate.updateSHA256 == updateSHA256, candidate.baseVersionVectorSHA256 == baseVersionVectorSHA256 else { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
        return candidate
    }

    func databaseAttribution() -> (String, String, String?) {
        switch intent.attribution {
        case .humanUi(let surface): return ("humanUi", surface, nil)
        case .agentJob(let jobId, let runId): return ("agentJob", jobId, runId)
        case .system(let source): return ("system", source, nil)
        }
    }
}
