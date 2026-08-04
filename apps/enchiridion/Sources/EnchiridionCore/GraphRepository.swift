import Foundation
import GRDB

public struct RelationDefinitionCloudRecord: Sendable {
  public var definition: RelationDefinition
  public var modifiedAt: Date
  public var dirtyGeneration: Int64
  public var cloudRecord: Data?
}

extension LibraryRepository {
  public func relationDefinitions() throws -> [RelationDefinition] {
    return try database.read { db in
      try Row.fetchAll(
        db,
        sql: """
          SELECT definition_json
          FROM _graph_relation_definitions
          WHERE is_deleted = 0
          ORDER BY is_system DESC, forward_name COLLATE NOCASE
          """
      ).compactMap(Self.decodeRelation)
    }
  }

  public func saveRelationDefinition(
    _ definition: RelationDefinition,
    now: Date = Date()
  ) throws {
    let forward = definition.forwardName.trimmingCharacters(in: .whitespacesAndNewlines)
    let inverse = definition.inverseName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !forward.isEmpty, !inverse.isEmpty else { throw GraphModelError.invalidEndpoint }
    return try database.write { db in
      if let existing = try Row.fetchOne(
        db,
        sql: "SELECT definition_json FROM _graph_relation_definitions WHERE id = ?",
        arguments: [definition.id.rawValue]
      ).flatMap(Self.decodeRelation), existing.isSystem, existing != definition {
        throw GraphModelError.immutableSystemDefinition
      }
      let availableTags = Set(try String.fetchAll(
        db,
        sql: "SELECT id FROM supertag_schemas WHERE deleted = 0"
      ).map(TagID.init(rawValue:)))
      guard Set(definition.sourceTagIDs).isSubset(of: availableTags),
        Set(definition.targetTagIDs).isSubset(of: availableTags)
      else { throw GraphModelError.invalidEndpoint }
      var normalized = definition
      normalized.forwardName = forward
      normalized.inverseName = inverse
      try GraphDatabaseSchema.saveRelation(normalized, in: db, modifiedAt: now)
      try GraphProjectionStore.refreshIssues(for: [definition.id], in: db)
    }
  }

  public func deleteRelationDefinition(
    _ id: RelationID,
    now: Date = Date()
  ) throws {
    return try database.write { db in
      guard var existing = try Row.fetchOne(
        db,
        sql: "SELECT definition_json FROM _graph_relation_definitions WHERE id = ?",
        arguments: [id.rawValue]
      ).flatMap(Self.decodeRelation) else { throw GraphModelError.unknownRelation(id) }
      guard !existing.isSystem else { throw GraphModelError.immutableSystemDefinition }
      existing.isDeleted = true
      try GraphDatabaseSchema.saveRelation(existing, in: db, modifiedAt: now)
      try GraphProjectionStore.refreshIssues(for: [id], in: db)
    }
  }

  @discardableResult
  public func createEdge(
    relationID: RelationID,
    from sourceID: NodeID,
    to targetID: NodeID,
    origin: GraphEdgeOrigin = .user,
    now: Date = Date()
  ) throws -> KnowledgeEdge {
    try database.write { db in
      try Self.createEdge(
        in: db,
        relationID: relationID,
        from: sourceID,
        to: targetID,
        origin: origin,
        now: now
      )
    }
  }

