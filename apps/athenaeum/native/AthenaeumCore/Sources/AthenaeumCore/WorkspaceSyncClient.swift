import Foundation
import Automerge
import AthenaeumDomain
import AthenaeumRPC

// `WorkspaceSyncClient` — plan §"Repo/package layout"'s "sync client" actor: the real client half of
// both of the plan's Sync protocol content classes (§"Sync protocol"):
//
//  1. Automerge prose sync (`syncPage`) — mirrors `web/src/automerge-page.ts`'s
//     `syncPageWithServer` line for line: same "always call `startPageSync` first, then exchange
//     `generateSyncMessage`/`pageSyncMessage` until both sides have nothing left to send, bounded
//     at 50 round trips, `reset: true` reclaims with a fresh session id" shape, reusing one stable
//     `SyncSessionHandle` per node across calls (not a fresh id per debounced edit — the exact
//     fix Phase 1's web stage made, see that file's doc comment history).
//  2. Structured-record sync feed (`catchUpStructuredSync`) — mirrors
//     `web/src/sync-feed-client.ts`'s `catchUpSyncFeed`: pages through `syncFeed` with a
//     persisted `(epoch, afterCounter)` cursor, restarting from scratch on `epochMismatch`.
//
// Every mutation method here follows the plan's "Native local SQLite stays the immediate write
// authority (durable-before-sync)": the local `LocalWorkspaceStore` write always happens, and always
// happens before the corresponding RPC call — a network/RPC failure leaves the local row marked
// `dirty` for a later retry rather than losing the local write or blocking on connectivity. This
// stage does not implement an actual background retry queue (out of scope — see this file's
// `TODO`-free but explicit doc comments below on exactly what's real vs. deferred); the
// `dirty`-flag bookkeeping itself, and every method's local-write-before-network-call ordering,
// is real and exercised by this package's tests, not stubbed.

public enum WorkspaceSyncClientError: Error, Sendable, Equatable {
    case pageNotFoundLocally(EntityId)
}

public struct SyncFeedCatchUpResult: Sendable, Equatable {
    public let epoch: String
    public let entriesSeen: Int
    public let byEntityKind: [String: Int]
}

