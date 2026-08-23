import Foundation

/// Mirrors `packages/domain/src/node.ts`'s `PendingMarker` — the reusable `{chatId, sequence?}`
/// marker every agent-proposed `Node`/`Fact`/`Edge` carries while unaccepted (plan §"Agent-native
/// editing & gatekeeper integrations": "Every agent-proposed mutation is a pending record...
/// mirroring `GadgetRecord.pending` exactly"). `sequence` absent means "unstamped" — see node.ts's
/// doc comment on `PendingMarker` for the full crash-recovery meaning of that distinction; this
/// Swift mirror only needs to round-trip the field, not reimplement the recovery logic itself.
public struct PendingMarker: Codable, Hashable, Sendable {
    public let chatId: EntityId
    public let sequence: Int?

    public init(chatId: EntityId, sequence: Int? = nil) {
        self.chatId = chatId
        self.sequence = sequence
    }
}

/// Mirrors `packages/domain/src/node.ts`'s `Node` — the graph-vertex entity:
/// `{id, workspaceId, title, createdAt, pending?}`. Field names match the TS `Schema.Class`'s field
/// names exactly (both already camelCase), so the default synthesized `Codable` conformance
/// already produces matching JSON keys — no `CodingKeys` needed. `pending` (added by the Phase 3
/// storage-schema task) marks a node an agent chat proposed but the user hasn't accepted yet — see
/// `PendingMarker`'s doc comment above.
public struct Node: Codable, Hashable, Sendable {
    public let id: EntityId
    public let workspaceId: EntityId
    public let title: String
    public let createdAt: IsoDateTimeString
    public let pending: PendingMarker?

    public init(
        id: EntityId,
        workspaceId: EntityId,
        title: String,
        createdAt: IsoDateTimeString,
        pending: PendingMarker? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.title = title
        self.createdAt = createdAt
        self.pending = pending
    }
}
