import CryptoKit
import Foundation
import Loro
import AthenaeumDomain

public enum LoroPageDocumentStoreError: Error, Sendable, Equatable {
    case malformedSnapshot
    case malformedVersionVector
    case invalidPageSchema
    case preparedStateDoesNotMatchNode
    case invalidPreparedState
    case inputTooLarge
    case nativePlainTextIneligible
    case nativePlainTextWitnessMismatch
    case nativePlainTextDirty
    case nativePlainTextInvalidRange
    case nativePlainTextNoOp
    case nativePlainTextNewlineUnsupported
    case nativePlainTextMutationFailed
    case nativeRichTextIneligible
}

/// The deliberately small v1 editing surface. This is a value-only view: neither a Loro
/// container nor encoded CRDT material can cross into the app UI.
struct NativePlainLoroEditableV1: Sendable, Equatable {
    public let text: String
    public let scalarCount: Int
    /// Descriptor evidence accepted from the server. A local edit never rewrites this witness.
    public let route: LoroPageRouteWitness
    /// The exact actor replica currently shown to the caller.
    public let replica: LoroPageReplicaWitness
}

/// Internal bridge from actor-held literal authority to the public rich editor facade.
struct NativeRichLoroEditableV1: Sendable, Equatable {
    let document: LoroNativeRichDocumentV1
    let route: LoroPageRouteWitness
    let replica: LoroPageReplicaWitness
}

/// Structural validation only: page content remains opaque to the native store.
public struct LoroPageSchemaValidation: Sendable, Equatable {
    public let schemaVersion: Int
    public let hasCanonicalPageContainers: Bool

    init(schemaVersion: Int, hasCanonicalPageContainers: Bool) {
        self.schemaVersion = schemaVersion
        self.hasCanonicalPageContainers = hasCanonicalPageContainers
    }
}

/// A blank bootstrap is deliberately distinct from a persistable state. It may only receive the
/// canonical payload supplied by `startLoroPageSync`; it cannot be published or stored as a page.
public struct LoroBlankBootstrap: Sendable, Equatable {
    /// Module-internal only: the sync client may feed this into the canonical server payload,
    /// but no public caller can persist or publish it directly.
    let snapshotBytes: Data
    fileprivate init(snapshotBytes: Data) { self.snapshotBytes = snapshotBytes }
}

/// Actor-issued, node-bound material which may be persisted before it is published into the cache.
/// Its initializer is module-internal, so only this Core module can construct it.
public struct LoroPreparedPageState: Sendable, Equatable {
    public let nodeId: EntityId
    public let snapshotBytes: Data
    public let versionBytes: Data
    public let localSnapshotSHA256: String
    public let validation: LoroPageSchemaValidation

    init(nodeId: EntityId, snapshotBytes: Data, versionBytes: Data, localSnapshotSHA256: String, validation: LoroPageSchemaValidation) {
        self.nodeId = nodeId
        self.snapshotBytes = snapshotBytes
        self.versionBytes = versionBytes
        self.localSnapshotSHA256 = localSnapshotSHA256
        self.validation = validation
    }

    public var pageSchemaVersion: Int { validation.schemaVersion }
}

/// A non-authoritative inspection of exactly the bytes stored in a durable page row.  Unlike a
/// prepared state this never exports a snapshot, publishes a replica, or grants literal authority.
struct LoroPersistedReplicaInspection: Sendable, Equatable {
    let snapshotSHA256: String
    let versionVectorSHA256: String
    let validation: LoroPageSchemaValidation

    var pageSchemaVersion: Int { validation.schemaVersion }
}

/// Durable, FFI-free representation of one `loro_pages` row. Descriptor fields are observations
/// from an accepted remote descriptor/response and are never locally advanced.
public struct LoroPageLocalState: Sendable, Equatable {
    public let nodeId: EntityId
    public let pageSchemaVersion: Int
    public let snapshotBytes: Data
    public let localSnapshotSHA256: String
    public let dirty: Bool
    public let observedDescriptorStorageVersion: Int
    public let observedDescriptorSnapshotSHA256: String

    /// The node key is derived from the actor-issued candidate. This prevents a caller from
    /// persisting bytes prepared for one page under another page's SQLite key.
    public init(prepared: LoroPreparedPageState, dirty: Bool, observedDescriptorStorageVersion: Int, observedDescriptorSnapshotSHA256: String) {
        self.nodeId = prepared.nodeId
        self.pageSchemaVersion = prepared.pageSchemaVersion
        self.snapshotBytes = prepared.snapshotBytes
        self.localSnapshotSHA256 = prepared.localSnapshotSHA256
        self.dirty = dirty
        self.observedDescriptorStorageVersion = observedDescriptorStorageVersion
        self.observedDescriptorSnapshotSHA256 = observedDescriptorSnapshotSHA256
    }

    init(nodeId: EntityId, pageSchemaVersion: Int, snapshotBytes: Data, localSnapshotSHA256: String, dirty: Bool, observedDescriptorStorageVersion: Int, observedDescriptorSnapshotSHA256: String) {
        self.nodeId = nodeId
        self.pageSchemaVersion = pageSchemaVersion
        self.snapshotBytes = snapshotBytes
        self.localSnapshotSHA256 = localSnapshotSHA256
        self.dirty = dirty
        self.observedDescriptorStorageVersion = observedDescriptorStorageVersion
        self.observedDescriptorSnapshotSHA256 = observedDescriptorSnapshotSHA256
    }
}

/// An actor-minted, literal snapshot authority.  This is deliberately distinct from the
/// reconstructable `LoroPreparedPageState`: Loro snapshot exports are not a canonical wire
/// encoding, so an observation may not be promoted into authoring authority merely by importing
/// and exporting it again.
struct LoroLiteralPreparedPageState: Sendable, Equatable {
    let workspaceId: EntityId
    let nodeId: EntityId
    let route: LoroPageRouteWitness
    let snapshotBytes: Data
    let versionBytes: Data
    let localSnapshotSHA256: String
    let versionVectorSHA256: String
    let validation: LoroPageSchemaValidation

    private init(
        workspaceId: EntityId,
        nodeId: EntityId,
        route: LoroPageRouteWitness,
        snapshotBytes: Data,
        versionBytes: Data,
        localSnapshotSHA256: String,
        versionVectorSHA256: String,
        validation: LoroPageSchemaValidation
    ) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
        self.route = route
        self.snapshotBytes = snapshotBytes
        self.versionBytes = versionBytes
        self.localSnapshotSHA256 = localSnapshotSHA256
        self.versionVectorSHA256 = versionVectorSHA256
        self.validation = validation
    }

    /// The only mint is lexical to this source file.  Other Core sources can consume a token,
    /// but cannot turn arbitrary bytes plus a caller-computed hash into one.
    fileprivate static func minted(
        workspaceId: EntityId,
        nodeId: EntityId,
        route: LoroPageRouteWitness,
        snapshotBytes: Data,
        versionBytes: Data,
        localSnapshotSHA256: String,
        versionVectorSHA256: String,
        validation: LoroPageSchemaValidation
    ) -> Self {
        .init(
            workspaceId: workspaceId,
            nodeId: nodeId,
            route: route,
            snapshotBytes: snapshotBytes,
            versionBytes: versionBytes,
            localSnapshotSHA256: localSnapshotSHA256,
            versionVectorSHA256: versionVectorSHA256,
            validation: validation
        )
    }
}

