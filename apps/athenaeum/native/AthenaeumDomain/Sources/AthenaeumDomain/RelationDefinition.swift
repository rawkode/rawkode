import Foundation

/// Mirrors `packages/domain/src/relation-definition.ts`'s `RelationCardinality` literal union.
/// Raw values match the TS string literals exactly (`"one-to-one"` etc.) so JSON round-trips
/// unchanged.
public enum RelationCardinality: String, Codable, Hashable, Sendable {
    case oneToOne = "one-to-one"
    case oneToMany = "one-to-many"
    case manyToOne = "many-to-one"
    case manyToMany = "many-to-many"
}

/// Mirrors `relation-definition.ts`'s `RelationDefinition` — the typed schema for an edge kind
/// (e.g. forward "employs" / inverse "employed by", source tag Company, target tag Person,
/// cardinality one-to-many). `Edge` rows (see Edge.swift) are instances of one of these.
public struct RelationDefinition: Codable, Hashable, Sendable {
    public let id: EntityId
    public let forwardName: String
    public let inverseName: String
    public let sourceTagId: EntityId
    public let targetTagId: EntityId
    public let cardinality: RelationCardinality

    public init(
        id: EntityId,
        forwardName: String,
        inverseName: String,
        sourceTagId: EntityId,
        targetTagId: EntityId,
        cardinality: RelationCardinality
    ) {
        self.id = id
        self.forwardName = forwardName
        self.inverseName = inverseName
        self.sourceTagId = sourceTagId
        self.targetTagId = targetTagId
        self.cardinality = cardinality
    }
}
