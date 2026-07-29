import Foundation

public struct LiveQueryID: RawRepresentable, Codable, Hashable, Sendable, Identifiable {
  public let rawValue: String
  public var id: String { rawValue }
  public init(rawValue: String) { self.rawValue = rawValue }
  public static func random() -> Self { .init(rawValue: "view_\(UUID().uuidString.lowercased())") }
}

public enum LiveQuerySource: Codable, Hashable, Sendable {
  case pages
  case supertag(SupertagID)
  case calendarEvents
  case workCalendar

  public var domainName: String {
    switch self {
    case .pages: "pages"
    case .supertag(let id): "#\(id.rawValue)"
    case .calendarEvents: "calendar_events"
    case .workCalendar: "work_calendar"
    }
  }
}

public enum LiveViewKind: String, Codable, CaseIterable, Hashable, Sendable {
  case list, table, board, calendar, canvas

  public var title: String { rawValue.capitalized }
  public var systemImage: String {
    switch self {
    case .list: "list.bullet"
    case .table: "tablecells"
    case .board: "rectangle.split.3x1"
    case .calendar: "calendar"
    case .canvas: "scribble.variable"
    }
  }
}

public enum LiveQueryPeopleScope: String, Codable, CaseIterable, Hashable, Sendable {
  case promotedOnly
  case includeOthers
}

public enum LiveQueryOperator: String, Codable, CaseIterable, Hashable, Sendable {
  case equals, notEquals, contains, isEmpty, isNotEmpty, before, after

  public var title: String {
    switch self {
    case .equals: "is"
    case .notEquals: "is not"
    case .contains: "contains"
    case .isEmpty: "is empty"
    case .isNotEmpty: "is not empty"
    case .before: "is before"
    case .after: "is after"
    }
  }

  public var needsValue: Bool { self != .isEmpty && self != .isNotEmpty }
}

public struct LiveQueryFilter: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var fieldID: SupertagFieldID?
  public var systemField: String?
  public var operation: LiveQueryOperator
  public var value: SupertagValue?

  public init(
    id: String = UUID().uuidString.lowercased(),
    fieldID: SupertagFieldID? = nil,
    systemField: String? = nil,
    operation: LiveQueryOperator,
    value: SupertagValue? = nil
  ) {
    self.id = id
    self.fieldID = fieldID
    self.systemField = systemField
    self.operation = operation
    self.value = value
  }
}

public struct LiveQuerySort: Codable, Hashable, Sendable {
  public var fieldID: SupertagFieldID?
  public var systemField: String?
  public var ascending: Bool

  public init(fieldID: SupertagFieldID? = nil, systemField: String? = nil, ascending: Bool = true) {
    self.fieldID = fieldID
    self.systemField = systemField
    self.ascending = ascending
  }
}

public struct LiveQueryDefinition: Identifiable, Codable, Hashable, Sendable {
  public var id: LiveQueryID
  public var name: String
  public var source: LiveQuerySource
  public var filters: [LiveQueryFilter]
  public var sorts: [LiveQuerySort]
  public var viewKind: LiveViewKind
  public var visibleFieldIDs: [SupertagFieldID]
  public var groupFieldID: SupertagFieldID?
  public var startFieldID: SupertagFieldID?
  public var endFieldID: SupertagFieldID?
  public var limit: Int
  public var peopleScope: LiveQueryPeopleScope

  public init(
    id: LiveQueryID = .random(),
    name: String,
    source: LiveQuerySource,
    filters: [LiveQueryFilter] = [],
    sorts: [LiveQuerySort] = [.init(systemField: "title")],
    viewKind: LiveViewKind = .list,
    visibleFieldIDs: [SupertagFieldID] = [],
    groupFieldID: SupertagFieldID? = nil,
    startFieldID: SupertagFieldID? = nil,
    endFieldID: SupertagFieldID? = nil,
    limit: Int = 500,
    peopleScope: LiveQueryPeopleScope = .promotedOnly
  ) {
    self.id = id
    self.name = name
    self.source = source
    self.filters = filters
    self.sorts = sorts
    self.viewKind = viewKind
    self.visibleFieldIDs = visibleFieldIDs
    self.groupFieldID = groupFieldID
    self.startFieldID = startFieldID
    self.endFieldID = endFieldID
    let maximumLimit = viewKind == .canvas ? WhiteboardLimits.maximumPageCards : 5_000
    self.limit = min(max(limit, 1), maximumLimit)
    self.peopleScope = peopleScope
  }