  static func createEdge(
    in db: Database,
    relationID: RelationID,
    from sourceID: NodeID,
    to targetID: NodeID,
    origin: GraphEdgeOrigin = .user,
    now: Date = Date()
  ) throws -> KnowledgeEdge {
    guard let relation = try Row.fetchOne(
      db,
      sql: "SELECT definition_json FROM _graph_relation_definitions WHERE id = ? AND is_deleted = 0",
      arguments: [relationID.rawValue]
    ).flatMap(Self.decodeRelation) else { throw GraphModelError.unknownRelation(relationID) }
    guard let source = try Self.fetchPage(db, id: sourceID), source.deletedAt == nil,
      let target = try Self.fetchPage(db, id: targetID), target.deletedAt == nil
    else { throw GraphModelError.invalidEndpoint }
    let sourceTags = try Self.effectiveTagIDs(db, nodeID: sourceID)
    let targetTags = try Self.effectiveTagIDs(db, nodeID: targetID)
    guard relation.sourceTagIDs.isEmpty || !sourceTags.isDisjoint(with: relation.sourceTagIDs),
      relation.targetTagIDs.isEmpty || !targetTags.isDisjoint(with: relation.targetTagIDs)
    else { throw GraphModelError.invalidEndpoint }

    if relation.cardinality.targetsPerSource == .one,
      try Int.fetchOne(
        db,
        sql: "SELECT COUNT(DISTINCT target_node_id) FROM _graph_edges WHERE relation_id = ? AND source_node_id = ? AND target_node_id <> ?",
        arguments: [relationID.rawValue, sourceID.rawValue, targetID.rawValue]
      ) ?? 0 > 0
    {
      throw GraphModelError.cardinalityViolation(relationID)
    }
    if relation.cardinality.sourcesPerTarget == .one,
      try Int.fetchOne(
        db,
        sql: "SELECT COUNT(DISTINCT source_node_id) FROM _graph_edges WHERE relation_id = ? AND target_node_id = ? AND source_node_id <> ?",
        arguments: [relationID.rawValue, targetID.rawValue, sourceID.rawValue]
      ) ?? 0 > 0
    {
      throw GraphModelError.cardinalityViolation(relationID)
    }

    if let existing = try Row.fetchOne(
      db,
      sql: "SELECT * FROM _graph_edges WHERE relation_id = ? AND source_node_id = ? AND target_node_id = ?",
      arguments: [relationID.rawValue, sourceID.rawValue, targetID.rawValue]
    ).flatMap(Self.decodeEdge) {
      return existing
    }

    let edge = KnowledgeEdge(
      relationID: relationID,
      sourceNodeID: sourceID,
      targetNodeID: targetID,
      origin: origin,
      createdAt: now
    )
    let mutation = try PageDocument.upsertEdge(edge, in: source.document)
    let updated = Self.updatedPage(source, with: mutation, now: now)
    try Self.writePage(db, page: updated, cloudDirty: origin != .provider)
    return edge
  }

  public func relationshipAuthoringIntent(
    relationID: RelationID,
    presentedSourceID: PageID,
    direction: GraphRelationshipDirection
  ) throws -> GraphRelationshipAuthoringIntent {
    try database.read { db in
      guard let relation = try Row.fetchOne(
        db,
        sql: "SELECT definition_json FROM _graph_relation_definitions WHERE id = ? AND is_deleted = 0",
        arguments: [relationID.rawValue]
      ).flatMap(Self.decodeRelation) else { throw GraphModelError.unknownRelation(relationID) }
      let presentedTags = try Self.effectiveTagIDs(db, nodeID: presentedSourceID)
      let requiredTags = direction == .forward ? relation.sourceTagIDs : relation.targetTagIDs
      guard requiredTags.isEmpty || !presentedTags.isDisjoint(with: requiredTags) else {
        throw GraphModelError.invalidEndpoint
      }
      let targetRequirements = direction == .forward ? relation.targetTagIDs : relation.sourceTagIDs
      let definitions = try Row.fetchAll(
        db,
        sql: "SELECT definition_json FROM supertag_schemas WHERE deleted = 0"
      ).compactMap { row -> SupertagDefinition? in
        guard let data: Data = row["definition_json"] else { return nil }
        return try? JSONDecoder.enchiridion.decode(SupertagDefinition.self, from: data)
      }
      let compatible = definitions.filter { definition in
        let effective = SupertagInheritance.effectiveTagIDs(
          for: [definition.id], definitions: definitions
        )
        return targetRequirements.isEmpty || !effective.isDisjoint(with: targetRequirements)
      }.map(\.id).sorted { $0.rawValue < $1.rawValue }
      return GraphRelationshipAuthoringIntent(
        relation: relation,
        presentedSourceID: presentedSourceID,
        direction: direction,
        compatibleTargetTypeIDs: compatible
      )
    }
  }

