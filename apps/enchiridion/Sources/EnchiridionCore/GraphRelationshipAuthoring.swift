import Foundation

public enum GraphRelationshipDirection: String, Codable, Hashable, Sendable {
  case forward
  case inverse
}

/// Describes a relationship from the page currently being presented. The
/// persisted edge always retains the relation definition's canonical direction.
public struct GraphRelationshipAuthoringIntent: Hashable, Sendable {
  public var relation: RelationDefinition
  public var presentedSourceID: PageID
  public var direction: GraphRelationshipDirection
  public var compatibleTargetTypeIDs: [SupertagID]

  public init(
    relation: RelationDefinition,
    presentedSourceID: PageID,
    direction: GraphRelationshipDirection,
    compatibleTargetTypeIDs: [SupertagID]
  ) {
    self.relation = relation
    self.presentedSourceID = presentedSourceID
    self.direction = direction
    self.compatibleTargetTypeIDs = compatibleTargetTypeIDs
  }

  public func canonicalEndpoints(selectedTargetID: PageID) -> (source: PageID, target: PageID) {
    switch direction {
    case .forward: (presentedSourceID, selectedTargetID)
    case .inverse: (selectedTargetID, presentedSourceID)
    }
  }
}

public enum ExistingPersonResolution: Hashable, Sendable {
  /// Legacy selection payload. It is deliberately rejected by the repository because it cannot
  /// prove which email the person was selected for.
  case useExisting(PageID)

  /// The caller explicitly chose an already-existing Person for this normalized-email lookup.
  /// The repository normalizes and revalidates the email and selected page in the same write
  /// transaction, so an asynchronous picker cannot link a stale or unrelated Person.
  case useExistingMatchingEmail(pageID: PageID, matchingEmail: String)
}

public struct CreateEntityAndRelationshipRequest: Sendable {
  public var intent: GraphRelationshipAuthoringIntent
  public var selectedTargetTypeID: SupertagID
  public var title: String
  public var initialProperties: [SupertagPropertyKey: [SupertagValue]]
  public var existingPersonResolution: ExistingPersonResolution?

  public init(
    intent: GraphRelationshipAuthoringIntent,
    selectedTargetTypeID: SupertagID,
    title: String,
    initialProperties: [SupertagPropertyKey: [SupertagValue]] = [:],
    existingPersonResolution: ExistingPersonResolution? = nil
  ) {
    self.intent = intent
    self.selectedTargetTypeID = selectedTargetTypeID
    self.title = title
    self.initialProperties = initialProperties
    self.existingPersonResolution = existingPersonResolution
  }
}

public struct EntityRelationshipMutationReceipt: Sendable {
  public var entity: PageSnapshot
  public var edge: KnowledgeEdge
  public var canonicalSourceID: PageID
  public var canonicalTargetID: PageID
  public var changedPageIDs: [PageID]

  public init(
    entity: PageSnapshot,
    edge: KnowledgeEdge,
    canonicalSourceID: PageID,
    canonicalTargetID: PageID,
    changedPageIDs: [PageID]
  ) {
    self.entity = entity
    self.edge = edge
    self.canonicalSourceID = canonicalSourceID
    self.canonicalTargetID = canonicalTargetID
    self.changedPageIDs = changedPageIDs
  }
}

public enum GraphRelationshipAuthoringError: Error, Equatable, LocalizedError {
  case invalidTitle
  case incompatibleType
  case invalidProperties
  case personSelectionRequired
  case invalidPersonSelection

  public var errorDescription: String? {
    switch self {
    case .invalidTitle: "The new entity needs a name."
    case .incompatibleType: "That entity type cannot be used for this relationship."
    case .invalidProperties: "The new entity contains an invalid property."
    case .personSelectionRequired: "Choose the existing Person with this email before linking."
    case .invalidPersonSelection: "The selected Person no longer matches this email."
    }
  }
}
