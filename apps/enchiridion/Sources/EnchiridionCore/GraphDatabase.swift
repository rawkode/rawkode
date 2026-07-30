import CryptoKit
import Foundation
import GRDB

enum GraphDatabaseSchema {
  static func install(in db: Database) throws {
    try db.create(table: "_graph_relation_definitions") { table in
      table.column("id", .text).primaryKey()
      table.column("forward_name", .text).notNull()
      table.column("inverse_name", .text).notNull()
      table.column("targets_per_source", .text).notNull()
      table.column("sources_per_target", .text).notNull()
      table.column("is_system", .boolean).notNull().defaults(to: false)
      table.column("is_deleted", .boolean).notNull().defaults(to: false)
      table.column("definition_json", .blob).notNull()
      table.column("modified_at", .double).notNull()
      table.column("dirty_generation", .integer).notNull().defaults(to: 1)
      table.column("cloud_dirty", .boolean).notNull().defaults(to: true).indexed()
      table.column("cloud_synced_generation", .integer).notNull().defaults(to: 0)
      table.column("cloud_record", .blob)
    }
    try db.create(table: "_graph_relation_source_tags") { table in
      table.column("relation_id", .text).notNull()
        .references("_graph_relation_definitions", onDelete: .cascade)
      table.column("tag_id", .text).notNull()
      table.primaryKey(["relation_id", "tag_id"])
    }
    try db.create(table: "_graph_relation_target_tags") { table in
      table.column("relation_id", .text).notNull()
        .references("_graph_relation_definitions", onDelete: .cascade)
      table.column("tag_id", .text).notNull()
      table.primaryKey(["relation_id", "tag_id"])
    }
    try db.create(table: "_graph_tag_parents") { table in
      table.column("tag_id", .text).notNull()
      table.column("parent_tag_id", .text).notNull()
      table.primaryKey(["tag_id", "parent_tag_id"])
    }
    try db.create(table: "_graph_tag_closure") { table in
      table.column("descendant_tag_id", .text).notNull()
      table.column("ancestor_tag_id", .text).notNull()
      table.column("depth", .integer).notNull()
      table.primaryKey(["descendant_tag_id", "ancestor_tag_id"])
    }
    try db.create(
      index: "_graph_tag_closure_on_ancestor",
      on: "_graph_tag_closure",
      columns: ["ancestor_tag_id", "descendant_tag_id"]
    )
    try db.create(table: "_graph_facts") { table in
      table.column("fact_id", .text).primaryKey()
      table.column("node_id", .text).notNull().indexed()
        .references("pages", onDelete: .cascade)
      table.column("predicate_id", .text).notNull().indexed()
      table.column("tag_id", .text).notNull().indexed()
      table.column("field_id", .text).notNull().indexed()
      table.column("value_index", .integer).notNull()
      table.column("value_type", .text).notNull()
      table.column("text_value", .text)
      table.column("number_value", .double)
      table.column("boolean_value", .boolean)
      table.column("local_date_value", .text)
      table.column("date_time_value", .double)
      table.column("origin", .text).notNull()
      table.column("created_at", .double).notNull()
    }
    try db.create(table: "_graph_edges") { table in
      table.column("edge_id", .text).primaryKey()
      table.column("relation_id", .text).notNull().indexed()
      table.column("source_node_id", .text).notNull().indexed()
        .references("pages", onDelete: .cascade)
      // Deliberately no target foreign key. A source-owned CRDT edge survives target purge and is
      // surfaced as an unresolved issue until the user removes or repairs it.
      table.column("target_node_id", .text).notNull().indexed()
      table.column("origin", .text).notNull()
      table.column("created_at", .double).notNull()
    }
    try db.create(
      index: "_graph_edges_on_relation_source",
      on: "_graph_edges",
      columns: ["relation_id", "source_node_id"]
    )
    try db.create(
      index: "_graph_edges_on_relation_target",
      on: "_graph_edges",
      columns: ["relation_id", "target_node_id"]
    )
    try db.create(table: "_graph_issues") { table in
      table.column("issue_id", .text).primaryKey()
      table.column("kind", .text).notNull().indexed()
      table.column("node_id", .text).notNull().indexed()
      table.column("edge_id", .text).indexed()
      table.column("relation_id", .text).indexed()
      table.column("message", .text).notNull()
      table.column("created_at", .double).notNull()
    }
    try db.create(table: "_saved_graph_queries") { table in
      table.column("id", .text).primaryKey()
      table.column("name", .text).notNull()
      table.column("source_kind", .text).notNull()
      table.column("builder_json", .blob)
      table.column("sql_text", .text)
      table.column("presentation_json", .blob).notNull()
      table.column("modified_at", .double).notNull()
      table.column("sort_order", .integer).notNull().defaults(to: 999)
      table.column("deleted", .boolean).notNull().defaults(to: false)
      table.column("dirty_generation", .integer).notNull().defaults(to: 1)
      table.column("cloud_dirty", .boolean).notNull().defaults(to: true)
      table.column("cloud_synced_generation", .integer).notNull().defaults(to: 0)
      table.column("cloud_record", .blob)
    }
    try db.execute(
      sql: "CREATE VIRTUAL TABLE graph_text_search USING fts5(node_id UNINDEXED, title, body)"
    )
    try db.execute(sql: """
      CREATE TRIGGER _graph_pages_after_delete
      AFTER DELETE ON pages
      BEGIN
        DELETE FROM graph_text_search WHERE node_id = OLD.id;
      END
      """)

    try createPublicViews(in: db)
    for relation in BuiltInRelations.all {
      try saveRelation(relation, in: db, modifiedAt: Date(timeIntervalSince1970: 0))
    }
    try rebuildTagClosure(in: db)

    for row in try Row.fetchAll(db, sql: "SELECT * FROM pages") {
      let page = try LibraryRepository.decodePage(row)
      try GraphProjectionStore.replacePage(page, references: nil, in: db)
    }
    try GraphProjectionStore.refreshIssues(in: db)
  }

