import Foundation
import AthenaeumDomain

// `LocalWorkspaceStore` — plan §"Repo/package layout"'s "Swift actors: local SQLite authority" and
// plan §"Sync protocol"'s "Native local SQLite stays the immediate write authority
// (durable-before-sync)": every structured mutation this client makes (`Node`/`Page` reference
// rows/`Tag`/`Fact`/`Edge`) is written here FIRST, synchronously, before any network call is
// attempted — `WorkspaceSyncClient` (this package's orchestrator) is the only caller that decides
// when/whether a locally-durable row also gets pushed to the backend, and a push failure never
// loses the local write, only leaves its `dirty` flag set for a later retry.
//
// One v1 migration (task's own scope: "even if just one v1 migration for Phase 2's scope") —
// this is deliberately not new-notes' full crash-safety/forensic-backup migration apparatus
// (`SQLiteStore.swift`'s `migrate`/`backupBeforeMigrationIfNeeded`/`recoverInterruptedBootstrapFiles`)
// — that machinery answers a multi-year, multi-migration production app's problems, which this
// stage's single-schema-version scope doesn't have yet. `PRAGMA user_version` is the same
// versioning primitive new-notes uses; a later stage adding migration 2 should follow this same
// `if version < N` ladder, not redesign it.

public enum LocalWorkspaceStoreError: Error, Sendable, Equatable {
    /// Mirrors the backend's own `NodeNotFound` precondition on `createPage`
    /// (`notes-service-live.ts`: `yield* nodesRepository.get(nodeId)` before creating a page) —
    /// enforced here too so a page row can never locally reference a node this store doesn't
    /// have, even though SQLite foreign keys are off (see `SQLite3Connection`'s doc comment).
    case nodeNotFound(EntityId)
    case pageNotFound(EntityId)
    case decodingFailed(String)
}

