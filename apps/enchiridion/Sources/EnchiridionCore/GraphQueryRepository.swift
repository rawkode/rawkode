import Foundation
import GRDB

extension LibraryRepository {
  public nonisolated func runGraphSQL(
    _ sql: String,
    arguments: [String: GraphSQLValue] = [:],
    limits: GraphQueryLimits = .init()
  ) throws -> GraphQueryResult {
    try GraphSQLExecutor.execute(
      path: path,
      sql: sql,
      arguments: arguments,
      limits: limits
    )
  }

  public nonisolated func runGraphQuery(
    _ definition: GraphQueryDefinition,
    limits: GraphQueryLimits = .init()
  ) throws -> GraphQueryResult {
    let compiled = GraphQueryCompiler.compile(definition)
    return try runGraphSQL(
      compiled.sql,
      arguments: compiled.arguments,
      limits: limits
    )
  }

  public nonisolated func runGraphQuery(
    _ query: SavedGraphQuery,
    limits: GraphQueryLimits = .init()
  ) throws -> GraphQueryResult {
    let result: GraphQueryResult
    switch query.source {
    case .builder(let definition):
      result = try runGraphQuery(definition, limits: limits)
    case .sql(let sql):
      result = try runGraphSQL(sql, limits: limits)
    }
    try Self.validate(result: result, presentation: query.presentation)
    return result
  }

