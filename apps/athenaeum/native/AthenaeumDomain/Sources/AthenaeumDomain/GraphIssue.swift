import Foundation

/// Mirrors `packages/domain/src/graph-issue.ts`'s `GraphIssueKind` literal union — currently
/// exactly one kind, kept as a closed enum (not a bare string) for the same reason the TS side
/// gives: adding a second kind later becomes a one-line, exhaustively-checked change everywhere
/// that switches over it.
public enum GraphIssueKind: String, Codable, Hashable, Sendable {
    case concurrentMaxOneEdgeConflict = "concurrent-max-one-edge-conflict"
}

/// Mirrors `graph-issue.ts`'s `GraphIssue` — the durable, queryable record of a detected
/// concurrent max-one-cardinality edge conflict (Evolution Rule #4: "preserve... and expose",
/// not "reject").
public struct GraphIssue: Codable, Hashable, Sendable {
    public let id: EntityId
    public let kind: GraphIssueKind
    public let relationDefinitionId: EntityId
    public let nodeId: EntityId
    public let conflictingEdgeIds: [EntityId]
    public let createdAt: IsoDateTimeString

    public init(
        id: EntityId,
        kind: GraphIssueKind,
        relationDefinitionId: EntityId,
        nodeId: EntityId,
        conflictingEdgeIds: [EntityId],
        createdAt: IsoDateTimeString
    ) {
        self.id = id
        self.kind = kind
        self.relationDefinitionId = relationDefinitionId
        self.nodeId = nodeId
        self.conflictingEdgeIds = conflictingEdgeIds
        self.createdAt = createdAt
    }
}