  public var domainSQL: String { DomainQueryCodec.serialize(self) }

  /// Whether this saved view can use the task workbench instead of the generic page renderer.
  public var isTaskListPerspective: Bool {
    guard viewKind == .list, case .supertag(let supertagID) = source else {
      return false
    }
    return supertagID == BuiltInSupertags.task
  }

  private enum CodingKeys: String, CodingKey {
    case id, name, source, filters, sorts, viewKind, visibleFieldIDs, groupFieldID
    case startFieldID, endFieldID, limit, peopleScope
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      id: try values.decode(LiveQueryID.self, forKey: .id),
      name: try values.decode(String.self, forKey: .name),
      source: try values.decode(LiveQuerySource.self, forKey: .source),
      filters: try values.decodeIfPresent([LiveQueryFilter].self, forKey: .filters) ?? [],
      sorts: try values.decodeIfPresent([LiveQuerySort].self, forKey: .sorts)
        ?? [.init(systemField: "title")],
      viewKind: try values.decodeIfPresent(LiveViewKind.self, forKey: .viewKind) ?? .list,
      visibleFieldIDs: try values.decodeIfPresent(
        [SupertagFieldID].self,
        forKey: .visibleFieldIDs
      ) ?? [],
      groupFieldID: try values.decodeIfPresent(SupertagFieldID.self, forKey: .groupFieldID),
      startFieldID: try values.decodeIfPresent(SupertagFieldID.self, forKey: .startFieldID),
      endFieldID: try values.decodeIfPresent(SupertagFieldID.self, forKey: .endFieldID),
      limit: try values.decodeIfPresent(Int.self, forKey: .limit) ?? 500,
      peopleScope: try values.decodeIfPresent(LiveQueryPeopleScope.self, forKey: .peopleScope)
        ?? .promotedOnly
    )
  }

  public func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(id, forKey: .id)
    try values.encode(name, forKey: .name)
    try values.encode(source, forKey: .source)
    try values.encode(filters, forKey: .filters)
    try values.encode(sorts, forKey: .sorts)
    try values.encode(viewKind, forKey: .viewKind)
    try values.encode(visibleFieldIDs, forKey: .visibleFieldIDs)
    try values.encodeIfPresent(groupFieldID, forKey: .groupFieldID)
    try values.encodeIfPresent(startFieldID, forKey: .startFieldID)
    try values.encodeIfPresent(endFieldID, forKey: .endFieldID)
    try values.encode(limit, forKey: .limit)
    try values.encode(peopleScope, forKey: .peopleScope)
  }
}

public enum LiveQueryItem: Identifiable, Hashable, Sendable {
  case page(PageSnapshot)
  case event(CalendarEventSnapshot)

  public var id: String {
    switch self {
    case .page(let page): "page:\(page.id.rawValue)"
    case .event(let event): "event:\(event.identity.stableKey)"
    }
  }

  public var title: String {
    switch self {
    case .page(let page): page.displayTitle
    case .event(let event): event.title
    }
  }

  public var isReadOnly: Bool {
    if case .event = self { return true }
    return false
  }
}

public enum DomainQueryError: Error, LocalizedError, Equatable {
  case unsupported(String)
  public var errorDescription: String? {
    switch self { case .unsupported(let message): message }
  }
}