/// A durable semantic candidate reminted from exact v7 evidence.  It binds the workspace as
/// well as the original base, immutable intent, update, and literal result bytes.
struct LoroFrozenLiteralCandidate: Sendable, Equatable {
    let workspaceId: EntityId
    let checkpoint: LoroSemanticCheckpoint
    let baseSnapshot: Data
    let baseSnapshotSHA256: String
    let literal: LoroLiteralPreparedPageState
    let nativePlainText: String
    let semantic: LoroCanonicalSemanticValueV1

    private init(
        workspaceId: EntityId,
        checkpoint: LoroSemanticCheckpoint,
        baseSnapshot: Data,
        baseSnapshotSHA256: String,
        literal: LoroLiteralPreparedPageState,
        nativePlainText: String,
        semantic: LoroCanonicalSemanticValueV1
    ) {
        self.workspaceId = workspaceId
        self.checkpoint = checkpoint
        self.baseSnapshot = baseSnapshot
        self.baseSnapshotSHA256 = baseSnapshotSHA256
        self.literal = literal
        self.nativePlainText = nativePlainText
        self.semantic = semantic
    }

    /// Same-file-only mint.  In particular, `@testable` clients cannot construct a frozen
    /// candidate, nor can another Core source fabricate one from a hydrated page row.
    fileprivate static func minted(
        workspaceId: EntityId,
        checkpoint: LoroSemanticCheckpoint,
        baseSnapshot: Data,
        baseSnapshotSHA256: String,
        literal: LoroLiteralPreparedPageState,
        nativePlainText: String,
        semantic: LoroCanonicalSemanticValueV1
    ) -> Self {
        .init(
            workspaceId: workspaceId,
            checkpoint: checkpoint,
            baseSnapshot: baseSnapshot,
            baseSnapshotSHA256: baseSnapshotSHA256,
            literal: literal,
            nativePlainText: nativePlainText,
            semantic: semantic
        )
    }
}

/// Semantic-only result of validating a reconstructed reload.  Raw reload bytes deliberately do
/// not escape this proof, preventing them from becoming an accidental literal persistence path.
struct LoroReconstructedAuthorityProof: Sendable, Equatable {
    let route: LoroPageRouteWitness
    let versionVector: Data
    let versionVectorSHA256: String
    let text: String
    let semantic: LoroCanonicalSemanticValueV1
}