  static func createPublicViews(in db: Database) throws {
    try db.execute(sql: """
      CREATE VIEW graph_nodes AS
      SELECT id AS node_id,
             title,
             plain_text,
             kind_tag AS kind,
             created_at,
             modified_at,
             deleted_at,
             is_pinned
      FROM pages
      WHERE id IS NOT NULL
      """)
    try db.execute(sql: """
      CREATE VIEW graph_tags AS
      SELECT id AS tag_id,
             name,
             sort_order,
             deleted,
             CASE WHEN id IN ('person','organization','company','event','place','area','project','task')
               THEN 1 ELSE 0 END AS is_base
      FROM supertag_schemas
      WHERE id IS NOT NULL
      """)
    try db.execute(sql: """
      CREATE VIEW graph_tag_parents AS
      SELECT tag_id, parent_tag_id FROM _graph_tag_parents WHERE tag_id IS NOT NULL
      """)
    try db.execute(sql: """
      CREATE VIEW graph_tag_closure AS
      SELECT descendant_tag_id, ancestor_tag_id, depth
      FROM _graph_tag_closure
      WHERE descendant_tag_id IS NOT NULL
      """)
    try db.execute(sql: """
      CREATE VIEW graph_node_tags AS
      SELECT direct.page_id AS node_id,
             closure.ancestor_tag_id AS tag_id,
             MIN(closure.depth) AS depth,
             MAX(CASE WHEN closure.depth = 0 THEN 1 ELSE 0 END) AS direct
      FROM page_supertags direct
      JOIN _graph_tag_closure closure
        ON closure.descendant_tag_id = direct.supertag_id
      GROUP BY direct.page_id, closure.ancestor_tag_id
      """)
    try db.execute(sql: """
      CREATE VIEW graph_facts AS
      SELECT fact_id, node_id, predicate_id, tag_id, field_id, value_index,
             value_type, text_value, number_value, boolean_value,
             local_date_value, date_time_value, origin, created_at
      FROM _graph_facts
      WHERE fact_id IS NOT NULL
      """)
    try db.execute(sql: """
      CREATE VIEW graph_relation_definitions AS
      SELECT id AS relation_id, forward_name, inverse_name,
             targets_per_source, sources_per_target, is_system
      FROM _graph_relation_definitions
      WHERE is_deleted = 0
      """)
    try db.execute(sql: """
      CREATE VIEW graph_edges AS
      SELECT edge.edge_id,
             edge.source_node_id AS from_node_id,
             edge.target_node_id AS to_node_id,
             edge.relation_id,
             relation.forward_name AS relationship_name,
             'forward' AS direction,
             edge.source_node_id AS canonical_source_node_id,
             edge.target_node_id AS canonical_target_node_id,
             edge.origin,
             edge.created_at
      FROM _graph_edges edge
      JOIN _graph_relation_definitions relation ON relation.id = edge.relation_id
      WHERE relation.is_deleted = 0
      UNION ALL
      SELECT edge.edge_id,
             edge.target_node_id AS from_node_id,
             edge.source_node_id AS to_node_id,
             edge.relation_id,
             relation.inverse_name AS relationship_name,
             'inverse' AS direction,
             edge.source_node_id AS canonical_source_node_id,
             edge.target_node_id AS canonical_target_node_id,
             edge.origin,
             edge.created_at
      FROM _graph_edges edge
      JOIN _graph_relation_definitions relation ON relation.id = edge.relation_id
      WHERE relation.is_deleted = 0
      """)
    try db.execute(sql: """
      CREATE VIEW graph_issues AS
      SELECT issue_id, kind, node_id, edge_id, relation_id, message, created_at
      FROM _graph_issues
      WHERE issue_id IS NOT NULL
      """)
  }