public enum DomainQueryCodec {
  public static func parse(_ sql: String, id: LiveQueryID = .random(), name: String = "Untitled View") throws -> LiveQueryDefinition {
    let tokens = tokenize(sql)
    guard tokens.count >= 4, tokens[0].uppercased() == "SELECT",
      tokens[1] == "*", tokens[2].uppercased() == "FROM"
    else { throw DomainQueryError.unsupported("Use SELECT * FROM followed by a tag or system source.") }
    let source: LiveQuerySource
    switch tokens[3].lowercased() {
    case "pages": source = .pages
    case "calendar_events": source = .calendarEvents
    case "work_calendar": source = .workCalendar
    case let value where value.hasPrefix("#"):
      source = .supertag(.init(rawValue: String(value.dropFirst())))
    default: throw DomainQueryError.unsupported("Unknown query source \(tokens[3]).")
    }

    var definition = LiveQueryDefinition(id: id, name: name, source: source)
    definition.sorts = []
    var index = 4
    while index < tokens.count {
      switch tokens[index].uppercased() {
      case "WHERE":
        index += 1
        while index < tokens.count, !isClause(tokens[index]) {
          let field = tokens[index]
          index += 1
          guard index < tokens.count else {
            throw DomainQueryError.unsupported("A filter needs an operator.")
          }
          let operation: LiveQueryOperator
          switch tokens[index].uppercased() {
          case "=": operation = .equals; index += 1
          case "!=": operation = .notEquals; index += 1
          case "CONTAINS": operation = .contains; index += 1
          case "BEFORE": operation = .before; index += 1
          case "AFTER": operation = .after; index += 1
          case "IS":
            index += 1
            if index < tokens.count, tokens[index].uppercased() == "NOT" {
              index += 1
              guard index < tokens.count, tokens[index].uppercased() == "EMPTY" else {
                throw DomainQueryError.unsupported("IS NOT must be followed by EMPTY.")
              }
              operation = .isNotEmpty
              index += 1
            } else {
              guard index < tokens.count, tokens[index].uppercased() == "EMPTY" else {
                throw DomainQueryError.unsupported("IS must be followed by EMPTY.")
              }
              operation = .isEmpty
              index += 1
            }
          default:
            throw DomainQueryError.unsupported("Unknown filter operator \(tokens[index]).")
          }
          var value: SupertagValue?
          if operation.needsValue {
            guard index < tokens.count, !isClause(tokens[index]), tokens[index].uppercased() != "AND" else {
              throw DomainQueryError.unsupported("The \(field) filter needs a value.")
            }
            value = try decodeLiteral(tokens[index])
            index += 1
          }
          definition.filters.append(
            LiveQueryFilter(
              fieldID: isSystemField(field) ? nil : .init(rawValue: field),
              systemField: isSystemField(field) ? field.lowercased() : nil,
              operation: operation,
              value: value
            )
          )
          if index < tokens.count, tokens[index].uppercased() == "AND" { index += 1 }
        }
      case "SHOW":
        index += 1
        definition.visibleFieldIDs = []
        while index < tokens.count, !isClause(tokens[index]) {
          let field = tokens[index].trimmingCharacters(in: CharacterSet(charactersIn: ","))
          if !field.isEmpty { definition.visibleFieldIDs.append(.init(rawValue: field)) }
          index += 1
        }
      case "INCLUDE":
        guard index + 1 < tokens.count, tokens[index + 1].uppercased() == "OTHERS" else {
          throw DomainQueryError.unsupported("INCLUDE must be followed by OTHERS.")
        }
        definition.peopleScope = .includeOthers
        index += 2
      case "GROUP":
        guard index + 2 < tokens.count, tokens[index + 1].uppercased() == "BY" else {
          throw DomainQueryError.unsupported("GROUP must be followed by BY and a field.")
        }
        definition.groupFieldID = .init(rawValue: tokens[index + 2])
        index += 3
      case "DATES":
        guard index + 1 < tokens.count else {
          throw DomainQueryError.unsupported("DATES needs a start field.")
        }
        definition.startFieldID = .init(rawValue: tokens[index + 1])
        index += 2
        if index + 1 < tokens.count, tokens[index].uppercased() == "TO" {
          definition.endFieldID = .init(rawValue: tokens[index + 1])
          index += 2
        }
      case "ORDER":
        guard index + 2 < tokens.count, tokens[index + 1].uppercased() == "BY" else {
          throw DomainQueryError.unsupported("ORDER must be followed by BY and a field.")
        }
        index += 2
        definition.sorts = []
        while index < tokens.count, !isClause(tokens[index]) {
          let field = tokens[index].trimmingCharacters(in: CharacterSet(charactersIn: ","))
          index += 1
          let direction = index < tokens.count ? tokens[index].uppercased() : nil
          let hasDirection = direction == "ASC" || direction == "DESC"
          let ascending = direction != "DESC"
          if hasDirection { index += 1 }
          definition.sorts.append(
            .init(
              fieldID: isSystemField(field) ? nil : .init(rawValue: field),
              systemField: isSystemField(field) ? field.lowercased() : nil,
              ascending: ascending
            )
          )
        }
      case "LIMIT":
        guard index + 1 < tokens.count, let limit = Int(tokens[index + 1]), (1...5_000).contains(limit) else {
          throw DomainQueryError.unsupported("LIMIT must be between 1 and 5000.")
        }
        definition.limit = limit
        index += 2
      case "VIEW":
        guard index + 1 < tokens.count, let kind = LiveViewKind(rawValue: tokens[index + 1].lowercased()) else {
          throw DomainQueryError.unsupported("VIEW must be LIST, TABLE, BOARD, CALENDAR, or CANVAS.")
        }
        definition.viewKind = kind
        index += 2
      default:
        throw DomainQueryError.unsupported("Unsupported clause \(tokens[index]).")
      }
    }
    guard definition.viewKind != .canvas || definition.limit <= WhiteboardLimits.maximumPageCards else {
      throw DomainQueryError.unsupported(
        "Canvas views are limited to \(WhiteboardLimits.maximumPageCards) query results."
      )
    }
    return definition
  }

