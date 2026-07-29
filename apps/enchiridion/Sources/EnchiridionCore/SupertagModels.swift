import Foundation

public struct SupertagID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }

  public init(rawValue: String) { self.rawValue = rawValue }
  public static func random() -> Self {
    .init(rawValue: "tag-\(UUID().uuidString.lowercased())")
  }
}

public struct SupertagFieldID: RawRepresentable, Codable, Hashable, Sendable, Identifiable {
  public let rawValue: String
  public var id: String { rawValue }
  public init(rawValue: String) { self.rawValue = rawValue }
}

public enum SupertagFieldType: String, Codable, CaseIterable, Hashable, Sendable {
  case text, number, boolean, date, dateTime, select, url, email, phone, entityReference

  public var title: String {
    switch self {
    case .text: "Text"
    case .number: "Number"
    case .boolean: "Checkbox"
    case .date: "Date"
    case .dateTime: "Date & Time"
    case .select: "Select"
    case .url: "URL"
    case .email: "Email"
    case .phone: "Phone"
    case .entityReference: "Reference"
    }
  }
}

public struct SupertagSelectOption: Identifiable, Codable, Hashable, Sendable {
  public var id: String
  public var name: String
  public var color: String

  public init(id: String, name: String, color: String = "blue") {
    self.id = id
    self.name = name
    self.color = color
  }
}

public struct SupertagFieldDefinition: Identifiable, Codable, Hashable, Sendable {
  public var id: SupertagFieldID
  public var name: String
  public var type: SupertagFieldType
  public var allowsMultiple: Bool
  public var isRequired: Bool
  public var isMultiline: Bool
  public var options: [SupertagSelectOption]
  public var allowedSupertagIDs: [SupertagID]
  public var isDeleted: Bool

  public init(
    id: SupertagFieldID,
    name: String,
    type: SupertagFieldType,
    allowsMultiple: Bool = false,
    isRequired: Bool = false,
    isMultiline: Bool = false,
    options: [SupertagSelectOption] = [],
    allowedSupertagIDs: [SupertagID] = [],
    isDeleted: Bool = false
  ) {
    self.id = id
    self.name = name
    self.type = type
    self.allowsMultiple = allowsMultiple
    self.isRequired = isRequired
    self.isMultiline = isMultiline
    self.options = options
    self.allowedSupertagIDs = allowedSupertagIDs
    self.isDeleted = isDeleted
  }
}

public struct SupertagDefinition: Identifiable, Codable, Hashable, Sendable {
  public var id: SupertagID
  public var name: String
  public var symbol: String
  public var fields: [SupertagFieldDefinition]
  public var isBuiltIn: Bool
  public var isDeleted: Bool

  public init(
    id: SupertagID,
    name: String,
    symbol: String,
    fields: [SupertagFieldDefinition],
    isBuiltIn: Bool = false,
    isDeleted: Bool = false
  ) {
    self.id = id
    self.name = name
    self.symbol = symbol
    self.fields = fields
    self.isBuiltIn = isBuiltIn
    self.isDeleted = isDeleted
  }

  public static func draft(name: String = "New Supertag") -> Self {
    .init(id: .random(), name: name, symbol: "number", fields: [])
  }
}

public enum SupertagValue: Codable, Hashable, Sendable, Identifiable {
  case text(String)
  case number(Double)
  case boolean(Bool)
  case date(Date)
  case dateTime(Date)
  case select(String)
  case url(String)
  case email(String)
  case phone(String)
  case page(PageID)

  public var id: String {
    switch self {
    case .text(let value): "text:\(value)"
    case .number(let value): "number:\(value)"
    case .boolean(let value): "boolean:\(value)"
    case .date(let value): "date:\(value.timeIntervalSince1970)"
    case .dateTime(let value): "dateTime:\(value.timeIntervalSince1970)"
    case .select(let value): "select:\(value)"
    case .url(let value): "url:\(value)"
    case .email(let value): "email:\(value.lowercased())"
    case .phone(let value): "phone:\(value)"
    case .page(let value): "page:\(value.rawValue)"
    }
  }

  public var displayValue: String {
    switch self {
    case .text(let value), .select(let value), .url(let value), .email(let value), .phone(let value): value
    case .number(let value): value.formatted()
    case .boolean(let value): value ? "Yes" : "No"
    case .date(let value): value.formatted(date: .abbreviated, time: .omitted)
    case .dateTime(let value): value.formatted(date: .abbreviated, time: .shortened)
    case .page(let value): value.rawValue
    }
  }
}

public struct SupertagPropertyKey: Codable, Hashable, Sendable {
  public var supertagID: SupertagID
  public var fieldID: SupertagFieldID

  public init(supertagID: SupertagID, fieldID: SupertagFieldID) {
    self.supertagID = supertagID
    self.fieldID = fieldID
  }

  var storageKey: String { "\(supertagID.rawValue):\(fieldID.rawValue)" }
}

public struct SupertagConflict: Codable, Hashable, Sendable, Identifiable {
  public var key: SupertagPropertyKey
  public var candidates: [[SupertagValue]]
  public var id: String { key.storageKey }
}