/// A separate actor for native Loro replicas. No Loro handles escape this actor.
public actor LoroPageDocumentStore {
    private struct ObservationCache {
        let doc: LoroDoc
        let state: LoroPreparedPageState
    }

    private struct LiteralCache {
        let doc: LoroDoc
        let state: LoroLiteralPreparedPageState
    }

    /// Read-sync observations and literal authoring authority are intentionally disjoint.  An
    /// observation is useful to a projector, but it can never make a page editable.
    private var observed: [String: ObservationCache] = [:]
    private var literal: [String: LiteralCache] = [:]
    private var failNextLiteralPublication = false
    // Deliberately not the R0 corpus peer (424242). Each production compilation gets a fresh
    // actor identity so test fixtures cannot accidentally define production causality.
    private var issuedNativeRichPeers: Set<UInt64> = []

    public init() {}

    public func loadEmptyReplica() throws -> LoroBlankBootstrap {
        let doc = LoroDoc()
        return LoroBlankBootstrap(snapshotBytes: try doc.export(mode: .snapshot))
    }

    /// Validates only fixed metadata and the two required PM root containers. It intentionally
    /// does not inspect paragraphs, text, attributes values, or any user-authored child content.
    public func prepare(nodeId: EntityId, snapshot: Data, applying serverUpdate: Data? = nil, serverVersion: Data? = nil) throws -> LoroPreparedPageState {
        let limits = LoroPageProjectionLimits()
        guard snapshot.count <= limits.maxSnapshotBytes,
              (serverUpdate?.count ?? 0) <= limits.maxUpdateBytes,
              (serverVersion?.count ?? 0) <= limits.maxVersionVectorBytes else {
            throw LoroPageDocumentStoreError.inputTooLarge
        }
        let doc = LoroDoc()
        do {
            _ = try doc.import(bytes: snapshot)
            // An explicit zero-byte sync update carries no operations; importing it into Loro is
            // invalid, whereas an absent update has separate protocol meaning at the RPC layer.
            if let serverUpdate, !serverUpdate.isEmpty { _ = try doc.import(bytes: serverUpdate) }
        } catch { throw LoroPageDocumentStoreError.malformedSnapshot }
        if let serverVersion {
            do {
                let accepted = try VersionVector.decode(bytes: serverVersion)
                _ = try doc.export(mode: .updates(from: accepted))
            } catch { throw LoroPageDocumentStoreError.malformedVersionVector }
        }
        return try prepared(nodeId: nodeId, from: doc)
    }

    /// Inspects one persisted replica without normalizing it through snapshot export.  This is
    /// deliberately value-only and must remain separate from candidate preparation and literal
    /// cache installation: eligibility may observe durable bytes but cannot authorize them.
    func inspectPersistedReplicaV1(snapshot: Data) throws -> LoroPersistedReplicaInspection {
        let limits = LoroPageProjectionLimits()
        guard !snapshot.isEmpty, snapshot.count <= limits.maxSnapshotBytes else {
            throw LoroPageDocumentStoreError.inputTooLarge
        }
        let snapshotSHA256 = digest(snapshot)
        let doc = LoroDoc()
        do { _ = try doc.import(bytes: snapshot) }
        catch { throw LoroPageDocumentStoreError.malformedSnapshot }
        let versionBytes = doc.oplogVv().encode()
        guard versionBytes.count <= limits.maxVersionVectorBytes else {
            throw LoroPageDocumentStoreError.inputTooLarge
        }
        return .init(
            snapshotSHA256: snapshotSHA256,
            versionVectorSHA256: try semanticVersionDigest(versionBytes),
            validation: try inspectPageSchema(in: doc)
        )
    }

    /// Checkpoint-only eligibility proof for an untrusted candidate snapshot. It shares the
    /// exact closed-world predicate used by the editor but never publishes a Loro handle.
    func validateNativePlainLoroCandidateV1(nodeId: EntityId, snapshot: Data) throws -> LoroPreparedPageState {
        let prepared = try prepare(nodeId: nodeId, snapshot: snapshot)
        let doc = LoroDoc()
        do { _ = try doc.import(bytes: snapshot) } catch { throw LoroPageDocumentStoreError.malformedSnapshot }
        _ = try inspectNativePlainText(in: doc)
        return prepared
    }

    /// Core-test-only strict rich admission probe. It deliberately returns only prepared metadata
    /// and never creates a literal token, checkpoint, update, or transport-visible candidate.
    func validateNativeRichLoroCandidateV1(nodeId: EntityId, snapshot: Data) throws -> LoroPreparedPageState {
        let prepared = try prepare(nodeId: nodeId, snapshot: snapshot)
        let doc = try importedLiteralDocument(snapshot: snapshot)
        _ = try inspectNativeSemantic(in: doc)
        return prepared
    }

    /// Proves a candidate is the semantic result of applying its frozen update to the frozen
    /// base authority; both sides must satisfy the strict native-plain editor subset.
    func validateCheckpointCandidate(nodeId: EntityId, baseSnapshot: Data, baseVersionVector: Data, route: LoroPageRouteWitness, candidateSnapshot: Data, update: Data) throws -> LoroPreparedPageState {
        guard route.nodeId == nodeId, route.format == .loroV1, !update.isEmpty else { throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch }
        let base = try validateNativeRichOrPlainCandidateV1(nodeId: nodeId, snapshot: baseSnapshot)
        guard digest(baseSnapshot) == route.snapshotSHA256,
              route.schemaVersion == base.pageSchemaVersion,
              try versionVectorsEqual(base.versionBytes, baseVersionVector) else { throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch }
        let candidate = try validateNativeRichOrPlainCandidateV1(nodeId: nodeId, snapshot: candidateSnapshot)
        let candidateDoc = LoroDoc()
        do { _ = try candidateDoc.import(bytes: candidateSnapshot) } catch { throw LoroPageDocumentStoreError.malformedSnapshot }
        let candidateSemantic = try inspectNativeSemantic(in: candidateDoc)
        let doc = LoroDoc()
        do { _ = try doc.import(bytes: baseSnapshot); _ = try doc.import(bytes: update) }
        catch { throw LoroPageDocumentStoreError.malformedSnapshot }
        let applied = try prepared(nodeId: nodeId, from: doc)
        let appliedSemantic = try inspectNativeSemantic(in: doc)
        // Snapshot exports are not a canonical wire encoding. Both documents have already passed
        // strict native-plain validation; compare their causal identity and safe semantics rather
        // than requiring independently exported snapshot bytes to match.
        guard try versionVectorsEqual(applied.versionBytes, candidate.versionBytes),
              appliedSemantic == candidateSemantic else { throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch }
        return candidate
    }

    /// Publishes a reconstructable read observation only.  This deliberately does *not* populate
    /// the literal-authority cache; callers must first obtain `LoroAcceptedPageEvidence` from
    /// the durable store and pass it through `installAcceptedLiteral`.
    public func publish(nodeId: EntityId, prepared state: LoroPreparedPageState) throws {
        let limits = LoroPageProjectionLimits()
        guard state.snapshotBytes.count <= limits.maxSnapshotBytes,
              state.versionBytes.count <= limits.maxVersionVectorBytes,
              state.localSnapshotSHA256 == digest(state.snapshotBytes) else {
            throw LoroPageDocumentStoreError.inputTooLarge
        }
        guard nodeId == state.nodeId else { throw LoroPageDocumentStoreError.preparedStateDoesNotMatchNode }
        let doc = LoroDoc()
        do { _ = try doc.import(bytes: state.snapshotBytes) } catch { throw LoroPageDocumentStoreError.malformedSnapshot }
        let regenerated = try prepared(nodeId: nodeId, from: doc)
        guard try versionVectorsEqual(regenerated.versionBytes, state.versionBytes),
              regenerated.validation == state.validation else {
            throw LoroPageDocumentStoreError.invalidPreparedState
        }
        observed[nodeId.rawValue] = .init(doc: doc, state: state)
    }

    public func publishedState(nodeId: EntityId) throws -> LoroPreparedPageState? {
        observed[nodeId.rawValue]?.state
    }

    /// Projects the already-published actor-confined replica atomically. The only returned
    /// values are immutable and Sendable, so no FFI object can cross the actor boundary.
    public func projectPublished(nodeId: EntityId, route: LoroPageRouteWitness, isDirty: Bool) throws -> LoroPageProjection {
        guard let cached = observed[nodeId.rawValue] else { throw LoroPageProjectionError.pageNotPublished(nodeId) }
        let prepared = cached.state
        var projector = LoroPageProjector(limits: LoroPageProjectionLimits())
        let root = try projector.project(cached.doc)
        return LoroPageProjection(
            root: root,
            route: route,
            replica: LoroPageReplicaWitness(snapshotSHA256: prepared.localSnapshotSHA256, versionVectorSHA256: try semanticVersionDigest(prepared.versionBytes)),
            schemaVersion: prepared.pageSchemaVersion,
            isDirty: isDirty
        )
    }

    /// Returns the only native authoring subset proved for Loro/ProseMirror v1: one canonical
    /// paragraph containing zero or one unmarked `LoroText`. This is intentionally stricter than
    /// the read-only projector and inspects the live Loro graph rather than its sanitized output.
    func nativePlainLoroEditableV1(
        nodeId: EntityId,
        route: LoroPageRouteWitness,
        persistedReplica: LoroPageReplicaWitness,
        publishedReplica: LoroPageReplicaWitness,
        isDirty: Bool
    ) throws -> NativePlainLoroEditableV1 {
        guard !isDirty else { throw LoroPageDocumentStoreError.nativePlainTextDirty }
        guard let cached = literal[nodeId.rawValue] else { throw LoroPageProjectionError.pageNotPublished(nodeId) }
        let state = cached.state
        let actual = LoroPageReplicaWitness(snapshotSHA256: state.localSnapshotSHA256, versionVectorSHA256: state.versionVectorSHA256)
        guard route.nodeId == nodeId,
              route == state.route,
              route.format == .loroV1,
              route.schemaVersion == 1,
              route.snapshotSHA256 == state.localSnapshotSHA256,
              persistedReplica == actual,
              publishedReplica == actual else {
            throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch
        }
        let text = try inspectNativePlainText(in: cached.doc)
        return NativePlainLoroEditableV1(text: text, scalarCount: text.unicodeScalars.count, route: route, replica: actual)
    }

    /// Rich admission uses the same literal and witness boundary as plain admission, but accepts
    /// the closed canonical rich subset (with plain inspected first by `inspectNativeSemantic`).
    func nativeRichLoroEditableV1(
        nodeId: EntityId,
        route: LoroPageRouteWitness,
        persistedReplica: LoroPageReplicaWitness,
        publishedReplica: LoroPageReplicaWitness,
        isDirty: Bool
    ) throws -> NativeRichLoroEditableV1 {
        guard !isDirty, let cached = literal[nodeId.rawValue] else {
            if isDirty { throw LoroPageDocumentStoreError.nativePlainTextDirty }
            throw LoroPageProjectionError.pageNotPublished(nodeId)
        }
        let state = cached.state
        let actual = LoroPageReplicaWitness(snapshotSHA256: state.localSnapshotSHA256, versionVectorSHA256: state.versionVectorSHA256)
        guard route.nodeId == nodeId, route == state.route, route.format == .loroV1,
              route.schemaVersion == 1, route.snapshotSHA256 == state.localSnapshotSHA256,
              persistedReplica == actual, publishedReplica == actual else {
            throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch
        }
        return .init(document: .init(semantic: try inspectNativeSemantic(in: cached.doc)), route: route, replica: actual)
    }

    /// Replaces a scalar range inside the existing attached LoroText. The offset unit is Unicode
    /// scalar count, matching Loro's `insert`/`delete` Unicode-position API. Callers supply only
    /// scalar offsets; conversion and UInt32 bounds checks live here, next to the FFI call.
    ///
    /// This updates only the actor-confined replica. A later semantic checkpoint/durability layer
    /// owns persistence and ledger publication; no raw update bytes are returned from this API.
    func replaceNativePlainLoroEditableV1(
        nodeId: EntityId,
        route: LoroPageRouteWitness,
        persistedReplica: LoroPageReplicaWitness,
        publishedReplica: LoroPageReplicaWitness,
        isDirty: Bool,
        scalarRange: Range<Int>,
        replacement: String
    ) throws -> NativePlainLoroEditableV1 {
        let current = try nativePlainLoroEditableV1(
            nodeId: nodeId,
            route: route,
            persistedReplica: persistedReplica,
            publishedReplica: publishedReplica,
            isDirty: isDirty
        )
        guard !replacement.contains(where: { $0 == "\n" || $0 == "\r" }) else {
            throw LoroPageDocumentStoreError.nativePlainTextNewlineUnsupported
        }
        guard scalarRange.lowerBound >= 0,
              scalarRange.upperBound >= scalarRange.lowerBound,
              scalarRange.upperBound <= current.scalarCount else {
            throw LoroPageDocumentStoreError.nativePlainTextInvalidRange
        }
        let existing = String(current.text.unicodeScalars.dropFirst(scalarRange.lowerBound).prefix(scalarRange.count))
        guard existing != replacement else { throw LoroPageDocumentStoreError.nativePlainTextNoOp }
        guard let cached = literal[nodeId.rawValue] else { throw LoroPageProjectionError.pageNotPublished(nodeId) }
        let doc = cached.doc
        let base = doc.oplogVv()
        let text = try nativePlainTextContainer(in: doc, createIfEmpty: true)
        guard let position = UInt32(exactly: scalarRange.lowerBound),
              let length = UInt32(exactly: scalarRange.count) else {
            throw LoroPageDocumentStoreError.nativePlainTextInvalidRange
        }
        do {
            if length > 0 { try text.delete(pos: position, len: length) }
            if !replacement.isEmpty { try text.insert(pos: position, s: replacement) }
            doc.commit()
            guard !(try doc.export(mode: .updates(from: base))).isEmpty else {
                throw LoroPageDocumentStoreError.nativePlainTextMutationFailed
            }
        } catch let error as LoroPageDocumentStoreError {
            throw error
        } catch {
            throw LoroPageDocumentStoreError.nativePlainTextMutationFailed
        }
        let prepared = try prepared(nodeId: nodeId, from: doc)
        let replica = try replicaWitness(prepared)
        // `route` deliberately remains the accepted server descriptor witness. The new `replica`
        // is a separate local draft witness; it must be durably checkpointed and semantically
        // committed before any subsequent clean-page eligibility check can use it as authority.
        return NativePlainLoroEditableV1(text: try inspectNativePlainText(in: doc), scalarCount: Int(text.lenUnicode()), route: route, replica: replica)
    }

    /// Forms, but does not publish, a complete immutable semantic candidate.  Both the base and
    /// candidate Loro handles remain inside this actor; callers receive only frozen bytes.
    func prepareNativePlainSemanticCandidateV1(
        nodeId: EntityId,
        route: LoroPageRouteWitness,
        persistedReplica: LoroPageReplicaWitness,
        publishedReplica: LoroPageReplicaWitness,
        isDirty: Bool,
        scalarRange: Range<Int>,
        replacement: String,
        workspaceId: EntityId,
        intent: LoroMutationIntentV1
    ) throws -> LoroFrozenLiteralCandidate {
        let current = try nativePlainLoroEditableV1(nodeId: nodeId, route: route, persistedReplica: persistedReplica, publishedReplica: publishedReplica, isDirty: isDirty)
        guard !replacement.contains(where: { $0 == "\n" || $0 == "\r" }), scalarRange.lowerBound >= 0, scalarRange.upperBound >= scalarRange.lowerBound, scalarRange.upperBound <= current.scalarCount else {
            throw LoroPageDocumentStoreError.nativePlainTextInvalidRange
        }
        guard let cached = literal[nodeId.rawValue],
              cached.state.workspaceId == workspaceId,
              cached.state.route == route,
              cached.state.localSnapshotSHA256 == route.snapshotSHA256,
              cached.state.localSnapshotSHA256 == persistedReplica.snapshotSHA256 else { throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch }
        // The exact frozen base is actor-owned authority.  No caller can substitute a matching
        // looking byte string or a freshly re-exported reconstruction at this boundary.
        let baseSnapshot = cached.state.snapshotBytes
        let baseInspection = try inspectPersistedReplicaV1(snapshot: baseSnapshot)
        guard baseInspection.snapshotSHA256 == cached.state.localSnapshotSHA256,
              baseInspection.snapshotSHA256 == route.snapshotSHA256,
              baseInspection.snapshotSHA256 == persistedReplica.snapshotSHA256,
              baseInspection.snapshotSHA256 == publishedReplica.snapshotSHA256,
              baseInspection.pageSchemaVersion == route.schemaVersion,
              baseInspection.versionVectorSHA256 == cached.state.versionVectorSHA256,
              baseInspection.versionVectorSHA256 == persistedReplica.versionVectorSHA256,
              baseInspection.versionVectorSHA256 == publishedReplica.versionVectorSHA256 else {
            throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch
        }
        let clone = LoroDoc()
        do { _ = try clone.import(bytes: baseSnapshot) } catch { throw LoroPageDocumentStoreError.malformedSnapshot }
        let baseVersion = cached.state.versionBytes
        let text = try nativePlainTextContainer(in: clone, createIfEmpty: true)
        let existing = String(current.text.unicodeScalars.dropFirst(scalarRange.lowerBound).prefix(scalarRange.count))
        guard existing != replacement,
              let position = UInt32(exactly: scalarRange.lowerBound), let length = UInt32(exactly: scalarRange.count) else { throw LoroPageDocumentStoreError.nativePlainTextNoOp }
        do {
            if length > 0 { try text.delete(pos: position, len: length) }
            if !replacement.isEmpty { try text.insert(pos: position, s: replacement) }
            clone.commit()
            let update = try clone.export(mode: .updates(from: try VersionVector.decode(bytes: baseVersion)))
            guard !update.isEmpty else { throw LoroPageDocumentStoreError.nativePlainTextMutationFailed }
            let prepared = try prepared(nodeId: nodeId, from: clone)
            let expectedRoute = LoroPageRouteWitness(
                nodeId: nodeId,
                format: .loroV1,
                storageVersion: try incrementStorageVersion(route.storageVersion),
                schemaVersion: route.schemaVersion,
                snapshotSHA256: prepared.localSnapshotSHA256
            )
            let checkpoint = try LoroSemanticCheckpoint(
                workspaceId: workspaceId,
                nodeId: nodeId,
                state: .inFlight,
                intent: intent,
                route: route,
                update: update,
                baseVersionVector: baseVersion
            )
            let candidateText = try inspectNativePlainText(in: clone)
            let literal = try literalState(
                workspaceId: workspaceId,
                nodeId: nodeId,
                route: expectedRoute,
                snapshot: prepared.snapshotBytes,
                expectedVersionVector: prepared.versionBytes
            )
            return .minted(
                workspaceId: workspaceId,
                checkpoint: checkpoint,
                baseSnapshot: baseSnapshot,
                baseSnapshotSHA256: LoroMutationWire.sha256Hex(baseSnapshot),
                literal: literal,
                nativePlainText: candidateText,
                semantic: try inspectNativeSemantic(in: clone)
            )
        } catch let error as LoroPageDocumentStoreError { throw error }
        catch { throw LoroPageDocumentStoreError.nativePlainTextMutationFailed }
    }

    /// Mints a candidate only from the actor-held literal base. The caller contributes semantic
    /// content, never a snapshot, update, Loro handle, or candidate authority.
    func prepareNativeRichSemanticCandidateV1(
        nodeId: EntityId, route: LoroPageRouteWitness,
        persistedReplica: LoroPageReplicaWitness, publishedReplica: LoroPageReplicaWitness,
        isDirty: Bool, workspaceId: EntityId, intent: LoroMutationIntentV1,
        proposed: LoroNativeRichDocumentV1
    ) throws -> LoroFrozenLiteralCandidate {
        let semantic: LoroCanonicalSemanticValueV1
        do { semantic = try proposed.semantic.validated() } catch { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
        guard !isDirty, let cached = literal[nodeId.rawValue], cached.state.workspaceId == workspaceId else { throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch }
        let actual = LoroPageReplicaWitness(snapshotSHA256: cached.state.localSnapshotSHA256, versionVectorSHA256: cached.state.versionVectorSHA256)
        guard cached.state.route == route, route.snapshotSHA256 == actual.snapshotSHA256,
              persistedReplica == actual, publishedReplica == actual else { throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch }
        let baseSnapshot = cached.state.snapshotBytes
        let base = try importedLiteralDocument(snapshot: baseSnapshot)
        let baseVersion = base.oplogVv().encode()
        guard try versionVectorsEqual(baseVersion, cached.state.versionBytes), try inspectNativeSemantic(in: base) != semantic else { throw LoroPageDocumentStoreError.nativePlainTextNoOp }
        let peer = freshNativeRichPeer()
        let clone = LoroDoc()
        do { try clone.setPeerId(peer: peer); configureNativeRichStyles(clone); _ = try clone.import(bytes: baseSnapshot); try writeNativeRich(semantic, to: clone); clone.commit() }
        catch { throw LoroPageDocumentStoreError.nativePlainTextMutationFailed }
        let update: Data
        do { update = try clone.export(mode: .updates(from: try VersionVector.decode(bytes: baseVersion))) }
        catch { throw LoroPageDocumentStoreError.nativePlainTextMutationFailed }
        guard !update.isEmpty, try inspectNativeSemantic(in: clone) == semantic else { throw LoroPageDocumentStoreError.nativePlainTextMutationFailed }
        let prepared = try prepared(nodeId: nodeId, from: clone)
        let expectedRoute = LoroPageRouteWitness(nodeId: nodeId, format: .loroV1, storageVersion: try incrementStorageVersion(route.storageVersion), schemaVersion: route.schemaVersion, snapshotSHA256: prepared.localSnapshotSHA256)
        let checkpoint = try LoroSemanticCheckpoint(workspaceId: workspaceId, nodeId: nodeId, state: .inFlight, intent: intent, route: route, update: update, baseVersionVector: baseVersion)
        let literal = try literalState(workspaceId: workspaceId, nodeId: nodeId, route: expectedRoute, snapshot: prepared.snapshotBytes, expectedVersionVector: prepared.versionBytes, allowRich: true)
        return .minted(workspaceId: workspaceId, checkpoint: checkpoint, baseSnapshot: baseSnapshot, baseSnapshotSHA256: digest(baseSnapshot), literal: literal, nativePlainText: appliedText(from: semantic), semantic: semantic)
    }


    /// Loro version-vector wire encodings are not the equality contract. Decode both values and
    /// compare the semantic vectors, so a peer's equivalent encoding cannot keep a replica dirty.
    public func versionVectorsEqual(_ left: Data, _ right: Data) throws -> Bool {
        do {
            let lhs = try VersionVector.decode(bytes: left)
            let rhs = try VersionVector.decode(bytes: right)
            return lhs.eq(other: rhs)
        } catch {
            throw LoroPageDocumentStoreError.malformedVersionVector
        }
    }

    /// Installs authoring authority only from a durable, ownership-checked accepted-page proof.
    /// A generic prepared state or a hydrated `LoroPageLocalState` cannot call this API.
    func installAcceptedLiteral(_ evidence: LoroAcceptedPageEvidence) throws {
        guard evidence.route.nodeId == evidence.nodeId,
              evidence.route.format == .loroV1,
              evidence.route.schemaVersion == evidence.pageSchemaVersion,
              evidence.localSnapshotSHA256 == evidence.route.snapshotSHA256,
              digest(evidence.snapshotBytes) == evidence.localSnapshotSHA256 else {
            throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch
        }
        let state = try literalState(
            workspaceId: evidence.workspaceId,
            nodeId: evidence.nodeId,
            route: evidence.route,
            snapshot: evidence.snapshotBytes,
            expectedVersionVector: nil
        )
        let doc = try importedLiteralDocument(snapshot: state.snapshotBytes)
        literal[evidence.nodeId.rawValue] = .init(doc: doc, state: state)
    }

    /// Internal rich-authority recovery path. It is deliberately separate from the legacy plain
    /// method above, whose error taxonomy and editor admission must remain unchanged.
    func installAcceptedRichLiteral(_ evidence: LoroAcceptedPageEvidence) throws {
        guard evidence.route.nodeId == evidence.nodeId, evidence.route.format == .loroV1,
              evidence.route.schemaVersion == evidence.pageSchemaVersion,
              evidence.localSnapshotSHA256 == evidence.route.snapshotSHA256,
              digest(evidence.snapshotBytes) == evidence.localSnapshotSHA256 else { throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch }
        let state = try literalState(workspaceId: evidence.workspaceId, nodeId: evidence.nodeId, route: evidence.route, snapshot: evidence.snapshotBytes, expectedVersionVector: nil, allowRich: true)
        literal[evidence.nodeId.rawValue] = .init(doc: try importedLiteralDocument(snapshot: state.snapshotBytes), state: state)
    }

    /// Revalidates every durable v7 field before reminting a process-local literal token.  A
    /// hydrated page row, an observation cache entry, and a reconstructed reload intentionally
    /// have no path here.
    func remintFrozenLiteralCandidate(_ evidence: LoroFrozenCandidateEvidence) throws -> LoroFrozenLiteralCandidate {
        let checkpoint = evidence.checkpoint
        guard evidence.workspaceId == checkpoint.workspaceId,
              evidence.nodeId == checkpoint.nodeId,
              evidence.baseSnapshotSHA256 == digest(evidence.baseSnapshot),
              evidence.baseSnapshotSHA256 == checkpoint.route.snapshotSHA256,
              evidence.expectedResultRoute.nodeId == checkpoint.nodeId,
              evidence.expectedResultRoute.format == .loroV1,
              evidence.expectedResultRoute.storageVersion == (try incrementStorageVersion(checkpoint.route.storageVersion)),
              evidence.expectedResultRoute.schemaVersion == checkpoint.route.schemaVersion,
              evidence.candidateSnapshotSHA256 == digest(evidence.candidateSnapshot),
              evidence.candidateSnapshotSHA256 == evidence.expectedResultRoute.snapshotSHA256,
              evidence.candidateResultVersionVectorSHA256 == (try semanticVersionDigest(evidence.candidateResultVersionVector)),
              checkpoint.baseVersionVectorSHA256 == (try semanticVersionDigest(checkpoint.baseVersionVector)) else {
            throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch
        }

        let base = try literalState(
            workspaceId: evidence.workspaceId,
            nodeId: evidence.nodeId,
            route: checkpoint.route,
            snapshot: evidence.baseSnapshot,
            expectedVersionVector: checkpoint.baseVersionVector,
            allowRich: true
        )
        let candidate = try literalState(
            workspaceId: evidence.workspaceId,
            nodeId: evidence.nodeId,
            route: evidence.expectedResultRoute,
            snapshot: evidence.candidateSnapshot,
            expectedVersionVector: evidence.candidateResultVersionVector,
            allowRich: true
        )
        let applied = try importedLiteralDocument(snapshot: evidence.baseSnapshot)
        do { _ = try applied.import(bytes: checkpoint.update) }
        catch { throw LoroPageDocumentStoreError.malformedSnapshot }
        let appliedSemantic = try inspectNativeSemantic(in: applied)
        let candidateSemantic = try inspectNativeSemantic(in: importedLiteralDocument(snapshot: evidence.candidateSnapshot))
        let appliedVersion = applied.oplogVv().encode()
        guard try versionVectorsEqual(appliedVersion, candidate.versionBytes),
              appliedSemantic == candidateSemantic,
              base.localSnapshotSHA256 == checkpoint.route.snapshotSHA256 else {
            throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch
        }
        return .minted(
            workspaceId: evidence.workspaceId,
            checkpoint: checkpoint,
            baseSnapshot: evidence.baseSnapshot,
            baseSnapshotSHA256: evidence.baseSnapshotSHA256,
            literal: candidate,
            nativePlainText: appliedText(from: appliedSemantic),
            semantic: appliedSemantic
        )
    }

    /// A reload reconstructed by sync is evidence about semantic state only.  It may establish a
    /// matching route, strict graph, text, and version vector, but its exported raw bytes are
    /// never a persistence or publication input.
    func validateReconstructedAuthority(_ authority: LoroReconstructedAuthorityObservation) throws -> LoroReconstructedAuthorityProof {
        guard authority.route.nodeId == authority.nodeId,
              authority.route.format == .loroV1,
              authority.route.storageVersion > 0,
              authority.route.schemaVersion > 0,
              digest(authority.snapshot) == authority.route.snapshotSHA256,
              authority.snapshot.count <= LoroPageProjectionLimits().maxSnapshotBytes,
              authority.versionVector.count <= LoroPageProjectionLimits().maxVersionVectorBytes else {
            throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch
        }
        let doc = try importedLiteralDocument(snapshot: authority.snapshot)
        let validation = try inspectPageSchema(in: doc)
        let semantic = try inspectNativeSemantic(in: doc)
        let version = doc.oplogVv().encode()
        guard validation.schemaVersion == authority.route.schemaVersion,
              try versionVectorsEqual(version, authority.versionVector) else {
            throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch
        }
        return .init(route: authority.route, versionVector: version, versionVectorSHA256: try semanticVersionDigest(version), text: appliedText(from: semantic), semantic: semantic)
    }

    /// Publishes only a reminted frozen v7 candidate after SQLite has atomically accepted it.
    /// It never derives a snapshot by re-exporting a reconstructed authority response.
    func publishLiteral(_ frozen: LoroFrozenLiteralCandidate) throws {
        if failNextLiteralPublication {
            failNextLiteralPublication = false
            throw LoroPageDocumentStoreError.nativePlainTextMutationFailed
        }
        let checked = try literalState(
            workspaceId: frozen.workspaceId,
            nodeId: frozen.checkpoint.nodeId,
            route: frozen.literal.route,
            snapshot: frozen.literal.snapshotBytes,
            expectedVersionVector: frozen.literal.versionBytes,
            allowRich: true
        )
        let literalSemantic = try inspectNativeSemantic(in: importedLiteralDocument(snapshot: frozen.literal.snapshotBytes))
        guard checked == frozen.literal,
              frozen.checkpoint.workspaceId == frozen.workspaceId,
              frozen.checkpoint.nodeId == frozen.literal.nodeId,
              frozen.literal.route.storageVersion == (try incrementStorageVersion(frozen.checkpoint.route.storageVersion)),
              frozen.semantic == literalSemantic else {
            throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch
        }
        let doc = try importedLiteralDocument(snapshot: frozen.literal.snapshotBytes)
        literal[frozen.literal.nodeId.rawValue] = .init(doc: doc, state: frozen.literal)
        let observation = LoroPreparedPageState(
            nodeId: frozen.literal.nodeId,
            snapshotBytes: frozen.literal.snapshotBytes,
            versionBytes: frozen.literal.versionBytes,
            localSnapshotSHA256: frozen.literal.localSnapshotSHA256,
            validation: frozen.literal.validation
        )
        observed[frozen.literal.nodeId.rawValue] = .init(doc: try importedLiteralDocument(snapshot: observation.snapshotBytes), state: observation)
    }

    /// Recovery callers choose when to re-install authority from the durable accepted row.  A
    /// post-commit publication failure removes both slots so no stale edit can be admitted.
    func invalidateCacheSlots(nodeId: EntityId) {
        observed[nodeId.rawValue] = nil
        literal[nodeId.rawValue] = nil
    }

    /// A raw read-sync observation may replace the durable page, but it may not retain a prior
    /// literal authoring token.  The observed projection remains available for read-only use;
    /// callers must explicitly recover a sealed accepted row before authoring again.
    func invalidateLiteralCache(nodeId: EntityId) {
        literal[nodeId.rawValue] = nil
    }

    /// Internal test failpoint used to prove post-commit cache invalidation.  It does not create
    /// a literal token or offer a generic raw-byte publication path.
    func failNextLiteralPublicationForTesting() {
        failNextLiteralPublication = true
    }

    /// True only for a causal successor, never for an equivalent re-encoding.
    func versionVectorStrictlyIncludes(_ authority: Data, _ candidate: Data) throws -> Bool {
        do {
            let lhs = try VersionVector.decode(bytes: authority)
            let rhs = try VersionVector.decode(bytes: candidate)
            return lhs.includesVv(other: rhs) && !lhs.eq(other: rhs)
        } catch { throw LoroPageDocumentStoreError.malformedVersionVector }
    }

    private func prepared(nodeId: EntityId, from doc: LoroDoc) throws -> LoroPreparedPageState {
        let snapshot: Data
        do { snapshot = try doc.export(mode: .snapshot) } catch { throw LoroPageDocumentStoreError.malformedSnapshot }
        let version = doc.oplogVv().encode()
        let limits = LoroPageProjectionLimits()
        guard snapshot.count <= limits.maxSnapshotBytes, version.count <= limits.maxVersionVectorBytes else { throw LoroPageDocumentStoreError.inputTooLarge }
        return LoroPreparedPageState(nodeId: nodeId, snapshotBytes: snapshot, versionBytes: version, localSnapshotSHA256: digest(snapshot), validation: try inspectPageSchema(in: doc))
    }

    /// Recreates a literal state only after checking the raw stored bytes themselves.  It is not
    /// exposed as a generic `bytes + hash` factory: its callers are the accepted-page and frozen
    /// evidence boundaries above, plus actor-owned candidate construction.
    private func literalState(
        workspaceId: EntityId,
        nodeId: EntityId,
        route: LoroPageRouteWitness,
        snapshot: Data,
        expectedVersionVector: Data?,
        allowRich: Bool = false
    ) throws -> LoroLiteralPreparedPageState {
        let limits = LoroPageProjectionLimits()
        guard route.nodeId == nodeId,
              route.format == .loroV1,
              route.storageVersion > 0,
              route.schemaVersion > 0,
              snapshot.count > 0,
              snapshot.count <= limits.maxSnapshotBytes,
              digest(snapshot) == route.snapshotSHA256,
              expectedVersionVector.map({ !$0.isEmpty && $0.count <= limits.maxVersionVectorBytes }) ?? true else {
            throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch
        }
        let doc = try importedLiteralDocument(snapshot: snapshot)
        let validation = try inspectPageSchema(in: doc)
        let version = doc.oplogVv().encode()
        let expectedVersionMatches = try expectedVersionVector.map { try versionVectorsEqual(version, $0) } ?? true
        guard validation.schemaVersion == route.schemaVersion,
              expectedVersionMatches else {
            throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch
        }
        if allowRich { _ = try inspectNativeSemantic(in: doc) }
        else { _ = try inspectNativePlainText(in: doc) }
        return .minted(
            workspaceId: workspaceId,
            nodeId: nodeId,
            route: route,
            snapshotBytes: snapshot,
            versionBytes: version,
            localSnapshotSHA256: digest(snapshot),
            versionVectorSHA256: try semanticVersionDigest(version),
            validation: validation
        )
    }

    private func importedLiteralDocument(snapshot: Data) throws -> LoroDoc {
        let doc = LoroDoc()
        do { _ = try doc.import(bytes: snapshot) }
        catch { throw LoroPageDocumentStoreError.malformedSnapshot }
        return doc
    }

    private func incrementStorageVersion(_ storageVersion: Int) throws -> Int {
        guard storageVersion > 0, storageVersion < Int.max else {
            throw LoroPageDocumentStoreError.nativePlainTextWitnessMismatch
        }
        return storageVersion + 1
    }

    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// A semantic VV witness is independent of a peer's non-canonical wire encoding.
    private func semanticVersionDigest(_ encoded: Data) throws -> String {
        do {
            return try VersionVectorIdentity.digest(encodedVersionVector: encoded)
        } catch {
            throw LoroPageDocumentStoreError.malformedVersionVector
        }
    }

    private func replicaWitness(_ prepared: LoroPreparedPageState) throws -> LoroPageReplicaWitness {
        LoroPageReplicaWitness(snapshotSHA256: prepared.localSnapshotSHA256, versionVectorSHA256: try semanticVersionDigest(prepared.versionBytes))
    }

    /// Plain is intentionally considered first, preserving the established v7 surface and empty
    /// paragraph behaviour. Rich admission is a separate, closed-world native validator; it does
    /// not use the web replay helper or projection as an authority oracle.
    private func inspectNativeSemantic(in doc: LoroDoc) throws -> LoroCanonicalSemanticValueV1 {
        if let plain = try? inspectNativePlainText(in: doc) {
            let semantic = LoroCanonicalSemanticValueV1(blocks: [.paragraph(plain.isEmpty ? [] : [.init(text: plain)])])
            do { return try semantic.validated() }
            catch { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
        }
        guard case let .map(roots) = doc.getDeepValue(), Set(roots.keys) == ["athenaeum-page-meta-v1", "athenaeum-prosemirror-v1"] else { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
        let metadata = doc.getMap(id: "athenaeum-page-meta-v1")
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        guard case let .map(meta) = metadata.getDeepValue(), meta.count == 1, case .i64(1)? = meta["schemaVersion"],
              case let .map(rootValue) = root.getDeepValue(), Set(rootValue.keys) == ["nodeName", "attributes", "children"],
              case .string("doc")? = rootValue["nodeName"], case let .map(rootAttrs)? = rootValue["attributes"], isNativePlainAttributes(rootAttrs),
              let children = root.get(key: "children")?.asLoroList(), children.len() > 0, Int(children.len()) <= LoroPageProjectionLimits().maxChildren else { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
        var blocks: [LoroCanonicalSemanticValueV1.Block] = []
        var bytes = 0
        var scalarCount = 0
        var runCount = 0
        for index in 0..<children.len() {
            guard let map = children.get(index: index)?.asLoroMap(), case let .map(value) = map.getDeepValue(), Set(value.keys) == ["nodeName", "attributes", "children"],
                  case let .string(name)? = value["nodeName"], case let .map(attrs)? = value["attributes"],
                  let inline = map.get(key: "children")?.asLoroList(), inline.len() <= 1 else { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
            let runs: [LoroCanonicalSemanticValueV1.TextRun]
            if inline.len() == 0 { runs = [] } else {
                guard let text = inline.get(index: 0)?.asLoroText(), text.isAttached(), !text.isDeleted() else { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
                bytes += Int(text.lenUtf8()); scalarCount += Int(text.lenUnicode())
                guard bytes <= LoroPageProjectionLimits().maxUTF8Bytes, scalarCount <= LoroPageProjectionLimits().maxUTF8Bytes else { throw LoroPageDocumentStoreError.inputTooLarge }
                runs = try richRuns(text)
            }
            runCount += runs.count
            guard runCount <= LoroPageProjectionLimits().maxTextRuns, runs.allSatisfy({ $0.marks.count <= LoroPageProjectionLimits().maxMarks }) else { throw LoroPageDocumentStoreError.inputTooLarge }
            switch name {
            case "paragraph": guard isNativePlainAttributes(attrs) else { throw LoroPageDocumentStoreError.nativeRichTextIneligible }; blocks.append(.paragraph(runs))
            case "heading":
                guard attrs.count == 2, attrs["isAmgBlock"] == .bool(value: false), case .i64(let level)? = attrs["level"], (1...3).contains(Int(level)) else { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
                blocks.append(.heading(level: Int(level), runs: runs))
            default: throw LoroPageDocumentStoreError.nativeRichTextIneligible
            }
        }
        let semantic = LoroCanonicalSemanticValueV1(blocks: blocks)
        do { return try semantic.validated() } catch { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
    }

    private func richRuns(_ text: LoroText) throws -> [LoroCanonicalSemanticValueV1.TextRun] {
        var runs: [LoroCanonicalSemanticValueV1.TextRun] = []
        for delta in text.toDelta() {
            guard case let .insert(insertedText, rawAttributes) = delta, !insertedText.isEmpty else { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
            let attributes = rawAttributes ?? [:]
            guard attributes.keys.allSatisfy({ ["strong", "em", "code", "entityRef", "supertagRef"].contains($0) }) else { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
            for key in ["strong", "em", "code"] {
                if let value = attributes[key], value != LoroValue.map(value: [:]) { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
            }
            let references = ["entityRef", "supertagRef"].compactMap { key -> LoroCanonicalSemanticValueV1.InlineReference? in
                guard let attributeValue = attributes[key] else { return nil }
                guard case let .map(payload) = attributeValue,
                      Set(payload.keys) == Set([key == "entityRef" ? "nodeId" : "tagId", "label"]),
                      case let .string(id)? = payload[key == "entityRef" ? "nodeId" : "tagId"],
                      case let .string(label)? = payload["label"],
                      let entityId = try? EntityId(validating: id),
                      !label.isEmpty, label.lengthOfBytes(using: .utf8) <= 500, label == insertedText else { return nil }
                return .init(kind: key == "entityRef" ? .entity : .supertag, id: entityId, label: label)
            }
            guard references.count == attributes.keys.filter({ $0 == "entityRef" || $0 == "supertagRef" }).count,
                  references.count <= 1 else { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
            let marks = LoroCanonicalSemanticValueV1.Mark.canonicalOrder.filter { mark in attributes.keys.contains(mark == .emphasis ? "em" : mark.rawValue) }
            let reference = references.first
            guard runs.last == nil || runs.last!.marks != marks || runs.last!.reference != reference else { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
            runs.append(.init(text: insertedText, marks: marks, reference: reference))
        }
        return runs
    }

    private func writeNativeRich(_ semantic: LoroCanonicalSemanticValueV1, to doc: LoroDoc) throws {
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        guard let children = root.get(key: "children")?.asLoroList() else { throw LoroPageDocumentStoreError.nativeRichTextIneligible }
        if children.len() > 0 { try children.delete(pos: 0, len: children.len()) }
        for block in semantic.blocks {
            let node = try children.insertMapContainer(pos: children.len(), child: LoroMap())
            let attributes = try node.getOrCreateMapContainer(key: "attributes", child: LoroMap())
            let inline = try node.getOrCreateListContainer(key: "children", child: LoroList())
            let runs: [LoroCanonicalSemanticValueV1.TextRun]
            switch block {
            case let .paragraph(value): try node.insert(key: "nodeName", v: "paragraph"); try attributes.insert(key: "isAmgBlock", v: false); runs = value
            case let .heading(level, value): try node.insert(key: "nodeName", v: "heading"); try attributes.insert(key: "isAmgBlock", v: false); try attributes.insert(key: "level", v: level); runs = value
            }
            guard !runs.isEmpty else { continue }
            let text = try inline.insertTextContainer(pos: 0, child: LoroText())
            var offset: UInt32 = 0
            for run in runs {
                try text.pushStr(s: run.text)
                guard let count = UInt32(exactly: run.text.unicodeScalars.count), offset <= UInt32.max - count else { throw LoroPageDocumentStoreError.inputTooLarge }
                for mark in run.marks { try text.mark(from: offset, to: offset + count, key: mark == .emphasis ? "em" : mark.rawValue, value: LoroValue.map(value: [:])) }
                if let reference = run.reference {
                    let key = reference.kind == .entity ? "entityRef" : "supertagRef"
                    let idKey = reference.kind == .entity ? "nodeId" : "tagId"
                    let payload: LoroValue = .map(value: [idKey: .string(value: reference.id.rawValue), "label": .string(value: reference.label)])
                    try text.mark(from: offset, to: offset + count, key: key, value: payload)
                }
                offset += count
            }
        }
    }

    private func configureNativeRichStyles(_ doc: LoroDoc) {
        let styles = StyleConfigMap.defaultRichTextConfig()
        // The canonical value form records exact mark spans. A mark that expands at either edge
        // would silently apply formatting to surrounding Web-authored prose on a native rewrite.
        styles.insert(key: "strong", value: StyleConfig(expand: .none))
        styles.insert(key: "em", value: StyleConfig(expand: .none))
        styles.insert(key: "code", value: StyleConfig(expand: .none))
        styles.insert(key: "entityRef", value: StyleConfig(expand: .none))
        styles.insert(key: "supertagRef", value: StyleConfig(expand: .none))
        doc.configTextStyle(textStyle: styles)
    }

    private func appliedText(from semantic: LoroCanonicalSemanticValueV1) -> String {
        semantic.blocks.map { block in
            switch block { case let .paragraph(runs): return runs.map(\.text).joined(); case let .heading(_, runs): return runs.map(\.text).joined() }
        }.joined(separator: "\n")
    }

    private func freshNativeRichPeer() -> UInt64 {
        var generator = SystemRandomNumberGenerator()
        var peer: UInt64
        repeat { peer = UInt64.random(in: 1...UInt64.max, using: &generator) } while peer == 424242 || issuedNativeRichPeers.contains(peer)
        issuedNativeRichPeers.insert(peer)
        return peer
    }

    private func validateNativeRichOrPlainCandidateV1(nodeId: EntityId, snapshot: Data) throws -> LoroPreparedPageState {
        let prepared = try prepare(nodeId: nodeId, snapshot: snapshot)
        let doc = try importedLiteralDocument(snapshot: snapshot)
        do { _ = try inspectNativeSemantic(in: doc) }
        catch { throw LoroPageDocumentStoreError.nativePlainTextIneligible }
        return prepared
    }

    /// Closed-world raw graph validation for the native plain-text editor. `getDeepValue` is used
    /// first so querying the expected roots cannot manufacture an absent root in an untrusted doc.
    private func inspectNativePlainText(in doc: LoroDoc) throws -> String {
        guard case let .map(value: roots) = doc.getDeepValue(),
              Set(roots.keys) == ["athenaeum-page-meta-v1", "athenaeum-prosemirror-v1"] else {
            throw LoroPageDocumentStoreError.nativePlainTextIneligible
        }
        let metadata = doc.getMap(id: "athenaeum-page-meta-v1")
        guard case let .map(value: metadataValues) = metadata.getDeepValue(),
              metadataValues.count == 1,
              case .i64(1)? = metadataValues["schemaVersion"] else {
            throw LoroPageDocumentStoreError.nativePlainTextIneligible
        }
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        guard case let .map(value: rootValues) = root.getDeepValue(),
              Set(rootValues.keys) == ["nodeName", "attributes", "children"],
              case .string("doc")? = rootValues["nodeName"],
              case let .map(value: rootAttributes)? = rootValues["attributes"],
              isNativePlainAttributes(rootAttributes),
              case let .list(value: rootChildren)? = rootValues["children"], rootChildren.count == 1 else {
            throw LoroPageDocumentStoreError.nativePlainTextIneligible
        }
        guard let children = root.get(key: "children")?.asLoroList(),
              let paragraph = children.get(index: 0)?.asLoroMap(),
              case let .map(value: paragraphValues) = paragraph.getDeepValue(),
              Set(paragraphValues.keys) == ["nodeName", "attributes", "children"],
              case .string("paragraph")? = paragraphValues["nodeName"],
              case let .map(value: paragraphAttributes)? = paragraphValues["attributes"],
              isNativePlainAttributes(paragraphAttributes),
              case let .list(value: paragraphChildren)? = paragraphValues["children"], paragraphChildren.count <= 1 else {
            throw LoroPageDocumentStoreError.nativePlainTextIneligible
        }
        if paragraphChildren.isEmpty { return "" }
        guard let inline = paragraph.get(key: "children")?.asLoroList(),
              let text = inline.get(index: 0)?.asLoroText(),
              text.isAttached(), !text.isDeleted(),
              Int(text.lenUnicode()) <= LoroPageProjectionLimits().maxUTF8Bytes,
              text.lenUtf8() <= UInt32(LoroPageProjectionLimits().maxUTF8Bytes) else {
            throw LoroPageDocumentStoreError.nativePlainTextIneligible
        }
        // Marks are intentionally not accepted in the v1 authoring subset.
        guard case let .list(value: delta) = text.getRichtextValue(), delta.allSatisfy({ entry in
            guard case let .map(value: run) = entry,
                  case .string? = run["insert"],
                  run.keys.allSatisfy({ $0 == "insert" }) else { return false }
            return true
        }) else { throw LoroPageDocumentStoreError.nativePlainTextIneligible }
        return text.toString()
    }

    private func isNativePlainAttributes(_ attributes: [String: LoroValue]) -> Bool {
        attributes.count == 1 && attributes["isAmgBlock"] == .bool(value: false)
    }

    private func nativePlainTextContainer(in doc: LoroDoc, createIfEmpty: Bool) throws -> LoroText {
        _ = try inspectNativePlainText(in: doc)
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        guard let children = root.get(key: "children")?.asLoroList(),
              let paragraph = children.get(index: 0)?.asLoroMap(),
              let inline = paragraph.get(key: "children")?.asLoroList() else {
            throw LoroPageDocumentStoreError.nativePlainTextIneligible
        }
        if let text = inline.get(index: 0)?.asLoroText(), text.isAttached(), !text.isDeleted() { return text }
        guard createIfEmpty, inline.len() == 0 else { throw LoroPageDocumentStoreError.nativePlainTextIneligible }
        do { return try inline.insertTextContainer(pos: 0, child: LoroText()) }
        catch { throw LoroPageDocumentStoreError.nativePlainTextMutationFailed }
    }

    private func inspectPageSchema(in doc: LoroDoc) throws -> LoroPageSchemaValidation {
        let metadata = doc.getMap(id: "athenaeum-page-meta-v1")
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        guard case .i64(1)? = metadata.get(key: "schemaVersion")?.asValue(),
              case .string("doc")? = root.get(key: "nodeName")?.asValue(),
              root.get(key: "attributes")?.asLoroMap() != nil,
              root.get(key: "children")?.asLoroList() != nil else {
            throw LoroPageDocumentStoreError.invalidPageSchema
        }
        return LoroPageSchemaValidation(schemaVersion: 1, hasCanonicalPageContainers: true)
    }
}