  public static func serialize(_ definition: LiveQueryDefinition) -> String {
    var parts = ["SELECT * FROM \(definition.source.domainName)"]
    if !definition.filters.isEmpty {
      let filters = definition.filters.map { filter in
        let field = filter.systemField ?? filter.fieldID?.rawValue ?? "title"
        switch filter.operation {
        case .equals: return "\(field) = \(encodeLiteral(filter.value))"
        case .notEquals: return "\(field) != \(encodeLiteral(filter.value))"
        case .contains: return "\(field) CONTAINS \(encodeLiteral(filter.value))"
        case .isEmpty: return "\(field) IS EMPTY"
        case .isNotEmpty: return "\(field) IS NOT EMPTY"
        case .before: return "\(field) BEFORE \(encodeLiteral(filter.value))"
        case .after: return "\(field) AFTER \(encodeLiteral(filter.value))"
        }
      }
      parts.append("WHERE \(filters.joined(separator: " AND "))")
    }
    if !definition.visibleFieldIDs.isEmpty {
      parts.append("SHOW \(definition.visibleFieldIDs.map(\.rawValue).joined(separator: ", "))")
    }
    if definition.peopleScope == .includeOthers { parts.append("INCLUDE OTHERS") }
    if let group = definition.groupFieldID { parts.append("GROUP BY \(group.rawValue)") }
    if let start = definition.startFieldID {
      let end = definition.endFieldID.map { " TO \($0.rawValue)" } ?? ""
      parts.append("DATES \(start.rawValue)\(end)")
    }
    if !definition.sorts.isEmpty {
      let sorts = definition.sorts.map { sort in
        let field = sort.systemField ?? sort.fieldID?.rawValue ?? "title"
        return "\(field) \(sort.ascending ? "ASC" : "DESC")"
      }
      parts.append("ORDER BY \(sorts.joined(separator: ", "))")
    }
    parts.append("LIMIT \(definition.limit)")
    parts.append("VIEW \(definition.viewKind.rawValue.uppercased())")
    return parts.joined(separator: " ")
  }

  private static let clauseWords: Set<String> = [
    "WHERE", "SHOW", "INCLUDE", "GROUP", "DATES", "ORDER", "LIMIT", "VIEW",
  ]
  private static let systemFields: Set<String> = ["title", "created", "modified", "kind", "start", "end", "calendar", "source"]