  public func savedGraphQueries() throws -> [SavedGraphQuery] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: """
          SELECT * FROM _saved_graph_queries
          WHERE deleted = 0
          ORDER BY sort_order, name COLLATE NOCASE
          """
      ).compactMap(Self.decodeSavedGraphQuery)
    }
  }

  public func saveGraphQuery(
    _ query: SavedGraphQuery,
    now: Date = Date()
  ) throws {
    let name = query.name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { throw GraphQueryError.sqlite("Enter a query name.") }
    switch query.source {
    case .builder(let definition):
      _ = try runGraphQuery(definition, limits: .init(maximumRows: 1))
    case .sql(let sql):
      _ = try runGraphSQL(sql, limits: .init(maximumRows: 1))
    }
    try database.write { db in
      let sourceKind: String
      let builderJSON: Data?
      let sqlText: String?
      switch query.source {
      case .builder(let definition):
        sourceKind = "builder"
        builderJSON = try JSONEncoder.enchiridion.encode(definition)
        sqlText = nil
      case .sql(let sql):
        sourceKind = "sql"
        builderJSON = nil
        sqlText = sql
      }
      try db.execute(
        sql: """
          INSERT INTO _saved_graph_queries
            (id,name,source_kind,builder_json,sql_text,presentation_json,modified_at,
             sort_order,deleted,dirty_generation,cloud_dirty)
          VALUES (?,?,?,?,?,?,?,COALESCE((SELECT sort_order FROM _saved_graph_queries WHERE id = ?),999),0,1,1)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            source_kind=excluded.source_kind,
            builder_json=excluded.builder_json,
            sql_text=excluded.sql_text,
            presentation_json=excluded.presentation_json,
            modified_at=excluded.modified_at,
            deleted=0,
            dirty_generation=_saved_graph_queries.dirty_generation + 1,
            cloud_dirty=1
          """,
        arguments: [
          query.id.rawValue,
          name,
          sourceKind,
          builderJSON,
          sqlText,
          try JSONEncoder.enchiridion.encode(query.presentation),
          now.timeIntervalSince1970,
          query.id.rawValue,
        ]
      )
    }
  }

  public func deleteGraphQuery(_ id: GraphQueryID, now: Date = Date()) throws {
    try database.write { db in
      try db.execute(
        sql: """
          UPDATE _saved_graph_queries
          SET deleted = 1,
              modified_at = ?,
              dirty_generation = dirty_generation + 1,
              cloud_dirty = 1
          WHERE id = ?
          """,
        arguments: [now.timeIntervalSince1970, id.rawValue]
      )
    }
  }

  public func graphFacts(for nodeID: NodeID) throws -> [KnowledgeFact] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: "SELECT * FROM _graph_facts WHERE node_id = ? ORDER BY predicate_id,value_index",
        arguments: [nodeID.rawValue]
      ).compactMap(Self.decodeFact)
    }
  }

  private nonisolated static func validate(
    result: GraphQueryResult,
    presentation: GraphViewPresentation
  ) throws {
    let columns = Set(result.columns.map(\.name))
    switch presentation.kind {
    case .table:
      return
    case .list, .board, .gallery:
      guard columns.contains("node_id") else {
        throw GraphQueryError.sqlite("This presentation requires a node_id column.")
      }
    case .calendar:
      guard columns.contains("node_id"),
        columns.contains(presentation.startColumn ?? "start_at"),
        columns.contains(presentation.endColumn ?? "end_at")
      else {
        throw GraphQueryError.sqlite(
          "Calendar presentation requires node_id, start_at, and end_at columns."
        )
      }
    }
  }

  private static func decodeSavedGraphQuery(_ row: Row) -> SavedGraphQuery? {
    guard let rawID: String = row["id"],
      let name: String = row["name"],
      let sourceKind: String = row["source_kind"],
      let presentationData: Data = row["presentation_json"],
      let presentation = try? JSONDecoder.enchiridion.decode(
        GraphViewPresentation.self,
        from: presentationData
      )
    else { return nil }
    let source: SavedGraphQuery.Source
    switch sourceKind {
    case "builder":
      guard let data: Data = row["builder_json"],
        let definition = try? JSONDecoder.enchiridion.decode(
          GraphQueryDefinition.self,
          from: data
        )
      else { return nil }
      source = .builder(definition)
    case "sql":
      guard let sql: String = row["sql_text"] else { return nil }
      source = .sql(sql)
    default:
      return nil
    }
    return .init(
      id: .init(rawValue: rawID),
      name: name,
      source: source,
      presentation: presentation
    )
  }

  private static func decodeFact(_ row: Row) -> KnowledgeFact? {
    guard let rawID: String = row["fact_id"],
      let rawNodeID: String = row["node_id"],
      let rawPredicateID: String = row["predicate_id"],
      let rawType: String = row["value_type"],
      let type = GraphValueType(rawValue: rawType),
      let rawOrigin: String = row["origin"],
      let origin = GraphFactOrigin(rawValue: rawOrigin),
      let createdAt: Double = row["created_at"]
    else { return nil }
    let value: GraphFactValue
    switch type {
    case .text:
      guard let stored: String = row["text_value"] else { return nil }
      value = .text(stored)
    case .number:
      guard let stored: Double = row["number_value"] else { return nil }
      value = .number(stored)
    case .boolean:
      guard let stored: Bool = row["boolean_value"] else { return nil }
      value = .boolean(stored)
    case .localDate:
      guard let stored: String = row["local_date_value"],
        let date = LocalDate(rawValue: stored)
      else { return nil }
      value = .localDate(date)
    case .dateTime:
      guard let stored: Double = row["date_time_value"] else { return nil }
      value = .dateTime(Date(timeIntervalSince1970: stored))
    case .select:
      guard let stored: String = row["text_value"] else { return nil }
      value = .select(stored)
    case .url:
      guard let stored: String = row["text_value"] else { return nil }
      value = .url(stored)
    case .email:
      guard let stored: String = row["text_value"] else { return nil }
      value = .email(stored)
    case .phone:
      guard let stored: String = row["text_value"] else { return nil }
      value = .phone(stored)
    }
    return .init(
      id: .init(rawValue: rawID),
      nodeID: .init(rawValue: rawNodeID),
      predicateID: .init(rawValue: rawPredicateID),
      value: value,
      origin: origin,
      createdAt: Date(timeIntervalSince1970: createdAt)
    )
  }
}
