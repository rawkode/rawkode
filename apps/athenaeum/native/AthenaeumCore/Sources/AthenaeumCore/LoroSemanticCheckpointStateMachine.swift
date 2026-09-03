import AthenaeumDomain
import Foundation

/// Fake-only seam for NLE-01. Production RPC, sessions, raw sync, and transport adapters are
/// deliberately absent from this Core foundation.
protocol LoroSemanticCheckpointTransport: Sendable {
    func submit(_ checkpoint: LoroSemanticCheckpoint) async throws -> LoroSemanticCheckpointReceipt
    func reload(workspaceId: EntityId, nodeId: EntityId) async throws -> LoroSemanticCheckpointAuthority
}

enum LoroSemanticCheckpointTransportError: Error, Sendable, Equatable {
    case unknown
    case contentConflict
    case requestIdentityConflict
    case authorizationDenied
}

public enum LoroSemanticCheckpointOutcome: Sendable, Equatable {
    case committed
    /// SQLite committed the accepted literal and archived its evidence, but cache publication
    /// failed afterwards. The only safe UI action is to reload from the durable accepted row.
    case committedCacheInvalidated
    case retainedRetry
    case retainedConflict
    case retainedRequestIdentity
    case deniedAuthorizationOrSession
}

struct LoroSemanticCheckpointAuthority: Sendable, Equatable {
    let workspaceId: EntityId
    let nodeId: EntityId
    let route: LoroPageRouteWitness
    let snapshot: Data
    let versionVector: Data
}

/// A source-sealed reconstruction envelope.  It is intentionally not a literal snapshot token:
/// the raw bytes can be inspected for semantic convergence only and may never reach persistence
/// or cache publication.  Tests can provide the raw transport authority but cannot mint this
/// evidence type under `@testable`.
struct LoroReconstructedAuthorityObservation: Sendable, Equatable {
    let workspaceId: EntityId
    let nodeId: EntityId
    let route: LoroPageRouteWitness
    let snapshot: Data
    let versionVector: Data

    private init(workspaceId: EntityId, nodeId: EntityId, route: LoroPageRouteWitness, snapshot: Data, versionVector: Data) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
        self.route = route
        self.snapshot = snapshot
        self.versionVector = versionVector
    }

    fileprivate static func reconstructed(from authority: LoroSemanticCheckpointAuthority, expectedWorkspace: EntityId, expectedNode: EntityId) throws -> Self {
        guard authority.workspaceId == expectedWorkspace,
              authority.nodeId == expectedNode,
              authority.route.nodeId == expectedNode,
              authority.route.format == .loroV1,
              !authority.snapshot.isEmpty,
              !authority.versionVector.isEmpty else {
            throw LoroSemanticCheckpointStateMachineError.invalidAuthority
        }
        return .init(
            workspaceId: authority.workspaceId,
            nodeId: authority.nodeId,
            route: authority.route,
            snapshot: authority.snapshot,
            versionVector: authority.versionVector
        )
    }
}

struct LoroSemanticCheckpointReceipt: Sendable, Equatable {
    /// The receipt is bound to the dispatched checkpoint's target.  It is evidence about that
    /// target only; it must never select the follow-up reload target.
    let workspaceId: EntityId
    let nodeId: EntityId
    let intent: LoroMutationIntentV1
    let baseRoute: LoroPageRouteWitness
    let resultRoute: LoroPageRouteWitness
    let updateSHA256: String
    let baseVersionVectorSHA256: String
    let resultSnapshotSHA256: String
    let resultVersionVectorSHA256: String
}

enum LoroSemanticCheckpointStateMachineError: Error, Sendable, Equatable {
    case checkpointAlreadyExists
    case retryNotAvailable
    case discardNotAvailable
    case invalidAuthority
    case invalidReceipt
    /// A reconstructed reload is not an authority token.  A route/vector/text mismatch after a
    /// receipt is therefore retained for retry rather than being promoted or persisted.
    case reconstructedAuthorityMismatch
}