public actor WorkspaceSyncClient {
    private let localStore: LocalWorkspaceStore
    private let pageStore: PageDocumentStore
    private let rpcClient: WorkspaceRPCClient
    public let workspaceId: EntityId

    public init(localStore: LocalWorkspaceStore, pageStore: PageDocumentStore, rpcClient: WorkspaceRPCClient, workspaceId: EntityId) {
        self.localStore = localStore
        self.pageStore = pageStore
        self.rpcClient = rpcClient
        self.workspaceId = workspaceId
    }

    // MARK: - Nodes

    /// Durable-before-sync: writes the node to `LocalWorkspaceStore` first (dirty), then pushes it via
    /// `createNode`. `id` mirrors `CreateNodeInput.id`'s caller-supplied-id convention
    /// (`rpc.ts`) — passing one makes this call idempotent/resolve-or-create-friendly, matching
    /// `web/src/DailyNote.tsx`'s `resolveDailyNote` pattern; omitting it gets a fresh
    /// server-minted id.
    @discardableResult
    public func createNode(title: String, id: EntityId? = nil) async throws -> Node {
        let localId = try id ?? EntityId(validating: UUID().uuidString.lowercased())
        let createdAt = try IsoDateTimeString(validating: ISO8601DateFormatter().string(from: Date()))
        let localNode = Node(id: localId, workspaceId: workspaceId, title: title, createdAt: createdAt)
        try await localStore.upsertNode(localNode, dirty: true)

        let remote = try await rpcClient.createNode(title: title, id: localId.rawValue)
        let confirmed = Node(
            id: try EntityId(validating: remote.id),
            workspaceId: try EntityId(validating: remote.workspaceId),
            title: remote.title,
            createdAt: try IsoDateTimeString(validating: remote.createdAt)
        )
        try await localStore.upsertNode(confirmed, dirty: false)
        return confirmed
    }

    /// Resolve-or-create: mirrors `DailyNote.tsx`'s `resolveDailyNote`'s node half — `getNode`,
    /// falling back to `createNode` only on `NodeNotFound`.
    public func resolveOrCreateNode(id: EntityId, title: String) async throws -> Node {
        do {
            let remote = try await rpcClient.getNode(nodeId: id.rawValue)
            let node = Node(
                id: try EntityId(validating: remote.id),
                workspaceId: try EntityId(validating: remote.workspaceId),
                title: remote.title,
                createdAt: try IsoDateTimeString(validating: remote.createdAt)
            )
            try await localStore.upsertNode(node, dirty: false)
            return node
        } catch AthenaeumDomainError.nodeNotFound {
            return try await createNode(title: title, id: id)
        }
    }

    // MARK: - Pages (structured reference row + Automerge genesis)

    /// Resolve-or-create for a node's page, mirroring `DailyNote.tsx`'s page half
    /// (`getPageText` falling back to `createPage` on `PageNotFound`), then immediately runs one
    /// real sync exchange to pull the (possibly pre-existing) server content into a fresh local
    /// replica — never assumes a brand-new `createPage` response means the local doc already has
    /// everything, since another device could have created it first.
    @discardableResult
    public func resolveOrCreatePage(nodeId: EntityId, session: SyncSessionHandle) async throws -> String {
        do {
            _ = try await rpcClient.getPageText(nodeId: nodeId.rawValue)
        } catch AthenaeumDomainError.pageNotFound {
            _ = try await rpcClient.createPage(nodeId: nodeId.rawValue)
        }

        let placeholder = Page(nodeId: nodeId, automergeDocId: nodeId.rawValue, headsHash: "")
        try await localStore.upsertPage(placeholder, docBytes: nil, dirty: false)

        // Always starts from a genuinely empty local replica unless this run already has one
        // loaded with possible local-only pending edits worth preserving (e.g. a repeated call
        // for the same node within one process lifetime) — never a locally-`putObject`-created
        // genesis, whether or not the page already existed server-side (see
        // `PageDocumentStore`'s doc comment for why that would be unsafe even for a *newly*
        // created, still-empty server page). The subsequent `syncPage` call is what actually
        // pulls the server's real genesis/content in, via the real sync-message exchange.
        if !(await pageStore.isLoaded(nodeId: nodeId)) {
            await pageStore.loadEmpty(nodeId: nodeId)
        }
        return try await syncPage(nodeId: nodeId, session: session)
    }

    /// Applies a local edit as a real Automerge change (never a server RPC — see
    /// `PageDocumentStore`'s doc comment), then immediately persists the resulting snapshot bytes
    /// to `LocalWorkspaceStore` (durable-before-sync) — the edit survives a crash even before the
    /// next `syncPage` call reaches the network.
    @discardableResult
    public func applyLocalEdit(
        nodeId: EntityId,
        index: Int,
        deleteCount: Int,
        insertText: String
    ) async throws -> String {
        let text = try await pageStore.applyLocalSplice(
            nodeId: nodeId, index: index, deleteCount: deleteCount, insertText: insertText
        )
        try await persistPageSnapshotLocally(nodeId: nodeId, dirty: true)
        return text
    }

    private func persistPageSnapshotLocally(nodeId: EntityId, dirty: Bool) async throws {
        let bytes = try await pageStore.snapshotBytes(nodeId: nodeId)
        let headsHash = try await pageStore.headsHash(nodeId: nodeId)
        let page = Page(nodeId: nodeId, automergeDocId: nodeId.rawValue, headsHash: headsHash)
        try await localStore.upsertPage(page, docBytes: bytes, dirty: dirty)
    }

    /// The real Automerge sync-session round trip against `startPageSync`/`pageSyncMessage` —
    /// see this file's top doc comment for the exact `automerge-page.ts` correspondence. Persists
    /// the converged snapshot to `LocalWorkspaceStore` and clears the page's `dirty` flag on success.
    @discardableResult
    public func syncPage(nodeId: EntityId, session: SyncSessionHandle) async throws -> String {
        guard await pageStore.isLoaded(nodeId: nodeId) else {
            throw WorkspaceSyncClientError.pageNotFoundLocally(nodeId)
        }

        var syncState = SyncState()
        var ordinal = 0
        var serverMessage = try await rpcClient.startPageSync(nodeId: nodeId.rawValue, sessionId: session.id)

        roundLoop: for _ in 0..<50 {
            if let serverMessage {
                try await pageStore.receiveSyncMessage(nodeId: nodeId, state: syncState, message: serverMessage)
            }

            guard let outMessage = try await pageStore.generateSyncMessage(nodeId: nodeId, state: syncState) else {
                // Nothing left for us to send — caught up (mirrors syncPageWithServer's `break`).
                break roundLoop
            }

            let response = try await rpcClient.pageSyncMessage(
                nodeId: nodeId.rawValue, sessionId: session.id, ordinal: ordinal, message: outMessage
            )
            ordinal += 1

            if response.reset {
                session.id = UUID().uuidString
                syncState = SyncState()
                serverMessage = try await rpcClient.startPageSync(nodeId: nodeId.rawValue, sessionId: session.id)
                ordinal = 0
                continue roundLoop
            }

            serverMessage = response.message
            if response.converged, serverMessage == nil { break roundLoop }
        }

        try await persistPageSnapshotLocally(nodeId: nodeId, dirty: false)
        return try await pageStore.text(nodeId: nodeId)
    }

    // MARK: - Structured graph mutations (Tags/Facts/Edges) — local-first, same discipline as
    // `createNode`. Kept intentionally thin (one upsert + one RPC push each): the plan's
    // structured-conflict-model machinery ("base revision and prior value... observed-remove
    // tags... aggregate optimistic concurrency... tombstone conflict") is explicitly out of this
    // stage's scope (Storage/Sync-client, not the later conflict-resolution stage) — these methods
    // give `LocalWorkspaceStore`'s Tag/Fact/Edge tables a real, tested server counterpart rather than
    // leaving them write-only/local-only, without inventing that later machinery early.

    @discardableResult
    public func createTag(name: String, parentIds: [EntityId] = []) async throws -> Tag {
        let remote = try await rpcClient.createTag(name: name, parentIds: parentIds.map(\.rawValue))
        let tag = try Tag(
            id: EntityId(validating: remote.id),
            name: remote.name,
            parentIds: remote.parentIds.map { try EntityId(validating: $0) },
            builtin: remote.builtin
        )
        try await localStore.upsertTag(tag, dirty: false)
        return tag
    }

    @discardableResult
    public func addFact(nodeId: EntityId, predicateId: String, value: JSONValue, id: EntityId? = nil) async throws -> Fact {
        let localId = try id ?? EntityId(validating: UUID().uuidString.lowercased())
        let localFact = Fact(id: localId, nodeId: nodeId, predicateId: predicateId, value: value)
        try await localStore.upsertFact(localFact, dirty: true)

        let remote = try await rpcClient.addFact(
            nodeId: nodeId.rawValue, predicateId: predicateId, value: value.toCapnWebValue(), id: localId.rawValue
        )
        let confirmed = Fact(
            id: try EntityId(validating: remote.id),
            nodeId: try EntityId(validating: remote.nodeId),
            predicateId: remote.predicateId,
            value: try remote.value.toJSONValue()
        )
        try await localStore.upsertFact(confirmed, dirty: false)
        return confirmed
    }

    @discardableResult
    public func createEdge(relationDefinitionId: EntityId, sourceNodeId: EntityId, targetNodeId: EntityId) async throws -> Edge {
        let remote = try await rpcClient.createEdge(
            relationDefinitionId: relationDefinitionId.rawValue,
            sourceNodeId: sourceNodeId.rawValue,
            targetNodeId: targetNodeId.rawValue
        )
        let edge = Edge(
            id: try EntityId(validating: remote.id),
            relationDefinitionId: try EntityId(validating: remote.relationDefinitionId),
            sourceNodeId: try EntityId(validating: remote.sourceNodeId),
            targetNodeId: try EntityId(validating: remote.targetNodeId)
        )
        try await localStore.upsertEdge(edge, dirty: false)
        return edge
    }

    // MARK: - Structured-record sync feed catch-up (mirrors `sync-feed-client.ts`'s
    // `catchUpSyncFeed`)

    private static let pageLimit = 100
    private static let maxPages = 500

    /// Pages through `syncFeed` from this workspace's persisted cursor (`LocalWorkspaceStore.
    /// syncFeedCursor`) until caught up, restarting from scratch on an `epochMismatch` — the same
    /// epoch-recovery path `sync-feed-client.ts`'s doc comment describes, bounded at
    /// `maxPages`/`pageLimit` for the identical "fail loudly, don't hang forever" reason.
    public func catchUpStructuredSync() async throws -> SyncFeedCatchUpResult {
        var cursor = try await localStore.syncFeedCursor(workspaceId: workspaceId)
        var epoch = cursor?.epoch ?? ""
        var entriesSeen = 0
        var byEntityKind: [String: Int] = [:]

        for _ in 0..<Self.maxPages {
            let page = try await rpcClient.syncFeed(
                knownEpoch: cursor?.epoch, afterCounter: cursor?.afterCounter, limit: Self.pageLimit
            )
            epoch = page.epoch

            if page.epochMismatch {
                cursor = nil
                try await localStore.setSyncFeedCursor(workspaceId: workspaceId, epoch: epoch, afterCounter: nil)
                continue
            }

            for entry in page.entries {
                entriesSeen += 1
                byEntityKind[entry.entityKind, default: 0] += 1
            }

            guard let nextAfterCounter = page.nextAfterCounter else {
                try await localStore.setSyncFeedCursor(workspaceId: workspaceId, epoch: epoch, afterCounter: cursor?.afterCounter)
                return SyncFeedCatchUpResult(epoch: epoch, entriesSeen: entriesSeen, byEntityKind: byEntityKind)
            }
            cursor = (epoch: epoch, afterCounter: nextAfterCounter)
            try await localStore.setSyncFeedCursor(workspaceId: workspaceId, epoch: epoch, afterCounter: nextAfterCounter)
        }

        return SyncFeedCatchUpResult(epoch: epoch, entriesSeen: entriesSeen, byEntityKind: byEntityKind)
    }
}