  private static func isClause(_ token: String) -> Bool { clauseWords.contains(token.uppercased()) }
  private static func isSystemField(_ field: String) -> Bool { systemFields.contains(field.lowercased()) }

  private static func encodeLiteral(_ value: SupertagValue?) -> String {
    guard let value else { return quoted("text:") }
    switch value {
    case .text(let value): return quoted("text:\(value)")
    case .number(let value): return quoted("number:\(value)")
    case .boolean(let value): return quoted("boolean:\(value)")
    case .date(let value): return quoted("date:\(value.formatted(.iso8601))")
    case .dateTime(let value): return quoted("dateTime:\(value.formatted(.iso8601))")
    case .select(let value): return quoted("select:\(value)")
    case .url(let value): return quoted("url:\(value)")
    case .email(let value): return quoted("email:\(value)")
    case .phone(let value): return quoted("phone:\(value)")
    case .page(let value): return quoted("page:\(value.rawValue)")
    }
  }

  private static func decodeLiteral(_ token: String) throws -> SupertagValue {
    let pieces = token.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    guard pieces.count == 2 else { return .text(token) }
    let value = String(pieces[1])
    switch pieces[0] {
    case "text": return .text(value)
    case "number":
      guard let number = Double(value) else { throw DomainQueryError.unsupported("Invalid number literal.") }
      return .number(number)
    case "boolean":
      guard let boolean = Bool(value) else { throw DomainQueryError.unsupported("Invalid boolean literal.") }
      return .boolean(boolean)
    case "date":
      guard let date = try? Date.ISO8601FormatStyle().parse(value) else { throw DomainQueryError.unsupported("Invalid date literal.") }
      return .date(date)
    case "dateTime":
      guard let date = try? Date.ISO8601FormatStyle().parse(value) else { throw DomainQueryError.unsupported("Invalid date-time literal.") }
      return .dateTime(date)
    case "select": return .select(value)
    case "url": return .url(value)
    case "email": return .email(value)
    case "phone": return .phone(value)
    case "page": return .page(.init(rawValue: value))
    default: return .text(token)
    }
  }

  private static func quoted(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"") + "\""
  }

  private static func tokenize(_ input: String) -> [String] {
    var tokens: [String] = []
    var current = ""
    var quoted = false
    var escaping = false
    func finish() {
      if !current.isEmpty { tokens.append(current); current = "" }
    }
    for character in input {
      if escaping { current.append(character); escaping = false; continue }
      if quoted && character == "\\" { escaping = true; continue }
      if character == "\"" { quoted.toggle(); continue }
      if !quoted && (character.isWhitespace || character == ",") {
        finish()
      } else {
        current.append(character)
      }
    }
    finish()
    return tokens
  }
}

public enum BuiltInLiveQueries {
  public static let all: [LiveQueryDefinition] = [
    .init(id: .init(rawValue: "view_people"), name: "People", source: .supertag(BuiltInSupertags.person), viewKind: .table,
      visibleFieldIDs: [.init(rawValue: "email"), .init(rawValue: "organization"), .init(rawValue: "role")]),
    .init(id: .init(rawValue: "view_projects"), name: "Projects", source: .supertag(BuiltInSupertags.project), viewKind: .board,
      visibleFieldIDs: [.init(rawValue: "status"), .init(rawValue: "owner"), .init(rawValue: "due-date")],
      groupFieldID: .init(rawValue: "status")),
    .init(id: .init(rawValue: "view_tasks"), name: "Tasks", source: .supertag(BuiltInSupertags.task), viewKind: .board,
      visibleFieldIDs: [.init(rawValue: "status"), .init(rawValue: "project"), .init(rawValue: "scheduled"), .init(rawValue: "deadline")],
      groupFieldID: .init(rawValue: "status")),
    .init(
      id: .init(rawValue: "view_work_calendar"),
      name: "Work Calendar",
      source: .workCalendar,
      sorts: [.init(systemField: "start")],
      viewKind: .calendar
    ),
  ]
}
