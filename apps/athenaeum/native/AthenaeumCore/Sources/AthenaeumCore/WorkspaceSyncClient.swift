import Foundation
import AthenaeumDomain
import AthenaeumRPC

/// The only native surfaces permitted to own a checklist toggle. Keeping this as a closed,
/// value-only type prevents a caller from forwarding an arbitrary attribution string across the
/// UI/page-operations boundary.
public enum NativeRichTaskItemToggleSurface: String, Equatable, Hashable, Sendable {
    case macos
    case ios

    public static var current: Self {
        #if os(macOS)
        return .macos
        #else
        return .ios
        #endif
    }

    public var mutationAttribution: LoroMutationAttributionV1 {
        // Keep the serialized value platform-specific while using the closed wire vocabulary.
        .humanUi(surface: self == .ios ? "ios-rich-text-editor" : rawValue)
    }
}

// `WorkspaceSyncClient` is the native Loro and structured-record sync client. Legacy Automerge
// transport remains a backend/web compatibility lane and is deliberately not linkable from this
// shipped target: combining its static Rust FFI with `loro-swift` makes the macOS app un-linkable.
//
// Every mutation method here follows the plan's "Native local SQLite stays the immediate write
// authority (durable-before-sync)": the local `LocalWorkspaceStore` write always happens, and always
// happens before the corresponding RPC call — a network/RPC failure leaves the local row marked
// `dirty` for a later retry rather than losing the local write or blocking on connectivity. This
// stage does not implement an actual background retry queue (out of scope — see this file's
// `TODO`-free but explicit doc comments below on exactly what's real vs. deferred); the
// `dirty`-flag bookkeeping itself, and every method's local-write-before-network-call ordering,
// is real and exercised by this package's tests, not stubbed.

public enum WorkspaceSyncClientError: Error, Sendable, Equatable {
    case pageNotFoundLocally(EntityId)
    case missingLoroCreationIntent(EntityId)
    case invalidLoroDescriptor(EntityId)
    case invalidLoroSyncResponse
    case invalidNodeCreationInput
}

/// Deliberately opaque native Loro result.  Rich-text traversal and mutation remain outside this
/// transport/durability stage.
public struct LoroPageReadOnlyProjection: Sendable, Equatable {
    public let format: PageDocumentFormat
    public let schemaVersion: Int
    public let isDirty: Bool
}

public struct SyncFeedCatchUpResult: Sendable, Equatable {
    public let epoch: String
    public let entriesSeen: Int
    public let byEntityKind: [String: Int]
}

