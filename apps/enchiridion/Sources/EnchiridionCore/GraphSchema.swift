import Foundation

public enum GraphValueType: String, Codable, CaseIterable, Hashable, Sendable {
  case text
  case number
  case boolean
  case localDate
  case dateTime
  case select
  case url
  case email
  case phone
}

public enum GraphFactValue: Codable, Hashable, Sendable {
  case text(String)
  case number(Double)
  case boolean(Bool)
  case localDate(LocalDate)
  case dateTime(Date)
  case select(String)
  case url(String)
  case email(String)
  case phone(String)

  public var type: GraphValueType {
    switch self {
    case .text: .text
    case .number: .number
    case .boolean: .boolean
    case .localDate: .localDate
    case .dateTime: .dateTime
    case .select: .select
    case .url: .url
    case .email: .email
    case .phone: .phone
    }
  }

  public var displayValue: String {
    switch self {
    case .text(let value), .select(let value), .url(let value), .email(let value),
      .phone(let value): value
    case .number(let value): value.formatted()
    case .boolean(let value): value ? "Yes" : "No"
    case .localDate(let value): value.rawValue
    case .dateTime(let value): value.formatted(date: .abbreviated, time: .shortened)
    }
  }
}

public enum GraphFactOrigin: String, Codable, Hashable, Sendable {
  case user
  case provider
  case system
}

public struct KnowledgeFact: Codable, Hashable, Sendable, Identifiable {
  public var id: FactID
  public var nodeID: NodeID
  public var predicateID: PredicateID
  public var value: GraphFactValue
  public var origin: GraphFactOrigin
  public var createdAt: Date

  public init(
    id: FactID = .random(),
    nodeID: NodeID,
    predicateID: PredicateID,
    value: GraphFactValue,
    origin: GraphFactOrigin = .user,
    createdAt: Date = Date()
  ) {
    self.id = id
    self.nodeID = nodeID
    self.predicateID = predicateID
    self.value = value
    self.origin = origin
    self.createdAt = createdAt
  }
}

public enum EndpointMaximum: String, Codable, CaseIterable, Hashable, Sendable {
  case one
  case many
}

public struct RelationCardinality: Codable, Hashable, Sendable {
  /// Maximum outgoing targets allowed for one source node.
  public var targetsPerSource: EndpointMaximum
  /// Maximum incoming sources allowed for one target node.
  public var sourcesPerTarget: EndpointMaximum

  public init(
    targetsPerSource: EndpointMaximum,
    sourcesPerTarget: EndpointMaximum
  ) {
    self.targetsPerSource = targetsPerSource
    self.sourcesPerTarget = sourcesPerTarget
  }

  public static let oneToOne = Self(targetsPerSource: .one, sourcesPerTarget: .one)
  public static let manyToOne = Self(targetsPerSource: .one, sourcesPerTarget: .many)
  public static let oneToMany = Self(targetsPerSource: .many, sourcesPerTarget: .one)
  public static let manyToMany = Self(targetsPerSource: .many, sourcesPerTarget: .many)
}

public struct RelationDefinition: Codable, Hashable, Sendable, Identifiable {
  public var id: RelationID
  public var sourceTagIDs: [TagID]
  public var targetTagIDs: [TagID]
  public var forwardName: String
  public var inverseName: String
  public var cardinality: RelationCardinality
  public var isSystem: Bool
  public var isDeleted: Bool

  public init(
    id: RelationID,
    sourceTagIDs: [TagID] = [],
    targetTagIDs: [TagID] = [],
    forwardName: String,
    inverseName: String,
    cardinality: RelationCardinality = .manyToMany,
    isSystem: Bool = false,
    isDeleted: Bool = false
  ) {
    self.id = id
    self.sourceTagIDs = sourceTagIDs
    self.targetTagIDs = targetTagIDs
    self.forwardName = forwardName
    self.inverseName = inverseName
    self.cardinality = cardinality
    self.isSystem = isSystem
    self.isDeleted = isDeleted
  }
}

public enum GraphEdgeOrigin: String, Codable, Hashable, Sendable {
  case user
  case inlineReference
  case provider
  case system
}

public struct KnowledgeEdge: Codable, Hashable, Sendable, Identifiable {
  public var id: EdgeID
  public var relationID: RelationID
  public var sourceNodeID: NodeID
  public var targetNodeID: NodeID
  public var origin: GraphEdgeOrigin
  public var createdAt: Date

  public init(
    id: EdgeID = .random(),
    relationID: RelationID,
    sourceNodeID: NodeID,
    targetNodeID: NodeID,
    origin: GraphEdgeOrigin = .user,
    createdAt: Date = Date()
  ) {
    self.id = id
    self.relationID = relationID
    self.sourceNodeID = sourceNodeID
    self.targetNodeID = targetNodeID
    self.origin = origin
    self.createdAt = createdAt
  }
}

public struct GraphBacklink: Codable, Hashable, Sendable, Identifiable {
  public var edge: KnowledgeEdge
  public var relation: RelationDefinition
  public var sourceTitle: String
  public var id: EdgeID { edge.id }
}

public enum GraphIssueKind: String, Codable, CaseIterable, Hashable, Sendable {
  case cardinalityViolation
  case unresolvedTarget
  case invalidTargetType
  case inheritanceCycle
}

public struct GraphIssue: Codable, Hashable, Sendable, Identifiable {
  public var id: GraphIssueID
  public var kind: GraphIssueKind
  public var nodeID: NodeID
  public var edgeID: EdgeID?
  public var relationID: RelationID?
  public var message: String
  public var createdAt: Date

  public init(
    id: GraphIssueID,
    kind: GraphIssueKind,
    nodeID: NodeID,
    edgeID: EdgeID? = nil,
    relationID: RelationID? = nil,
    message: String,
    createdAt: Date = Date()
  ) {
    self.id = id
    self.kind = kind
    self.nodeID = nodeID
    self.edgeID = edgeID
    self.relationID = relationID
    self.message = message
    self.createdAt = createdAt
  }
}
