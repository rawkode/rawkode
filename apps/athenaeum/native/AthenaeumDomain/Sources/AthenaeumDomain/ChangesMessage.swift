import Foundation

private enum ChangesMessageValidationError: Error {
    case emptyTitle
    case nonPositiveVersion
}

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

/// Mirrors `changes-message.ts`'s `CreatedAppSummary`: `{appId, title}`.
public struct CreatedAppSummary: Codable, Hashable, Sendable {
    public let appId: EntityId
    public let title: String

    public init(appId: EntityId, title: String) throws {
        guard !title.isEmpty else {
            throw ChangesMessageValidationError.emptyTitle
        }
        self.appId = appId
        self.title = title
    }

    private enum CodingKeys: String, CodingKey { case appId, title }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            appId: container.decode(EntityId.self, forKey: .appId),
            title: container.decode(String.self, forKey: .title)
        )
    }
}

/// Mirrors `app.ts`'s `AppCodeKind = Schema.Literal("client", "server")`.
public enum AppCodeKind: String, Codable, Hashable, Sendable {
    case client
    case server
}

/// Mirrors `changes-message.ts`'s `UpdatedAppCodeSummary`: `{appId, kind, version}`.
public struct UpdatedAppCodeSummary: Codable, Hashable, Sendable {
    public let appId: EntityId
    public let kind: AppCodeKind
    public let version: Int

    public init(appId: EntityId, kind: AppCodeKind, version: Int) throws {
        guard version > 0 else {
            throw ChangesMessageValidationError.nonPositiveVersion
        }
        self.appId = appId
        self.kind = kind
        self.version = version
    }

    private enum CodingKeys: String, CodingKey { case appId, kind, version }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            appId: container.decode(EntityId.self, forKey: .appId),
            kind: container.decode(AppCodeKind.self, forKey: .kind),
            version: container.decode(Int.self, forKey: .version)
        )
    }
}

/// Mirrors `changes-message.ts`'s `ChangesMessage`: `{chatId, sequence, createdNodes?,
/// addedFacts?, addedEdges?, noteEdits?}` — the `changes` stream envelope. All four batch fields
/// are independently optional (per §Q15's "a creation-only batch has an empty no-op update"),
/// including the app-library extensions `createdApps` and `updatedAppCode`.
public struct ChangesMessage: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public let sequence: Int
    public let createdNodes: [CreatedNodeSummary]?
    public let addedFacts: [AddedFactSummary]?
    public let addedEdges: [AddedEdgeSummary]?
    public let noteEdits: [NoteEditSummary]?
    public let createdApps: [CreatedAppSummary]?
    public let updatedAppCode: [UpdatedAppCodeSummary]?

    public init(
        chatId: EntityId,
        sequence: Int,
        createdNodes: [CreatedNodeSummary]? = nil,
        addedFacts: [AddedFactSummary]? = nil,
        addedEdges: [AddedEdgeSummary]? = nil,
        noteEdits: [NoteEditSummary]? = nil,
        createdApps: [CreatedAppSummary]? = nil,
        updatedAppCode: [UpdatedAppCodeSummary]? = nil
    ) {
        self.chatId = chatId
        self.sequence = sequence
        self.createdNodes = createdNodes
        self.addedFacts = addedFacts
        self.addedEdges = addedEdges
        self.noteEdits = noteEdits
        self.createdApps = createdApps
        self.updatedAppCode = updatedAppCode
    }
}