/// Core-only durable state machine. Every externally visible dispatch is preceded by a committed
/// checkpoint; cache publication is strictly after the corresponding storage transaction.
actor LoroSemanticCheckpointStateMachine {
    private let local: LocalWorkspaceStore
    private let documents: LoroPageDocumentStore
    private let transport: any LoroSemanticCheckpointTransport
#if DEBUG
    // Test-only and compiled out of release: the transport snapshot has already passed full
    // route/hash/schema/version-vector validation before this proof-only transform runs. It lets
    // acceptance tests exercise an otherwise unrepresentable semantic disagreement (the same
    // route hash cannot honestly name different raw content).
    private var testOnlyProofTransform: (@Sendable (LoroReconstructedAuthorityProof) -> LoroReconstructedAuthorityProof)?
#endif

    init(local: LocalWorkspaceStore, documents: LoroPageDocumentStore, transport: any LoroSemanticCheckpointTransport) {
        self.local = local; self.documents = documents; self.transport = transport
    }

#if DEBUG
    func installTestOnlyProofTransform(
        _ transform: @escaping @Sendable (LoroReconstructedAuthorityProof) -> LoroReconstructedAuthorityProof
    ) {
        testOnlyProofTransform = transform
    }
#endif

    /// Submission accepts only an actor-minted frozen literal candidate. Generic reconstructed
    /// snapshots and caller-supplied base bytes never reach the durable v7 write boundary.
    func submit(_ frozen: LoroFrozenLiteralCandidate) async throws -> LoroSemanticCheckpointOutcome {
        do {
            try await local.persistFrozenLiteralCandidate(actorIssued: frozen)
        } catch LocalWorkspaceStoreError.checkpointAlreadyExists {
            throw LoroSemanticCheckpointStateMachineError.checkpointAlreadyExists
        }
        return await dispatch(frozen.checkpoint)
    }

    func retry(workspaceId: EntityId, nodeId: EntityId) async throws -> LoroSemanticCheckpointOutcome {
        let evidence: LoroFrozenCandidateEvidence
        do {
            // This transaction validates the exact retained row and transitions it to in-flight
            // before any candidate material can reach the transport seam.
            evidence = try await local.beginRetryLoroCheckpoint(workspaceId: workspaceId, nodeId: nodeId)
        } catch LocalWorkspaceStoreError.invalidLoroCheckpoint {
            throw LoroSemanticCheckpointStateMachineError.retryNotAvailable
        }

        do {
            let frozen = try await documents.remintFrozenLiteralCandidate(evidence)
            guard frozen.checkpoint == evidence.checkpoint else {
                throw LoroSemanticCheckpointStateMachineError.invalidReceipt
            }
        } catch {
            // Semantic revalidation failed after the atomic begin. Put the exact row back into
            // retained retry and never dispatch its bytes.
            _ = try? await local.transitionLoroCheckpoint(
                workspaceId: workspaceId,
                nodeId: nodeId,
                from: .inFlight,
                to: .retainedRetry
            )
            return .retainedRetry
        }
        return await dispatch(evidence.checkpoint)
    }

    func discardAndReload(workspaceId: EntityId, nodeId: EntityId) async throws {
        guard let checkpoint = try await local.loroCheckpoint(workspaceId: workspaceId, nodeId: nodeId),
              checkpoint.state == .retainedConflict || checkpoint.state == .retainedRequestIdentity else {
            throw LoroSemanticCheckpointStateMachineError.discardNotAvailable
        }
        // The v7 state alphabet intentionally has no destructive/discarded terminal. A conflict
        // remains retained until a future explicit resolution protocol supplies archival
        // semantics; silently deleting or rewriting its frozen evidence would violate custody.
        _ = checkpoint
        throw LoroSemanticCheckpointStateMachineError.discardNotAvailable
    }

    private func dispatch(_ checkpoint: LoroSemanticCheckpoint) async -> LoroSemanticCheckpointOutcome {
        do {
            let receipt = try await transport.submit(checkpoint)
            return try await accept(receipt: receipt, checkpoint: checkpoint)
        } catch is CancellationError {
            _ = try? await local.transitionLoroCheckpoint(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId, from: .inFlight, to: .retainedRetry)
            return .retainedRetry
        } catch let error as LoroSemanticCheckpointTransportError {
            let target: LoroSemanticCheckpointState
            switch error {
            case .contentConflict: target = .retainedConflict
            case .requestIdentityConflict: target = .retainedRequestIdentity
            case .unknown: target = .retainedRetry
            case .authorizationDenied:
                _ = try? await local.transitionLoroCheckpoint(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId, from: .inFlight, to: .retainedRetry)
                return .deniedAuthorizationOrSession
            }
            _ = try? await local.transitionLoroCheckpoint(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId, from: .inFlight, to: target)
            return target == .retainedConflict ? .retainedConflict : target == .retainedRequestIdentity ? .retainedRequestIdentity : .retainedRetry
        } catch LoroSemanticCheckpointStateMachineError.reconstructedAuthorityMismatch {
            // The reload was successfully bounded to the checkpoint target, but it was causally
            // newer or otherwise not the exact frozen result.  Keep the candidate untouched.
            _ = try? await local.transitionLoroCheckpoint(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId, from: .inFlight, to: .retainedRetry)
            return .retainedRetry
        } catch {
            _ = try? await local.transitionLoroCheckpoint(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId, from: .inFlight, to: .retainedRetry)
            return .retainedRetry
        }
    }

    private func accept(receipt: LoroSemanticCheckpointReceipt, checkpoint: LoroSemanticCheckpoint) async throws -> LoroSemanticCheckpointOutcome {
        // A returned receipt always causes exactly one bounded reload of the checkpoint target,
        // even if the receipt is malformed or names another workspace/node.  Receipt fields are
        // evidence to validate afterwards, never routing input.
        let authority = try await transport.reload(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId)
        guard let evidence = try await local.frozenCandidateEvidence(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId),
              evidence.checkpoint == checkpoint else {
            throw LoroSemanticCheckpointStateMachineError.invalidReceipt
        }
        let frozen = try await documents.remintFrozenLiteralCandidate(evidence)
        guard frozen.checkpoint == checkpoint,
              receipt.workspaceId == checkpoint.workspaceId,
              receipt.nodeId == checkpoint.nodeId,
              receipt.intent == checkpoint.intent,
              receipt.baseRoute == checkpoint.route,
              receipt.resultRoute == frozen.literal.route,
              receipt.updateSHA256 == checkpoint.updateSHA256,
              receipt.baseVersionVectorSHA256 == checkpoint.baseVersionVectorSHA256,
              receipt.resultSnapshotSHA256 == frozen.literal.localSnapshotSHA256,
              receipt.resultVersionVectorSHA256 == frozen.literal.versionVectorSHA256 else {
            throw LoroSemanticCheckpointStateMachineError.invalidReceipt
        }
        let observation = try LoroReconstructedAuthorityObservation.reconstructed(
            from: authority, expectedWorkspace: checkpoint.workspaceId, expectedNode: checkpoint.nodeId
        )
        let validatedProof = try await documents.validateReconstructedAuthority(observation)
#if DEBUG
        let proof = testOnlyProofTransform?(validatedProof) ?? validatedProof
#else
        let proof = validatedProof
#endif
        // Raw sync reconstruction has no literal authority. It can prove only that the trusted
        // receipt's exact result route, causal vector, and strict native-plain semantics agree
        // with the already-frozen candidate. A causally newer or raw-byte-different reload stays
        // retained for later resolution rather than being persisted as a guessed authority.
        guard matchesAcceptedSemanticResult(
            proofRoute: proof.route, proofSemantic: proof.semantic,
            proofVersionVectorSHA256: proof.versionVectorSHA256,
            expectedRoute: receipt.resultRoute, expectedSemantic: frozen.semantic,
            expectedVersionVectorSHA256: frozen.literal.versionVectorSHA256
        ) else {
            throw LoroSemanticCheckpointStateMachineError.reconstructedAuthorityMismatch
        }
        try await local.acceptFrozenLiteralCandidate(actorIssued: frozen, dispatched: checkpoint)
        do {
            try await documents.publishLiteral(frozen)
            return .committed
        } catch {
            await documents.invalidateCacheSlots(nodeId: checkpoint.nodeId)
            return .committedCacheInvalidated
        }
    }

    /// The final acceptance predicate deliberately receives content semantics and digests only;
    /// it cannot become a raw snapshot/update handoff path.
    func matchesAcceptedSemanticResult(
        proofRoute: LoroPageRouteWitness,
        proofSemantic: LoroCanonicalSemanticValueV1,
        proofVersionVectorSHA256: String,
        expectedRoute: LoroPageRouteWitness,
        expectedSemantic: LoroCanonicalSemanticValueV1,
        expectedVersionVectorSHA256: String
    ) -> Bool {
        proofRoute == expectedRoute && proofSemantic == expectedSemantic && proofVersionVectorSHA256 == expectedVersionVectorSHA256
    }
}
