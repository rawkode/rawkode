import Foundation

/// The minimal entity mirrors this client decodes into — hand-written against
/// `packages/domain/src/*.ts`'s `Schema.Class` field shapes, not generated. A future
/// `AthenaeumDomain` Swift package (plan §"Repo/package layout") supersedes these; kept minimal
/// (only the fields the methods below actually return) rather than speculatively mirroring the
/// full domain package.
public struct RPCNode: Sendable, Equatable {
    public let id: String
    public let workspaceId: String
    public let title: String
    public let createdAt: String
    /// Phase 3 addition — mirrors `node.ts`'s optional `pending: {chatId, sequence?}` marker (see
    /// `RPCPendingMarker` in `WorkspaceRPCClient+AgentEdit.swift`). `nil` for every ordinary mainline
    /// node; set for a node an agent chat proposed but the user hasn't accepted yet.
    public let pending: RPCPendingMarker?

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let title = try value.field("title").stringValue,
              let createdAt = try value.field("createdAt").stringValue
        else { throw CapnWebError.malformedMessage("malformed Node: \(value)") }
        self.id = id
        self.workspaceId = workspaceId
        self.title = title
        self.createdAt = createdAt
        self.pending = try RPCPendingMarker.decodeOptional(value.field("pending"))
    }
}

/// Mirrors `packages/domain/src/page.ts`'s `Page` — the Automerge doc *reference*, never document
/// bytes (see that file's doc comment).
public struct RPCPage: Sendable, Equatable {
    public let nodeId: String
    public let automergeDocId: String
    public let headsHash: String

    init(_ value: CapnWebValue) throws {
        guard let nodeId = try value.field("nodeId").stringValue,
              let automergeDocId = try value.field("automergeDocId").stringValue,
              let headsHash = try value.field("headsHash").stringValue
        else { throw CapnWebError.malformedMessage("malformed Page: \(value)") }
        self.nodeId = nodeId
        self.automergeDocId = automergeDocId
        self.headsHash = headsHash
    }
}

/// Mirrors `packages/domain/src/edge.ts`'s `Edge`.
public struct RPCEdge: Sendable, Equatable {
    public let id: String
    public let relationDefinitionId: String
    public let sourceNodeId: String
    public let targetNodeId: String
    /// Phase 3 addition — see `RPCNode.pending`'s doc comment.
    public let pending: RPCPendingMarker?

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let relationDefinitionId = try value.field("relationDefinitionId").stringValue,
              let sourceNodeId = try value.field("sourceNodeId").stringValue,
              let targetNodeId = try value.field("targetNodeId").stringValue
        else { throw CapnWebError.malformedMessage("malformed Edge: \(value)") }
        self.id = id
        self.relationDefinitionId = relationDefinitionId
        self.sourceNodeId = sourceNodeId
        self.targetNodeId = targetNodeId
        self.pending = try RPCPendingMarker.decodeOptional(value.field("pending"))
    }
}

/// Mirrors `packages/domain/src/sync.ts`'s `SyncFeedEntry`. `payload` is left as the raw
/// `CapnWebValue` (matching the TS schema's own `Schema.Unknown` — see that file's doc comment
/// for why: the payload's real shape depends on `entityKind`, which the *caller*, not this
/// generic feed-entry decoder, knows how to dispatch on).
public struct RPCSyncFeedEntry: Sendable, Equatable {
    public let replicaEpoch: Int
    public let monotonicCounter: Int
    public let entityKind: String
    public let entityId: String
    public let operation: String
    public let payload: CapnWebValue
    public let hash: String

    init(_ value: CapnWebValue) throws {
        guard let replicaEpoch = try value.field("replicaEpoch").intValue,
              let monotonicCounter = try value.field("monotonicCounter").intValue,
              let entityKind = try value.field("entityKind").stringValue,
              let entityId = try value.field("entityId").stringValue,
              let operation = try value.field("operation").stringValue,
              let hash = try value.field("hash").stringValue
        else { throw CapnWebError.malformedMessage("malformed SyncFeedEntry: \(value)") }
        self.replicaEpoch = replicaEpoch
        self.monotonicCounter = monotonicCounter
        self.entityKind = entityKind
        self.entityId = entityId
        self.operation = operation
        self.payload = try value.field("payload")
        self.hash = hash
    }
}

public struct RPCSyncFeedPage: Sendable, Equatable {
    public let epoch: String
    public let epochMismatch: Bool
    public let entries: [RPCSyncFeedEntry]
    public let nextAfterCounter: Int?
}

public struct RPCPageSyncResult: Sendable, Equatable {
    public let sessionId: String
    public let ordinal: Int
    public let message: Data?
    public let converged: Bool
    public let reset: Bool
}

