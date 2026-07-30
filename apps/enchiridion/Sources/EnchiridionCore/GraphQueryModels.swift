import Foundation

public struct GraphQueryID: RawRepresentable, Codable, Hashable, Sendable, Identifiable {
  public let rawValue: String
  public var id: String { rawValue }
  public init(rawValue: String) { self.rawValue = rawValue }
  public static func random() -> Self {
    .init(rawValue: "graph_query_\(UUID().uuidString.lowercased())")
  }
}

public enum GraphComparison: String, Codable, CaseIterable, Hashable, Sendable {
  case equals
  case notEquals
  case contains
  case before
  case after
  case isEmpty
  case isNotEmpty
}

public enum GraphTraversalDirection: String, Codable, CaseIterable, Hashable, Sendable {
  case forward
  case inverse
  case either
}

public struct GraphTraversal: Codable, Hashable, Sendable {
  public static let maximumAllowedDepth = 8

  public var relationID: RelationID?
  public var direction: GraphTraversalDirection
  public var minimumDepth: Int
  public var maximumDepth: Int
  public var targetTagID: TagID?

  public init(
    relationID: RelationID? = nil,
    direction: GraphTraversalDirection = .forward,
    minimumDepth: Int = 1,
    maximumDepth: Int = 1,
    targetTagID: TagID? = nil
  ) {
    self.relationID = relationID
    self.direction = direction
    self.minimumDepth = min(max(minimumDepth, 1), Self.maximumAllowedDepth)
    self.maximumDepth = min(
      max(maximumDepth, self.minimumDepth),
      Self.maximumAllowedDepth
    )
    self.targetTagID = targetTagID
  }

  private enum CodingKeys: String, CodingKey {
    case relationID
    case direction
    case minimumDepth
    case maximumDepth
    case targetTagID
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      relationID: try container.decodeIfPresent(RelationID.self, forKey: .relationID),
      direction: try container.decode(GraphTraversalDirection.self, forKey: .direction),
      minimumDepth: try container.decode(Int.self, forKey: .minimumDepth),
      maximumDepth: try container.decode(Int.self, forKey: .maximumDepth),
      targetTagID: try container.decodeIfPresent(TagID.self, forKey: .targetTagID)
    )
  }
}

public indirect enum GraphExpression: Codable, Hashable, Sendable {
  case tag(TagID)
  case fact(PredicateID, GraphComparison, GraphFactValue?)
  case traversal(GraphTraversal)
  case and([GraphExpression])
  case or([GraphExpression])
  case not(GraphExpression)
}

public enum GraphSortKey: Codable, Hashable, Sendable {
  case title
  case createdAt
  case modifiedAt
  case fact(PredicateID)
}

public struct GraphSort: Codable, Hashable, Sendable {
  public var key: GraphSortKey
  public var ascending: Bool

  public init(key: GraphSortKey, ascending: Bool = true) {
    self.key = key
    self.ascending = ascending
  }
}

public struct GraphQueryDefinition: Codable, Hashable, Sendable {
  public static let maximumAllowedLimit = 5_000

  public var expression: GraphExpression?
  public var sorts: [GraphSort]
  public var includeDeleted: Bool
  public var limit: Int

  public init(
    expression: GraphExpression? = nil,
    sorts: [GraphSort] = [.init(key: .title)],
    includeDeleted: Bool = false,
    limit: Int = 500
  ) {
    self.expression = expression
    self.sorts = sorts
    self.includeDeleted = includeDeleted
    self.limit = min(max(limit, 1), Self.maximumAllowedLimit)
  }

  private enum CodingKeys: String, CodingKey {
    case expression
    case sorts
    case includeDeleted
    case limit
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      expression: try container.decodeIfPresent(GraphExpression.self, forKey: .expression),
      sorts: try container.decode([GraphSort].self, forKey: .sorts),
      includeDeleted: try container.decode(Bool.self, forKey: .includeDeleted),
      limit: try container.decode(Int.self, forKey: .limit)
    )
  }
}

public enum GraphViewKind: String, Codable, CaseIterable, Hashable, Sendable {
  case list
  case table
  case board
  case gallery
  case calendar

  public var title: String { rawValue.capitalized }
  public var systemImage: String {
    switch self {
    case .list: "list.bullet"
    case .table: "tablecells"
    case .board: "rectangle.split.3x1"
    case .gallery: "square.grid.2x2"
    case .calendar: "calendar"
    }
  }
}

public struct GraphViewPresentation: Codable, Hashable, Sendable {
  public var kind: GraphViewKind
  public var titleColumn: String
  public var groupColumn: String?
  public var startColumn: String?
  public var endColumn: String?

