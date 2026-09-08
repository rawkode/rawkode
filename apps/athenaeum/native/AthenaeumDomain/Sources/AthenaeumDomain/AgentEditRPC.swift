import Foundation

// Mirrors `packages/domain/src/agent-edit-rpc.ts` — wire schemas for `AgentEditService`'s RPC
// surface: `createChat`/`listChats`/`getChat`/`sendChatMessage`/`mergeChanges`/`revertChanges`/
// `listChatChanges`/`listPendingChanges`. Same one-`Schema.Class`-pair-per-method convention as
// NodeRPC.swift/GraphRPC.swift. `chatId` is `EntityId` throughout, matching `Chat.id`.

public struct CreateChatInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let title: String
    public init(workspaceId: EntityId, title: String) {
        self.workspaceId = workspaceId
        self.title = title
    }
}

public struct CreateChatOutput: Codable, Hashable, Sendable {
    public let chat: Chat
    public init(chat: Chat) { self.chat = chat }
}

public struct ListChatsInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public init(workspaceId: EntityId) { self.workspaceId = workspaceId }
}

public struct ListChatsOutput: Codable, Hashable, Sendable {
    public let chats: [Chat]
    public init(chats: [Chat]) { self.chats = chats }
}

public struct GetChatInput: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public init(chatId: EntityId) { self.chatId = chatId }
}

/// `messages` is this chat's full persisted log, in `sequence` order — including `"tool"`-role
/// rows (see ChatMessageRole in Chat.swift), which a normal chat UI may collapse/hide.
public struct GetChatOutput: Codable, Hashable, Sendable {
    public let chat: Chat
    public let messages: [ChatMessageRecord]
    public init(chat: Chat, messages: [ChatMessageRecord]) {
        self.chat = chat
        self.messages = messages
    }
}

/// One server-resolved, presentation-safe item in a coherent chat review snapshot. `lane` is the
/// authoritative discriminator for the independent structured and legacy-fork review lanes.
/// `nodeId` is structural action identity only (for legacy note-fork accept/revert); clients must
/// never render it or include it in accessibility/error text.
public struct ChatReviewItem: Codable, Hashable, Sendable {
    public let lane: String
    public let kind: String
    public let sequence: Int
    public let label: String
    public let stamped: Bool
    public let targetAvailable: Bool
    public let actionable: Bool
    public let nodeId: EntityId?
    public let forkPreviewLines: [String]?
    public let forkPreviewTruncated: Bool?
    public let previewDigest: String?

    public init(
        lane: String,
        kind: String,
        sequence: Int,
        label: String,
        stamped: Bool, targetAvailable: Bool, actionable: Bool, nodeId: EntityId? = nil,
        forkPreviewLines: [String]? = nil, forkPreviewTruncated: Bool? = nil, previewDigest: String? = nil
    ) {
        self.lane = lane
        self.kind = kind
        self.sequence = sequence
        self.label = label
        self.stamped = stamped; self.targetAvailable = targetAvailable; self.actionable = actionable
        self.nodeId = nodeId
        self.forkPreviewLines = forkPreviewLines; self.forkPreviewTruncated = forkPreviewTruncated; self.previewDigest = previewDigest
    }
}
public struct ChatReviewForkLaneStatus: Codable, Hashable, Sendable {
    public let total: Int
    public let shown: Int
    public let truncated: Bool
    public let unavailable: Int
}

/// Coherent transcript + server-owned review projection. Witnesses are opaque SHA-256 custody
/// tokens: they are compared as versions and never shown to the user.
public struct GetChatReviewInput: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public init(chatId: EntityId) { self.chatId = chatId }
}

public struct GetChatReviewOutput: Codable, Hashable, Sendable {
    public let chat: Chat
    public let messages: [ChatMessageRecord]
    public let items: [ChatReviewItem]
    public let witness: String
    public let noteForkWitness: String
    public let structuredForks: ChatReviewForkLaneStatus
    public let legacyForks: ChatReviewForkLaneStatus

