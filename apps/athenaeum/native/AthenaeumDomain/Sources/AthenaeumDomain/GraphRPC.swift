import Foundation

// Mirrors `packages/domain/src/graph-rpc.ts` — wire schemas for the graph mutation/read RPC
// surface (tags/facts/relationDefinitions/edges/views/backlinks/graphIssues/tagClosure/
// node-tag-assignment).

public struct CreateTagInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let name: String
    public let parentIds: [EntityId]
    public let requestId: String
    public let commitMessage: String
    public let attribution: MutationAttribution
    public init(workspaceId: EntityId, name: String, parentIds: [EntityId], requestId: String, commitMessage: String, attribution: MutationAttribution) {
        self.workspaceId = workspaceId
        self.name = name
        self.parentIds = parentIds
        self.requestId = requestId
        self.commitMessage = commitMessage
        self.attribution = attribution
    }
}

public struct CreateTagOutput: Codable, Hashable, Sendable {
    public let tag: Tag
    public init(tag: Tag) { self.tag = tag }
}

public struct AddFactInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public let predicateId: String
    public let value: JSONValue
    public let requestId: String
    public let commitMessage: String
    public let attribution: MutationAttribution
    /// Optional caller-supplied id — same idempotent-retry convention as `NodeRPC.swift`'s
    /// `CreateNodeInput.id` (see `graph-rpc.ts`'s doc comment).
    public let id: EntityId?

    public init(workspaceId: EntityId, nodeId: EntityId, predicateId: String, value: JSONValue, requestId: String, commitMessage: String, attribution: MutationAttribution, id: EntityId? = nil) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
        self.predicateId = predicateId
        self.value = value
        self.requestId = requestId
        self.commitMessage = commitMessage
        self.attribution = attribution
        self.id = id
    }
}

public struct MutationAttribution: Codable, Hashable, Sendable {
    public let version: String
    public let kind: String
    public let surface: String?
    public let jobId: String?
    public let runId: String?
    public let source: String?
    public init(version: String = "athenaeum.mutation-attribution.v1", kind: String, surface: String? = nil, jobId: String? = nil, runId: String? = nil, source: String? = nil) {
        self.version = version; self.kind = kind; self.surface = surface; self.jobId = jobId; self.runId = runId; self.source = source
    }
}

public struct AddFactOutput: Codable, Hashable, Sendable {
    public let fact: Fact
    public init(fact: Fact) { self.fact = fact }
}

public struct CreateRelationDefinitionInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let forwardName: String
    public let inverseName: String
    public let sourceTagId: EntityId
    public let targetTagId: EntityId
    public let cardinality: RelationCardinality
    public let requestId: String
    public let commitMessage: String
    public let attribution: MutationAttribution

    public init(
        workspaceId: EntityId,
        forwardName: String,
        inverseName: String,
        sourceTagId: EntityId,
        targetTagId: EntityId,
        cardinality: RelationCardinality,
        requestId: String,
        commitMessage: String,
        attribution: MutationAttribution
    ) {
        self.workspaceId = workspaceId
        self.forwardName = forwardName
        self.inverseName = inverseName
        self.sourceTagId = sourceTagId
        self.targetTagId = targetTagId
        self.cardinality = cardinality
        self.requestId = requestId
        self.commitMessage = commitMessage
        self.attribution = attribution
    }
}

public struct CreateRelationDefinitionOutput: Codable, Hashable, Sendable {
    public let relationDefinition: RelationDefinition
    public init(relationDefinition: RelationDefinition) { self.relationDefinition = relationDefinition }
}

public struct CreateEdgeInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let relationDefinitionId: EntityId
    public let sourceNodeId: EntityId
    public let targetNodeId: EntityId
    public let requestId: String
    public let commitMessage: String
    public let attribution: MutationAttribution

    public init(workspaceId: EntityId, relationDefinitionId: EntityId, sourceNodeId: EntityId, targetNodeId: EntityId, requestId: String, commitMessage: String, attribution: MutationAttribution) {
        self.workspaceId = workspaceId
        self.relationDefinitionId = relationDefinitionId
        self.sourceNodeId = sourceNodeId
        self.targetNodeId = targetNodeId
        self.requestId = requestId
        self.commitMessage = commitMessage
        self.attribution = attribution
    }
}

public struct CreateEdgeOutput: Codable, Hashable, Sendable {
    public let edge: Edge
    public init(edge: Edge) { self.edge = edge }
}

/// Mirrors `graph-rpc.ts`'s `RunViewInput` — **both** `viewName` and `viewSpec`, a package deal
/// (see that file's doc comment: the fixed view set plus the authorizer only works together).
public struct RunViewInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let viewName: GraphViewName
    public let viewSpec: ViewSpec

    public init(workspaceId: EntityId, viewName: GraphViewName, viewSpec: ViewSpec) {
        self.workspaceId = workspaceId
        self.viewName = viewName
        self.viewSpec = viewSpec
    }
}

