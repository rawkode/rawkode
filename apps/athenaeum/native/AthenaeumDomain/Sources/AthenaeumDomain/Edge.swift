import Foundation

/// Mirrors `packages/domain/src/edge.ts`'s `Edge` — canonical, source-owned relationship
/// instances. Backlinks are a query (non-unique index target→edges), never a second stored
/// record (GraphDataModel.md Evolution Rule #3) — accordingly there is no `InverseEdge`/
/// `Backlink` type here either, matching the TS side exactly. `pending` (Phase 3 storage-schema
/// task) mirrors `Node.pending` (Node.swift) — an `Edge` an agent chat proposed via the `addEdge`
/// tool but the user hasn't accepted yet.
public struct Edge: Codable, Hashable, Sendable {
    public let id: EntityId
    public let relationDefinitionId: EntityId
    public let sourceNodeId: EntityId
    public let targetNodeId: EntityId
    public let pending: PendingMarker?

    public init(
        id: EntityId,
        relationDefinitionId: EntityId,
        sourceNodeId: EntityId,
        targetNodeId: EntityId,
        pending: PendingMarker? = nil
    ) {
        self.id = id
        self.relationDefinitionId = relationDefinitionId
        self.sourceNodeId = sourceNodeId
        self.targetNodeId = targetNodeId
        self.pending = pending
    }
}
