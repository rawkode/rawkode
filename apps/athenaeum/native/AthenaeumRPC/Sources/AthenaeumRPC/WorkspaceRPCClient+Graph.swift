import Foundation

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

    public func createTag(name: String, parentIds: [String] = []) async throws -> RPCTag {
        let result = try await rpc("createTag", [
            "name": .string(name),
            "parentIds": .array(parentIds.map(CapnWebValue.string))
        ])
        return try RPCTag(result.field("tag"))
    }

    public func listTags() async throws -> [RPCTag] {
        let result = try await rpc("listTags", [:])
        let tags = try result.field("tags").arrayValue ?? []
        return try tags.map(RPCTag.init)
    }

    public func assignTag(nodeId: String, tagId: String) async throws {
        _ = try await rpc("assignTag", ["nodeId": .string(nodeId), "tagId": .string(tagId)])
    }

    // MARK: - Facts

    /// `id` mirrors `AddFactInput.id`'s optional-caller-supplied-id convention (`graph-rpc.ts`) —
    /// passing a stable id makes a retried call idempotent (`SyncFeedService.append`'s
    /// write-side dedup); omitting it (the default) gets a fresh server-minted id every call.
    public func addFact(
        nodeId: String,
        predicateId: String,
        value: CapnWebValue,
        id: String? = nil
    ) async throws -> RPCFact {
        var args: [String: CapnWebValue] = [
            "nodeId": .string(nodeId),
            "predicateId": .string(predicateId),
            "value": value
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
        cardinality: String
    ) async throws -> RPCRelationDefinition {
        let result = try await rpc("createRelationDefinition", [
            "forwardName": .string(forwardName),
            "inverseName": .string(inverseName),
            "sourceTagId": .string(sourceTagId),
            "targetTagId": .string(targetTagId),
            "cardinality": .string(cardinality)
        ])
        return try RPCRelationDefinition(result.field("relationDefinition"))
    }

    public func createEdge(
        relationDefinitionId: String,
        sourceNodeId: String,
        targetNodeId: String
    ) async throws -> RPCEdge {
        let result = try await rpc("createEdge", [
            "relationDefinitionId": .string(relationDefinitionId),
            "sourceNodeId": .string(sourceNodeId),
            "targetNodeId": .string(targetNodeId)
        ])
        return try RPCEdge(result.field("edge"))
    }
}