  static func saveRelation(
    _ relation: RelationDefinition,
    in db: Database,
    modifiedAt: Date = Date()
  ) throws {
    let encoded = try JSONEncoder.enchiridion.encode(relation)
    try db.execute(
      sql: """
        INSERT INTO _graph_relation_definitions
          (id,forward_name,inverse_name,targets_per_source,sources_per_target,
           is_system,is_deleted,definition_json,modified_at,dirty_generation,cloud_dirty)
        VALUES (?,?,?,?,?,?,?,?,?,1,?)
        ON CONFLICT(id) DO UPDATE SET
          forward_name=excluded.forward_name,
          inverse_name=excluded.inverse_name,
          targets_per_source=excluded.targets_per_source,
          sources_per_target=excluded.sources_per_target,
          is_system=excluded.is_system,
          is_deleted=excluded.is_deleted,
          definition_json=excluded.definition_json,
          modified_at=excluded.modified_at,
          dirty_generation=_graph_relation_definitions.dirty_generation + 1,
          cloud_dirty=excluded.cloud_dirty
        """,
      arguments: [
        relation.id.rawValue,
        relation.forwardName,
        relation.inverseName,
        relation.cardinality.targetsPerSource.rawValue,
        relation.cardinality.sourcesPerTarget.rawValue,
        relation.isSystem,
        relation.isDeleted,
        encoded,
        modifiedAt.timeIntervalSince1970,
        !relation.isSystem,
      ]
    )
    try db.execute(
      sql: "DELETE FROM _graph_relation_source_tags WHERE relation_id = ?",
      arguments: [relation.id.rawValue]
    )
    try db.execute(
      sql: "DELETE FROM _graph_relation_target_tags WHERE relation_id = ?",
      arguments: [relation.id.rawValue]
    )
    for tagID in relation.sourceTagIDs {
      try db.execute(
        sql: "INSERT INTO _graph_relation_source_tags (relation_id,tag_id) VALUES (?,?)",
        arguments: [relation.id.rawValue, tagID.rawValue]
      )
    }
    for tagID in relation.targetTagIDs {
      try db.execute(
        sql: "INSERT INTO _graph_relation_target_tags (relation_id,tag_id) VALUES (?,?)",
        arguments: [relation.id.rawValue, tagID.rawValue]
      )
    }
  }

