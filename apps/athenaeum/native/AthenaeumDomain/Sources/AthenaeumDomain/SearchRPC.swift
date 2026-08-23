import Foundation

/// Mirrors `packages/domain/src/search-rpc.ts`'s `SearchNodesInput` — `limit` optional, backend
/// clamps to its own hard cap regardless.
public struct SearchNodesInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let query: String
    public let limit: Int?

    public init(workspaceId: EntityId, query: String, limit: Int? = nil) {
        self.workspaceId = workspaceId
        self.query = query
        self.limit = limit
    }
}

/// Mirrors `search-rpc.ts`'s `SearchResultEntry` — one search hit: matching node's id/title plus a
/// short excerpt (empty string if the match was on `title` alone, no page body).
public struct SearchResultEntry: Codable, Hashable, Sendable {
    public let nodeId: EntityId
    public let title: String
    public let snippet: String

    public init(nodeId: EntityId, title: String, snippet: String) {
        self.nodeId = nodeId
        self.title = title
        self.snippet = snippet
    }
}

public struct SearchNodesOutput: Codable, Hashable, Sendable {
    public let results: [SearchResultEntry]
    public init(results: [SearchResultEntry]) { self.results = results }
}
