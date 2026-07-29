import Foundation

public struct VaultSearchResult: Codable, Hashable, Sendable, Identifiable {
  public var scopedNodeID: VaultScopedNodeID
  public var vaultName: String
  public var title: String
  public var excerpt: String
  public var score: Double
  public var id: String { scopedNodeID.id }

  public init(
    scopedNodeID: VaultScopedNodeID,
    vaultName: String,
    title: String,
    excerpt: String,
    score: Double
  ) {
    self.scopedNodeID = scopedNodeID
    self.vaultName = vaultName
    self.title = title
    self.excerpt = excerpt
    self.score = score
  }
}

/// Fans a text search out across downloaded vaults while preserving vault-scoped identities.
/// Query execution itself remains local to each vault's public SQLite graph surface.
public struct VaultSearch: Sendable {
  private let registry: VaultRegistry

  public init(registry: VaultRegistry) {
    self.registry = registry
  }

  public init() throws {
    registry = try VaultRegistry(path: VaultRegistry.defaultCatalogPath())
  }

  public func search(
    _ text: String,
    limit: Int = 50
  ) async throws -> [VaultSearchResult] {
    let expression = Self.matchExpression(text)
    guard !expression.isEmpty else { return [] }
    let boundedLimit = min(max(limit, 1), 200)
    let snapshot = try registry.snapshot()
    var results: [VaultSearchResult] = []

    for vault in snapshot.vaults where vault.isDownloaded {
      let repository = try LibraryRepository(path: registry.graphPath(for: vault.id))
      let queryResult = try repository.runGraphSQL(
        """
        SELECT node_id,
               title,
               snippet(graph_text_search, 2, '', '', ' … ', 18) AS excerpt,
               bm25(graph_text_search) AS score
        FROM graph_text_search
        WHERE graph_text_search MATCH :query
        ORDER BY score, title COLLATE NOCASE
        LIMIT \(boundedLimit)
        """,
        arguments: ["query": .text(expression)],
        limits: .init(maximumRows: boundedLimit)
      )
      for row in queryResult.rows {
        guard case .text(let nodeID) = queryResult.value(column: "node_id", in: row),
          case .text(let title) = queryResult.value(column: "title", in: row)
        else { continue }
        let excerpt: String
        if case .text(let value) = queryResult.value(column: "excerpt", in: row) {
          excerpt = value
        } else {
          excerpt = ""
        }
        let score: Double
        switch queryResult.value(column: "score", in: row) {
        case .real(let value): score = value
        case .integer(let value): score = Double(value)
        default: score = 0
        }
        results.append(
          .init(
            scopedNodeID: .init(vaultID: vault.id, nodeID: .init(rawValue: nodeID)),
            vaultName: vault.name,
            title: title,
            excerpt: excerpt,
            score: score
          )
        )
      }
    }

    return Array(results.sorted {
      if $0.score != $1.score { return $0.score < $1.score }
      if $0.vaultName != $1.vaultName {
        return $0.vaultName.localizedStandardCompare($1.vaultName) == .orderedAscending
      }
      return $0.title.localizedStandardCompare($1.title) == .orderedAscending
    }.prefix(boundedLimit))
  }

  private static func matchExpression(_ text: String) -> String {
    text
      .split(whereSeparator: { $0.isWhitespace })
      .prefix(12)
      .map { token in
        let escaped = token.replacingOccurrences(of: "\"", with: "\"\"")
        return "\"\(escaped)\""
      }
      .joined(separator: " AND ")
  }
}
