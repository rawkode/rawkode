import Foundation
import AthenaeumDomain

// Genuine cross-cutting addition, confined to `native/AthenaeumRPC` (the Decisions stage's own
// resolved transport package) — NOT a new stage-owned file duplicating dispatch logic against
// `packages/backend`. The Decisions stage's `WorkspaceRPCClient.swift` deliberately scoped itself to
// "every method `WorkspaceRpcApi` exposes today except... the remaining graph-mutation methods
// (`createTag`, `addFact`, `createRelationDefinition`, `createEdge`, `assignTag`,
// `listGraphIssues`, `listTagClosure`, `searchNodes`), which follow the exact same
// `call(_:args:)` pattern below and were left for whichever stage first needs them rather than
// mirrored speculatively" — that doc comment names this file's job exactly. `AthenaeumCore`'s
// `LocalWorkspaceStore` (Nodes/Pages/Tags/Facts/Edges local authority) needs a real server-side
// counterpart for Tags/Facts/Edges, not just Nodes/Pages, to be a genuine sync client rather than
// a partial one — this file is that minimal, mechanical extension, same file/pattern the
// Decisions stage already anticipated, not a redesign.

/// Mirrors `packages/domain/src/tag.ts`'s `Tag`.
public struct RPCTag: Sendable, Equatable {
    public let id: String
    public let name: String
    public let parentIds: [String]
    public let builtin: Bool

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let name = try value.field("name").stringValue,
              let builtin = try value.field("builtin").boolValue
        else { throw CapnWebError.malformedMessage("malformed Tag: \(value)") }
        self.id = id
        self.name = name
        self.parentIds = try (value.field("parentIds").arrayValue ?? []).compactMap(\.stringValue)
        self.builtin = builtin
    }
}

/// Mirrors `packages/domain/src/tag-field-definition.ts`'s `TagFieldValueKind`.
public enum RPCTagFieldValueKind: String, Sendable, Equatable {
    case text
    case number
    case date
    case checkbox
    case entityRef = "entity-ref"
}

/// Mirrors `packages/domain/src/tag-field-definition.ts`'s `TagFieldDefinition`.
public struct RPCTagFieldDefinition: Sendable, Equatable, Identifiable {
    public let id: String
    public let tagId: String
    public let name: String
    public let valueKind: RPCTagFieldValueKind
    public let sortOrder: Int
    public let builtin: Bool

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let tagId = try value.field("tagId").stringValue,
              let name = try value.field("name").stringValue,
              let valueKindValue = try value.field("valueKind").stringValue,
              let valueKind = RPCTagFieldValueKind(rawValue: valueKindValue),
              let sortOrder = try value.field("sortOrder").intValue,
              sortOrder >= 0,
              let builtin = try value.field("builtin").boolValue,
              !name.isEmpty
        else { throw CapnWebError.malformedMessage("malformed TagFieldDefinition: \(value)") }
        self.id = id
        self.tagId = tagId
        self.name = name
        self.valueKind = valueKind
        self.sortOrder = sortOrder
        self.builtin = builtin
    }
}

/// One effective field returned by `listTagFields`, including whether it was inherited from an
/// ancestor Supertag. Keeping this resolution on the RPC boundary lets native render the same
/// effective schema as web without reimplementing tag-closure traversal locally.
public struct RPCResolvedTagField: Sendable, Equatable, Identifiable {
    public let field: RPCTagFieldDefinition
    public let inherited: Bool

    public var id: String { field.id }

    init(_ value: CapnWebValue) throws {
        self.field = try RPCTagFieldDefinition(value.field("field"))
        guard let inherited = try value.field("inherited").boolValue else {
            throw CapnWebError.malformedMessage("malformed ResolvedTagField: \(value)")
        }
        self.inherited = inherited
    }
}

/// Mirrors `packages/domain/src/fact.ts`'s `Fact`. `value` is left as the raw `CapnWebValue`
/// (matching `RPCSyncFeedEntry.payload`'s own rationale) — `Fact.value` is `JsonValue`, a
/// recursive JSON-safe union `CapnWebValue` already models directly, so re-projecting it into a
/// second Swift JSON-value type here would just duplicate `CapnWebValue` under a different name.
public struct RPCFact: Sendable, Equatable {
    public let id: String
    public let nodeId: String
    public let predicateId: String
    public let value: CapnWebValue
    /// Phase 3 addition — see `RPCNode.pending`'s doc comment (`WorkspaceRPCClient.swift`).
    public let pending: RPCPendingMarker?

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let nodeId = try value.field("nodeId").stringValue,
              let predicateId = try value.field("predicateId").stringValue
        else { throw CapnWebError.malformedMessage("malformed Fact: \(value)") }
        self.id = id
        self.nodeId = nodeId
        self.predicateId = predicateId
        self.value = try value.field("value")
        self.pending = try RPCPendingMarker.decodeOptional(value.field("pending"))
    }
}