  static func rebuildTagClosure(in db: Database) throws {
    let definitions: [SupertagDefinition] = try Row.fetchAll(
      db,
      sql: "SELECT definition_json FROM supertag_schemas WHERE deleted = 0"
    ).compactMap { row in
      guard let data: Data = row["definition_json"] else { return nil }
      return try? JSONDecoder.enchiridion.decode(SupertagDefinition.self, from: data)
    }
    let byID = Dictionary(uniqueKeysWithValues: definitions.map { ($0.id, $0) })
    var closure: [TagID: [TagID: Int]] = [:]

    func ancestors(of id: TagID, path: [TagID]) throws -> [TagID: Int] {
      if let cached = closure[id] { return cached }
      guard let definition = byID[id] else { throw GraphModelError.unknownTag(id) }
      guard !path.contains(id) else { throw GraphModelError.inheritanceCycle(path + [id]) }
      var result: [TagID: Int] = [id: 0]
      for parentID in definition.parentIDs {
        for (ancestorID, parentDepth) in try ancestors(of: parentID, path: path + [id]) {
          result[ancestorID] = min(result[ancestorID] ?? .max, parentDepth + 1)
        }
      }
      closure[id] = result
      return result
    }

    for id in byID.keys { _ = try ancestors(of: id, path: []) }
    try db.execute(sql: "DELETE FROM _graph_tag_parents")
    try db.execute(sql: "DELETE FROM _graph_tag_closure")
    for definition in definitions {
      for parentID in definition.parentIDs {
        try db.execute(
          sql: "INSERT INTO _graph_tag_parents (tag_id,parent_tag_id) VALUES (?,?)",
          arguments: [definition.id.rawValue, parentID.rawValue]
        )
      }
      for (ancestorID, depth) in closure[definition.id] ?? [:] {
        try db.execute(
          sql: "INSERT INTO _graph_tag_closure (descendant_tag_id,ancestor_tag_id,depth) VALUES (?,?,?)",
          arguments: [definition.id.rawValue, ancestorID.rawValue, depth]
        )
      }
    }
  }
}

enum GraphProjectionStore {
  static func replacePage(
    _ page: PageSnapshot,
    references: [PageReference]?,
    in db: Database
  ) throws {
    let projection = try? PageDocument.inspect(page.document, pageID: page.id)
    try db.execute(sql: "DELETE FROM _graph_facts WHERE node_id = ?", arguments: [page.id.rawValue])
    try db.execute(
      sql: "DELETE FROM _graph_edges WHERE source_node_id = ? AND origin <> ?",
      arguments: [page.id.rawValue, GraphEdgeOrigin.inlineReference.rawValue]
    )
    var explicitTuples: Set<String> = []
    for edge in projection?.graphEdges ?? [] {
      try insert(edge: edge, in: db)
      explicitTuples.insert(tuple(edge.relationID, edge.targetNodeID))
    }
    for (key, values) in page.objectMetadata.properties {
      for (index, value) in values.enumerated() {
        switch value {
        case .page(let targetID):
          let relationID = BuiltInRelations.relationID(for: key)
          guard !explicitTuples.contains(tuple(relationID, targetID)) else { continue }
          let edge = KnowledgeEdge(
            id: deterministicEdgeID(
              source: page.id,
              relation: relationID,
              target: targetID,
              ordinal: index
            ),
            relationID: relationID,
            sourceNodeID: page.id,
            targetNodeID: targetID,
            createdAt: page.createdAt
          )
          try insert(edge: edge, in: db)
        default:
          try insert(
            fact: fact(
              nodeID: page.id,
              key: key,
              value: value,
              index: index,
              createdAt: page.createdAt
            ),
            key: key,
            index: index,
            in: db
          )
        }
      }
    }
    if let references { try replaceMentions(from: page.id, references: references, in: db) }
    try db.execute(sql: "DELETE FROM graph_text_search WHERE node_id = ?", arguments: [page.id.rawValue])
    if page.deletedAt == nil {
      try db.execute(
        sql: "INSERT INTO graph_text_search (node_id,title,body) VALUES (?,?,?)",
        arguments: [page.id.rawValue, page.title, page.plainText]
      )
    }
  }

