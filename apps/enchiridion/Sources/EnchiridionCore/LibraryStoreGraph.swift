import Foundation

extension LibraryStore {
  public func graphRelationDefinitions() async throws -> [RelationDefinition] {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    return try await repository.relationDefinitions()
  }

  public func saveGraphRelationDefinition(_ definition: RelationDefinition) async throws {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    try await repository.saveRelationDefinition(definition)
    await reload(policy: .refreshOnly)
  }

  public func deleteGraphRelationDefinition(_ id: RelationID) async throws {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    try await repository.deleteRelationDefinition(id)
    await reload(policy: .refreshOnly)
  }

  public func graphOutgoingEdges(from nodeID: NodeID) async throws -> [KnowledgeEdge] {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    return try await repository.outgoingEdges(from: nodeID)
  }

  public func graphBacklinks(to nodeID: NodeID) async throws -> [GraphBacklink] {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    return try await repository.graphBacklinks(to: nodeID)
  }

  public func graphIssues() async throws -> [GraphIssue] {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    return try await repository.graphIssues()
  }

  @discardableResult
  public func createGraphEdge(
    relationID: RelationID,
    from sourceID: NodeID,
    to targetID: NodeID
  ) async throws -> KnowledgeEdge {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    let edge = try await repository.createEdge(
      relationID: relationID,
      from: sourceID,
      to: targetID
    )
    await reload(policy: .refreshOnly)
    return edge
  }

  public func removeGraphEdge(_ edgeID: EdgeID) async throws {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    try await repository.removeEdge(edgeID)
    await reload(policy: .refreshOnly)
  }

  public func resolveGraphCardinalityConflict(
    relationID: RelationID,
    keeping edgeID: EdgeID
  ) async throws {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    try await repository.resolveCardinalityConflict(relationID: relationID, keeping: edgeID)
    await reload(policy: .refreshOnly)
  }

  public func runGraphSQL(
    _ sql: String,
    arguments: [String: GraphSQLValue] = [:]
  ) throws -> GraphQueryResult {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    return try repository.runGraphSQL(sql, arguments: arguments)
  }

  public func runGraphQuery(_ definition: GraphQueryDefinition) throws -> GraphQueryResult {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    return try repository.runGraphQuery(definition)
  }

  public func savedGraphQueries() async throws -> [SavedGraphQuery] {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    return try await repository.savedGraphQueries()
  }

  public func runGraphQuery(_ query: SavedGraphQuery) throws -> GraphQueryResult {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    return try repository.runGraphQuery(query)
  }

  public func saveGraphQuery(_ query: SavedGraphQuery) async throws {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    try await repository.saveGraphQuery(query)
  }

  public func deleteGraphQuery(_ id: GraphQueryID) async throws {
    guard let repository else {
      throw LibraryRepositoryError.databaseUnavailable(startupError ?? "The vault is unavailable.")
    }
    try await repository.deleteGraphQuery(id)
  }
}
