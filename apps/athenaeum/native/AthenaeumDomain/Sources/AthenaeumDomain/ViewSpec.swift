import Foundation

// Mirrors `packages/domain/src/view-spec.ts` — see that file's own extensive doc comment for the
// predicate-tree design rationale (leaf ops target a `FieldRef` — either a physical `column` or a
// `Fact.predicateId` — combined with `and`/`or`; `hasTag` is its own op, not an `eq` over a
// synthetic column, because tag membership is a set-membership test against `tagClosure`).
//
// `ViewPredicate`/`FieldRef` are TS `Schema.Union`s of `Schema.Struct`s (tagged by a `kind`/`op`
// discriminant field), not `Schema.Class`es — the Swift mirror is a tagged `indirect enum` with
// custom `Codable` implementing the identical `{kind: "column", column}` /
// `{op: "eq", field, value}` wire shape, since Swift's enum-with-associated-values has no default
// JSON encoding that matches a discriminant-plus-payload-fields object shape.

/// Mirrors `view-spec.ts`'s `FieldRef`: `{kind: "column", column} | {kind: "fact", predicateId}`.
public enum FieldRef: Hashable, Sendable {
    case column(String)
    case fact(predicateId: String)
}

extension FieldRef: Codable {
    private enum CodingKeys: String, CodingKey {
        case kind, column, predicateId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "column":
            self = .column(try container.decode(String.self, forKey: .column))
        case "fact":
            self = .fact(predicateId: try container.decode(String.self, forKey: .predicateId))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "FieldRef.kind must be \"column\" or \"fact\", got: \(kind)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .column(let column):
            try container.encode("column", forKey: .kind)
            try container.encode(column, forKey: .column)
        case .fact(let predicateId):
            try container.encode("fact", forKey: .kind)
            try container.encode(predicateId, forKey: .predicateId)
        }
    }
}

/// Mirrors `view-spec.ts`'s `ViewPredicate` recursive union:
/// `eq | in | hasTag | and | or`. `tagId` decodes/encodes as a plain `EntityId` (the *decoded*
/// TS-side shape — `ViewPredicate`, not `ViewPredicateEncoded`, since `EntityId`'s wire form is
/// already a plain string either way).
public indirect enum ViewPredicate: Hashable, Sendable {
    case eq(field: FieldRef, value: JSONValue)
    case `in`(field: FieldRef, values: [JSONValue])
    case hasTag(tagId: EntityId)
    case and([ViewPredicate])
    case or([ViewPredicate])
}

extension ViewPredicate: Codable {
    private enum CodingKeys: String, CodingKey {
        case op, field, value, values, tagId, predicates
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let op = try container.decode(String.self, forKey: .op)
        switch op {
        case "eq":
            self = .eq(
                field: try container.decode(FieldRef.self, forKey: .field),
                value: try container.decode(JSONValue.self, forKey: .value)
            )
        case "in":
            self = .in(
                field: try container.decode(FieldRef.self, forKey: .field),
                values: try container.decode([JSONValue].self, forKey: .values)
            )
        case "hasTag":
            self = .hasTag(tagId: try container.decode(EntityId.self, forKey: .tagId))
        case "and":
            self = .and(try container.decode([ViewPredicate].self, forKey: .predicates))
        case "or":
            self = .or(try container.decode([ViewPredicate].self, forKey: .predicates))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .op,
                in: container,
                debugDescription: "ViewPredicate.op must be one of eq/in/hasTag/and/or, got: \(op)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .eq(let field, let value):
            try container.encode("eq", forKey: .op)
            try container.encode(field, forKey: .field)
            try container.encode(value, forKey: .value)
        case .in(let field, let values):
            try container.encode("in", forKey: .op)
            try container.encode(field, forKey: .field)
            try container.encode(values, forKey: .values)
        case .hasTag(let tagId):
            try container.encode("hasTag", forKey: .op)
            try container.encode(tagId, forKey: .tagId)
        case .and(let predicates):
            try container.encode("and", forKey: .op)
            try container.encode(predicates, forKey: .predicates)
        case .or(let predicates):
            try container.encode("or", forKey: .op)
            try container.encode(predicates, forKey: .predicates)
        }
    }
}

/// Mirrors `view-spec.ts`'s `GraphViewName` — the fixed, authorizer-restricted read-only view set
/// carried forward from Enchiridion's `GraphDataModel.md`.
public enum GraphViewName: String, Codable, Hashable, Sendable {
    case graphNodes = "graph_nodes"
    case graphTags = "graph_tags"
    case graphTagParents = "graph_tag_parents"
    case graphTagClosure = "graph_tag_closure"
    case graphNodeTags = "graph_node_tags"
    case graphFacts = "graph_facts"
    case graphRelationDefinitions = "graph_relation_definitions"
    case graphEdges = "graph_edges"
    case graphIssues = "graph_issues"
    case graphTextSearch = "graph_text_search"
}

/// Mirrors `view-spec.ts`'s `ViewSpec.view` rendering-mode literal (`"table"|"list"|"board"`) —
/// distinct from `GraphViewName` (see `graph-rpc.ts`'s `RunViewInput` doc comment: one is *which*
/// SQL view is queried, the other is a UI rendering mode).
public enum ViewRenderMode: String, Codable, Hashable, Sendable {
    case table, list, board
}

/// Mirrors `view-spec.ts`'s `ViewSpec` — filter predicate tree, `groupBy`, sort, rendering mode,
/// `visibleColumns`, bounded `rowLimit`. Optional TS fields (`Schema.optional`) map to Swift
/// `Optional` stored properties; the compiler-synthesized `Codable` conformance already omits an
/// absent key on encode and tolerates a missing key on decode for `Optional`-typed stored
/// properties, matching `Schema.optional`'s wire behavior exactly with no custom code needed.
public struct ViewSpec: Codable, Hashable, Sendable {
    public let filter: ViewPredicate?
    public let groupBy: String?
    public let sortColumn: String?
    public let sortDescending: Bool?
    public let view: ViewRenderMode
    public let visibleColumns: [String]
    public let rowLimit: Int

    public init(
        filter: ViewPredicate? = nil,
        groupBy: String? = nil,
        sortColumn: String? = nil,
        sortDescending: Bool? = nil,
        view: ViewRenderMode,
        visibleColumns: [String],
        rowLimit: Int
    ) {
        self.filter = filter
        self.groupBy = groupBy
        self.sortColumn = sortColumn
        self.sortDescending = sortDescending
        self.view = view
        self.visibleColumns = visibleColumns
        self.rowLimit = rowLimit
    }
}
