import AthenaeumDomain
import Foundation

/// The durable semantic-checkpoint state a native editor must resolve before it can author.
/// This intentionally contains no checkpoint bytes, mutation intent, or CRDT material.
public enum LoroSemanticCheckpointResolution: Sendable, Equatable {
    case none
    case inFlight
    case committed
    case retainedRetry
    case retainedConflict
    case retainedRequestIdentity
    case deniedAuthorizationOrSession
}

/// Immutable, value-only native editor input. Loro handles and encoded updates remain Core-private.
public struct LoroNativePlainEditorState: Sendable, Equatable {
    public let text: String
    public let scalarCount: Int
    public let route: LoroPageRouteWitness
    public let replica: LoroPageReplicaWitness

    init(_ value: NativePlainLoroEditableV1) {
        text = value.text
        scalarCount = value.scalarCount
        route = value.route
        replica = value.replica
    }

    /// Core-test seam; it is intentionally not part of the library's public authoring API.
    init(text: String, scalarCount: Int, route: LoroPageRouteWitness, replica: LoroPageReplicaWitness) {
        self.text = text
        self.scalarCount = scalarCount
        self.route = route
        self.replica = replica
    }
}

/// Closed native editor admission result. A caller can only edit after `.editable`.
public enum LoroNativePlainEditorEligibility: Sendable, Equatable {
    case editable(LoroNativePlainEditorState)
    case unauthenticated
    case checkpointResolutionRequired(LoroSemanticCheckpointResolution)
    case ineligible
}

/// Closed, value-only result of asking Core to submit a whole-text native edit.  In particular,
/// neither an update nor a request identifier can escape to the presentation layer.
public enum LoroNativePlainTextSubmissionDisposition: Sendable, Equatable {
    case submitted
    /// The edit is durably accepted and archived, but Core intentionally invalidated both local
    /// cache slots after a post-commit publication failure. Reopen/reload before editing again.
    case submittedNeedsReload
    case noChange
    case unauthenticated
    case checkpointResolutionRequired(LoroSemanticCheckpointResolution)
    case ineligible
    case staleEditorState
    case invalidProposedText
}

/// Immutable value-only rich-document editor input. CRDT containers and encoded updates remain
/// inside Core; presentation receives only canonical semantic content and immutable witnesses.
public struct LoroNativeRichEditorState: Sendable, Equatable {
    public let document: LoroNativeRichDocumentV1
    public let route: LoroPageRouteWitness
    public let replica: LoroPageReplicaWitness

    init(_ value: NativeRichLoroEditableV1) {
        document = value.document
        route = value.route
        replica = value.replica
    }

    init(document: LoroNativeRichDocumentV1, route: LoroPageRouteWitness, replica: LoroPageReplicaWitness) {
        self.document = document; self.route = route; self.replica = replica
    }
}

/// Closed rich-editor admission result. Rich and legacy-plain admission remain separate APIs.
public enum LoroNativeRichEditorEligibility: Sendable, Equatable {
    case editable(LoroNativeRichEditorState)
    case unauthenticated
    case checkpointResolutionRequired(LoroSemanticCheckpointResolution)
    case ineligible
}

/// Closed, value-only result of submitting a canonical native rich document.
public enum LoroNativeRichDocumentSubmissionDisposition: Sendable, Equatable {
    case submitted
    case submittedNeedsReload
    case noChange
    case unauthenticated
    case checkpointResolutionRequired(LoroSemanticCheckpointResolution)
    case ineligible
    case staleEditorState
    case invalidProposedDocument
    case invalidCommitMessage
}

extension LoroSemanticCheckpointResolution {
    init(_ checkpoint: LoroSemanticCheckpoint?) {
        guard let checkpoint else { self = .none; return }
        switch checkpoint.state {
        case .inFlight: self = .inFlight
        case .retainedRetry: self = .retainedRetry
        case .retainedConflict: self = .retainedConflict
        case .retainedRequestIdentity: self = .retainedRequestIdentity
        case .acceptedArchived: self = .none
        }
    }

    init(_ outcome: LoroSemanticCheckpointOutcome) {
        switch outcome {
        case .committed: self = .committed
        case .committedCacheInvalidated: self = .committed
        case .retainedRetry: self = .retainedRetry
        case .retainedConflict: self = .retainedConflict
        case .retainedRequestIdentity: self = .retainedRequestIdentity
        case .deniedAuthorizationOrSession: self = .deniedAuthorizationOrSession
        }
    }
}
