import Foundation

/// A property inherited through a supertag hierarchy without losing the schema that owns it.
///
/// A field's identity is its complete property key, rather than its local field identifier. This
/// permits, for example, `person.email` and `customer.email` to coexist in one effective schema.
public struct SupertagEffectiveField: Hashable, Sendable, Identifiable {
  public let propertyKey: SupertagPropertyKey
  public let definition: SupertagFieldDefinition

  public var id: SupertagPropertyKey { propertyKey }

  public init(propertyKey: SupertagPropertyKey, definition: SupertagFieldDefinition) {
    self.propertyKey = propertyKey
    self.definition = definition
  }

  public static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.propertyKey == rhs.propertyKey
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(propertyKey)
  }
}

public enum SupertagInheritance {
  public static func effectiveTagIDs(
    for directTagIDs: Set<TagID>,
    definitions: [SupertagDefinition]
  ) -> Set<TagID> {
    let definitionsByID = definitions.reduce(into: [TagID: SupertagDefinition]()) {
      $0[$1.id] = $1
    }
    var effectiveTagIDs = directTagIDs
    var pendingTagIDs = Array(directTagIDs)

    while let tagID = pendingTagIDs.popLast() {
      guard let definition = definitionsByID[tagID] else { continue }
      for parentID in definition.parentIDs where effectiveTagIDs.insert(parentID).inserted {
        pendingTagIDs.append(parentID)
      }
    }
    return effectiveTagIDs
  }

  /// Resolves the scalar and reference fields available to one selected supertag.
  ///
  /// Parents are traversed in their declared order before the child. Each live schema is visited
  /// once, which makes diamond inheritance and malformed cycles deterministic without duplicating
  /// an ancestor's fields. Deleted field definitions remain present so downstream validation can
  /// reject them explicitly; field ownership remains the schema in which each field was declared.
  public static func effectiveFields(
    for selectedTagID: SupertagID,
    definitions: [SupertagDefinition]
  ) -> [SupertagEffectiveField] {
    let definitionsByID = definitions.reduce(into: [SupertagID: SupertagDefinition]()) {
      $0[$1.id] = $1
    }
    var visited = Set<SupertagID>()
    var visiting = Set<SupertagID>()
    var fields: [SupertagEffectiveField] = []

    func visit(_ tagID: SupertagID) {
      guard !visited.contains(tagID), !visiting.contains(tagID),
        let definition = definitionsByID[tagID], !definition.isDeleted
      else { return }

      visiting.insert(tagID)
      for parentID in definition.parentIDs {
        visit(parentID)
      }
      visiting.remove(tagID)
      visited.insert(tagID)
      fields.append(contentsOf: definition.fields.map {
        SupertagEffectiveField(
          propertyKey: .init(supertagID: definition.id, fieldID: $0.id),
          definition: $0
        )
      })
    }

    visit(selectedTagID)
    return fields
  }
}

public enum BuiltInRelations {
  public static let personOrganization = RelationID(rawValue: "person.organization")
  public static let projectArea = RelationID(rawValue: "project.area")
  public static let projectOwners = RelationID(rawValue: "project.owners")
  public static let projectOrganization = RelationID(rawValue: "project.organization")
  public static let projectPlace = RelationID(rawValue: "project.place")
  public static let taskProject = RelationID(rawValue: "task.project")
  public static let taskArea = RelationID(rawValue: "task.area")
  public static let taskParent = RelationID(rawValue: "task.parent")
  public static let taskAssignees = RelationID(rawValue: "task.assignees")
  public static let eventOrganizer = RelationID(rawValue: "event.organizer")
  public static let eventAttendees = RelationID(rawValue: "event.attendees")
  public static let eventPlace = RelationID(rawValue: "event.place")
  public static let mentions = RelationID(rawValue: "system.mentions")

