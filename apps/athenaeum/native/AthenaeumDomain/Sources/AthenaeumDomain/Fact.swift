import Foundation

/// Mirrors `packages/domain/src/fact.ts`'s `Fact` — a single typed `(nodeId, predicateId, value)`
/// assertion. `value` uses the shared `JSONValue` recursive union (see JSONValue.swift), matching
/// the TS side's identical reasoning for not using an untyped passthrough. `pending` (Phase 3
/// storage-schema task) mirrors `Node.pending` (Node.swift) — a `Fact` an agent chat proposed via
/// the `addFact` tool but the user hasn't accepted yet.
public struct Fact: Codable, Hashable, Sendable {
    public let id: EntityId
    public let nodeId: EntityId
    public let predicateId: String
    public let value: JSONValue
    public let pending: PendingMarker?

    public init(
        id: EntityId,
        nodeId: EntityId,
        predicateId: String,
        value: JSONValue,
        pending: PendingMarker? = nil
    ) {
        self.id = id
        self.nodeId = nodeId
        self.predicateId = predicateId
        self.value = value
        self.pending = pending
    }
}