  public init(
    kind: GraphViewKind = .list,
    titleColumn: String = "title",
    groupColumn: String? = nil,
    startColumn: String? = nil,
    endColumn: String? = nil
  ) {
    self.kind = kind
    self.titleColumn = titleColumn
    self.groupColumn = groupColumn
    self.startColumn = startColumn
    self.endColumn = endColumn
  }
}

public struct SavedGraphQuery: Codable, Hashable, Sendable, Identifiable {
  public enum Source: Codable, Hashable, Sendable {
    case builder(GraphQueryDefinition)
    case sql(String)
  }

  public var id: GraphQueryID
  public var name: String
  public var source: Source
  public var presentation: GraphViewPresentation

  public init(
    id: GraphQueryID = .random(),
    name: String,
    source: Source,
    presentation: GraphViewPresentation = .init()
  ) {
    self.id = id
    self.name = name
    self.source = source
    self.presentation = presentation
  }
}

public enum GraphSQLValue: Codable, Hashable, Sendable {
  case null
  case integer(Int64)
  case real(Double)
  case text(String)
  case blob(Data)
}

public struct GraphQueryColumn: Codable, Hashable, Sendable, Identifiable {
  public var name: String
  public var id: String { name }
  public init(name: String) { self.name = name }
}

public struct GraphQueryRow: Codable, Hashable, Sendable, Identifiable {
  public var values: [GraphSQLValue]
  public var id: Int
  public init(id: Int, values: [GraphSQLValue]) {
    self.id = id
    self.values = values
  }
}

public struct GraphQueryResult: Codable, Hashable, Sendable {
  public var columns: [GraphQueryColumn]
  public var rows: [GraphQueryRow]
  public var wasTruncated: Bool
  public var elapsed: TimeInterval

  public init(
    columns: [GraphQueryColumn],
    rows: [GraphQueryRow],
    wasTruncated: Bool,
    elapsed: TimeInterval
  ) {
    self.columns = columns
    self.rows = rows
    self.wasTruncated = wasTruncated
    self.elapsed = elapsed
  }

  public func value(column name: String, in row: GraphQueryRow) -> GraphSQLValue? {
    guard let index = columns.firstIndex(where: { $0.name == name }),
      row.values.indices.contains(index)
    else { return nil }
    return row.values[index]
  }
}

public struct CompiledGraphQuery: Equatable, Sendable {
  public var sql: String
  public var arguments: [String: GraphSQLValue]

  public init(sql: String, arguments: [String: GraphSQLValue]) {
    self.sql = sql
    self.arguments = arguments
  }
}

public enum GraphQueryCompiler {
  public static func compile(_ definition: GraphQueryDefinition) -> CompiledGraphQuery {
    var context = Context()
    var predicates: [String] = []
    if !definition.includeDeleted { predicates.append("node.deleted_at IS NULL") }
    if let expression = definition.expression {
      predicates.append(context.expression(expression, nodeAlias: "node"))
    }
    let whereClause = predicates.isEmpty ? "" : "\nWHERE \(predicates.joined(separator: " AND "))"
    let orderClause = definition.sorts.isEmpty
      ? ""
      : "\nORDER BY " + definition.sorts.map { context.sort($0, nodeAlias: "node") }.joined(separator: ", ")
    let limit = min(max(definition.limit, 1), GraphQueryDefinition.maximumAllowedLimit)
    let sql = """
      SELECT node.node_id, node.title, node.plain_text, node.kind,
             node.created_at, node.modified_at, node.deleted_at
      FROM graph_nodes node\(whereClause)\(orderClause)
      LIMIT \(limit)
      """
    return .init(sql: sql, arguments: context.arguments)
  }

  private struct Context {
    var arguments: [String: GraphSQLValue] = [:]
    var nextArgument = 0
    var nextTraversal = 0

    mutating func bind(_ value: GraphSQLValue) -> String {
      let name = "p\(nextArgument)"
      nextArgument += 1
      arguments[name] = value
      return ":\(name)"
    }