  static func replaceMentions(
    from sourceID: NodeID,
    references: [PageReference],
    in db: Database
  ) throws {
    try db.execute(
      sql: "DELETE FROM _graph_edges WHERE source_node_id = ? AND origin = ?",
      arguments: [sourceID.rawValue, GraphEdgeOrigin.inlineReference.rawValue]
    )
    for (index, reference) in references.enumerated() {
      try insert(
        edge: .init(
          id: deterministicEdgeID(
            source: sourceID,
            relation: BuiltInRelations.mentions,
            target: reference.targetPageID,
            ordinal: index
          ),
          relationID: BuiltInRelations.mentions,
          sourceNodeID: sourceID,
          targetNodeID: reference.targetPageID,
          origin: .inlineReference
        ),
        in: db
      )
    }
  }

  static func refreshIssues(in db: Database) throws {
    try db.execute(sql: "DELETE FROM _graph_issues")
    let edges: [KnowledgeEdge] = try Row.fetchAll(db, sql: "SELECT * FROM _graph_edges")
      .compactMap(decodeEdge)
    let relations: [RelationID: RelationDefinition] = Dictionary(uniqueKeysWithValues:
      try Row.fetchAll(
        db,
        sql: "SELECT definition_json FROM _graph_relation_definitions WHERE is_deleted = 0"
      ).compactMap { row -> (RelationID, RelationDefinition)? in
        guard let data: Data = row["definition_json"],
          let definition = try? JSONDecoder.enchiridion.decode(RelationDefinition.self, from: data)
        else { return nil }
        return (definition.id, definition)
      }
    )
    try insertIssues(for: edges, relations: relations, in: db)
  }

  static func refreshIssues(
    for relationIDs: Set<RelationID>,
    in db: Database
  ) throws {
    guard !relationIDs.isEmpty else { return }
    let rawIDs = relationIDs.map(\.rawValue).sorted()
    let placeholders = Array(repeating: "?", count: rawIDs.count).joined(separator: ",")
    let arguments = StatementArguments(rawIDs)
    try db.execute(
      sql: "DELETE FROM _graph_issues WHERE relation_id IN (\(placeholders))",
      arguments: arguments
    )
    let edges = try Row.fetchAll(
      db,
      sql: "SELECT * FROM _graph_edges WHERE relation_id IN (\(placeholders))",
      arguments: arguments
    ).compactMap(decodeEdge)
    let relations = Dictionary(uniqueKeysWithValues:
      try Row.fetchAll(
        db,
        sql: """
          SELECT definition_json
          FROM _graph_relation_definitions
          WHERE is_deleted = 0 AND id IN (\(placeholders))
          """,
        arguments: arguments
      ).compactMap { row -> (RelationID, RelationDefinition)? in
        guard let data: Data = row["definition_json"],
          let definition = try? JSONDecoder.enchiridion.decode(RelationDefinition.self, from: data)
        else { return nil }
        return (definition.id, definition)
      }
    )
    try insertIssues(for: edges, relations: relations, in: db)
  }

  static func relationIDs(touching nodeID: NodeID, in db: Database) throws -> Set<RelationID> {
    Set(try String.fetchAll(
      db,
      sql: """
        SELECT DISTINCT relation_id
        FROM _graph_edges
        WHERE source_node_id = ? OR target_node_id = ?
        """,
      arguments: [nodeID.rawValue, nodeID.rawValue]
    ).map(RelationID.init(rawValue:)))
  }