/// Typed convenience wrapper over `CapnWebBatchClient` for the specific RPC surface this stage
/// scoped (see `apps/athenaeum/native/docs/decisions.md`): `createNode`, `getNode`, `listNodes`,
/// `createPage`, `getPageText`, `applyPageEdit`, `startPageSync`, `pageSyncMessage`,
/// `listBacklinks`, `runView`, `syncFeed`, `rotateEpoch` — every method
/// `packages/backend/src/workspace-durable-object.ts`'s `WorkspaceRpcApi` exposes today except
/// `subscribeToNodes` (a live Cap'n Web push subscription, deliberately out of scope for the HTTP
/// batch transport — see decisions.md) and the remaining graph-mutation methods (`createTag`,
/// `addFact`, `createRelationDefinition`, `createEdge`, `assignTag`, `listGraphIssues`,
/// `listTagClosure`, `searchNodes`), which follow the exact same `call(_:args:)` pattern below
/// and were left for whichever stage first needs them rather than mirrored speculatively.
public final class WorkspaceRPCClient: Sendable {
    private let client: CapnWebBatchClient
    public let workspaceId: String

    /// `baseURL` is the workspace's own endpoint, `/api/workspace/:workspaceId` on the backend Worker (see
    /// `packages/backend/src/index.ts`) — e.g.
    /// `https://athenaeum-backend.<subdomain>.workers.dev/api/workspace/<workspaceId>` or, for local
    /// development, `http://127.0.0.1:8787/api/workspace/<workspaceId>`.
    ///
    /// `bearerCredential` (Phase 4 addition) — a `DevSignInOutput.credential` from
    /// `DevAuthClient.signIn`, threaded straight through to `CapnWebBatchClient`. `nil` (the
    /// default) is every pre-Phase-4 call site's exact prior behavior: an anonymous connection,
    /// which every method except `whoami` and the sharing surface still accepts today (see
    /// `workspace-durable-object.ts`'s own header comment on `#currentUser`).
    public init(baseURL: URL, workspaceId: String, urlSession: URLSession = .shared, bearerCredential: String? = nil) {
        self.client = CapnWebBatchClient(baseURL: baseURL, urlSession: urlSession, bearerCredential: bearerCredential)
        self.workspaceId = workspaceId
    }

    /// Internal (not `private`) so `WorkspaceRPCClient+Graph.swift`'s extension methods — in the same
    /// module/target, added by the Storage/Sync-client stage — can reuse the exact same
    /// workspaceId-injection + `AthenaeumDomainError` conversion behavior rather than duplicating it.
    func rpc(_ method: String, _ args: [String: CapnWebValue]) async throws -> CapnWebValue {
        var withWorkspace = args
        withWorkspace["workspaceId"] = .string(workspaceId)
        do {
            return try await client.call(method, args: .object(withWorkspace))
        } catch let error as CapnWebError {
            throw error.asDomainError()
        }
    }

    // MARK: - Auth-context proof (Phase 4 prerequisite)

    /// Mirrors `WorkspaceRpcApi.whoami()` — the reference proof that a Bearer credential passed to
    /// this client's `init(bearerCredential:)` actually reaches `CurrentUser` server-side.
    /// Answerable by anonymous callers too (`authenticated: false`), never throws `Unauthorized`.
    public func whoami() async throws -> (authenticated: Bool, email: String?) {
        let result = try await rpc("whoami", [:])
        return (
            authenticated: try result.field("authenticated").boolValue ?? false,
            email: try result.field("email").stringValue
        )
    }

    // MARK: - Nodes

    public func createNode(title: String, id: String? = nil) async throws -> RPCNode {
        var args: [String: CapnWebValue] = ["title": .string(title)]
        args["id"] = id.map(CapnWebValue.string) ?? .undefined
        let result = try await rpc("createNode", args)
        return try RPCNode(result.field("node"))
    }

    public func getNode(nodeId: String) async throws -> RPCNode {
        let result = try await rpc("getNode", ["nodeId": .string(nodeId)])
        return try RPCNode(result.field("node"))
    }

    public func listNodes() async throws -> [RPCNode] {
        let result = try await rpc("listNodes", [:])
        let nodes = try result.field("nodes").arrayValue ?? []
        return try nodes.map(RPCNode.init)
    }

    // MARK: - Page bodies (Automerge)

    public func createPage(nodeId: String) async throws -> (page: RPCPage, text: String) {
        let result = try await rpc("createPage", ["nodeId": .string(nodeId)])
        return (try RPCPage(result.field("page")), try result.field("text").stringValue ?? "")
    }