public actor WorkspaceSyncClient {
    private let localStore: LocalWorkspaceStore
    private let rpcClient: WorkspaceRPCClient
    private let loroTransport: any LoroWorkspaceTransport
    private let loroStore: LoroPageDocumentStore
    private let loroGate: LoroNodeOperationGate
    private let semanticAuthentication: @Sendable () async -> Bool
    private let semanticTransport: (any LoroSemanticCheckpointTransport)?
    private var loroSessions: [String: LoroSyncSession] = [:]
    private var loroInFlight: [String: LoroInFlightFrame] = [:]
    public let workspaceId: EntityId

    public init(localStore: LocalWorkspaceStore, rpcClient: WorkspaceRPCClient, workspaceId: EntityId) {
        self.localStore = localStore
        self.rpcClient = rpcClient
        self.loroTransport = rpcClient
        self.loroStore = LoroPageDocumentStore()
        self.loroGate = LoroNodeOperationGate()
        self.semanticAuthentication = { [rpcClient] in (try? await rpcClient.whoami().authenticated) ?? false }
        self.semanticTransport = nil
        self.workspaceId = workspaceId
    }

    /// Core-test seam for the Loro protocol only. It deliberately accepts no legacy document
    /// store, so test binaries prove the same FFI closure as the shipped app.
    init(localStore: LocalWorkspaceStore, loroTransport: any LoroWorkspaceTransport, workspaceId: EntityId, semanticAuthentication: @escaping @Sendable () async -> Bool = { false }, semanticTransport: (any LoroSemanticCheckpointTransport)? = nil, loroStore: LoroPageDocumentStore? = nil) {
        self.localStore = localStore
        self.rpcClient = WorkspaceRPCClient(baseURL: URL(string: "http://127.0.0.1")!, workspaceId: workspaceId.rawValue)
        self.loroTransport = loroTransport
        self.loroStore = loroStore ?? LoroPageDocumentStore()
        self.loroGate = LoroNodeOperationGate()
        self.semanticAuthentication = semanticAuthentication
        self.semanticTransport = semanticTransport
        self.workspaceId = workspaceId
    }

    /// The semantic runtime uses these same instances, so a read sync cannot overlap a semantic
    /// dispatch or recovery for the same `(workspace,node)`.
    func makeLoroSemanticRuntime(intent: LoroMutationIntentV1?) async throws -> LoroSemanticRuntime {
        guard let intent, (try await rpcClient.whoami()).authenticated else { throw LoroSemanticRuntimeError.custodyDenied }
        // This short-lived proof is deliberately generated only after the authenticated RPC
        // session answers `whoami`; individual commits still receive server authorization.
        let custody = LoroSemanticCustody(workspaceId: workspaceId, intent: intent, expiresAt: Date().addingTimeInterval(60))
        return LoroSemanticRuntime(local: localStore, documents: loroStore, gate: loroGate, rpc: rpcClient, workspaceId: workspaceId, custody: custody)
    }

    /// Startup recovery only dispatches a genuinely in-flight frozen checkpoint. Retained and
    /// terminal rows are returned without authenticating or changing durable state.
    public func recoverInFlightLoroSemanticCheckpoint(nodeId: EntityId) async throws -> LoroSemanticCheckpointResolution {
        let local = localStore; let documents = loroStore; let gate = loroGate; let rpc = rpcClient; let workspace = workspaceId; let transport = semanticTransport; let auth = semanticAuthentication
        return try await withLoroLease(nodeId: nodeId) { [local, documents, gate, rpc, workspace, transport, auth, nodeId] in
            guard let checkpoint = try await local.loroCheckpoint(workspaceId: workspace, nodeId: nodeId) else { return .none }
            guard checkpoint.state == .inFlight else { return .init(checkpoint) }
            guard await auth() else { return .deniedAuthorizationOrSession }
            let custody = LoroSemanticCustody(workspaceId: workspace, intent: checkpoint.intent, expiresAt: Date().addingTimeInterval(60))
            let runtime = transport.map { LoroSemanticRuntime(local: local, documents: documents, gate: gate, workspaceId: workspace, custody: custody, transport: $0) }
                ?? LoroSemanticRuntime(local: local, documents: documents, gate: gate, rpc: rpc, workspaceId: workspace, custody: custody)
            guard let outcome = try await runtime.recoverInFlightAssumingLease(nodeId: nodeId) else { return .inFlight }
            return .init(outcome)
        }
    }

    /// Explicit retry replays only the durable retained-retry checkpoint; it never creates a
    /// replacement intent or a replacement candidate.
    public func retryRetainedLoroSemanticCheckpoint(nodeId: EntityId) async throws -> LoroSemanticCheckpointResolution {
        let local = localStore; let documents = loroStore; let gate = loroGate; let rpc = rpcClient; let workspace = workspaceId; let transport = semanticTransport; let auth = semanticAuthentication
        return try await withLoroLease(nodeId: nodeId) { [local, documents, gate, rpc, workspace, transport, auth, nodeId] in
            guard let checkpoint = try await local.loroCheckpoint(workspaceId: workspace, nodeId: nodeId) else { return .none }
            guard checkpoint.state == .retainedRetry else { return .init(checkpoint) }
            guard await auth() else { return .deniedAuthorizationOrSession }
            let custody = LoroSemanticCustody(workspaceId: workspace, intent: checkpoint.intent, expiresAt: Date().addingTimeInterval(60))
            let runtime = transport.map { LoroSemanticRuntime(local: local, documents: documents, gate: gate, workspaceId: workspace, custody: custody, transport: $0) }
                ?? LoroSemanticRuntime(local: local, documents: documents, gate: gate, rpc: rpc, workspaceId: workspace, custody: custody)
            guard let outcome = try await runtime.retryRetainedAssumingLease(nodeId: nodeId) else { return .retainedRetry }
            return .init(outcome)
        }
    }

    /// Authoring admission is observational: it neither creates a candidate nor changes the
    /// published replica or local authority. It shares the read-sync node gate.
    public func loroNativePlainEditorEligibility(nodeId: EntityId) async throws -> LoroNativePlainEditorEligibility {
        try await withLoroLease(nodeId: nodeId) { [self, nodeId] in
            try await nativePlainEditorEligibilityAssumingLease(nodeId: nodeId)
        }
    }

    /// Explicitly re-establishes literal authoring authority from the sealed, durable accepted
    /// row. This is intentionally separate from eligibility and submission: after a
    /// `submittedNeedsReload` result, a subsequent edit must remain closed until this recovery
    /// operation (or a fresh explicit sync/recovery flow) completes.
    public func recoverAcceptedLoroLiteralForEditing(nodeId: EntityId) async throws -> LoroNativePlainEditorEligibility {
        try await withLoroLease(nodeId: nodeId) { [self, nodeId] in
            guard await semanticAuthentication() else { return .unauthenticated }
            if let checkpoint = try await localStore.loroCheckpoint(workspaceId: workspaceId, nodeId: nodeId) {
                return .checkpointResolutionRequired(.init(checkpoint))
            }
            guard let accepted = try await localStore.acceptedLoroPageEvidence(workspaceId: workspaceId, nodeId: nodeId) else {
                return .ineligible
            }
            try await loroStore.installAcceptedLiteral(accepted)
            return try await nativePlainEditorEligibilityAfterAuthenticationAssumingLease(nodeId: nodeId)
        }
    }

    /// Value-only semantic submission for native plain-text editors. Core generates the request
    /// identity and attribution after validating the immutable editor witness under one node lease.
    public func submitNativePlainText(nodeId: EntityId, base: LoroNativePlainEditorState, proposedText: String) async throws -> LoroNativePlainTextSubmissionDisposition {
        try await withLoroLease(nodeId: nodeId) { [self, nodeId, base, proposedText] in
            let eligibility = try await nativePlainEditorEligibilityAssumingLease(nodeId: nodeId)
            switch eligibility {
            case .unauthenticated: return .unauthenticated
            case .checkpointResolutionRequired(let resolution): return .checkpointResolutionRequired(resolution)
            case .ineligible: return .ineligible
            case .editable(let current):
                guard base == current else { return .staleEditorState }
                guard !proposedText.contains("\n") && !proposedText.contains("\r") else { return .invalidProposedText }
                guard proposedText != base.text else { return .noChange }
                let replacement = Self.nativePlainReplacement(from: base.text, to: proposedText)
                let intent = try LoroMutationIntentV1(requestId: UUID().uuidString.lowercased(), commitMessage: "Edit daily note", attribution: .humanUi(surface: "macos"))
                let custody = LoroSemanticCustody(workspaceId: workspaceId, intent: intent, expiresAt: Date().addingTimeInterval(60))
                let runtime = semanticTransport.map { LoroSemanticRuntime(local: localStore, documents: loroStore, gate: loroGate, workspaceId: workspaceId, custody: custody, transport: $0) }
                    ?? LoroSemanticRuntime(local: localStore, documents: loroStore, gate: loroGate, rpc: rpcClient, workspaceId: workspaceId, custody: custody)
                switch try await runtime.replacePlainTextAssumingLease(nodeId: nodeId, scalarRange: replacement.baseRange, replacement: replacement.proposedMiddle) {
                case .committed: return .submitted
                case .committedCacheInvalidated: return .submittedNeedsReload
                case .deniedAuthorizationOrSession:
                    // If candidate freezing won the race with custody expiry, durable evidence
                    // is the user-facing truth and must not be hidden behind a bare auth result.
                    if let checkpoint = try await localStore.loroCheckpoint(workspaceId: workspaceId, nodeId: nodeId) {
                        return .checkpointResolutionRequired(.init(checkpoint))
                    }
                    return .unauthenticated
                case .retainedRetry: return .checkpointResolutionRequired(.retainedRetry)
                case .retainedConflict: return .checkpointResolutionRequired(.retainedConflict)
                case .retainedRequestIdentity: return .checkpointResolutionRequired(.retainedRequestIdentity)
                }
            }
        }
    }

    /// Observational rich admission. This cannot install literal authority or mint a candidate.
    public func loroNativeRichEditorEligibility(nodeId: EntityId) async throws -> LoroNativeRichEditorEligibility {
        try await withLoroLease(nodeId: nodeId) { [self, nodeId] in
            try await nativeRichEditorEligibilityAssumingLease(nodeId: nodeId)
        }
    }

    /// Explicit rich-authority recovery. This intentionally does not broaden legacy plain
    /// recovery, whose strict plain subset and error taxonomy remain stable.
    public func recoverAcceptedLoroRichLiteralForEditing(nodeId: EntityId) async throws -> LoroNativeRichEditorEligibility {
        try await withLoroLease(nodeId: nodeId) { [self, nodeId] in
            guard await semanticAuthentication() else { return .unauthenticated }
            if let checkpoint = try await localStore.loroCheckpoint(workspaceId: workspaceId, nodeId: nodeId) {
                return .checkpointResolutionRequired(.init(checkpoint))
            }
            guard let accepted = try await localStore.acceptedLoroPageEvidence(workspaceId: workspaceId, nodeId: nodeId) else { return .ineligible }
            try await loroStore.installAcceptedRichLiteral(accepted)
            return try await nativeRichEditorEligibilityAfterAuthenticationAssumingLease(nodeId: nodeId)
        }
    }

    /// Value-only semantic submission for native rich editors. Core owns request identity,
    /// attribution, literal authority, candidate bytes, and transport custody.
    public func submitNativeRichDocumentV1(nodeId: EntityId, base: LoroNativeRichEditorState, proposed: LoroNativeRichDocumentV1, commitMessage: String) async throws -> LoroNativeRichDocumentSubmissionDisposition {
        try await withLoroLease(nodeId: nodeId) { [self, nodeId, base, proposed, commitMessage] in
            let eligibility = try await nativeRichEditorEligibilityAssumingLease(nodeId: nodeId)
            switch eligibility {
            case .unauthenticated: return .unauthenticated
            case .checkpointResolutionRequired(let resolution): return .checkpointResolutionRequired(resolution)
            case .ineligible: return .ineligible
            case .editable(let current):
                guard base == current else { return .staleEditorState }
                let canonical: LoroCanonicalSemanticValueV1
                do { canonical = try proposed.semantic.validated() }
                catch { return .invalidProposedDocument }
                guard canonical != base.document.semantic else { return .noChange }
                let message: LoroCommitMessageV1
                do { message = try LoroCommitMessageV1(commitMessage) }
                catch { return .invalidCommitMessage }
                let intent = try LoroMutationIntentV1(requestId: UUID().uuidString.lowercased(), commitMessage: message.value, attribution: .humanUi(surface: "macos"))
                let custody = LoroSemanticCustody(workspaceId: workspaceId, intent: intent, expiresAt: Date().addingTimeInterval(60))
                let runtime = semanticTransport.map { LoroSemanticRuntime(local: localStore, documents: loroStore, gate: loroGate, workspaceId: workspaceId, custody: custody, transport: $0) }
                    ?? LoroSemanticRuntime(local: localStore, documents: loroStore, gate: loroGate, rpc: rpcClient, workspaceId: workspaceId, custody: custody)
                switch try await runtime.replaceRichDocumentAssumingLease(nodeId: nodeId, proposed: .init(semantic: canonical)) {
                case .committed: return .submitted
                case .committedCacheInvalidated: return .submittedNeedsReload
                case .deniedAuthorizationOrSession:
                    if let checkpoint = try await localStore.loroCheckpoint(workspaceId: workspaceId, nodeId: nodeId) {
                        return .checkpointResolutionRequired(.init(checkpoint))
                    }
                    return .unauthenticated
                case .retainedRetry: return .checkpointResolutionRequired(.retainedRetry)
                case .retainedConflict: return .checkpointResolutionRequired(.retainedConflict)
                case .retainedRequestIdentity: return .checkpointResolutionRequired(.retainedRequestIdentity)
                }
            }
        }
    }

    /// Dedicated, idempotent checklist toggle submission. This never accepts a replacement
    /// semantic document; the actor/store resolves the command against its frozen base and
    /// changes only the witnessed `checked` map entry.
    public func submitNativeRichTaskItemToggle(
        nodeId: EntityId,
        base: LoroNativeRichEditorState,
        command: LoroNativeRichTaskItemToggleCommand,
        commitMessage: String,
        surface: NativeRichTaskItemToggleSurface
    ) async throws -> LoroNativeRichDocumentSubmissionDisposition {
        try await withLoroLease(nodeId: nodeId) { [self, nodeId, base, command, commitMessage] in
            let eligibility = try await nativeRichEditorEligibilityAssumingLease(nodeId: nodeId)
            switch eligibility {
            case .unauthenticated: return .unauthenticated
            case .checkpointResolutionRequired(let resolution): return .checkpointResolutionRequired(resolution)
            case .ineligible: return .ineligible
            case .editable(let current):
                guard base == current else { return .staleEditorState }
                let message: LoroCommitMessageV1
                do { message = try LoroCommitMessageV1(commitMessage) }
                catch { return .invalidCommitMessage }
                let intent = try LoroMutationIntentV1(
                    requestId: command.commandID.uuidString.lowercased(),
                    commitMessage: message.value,
                    attribution: surface.mutationAttribution
                )
                let custody = LoroSemanticCustody(workspaceId: workspaceId, intent: intent, expiresAt: Date().addingTimeInterval(60))
                let runtime = semanticTransport.map { LoroSemanticRuntime(local: localStore, documents: loroStore, gate: loroGate, workspaceId: workspaceId, custody: custody, transport: $0) }
                    ?? LoroSemanticRuntime(local: localStore, documents: loroStore, gate: loroGate, rpc: rpcClient, workspaceId: workspaceId, custody: custody)
                switch try await runtime.toggleRichTaskItemAssumingLease(nodeId: nodeId, command: command) {
                case .committed: return .submitted
                case .committedCacheInvalidated: return .submittedNeedsReload
                case .deniedAuthorizationOrSession:
                    if let checkpoint = try await localStore.loroCheckpoint(workspaceId: workspaceId, nodeId: nodeId) {
                        return .checkpointResolutionRequired(.init(checkpoint))
                    }
                    return .unauthenticated
                case .retainedRetry: return .checkpointResolutionRequired(.retainedRetry)
                case .retainedConflict: return .checkpointResolutionRequired(.retainedConflict)
                case .retainedRequestIdentity: return .checkpointResolutionRequired(.retainedRequestIdentity)
                }
            }
        }
    }

    public func submitNativeRichTaskListInsertion(
        nodeId: EntityId,
        base: LoroNativeRichEditorState,
        command: LoroNativeRichTaskListInsertionCommand,
        commitMessage: String,
        surface: NativeRichTaskItemToggleSurface
    ) async throws -> LoroNativeRichDocumentSubmissionDisposition {
        try await withLoroLease(nodeId: nodeId) { [self, nodeId, base, command, commitMessage] in
            let eligibility = try await nativeRichEditorEligibilityAssumingLease(nodeId: nodeId)
            switch eligibility {
            case .unauthenticated: return .unauthenticated
            case .checkpointResolutionRequired(let resolution): return .checkpointResolutionRequired(resolution)
            case .ineligible: return .ineligible
            case .editable(let current):
                guard base == current else { return .staleEditorState }
                let message: LoroCommitMessageV1
                do { message = try LoroCommitMessageV1(commitMessage) }
                catch { return .invalidCommitMessage }
                let intent = try LoroMutationIntentV1(
                    requestId: command.commandID.uuidString.lowercased(),
                    commitMessage: message.value,
                    attribution: surface.mutationAttribution
                )
                let custody = LoroSemanticCustody(workspaceId: workspaceId, intent: intent, expiresAt: Date().addingTimeInterval(60))
                let runtime = semanticTransport.map { LoroSemanticRuntime(local: localStore, documents: loroStore, gate: loroGate, workspaceId: workspaceId, custody: custody, transport: $0) }
                    ?? LoroSemanticRuntime(local: localStore, documents: loroStore, gate: loroGate, rpc: rpcClient, workspaceId: workspaceId, custody: custody)
                switch try await runtime.insertRichTaskListAssumingLease(nodeId: nodeId, command: command) {
                case .committed: return .submitted
                case .committedCacheInvalidated: return .submittedNeedsReload
                case .deniedAuthorizationOrSession:
                    if let checkpoint = try await localStore.loroCheckpoint(workspaceId: workspaceId, nodeId: nodeId) {
                        return .checkpointResolutionRequired(.init(checkpoint))
                    }
                    return .unauthenticated
                case .retainedRetry: return .checkpointResolutionRequired(.retainedRetry)
                case .retainedConflict: return .checkpointResolutionRequired(.retainedConflict)
                case .retainedRequestIdentity: return .checkpointResolutionRequired(.retainedRequestIdentity)
                }
            }
        }
    }

    private func nativePlainEditorEligibilityAssumingLease(nodeId: EntityId) async throws -> LoroNativePlainEditorEligibility {
        guard await semanticAuthentication() else { return .unauthenticated }
        return try await nativePlainEditorEligibilityAfterAuthenticationAssumingLease(nodeId: nodeId)
    }

    private func nativeRichEditorEligibilityAssumingLease(nodeId: EntityId) async throws -> LoroNativeRichEditorEligibility {
        guard await semanticAuthentication() else { return .unauthenticated }
        return try await nativeRichEditorEligibilityAfterAuthenticationAssumingLease(nodeId: nodeId)
    }

    private func nativeRichEditorEligibilityAfterAuthenticationAssumingLease(nodeId: EntityId) async throws -> LoroNativeRichEditorEligibility {
        if let checkpoint = try await localStore.loroCheckpoint(workspaceId: workspaceId, nodeId: nodeId) {
            return .checkpointResolutionRequired(.init(checkpoint))
        }
        guard let node = try await localStore.node(id: nodeId), node.workspaceId == workspaceId,
              let local = try await localStore.loroPage(nodeId: nodeId), local.nodeId == nodeId else { return .ineligible }
        let inspection = try await loroStore.inspectPersistedReplicaV1(snapshot: local.snapshotBytes)
        guard inspection.snapshotSHA256 == local.localSnapshotSHA256, inspection.pageSchemaVersion == local.pageSchemaVersion else {
            throw LocalWorkspaceStoreError.invalidLoroPageState
        }
        guard !local.dirty, local.pageSchemaVersion == 1, local.observedDescriptorStorageVersion > 0,
              local.localSnapshotSHA256 == local.observedDescriptorSnapshotSHA256 else { return .ineligible }
        let replica = LoroPageReplicaWitness(snapshotSHA256: inspection.snapshotSHA256, versionVectorSHA256: inspection.versionVectorSHA256)
        let route = LoroPageRouteWitness(nodeId: nodeId, format: .loroV1, storageVersion: local.observedDescriptorStorageVersion, schemaVersion: local.pageSchemaVersion, snapshotSHA256: local.observedDescriptorSnapshotSHA256)
        do { return .editable(.init(try await loroStore.nativeRichLoroEditableV1(nodeId: nodeId, route: route, persistedReplica: replica, publishedReplica: replica, isDirty: local.dirty))) }
        catch LoroPageDocumentStoreError.nativePlainTextIneligible { return .ineligible }
        catch LoroPageDocumentStoreError.nativeRichTextIneligible { return .ineligible }
        catch LoroPageDocumentStoreError.nativePlainTextWitnessMismatch { return .ineligible }
        catch LoroPageDocumentStoreError.inputTooLarge { return .ineligible }
        catch LoroPageProjectionError.pageNotPublished { return .ineligible }
    }

    /// This admission path deliberately does not populate the literal cache. It can verify
    /// read-only durable data and inspect an already-installed literal, but a caller must cross
    /// `recoverAcceptedLoroLiteralForEditing` to re-authorize bytes for a new candidate.
    private func nativePlainEditorEligibilityAfterAuthenticationAssumingLease(nodeId: EntityId) async throws -> LoroNativePlainEditorEligibility {
        // Once admission is authenticated, retained evidence wins over decoding a potentially
        // malformed current replica. Before authentication it remains completely opaque.
        if let checkpoint = try await localStore.loroCheckpoint(workspaceId: workspaceId, nodeId: nodeId) {
            return .checkpointResolutionRequired(.init(checkpoint))
        }
        guard let node = try await localStore.node(id: nodeId), node.workspaceId == workspaceId else { return .ineligible }
        guard let local = try await localStore.loroPage(nodeId: nodeId), local.nodeId == nodeId else { return .ineligible }
        let inspection = try await loroStore.inspectPersistedReplicaV1(snapshot: local.snapshotBytes)
        guard inspection.snapshotSHA256 == local.localSnapshotSHA256, inspection.pageSchemaVersion == local.pageSchemaVersion else {
            throw LocalWorkspaceStoreError.invalidLoroPageState
        }
        guard !local.dirty, local.pageSchemaVersion == 1, local.observedDescriptorStorageVersion > 0,
              local.localSnapshotSHA256 == local.observedDescriptorSnapshotSHA256 else { return .ineligible }
        let replica = LoroPageReplicaWitness(snapshotSHA256: inspection.snapshotSHA256, versionVectorSHA256: inspection.versionVectorSHA256)
        let route = LoroPageRouteWitness(nodeId: nodeId, format: .loroV1, storageVersion: local.observedDescriptorStorageVersion, schemaVersion: local.pageSchemaVersion, snapshotSHA256: local.observedDescriptorSnapshotSHA256)
        do { return .editable(.init(try await loroStore.nativePlainLoroEditableV1(nodeId: nodeId, route: route, persistedReplica: replica, publishedReplica: replica, isDirty: local.dirty))) }
        catch LoroPageDocumentStoreError.nativePlainTextIneligible { return .ineligible }
        catch LoroPageDocumentStoreError.nativePlainTextWitnessMismatch { return .ineligible }
        catch LoroPageProjectionError.pageNotPublished { return .ineligible }
    }

    struct NativePlainReplacement: Sendable {
        let baseRange: Range<Int>
        let proposedMiddle: String
    }

    nonisolated static func nativePlainReplacement(from base: String, to proposed: String) -> NativePlainReplacement {
        let old = Array(base.unicodeScalars); let new = Array(proposed.unicodeScalars)
        var prefix = 0
        while prefix < old.count && prefix < new.count && old[prefix] == new[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < old.count - prefix && suffix < new.count - prefix && old[old.count - suffix - 1] == new[new.count - suffix - 1] { suffix += 1 }
        return .init(baseRange: prefix..<(old.count - suffix), proposedMiddle: String(String.UnicodeScalarView(new[prefix..<(new.count - suffix)])))
    }


    // MARK: - Nodes

    /// Durable-before-sync: writes the node to `LocalWorkspaceStore` first (dirty), then pushes it via
    /// `createNode`. `id` mirrors `CreateNodeInput.id`'s caller-supplied-id convention
    /// (`rpc.ts`) — passing one makes this call idempotent/resolve-or-create-friendly, matching
    /// `web/src/DailyNote.tsx`'s `resolveDailyNote` pattern; omitting it gets a fresh
    /// server-minted id.
    @discardableResult
    public func createNode(title: String, id: EntityId? = nil) async throws -> Node {
        let localId = try id ?? EntityId(validating: UUID().uuidString.lowercased())
        let createdAt = try IsoDateTimeString(validating: ISO8601DateFormatter().string(from: Date()))
        let localNode = Node(id: localId, workspaceId: workspaceId, title: title, createdAt: createdAt)
        try await localStore.upsertNode(localNode, dirty: true)

        let remote = try await rpcClient.createNode(title: title, id: localId.rawValue)
        let confirmed = Node(
            id: try EntityId(validating: remote.id),
            workspaceId: try EntityId(validating: remote.workspaceId),
            title: remote.title,
            createdAt: try IsoDateTimeString(validating: remote.createdAt)
        )
        try await localStore.upsertNode(confirmed, dirty: false)
        return confirmed
    }

    /// Provenance-bearing node creation. The operation object is supplied by the caller and is
    /// reused verbatim when a multi-step flow retries after an uncertain response; the legacy
    /// `createNode` above remains available for compatibility fixtures and anonymous transports.
    @discardableResult
    public func createNodeWithIntent(
        title: String,
        id: EntityId? = nil,
        requestId: String,
        commitMessage: String,
        attribution: MutationAttribution
    ) async throws -> Node {
        let canonicalTitle = title.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !canonicalTitle.isEmpty else { throw WorkspaceSyncClientError.invalidNodeCreationInput }
        let localId = try id ?? EntityId(validating: UUID().uuidString.lowercased())
        let createdAt = try IsoDateTimeString(validating: ISO8601DateFormatter().string(from: Date()))
        let localNode = Node(id: localId, workspaceId: workspaceId, title: canonicalTitle, createdAt: createdAt)
        try await localStore.upsertNode(localNode, dirty: true)

        let remote = try await rpcClient.createNodeWithIntent(
            title: canonicalTitle,
            id: localId.rawValue,
            requestId: requestId,
            commitMessage: commitMessage,
            attribution: attribution
        )
        let confirmed = Node(
            id: try EntityId(validating: remote.id),
            workspaceId: try EntityId(validating: remote.workspaceId),
            title: remote.title,
            createdAt: try IsoDateTimeString(validating: remote.createdAt)
        )
        try await localStore.upsertNode(confirmed, dirty: false)
        return confirmed
    }

    /// Resolve-or-create: mirrors `DailyNote.tsx`'s `resolveDailyNote`'s node half — `getNode`,
    /// falling back to `createNode` only on `NodeNotFound`.
    public func resolveOrCreateNode(id: EntityId, title: String, creationIntent: CreationIntent? = nil) async throws -> Node {
        do {
            let remote = try await rpcClient.getNode(nodeId: id.rawValue)
            let node = Node(
                id: try EntityId(validating: remote.id),
                workspaceId: try EntityId(validating: remote.workspaceId),
                title: remote.title,
                createdAt: try IsoDateTimeString(validating: remote.createdAt)
            )
            try await localStore.upsertNode(node, dirty: false)
            return node
        } catch AthenaeumDomainError.nodeNotFound {
            if let creationIntent {
                do {
                    return try await createNodeWithIntent(
                        title: title,
                        id: id,
                        requestId: creationIntent.requestId,
                        commitMessage: creationIntent.commitMessage,
                        attribution: creationIntent.attribution
                    )
                } catch AthenaeumDomainError.nodeAlreadyExists {
                    // Another device may have won the explicit-id race after our getNode. Read
                    // that winner and make it the clean local authority instead of leaving the
                    // optimistic dirty row behind. Only accept it when it is the same canonical
                    // daily-note title; a different occupant remains a real collision.
                    let remote = try await rpcClient.getNode(nodeId: id.rawValue)
                    let existing = Node(
                        id: try EntityId(validating: remote.id),
                        workspaceId: try EntityId(validating: remote.workspaceId),
                        title: remote.title,
                        createdAt: try IsoDateTimeString(validating: remote.createdAt)
                    )
                    try await localStore.upsertNode(existing, dirty: false)
                    let canonicalTitle = title.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
                    guard existing.workspaceId == workspaceId, existing.title == canonicalTitle else {
                        throw AthenaeumDomainError.nodeAlreadyExists(nodeId: id.rawValue)
                    }
                    return existing
                }
            }
            return try await createNode(title: title, id: id)
        }
    }

    // MARK: - Native Loro pages (separate from Automerge)

    /// Creation intent is mandatory only for the PageNotFound branch. Callers must retain the
    /// same value across uncertain retries; this client never fabricates provenance.
    public func resolveOrCreateLoroPageReadOnly(nodeId: EntityId, creationIntent: CreationIntent?) async throws -> LoroPageReadOnlyProjection {
        let transport = loroTransport
        return try await withLoroLease(nodeId: nodeId) { [self, transport, nodeId] in
            let descriptor: PageDocumentDescriptor
            do {
                descriptor = try await transport.getPageDocumentDescriptor(nodeId: nodeId.rawValue)
            } catch AthenaeumDomainError.pageNotFound {
                guard let creationIntent else { throw WorkspaceSyncClientError.missingLoroCreationIntent(nodeId) }
                descriptor = try await transport.createLoroPage(nodeId: nodeId.rawValue, creationIntent: creationIntent)
            }
            let schema = try self.validateLoroDescriptor(descriptor, nodeId: nodeId)
            return try await self.synchronizeLoro(nodeId: nodeId, descriptor: descriptor, schemaVersion: schema)
        }
    }

    public func syncLoroPageReadOnly(nodeId: EntityId) async throws -> LoroPageReadOnlyProjection {
        let transport = loroTransport
        return try await withLoroLease(nodeId: nodeId) { [self, transport, nodeId] in
            let descriptor = try await transport.getPageDocumentDescriptor(nodeId: nodeId.rawValue)
            let schema = try self.validateLoroDescriptor(descriptor, nodeId: nodeId)
            return try await self.synchronizeLoro(nodeId: nodeId, descriptor: descriptor, schemaVersion: schema)
        }
    }

    /// Read-only recursive projection of the actor-published Loro replica. A fresh descriptor is
    /// captured into the typed route witness; AppUI must compare it with the descriptor that
    /// selected the Loro route before replacing its current presentation. The synchronization,
    /// descriptor recheck, and actor-confined projection share one node lease so another local
    /// sync cannot replace the published replica between those phases.
    public func syncLoroPageProjectionReadOnly(nodeId: EntityId) async throws -> LoroPageProjection {
        let transport = loroTransport
        return try await withLoroLease(nodeId: nodeId) { [self, transport, nodeId] in
            let selectedDescriptor = try await transport.getPageDocumentDescriptor(nodeId: nodeId.rawValue)
            let selectedSchema = try self.validateLoroDescriptor(selectedDescriptor, nodeId: nodeId)
            let selectedDescriptorWitness = self.descriptorWitness(selectedDescriptor)
            let selectedRoute = LoroPageRouteWitness(
                nodeId: nodeId,
                format: .loroV1,
                storageVersion: selectedDescriptorWitness.0,
                schemaVersion: selectedSchema,
                snapshotSHA256: selectedDescriptorWitness.1
            )

            let result = try await self.synchronizeLoro(
                nodeId: nodeId,
                descriptor: selectedDescriptor,
                schemaVersion: selectedSchema
            )

            // A changed descriptor means the replica was synchronized against a different route
            // witness. Do not relabel that replica as the new route or expose it to AppUI.
            let confirmedDescriptor = try await transport.getPageDocumentDescriptor(nodeId: nodeId.rawValue)
            let confirmedSchema = try self.validateLoroDescriptor(confirmedDescriptor, nodeId: nodeId)
            let confirmedDescriptorWitness = self.descriptorWitness(confirmedDescriptor)
            let confirmedRoute = LoroPageRouteWitness(
                nodeId: nodeId,
                format: .loroV1,
                storageVersion: confirmedDescriptorWitness.0,
                schemaVersion: confirmedSchema,
                snapshotSHA256: confirmedDescriptorWitness.1
            )
            guard selectedRoute == confirmedRoute, result.schemaVersion == selectedSchema else {
                throw WorkspaceSyncClientError.invalidLoroDescriptor(nodeId)
            }
            return try await self.loroStore.projectPublished(
                nodeId: nodeId,
                route: selectedRoute,
                isDirty: result.isDirty
            )
        }
    }

    private func withLoroLease<T: Sendable>(nodeId: EntityId, operation: @Sendable () async throws -> T) async throws -> T {
        let key = "\(workspaceId.rawValue):\(nodeId.rawValue)"
        return try await loroGate.withLease(key, operation: operation)
    }

    nonisolated private func validateLoroDescriptor(_ descriptor: PageDocumentDescriptor, nodeId: EntityId) throws -> Int {
        guard descriptor.nodeId == nodeId, descriptor.activeFormat == .loroV1 else {
            throw WorkspaceSyncClientError.invalidLoroDescriptor(nodeId)
        }
        switch descriptor {
        case .migratedLoro(_, _, _, let loro), .nativeLoro(_, _, let loro):
            guard loro.schemaVersion == 1 else { throw WorkspaceSyncClientError.invalidLoroDescriptor(nodeId) }
            return loro.schemaVersion
        case .legacy:
            throw WorkspaceSyncClientError.invalidLoroDescriptor(nodeId)
        }
    }

    nonisolated private func descriptorWitness(_ descriptor: PageDocumentDescriptor) -> (Int, String) {
        switch descriptor {
        case .migratedLoro(_, let version, _, let loro), .nativeLoro(_, let version, let loro):
            return (version, loro.snapshotSha256)
        case .legacy:
            preconditionFailure("validated before witness extraction")
        }
    }

    private func synchronizeLoro(nodeId: EntityId, descriptor: PageDocumentDescriptor, schemaVersion: Int) async throws -> LoroPageReadOnlyProjection {
        let witness = descriptorWitness(descriptor)
        if let frame = loroInFlight[nodeId.rawValue] {
            guard frame.workspaceId == workspaceId, frame.nodeId == nodeId else {
                throw WorkspaceSyncClientError.invalidLoroSyncResponse
            }
            // This is deliberately the first network side effect on retry: it is the exact
            // immutable request which had an uncertain outcome, not a regenerated handshake.
            let response = try await loroTransport.loroPageReadSyncMessage(nodeId: nodeId.rawValue, sessionId: frame.sessionId, ordinal: frame.ordinal, clientVersion: frame.clientVersion)
            return try await acceptLoroResponse(response, frame: frame, witness: witness, schemaVersion: schemaVersion)
        }
        let persisted = try await localStore.loroPage(nodeId: nodeId)
        let source: Data
        if let persisted { source = persisted.snapshotBytes } else { source = try await loroStore.loadEmptyReplica().snapshotBytes }
        return try await runLoroSession(nodeId: nodeId, source: source, witness: witness, schemaVersion: schemaVersion, resetsRemaining: 1)
    }

    private func runLoroSession(nodeId: EntityId, source: Data, witness: (Int, String), schemaVersion: Int, resetsRemaining: Int) async throws -> LoroPageReadOnlyProjection {
        let sessionId = UUID().uuidString.lowercased()
        let started = try await loroTransport.startLoroPageSync(nodeId: nodeId.rawValue, sessionId: sessionId)
        guard started.sessionId == sessionId, !started.message.isEmpty, !started.serverVersion.isEmpty else {
            throw WorkspaceSyncClientError.invalidLoroSyncResponse
        }
        // `prepare` works on a clone reconstructed from durable bytes, so a failed import never
        // mutates the published cache or its SQLite row.
        let candidate = try await loroStore.prepare(nodeId: nodeId, snapshot: source, applying: started.message, serverVersion: started.serverVersion)
        // The start payload is already accepted remote state. Make it durable before exposing a
        // session/frame or publishing cache state, so a crash cannot forget a merged server base.
        try await persistLoro(candidate, dirty: true, witness: witness, nodeId: nodeId)
        let session = try LoroSyncSession(workspaceId: workspaceId, nodeId: nodeId, sessionId: sessionId, started: true, nextOrdinal: 0, knownServerVersion: started.serverVersion)
        loroSessions[nodeId.rawValue] = session

        // There is intentionally no native editor mutation API yet. The read-only frame is
        // retained so an uncertain transport retry preserves its session identity exactly.
        let frame = LoroInFlightFrame(workspaceId: workspaceId, nodeId: nodeId, sessionId: sessionId, ordinal: 0, clientVersion: candidate.versionBytes)
        loroInFlight[nodeId.rawValue] = frame
        let response: LoroPageSyncMessageOutput
        do {
            response = try await loroTransport.loroPageReadSyncMessage(nodeId: nodeId.rawValue, sessionId: sessionId, ordinal: 0, clientVersion: candidate.versionBytes)
        } catch { throw error }
        return try await acceptLoroResponse(response, frame: frame, witness: witness, schemaVersion: schemaVersion, candidate: candidate, resetsRemaining: resetsRemaining)
    }

    private func acceptLoroResponse(_ response: LoroPageSyncMessageOutput, frame: LoroInFlightFrame, witness: (Int, String), schemaVersion: Int, candidate suppliedCandidate: LoroPreparedPageState? = nil, resetsRemaining: Int = 1) async throws -> LoroPageReadOnlyProjection {
        guard response.sessionId == frame.sessionId, response.ordinal == frame.ordinal else { throw WorkspaceSyncClientError.invalidLoroSyncResponse }
        let persisted = try await localStore.loroPage(nodeId: frame.nodeId)
        let candidate: LoroPreparedPageState
        if let suppliedCandidate {
            candidate = suppliedCandidate
        } else {
            guard let persisted else { throw WorkspaceSyncClientError.pageNotFoundLocally(frame.nodeId) }
            candidate = try await loroStore.prepare(nodeId: frame.nodeId, snapshot: persisted.snapshotBytes, serverVersion: frame.clientVersion)
        }
        if response.reset {
            guard resetsRemaining > 0 else { throw WorkspaceSyncClientError.invalidLoroSyncResponse }
            // Reset means the old frame may have been applied. Persist the merged candidate dirty,
            // then re-handshake from those durable bytes rather than replaying it.
            try await persistLoro(candidate, dirty: true, witness: witness, nodeId: frame.nodeId)
            loroInFlight[frame.nodeId.rawValue] = nil
            return try await runLoroSession(nodeId: frame.nodeId, source: candidate.snapshotBytes, witness: witness, schemaVersion: schemaVersion, resetsRemaining: resetsRemaining - 1)
        }
        let accepted = try await loroStore.prepare(nodeId: frame.nodeId, snapshot: candidate.snapshotBytes, applying: response.update, serverVersion: response.serverVersion)
        let semanticVersionMatch: Bool
        if response.converged {
            semanticVersionMatch = try await loroStore.versionVectorsEqual(accepted.versionBytes, response.serverVersion)
        } else {
            semanticVersionMatch = false
        }
        let converged = response.converged && semanticVersionMatch
        // A definitive converged response is the only way to clear dirty. Previous dirty state is
        // evidence of an earlier uncertainty, not a reason to override this semantic convergence.
        let dirty = !converged
        try await persistLoro(accepted, dirty: dirty, witness: witness, nodeId: frame.nodeId)
        loroInFlight[frame.nodeId.rawValue] = nil
        loroSessions[frame.nodeId.rawValue] = try LoroSyncSession(workspaceId: workspaceId, nodeId: frame.nodeId, sessionId: frame.sessionId, started: true, nextOrdinal: frame.ordinal + 1, knownServerVersion: response.serverVersion)
        return LoroPageReadOnlyProjection(format: .loroV1, schemaVersion: schemaVersion, isDirty: dirty)
    }

    private func persistLoro(_ candidate: LoroPreparedPageState, dirty: Bool, witness: (Int, String), nodeId: EntityId) async throws {
        try await localStore.upsertLoroPage(LoroPageLocalState(prepared: candidate, dirty: dirty, observedDescriptorStorageVersion: witness.0, observedDescriptorSnapshotSHA256: witness.1))
        try await loroStore.publish(nodeId: nodeId, prepared: candidate)
        // Read-sync output is reconstructable observation material. It may update the durable
        // page and observed projection, but it cannot populate literal authoring authority.
        // Invalidate any prior literal so it cannot be reused after the route changes.
        await loroStore.invalidateLiteralCache(nodeId: nodeId)
    }

    // MARK: - Structured graph mutations (Tags/Facts/Edges) — local-first, same discipline as
    // `createNode`. Kept intentionally thin (one upsert + one RPC push each): the plan's
    // structured-conflict-model machinery ("base revision and prior value... observed-remove
    // tags... aggregate optimistic concurrency... tombstone conflict") is explicitly out of this
    // stage's scope (Storage/Sync-client, not the later conflict-resolution stage) — these methods
    // give `LocalWorkspaceStore`'s Tag/Fact/Edge tables a real, tested server counterpart rather than
    // leaving them write-only/local-only, without inventing that later machinery early.

    @discardableResult
    public func createTag(name: String, parentIds: [EntityId] = [], requestId: String, commitMessage: String, attribution: MutationAttribution) async throws -> Tag {
        let remote = try await rpcClient.createTag(name: name, parentIds: parentIds.map(\.rawValue), requestId: requestId, commitMessage: commitMessage, attribution: attribution)
        let tag = try Tag(
            id: EntityId(validating: remote.id),
            name: remote.name,
            parentIds: remote.parentIds.map { try EntityId(validating: $0) },
            builtin: remote.builtin
        )
        try await localStore.upsertTag(tag, dirty: false)
        return tag
    }

    @discardableResult
    public func addFact(nodeId: EntityId, predicateId: String, value: JSONValue, requestId: String, commitMessage: String, attribution: MutationAttribution, id: EntityId? = nil) async throws -> Fact {
        let localId = try id ?? EntityId(validating: UUID().uuidString.lowercased())
        let localFact = Fact(id: localId, nodeId: nodeId, predicateId: predicateId, value: value)
        try await localStore.upsertFact(localFact, dirty: true)

        let remote = try await rpcClient.addFact(
            nodeId: nodeId.rawValue, predicateId: predicateId, value: value.toCapnWebValue(), requestId: requestId, commitMessage: commitMessage, attribution: attribution, id: localId.rawValue
        )
        let confirmed = Fact(
            id: try EntityId(validating: remote.id),
            nodeId: try EntityId(validating: remote.nodeId),
            predicateId: remote.predicateId,
            value: try remote.value.toJSONValue()
        )
        try await localStore.upsertFact(confirmed, dirty: false)
        return confirmed
    }

    @discardableResult
    public func createEdge(relationDefinitionId: EntityId, sourceNodeId: EntityId, targetNodeId: EntityId, requestId: String, commitMessage: String, attribution: MutationAttribution) async throws -> Edge {
        let remote = try await rpcClient.createEdge(
            relationDefinitionId: relationDefinitionId.rawValue,
            sourceNodeId: sourceNodeId.rawValue,
            targetNodeId: targetNodeId.rawValue,
            requestId: requestId,
            commitMessage: commitMessage,
            attribution: attribution
        )
        let edge = Edge(
            id: try EntityId(validating: remote.id),
            relationDefinitionId: try EntityId(validating: remote.relationDefinitionId),
            sourceNodeId: try EntityId(validating: remote.sourceNodeId),
            targetNodeId: try EntityId(validating: remote.targetNodeId)
        )
        try await localStore.upsertEdge(edge, dirty: false)
        return edge
    }

    // MARK: - Structured-record sync feed catch-up (mirrors `sync-feed-client.ts`'s
    // `catchUpSyncFeed`)

    private static let pageLimit = 100
    private static let maxPages = 500

    /// Pages through `syncFeed` from this workspace's persisted cursor (`LocalWorkspaceStore.
    /// syncFeedCursor`) until caught up, restarting from scratch on an `epochMismatch` — the same
    /// epoch-recovery path `sync-feed-client.ts`'s doc comment describes, bounded at
    /// `maxPages`/`pageLimit` for the identical "fail loudly, don't hang forever" reason.
    public func catchUpStructuredSync() async throws -> SyncFeedCatchUpResult {
        var cursor = try await localStore.syncFeedCursor(workspaceId: workspaceId)
        var epoch = cursor?.epoch ?? ""
        var entriesSeen = 0
        var byEntityKind: [String: Int] = [:]

        for _ in 0..<Self.maxPages {
            let page = try await rpcClient.syncFeed(
                knownEpoch: cursor?.epoch, afterCounter: cursor?.afterCounter, limit: Self.pageLimit
            )
            epoch = page.epoch

            if page.epochMismatch {
                cursor = nil
                try await localStore.setSyncFeedCursor(workspaceId: workspaceId, epoch: epoch, afterCounter: nil)
                continue
            }

            for entry in page.entries {
                entriesSeen += 1
                byEntityKind[entry.entityKind, default: 0] += 1
            }

            guard let nextAfterCounter = page.nextAfterCounter else {
                try await localStore.setSyncFeedCursor(workspaceId: workspaceId, epoch: epoch, afterCounter: cursor?.afterCounter)
                return SyncFeedCatchUpResult(epoch: epoch, entriesSeen: entriesSeen, byEntityKind: byEntityKind)
            }
            cursor = (epoch: epoch, afterCounter: nextAfterCounter)
            try await localStore.setSyncFeedCursor(workspaceId: workspaceId, epoch: epoch, afterCounter: nextAfterCounter)
        }

        return SyncFeedCatchUpResult(epoch: epoch, entriesSeen: entriesSeen, byEntityKind: byEntityKind)
    }
}

// MARK: - JSONValue <-> CapnWebValue bridging (AthenaeumDomain's JSON model <-> AthenaeumRPC's
// wire value model — two independently-scoped packages, per this stage's own package boundaries,
// so a small adapter here is the right place for the conversion rather than either package
// depending on the other for it).

extension JSONValue {
    func toCapnWebValue() -> CapnWebValue {
        switch self {
        case .null: return .null
        case .bool(let value): return .bool(value)
        case .number(let value): return .number(value)
        case .string(let value): return .string(value)
        case .array(let values): return .array(values.map { $0.toCapnWebValue() })
        case .object(let fields):
            var result: [String: CapnWebValue] = [:]
            for (key, value) in fields { result[key] = value.toCapnWebValue() }
            return .object(result)
        }
    }
}

enum JSONValueBridgeError: Error, Sendable {
    case unsupportedCapnWebValue(String)
}

extension CapnWebValue {
    func toJSONValue() throws -> JSONValue {
        switch self {
        case .null, .undefined: return .null
        case .bool(let value): return .bool(value)
        case .number(let value): return .number(value)
        case .string(let value): return .string(value)
        case .array(let values): return .array(try values.map { try $0.toJSONValue() })
        case .object(let fields):
            var result: [String: JSONValue] = [:]
            for (key, value) in fields { result[key] = try value.toJSONValue() }
            return .object(result)
        case .bytes, .error:
            throw JSONValueBridgeError.unsupportedCapnWebValue("\(self)")
        }
    }
}