  public static let all: [RelationDefinition] = [
    relation(personOrganization, [BuiltInSupertags.person], [BuiltInSupertags.organization], "organization", "people", .manyToOne),
    relation(projectArea, [BuiltInSupertags.project], [BuiltInSupertags.area], "area", "projects", .manyToOne),
    relation(projectOwners, [BuiltInSupertags.project], [BuiltInSupertags.person], "owners", "owned projects", .manyToMany),
    relation(projectOrganization, [BuiltInSupertags.project], [BuiltInSupertags.organization], "organization", "projects", .manyToOne),
    relation(projectPlace, [BuiltInSupertags.project], [BuiltInSupertags.place], "place", "projects", .manyToOne),
    relation(taskProject, [BuiltInSupertags.task], [BuiltInSupertags.project], "project", "tasks", .manyToOne),
    relation(taskArea, [BuiltInSupertags.task], [BuiltInSupertags.area], "area", "tasks", .manyToOne),
    relation(taskParent, [BuiltInSupertags.task], [BuiltInSupertags.task], "parent", "subtasks", .manyToOne),
    relation(taskAssignees, [BuiltInSupertags.task], [BuiltInSupertags.person], "assignees", "assigned tasks", .manyToMany),
    relation(eventOrganizer, [BuiltInSupertags.event], [BuiltInSupertags.person], "organizer", "organized events", .manyToOne),
    relation(eventAttendees, [BuiltInSupertags.event], [BuiltInSupertags.person], "attendees", "events", .manyToMany),
    relation(eventPlace, [BuiltInSupertags.event], [BuiltInSupertags.place], "place", "events", .manyToOne),
    relation(mentions, [], [], "mentions", "mentioned by", .manyToMany),
  ]

  public static func relationID(for key: SupertagPropertyKey) -> RelationID {
    let pair = "\(key.supertagID.rawValue).\(key.fieldID.rawValue)"
    return switch pair {
    case "person.organization": personOrganization
    case "project.area": projectArea
    case "project.owner": projectOwners
    case "project.organization": projectOrganization
    case "project.place": projectPlace
    case "task.project": taskProject
    case "task.area": taskArea
    case "task.parent": taskParent
    case "task.assignee": taskAssignees
    case "event.organizer": eventOrganizer
    case "event.attendees": eventAttendees
    case "event.place": eventPlace
    default: .init(rawValue: "property-relation:\(key.supertagID.rawValue):\(key.fieldID.rawValue)")
    }
  }

  public static func propertyKey(for relationID: RelationID) -> SupertagPropertyKey? {
    switch relationID {
    case personOrganization: return .init(supertagID: BuiltInSupertags.person, fieldID: .init(rawValue: "organization"))
    case projectArea: return .init(supertagID: BuiltInSupertags.project, fieldID: .init(rawValue: "area"))
    case projectOwners: return .init(supertagID: BuiltInSupertags.project, fieldID: .init(rawValue: "owner"))
    case projectOrganization: return .init(supertagID: BuiltInSupertags.project, fieldID: .init(rawValue: "organization"))
    case projectPlace: return .init(supertagID: BuiltInSupertags.project, fieldID: .init(rawValue: "place"))
    case taskProject: return .init(supertagID: BuiltInSupertags.task, fieldID: .init(rawValue: "project"))
    case taskArea: return .init(supertagID: BuiltInSupertags.task, fieldID: .init(rawValue: "area"))
    case taskParent: return .init(supertagID: BuiltInSupertags.task, fieldID: .init(rawValue: "parent"))
    case taskAssignees: return .init(supertagID: BuiltInSupertags.task, fieldID: .init(rawValue: "assignee"))
    case eventOrganizer: return .init(supertagID: BuiltInSupertags.event, fieldID: .init(rawValue: "organizer"))
    case eventAttendees: return .init(supertagID: BuiltInSupertags.event, fieldID: .init(rawValue: "attendees"))
    case eventPlace: return .init(supertagID: BuiltInSupertags.event, fieldID: .init(rawValue: "place"))
    default:
      guard relationID.rawValue.hasPrefix("property-relation:") else { return nil }
      let parts = relationID.rawValue.split(separator: ":", omittingEmptySubsequences: false)
      guard parts.count == 3 else { return nil }
      return .init(
        supertagID: .init(rawValue: String(parts[1])),
        fieldID: .init(rawValue: String(parts[2]))
      )
    }
  }

  private static func relation(
    _ id: RelationID,
    _ sources: [TagID],
    _ targets: [TagID],
    _ forward: String,
    _ inverse: String,
    _ cardinality: RelationCardinality
  ) -> RelationDefinition {
    .init(
      id: id,
      sourceTagIDs: sources,
      targetTagIDs: targets,
      forwardName: forward,
      inverseName: inverse,
      cardinality: cardinality,
      isSystem: true
    )
  }
}