    public init(
        chat: Chat,
        messages: [ChatMessageRecord],
        items: [ChatReviewItem],
        witness: String,
        noteForkWitness: String, structuredForks: ChatReviewForkLaneStatus, legacyForks: ChatReviewForkLaneStatus
    ) {
        self.chat = chat
        self.messages = messages
        self.items = items
        self.witness = witness
        self.noteForkWitness = noteForkWitness
        self.structuredForks = structuredForks; self.legacyForks = legacyForks
    }
}
public struct DecideChatReviewInput: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public let operation: String
    public let sequenceBoundary: Int
    public let expectedWitness: String
    public let requestId: String
    public let message: String
    public let provenance: String
}

public struct DecideChatReviewOutput: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public let operation: String
    public let sequenceBoundary: Int
    public let witness: String
}

/// Runs one full agent turn: `text` is the user's new message; prior history is loaded
/// server-side from the chat's own persisted log.
public struct SendChatMessageInput: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public let text: String
    public init(chatId: EntityId, text: String) {
        self.chatId = chatId
        self.text = text
    }
}

/// `messages` is only this call's own delta (the new user message, any `"tool"`-role log rows,
/// and the final `"assistant"` reply) — not the chat's whole history. `changesSequences` is every
/// `ChangesMessage.sequence` this turn produced, in order.
public struct SendChatMessageOutput: Codable, Hashable, Sendable {
    public let messages: [ChatMessageRecord]
    public let changesSequences: [Int]
    public init(messages: [ChatMessageRecord], changesSequences: [Int]) {
        self.messages = messages
        self.changesSequences = changesSequences
    }
}

/// Promotes (clears `pending` on) every pending node/fact/edge this chat produced with
/// `sequence <= mergeThrough`, per `multi-gadget.md` §Q15.
public struct MergeChangesInput: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public let mergeThrough: Int
    public init(chatId: EntityId, mergeThrough: Int) {
        self.chatId = chatId
        self.mergeThrough = mergeThrough
    }
}

public struct MergeChangesOutput: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public let mergeThrough: Int
    public init(chatId: EntityId, mergeThrough: Int) {
        self.chatId = chatId
        self.mergeThrough = mergeThrough
    }
}

/// Deletes every pending node/fact/edge this chat produced with `sequence >= revertFrom`.
public struct RevertChangesInput: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public let revertFrom: Int
    public init(chatId: EntityId, revertFrom: Int) {
        self.chatId = chatId
        self.revertFrom = revertFrom
    }
}

public struct RevertChangesOutput: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public let revertFrom: Int
    public init(chatId: EntityId, revertFrom: Int) {
        self.chatId = chatId
        self.revertFrom = revertFrom
    }
}

public struct ListChatChangesInput: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public init(chatId: EntityId) { self.chatId = chatId }
}

/// The full `changes` *audit trail* — every `ChangesMessage` batch this chat has ever produced,
/// regardless of whether `mergeChanges`/`revertChanges` has since promoted or deleted the pending
/// records it summarizes. See `ListPendingChangesOutput` below for "what is still pending now."
public struct ListChatChangesOutput: Codable, Hashable, Sendable {
    public let changes: [ChangesMessage]
    public init(changes: [ChangesMessage]) { self.changes = changes }
}

public struct ListPendingChangesInput: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public init(chatId: EntityId) { self.chatId = chatId }
}

/// The live, authoritative answer to "what does this chat currently have pending" — every
/// `Node`/`Fact`/`Edge` this chat has proposed whose `pending` marker is still set. This is the
/// data source the accept/revert UI (`PendingChangesView`) actually reads — see
/// `agent-edit-rpc.ts`'s `ListPendingChangesOutput` doc comment for why `listChatChanges`'s
/// permanent audit trail is the wrong source for that question.
public struct ListPendingChangesOutput: Codable, Hashable, Sendable {
    public let nodes: [Node]
    public let facts: [Fact]
    public let edges: [Edge]
    public init(nodes: [Node], facts: [Fact], edges: [Edge]) {
        self.nodes = nodes
        self.facts = facts
        self.edges = edges
    }
}
