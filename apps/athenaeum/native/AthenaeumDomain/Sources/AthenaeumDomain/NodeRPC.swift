import Foundation

// Mirrors `packages/domain/src/rpc.ts` — wire schemas for `createNode`/`listNodes`/`getNode` plus
// the live `NodesChangedEvent` subscription payload. One Codable struct per TS `Schema.Class`,
// same field names (already camelCase on both sides).

public struct CreateNodeInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let title: String
    /// Optional caller-supplied id (see `rpc.ts`'s doc comment: the web app's daily-note resolver
    /// is the one caller that supplies it; every other caller omits it and gets a fresh
    /// server-minted id).
    public let id: EntityId?

    public init(workspaceId: EntityId, title: String, id: EntityId? = nil) {
        self.workspaceId = workspaceId
        self.title = title
        self.id = id
    }
}

public struct CreateNodeOutput: Codable, Hashable, Sendable {
    public let node: Node
    public init(node: Node) { self.node = node }
}

public struct ListNodesInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public init(workspaceId: EntityId) { self.workspaceId = workspaceId }
}

public struct ListNodesOutput: Codable, Hashable, Sendable {
    public let nodes: [Node]
    public init(nodes: [Node]) { self.nodes = nodes }
}

public struct GetNodeInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public init(workspaceId: EntityId, nodeId: EntityId) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
    }
}

public struct GetNodeOutput: Codable, Hashable, Sendable {
    public let node: Node
    public init(node: Node) { self.node = node }
}

/// Mirrors `rpc.ts`'s `NodesChangedEvent` — the payload pushed to a live `nodes` subscription
/// stub (Phase 0's `subscribeToNodes`, a Cap'n Web live-push method the HTTP-batch
/// `AthenaeumRPC` transport deliberately does not cover yet — see `docs/decisions.md`). Modeled
/// here regardless, since this package's job is mirroring the *wire schema*, independent of which
/// transport currently exercises it.
public struct NodesChangedEvent: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodes: [Node]
    public init(workspaceId: EntityId, nodes: [Node]) {
        self.workspaceId = workspaceId
        self.nodes = nodes
    }
}