  private static func insertIssues(
    for edges: [KnowledgeEdge],
    relations: [RelationID: RelationDefinition],
    in db: Database
  ) throws {
    let nodeIDs = Set(edges.flatMap { [$0.sourceNodeID.rawValue, $0.targetNodeID.rawValue] })
    let existingNodes: Set<String>
    if nodeIDs.isEmpty {
      existingNodes = []
    } else {
      let rawIDs = nodeIDs.sorted()
      let placeholders = Array(repeating: "?", count: rawIDs.count).joined(separator: ",")
      existingNodes = Set(try String.fetchAll(
        db,
        sql: "SELECT id FROM pages WHERE deleted_at IS NULL AND id IN (\(placeholders))",
        arguments: StatementArguments(rawIDs)
      ))
    }

    for edge in edges where !existingNodes.contains(edge.targetNodeID.rawValue) {
      try insertIssue(
        kind: .unresolvedTarget,
        edge: edge,
        message: "The relationship target is unavailable.",
        in: db
      )
    }

    for (relationID, relation) in relations {
      let relationEdges = edges.filter { $0.relationID == relationID }
      if relation.cardinality.targetsPerSource == .one {
        for (_, conflicts) in Dictionary(grouping: relationEdges, by: \KnowledgeEdge.sourceNodeID)
        where Set(conflicts.map(\.targetNodeID)).count > 1 {
          for edge in conflicts {
            try insertIssue(
              kind: .cardinalityViolation,
              edge: edge,
              message: "\(relation.forwardName.capitalized) allows one target; choose which relationship to keep.",
              in: db
            )
          }
        }
      }
      if relation.cardinality.sourcesPerTarget == .one {
        for (_, conflicts) in Dictionary(grouping: relationEdges, by: \KnowledgeEdge.targetNodeID)
        where Set(conflicts.map(\.sourceNodeID)).count > 1 {
          for edge in conflicts {
            try insertIssue(
              kind: .cardinalityViolation,
              edge: edge,
              message: "\(relation.inverseName.capitalized) allows one source; choose which relationship to keep.",
              in: db
            )
          }
        }
      }
      if !relation.sourceTagIDs.isEmpty {
        for edge in relationEdges where existingNodes.contains(edge.sourceNodeID.rawValue) {
          let sourceTags = Set(try String.fetchAll(
            db,
            sql: "SELECT tag_id FROM graph_node_tags WHERE node_id = ?",
            arguments: [edge.sourceNodeID.rawValue]
          ).map(TagID.init(rawValue:)))
          guard sourceTags.isDisjoint(with: relation.sourceTagIDs) else { continue }
          try insertIssue(
            kind: .invalidSourceType,
            edge: edge,
            message: "The source does not have a type allowed by \(relation.forwardName).",
            in: db
          )
        }
      }
      if !relation.targetTagIDs.isEmpty {
        for edge in relationEdges where existingNodes.contains(edge.targetNodeID.rawValue) {
          let targetTags = Set(try String.fetchAll(
            db,
            sql: "SELECT tag_id FROM graph_node_tags WHERE node_id = ?",
            arguments: [edge.targetNodeID.rawValue]
          ).map(TagID.init(rawValue:)))
          guard targetTags.isDisjoint(with: relation.targetTagIDs) else { continue }
          try insertIssue(
            kind: .invalidTargetType,
            edge: edge,
            message: "The target does not have a type allowed by \(relation.forwardName).",
            in: db
          )
        }
      }
    }
  }

  private static func fact(
    nodeID: NodeID,
    key: SupertagPropertyKey,
    value: SupertagValue,
    index: Int,
    createdAt: Date
  ) -> KnowledgeFact {
    let graphValue: GraphFactValue
    switch value {
    case .text(let value): graphValue = .text(value)
    case .number(let value): graphValue = .number(value)
    case .boolean(let value): graphValue = .boolean(value)
    case .date(let value): graphValue = .localDate(.init(date: value))
    case .dateTime(let value): graphValue = .dateTime(value)
    case .select(let value): graphValue = .select(value)
    case .url(let value): graphValue = .url(value)
    case .email(let value): graphValue = .email(value)
    case .phone(let value): graphValue = .phone(value)
    case .page: preconditionFailure("References are projected as edges")
    }
    let predicate = PredicateID.property(tagID: key.supertagID, fieldID: key.fieldID)
    return .init(
      id: .init(rawValue: "fact_\(digest("\(nodeID.rawValue)|\(predicate.rawValue)|\(index)|\(value.id)"))"),
      nodeID: nodeID,
      predicateID: predicate,
      value: graphValue,
      createdAt: createdAt
    )
  }

