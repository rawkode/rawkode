import Foundation

// Mirrors `packages/domain/src/changes-message.ts` — the `changes` stream envelope (plan:
// "Acceptance rides the same changes-message stream, gaining createdNodes/addedFacts/addedEdges/
// noteEdits fields; mergeChanges/revertChanges promote/delete pending records exactly as
// multi-gadget.md §Q15 describes"). Each batch field is a lightweight summary record, not the full
// entity — see changes-message.ts's header comment for why.

/// Mirrors `changes-message.ts`'s `CreatedNodeSummary`: `{nodeId, title}`.
public struct CreatedNodeSummary: Codable, Hashable, Sendable {
    public let nodeId: EntityId
    public let title: String

    public init(nodeId: EntityId, title: String) {
        self.nodeId = nodeId
        self.title = title
    }
}

/// Mirrors `changes-message.ts`'s `AddedFactSummary`: `{factId, nodeId, predicateId}`.
public struct AddedFactSummary: Codable, Hashable, Sendable {
    public let factId: EntityId
    public let nodeId: EntityId
    public let predicateId: String

    public init(factId: EntityId, nodeId: EntityId, predicateId: String) {
        self.factId = factId
        self.nodeId = nodeId
        self.predicateId = predicateId
    }
}

/// Mirrors `changes-message.ts`'s `AddedEdgeSummary`: `{edgeId, relationDefinitionId,
/// sourceNodeId, targetNodeId}`.
public struct AddedEdgeSummary: Codable, Hashable, Sendable {
    public let edgeId: EntityId
    public let relationDefinitionId: EntityId
    public let sourceNodeId: EntityId
    public let targetNodeId: EntityId

    public init(edgeId: EntityId, relationDefinitionId: EntityId, sourceNodeId: EntityId, targetNodeId: EntityId) {
        self.edgeId = edgeId
        self.relationDefinitionId = relationDefinitionId
        self.sourceNodeId = sourceNodeId
        self.targetNodeId = targetNodeId
    }
}

/// Mirrors `changes-message.ts`'s `NoteEditSummary`: `{nodeId, headsHash}` — a note-body edit
/// accepted via the Automerge-fork mechanism (`ChatForkService`, not this file's `pending`-flag
/// batch fields — see changes-message.ts's doc comment).
public struct NoteEditSummary: Codable, Hashable, Sendable {
    public let nodeId: EntityId
    public let headsHash: String

    public init(nodeId: EntityId, headsHash: String) {
        self.nodeId = nodeId
        self.headsHash = headsHash
    }
}

/// Mirrors `changes-message.ts`'s `ChangesMessage`: `{chatId, sequence, createdNodes?,
/// addedFacts?, addedEdges?, noteEdits?}` — the `changes` stream envelope. All four batch fields
/// are independently optional (per §Q15's "a creation-only batch has an empty no-op update").
public struct ChangesMessage: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public let sequence: Int
    public let createdNodes: [CreatedNodeSummary]?
    public let addedFacts: [AddedFactSummary]?
    public let addedEdges: [AddedEdgeSummary]?
    public let noteEdits: [NoteEditSummary]?

    public init(
        chatId: EntityId,
        sequence: Int,
        createdNodes: [CreatedNodeSummary]? = nil,
        addedFacts: [AddedFactSummary]? = nil,
        addedEdges: [AddedEdgeSummary]? = nil,
        noteEdits: [NoteEditSummary]? = nil
    ) {
        self.chatId = chatId
        self.sequence = sequence
        self.createdNodes = createdNodes
        self.addedFacts = addedFacts
        self.addedEdges = addedEdges
        self.noteEdits = noteEdits
    }
}