    mutating func expression(_ value: GraphExpression, nodeAlias: String) -> String {
      switch value {
      case .tag(let tagID):
        return "EXISTS (SELECT 1 FROM graph_node_tags tag WHERE tag.node_id = \(nodeAlias).node_id AND tag.tag_id = \(bind(.text(tagID.rawValue))))"
      case .fact(let predicateID, let comparison, let expected):
        let predicate = bind(.text(predicateID.rawValue))
        if comparison == .isEmpty {
          return "NOT EXISTS (SELECT 1 FROM graph_facts fact WHERE fact.node_id = \(nodeAlias).node_id AND fact.predicate_id = \(predicate))"
        }
        if comparison == .isNotEmpty {
          return "EXISTS (SELECT 1 FROM graph_facts fact WHERE fact.node_id = \(nodeAlias).node_id AND fact.predicate_id = \(predicate))"
        }
        guard let expected else { return "0" }
        let (column, argument) = factOperand(
          expected,
          escapingLikeWildcards: comparison == .contains
        )
        let operation: String
        switch comparison {
        case .equals: operation = "= \(argument)"
        case .notEquals: operation = "= \(argument)"
        case .contains:
          operation = "LIKE '%' || \(argument) || '%' ESCAPE '\\' COLLATE NOCASE"
        case .before: operation = "< \(argument)"
        case .after: operation = "> \(argument)"
        case .isEmpty, .isNotEmpty: operation = "= \(argument)"
        }
        let exists = "EXISTS (SELECT 1 FROM graph_facts fact WHERE fact.node_id = \(nodeAlias).node_id AND fact.predicate_id = \(predicate) AND fact.\(column) \(operation))"
        return comparison == .notEquals ? "NOT \(exists)" : exists
      case .traversal(let traversal):
        let cteName = "walk_\(nextTraversal)"
        nextTraversal += 1
        let minimumDepth = min(
          max(traversal.minimumDepth, 1),
          GraphTraversal.maximumAllowedDepth
        )
        let maximumDepth = min(
          max(traversal.maximumDepth, minimumDepth),
          GraphTraversal.maximumAllowedDepth
        )
        let directionPredicate: String
        switch traversal.direction {
        case .forward: directionPredicate = "edge.direction = 'forward'"
        case .inverse: directionPredicate = "edge.direction = 'inverse'"
        case .either: directionPredicate = "1"
        }
        let relationPredicate = traversal.relationID.map {
          " AND edge.relation_id = \(bind(.text($0.rawValue)))"
        } ?? ""
        var target = "walk.depth BETWEEN \(minimumDepth) AND \(maximumDepth)"
        if let tagID = traversal.targetTagID {
          target += " AND EXISTS (SELECT 1 FROM graph_node_tags target_tag WHERE target_tag.node_id = walk.current_id AND target_tag.tag_id = \(bind(.text(tagID.rawValue))))"
        }
        return """
          EXISTS (
            WITH RECURSIVE \(cteName)(current_id, depth) AS (
              SELECT \(nodeAlias).node_id, 0
              UNION ALL
              SELECT edge.to_node_id, walk.depth + 1
              FROM \(cteName) walk
              JOIN graph_edges edge ON edge.from_node_id = walk.current_id
              WHERE walk.depth < \(maximumDepth)
                AND \(directionPredicate)\(relationPredicate)
            )
            SELECT 1 FROM \(cteName) walk WHERE \(target)
          )
          """
      case .and(let expressions):
        guard !expressions.isEmpty else { return "1" }
        return "(" + expressions.map { expression($0, nodeAlias: nodeAlias) }.joined(separator: " AND ") + ")"
      case .or(let expressions):
        guard !expressions.isEmpty else { return "0" }
        return "(" + expressions.map { expression($0, nodeAlias: nodeAlias) }.joined(separator: " OR ") + ")"
      case .not(let expressionValue):
        return "NOT (\(expression(expressionValue, nodeAlias: nodeAlias)))"
      }
    }

    mutating func sort(_ sort: GraphSort, nodeAlias: String) -> String {
      let direction = sort.ascending ? "ASC" : "DESC"
      switch sort.key {
      case .title: return "\(nodeAlias).title COLLATE NOCASE \(direction)"
      case .createdAt: return "\(nodeAlias).created_at \(direction)"
      case .modifiedAt: return "\(nodeAlias).modified_at \(direction)"
      case .fact(let predicateID):
        let predicate = bind(.text(predicateID.rawValue))
        return "(SELECT COALESCE(fact.text_value, fact.number_value, fact.boolean_value, fact.local_date_value, fact.date_time_value) FROM graph_facts fact WHERE fact.node_id = \(nodeAlias).node_id AND fact.predicate_id = \(predicate) ORDER BY fact.value_index LIMIT 1) \(direction)"
      }
    }

    mutating func factOperand(
      _ value: GraphFactValue,
      escapingLikeWildcards: Bool = false
    ) -> (String, String) {
      switch value {
      case .text(let value), .select(let value), .url(let value), .email(let value),
        .phone(let value):
        let boundValue = escapingLikeWildcards
          ? value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "%", with: "\\%")
            .replacingOccurrences(of: "_", with: "\\_")
          : value
        return ("text_value", bind(.text(boundValue)))
      case .number(let value): return ("number_value", bind(.real(value)))
      case .boolean(let value): return ("boolean_value", bind(.integer(value ? 1 : 0)))
      case .localDate(let value): return ("local_date_value", bind(.text(value.rawValue)))
      case .dateTime(let value): return ("date_time_value", bind(.real(value.timeIntervalSince1970)))
      }
    }
  }
}