    public func getPageText(nodeId: String) async throws -> (page: RPCPage, text: String) {
        let result = try await rpc("getPageText", ["nodeId": .string(nodeId)])
        return (try RPCPage(result.field("page")), try result.field("text").stringValue ?? "")
    }

    /// A plain text-replace op: delete `deleteCount` UTF-16 code units starting at `index`, then
    /// insert `insertText` — the same shape `packages/domain/src/page-rpc.ts`'s
    /// `ApplyPageEditInput` documents.
    public func applyPageEdit(
        nodeId: String,
        index: Int,
        deleteCount: Int,
        insertText: String
    ) async throws -> (page: RPCPage, text: String) {
        let result = try await rpc("applyPageEdit", [
            "nodeId": .string(nodeId),
            "index": .int(index),
            "deleteCount": .int(deleteCount),
            "insertText": .string(insertText)
        ])
        return (try RPCPage(result.field("page")), try result.field("text").stringValue ?? "")
    }

    // MARK: - Page sync (Automerge sync protocol)

    public func startPageSync(nodeId: String, sessionId: String) async throws -> Data? {
        let result = try await rpc("startPageSync", ["nodeId": .string(nodeId), "sessionId": .string(sessionId)])
        return try result.field("message").bytesValue
    }

    public func pageSyncMessage(
        nodeId: String,
        sessionId: String,
        ordinal: Int,
        message: Data
    ) async throws -> RPCPageSyncResult {
        let result = try await rpc("pageSyncMessage", [
            "nodeId": .string(nodeId),
            "sessionId": .string(sessionId),
            "ordinal": .int(ordinal),
            "message": .bytes(message)
        ])
        return RPCPageSyncResult(
            sessionId: try result.field("sessionId").stringValue ?? sessionId,
            ordinal: try result.field("ordinal").intValue ?? ordinal,
            message: try result.field("message").bytesValue,
            converged: try result.field("converged").boolValue ?? false,
            reset: try result.field("reset").boolValue ?? false
        )
    }

    // MARK: - Graph reads

    public func listBacklinks(nodeId: String) async throws -> [RPCEdge] {
        let result = try await rpc("listBacklinks", ["nodeId": .string(nodeId)])
        let edges = try result.field("edges").arrayValue ?? []
        return try edges.map(RPCEdge.init)
    }

    /// `viewName` is one of `view-spec.ts`'s `GraphViewName` literals (`"graph_nodes"`,
    /// `"graph_tags"`, `"graph_tag_parents"`, `"graph_tag_closure"`, `"graph_node_tags"`,
    /// `"graph_facts"`, `"graph_relation_definitions"`, `"graph_edges"`, `"graph_issues"`,
    /// `"graph_text_search"`) — kept as a plain `String` here rather than a Swift enum since
    /// `ViewSpec` itself (the `viewSpec` parameter) is a nontrivial predicate-tree schema this
    /// stage deliberately didn't mirror in full (see this file's top doc comment); callers pass
    /// the already-shaped wire object directly. Rows come back as raw `CapnWebValue`s, matching
    /// the server's own `RunViewOutput.rows: Schema.Array(Schema.Unknown)`.
    public func runView(viewName: String, viewSpec: CapnWebValue) async throws -> [CapnWebValue] {
        let result = try await rpc("runView", ["viewName": .string(viewName), "viewSpec": viewSpec])
        return try result.field("rows").arrayValue ?? []
    }

    // MARK: - Structured-record sync feed + epoch

    public func syncFeed(knownEpoch: String?, afterCounter: Int?, limit: Int) async throws -> RPCSyncFeedPage {
        var args: [String: CapnWebValue] = ["limit": .int(limit)]
        args["knownEpoch"] = knownEpoch.map(CapnWebValue.string) ?? .undefined
        args["afterCounter"] = afterCounter.map(CapnWebValue.int) ?? .undefined
        let result = try await rpc("syncFeed", args)
        let entries = try result.field("entries").arrayValue ?? []
        return RPCSyncFeedPage(
            epoch: try result.field("epoch").stringValue ?? "",
            epochMismatch: try result.field("epochMismatch").boolValue ?? false,
            entries: try entries.map(RPCSyncFeedEntry.init),
            nextAfterCounter: try result.field("nextAfterCounter").intValue
        )
    }

    /// Admin/test-only, per `packages/domain/src/sync-rpc.ts`'s `RotateEpochInput` doc comment.
    public func rotateEpoch() async throws -> String {
        let result = try await rpc("rotateEpoch", [:])
        return try result.field("epoch").stringValue ?? ""
    }
}