/// Mirrors `graph-rpc.ts`'s `RunViewOutput.rows: Schema.Array(Schema.Unknown)` — rows are
/// arbitrary JSON objects from the compiled SQL view, so `[JSONValue]` (same narrowing rationale
/// as `Sync.swift`'s `SyncFeedEntry.payload`).
public struct RunViewOutput: Codable, Hashable, Sendable {
    public let rows: [JSONValue]
    public init(rows: [JSONValue]) { self.rows = rows }
}

public struct ListBacklinksInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public init(workspaceId: EntityId, nodeId: EntityId) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
    }
}

public struct ListBacklinksOutput: Codable, Hashable, Sendable {
    public let edges: [Edge]
    public init(edges: [Edge]) { self.edges = edges }
}

public struct ListGraphIssuesInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public init(workspaceId: EntityId) { self.workspaceId = workspaceId }
}

public struct ListGraphIssuesOutput: Codable, Hashable, Sendable {
    public let graphIssues: [GraphIssue]
    public init(graphIssues: [GraphIssue]) { self.graphIssues = graphIssues }
}

/// Mirrors `graph-rpc.ts`'s `TagClosureEntry` — one row of the materialized `tagClosure`
/// collection. `ancestorId === descendantId` rows are reflexive self-membership entries.
public struct TagClosureEntry: Codable, Hashable, Sendable {
    public let ancestorId: EntityId
    public let descendantId: EntityId
    public init(ancestorId: EntityId, descendantId: EntityId) {
        self.ancestorId = ancestorId
        self.descendantId = descendantId
    }
}

public struct ListTagClosureInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public init(workspaceId: EntityId) { self.workspaceId = workspaceId }
}

public struct ListTagClosureOutput: Codable, Hashable, Sendable {
    public let entries: [TagClosureEntry]
    public init(entries: [TagClosureEntry]) { self.entries = entries }
}

public struct ListTagsInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public init(workspaceId: EntityId) { self.workspaceId = workspaceId }
}

public struct ListTagsOutput: Codable, Hashable, Sendable {
    public let tags: [Tag]
    public init(tags: [Tag]) { self.tags = tags }
}

/// Mirrors `graph-rpc.ts`'s `AssignTagInput`/`AssignTagOutput` — the `graph_node_tags` view's
/// underlying node-to-tag membership mutation, and the `hasTag` `ViewPredicate` op's only way to
/// get real data to test against.
public struct AssignTagInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public let tagId: EntityId
    public let requestId: String
    public let commitMessage: String
    public let attribution: MutationAttribution
    public init(workspaceId: EntityId, nodeId: EntityId, tagId: EntityId, requestId: String, commitMessage: String, attribution: MutationAttribution) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
        self.tagId = tagId
        self.requestId = requestId
        self.commitMessage = commitMessage
        self.attribution = attribution
    }
}

public struct AssignTagOutput: Codable, Hashable, Sendable {
    public let nodeId: EntityId
    public let tagId: EntityId
    public let changed: Bool
    public init(nodeId: EntityId, tagId: EntityId, changed: Bool) {
        self.nodeId = nodeId
        self.tagId = tagId
        self.changed = changed
    }
}

/// Mirrors the ledger-routed `ApplySupertagInput` rather than composing `assignTag` and facts in
/// the client. A caller owns one semantic request identity across an uncertain response/retry.
public struct ApplySupertagFieldValue: Codable, Hashable, Sendable {
    public let fieldId: EntityId
    public let value: JSONValue
    public init(fieldId: EntityId, value: JSONValue) {
        self.fieldId = fieldId
        self.value = value
    }
}

public struct ApplySupertagInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public let tagId: EntityId
    public let requestId: String
    public let commitMessage: String
    public let attribution: MutationAttribution
    public let fieldValues: [ApplySupertagFieldValue]?

    public init(workspaceId: EntityId, nodeId: EntityId, tagId: EntityId, requestId: String, commitMessage: String, attribution: MutationAttribution, fieldValues: [ApplySupertagFieldValue]? = nil) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
        self.tagId = tagId
        self.requestId = requestId
        self.commitMessage = commitMessage
        self.attribution = attribution
        self.fieldValues = fieldValues
    }
}

public struct ApplySupertagOutput: Codable, Hashable, Sendable {
    public let nodeId: EntityId
    public let tagId: EntityId
    public let facts: [Fact]
    public init(nodeId: EntityId, tagId: EntityId, facts: [Fact]) {
        self.nodeId = nodeId
        self.tagId = tagId
        self.facts = facts
    }
}