/// Mirrors `packages/domain/src/relation-definition.ts`'s `RelationDefinition`.
public struct RPCRelationDefinition: Sendable, Equatable {
    public let id: String
    public let forwardName: String
    public let inverseName: String
    public let sourceTagId: String
    public let targetTagId: String
    public let cardinality: String

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let forwardName = try value.field("forwardName").stringValue,
              let inverseName = try value.field("inverseName").stringValue,
              let sourceTagId = try value.field("sourceTagId").stringValue,
              let targetTagId = try value.field("targetTagId").stringValue,
              let cardinality = try value.field("cardinality").stringValue
        else { throw CapnWebError.malformedMessage("malformed RelationDefinition: \(value)") }
        self.id = id
        self.forwardName = forwardName
        self.inverseName = inverseName
        self.sourceTagId = sourceTagId
        self.targetTagId = targetTagId
        self.cardinality = cardinality
    }
}

extension WorkspaceRPCClient {
    // MARK: - Tags

    public func createTag(name: String, parentIds: [String] = [], requestId: String, commitMessage: String, attribution: MutationAttribution) async throws -> RPCTag {
        let result = try await rpc("createTag", [
            "name": .string(name),
            "parentIds": .array(parentIds.map(CapnWebValue.string)),
            "requestId": .string(requestId),
            "commitMessage": .string(commitMessage),
            "attribution": mutationAttributionValue(attribution)
        ])
        return try RPCTag(result.field("tag"))
    }

    public func listTags() async throws -> [RPCTag] {
        let result = try await rpc("listTags", [:])
        let tags = try result.field("tags").arrayValue ?? []
        return try tags.map(RPCTag.init)
    }

    /// Returns the effective field definitions for a Supertag, including inherited fields. The
    /// backend owns closure traversal; native only decodes the already-resolved projection.
    public func listTagFields(tagId: String) async throws -> [RPCResolvedTagField] {
        let result = try await rpc("listTagFields", ["tagId": .string(tagId)])
        return try (result.field("fields").arrayValue ?? []).map(RPCResolvedTagField.init)
    }

    public func assignTag(nodeId: String, tagId: String, requestId: String, commitMessage: String, attribution: MutationAttribution) async throws {
        _ = try await rpc("assignTag", [
            "nodeId": .string(nodeId),
            "tagId": .string(tagId),
            "requestId": .string(requestId),
            "commitMessage": .string(commitMessage),
            "attribution": mutationAttributionValue(attribution)
        ])
    }

    // MARK: - Facts

    private func mutationAttributionValue(_ attribution: MutationAttribution) -> CapnWebValue {
        var fields: [String: CapnWebValue] = [
            "version": .string(attribution.version),
            "kind": .string(attribution.kind)
        ]
        if let surface = attribution.surface { fields["surface"] = .string(surface) }
        if let jobId = attribution.jobId { fields["jobId"] = .string(jobId) }
        if let runId = attribution.runId { fields["runId"] = .string(runId) }
        if let source = attribution.source { fields["source"] = .string(source) }
        return .object(fields)
    }

    /// `requestId` is the caller-owned semantic operation identity and must be retained across
    /// transport retries. `id` independently controls Fact identity/upsert; omitting it lets the
    /// server mint a new Fact id for each distinct requestId.
    public func addFact(
        nodeId: String,
        predicateId: String,
        value: CapnWebValue,
        requestId: String,
        commitMessage: String,
        attribution: MutationAttribution,
        id: String? = nil
    ) async throws -> RPCFact {
        var args: [String: CapnWebValue] = [
            "nodeId": .string(nodeId),
            "predicateId": .string(predicateId),
            "value": value, "requestId": .string(requestId), "commitMessage": .string(commitMessage),
            "attribution": mutationAttributionValue(attribution)
        ]
        args["id"] = id.map(CapnWebValue.string) ?? .undefined
        let result = try await rpc("addFact", args)
        return try RPCFact(result.field("fact"))
    }

    // MARK: - Relation definitions + edges

    public func createRelationDefinition(
        forwardName: String,
        inverseName: String,
        sourceTagId: String,
        targetTagId: String,
        cardinality: String,
        requestId: String,
        commitMessage: String,
        attribution: MutationAttribution
    ) async throws -> RPCRelationDefinition {
        let result = try await rpc("createRelationDefinition", [
            "forwardName": .string(forwardName),
            "inverseName": .string(inverseName),
            "sourceTagId": .string(sourceTagId),
            "targetTagId": .string(targetTagId),
            "cardinality": .string(cardinality),
            "requestId": .string(requestId),
            "commitMessage": .string(commitMessage),
            "attribution": mutationAttributionValue(attribution)
        ])
        return try RPCRelationDefinition(result.field("relationDefinition"))
    }

    public func createEdge(
        relationDefinitionId: String,
        sourceNodeId: String,
        targetNodeId: String,
        requestId: String,
        commitMessage: String,
        attribution: MutationAttribution
    ) async throws -> RPCEdge {
        let result = try await rpc("createEdge", [
            "relationDefinitionId": .string(relationDefinitionId),
            "sourceNodeId": .string(sourceNodeId),
            "targetNodeId": .string(targetNodeId),
            "requestId": .string(requestId),
            "commitMessage": .string(commitMessage),
            "attribution": mutationAttributionValue(attribution)
        ])
        return try RPCEdge(result.field("edge"))
    }
}