  @discardableResult
  public func removeEdge(_ edgeID: EdgeID, now: Date = Date()) throws -> NodeID {
    try database.write { db in
      guard let edge = try Row.fetchOne(
        db,
        sql: "SELECT * FROM _graph_edges WHERE edge_id = ?",
        arguments: [edgeID.rawValue]
      ).flatMap(Self.decodeEdge),
        let source = try Self.fetchPage(db, id: edge.sourceNodeID)
      else { throw GraphModelError.invalidEndpoint }
      let updated = try Self.removingEdge(edge, from: source, now: now)
      try Self.writePage(db, page: updated, cloudDirty: true)
      return edge.sourceNodeID
    }
  }

  public func outgoingEdges(from nodeID: NodeID) throws -> [KnowledgeEdge] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: "SELECT * FROM _graph_edges WHERE source_node_id = ? ORDER BY created_at, edge_id",
        arguments: [nodeID.rawValue]
      ).compactMap(Self.decodeEdge)
    }
  }

  public func graphBacklinks(to nodeID: NodeID) throws -> [GraphBacklink] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: """
          SELECT edge.*,
                 relation.definition_json,
                 source.title AS source_title
          FROM _graph_edges edge
          JOIN _graph_relation_definitions relation ON relation.id = edge.relation_id
          JOIN pages source ON source.id = edge.source_node_id
          WHERE edge.target_node_id = ?
            AND source.deleted_at IS NULL
            AND relation.is_deleted = 0
          ORDER BY source.modified_at DESC, edge.edge_id
          """,
        arguments: [nodeID.rawValue]
      ).compactMap { row in
        guard let edge = Self.decodeEdge(row),
          let relation = Self.decodeRelation(row),
          let title: String = row["source_title"]
        else { return nil }
        return GraphBacklink(edge: edge, relation: relation, sourceTitle: title)
      }
    }
  }

  public func graphIssues() throws -> [GraphIssue] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: "SELECT * FROM _graph_issues ORDER BY created_at, issue_id"
      ).compactMap(Self.decodeIssue)
    }
  }

  public func dirtyRelationDefinitions() throws -> [RelationDefinitionCloudRecord] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: """
          SELECT * FROM _graph_relation_definitions
          WHERE cloud_dirty = 1 AND is_system = 0 AND id NOT LIKE 'dev.rawkode.enchiridion.%'
          ORDER BY modified_at, id
          """
      ).compactMap(Self.decodeRelationCloudRecord)
    }
  }

  public func relationDefinitionCloudRecord(
    id: RelationID
  ) throws -> RelationDefinitionCloudRecord? {
    guard !ModuleNamespace.isCompiledIdentifier(id.rawValue) else { return nil }
    return try database.read { db in
      try Row.fetchOne(
        db,
        sql: "SELECT * FROM _graph_relation_definitions WHERE id = ? AND is_system = 0",
        arguments: [id.rawValue]
      ).flatMap(Self.decodeRelationCloudRecord)
    }
  }

  @discardableResult
  public func markRelationDefinitionCloudSaved(
    id: RelationID,
    sentGeneration: Int64,
    systemFields: Data
  ) throws -> Bool {
    guard !ModuleNamespace.isCompiledIdentifier(id.rawValue) else { return false }
    return try database.write { db in
      try db.execute(
        sql: """
          UPDATE _graph_relation_definitions
          SET cloud_record = ?,
              cloud_synced_generation = MAX(cloud_synced_generation, ?),
              cloud_dirty = CASE WHEN dirty_generation <= ? THEN 0 ELSE 1 END
          WHERE id = ? AND is_system = 0
          """,
        arguments: [systemFields, sentGeneration, sentGeneration, id.rawValue]
      )
      return try Bool.fetchOne(
        db,
        sql: "SELECT cloud_dirty FROM _graph_relation_definitions WHERE id = ?",
        arguments: [id.rawValue]
      ) ?? false
    }
  }

  @discardableResult
  public func mergeCloudRelationDefinition(
    id: RelationID,
    definition: RelationDefinition,
    isDeleted: Bool,
    modifiedAt: Date,
    dirtyGeneration: Int64,
    systemFields: Data
  ) throws -> Bool {
    guard !ModuleNamespace.isCompiledIdentifier(id.rawValue) else { return false }
    return try database.write { db in
      if let row = try Row.fetchOne(
        db,
        sql: "SELECT is_system, cloud_dirty FROM _graph_relation_definitions WHERE id = ?",
        arguments: [id.rawValue]
      ) {
        let isSystem: Bool = row["is_system"] ?? false
        guard !isSystem else { throw GraphModelError.immutableSystemDefinition }
        let isDirty: Bool = row["cloud_dirty"] ?? false
        if isDirty {
          try db.execute(
            sql: "UPDATE _graph_relation_definitions SET cloud_record = ? WHERE id = ?",
            arguments: [systemFields, id.rawValue]
          )
          return true
        }
      }

      var normalized = definition
      normalized.id = id
      normalized.isSystem = false
      normalized.isDeleted = isDeleted
      try Self.writeCloudRelationDefinition(
        normalized,
        modifiedAt: modifiedAt,
        dirtyGeneration: dirtyGeneration,
        systemFields: systemFields,
        in: db
      )
      try GraphProjectionStore.refreshIssues(for: [id], in: db)
      return false
    }
  }

  @discardableResult
  public func applyCloudRelationDefinitionRecordDeletion(id: RelationID) throws -> Bool {
    guard !ModuleNamespace.isCompiledIdentifier(id.rawValue) else { return false }
    return try database.write { db in
      guard let row = try Row.fetchOne(
        db,
        sql: "SELECT definition_json,is_system,cloud_dirty FROM _graph_relation_definitions WHERE id = ?",
        arguments: [id.rawValue]
      ), !(row["is_system"] as Bool? ?? false)
      else { return false }
      if row["cloud_dirty"] as Bool? ?? false {
        try db.execute(
          sql: "UPDATE _graph_relation_definitions SET cloud_record = NULL WHERE id = ?",
          arguments: [id.rawValue]
        )
        return true
      }
      guard let data: Data = row["definition_json"],
        var definition = try? JSONDecoder.enchiridion.decode(RelationDefinition.self, from: data)
      else { throw LibraryRepositoryError.invalidRecord }
      definition.isDeleted = true
      try db.execute(
        sql: """
          UPDATE _graph_relation_definitions
          SET is_deleted = 1, definition_json = ?, cloud_record = NULL,
              cloud_dirty = 0, cloud_synced_generation = dirty_generation
          WHERE id = ?
          """,
        arguments: [try JSONEncoder.enchiridion.encode(definition), id.rawValue]
      )
      try GraphProjectionStore.refreshIssues(for: [id], in: db)
      return false
    }
  }

  public func clearRelationDefinitionCloudRecordMetadata(id: RelationID) throws {
    guard !ModuleNamespace.isCompiledIdentifier(id.rawValue) else { return }
    try database.write { db in
      try db.execute(
        sql: """
          UPDATE _graph_relation_definitions
          SET cloud_record = NULL, cloud_dirty = 1
          WHERE id = ? AND is_system = 0
          """,
        arguments: [id.rawValue]
      )
    }
  }

  /// Resolves a merge-created max-one conflict without inventing last-writer-wins semantics.
  public func resolveCardinalityConflict(
    relationID: RelationID,
    keeping edgeID: EdgeID,
    now: Date = Date()
  ) throws {
    try database.write { db in
      guard let keep = try Row.fetchOne(
        db,
        sql: "SELECT * FROM _graph_edges WHERE edge_id = ? AND relation_id = ?",
        arguments: [edgeID.rawValue, relationID.rawValue]
      ).flatMap(Self.decodeEdge),
        let relation = try Row.fetchOne(
          db,
          sql: "SELECT definition_json FROM _graph_relation_definitions WHERE id = ?",
          arguments: [relationID.rawValue]
        ).flatMap(Self.decodeRelation)
      else { throw GraphModelError.invalidEndpoint }
      let conflicts = try Row.fetchAll(
        db,
        sql: """
          SELECT * FROM _graph_edges
          WHERE relation_id = ? AND edge_id <> ?
            AND ((? = 'one' AND source_node_id = ?)
              OR (? = 'one' AND target_node_id = ?))
          """,
        arguments: [
          relationID.rawValue,
          edgeID.rawValue,
          relation.cardinality.targetsPerSource.rawValue,
          keep.sourceNodeID.rawValue,
          relation.cardinality.sourcesPerTarget.rawValue,
          keep.targetNodeID.rawValue,
        ]
      ).compactMap(Self.decodeEdge)
      var updatedPages: [NodeID: PageSnapshot] = [:]
      for edge in conflicts {
        let source: PageSnapshot
        if let updated = updatedPages[edge.sourceNodeID] {
          source = updated
        } else if let fetched = try Self.fetchPage(db, id: edge.sourceNodeID) {
          source = fetched
        } else {
          throw GraphModelError.invalidEndpoint
        }
        updatedPages[edge.sourceNodeID] = try Self.removingEdge(edge, from: source, now: now)
      }
      for page in updatedPages.values.sorted(by: { $0.id.rawValue < $1.id.rawValue }) {
        try Self.writePage(db, page: page, cloudDirty: true)
      }
    }
  }

  public func effectiveTagIDs(for nodeID: NodeID) throws -> Set<TagID> {
    try database.read { db in try Self.effectiveTagIDs(db, nodeID: nodeID) }
  }

  static func effectiveTagIDs(_ db: Database, nodeID: NodeID) throws -> Set<TagID> {
    Set(try String.fetchAll(
      db,
      sql: "SELECT tag_id FROM graph_node_tags WHERE node_id = ?",
      arguments: [nodeID.rawValue]
    ).map(TagID.init(rawValue:)))
  }

  private static func removingEdge(
    _ edge: KnowledgeEdge,
    from source: PageSnapshot,
    now: Date
  ) throws -> PageSnapshot {
    guard edge.origin != .provider, edge.origin != .inlineReference else {
      throw GraphModelError.immutableSystemDefinition
    }
    let explicit = (try? PageDocument.inspect(source.document, pageID: source.id).graphEdges) ?? []
    let mutation: (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection)
    if explicit.contains(where: { $0.id == edge.id }) {
      mutation = try PageDocument.removeEdge(edge.id, in: source.document)
    } else if let key = BuiltInRelations.propertyKey(for: edge.relationID) {
      let retained = (source.objectMetadata.properties[key] ?? []).filter { value in
        guard case .page(let pageID) = value else { return true }
        return pageID != edge.targetNodeID
      }
      mutation = try PageDocument.setProperty(key: key, values: retained, in: source.document)
    } else {
      throw GraphModelError.invalidEndpoint
    }
    return Self.updatedPage(source, with: mutation, now: now)
  }

  static func decodeRelation(_ row: Row) -> RelationDefinition? {
    guard let data: Data = row["definition_json"] else { return nil }
    return try? JSONDecoder.enchiridion.decode(RelationDefinition.self, from: data)
  }

  private static func decodeRelationCloudRecord(_ row: Row) -> RelationDefinitionCloudRecord? {
    guard let definition = decodeRelation(row),
      let modifiedAt: Double = row["modified_at"],
      let dirtyGeneration: Int64 = row["dirty_generation"]
    else { return nil }
    return .init(
      definition: definition,
      modifiedAt: Date(timeIntervalSince1970: modifiedAt),
      dirtyGeneration: dirtyGeneration,
      cloudRecord: row["cloud_record"]
    )
  }

  private static func writeCloudRelationDefinition(
    _ definition: RelationDefinition,
    modifiedAt: Date,
    dirtyGeneration: Int64,
    systemFields: Data,
    in db: Database
  ) throws {
    try db.execute(
      sql: """
        INSERT INTO _graph_relation_definitions
          (id,forward_name,inverse_name,targets_per_source,sources_per_target,
           is_system,is_deleted,definition_json,modified_at,dirty_generation,
           cloud_dirty,cloud_synced_generation,cloud_record)
        VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)
        ON CONFLICT(id) DO UPDATE SET
          forward_name=excluded.forward_name,
          inverse_name=excluded.inverse_name,
          targets_per_source=excluded.targets_per_source,
          sources_per_target=excluded.sources_per_target,
          is_system=0,
          is_deleted=excluded.is_deleted,
          definition_json=excluded.definition_json,
          modified_at=excluded.modified_at,
          dirty_generation=excluded.dirty_generation,
          cloud_dirty=0,
          cloud_synced_generation=excluded.cloud_synced_generation,
          cloud_record=excluded.cloud_record
        """,
      arguments: [
        definition.id.rawValue,
        definition.forwardName,
        definition.inverseName,
        definition.cardinality.targetsPerSource.rawValue,
        definition.cardinality.sourcesPerTarget.rawValue,
        false,
        definition.isDeleted,
        try JSONEncoder.enchiridion.encode(definition),
        modifiedAt.timeIntervalSince1970,
        dirtyGeneration,
        dirtyGeneration,
        systemFields,
      ]
    )
    try db.execute(
      sql: "DELETE FROM _graph_relation_source_tags WHERE relation_id = ?",
      arguments: [definition.id.rawValue]
    )
    try db.execute(
      sql: "DELETE FROM _graph_relation_target_tags WHERE relation_id = ?",
      arguments: [definition.id.rawValue]
    )
    for tagID in definition.sourceTagIDs {
      try db.execute(
        sql: "INSERT INTO _graph_relation_source_tags (relation_id,tag_id) VALUES (?,?)",
        arguments: [definition.id.rawValue, tagID.rawValue]
      )
    }
    for tagID in definition.targetTagIDs {
      try db.execute(
        sql: "INSERT INTO _graph_relation_target_tags (relation_id,tag_id) VALUES (?,?)",
        arguments: [definition.id.rawValue, tagID.rawValue]
      )
    }
  }

  private static func decodeEdge(_ row: Row) -> KnowledgeEdge? {
    guard let edgeID: String = row["edge_id"],
      let relationID: String = row["relation_id"],
      let sourceID: String = row["source_node_id"],
      let targetID: String = row["target_node_id"],
      let originRaw: String = row["origin"],
      let origin = GraphEdgeOrigin(rawValue: originRaw),
      let createdAt: Double = row["created_at"]
    else { return nil }
    return .init(
      id: .init(rawValue: edgeID),
      relationID: .init(rawValue: relationID),
      sourceNodeID: .init(rawValue: sourceID),
      targetNodeID: .init(rawValue: targetID),
      origin: origin,
      createdAt: Date(timeIntervalSince1970: createdAt)
    )
  }

  private static func decodeIssue(_ row: Row) -> GraphIssue? {
    guard let issueID: String = row["issue_id"],
      let kindRaw: String = row["kind"],
      let kind = GraphIssueKind(rawValue: kindRaw),
      let nodeID: String = row["node_id"],
      let message: String = row["message"],
      let createdAt: Double = row["created_at"]
    else { return nil }
    return .init(
      id: .init(rawValue: issueID),
      kind: kind,
      nodeID: .init(rawValue: nodeID),
      edgeID: (row["edge_id"] as String?).map(EdgeID.init(rawValue:)),
      relationID: (row["relation_id"] as String?).map(RelationID.init(rawValue:)),
      message: message,
      createdAt: Date(timeIntervalSince1970: createdAt)
    )
  }
}