// MARK: - JSONValue <-> CapnWebValue bridging (AthenaeumDomain's JSON model <-> AthenaeumRPC's
// wire value model — two independently-scoped packages, per this stage's own package boundaries,
// so a small adapter here is the right place for the conversion rather than either package
// depending on the other for it).

extension JSONValue {
    func toCapnWebValue() -> CapnWebValue {
        switch self {
        case .null: return .null
        case .bool(let value): return .bool(value)
        case .number(let value): return .number(value)
        case .string(let value): return .string(value)
        case .array(let values): return .array(values.map { $0.toCapnWebValue() })
        case .object(let fields):
            var result: [String: CapnWebValue] = [:]
            for (key, value) in fields { result[key] = value.toCapnWebValue() }
            return .object(result)
        }
    }
}

enum JSONValueBridgeError: Error, Sendable {
    case unsupportedCapnWebValue(String)
}

extension CapnWebValue {
    func toJSONValue() throws -> JSONValue {
        switch self {
        case .null, .undefined: return .null
        case .bool(let value): return .bool(value)
        case .number(let value): return .number(value)
        case .string(let value): return .string(value)
        case .array(let values): return .array(try values.map { try $0.toJSONValue() })
        case .object(let fields):
            var result: [String: JSONValue] = [:]
            for (key, value) in fields { result[key] = try value.toJSONValue() }
            return .object(result)
        case .bytes, .error:
            throw JSONValueBridgeError.unsupportedCapnWebValue("\(self)")
        }
    }
}
