import Foundation

// Mirrors `packages/domain/src/chat.ts` — the persisted workspace-storage chat entities (`Chat`,
// `ChatMessageRecord`), as opposed to `model-client.ts`'s ephemeral `ChatThread`/`ChatMessage`
// (see ToolCallRequest.swift's header comment and chat.ts's own extensive naming-collision note
// for why the two are deliberately distinct types with different shapes).

/// Mirrors `chat.ts`'s `Chat`: `{id, workspaceId, title, createdAt}` — a workspace-scoped agent chat
/// thread (plan: "Chats are workspace-scoped... one agent turn can create/link multiple notes and
/// entities at once").
public struct Chat: Codable, Hashable, Sendable {
    public let id: EntityId
    public let workspaceId: EntityId
    public let title: String
    public let createdAt: IsoDateTimeString

    public init(id: EntityId, workspaceId: EntityId, title: String, createdAt: IsoDateTimeString) {
        self.id = id
        self.workspaceId = workspaceId
        self.title = title
        self.createdAt = createdAt
    }
}

/// Mirrors `chat.ts`'s `ChatMessageRecord.role` literal union — a third `"tool"` value beyond the
/// usual `"user"|"assistant"`, since this is the durable, provider-agnostic log record (see
/// chat.ts's doc comment), not a wire shape shared with any one provider's API.
public enum ChatMessageRole: String, Codable, Hashable, Sendable {
    case user
    case assistant
    case tool
}

/// Mirrors `chat.ts`'s `ChatMessageRecord`: `{id, chatId, role, content, toolCalls?, sequence}` —
/// one persisted message in a `Chat`'s log, including `"tool"`-role rows (crash-recovery log
/// entries a normal chat UI may choose to collapse/hide — see `GetChatOutput`'s doc comment in
/// AgentEditRPC.swift).
public struct ChatMessageRecord: Codable, Hashable, Sendable {
    public let id: EntityId
    public let chatId: EntityId
    public let role: ChatMessageRole
    public let content: String
    public let toolCalls: [ToolCallRequest]?
    public let sequence: Int

    public init(
        id: EntityId,
        chatId: EntityId,
        role: ChatMessageRole,
        content: String,
        toolCalls: [ToolCallRequest]? = nil,
        sequence: Int
    ) {
        self.id = id
        self.chatId = chatId
        self.role = role
        self.content = content
        self.toolCalls = toolCalls
        self.sequence = sequence
    }
}
