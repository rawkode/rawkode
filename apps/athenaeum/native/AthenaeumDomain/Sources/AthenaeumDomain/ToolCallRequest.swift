import Foundation

// Mirrors `packages/domain/src/model-client.ts`'s `ToolCallRequest` — deliberately narrow: this
// package does not mirror the rest of `model-client.ts` (`ChatThread`/`ChatMessage`/`ToolSpec`/
// `ModelClient`/the provider-shaped content-block union), since that surface is a backend-internal
// concern between `AgentEditService` and its `ModelClient` implementations — no native client code
// drives it directly (see Chat.swift's header comment for the same scoping note on
// `ChatMessageRecord`). `ToolCallRequest` itself is mirrored because `ChatMessageRecord.toolCalls`
// (Chat.swift) is an array of these, and that field is real, persisted, and returned over the wire
// by `getChat`/`sendChatMessage`.

/// Mirrors `model-client.ts`'s `ToolCallRequest`: `{id, name, input}` — one tool call the model
/// requested, as persisted in a `"assistant"`-role `ChatMessageRecord.toolCalls` entry.
public struct ToolCallRequest: Codable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let input: JSONValue

    public init(id: String, name: String, input: JSONValue) {
        self.id = id
        self.name = name
        self.input = input
    }
}
