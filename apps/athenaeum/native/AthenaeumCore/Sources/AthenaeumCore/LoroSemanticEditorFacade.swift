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

    /// Produces another presentation-only value over the same immutable admission witnesses.
    /// This lets a native host render its local draft without receiving any Core-private Loro
    /// state or becoming able to alter the base used for submission.
    public func replacingDocument(_ document: LoroNativeRichDocumentV1) -> Self {
        .init(document: document, route: route, replica: replica)
    }
}

/// A typed, idempotent request to flip one native checklist item. The structural ordinals and
/// expected value are stale-context witnesses; `commandID` is the durable mutation/request
/// identity retained across uncertain transport retries.
public struct LoroNativeRichTaskItemToggleCommand: Sendable, Equatable, Identifiable {
    public let commandID: UUID
    public let editorGeneration: Int
    public let taskListIndex: Int
    public let itemIndex: Int
    public let expectedItem: LoroCanonicalSemanticValueV1.TaskItem

    public var id: UUID { commandID }

    public init(
        commandID: UUID = UUID(),
        editorGeneration: Int,
        taskListIndex: Int,
        itemIndex: Int,
        expectedItem: LoroCanonicalSemanticValueV1.TaskItem
    ) {
        self.commandID = commandID
        self.editorGeneration = editorGeneration
        self.taskListIndex = taskListIndex
        self.itemIndex = itemIndex
        self.expectedItem = expectedItem
    }
}

/// A typed, idempotent request to add one empty checklist item after a top-level paragraph or
/// heading. `expectedBlock` and the collapsed scalar offset fence the request to the editor
/// snapshot that captured it; `commandID` is retained as the durable mutation identity.
public struct LoroNativeRichTaskListInsertionCommand: Sendable, Equatable, Identifiable {
    public let commandID: UUID
    public let editorGeneration: Int
    public let topLevelBlockIndex: Int
    public let expectedBlock: LoroCanonicalSemanticValueV1.Block
    public let collapsedScalarOffset: Int

    public var id: UUID { commandID }

    public init(
        commandID: UUID = UUID(),
        editorGeneration: Int,
        topLevelBlockIndex: Int,
        expectedBlock: LoroCanonicalSemanticValueV1.Block,
        collapsedScalarOffset: Int
    ) {
        self.commandID = commandID
        self.editorGeneration = editorGeneration
        self.topLevelBlockIndex = topLevelBlockIndex
        self.expectedBlock = expectedBlock
        self.collapsedScalarOffset = collapsedScalarOffset
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

public struct LoroNativeRichTaskListInsertionAcknowledgement: Sendable, Equatable {
    public let commandID: UUID
    public let document: LoroNativeRichDocumentV1
    /// The acknowledged structural target is explicit so adapters do not infer focus from a
    /// flattened string after a response race.
    public let taskListIndex: Int
    public let itemIndex: Int
    /// Absolute Unicode-scalar caret location in the acknowledged document, inside the new item.
    public let postInsertionScalarOffset: Int

    public init(
        commandID: UUID,
        document: LoroNativeRichDocumentV1,
        taskListIndex: Int = -1,
        itemIndex: Int = -1,
        postInsertionScalarOffset: Int = -1
    ) {
        self.commandID = commandID
        self.document = document
        self.taskListIndex = taskListIndex
        self.itemIndex = itemIndex
        self.postInsertionScalarOffset = postInsertionScalarOffset
    }

    /// Builds an acknowledgement only for the exact empty item produced by the insertion
    /// command. Source runs are a witness, never content to copy into the new task.
    public init?(command: LoroNativeRichTaskListInsertionCommand, document: LoroNativeRichDocumentV1) {
        guard command.topLevelBlockIndex >= 0,
              command.topLevelBlockIndex + 1 < document.semantic.blocks.count,
              document.semantic.blocks[command.topLevelBlockIndex] == command.expectedBlock,
              case let .taskList(items) = document.semantic.blocks[command.topLevelBlockIndex + 1],
              items.count == 1,
              items[0].checked == false,
              items[0].runs.isEmpty
        else { return nil }

        switch command.expectedBlock {
        case .paragraph, .heading:
            break
        case .taskList:
            return nil
        }

        func flattenedLength(of block: LoroCanonicalSemanticValueV1.Block) -> Int {
            switch block {
            case let .paragraph(runs), let .heading(_, runs):
                return runs.reduce(0) { $0 + $1.text.unicodeScalars.count }
            case let .taskList(items):
                return items.reduce(0) { total, item in
                    total + item.runs.reduce(0) { $0 + $1.text.unicodeScalars.count }
                } + max(0, items.count - 1)
            }
        }

        let blockStart = document.semantic.blocks
            .prefix(command.topLevelBlockIndex)
            .reduce(0) { $0 + flattenedLength(of: $1) + 1 }
        let sourceLength = flattenedLength(of: command.expectedBlock)
        self.init(
            commandID: command.commandID,
            document: document,
            taskListIndex: command.topLevelBlockIndex + 1,
            itemIndex: 0,
            postInsertionScalarOffset: blockStart + sourceLength + 1
        )
    }
}

/// A terminal, command-ID-keyed outcome for a checklist insertion that cannot be adopted by the
/// native adapter. Stale cancellations are ignored; a different job must receive a new UUID.
public enum LoroNativeRichTaskListInsertionCancellationReason: String, Sendable, Equatable {
    case rejected
    case stale
    case unauthorized
    case conflict
    case transportFailure
}

public struct LoroNativeRichTaskListInsertionCancellation: Sendable, Equatable {
    public let commandID: UUID
    public let reason: LoroNativeRichTaskListInsertionCancellationReason

    public init(commandID: UUID, reason: LoroNativeRichTaskListInsertionCancellationReason) {
        self.commandID = commandID
        self.reason = reason
    }
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