/// The local SQLite write authority for one workspace's structured entities: `Node`, `Page`
/// (reference row + Automerge snapshot bytes — see `PageDocumentStore` for the actual CRDT
/// operations), `Tag`, `Fact`, `Edge`. Actor-isolated for the same reason new-notes' `SQLiteStore`
/// is (`"The only owner of the SQLite connection. All local state transitions are
/// actor-isolated."`) — `SQLite3Connection` itself has no internal synchronization.
public actor LocalWorkspaceStore {
    private let connection: SQLite3Connection
    public nonisolated let path: String

    private static let currentSchemaVersion = 1

    public init(path: String) throws {
        self.path = path
        self.connection = try SQLite3Connection(path: path)
        try Self.migrate(connection)
    }

    /// A private, on-disk-but-throwaway database in the caller's temp directory — used by tests
    /// and by any caller that wants real SQLite file-durability semantics without a real workspace
    /// path. `:memory:` (SQLite's genuine in-memory mode) works too via `init(path:)` directly.
    public static func scratchPath(label: String = UUID().uuidString) -> String {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("athenaeum-workspace-\(label).sqlite3")
            .path
    }

    private static func migrate(_ connection: SQLite3Connection) throws {
        let version = try connection.userVersion()
        guard version < currentSchemaVersion else { return }

        try connection.transaction {
            try connection.exec(
                """
                CREATE TABLE IF NOT EXISTS nodes (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    dirty INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS nodes_by_workspace ON nodes(workspace_id);

                CREATE TABLE IF NOT EXISTS pages (
                    node_id TEXT PRIMARY KEY,
                    automerge_doc_id TEXT NOT NULL,
                    heads_hash TEXT NOT NULL,
                    doc_bytes BLOB,
                    dirty INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS tags (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    parent_ids TEXT NOT NULL,
                    builtin INTEGER NOT NULL,
                    dirty INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS facts (
                    id TEXT PRIMARY KEY,
                    node_id TEXT NOT NULL,
                    predicate_id TEXT NOT NULL,
                    value TEXT NOT NULL,
                    dirty INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS facts_by_node ON facts(node_id);

                CREATE TABLE IF NOT EXISTS edges (
                    id TEXT PRIMARY KEY,
                    relation_definition_id TEXT NOT NULL,
                    source_node_id TEXT NOT NULL,
                    target_node_id TEXT NOT NULL,
                    dirty INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS edges_by_source ON edges(source_node_id);
                CREATE INDEX IF NOT EXISTS edges_by_target ON edges(target_node_id);

                CREATE TABLE IF NOT EXISTS sync_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )
            try connection.setUserVersion(currentSchemaVersion)
        }
    }

    // MARK: - JSON helpers (parentIds / Fact.value round-trip through TEXT columns)

    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()

    private static func encodeJSON<T: Encodable>(_ value: T) throws -> String {
        let data = try encoder.encode(value)
        guard let text = String(data: data, encoding: .utf8) else {
            throw LocalWorkspaceStoreError.decodingFailed("non-UTF8 JSON encoding")
        }
        return text
    }

    private static func decodeJSON<T: Decodable>(_ type: T.Type, from text: String) throws -> T {
        guard let data = text.data(using: .utf8) else {
            throw LocalWorkspaceStoreError.decodingFailed("non-UTF8 stored JSON: \(text)")
        }
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw LocalWorkspaceStoreError.decodingFailed("\(error) (raw: \(text))")
        }
    }

    // MARK: - Nodes

    /// Upserts `node` locally. `dirty: true` (the default) marks it as having local changes not
    /// yet confirmed pushed to the backend — `WorkspaceSyncClient` clears this via `markNodeSynced`
    /// once the corresponding RPC call succeeds.
    public func upsertNode(_ node: Node, dirty: Bool = true) throws {
        try connection.run(
            """
            INSERT INTO nodes (id, workspace_id, title, created_at, dirty) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, title = excluded.title,
                created_at = excluded.created_at, dirty = excluded.dirty;
            """,
            [.text(node.id.rawValue), .text(node.workspaceId.rawValue), .text(node.title),
             .text(node.createdAt.rawValue), .int(dirty ? 1 : 0)]
        )
    }

    public func markNodeSynced(id: EntityId) throws {
        try connection.run("UPDATE nodes SET dirty = 0 WHERE id = ?;", [.text(id.rawValue)])
    }

    private func rowToNode(_ statement: OpaquePointer) throws -> Node {
        Node(
            id: try EntityId(validating: columnText(statement, 0)),
            workspaceId: try EntityId(validating: columnText(statement, 1)),
            title: columnText(statement, 2),
            createdAt: try IsoDateTimeString(validating: columnText(statement, 3))
        )
    }

    public func node(id: EntityId) throws -> Node? {
        try connection.query(
            "SELECT id, workspace_id, title, created_at FROM nodes WHERE id = ?;",
            [.text(id.rawValue)],
            map: rowToNode
        ).first
    }

    public func listNodes(workspaceId: EntityId) throws -> [Node] {
        try connection.query(
            "SELECT id, workspace_id, title, created_at FROM nodes WHERE workspace_id = ? ORDER BY created_at;",
            [.text(workspaceId.rawValue)],
            map: rowToNode
        )
    }

    public func listDirtyNodes(workspaceId: EntityId) throws -> [Node] {
        try connection.query(
            "SELECT id, workspace_id, title, created_at FROM nodes WHERE workspace_id = ? AND dirty = 1;",
            [.text(workspaceId.rawValue)],
            map: rowToNode
        )
    }

    // MARK: - Pages (reference row + Automerge snapshot bytes)

    /// Requires `page.nodeId` to already exist in `nodes` (mirrors the backend's own
    /// `createPage` precondition — see this file's top doc comment).
    public func upsertPage(_ page: Page, docBytes: Data?, dirty: Bool = true) throws {
        guard try node(id: page.nodeId) != nil else {
            throw LocalWorkspaceStoreError.nodeNotFound(page.nodeId)
        }
        try connection.run(
            """
            INSERT INTO pages (node_id, automerge_doc_id, heads_hash, doc_bytes, dirty)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(node_id) DO UPDATE SET automerge_doc_id = excluded.automerge_doc_id,
                heads_hash = excluded.heads_hash,
                doc_bytes = COALESCE(excluded.doc_bytes, pages.doc_bytes),
                dirty = excluded.dirty;
            """,
            [.text(page.nodeId.rawValue), .text(page.automergeDocId), .text(page.headsHash),
             docBytes.map(SQLiteValue.blob) ?? .null, .int(dirty ? 1 : 0)]
        )
    }

    public func markPageSynced(nodeId: EntityId) throws {
        try connection.run("UPDATE pages SET dirty = 0 WHERE node_id = ?;", [.text(nodeId.rawValue)])
    }

    public func page(nodeId: EntityId) throws -> Page? {
        try connection.query(
            "SELECT node_id, automerge_doc_id, heads_hash FROM pages WHERE node_id = ?;",
            [.text(nodeId.rawValue)]
        ) { statement in
            Page(
                nodeId: try EntityId(validating: columnText(statement, 0)),
                automergeDocId: columnText(statement, 1),
                headsHash: columnText(statement, 2)
            )
        }.first
    }

    public func pageDocBytes(nodeId: EntityId) throws -> Data? {
        try connection.query(
            "SELECT doc_bytes FROM pages WHERE node_id = ?;",
            [.text(nodeId.rawValue)]
        ) { statement in columnBlob(statement, 0) }.first
    }

    // MARK: - Tags

    public func upsertTag(_ tag: Tag, dirty: Bool = true) throws {
        let parentIdsJSON = try Self.encodeJSON(tag.parentIds.map(\.rawValue))
        try connection.run(
            """
            INSERT INTO tags (id, name, parent_ids, builtin, dirty) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_ids = excluded.parent_ids,
                builtin = excluded.builtin, dirty = excluded.dirty;
            """,
            [.text(tag.id.rawValue), .text(tag.name), .text(parentIdsJSON),
             .int(tag.builtin ? 1 : 0), .int(dirty ? 1 : 0)]
        )
    }

    public func markTagSynced(id: EntityId) throws {
        try connection.run("UPDATE tags SET dirty = 0 WHERE id = ?;", [.text(id.rawValue)])
    }

    public func tag(id: EntityId) throws -> Tag? {
        try connection.query(
            "SELECT id, name, parent_ids, builtin FROM tags WHERE id = ?;",
            [.text(id.rawValue)],
            map: rowToTag
        ).first
    }

    public func listTags() throws -> [Tag] {
        try connection.query("SELECT id, name, parent_ids, builtin FROM tags ORDER BY name;", [], map: rowToTag)
    }

    private func rowToTag(_ statement: OpaquePointer) throws -> Tag {
        let parentIdStrings = try Self.decodeJSON([String].self, from: columnText(statement, 2))
        return Tag(
            id: try EntityId(validating: columnText(statement, 0)),
            name: columnText(statement, 1),
            parentIds: try parentIdStrings.map { try EntityId(validating: $0) },
            builtin: columnBool(statement, 3)
        )
    }

    // MARK: - Facts

    public func upsertFact(_ fact: Fact, dirty: Bool = true) throws {
        let valueJSON = try Self.encodeJSON(fact.value)
        try connection.run(
            """
            INSERT INTO facts (id, node_id, predicate_id, value, dirty) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id,
                predicate_id = excluded.predicate_id, value = excluded.value, dirty = excluded.dirty;
            """,
            [.text(fact.id.rawValue), .text(fact.nodeId.rawValue), .text(fact.predicateId),
             .text(valueJSON), .int(dirty ? 1 : 0)]
        )
    }

    public func markFactSynced(id: EntityId) throws {
        try connection.run("UPDATE facts SET dirty = 0 WHERE id = ?;", [.text(id.rawValue)])
    }

    private func rowToFact(_ statement: OpaquePointer) throws -> Fact {
        Fact(
            id: try EntityId(validating: columnText(statement, 0)),
            nodeId: try EntityId(validating: columnText(statement, 1)),
            predicateId: columnText(statement, 2),
            value: try Self.decodeJSON(JSONValue.self, from: columnText(statement, 3))
        )
    }

    public func listFacts(nodeId: EntityId) throws -> [Fact] {
        try connection.query(
            "SELECT id, node_id, predicate_id, value FROM facts WHERE node_id = ? ORDER BY id;",
            [.text(nodeId.rawValue)],
            map: rowToFact
        )
    }

    // MARK: - Edges

    public func upsertEdge(_ edge: Edge, dirty: Bool = true) throws {
        try connection.run(
            """
            INSERT INTO edges (id, relation_definition_id, source_node_id, target_node_id, dirty)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET relation_definition_id = excluded.relation_definition_id,
                source_node_id = excluded.source_node_id, target_node_id = excluded.target_node_id,
                dirty = excluded.dirty;
            """,
            [.text(edge.id.rawValue), .text(edge.relationDefinitionId.rawValue),
             .text(edge.sourceNodeId.rawValue), .text(edge.targetNodeId.rawValue), .int(dirty ? 1 : 0)]
        )
    }

    public func markEdgeSynced(id: EntityId) throws {
        try connection.run("UPDATE edges SET dirty = 0 WHERE id = ?;", [.text(id.rawValue)])
    }

    private func rowToEdge(_ statement: OpaquePointer) throws -> Edge {
        Edge(
            id: try EntityId(validating: columnText(statement, 0)),
            relationDefinitionId: try EntityId(validating: columnText(statement, 1)),
            sourceNodeId: try EntityId(validating: columnText(statement, 2)),
            targetNodeId: try EntityId(validating: columnText(statement, 3))
        )
    }

    /// Backlinks: edges targeting `nodeId` — the local mirror of the backend's own
    /// "non-unique index target→edges" query (`GraphDataModel.md` Evolution Rule #3, see
    /// `edge.ts`'s doc comment), computed the same way here: a query, never a second stored
    /// record.
    public func listBacklinks(targetNodeId: EntityId) throws -> [Edge] {
        try connection.query(
            "SELECT id, relation_definition_id, source_node_id, target_node_id FROM edges WHERE target_node_id = ?;",
            [.text(targetNodeId.rawValue)],
            map: rowToEdge
        )
    }

    public func listOutgoingEdges(sourceNodeId: EntityId) throws -> [Edge] {
        try connection.query(
            "SELECT id, relation_definition_id, source_node_id, target_node_id FROM edges WHERE source_node_id = ?;",
            [.text(sourceNodeId.rawValue)],
            map: rowToEdge
        )
    }

    // MARK: - Structured-record sync feed cursor (mirrors web/src/sync-feed-client.ts's
    // localStorage-backed `loadSyncFeedCursor`/`saveSyncFeedCursor`, but durable in this workspace's
    // own SQLite instead of a browser-only cache — the native analog of "durable-before-sync"
    // applied to the sync client's own bookkeeping, not just content rows.)

    public func syncFeedCursor(workspaceId: EntityId) throws -> (epoch: String, afterCounter: Int?)? {
        let key = "syncFeedCursor:\(workspaceId.rawValue)"
        guard let stored = try connection.query(
            "SELECT value FROM sync_meta WHERE key = ?;",
            [.text(key)],
            map: { columnText($0, 0) }
        ).first else { return nil }
        struct StoredCursor: Codable { let epoch: String; let afterCounter: Int? }
        let cursor = try Self.decodeJSON(StoredCursor.self, from: stored)
        return (cursor.epoch, cursor.afterCounter)
    }

    public func setSyncFeedCursor(workspaceId: EntityId, epoch: String, afterCounter: Int?) throws {
        struct StoredCursor: Codable { let epoch: String; let afterCounter: Int? }
        let key = "syncFeedCursor:\(workspaceId.rawValue)"
        let json = try Self.encodeJSON(StoredCursor(epoch: epoch, afterCounter: afterCounter))
        try connection.run(
            "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            [.text(key), .text(json)]
        )
    }
}