public struct PageObjectMetadata: Codable, Hashable, Sendable {
  public var supertagIDs: [SupertagID]
  public var properties: [SupertagPropertyKey: [SupertagValue]]
  public var conflicts: [SupertagConflict]
  public var personVisibility: PersonVisibility?
  public var personOrigin: PersonOrigin?

  public init(
    supertagIDs: [SupertagID] = [],
    properties: [SupertagPropertyKey: [SupertagValue]] = [:],
    conflicts: [SupertagConflict] = [],
    personVisibility: PersonVisibility? = nil,
    personOrigin: PersonOrigin? = nil
  ) {
    self.supertagIDs = supertagIDs
    self.properties = properties
    self.conflicts = conflicts
    self.personVisibility = personVisibility
    self.personOrigin = personOrigin
  }
}

public enum BuiltInSupertags {
  public static let person = SupertagID(rawValue: "person")
  public static let organization = SupertagID(rawValue: "organization")
  public static let area = SupertagID(rawValue: "area")
  public static let project = SupertagID(rawValue: "project")
  public static let task = SupertagID(rawValue: "task")
  public static let place = SupertagID(rawValue: "place")

  public static let all: [SupertagDefinition] = [
    definition(person, "Person", "person.crop.circle", [
      field("email", "Email", .email, many: true),
      field("phone", "Phone", .phone, many: true),
      field("organization", "Organization", .entityReference, allowed: [organization]),
      field("role", "Role", .text),
      field("birthday", "Birthday", .date),
      field("relationship-notes", "Relationship notes", .text, multiline: true),
    ]),
    definition(organization, "Organization", "building.2", [
      field("website", "Website", .url),
      field("domain", "Domain", .text),
      selectField("relationship", "Relationship", ["Prospect", "Active", "Partner", "Former"]),
      field("notes", "Notes", .text, multiline: true),
    ]),
    definition(area, "Area", "square.grid.2x2", [
      selectField("status", "Status", ["Active", "On Hold", "Archived"]),
      field("notes", "Notes", .text, multiline: true),
    ]),
    definition(project, "Project", "folder", [
      selectField("status", "Status", ["Idea", "Planned", "Active", "On Hold", "Completed", "Cancelled"]),
      field("area", "Area", .entityReference, allowed: [area]),
      field("owner", "Owner", .entityReference, many: true, allowed: [person]),
      field("organization", "Organization", .entityReference, allowed: [organization]),
      field("start-date", "Start date", .date),
      field("due-date", "Due date", .date),
      field("place", "Place", .entityReference, allowed: [place]),
      field("notes", "Notes", .text, multiline: true),
    ]),
    definition(task, "Task", "checkmark.circle", [
      selectField("status", "Status", ["To do", "In progress", "Blocked", "Done", "Cancelled"]),
      selectField("placement", "List", ["Inbox", "Anytime", "Someday"]),
      field("scheduled", "When", .dateTime),
      field("deadline", "Deadline", .date),
      field("reminder", "Reminder", .dateTime),
      field("project", "Project", .entityReference, allowed: [project]),
      field("area", "Area", .entityReference, allowed: [area]),
      field("parent", "Parent task", .entityReference, allowed: [task]),
      field("assignee", "Assignee", .entityReference, many: true, allowed: [person]),
      field("tags", "Tags", .text, many: true),
      selectField("priority", "Priority", ["Low", "Medium", "High", "Urgent"]),
      field("recurrence", "Repeat", .text),
      field("estimated-minutes", "Estimate (minutes)", .number),
      field("completed-at", "Completed at", .dateTime),
      field("due", "Due (legacy)", .dateTime),
      field("notes", "Notes", .text, multiline: true),
    ]),
    definition(place, "Place", "mappin.and.ellipse", [
      field("address", "Address", .text, multiline: true),
      field("map-url", "Map URL", .url),
      field("time-zone", "Time zone", .text),
      field("notes", "Notes", .text, multiline: true),
    ]),
  ]

  private static func definition(
    _ id: SupertagID, _ name: String, _ symbol: String, _ fields: [SupertagFieldDefinition]
  ) -> SupertagDefinition {
    SupertagDefinition(id: id, name: name, symbol: symbol, fields: fields, isBuiltIn: true)
  }

  private static func field(
    _ id: String,
    _ name: String,
    _ type: SupertagFieldType,
    many: Bool = false,
    multiline: Bool = false,
    allowed: [SupertagID] = []
  ) -> SupertagFieldDefinition {
    SupertagFieldDefinition(
      id: .init(rawValue: id), name: name, type: type, allowsMultiple: many,
      isMultiline: multiline, allowedSupertagIDs: allowed)
  }

  private static func selectField(_ id: String, _ name: String, _ values: [String]) -> SupertagFieldDefinition {
    SupertagFieldDefinition(
      id: .init(rawValue: id), name: name, type: .select,
      options: values.map { value in
        SupertagSelectOption(
          id: value.lowercased().replacingOccurrences(of: " ", with: "-"), name: value)
      })
  }
}

public struct SupertagCollection: Identifiable, Hashable, Sendable {
  public var definition: SupertagDefinition
  public var pages: [PageSnapshot]
  public var id: SupertagID { definition.id }
}