  private static func insert(
    fact: KnowledgeFact,
    key: SupertagPropertyKey,
    index: Int,
    in db: Database
  ) throws {
    var text: String?
    var number: Double?
    var boolean: Bool?
    var localDate: String?
    var dateTime: Double?
    switch fact.value {
    case .text(let value), .select(let value), .url(let value), .email(let value),
      .phone(let value): text = value
    case .number(let value): number = value
    case .boolean(let value): boolean = value
    case .localDate(let value): localDate = value.rawValue
    case .dateTime(let value): dateTime = value.timeIntervalSince1970
    }
    try db.execute(
      sql: """
        INSERT OR REPLACE INTO _graph_facts
          (fact_id,node_id,predicate_id,tag_id,field_id,value_index,value_type,
           text_value,number_value,boolean_value,local_date_value,date_time_value,origin,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
      arguments: [
        fact.id.rawValue,
        fact.nodeID.rawValue,
        fact.predicateID.rawValue,
        key.supertagID.rawValue,
        key.fieldID.rawValue,
        index,
        fact.value.type.rawValue,
        text,
        number,
        boolean,
        localDate,
        dateTime,
        fact.origin.rawValue,
        fact.createdAt.timeIntervalSince1970,
      ]
    )
  }

  private static func insert(edge: KnowledgeEdge, in db: Database) throws {
    try db.execute(
      sql: """
        INSERT OR REPLACE INTO _graph_edges
          (edge_id,relation_id,source_node_id,target_node_id,origin,created_at)
        VALUES (?,?,?,?,?,?)
        """,
      arguments: [
        edge.id.rawValue,
        edge.relationID.rawValue,
        edge.sourceNodeID.rawValue,
        edge.targetNodeID.rawValue,
        edge.origin.rawValue,
        edge.createdAt.timeIntervalSince1970,
      ]
    )
  }

  private static func insertIssue(
    kind: GraphIssueKind,
    edge: KnowledgeEdge,
    message: String,
    in db: Database
  ) throws {
    let id = "issue_\(digest("\(kind.rawValue)|\(edge.id.rawValue)"))"
    try db.execute(
      sql: """
        INSERT OR IGNORE INTO _graph_issues
          (issue_id,kind,node_id,edge_id,relation_id,message,created_at)
        VALUES (?,?,?,?,?,?,?)
        """,
      arguments: [
        id,
        kind.rawValue,
        edge.sourceNodeID.rawValue,
        edge.id.rawValue,
        edge.relationID.rawValue,
        message,
        Date().timeIntervalSince1970,
      ]
    )
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

  private static func tuple(_ relationID: RelationID, _ targetID: NodeID) -> String {
    "\(relationID.rawValue)|\(targetID.rawValue)"
  }

  private static func deterministicEdgeID(
    source: NodeID,
    relation: RelationID,
    target: NodeID,
    ordinal: Int
  ) -> EdgeID {
    .init(rawValue: "edge_\(digest("\(source.rawValue)|\(relation.rawValue)|\(target.rawValue)|\(ordinal)"))")
  }

  private static func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).prefix(20).map { String(format: "%02x", $0) }.joined()
  }
}

public enum GraphModelError: Error, LocalizedError, Equatable {
  case inheritanceCycle([TagID])
  case unknownTag(TagID)
  case unknownRelation(RelationID)
  case invalidEndpoint
  case cardinalityViolation(RelationID)
  case immutableSystemDefinition

  public var errorDescription: String? {
    switch self {
    case .inheritanceCycle: "Tag inheritance must not contain a cycle."
    case .unknownTag: "The tag is unavailable."
    case .unknownRelation: "The relationship definition is unavailable."
    case .invalidEndpoint: "The relationship endpoint is unavailable or has an incompatible type."
    case .cardinalityViolation: "This relationship allows only one value."
    case .immutableSystemDefinition: "System relationship definitions cannot be changed."
    }
  }
}
