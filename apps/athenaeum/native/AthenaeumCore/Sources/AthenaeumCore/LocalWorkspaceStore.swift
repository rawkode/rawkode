import Foundation
import AthenaeumDomain
import CryptoKit

// `LocalWorkspaceStore` — plan §"Repo/package layout"'s "Swift actors: local SQLite authority" and
// plan §"Sync protocol"'s "Native local SQLite stays the immediate write authority
// (durable-before-sync)": every structured mutation this client makes (`Node`/`Page` reference
// rows/`Tag`/`Fact`/`Edge`) is written here FIRST, synchronously, before any network call is
// attempted — `WorkspaceSyncClient` (this package's orchestrator) is the only caller that decides
// when/whether a locally-durable row also gets pushed to the backend, and a push failure never
// loses the local write, only leaves its `dirty` flag set for a later retry.
//
// The v1 and v2 migrations here deliberately remain smaller than new-notes' full
// crash-safety/forensic-backup migration apparatus
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
    case unsupportedSchemaVersion(Int)
    /// A database claiming a known user version must still have the exact table shape that
    /// version promised.  Treating a partial/manual v2 table as compatible would make a
    /// migration silently discard or mislabel durable Loro state.
    case unsupportedLoroPageLayout
    case invalidLoroPageState
    case injectedLoroWriteFailure
    case invalidLoroCheckpoint
    case checkpointAlreadyExists
    case invalidLoroCandidate
    case invalidLoroArchive
    case invalidDirtyEncoding
}

/// The immutable server witness returned with a legacy projection. Native no longer imports or
/// edits the Automerge document, but it still records the exact server version that produced the
/// read-only text so a later reload can detect a changed route rather than treating stale text as
/// current.
public struct LegacyPageProjectionWitness: Sendable, Equatable {
    public let nodeId: EntityId
    public let storageVersion: Int
    public let docId: String
    public let headsHash: String
    public let bytesSha256: String

    public init(nodeId: EntityId, storageVersion: Int, docId: String, headsHash: String, bytesSha256: String) {
        self.nodeId = nodeId
        self.storageVersion = storageVersion
        self.docId = docId
        self.headsHash = headsHash
        self.bytesSha256 = bytesSha256
    }
}

/// Exact durable state of the pre-migration local row. It is deliberately opaque to AppUI: when
/// `dirty` is true, native cannot reconcile the bytes without Automerge and must surface recovery
/// rather than replacing them with a server projection.
public struct LegacyLocalPageState: Sendable, Equatable {
    public let page: Page
    public let docBytes: Data?
    public let dirty: Bool

    public init(page: Page, docBytes: Data?, dirty: Bool) {
        self.page = page
        self.docBytes = docBytes
        self.dirty = dirty
    }
}

/// Result of atomically admitting a server-owned legacy projection into the local witness store.
public enum LegacyProjectionPersistenceDisposition: Sendable, Equatable {
    case persisted(LegacyPageProjectionWitness)
    case alreadyPersisted(LegacyPageProjectionWitness)
    case recoveryRequired(LegacyLocalPageState)
}

/// Sealed proof that a clean `loro_pages` row belongs to this workspace and still agrees with
/// its accepted descriptor.  The private initializer prevents a hydrated observation from being
/// promoted into literal authoring authority outside this source file.
struct LoroAcceptedPageEvidence: Sendable, Equatable {
    let workspaceId: EntityId
    let nodeId: EntityId
    let route: LoroPageRouteWitness
    let pageSchemaVersion: Int
    let snapshotBytes: Data
    let localSnapshotSHA256: String

    private init(workspaceId: EntityId, nodeId: EntityId, route: LoroPageRouteWitness, pageSchemaVersion: Int, snapshotBytes: Data, localSnapshotSHA256: String) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
        self.route = route
        self.pageSchemaVersion = pageSchemaVersion
        self.snapshotBytes = snapshotBytes
        self.localSnapshotSHA256 = localSnapshotSHA256
    }

    fileprivate static func accepted(
        workspaceId: EntityId,
        nodeId: EntityId,
        route: LoroPageRouteWitness,
        pageSchemaVersion: Int,
        snapshotBytes: Data,
        localSnapshotSHA256: String
    ) -> Self {
        .init(
            workspaceId: workspaceId,
            nodeId: nodeId,
            route: route,
            pageSchemaVersion: pageSchemaVersion,
            snapshotBytes: snapshotBytes,
            localSnapshotSHA256: localSnapshotSHA256
        )
    }
}

/// Opaque raw v7 evidence.  It is an input to the document actor's full semantic revalidation,
/// not a literal token and not a user-conformable trust protocol.
struct LoroFrozenCandidateEvidence: Sendable, Equatable {
    let workspaceId: EntityId
    let nodeId: EntityId
    let checkpoint: LoroSemanticCheckpoint
    let baseSnapshot: Data
    let baseSnapshotSHA256: String
    let candidateSnapshot: Data
    let candidateSnapshotSHA256: String
    let candidateResultVersionVector: Data
    let candidateResultVersionVectorSHA256: String
    let expectedResultRoute: LoroPageRouteWitness

    private init(
        workspaceId: EntityId,
        nodeId: EntityId,
        checkpoint: LoroSemanticCheckpoint,
        baseSnapshot: Data,
        baseSnapshotSHA256: String,
        candidateSnapshot: Data,
        candidateSnapshotSHA256: String,
        candidateResultVersionVector: Data,
        candidateResultVersionVectorSHA256: String,
        expectedResultRoute: LoroPageRouteWitness
    ) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
        self.checkpoint = checkpoint
        self.baseSnapshot = baseSnapshot
        self.baseSnapshotSHA256 = baseSnapshotSHA256
        self.candidateSnapshot = candidateSnapshot
        self.candidateSnapshotSHA256 = candidateSnapshotSHA256
        self.candidateResultVersionVector = candidateResultVersionVector
        self.candidateResultVersionVectorSHA256 = candidateResultVersionVectorSHA256
        self.expectedResultRoute = expectedResultRoute
    }

    fileprivate static func durable(
        workspaceId: EntityId,
        nodeId: EntityId,
        checkpoint: LoroSemanticCheckpoint,
        baseSnapshot: Data,
        baseSnapshotSHA256: String,
        candidateSnapshot: Data,
        candidateSnapshotSHA256: String,
        candidateResultVersionVector: Data,
        candidateResultVersionVectorSHA256: String,
        expectedResultRoute: LoroPageRouteWitness
    ) -> Self {
        .init(
            workspaceId: workspaceId,
            nodeId: nodeId,
            checkpoint: checkpoint,
            baseSnapshot: baseSnapshot,
            baseSnapshotSHA256: baseSnapshotSHA256,
            candidateSnapshot: candidateSnapshot,
            candidateSnapshotSHA256: candidateSnapshotSHA256,
            candidateResultVersionVector: candidateResultVersionVector,
            candidateResultVersionVectorSHA256: candidateResultVersionVectorSHA256,
            expectedResultRoute: expectedResultRoute
        )
    }
}

/// The local SQLite write authority for one workspace's structured entities: `Node`, `Page`
/// (legacy reference row and recoverable bytes), `Tag`, `Fact`, `Edge`. Actor-isolated for the same reason new-notes' `SQLiteStore`
/// is (`"The only owner of the SQLite connection. All local state transitions are
/// actor-isolated."`) — `SQLite3Connection` itself has no internal synchronization.
public actor LocalWorkspaceStore {
    private let connection: SQLite3Connection
    private let failLoroPageWrites: Bool
    private var remainingLoroWritesBeforeFailure: Int?
    private var failAfterV7ArchiveWrite: Bool
    private var failAfterV7AcceptedPageWrite: Bool
    private var failBeforeV7TerminalUpdate: Bool
    public nonisolated let path: String

    private static let currentSchemaVersion = 8

    private struct TableColumn: Equatable {
        let name: String
        let type: String
        let notNull: Bool
        let defaultValue: String?
        let primaryKey: Bool
    }

    // SQLite reports `TEXT PRIMARY KEY` as `notnull = 0` unless it is also explicitly marked
    // NOT NULL, so retain that detail in the expected layouts rather than normalizing it away.
    private static let legacyV2LoroPageLayout: [TableColumn] = [
        .init(name: "node_id", type: "TEXT", notNull: false, defaultValue: nil, primaryKey: true),
        .init(name: "page_schema_version", type: "INTEGER", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "snapshot_bytes", type: "BLOB", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "local_snapshot_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "dirty", type: "INTEGER", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "server_storage_version", type: "INTEGER", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "server_snapshot_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
    ]

    private static let observedV2LoroPageLayout: [TableColumn] = [
        .init(name: "node_id", type: "TEXT", notNull: false, defaultValue: nil, primaryKey: true),
        .init(name: "page_schema_version", type: "INTEGER", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "snapshot_bytes", type: "BLOB", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "local_snapshot_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "dirty", type: "INTEGER", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "observed_descriptor_storage_version", type: "INTEGER", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "observed_descriptor_snapshot_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
    ]

    public init(path: String) throws {
        try self.init(path: path, failLoroPageWrites: false)
    }

    /// Test-only failure injection for proving that cache publication happens after durable write.
    init(path: String, failLoroPageWrites: Bool, failLoroPageWritesAfter successfulWrites: Int? = nil,
         failAfterV7ArchiveWrite: Bool = false, failAfterV7AcceptedPageWrite: Bool = false,
         failBeforeV7TerminalUpdate: Bool = false) throws {
        self.path = path
        self.failLoroPageWrites = failLoroPageWrites
        self.remainingLoroWritesBeforeFailure = successfulWrites
        self.failAfterV7ArchiveWrite = failAfterV7ArchiveWrite
        self.failAfterV7AcceptedPageWrite = failAfterV7AcceptedPageWrite
        self.failBeforeV7TerminalUpdate = failBeforeV7TerminalUpdate
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
        guard version <= currentSchemaVersion else {
            throw LocalWorkspaceStoreError.unsupportedSchemaVersion(version)
        }

        if version < 1 {
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
                try connection.setUserVersion(1)
            }
        }

        if version < 2 {
            // This migration intentionally leaves the v1 `pages` table completely alone:
            // Automerge bytes must remain recoverable while Loro becomes the authority for new
            // pages. The version bump lives in the same transaction as the new table.
            try connection.transaction {
                try connection.exec(
                    """
                    CREATE TABLE IF NOT EXISTS loro_pages (
                        node_id TEXT PRIMARY KEY,
                        page_schema_version INTEGER NOT NULL,
                        snapshot_bytes BLOB NOT NULL,
                        local_snapshot_sha256 TEXT NOT NULL,
                        dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
                        server_storage_version INTEGER NOT NULL,
                        server_snapshot_sha256 TEXT NOT NULL
                    );
                    """
                )
                try connection.setUserVersion(2)
            }
        }

        if version < 3 {
            // Two v2 builds escaped: the initial one used `server_*`, while the direct-parent
            // repair already used `observed_descriptor_*` but retained user_version 2.  Inspect
            // the whole table layout before choosing a path.  Unknown or mixed tables fail
            // closed rather than risking durable state during a guessed migration.
            try connection.transaction {
                switch try loroPageTableLayout(connection) {
                case legacyV2LoroPageLayout:
                    try connection.exec(
                        """
                        CREATE TABLE loro_pages_v3 (
                            node_id TEXT PRIMARY KEY,
                            page_schema_version INTEGER NOT NULL,
                            snapshot_bytes BLOB NOT NULL,
                            local_snapshot_sha256 TEXT NOT NULL,
                            dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
                            observed_descriptor_storage_version INTEGER NOT NULL,
                            observed_descriptor_snapshot_sha256 TEXT NOT NULL
                        );
                        INSERT INTO loro_pages_v3 (
                            node_id, page_schema_version, snapshot_bytes, local_snapshot_sha256, dirty,
                            observed_descriptor_storage_version, observed_descriptor_snapshot_sha256
                        ) SELECT
                            node_id, page_schema_version, snapshot_bytes, local_snapshot_sha256, dirty,
                            server_storage_version, server_snapshot_sha256
                        FROM loro_pages;
                        DROP TABLE loro_pages;
                        ALTER TABLE loro_pages_v3 RENAME TO loro_pages;
                        """
                    )
                case observedV2LoroPageLayout:
                    // This is the already-repaired v2 layout.  Its data is already v3-shaped;
                    // only make the version marker durable in this same transaction.
                    break
                default:
                    throw LocalWorkspaceStoreError.unsupportedLoroPageLayout
                }
                try connection.setUserVersion(3)
            }
        }

        if version < 4 {
            // Checkpoints deliberately live beside (rather than inside) `loro_pages`: a clean
            // page has no row here, and the composite key is the semantic identity of a frozen
            // operation.  No migration rewrites either legacy Automerge or Loro bytes.
            try connection.transaction {
                try connection.exec(
                    """
                    CREATE TABLE loro_semantic_checkpoints (
                        workspace_id TEXT NOT NULL,
                        node_id TEXT NOT NULL,
                        state TEXT NOT NULL CHECK (state IN ('inFlight','retainedRetry','retainedConflict','retainedRequestIdentity')),
                        request_id TEXT NOT NULL,
                        commit_message TEXT NOT NULL,
                        attribution_kind TEXT NOT NULL CHECK (attribution_kind IN ('humanUi','agentJob','system')),
                        attribution_one TEXT NOT NULL,
                        attribution_two TEXT,
                        route_storage_version INTEGER NOT NULL CHECK (route_storage_version > 0),
                        route_schema_version INTEGER NOT NULL CHECK (route_schema_version > 0),
                        route_snapshot_sha256 TEXT NOT NULL,
                        update_bytes BLOB NOT NULL,
                        update_sha256 TEXT NOT NULL,
                        base_version_vector BLOB NOT NULL,
                        base_version_vector_sha256 TEXT NOT NULL,
                        PRIMARY KEY (workspace_id, node_id),
                        UNIQUE (node_id),
                        CHECK (length(request_id) BETWEEN 1 AND 200),
                        CHECK (length(commit_message) BETWEEN 1 AND 500),
                        CHECK (length(update_bytes) BETWEEN 1 AND 2097152),
                        CHECK (length(base_version_vector) BETWEEN 1 AND 65536),
                        CHECK (length(route_snapshot_sha256) = 64),
                        CHECK (length(update_sha256) = 64),
                        CHECK (length(base_version_vector_sha256) = 64),
                        CHECK ((attribution_kind = 'agentJob' AND attribution_two IS NOT NULL) OR
                               (attribution_kind != 'agentJob' AND attribution_two IS NULL))
                    );
                    """
                )
                try connection.setUserVersion(4)
            }
        }

        if version < 5 {
            try connection.transaction {
                // v4 stays immutable. Its shape and every row are reconstructed before copy.
                guard try checkpointTableLayout(connection) == checkpointLayout,
                      try checkpointTableDefinitionIsExact(connection, table: "loro_semantic_checkpoints", expected: v4CheckpointTableSQL),
                      try checkpointTableIndexesAreExact(connection, table: "loro_semantic_checkpoints", permitsLegacyNodeUnique: true) else {
                    throw LocalWorkspaceStoreError.invalidLoroCheckpoint
                }
                let source = try checkpointRows(connection, table: "loro_semantic_checkpoints")
                try connection.exec("""
                    CREATE TABLE loro_semantic_checkpoints_v5 (
                        workspace_id TEXT NOT NULL, node_id TEXT NOT NULL,
                        state TEXT NOT NULL CHECK (state IN ('inFlight','retainedRetry','retainedConflict','retainedRequestIdentity')),
                        request_id TEXT NOT NULL, commit_message TEXT NOT NULL,
                        attribution_kind TEXT NOT NULL CHECK (attribution_kind IN ('humanUi','agentJob','system')),
                        attribution_one TEXT NOT NULL, attribution_two TEXT,
                        route_storage_version INTEGER NOT NULL CHECK (route_storage_version > 0), route_schema_version INTEGER NOT NULL CHECK (route_schema_version > 0),
                        route_snapshot_sha256 TEXT NOT NULL, update_bytes BLOB NOT NULL, update_sha256 TEXT NOT NULL,
                        base_version_vector BLOB NOT NULL, base_version_vector_sha256 TEXT NOT NULL,
                        PRIMARY KEY (workspace_id,node_id),
                        CHECK(length(request_id) BETWEEN 1 AND 200), CHECK(length(commit_message) BETWEEN 1 AND 500),
                        CHECK(length(update_bytes) BETWEEN 1 AND 2097152), CHECK(length(base_version_vector) BETWEEN 1 AND 65536),
                        CHECK(length(route_snapshot_sha256)=64), CHECK(length(update_sha256)=64), CHECK(length(base_version_vector_sha256)=64),
                        CHECK((attribution_kind='agentJob' AND attribution_two IS NOT NULL) OR (attribution_kind!='agentJob' AND attribution_two IS NULL))
                    );
                    INSERT INTO loro_semantic_checkpoints_v5 SELECT * FROM loro_semantic_checkpoints;
                    """)
                let destination = try checkpointRows(connection, table: "loro_semantic_checkpoints_v5")
                guard source.count == destination.count,
                      source.allSatisfy({ sourceCheckpoint in destination.contains(sourceCheckpoint) }) else { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
                try connection.setUserVersion(5)
            }
        }

        if version < 6 {
            // v5 checkpoint rows are immutable forensic evidence. They predate an independently
            // durable clone snapshot, so they are intentionally never upgraded into dispatchable
            // candidates. New submissions use this separate v6 table; `loro_pages` remains the
            // accepted-server authority throughout a speculative edit.
            try connection.transaction {
                guard try checkpointTableLayout(connection, table: "loro_semantic_checkpoints_v5") == checkpointLayout,
                      try checkpointTableDefinitionIsExact(connection, table: "loro_semantic_checkpoints_v5", expected: v5CheckpointTableSQL),
                      try checkpointTableIndexesAreExact(connection, table: "loro_semantic_checkpoints_v5", permitsLegacyNodeUnique: false) else {
                    throw LocalWorkspaceStoreError.invalidLoroCheckpoint
                }
                _ = try checkpointRows(connection, table: "loro_semantic_checkpoints_v5")
                try connection.exec(v6CandidateTableSQL)
                try connection.setUserVersion(6)
            }
        }

        if version < 7 {
            // v6 remains byte-for-byte forensic evidence.  It did not carry the literal base
            // snapshot, so it cannot be replayed or upgraded.  v7 starts empty and persists a
            // complete frozen chain instead.
            try connection.transaction {
                guard try candidateV6TableLayout(connection) == candidateV6Layout,
                      try checkpointTableDefinitionIsExact(connection, table: "loro_semantic_candidates_v6", expected: v6CandidateTableSQL),
                      try checkpointTableIndexesAreExact(connection, table: "loro_semantic_candidates_v6", permitsLegacyNodeUnique: false) else {
                    throw LocalWorkspaceStoreError.invalidLoroCheckpoint
                }
                try connection.exec(v7CandidateTableSQL)
                try connection.exec(v7ArchiveTableSQL)
                try connection.setUserVersion(7)
            }
        }

        if version < 8 {
            // Legacy projection admission needs a durable, same-load witness without making the
            // native process decode Automerge bytes. Keep it in its own table so the historical
            // `pages` row (including recoverable `doc_bytes`) remains untouched when dirty.
            try connection.transaction {
                try connection.exec(
                    """
                    CREATE TABLE IF NOT EXISTS legacy_page_witnesses (
                        node_id TEXT PRIMARY KEY,
                        storage_version INTEGER NOT NULL CHECK (storage_version > 0),
                        automerge_doc_id TEXT NOT NULL,
                        heads_hash TEXT NOT NULL,
                        bytes_sha256 TEXT NOT NULL CHECK (length(bytes_sha256) = 64)
                    );
                    """
                )
                try connection.setUserVersion(8)
            }
        }

        // The archive belongs to the v7 retention contract. It is additive: an interrupted
        // pre-archive v7 rollout gains only the empty table; no v7 evidence is rewritten or
        // compacted. The working-table proof below remains the admission boundary.
        let archiveExists = try connection.query(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='loro_semantic_checkpoint_archive_v7';"
        ) { _ in true }.first ?? false
        if !archiveExists {
            try connection.exec(v7ArchiveTableSQL)
        }

        // Validate after the whole ladder, not against the entry version.
        guard try checkpointTableLayout(connection, table: "loro_semantic_checkpoints_v5") == checkpointLayout,
              try checkpointTableDefinitionIsExact(connection, table: "loro_semantic_checkpoints_v5", expected: v5CheckpointTableSQL),
              try checkpointTableIndexesAreExact(connection, table: "loro_semantic_checkpoints_v5", permitsLegacyNodeUnique: false),
              try loroPageTableLayout(connection) == observedV2LoroPageLayout,
              try candidateV6TableLayout(connection) == candidateV6Layout,
              try checkpointTableDefinitionIsExact(connection, table: "loro_semantic_candidates_v6", expected: v6CandidateTableSQL),
              try checkpointTableIndexesAreExact(connection, table: "loro_semantic_candidates_v6", permitsLegacyNodeUnique: false),
              try candidateV7TableLayout(connection) == candidateV7Layout,
              try checkpointTableDefinitionIsExact(connection, table: "loro_semantic_candidates_v7", expected: v7CandidateTableSQL),
              try checkpointTableIndexesAreExact(connection, table: "loro_semantic_candidates_v7", permitsLegacyNodeUnique: false),
              try archiveV7TableLayout(connection) == archiveV7Layout,
              try checkpointTableDefinitionIsExact(connection, table: "loro_semantic_checkpoint_archive_v7", expected: v7ArchiveTableSQL),
              try archiveV7TableIndexesAreExact(connection),
              try legacyPageWitnessTableLayout(connection) == legacyPageWitnessLayout else {
            throw LocalWorkspaceStoreError.invalidLoroCheckpoint
        }
    }

    private static func loroPageTableLayout(_ connection: SQLite3Connection) throws -> [TableColumn] {
        try connection.query("PRAGMA table_info(loro_pages);") { statement in
            TableColumn(
                name: columnText(statement, 1),
                type: columnText(statement, 2).uppercased(),
                notNull: columnBool(statement, 3),
                defaultValue: columnOptionalText(statement, 4),
                primaryKey: columnBool(statement, 5)
            )
        }
    }

    private static let legacyPageWitnessLayout: [TableColumn] = [
        .init(name: "node_id", type: "TEXT", notNull: false, defaultValue: nil, primaryKey: true),
        .init(name: "storage_version", type: "INTEGER", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "automerge_doc_id", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "heads_hash", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "bytes_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
    ]

    private static func legacyPageWitnessTableLayout(_ connection: SQLite3Connection) throws -> [TableColumn] {
        try connection.query("PRAGMA table_info(legacy_page_witnesses);") { statement in
            TableColumn(
                name: columnText(statement, 1),
                type: columnText(statement, 2).uppercased(),
                notNull: columnBool(statement, 3),
                defaultValue: columnOptionalText(statement, 4),
                primaryKey: columnBool(statement, 5)
            )
        }
    }

    private static let checkpointLayout: [TableColumn] = [
        .init(name: "workspace_id", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: true),
        .init(name: "node_id", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: true),
        .init(name: "state", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "request_id", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "commit_message", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "attribution_kind", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "attribution_one", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "attribution_two", type: "TEXT", notNull: false, defaultValue: nil, primaryKey: false),
        .init(name: "route_storage_version", type: "INTEGER", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "route_schema_version", type: "INTEGER", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "route_snapshot_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "update_bytes", type: "BLOB", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "update_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "base_version_vector", type: "BLOB", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "base_version_vector_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
    ]

    private static func checkpointTableLayout(_ connection: SQLite3Connection, table: String = "loro_semantic_checkpoints") throws -> [TableColumn] {
        try connection.query("PRAGMA table_info(\(table));") { statement in
            TableColumn(name: columnText(statement, 1), type: columnText(statement, 2).uppercased(), notNull: columnBool(statement, 3), defaultValue: columnOptionalText(statement, 4), primaryKey: columnBool(statement, 5))
        }
    }

    private static let candidateV6Layout: [TableColumn] = checkpointLayout + [
        .init(name: "candidate_snapshot", type: "BLOB", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "candidate_snapshot_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "candidate_result_version_vector", type: "BLOB", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "candidate_result_version_vector_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "expected_result_storage_version", type: "INTEGER", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "expected_result_schema_version", type: "INTEGER", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "expected_result_snapshot_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
    ]

    private static func candidateV6TableLayout(_ connection: SQLite3Connection) throws -> [TableColumn] {
        try checkpointTableLayout(connection, table: "loro_semantic_candidates_v6")
    }

    private static let candidateV7Layout: [TableColumn] = checkpointLayout + [
        .init(name: "base_snapshot", type: "BLOB", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "base_snapshot_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "candidate_snapshot", type: "BLOB", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "candidate_snapshot_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "candidate_result_version_vector", type: "BLOB", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "candidate_result_version_vector_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "expected_result_storage_version", type: "INTEGER", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "expected_result_schema_version", type: "INTEGER", notNull: true, defaultValue: nil, primaryKey: false),
        .init(name: "expected_result_snapshot_sha256", type: "TEXT", notNull: true, defaultValue: nil, primaryKey: false),
    ]

    private static func candidateV7TableLayout(_ connection: SQLite3Connection) throws -> [TableColumn] {
        try checkpointTableLayout(connection, table: "loro_semantic_candidates_v7")
    }

    /// The archive deliberately has a different primary key from the dispatchable working slot:
    /// every accepted request remains addressable after that slot is reused for a later edit.
    private static let archiveV7Layout: [TableColumn] = candidateV7Layout.enumerated().map { offset, column in
        switch offset {
        case 0, 1, 3:
            return .init(name: column.name, type: column.type, notNull: column.notNull, defaultValue: column.defaultValue, primaryKey: true)
        default:
            return column
        }
    }

    private static func archiveV7TableLayout(_ connection: SQLite3Connection) throws -> [TableColumn] {
        try checkpointTableLayout(connection, table: "loro_semantic_checkpoint_archive_v7")
    }

    private static func checkpointRows(_ connection: SQLite3Connection, table: String) throws -> [LoroSemanticCheckpoint] {
        try connection.query("SELECT workspace_id,node_id,state,request_id,commit_message,attribution_kind,attribution_one,attribution_two,route_storage_version,route_schema_version,route_snapshot_sha256,update_bytes,update_sha256,base_version_vector,base_version_vector_sha256 FROM \(table);") { s in
            let attribution: LoroMutationAttributionV1
            switch (columnText(s, 5), columnOptionalText(s, 7)) { case ("humanUi", nil): attribution = .humanUi(surface: columnText(s, 6)); case ("agentJob", let run?): attribution = .agentJob(jobId: columnText(s, 6), runId: run); case ("system", nil): attribution = .system(source: columnText(s, 6)); default: throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
            let intent = try LoroMutationIntentV1(requestId: columnText(s, 3), commitMessage: columnText(s, 4), attribution: attribution)
            return try LoroSemanticCheckpoint.reconstruct(workspaceId: EntityId(validating: columnText(s, 0)), nodeId: EntityId(validating: columnText(s, 1)), state: columnText(s, 2), requestId: intent.requestId, commitMessage: intent.commitMessage, attributionKind: columnText(s, 5), attributionOne: columnText(s, 6), attributionTwo: columnOptionalText(s, 7), storageVersion: columnInt(s, 8), schemaVersion: columnInt(s, 9), snapshotSHA256: columnText(s, 10), update: columnBlob(s, 11), updateSHA256: columnText(s, 12), baseVersionVector: columnBlob(s, 13), baseVersionVectorSHA256: columnText(s, 14))
        }
    }

    private static func checkpointTableDefinitionIsExact(_ connection: SQLite3Connection, table: String, expected: String) throws -> Bool {
        let sql = try connection.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?;", [.text(table)]) { columnText($0, 0) }.first ?? ""
        return normalizedSQL(sql) == normalizedSQL(expected)
    }

    private static func checkpointTableIndexesAreExact(_ connection: SQLite3Connection, table: String, permitsLegacyNodeUnique: Bool) throws -> Bool {
        let indexes = try connection.query("PRAGMA index_list(\(table));") { statement in
            (columnText(statement, 1), columnBool(statement, 2), columnText(statement, 3))
        }
        guard indexes.count == (permitsLegacyNodeUnique ? 2 : 1) else { return false }
        let primaryKeyIndexes = indexes.filter { $0.2 == "pk" && $0.1 }
        guard primaryKeyIndexes.count == 1 else { return false }
        let primaryKeyColumns = try connection.query("PRAGMA index_info(\(primaryKeyIndexes[0].0));") { columnText($0, 2) }
        guard primaryKeyColumns == ["workspace_id", "node_id"] else { return false }
        return permitsLegacyNodeUnique ? indexes.contains(where: { $0.2 == "u" && $0.1 && (try? connection.query("PRAGMA index_info(\($0.0));") { columnText($0, 2) }) == ["node_id"] }) : true
    }

    private static func archiveV7TableIndexesAreExact(_ connection: SQLite3Connection) throws -> Bool {
        let indexes = try connection.query("PRAGMA index_list(loro_semantic_checkpoint_archive_v7);") { statement in
            (columnText(statement, 1), columnBool(statement, 2), columnText(statement, 3))
        }
        guard indexes.count == 1,
              let primary = indexes.first,
              primary.1, primary.2 == "pk" else { return false }
        let columns = try connection.query("PRAGMA index_info(\(primary.0));") { columnText($0, 2) }
        return columns == ["workspace_id", "node_id", "request_id"]
    }

    private static func normalizedSQL(_ sql: String) -> String { sql.lowercased().filter { !$0.isWhitespace } }

    private static let v4CheckpointTableSQL = """
    CREATE TABLE loro_semantic_checkpoints (
        workspace_id TEXT NOT NULL, node_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('inFlight','retainedRetry','retainedConflict','retainedRequestIdentity')),
        request_id TEXT NOT NULL, commit_message TEXT NOT NULL,
        attribution_kind TEXT NOT NULL CHECK (attribution_kind IN ('humanUi','agentJob','system')),
        attribution_one TEXT NOT NULL, attribution_two TEXT,
        route_storage_version INTEGER NOT NULL CHECK (route_storage_version > 0),
        route_schema_version INTEGER NOT NULL CHECK (route_schema_version > 0),
        route_snapshot_sha256 TEXT NOT NULL, update_bytes BLOB NOT NULL, update_sha256 TEXT NOT NULL,
        base_version_vector BLOB NOT NULL, base_version_vector_sha256 TEXT NOT NULL,
        PRIMARY KEY (workspace_id, node_id), UNIQUE (node_id),
        CHECK (length(request_id) BETWEEN 1 AND 200), CHECK (length(commit_message) BETWEEN 1 AND 500),
        CHECK (length(update_bytes) BETWEEN 1 AND 2097152), CHECK (length(base_version_vector) BETWEEN 1 AND 65536),
        CHECK (length(route_snapshot_sha256) = 64), CHECK (length(update_sha256) = 64), CHECK (length(base_version_vector_sha256) = 64),
        CHECK ((attribution_kind = 'agentJob' AND attribution_two IS NOT NULL) OR
               (attribution_kind != 'agentJob' AND attribution_two IS NULL))
    )
    """

    private static let v5CheckpointTableSQL = """
    CREATE TABLE loro_semantic_checkpoints_v5 (workspace_id TEXT NOT NULL,node_id TEXT NOT NULL,state TEXT NOT NULL CHECK (state IN ('inFlight','retainedRetry','retainedConflict','retainedRequestIdentity')),request_id TEXT NOT NULL,commit_message TEXT NOT NULL,attribution_kind TEXT NOT NULL CHECK (attribution_kind IN ('humanUi','agentJob','system')),attribution_one TEXT NOT NULL,attribution_two TEXT,route_storage_version INTEGER NOT NULL CHECK (route_storage_version > 0),route_schema_version INTEGER NOT NULL CHECK (route_schema_version > 0),route_snapshot_sha256 TEXT NOT NULL,update_bytes BLOB NOT NULL,update_sha256 TEXT NOT NULL,base_version_vector BLOB NOT NULL,base_version_vector_sha256 TEXT NOT NULL,PRIMARY KEY (workspace_id,node_id),CHECK(length(request_id) BETWEEN 1 AND 200),CHECK(length(commit_message) BETWEEN 1 AND 500),CHECK(length(update_bytes) BETWEEN 1 AND 2097152),CHECK(length(base_version_vector) BETWEEN 1 AND 65536),CHECK(length(route_snapshot_sha256)=64),CHECK(length(update_sha256)=64),CHECK(length(base_version_vector_sha256)=64),CHECK((attribution_kind='agentJob' AND attribution_two IS NOT NULL) OR (attribution_kind!='agentJob' AND attribution_two IS NULL)))
    """

    private static let v6CandidateTableSQL = """
    CREATE TABLE loro_semantic_candidates_v6 (workspace_id TEXT NOT NULL,node_id TEXT NOT NULL,state TEXT NOT NULL CHECK (state IN ('inFlight','retainedRetry','retainedConflict','retainedRequestIdentity')),request_id TEXT NOT NULL,commit_message TEXT NOT NULL,attribution_kind TEXT NOT NULL CHECK (attribution_kind IN ('humanUi','agentJob','system')),attribution_one TEXT NOT NULL,attribution_two TEXT,route_storage_version INTEGER NOT NULL CHECK (route_storage_version > 0 AND route_storage_version < 9223372036854775807),route_schema_version INTEGER NOT NULL CHECK (route_schema_version > 0),route_snapshot_sha256 TEXT NOT NULL,update_bytes BLOB NOT NULL,update_sha256 TEXT NOT NULL,base_version_vector BLOB NOT NULL,base_version_vector_sha256 TEXT NOT NULL,candidate_snapshot BLOB NOT NULL,candidate_snapshot_sha256 TEXT NOT NULL,candidate_result_version_vector BLOB NOT NULL,candidate_result_version_vector_sha256 TEXT NOT NULL,expected_result_storage_version INTEGER NOT NULL CHECK (expected_result_storage_version = route_storage_version + 1),expected_result_schema_version INTEGER NOT NULL CHECK (expected_result_schema_version = route_schema_version),expected_result_snapshot_sha256 TEXT NOT NULL,PRIMARY KEY (workspace_id,node_id),CHECK(length(request_id) BETWEEN 1 AND 200),CHECK(length(commit_message) BETWEEN 1 AND 500),CHECK(length(update_bytes) BETWEEN 1 AND 2097152),CHECK(length(base_version_vector) BETWEEN 1 AND 65536),CHECK(length(candidate_snapshot) BETWEEN 1 AND 8388608),CHECK(length(candidate_result_version_vector) BETWEEN 1 AND 65536),CHECK(length(route_snapshot_sha256)=64),CHECK(length(update_sha256)=64),CHECK(length(base_version_vector_sha256)=64),CHECK(length(candidate_snapshot_sha256)=64),CHECK(length(candidate_result_version_vector_sha256)=64),CHECK(length(expected_result_snapshot_sha256)=64),CHECK((attribution_kind='agentJob' AND attribution_two IS NOT NULL) OR (attribution_kind!='agentJob' AND attribution_two IS NULL)))
    """

    private static let v7CandidateTableSQL = """
    CREATE TABLE loro_semantic_candidates_v7 (workspace_id TEXT NOT NULL,node_id TEXT NOT NULL,state TEXT NOT NULL CHECK (state IN ('inFlight','retainedRetry','retainedConflict','retainedRequestIdentity','acceptedArchived')),request_id TEXT NOT NULL,commit_message TEXT NOT NULL,attribution_kind TEXT NOT NULL CHECK (attribution_kind IN ('humanUi','agentJob','system')),attribution_one TEXT NOT NULL,attribution_two TEXT,route_storage_version INTEGER NOT NULL CHECK (route_storage_version > 0 AND route_storage_version < 9223372036854775807),route_schema_version INTEGER NOT NULL CHECK (route_schema_version > 0),route_snapshot_sha256 TEXT NOT NULL,update_bytes BLOB NOT NULL,update_sha256 TEXT NOT NULL,base_version_vector BLOB NOT NULL,base_version_vector_sha256 TEXT NOT NULL,base_snapshot BLOB NOT NULL,base_snapshot_sha256 TEXT NOT NULL,candidate_snapshot BLOB NOT NULL,candidate_snapshot_sha256 TEXT NOT NULL,candidate_result_version_vector BLOB NOT NULL,candidate_result_version_vector_sha256 TEXT NOT NULL,expected_result_storage_version INTEGER NOT NULL CHECK (expected_result_storage_version = route_storage_version + 1),expected_result_schema_version INTEGER NOT NULL CHECK (expected_result_schema_version = route_schema_version),expected_result_snapshot_sha256 TEXT NOT NULL,PRIMARY KEY (workspace_id,node_id),CHECK(length(request_id) BETWEEN 1 AND 200),CHECK(length(commit_message) BETWEEN 1 AND 500),CHECK(length(update_bytes) BETWEEN 1 AND 2097152),CHECK(length(base_version_vector) BETWEEN 1 AND 65536),CHECK(length(base_snapshot) BETWEEN 1 AND 8388608),CHECK(length(candidate_snapshot) BETWEEN 1 AND 8388608),CHECK(length(candidate_result_version_vector) BETWEEN 1 AND 65536),CHECK(length(route_snapshot_sha256)=64),CHECK(length(update_sha256)=64),CHECK(length(base_version_vector_sha256)=64),CHECK(length(base_snapshot_sha256)=64),CHECK(length(candidate_snapshot_sha256)=64),CHECK(length(candidate_result_version_vector_sha256)=64),CHECK(length(expected_result_snapshot_sha256)=64),CHECK((attribution_kind='agentJob' AND attribution_two IS NOT NULL) OR (attribution_kind!='agentJob' AND attribution_two IS NULL)))
    """

    /// The archive contains the exact pre-terminal working row, including raw evidence bytes.
    /// Its `state` is therefore deliberately constrained to the only state allowed to accept: an
    /// in-flight candidate.  The terminal `acceptedArchived` marker remains in the working slot.
    private static let v7ArchiveTableSQL = """
    CREATE TABLE loro_semantic_checkpoint_archive_v7 (workspace_id TEXT NOT NULL,node_id TEXT NOT NULL,state TEXT NOT NULL CHECK (state IN ('inFlight')),request_id TEXT NOT NULL,commit_message TEXT NOT NULL,attribution_kind TEXT NOT NULL CHECK (attribution_kind IN ('humanUi','agentJob','system')),attribution_one TEXT NOT NULL,attribution_two TEXT,route_storage_version INTEGER NOT NULL CHECK (route_storage_version > 0 AND route_storage_version < 9223372036854775807),route_schema_version INTEGER NOT NULL CHECK (route_schema_version > 0),route_snapshot_sha256 TEXT NOT NULL,update_bytes BLOB NOT NULL,update_sha256 TEXT NOT NULL,base_version_vector BLOB NOT NULL,base_version_vector_sha256 TEXT NOT NULL,base_snapshot BLOB NOT NULL,base_snapshot_sha256 TEXT NOT NULL,candidate_snapshot BLOB NOT NULL,candidate_snapshot_sha256 TEXT NOT NULL,candidate_result_version_vector BLOB NOT NULL,candidate_result_version_vector_sha256 TEXT NOT NULL,expected_result_storage_version INTEGER NOT NULL CHECK (expected_result_storage_version = route_storage_version + 1),expected_result_schema_version INTEGER NOT NULL CHECK (expected_result_schema_version = route_schema_version),expected_result_snapshot_sha256 TEXT NOT NULL,PRIMARY KEY (workspace_id,node_id,request_id),CHECK(length(request_id) BETWEEN 1 AND 200),CHECK(length(commit_message) BETWEEN 1 AND 500),CHECK(length(update_bytes) BETWEEN 1 AND 2097152),CHECK(length(base_version_vector) BETWEEN 1 AND 65536),CHECK(length(base_snapshot) BETWEEN 1 AND 8388608),CHECK(length(candidate_snapshot) BETWEEN 1 AND 8388608),CHECK(length(candidate_result_version_vector) BETWEEN 1 AND 65536),CHECK(length(route_snapshot_sha256)=64),CHECK(length(update_sha256)=64),CHECK(length(base_version_vector_sha256)=64),CHECK(length(base_snapshot_sha256)=64),CHECK(length(candidate_snapshot_sha256)=64),CHECK(length(candidate_result_version_vector_sha256)=64),CHECK(length(expected_result_snapshot_sha256)=64),CHECK((attribution_kind='agentJob' AND attribution_two IS NOT NULL) OR (attribution_kind!='agentJob' AND attribution_two IS NULL)))
    """

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

    /// Returns whether a legacy Automerge page has a local write that has not yet been
    /// acknowledged by the server.  The page row and its dirty bit are one piece of local
    /// authority: callers opening a read-only compatibility projection must inspect this bit
    /// before replacing the on-screen value with a remote snapshot.
    public func isPageDirty(nodeId: EntityId) throws -> Bool {
        try connection.query(
            "SELECT dirty FROM pages WHERE node_id = ?;",
            [.text(nodeId.rawValue)]
        ) { statement in
            guard let value = columnStrictInteger(statement, 0), value == 0 || value == 1 else {
                throw LocalWorkspaceStoreError.invalidDirtyEncoding
            }
            return value == 1
        }.first ?? false
    }

    public func pageDocBytes(nodeId: EntityId) throws -> Data? {
        try connection.query(
            "SELECT doc_bytes FROM pages WHERE node_id = ?;",
            [.text(nodeId.rawValue)]
        ) { statement in columnBlob(statement, 0) }.first
    }

    /// Returns the complete legacy row without coercing its dirty flag. This is the read half of
    /// `persistLegacyProjectionWitness`; callers can distinguish an absent row from recoverable
    /// local bytes before deciding whether a server projection may be shown.
    public func legacyPageState(nodeId: EntityId) throws -> LegacyLocalPageState? {
        try legacyPageRow(nodeId: nodeId)
    }

    /// Atomically records the exact server witness used to produce a legacy read-only projection.
    /// A dirty local row is a recovery boundary: because the shipped native process no longer
    /// carries Automerge, it must leave every legacy column byte-for-byte untouched and return
    /// `.recoveryRequired` rather than burying an unsynced edit under clean server metadata.
    public func persistLegacyProjectionWitness(
        nodeId: EntityId,
        storageVersion: Int,
        docId: String,
        headsHash: String,
        bytesSha256: String
    ) throws -> LegacyProjectionPersistenceDisposition {
        guard try node(id: nodeId) != nil else {
            throw LocalWorkspaceStoreError.nodeNotFound(nodeId)
        }
        guard storageVersion > 0,
              !docId.isEmpty,
              !headsHash.isEmpty,
              Self.isLowercaseSHA256(bytesSha256) else {
            throw LocalWorkspaceStoreError.invalidLoroPageState
        }
        let witness = LegacyPageProjectionWitness(
            nodeId: nodeId,
            storageVersion: storageVersion,
            docId: docId,
            headsHash: headsHash,
            bytesSha256: bytesSha256
        )

        return try connection.transaction {
            let existing = try legacyPageRow(nodeId: nodeId)
            if let existing, existing.dirty {
                // No UPDATE/INSERT is permitted on this branch. In particular, do not clear the
                // dirty bit or replace the local heads/hash while the old bytes await recovery.
                return .recoveryRequired(existing)
            }

            let prior = try connection.query(
                "SELECT storage_version, automerge_doc_id, heads_hash, bytes_sha256 FROM legacy_page_witnesses WHERE node_id = ?;",
                [.text(nodeId.rawValue)]
            ) { statement -> LegacyPageProjectionWitness? in
                guard let storage = columnStrictInteger(statement, 0), storage > 0,
                      let persistedDocId = columnStrictText(statement, 1), !persistedDocId.isEmpty,
                      let persistedHeads = columnStrictText(statement, 2), !persistedHeads.isEmpty,
                      let persistedBytes = columnStrictText(statement, 3), Self.isLowercaseSHA256(persistedBytes) else {
                    throw LocalWorkspaceStoreError.invalidLoroPageState
                }
                return LegacyPageProjectionWitness(
                    nodeId: nodeId,
                    storageVersion: Int(storage),
                    docId: persistedDocId,
                    headsHash: persistedHeads,
                    bytesSha256: persistedBytes
                )
            }.first ?? nil

            // Keep any old bytes recoverable. The witness table is the native read-only binding;
            // the legacy reference row remains a compatibility/recovery record only.
            if existing == nil {
                try connection.run(
                    "INSERT INTO pages (node_id, automerge_doc_id, heads_hash, doc_bytes, dirty) VALUES (?, ?, ?, NULL, 0);",
                    [.text(nodeId.rawValue), .text(docId), .text(headsHash)]
                )
            } else {
                try connection.run(
                    "UPDATE pages SET automerge_doc_id = ?, heads_hash = ?, dirty = 0 WHERE node_id = ? AND dirty = 0;",
                    [.text(docId), .text(headsHash), .text(nodeId.rawValue)]
                )
                guard connection.changes() == 1 else {
                    // The actor owns this connection, but retain a fail-closed guard if the SQL
                    // predicate ever stops matching because the schema changes underneath us.
                    if let current = try legacyPageRow(nodeId: nodeId), current.dirty {
                        return .recoveryRequired(current)
                    }
                    throw LocalWorkspaceStoreError.pageNotFound(nodeId)
                }
            }

            try connection.run(
                """
                INSERT INTO legacy_page_witnesses (node_id, storage_version, automerge_doc_id, heads_hash, bytes_sha256)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(node_id) DO UPDATE SET
                    storage_version = excluded.storage_version,
                    automerge_doc_id = excluded.automerge_doc_id,
                    heads_hash = excluded.heads_hash,
                    bytes_sha256 = excluded.bytes_sha256;
                """,
                [.text(nodeId.rawValue), .int(Int64(storageVersion)), .text(docId), .text(headsHash), .text(bytesSha256)]
            )
            return prior == witness ? .alreadyPersisted(witness) : .persisted(witness)
        }
    }

    private func legacyPageRow(nodeId: EntityId) throws -> LegacyLocalPageState? {
        try connection.query(
            "SELECT node_id, automerge_doc_id, heads_hash, doc_bytes, dirty FROM pages WHERE node_id = ?;",
            [.text(nodeId.rawValue)]
        ) { statement in
            guard let dirty = columnStrictInteger(statement, 4), dirty == 0 || dirty == 1 else {
                throw LocalWorkspaceStoreError.invalidDirtyEncoding
            }
            let bytes: Data?
            if columnIsNull(statement, 3) {
                bytes = nil
            } else if let blob = columnStrictBlob(statement, 3) {
                bytes = blob
            } else {
                // A non-BLOB value in a BLOB column is malformed; do not let SQLite's permissive
                // coercion hide it from the recovery path.
                throw LocalWorkspaceStoreError.decodingFailed("legacy page doc_bytes is not a BLOB")
            }
            return LegacyLocalPageState(
                page: Page(
                    nodeId: try EntityId(validating: columnText(statement, 0)),
                    automergeDocId: columnText(statement, 1),
                    headsHash: columnText(statement, 2)
                ),
                docBytes: bytes,
                dirty: dirty == 1
            )
        }.first
    }

    // MARK: - Loro pages (separate from legacy Automerge `pages`)

    /// Persists a fully prepared Loro candidate in one SQLite statement. Callers must invoke
    /// this before asking `LoroPageDocumentStore` to publish the corresponding in-memory cache.
    /// The server witness values are supplied by the accepted descriptor/response; this store
    /// never derives or advances them from local CRDT state.
    public func upsertLoroPage(_ state: LoroPageLocalState) throws {
        guard try node(id: state.nodeId) != nil else {
            throw LocalWorkspaceStoreError.nodeNotFound(state.nodeId)
        }
        // `LoroPageLocalState` derives this node id from the actor-issued prepared candidate;
        // callers cannot retarget candidate bytes under another page key before this SQL write.
        guard state.pageSchemaVersion > 0,
              !state.snapshotBytes.isEmpty,
              state.observedDescriptorStorageVersion > 0,
              Self.isLowercaseSHA256(state.localSnapshotSHA256),
              Self.isLowercaseSHA256(state.observedDescriptorSnapshotSHA256) else {
            throw LocalWorkspaceStoreError.invalidLoroPageState
        }
        if failLoroPageWrites { throw LocalWorkspaceStoreError.injectedLoroWriteFailure }
        if let remainingLoroWritesBeforeFailure {
            guard remainingLoroWritesBeforeFailure > 0 else { throw LocalWorkspaceStoreError.injectedLoroWriteFailure }
            self.remainingLoroWritesBeforeFailure = remainingLoroWritesBeforeFailure - 1
        }
        try connection.run(
            """
            INSERT INTO loro_pages (
                node_id, page_schema_version, snapshot_bytes, local_snapshot_sha256, dirty,
                observed_descriptor_storage_version, observed_descriptor_snapshot_sha256
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(node_id) DO UPDATE SET
                page_schema_version = excluded.page_schema_version,
                snapshot_bytes = excluded.snapshot_bytes,
                local_snapshot_sha256 = excluded.local_snapshot_sha256,
                dirty = excluded.dirty,
                observed_descriptor_storage_version = excluded.observed_descriptor_storage_version,
                observed_descriptor_snapshot_sha256 = excluded.observed_descriptor_snapshot_sha256;
            """,
            [
                .text(state.nodeId.rawValue), .int(Int64(state.pageSchemaVersion)),
                .blob(state.snapshotBytes), .text(state.localSnapshotSHA256), .int(state.dirty ? 1 : 0),
                .int(Int64(state.observedDescriptorStorageVersion)), .text(state.observedDescriptorSnapshotSHA256)
            ]
        )
    }

    public func loroPage(nodeId: EntityId) throws -> LoroPageLocalState? {
        try connection.query(
            """
            SELECT node_id, page_schema_version, snapshot_bytes, local_snapshot_sha256, dirty,
                   observed_descriptor_storage_version, observed_descriptor_snapshot_sha256
            FROM loro_pages WHERE node_id = ?;
            """,
            [.text(nodeId.rawValue)]
        ) { statement in
            guard let pageSchemaVersion = Self.strictPositiveSwiftInt(statement, 1),
                  let snapshotBytes = columnStrictBlob(statement, 2), !snapshotBytes.isEmpty,
                  let localSnapshotSHA256 = columnStrictText(statement, 3), Self.isLowercaseSHA256(localSnapshotSHA256),
                  let dirtyValue = columnStrictInteger(statement, 4), dirtyValue == 0 || dirtyValue == 1,
                  let observedDescriptorStorageVersion = Self.strictPositiveSwiftInt(statement, 5),
                  let observedDescriptorSnapshotSHA256 = columnStrictText(statement, 6), Self.isLowercaseSHA256(observedDescriptorSnapshotSHA256) else {
                throw LocalWorkspaceStoreError.invalidLoroPageState
            }
            return LoroPageLocalState(
                nodeId: try EntityId(validating: columnText(statement, 0)),
                pageSchemaVersion: pageSchemaVersion,
                snapshotBytes: snapshotBytes,
                localSnapshotSHA256: localSnapshotSHA256,
                dirty: dirtyValue == 1,
                observedDescriptorStorageVersion: observedDescriptorStorageVersion,
                observedDescriptorSnapshotSHA256: observedDescriptorSnapshotSHA256
            )
        }.first
    }

    private static func strictPositiveSwiftInt(_ statement: OpaquePointer, _ index: Int32) -> Int? {
        guard let value = columnStrictInteger(statement, index), value > 0, value <= Int64(Int.max) else {
            return nil
        }
        return Int(value)
    }

    /// Creates the only accepted-page evidence LocalStore can emit.  It checks workspace/node
    /// ownership and the exact durable raw snapshot binding before the document actor performs a
    /// second import and strict semantic validation.
    func acceptedLoroPageEvidence(workspaceId: EntityId, nodeId: EntityId) throws -> LoroAcceptedPageEvidence? {
        guard let node = try node(id: nodeId), node.workspaceId == workspaceId,
              let page = try loroPage(nodeId: nodeId),
              !page.dirty,
              page.pageSchemaVersion > 0,
              page.observedDescriptorStorageVersion > 0,
              page.snapshotBytes.count > 0,
              page.snapshotBytes.count <= LoroPageProjectionLimits().maxSnapshotBytes,
              Self.sha256(page.snapshotBytes) == page.localSnapshotSHA256,
              page.localSnapshotSHA256 == page.observedDescriptorSnapshotSHA256 else {
            return nil
        }
        let route = LoroPageRouteWitness(
            nodeId: nodeId,
            format: .loroV1,
            storageVersion: page.observedDescriptorStorageVersion,
            schemaVersion: page.pageSchemaVersion,
            snapshotSHA256: page.observedDescriptorSnapshotSHA256
        )
        return .accepted(
            workspaceId: workspaceId,
            nodeId: nodeId,
            route: route,
            pageSchemaVersion: page.pageSchemaVersion,
            snapshotBytes: page.snapshotBytes,
            localSnapshotSHA256: page.localSnapshotSHA256
        )
    }

    // MARK: - Semantic Loro checkpoints

    /// Immutable raw v7 material shared by the working slot and the append-only archive. This is
    /// intentionally not dispatchable on its own: only a non-terminal `V7WorkingRecord` can be
    /// converted into sealed `LoroFrozenCandidateEvidence` for document-actor revalidation.
    private struct V7ImmutableCandidate: Equatable {
        let workspaceId: EntityId
        let nodeId: EntityId
        let intent: LoroMutationIntentV1
        let route: LoroPageRouteWitness
        let update: Data
        let updateSHA256: String
        let baseVersionVector: Data
        let baseVersionVectorSHA256: String
        let baseSnapshot: Data
        let baseSnapshotSHA256: String
        let candidateSnapshot: Data
        let candidateSnapshotSHA256: String
        let candidateResultVersionVector: Data
        let candidateResultVersionVectorSHA256: String
        let expectedResultRoute: LoroPageRouteWitness

        func checkpoint(state: LoroSemanticCheckpointState) throws -> LoroSemanticCheckpoint {
            try LoroSemanticCheckpoint(
                workspaceId: workspaceId,
                nodeId: nodeId,
                state: state,
                intent: intent,
                route: route,
                update: update,
                baseVersionVector: baseVersionVector
            )
        }

        func bindings(state: LoroSemanticCheckpointState) throws -> [SQLiteValue] {
            let attribution = try checkpoint(state: state).databaseAttribution()
            return [
                .text(workspaceId.rawValue), .text(nodeId.rawValue), .text(state.rawValue),
                .text(intent.requestId), .text(intent.commitMessage), .text(attribution.0),
                .text(attribution.1), attribution.2.map(SQLiteValue.text) ?? .null,
                .int(Int64(route.storageVersion)), .int(Int64(route.schemaVersion)), .text(route.snapshotSHA256),
                .blob(update), .text(updateSHA256), .blob(baseVersionVector), .text(baseVersionVectorSHA256),
                .blob(baseSnapshot), .text(baseSnapshotSHA256), .blob(candidateSnapshot),
                .text(candidateSnapshotSHA256), .blob(candidateResultVersionVector),
                .text(candidateResultVersionVectorSHA256), .int(Int64(expectedResultRoute.storageVersion)),
                .int(Int64(expectedResultRoute.schemaVersion)), .text(expectedResultRoute.snapshotSHA256)
            ]
        }

        func matches(_ frozen: LoroFrozenLiteralCandidate) -> Bool {
            workspaceId == frozen.workspaceId &&
            nodeId == frozen.checkpoint.nodeId &&
            intent == frozen.checkpoint.intent &&
            route == frozen.checkpoint.route &&
            update == frozen.checkpoint.update &&
            updateSHA256 == frozen.checkpoint.updateSHA256 &&
            baseVersionVector == frozen.checkpoint.baseVersionVector &&
            baseVersionVectorSHA256 == frozen.checkpoint.baseVersionVectorSHA256 &&
            baseSnapshot == frozen.baseSnapshot &&
            baseSnapshotSHA256 == frozen.baseSnapshotSHA256 &&
            candidateSnapshot == frozen.literal.snapshotBytes &&
            candidateSnapshotSHA256 == frozen.literal.localSnapshotSHA256 &&
            candidateResultVersionVector == frozen.literal.versionBytes &&
            candidateResultVersionVectorSHA256 == frozen.literal.versionVectorSHA256 &&
            expectedResultRoute == frozen.literal.route
        }
    }

    /// The only dispatchable representation of a v7 row. `acceptedArchived` deliberately has a
    /// working-slot representation but cannot emit `LoroFrozenCandidateEvidence`.
    private struct V7WorkingRecord: Equatable {
        let state: LoroSemanticCheckpointState
        let immutable: V7ImmutableCandidate

        func checkpoint() throws -> LoroSemanticCheckpoint { try immutable.checkpoint(state: state) }

        func dispatchEvidence() throws -> LoroFrozenCandidateEvidence? {
            guard state != .acceptedArchived else { return nil }
            let checkpoint = try checkpoint()
            return .durable(
                workspaceId: immutable.workspaceId,
                nodeId: immutable.nodeId,
                checkpoint: checkpoint,
                baseSnapshot: immutable.baseSnapshot,
                baseSnapshotSHA256: immutable.baseSnapshotSHA256,
                candidateSnapshot: immutable.candidateSnapshot,
                candidateSnapshotSHA256: immutable.candidateSnapshotSHA256,
                candidateResultVersionVector: immutable.candidateResultVersionVector,
                candidateResultVersionVectorSHA256: immutable.candidateResultVersionVectorSHA256,
                expectedResultRoute: immutable.expectedResultRoute
            )
        }

        /// Exact state-and-identity predicate used by all v7 CAS transitions.  The working slot
        /// is never identified by workspace/node alone: a stale caller cannot transition a
        /// replacement candidate that has occupied a verified terminal slot.
        func stateCASBindings(expectedState: LoroSemanticCheckpointState) -> [SQLiteValue] {
            [
                .text(immutable.workspaceId.rawValue), .text(immutable.nodeId.rawValue),
                .text(immutable.intent.requestId), .text(expectedState.rawValue),
                .text(immutable.updateSHA256), .text(immutable.baseVersionVectorSHA256),
                .text(immutable.baseSnapshotSHA256),
                .text(immutable.candidateSnapshotSHA256), .text(immutable.candidateResultVersionVectorSHA256),
                .int(Int64(immutable.expectedResultRoute.storageVersion)),
                .int(Int64(immutable.expectedResultRoute.schemaVersion)), .text(immutable.expectedResultRoute.snapshotSHA256)
            ]
        }
    }

    /// Archive-only type. It intentionally has no conversion to a dispatchable candidate or a
    /// literal token; it exists solely to prove an `acceptedArchived` working slot has retained
    /// all of its prior immutable evidence before the slot is reused.
    private struct V7ArchivedRecord: Equatable {
        let immutable: V7ImmutableCandidate

        init(_ working: V7WorkingRecord) {
            self.immutable = working.immutable
        }

        func matchesTerminal(_ working: V7WorkingRecord) -> Bool {
            working.state == .acceptedArchived && immutable == working.immutable
        }
    }

    private static let v7Columns = "workspace_id,node_id,state,request_id,commit_message,attribution_kind,attribution_one,attribution_two,route_storage_version,route_schema_version,route_snapshot_sha256,update_bytes,update_sha256,base_version_vector,base_version_vector_sha256,base_snapshot,base_snapshot_sha256,candidate_snapshot,candidate_snapshot_sha256,candidate_result_version_vector,candidate_result_version_vector_sha256,expected_result_storage_version,expected_result_schema_version,expected_result_snapshot_sha256"

    /// Persists an actor-minted v7 frozen candidate.  It is additive and intentionally leaves
    /// v5/v6 forensic tables untouched.
    func persistFrozenLiteralCandidate(actorIssued frozen: LoroFrozenLiteralCandidate) throws {
        let incoming = try workingRecord(from: frozen)
        guard incoming.state == .inFlight,
              let node = try node(id: incoming.immutable.nodeId),
              node.workspaceId == incoming.immutable.workspaceId else {
            throw LocalWorkspaceStoreError.invalidLoroCandidate
        }
        try connection.transaction {
            guard !(try legacyV6Exists(workspaceId: incoming.immutable.workspaceId, nodeId: incoming.immutable.nodeId)),
                  !(try legacyV5Exists(workspaceId: incoming.immutable.workspaceId, nodeId: incoming.immutable.nodeId)) else {
                throw LocalWorkspaceStoreError.checkpointAlreadyExists
            }
            guard let existing = try v7WorkingRecord(workspaceId: incoming.immutable.workspaceId, nodeId: incoming.immutable.nodeId) else {
                guard !(try archiveRequestExists(
                    workspaceId: incoming.immutable.workspaceId,
                    nodeId: incoming.immutable.nodeId,
                    requestId: incoming.immutable.intent.requestId
                )) else { throw LocalWorkspaceStoreError.checkpointAlreadyExists }
                try insertV7Working(incoming)
                return
            }

            // The only reusable slot is a verified terminal marker. Its prior row has to be
            // present byte-for-byte in the append-only archive before a new actor-issued intent
            // can occupy the slot.
            guard existing.state == .acceptedArchived,
                  let archived = try v7ArchivedRecord(
                    workspaceId: incoming.immutable.workspaceId,
                    nodeId: incoming.immutable.nodeId,
                    requestId: existing.immutable.intent.requestId
                  ),
                  archived.matchesTerminal(existing),
                  !(try archiveRequestExists(
                    workspaceId: incoming.immutable.workspaceId,
                    nodeId: incoming.immutable.nodeId,
                    requestId: incoming.immutable.intent.requestId
                  )) else {
                throw LocalWorkspaceStoreError.checkpointAlreadyExists
            }
            try replaceAcceptedArchivedWorking(existing: existing, with: incoming)
        }
    }

    /// Returns opaque v7 evidence after strict SQLite type, bound, and hash checks.  The document
    /// actor must still re-import and prove the Loro graph before reminting authority.
    func frozenCandidateEvidence(workspaceId: EntityId, nodeId: EntityId) throws -> LoroFrozenCandidateEvidence? {
        guard let record = try v7WorkingRecord(workspaceId: workspaceId, nodeId: nodeId) else { return nil }
        guard (try node(id: nodeId))?.workspaceId == workspaceId else {
            throw LocalWorkspaceStoreError.invalidLoroCandidate
        }
        return try record.dispatchEvidence()
    }

    /// Atomically validates the retained v7 row and marks that exact immutable row in flight.
    /// The returned evidence has the new state but remains opaque raw material; the document
    /// actor remints and semantically validates it only after this durable CAS succeeds.
    func beginRetryLoroCheckpoint(workspaceId: EntityId, nodeId: EntityId) throws -> LoroFrozenCandidateEvidence {
        try connection.transaction {
            guard let owner = try node(id: nodeId) else {
                throw LocalWorkspaceStoreError.invalidLoroCheckpoint
            }
            guard owner.workspaceId == workspaceId else {
                throw LocalWorkspaceStoreError.invalidLoroCandidate
            }
            guard let record = try v7WorkingRecord(workspaceId: workspaceId, nodeId: nodeId),
                  record.state == .retainedRetry,
                  let retained = try record.dispatchEvidence() else {
                throw LocalWorkspaceStoreError.invalidLoroCheckpoint
            }
            try connection.run("""
                UPDATE loro_semantic_candidates_v7 SET state=?
                WHERE workspace_id=? AND node_id=? AND request_id=? AND state=? AND update_sha256=?
                  AND base_version_vector_sha256=? AND base_snapshot_sha256=?
                  AND candidate_snapshot_sha256=? AND candidate_result_version_vector_sha256=?
                  AND expected_result_storage_version=? AND expected_result_schema_version=?
                  AND expected_result_snapshot_sha256=?;
                """, [.text(LoroSemanticCheckpointState.inFlight.rawValue)] + record.stateCASBindings(expectedState: .retainedRetry))
            guard connection.changes() == 1 else { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
            return .durable(
                workspaceId: retained.workspaceId,
                nodeId: retained.nodeId,
                checkpoint: retained.checkpoint.changing(state: .inFlight),
                baseSnapshot: retained.baseSnapshot,
                baseSnapshotSHA256: retained.baseSnapshotSHA256,
                candidateSnapshot: retained.candidateSnapshot,
                candidateSnapshotSHA256: retained.candidateSnapshotSHA256,
                candidateResultVersionVector: retained.candidateResultVersionVector,
                candidateResultVersionVectorSHA256: retained.candidateResultVersionVectorSHA256,
                expectedResultRoute: retained.expectedResultRoute
            )
        }
    }

    private func v7WorkingRecord(workspaceId: EntityId, nodeId: EntityId) throws -> V7WorkingRecord? {
        let rows = try connection.query(
            "SELECT \(Self.v7Columns) FROM loro_semantic_candidates_v7 WHERE workspace_id=? AND node_id=?;",
            [.text(workspaceId.rawValue), .text(nodeId.rawValue)]
        ) { statement in
            try Self.decodeV7WorkingRecord(statement, expectedWorkspace: workspaceId, expectedNode: nodeId)
        }
        guard rows.count <= 1 else { throw LocalWorkspaceStoreError.invalidLoroCandidate }
        return rows.first
    }

    private func v7ArchivedRecord(workspaceId: EntityId, nodeId: EntityId, requestId: String) throws -> V7ArchivedRecord? {
        let rows = try connection.query(
            "SELECT \(Self.v7Columns) FROM loro_semantic_checkpoint_archive_v7 WHERE workspace_id=? AND node_id=? AND request_id=?;",
            [.text(workspaceId.rawValue), .text(nodeId.rawValue), .text(requestId)]
        ) { statement in
            let working = try Self.decodeV7WorkingRecord(statement, expectedWorkspace: workspaceId, expectedNode: nodeId)
            guard working.state == .inFlight, working.immutable.intent.requestId == requestId else {
                throw LocalWorkspaceStoreError.invalidLoroArchive
            }
            return V7ArchivedRecord(working)
        }
        guard rows.count <= 1 else { throw LocalWorkspaceStoreError.invalidLoroArchive }
        return rows.first
    }

    private static func decodeV7WorkingRecord(
        _ statement: OpaquePointer,
        expectedWorkspace: EntityId,
        expectedNode: EntityId
    ) throws -> V7WorkingRecord {
        guard let workspaceText = columnStrictText(statement, 0),
              let nodeText = columnStrictText(statement, 1),
              let workspace = try? EntityId(validating: workspaceText),
              let node = try? EntityId(validating: nodeText),
              workspace == expectedWorkspace, node == expectedNode,
              let stateText = columnStrictText(statement, 2),
              let state = LoroSemanticCheckpointState(rawValue: stateText),
              let requestId = columnStrictText(statement, 3),
              let commitMessage = columnStrictText(statement, 4),
              let attributionKind = columnStrictText(statement, 5),
              let attributionOne = columnStrictText(statement, 6),
              let routeStorage = strictPositiveSwiftInt(statement, 8),
              let routeSchema = strictPositiveSwiftInt(statement, 9),
              let routeHash = columnStrictText(statement, 10),
              let update = columnStrictBlob(statement, 11),
              let updateHash = columnStrictText(statement, 12),
              let baseVersion = columnStrictBlob(statement, 13),
              let baseVersionHash = columnStrictText(statement, 14),
              let baseSnapshot = columnStrictBlob(statement, 15),
              let baseSnapshotHash = columnStrictText(statement, 16),
              let candidateSnapshot = columnStrictBlob(statement, 17),
              let candidateSnapshotHash = columnStrictText(statement, 18),
              let candidateVersion = columnStrictBlob(statement, 19),
              let candidateVersionHash = columnStrictText(statement, 20),
              let expectedStorage = strictPositiveSwiftInt(statement, 21),
              let expectedSchema = strictPositiveSwiftInt(statement, 22),
              let expectedHash = columnStrictText(statement, 23),
              !update.isEmpty, update.count <= 2 * 1024 * 1024,
              !baseVersion.isEmpty, baseVersion.count <= LoroPageProjectionLimits().maxVersionVectorBytes,
              !baseSnapshot.isEmpty, baseSnapshot.count <= LoroPageProjectionLimits().maxSnapshotBytes,
              !candidateSnapshot.isEmpty, candidateSnapshot.count <= LoroPageProjectionLimits().maxSnapshotBytes,
              !candidateVersion.isEmpty, candidateVersion.count <= LoroPageProjectionLimits().maxVersionVectorBytes,
              isLowercaseSHA256(routeHash), isLowercaseSHA256(updateHash),
              isLowercaseSHA256(baseVersionHash), isLowercaseSHA256(baseSnapshotHash),
              isLowercaseSHA256(candidateSnapshotHash), isLowercaseSHA256(candidateVersionHash),
              isLowercaseSHA256(expectedHash) else {
            throw LocalWorkspaceStoreError.invalidLoroCandidate
        }
        let checkpoint = try LoroSemanticCheckpoint.reconstruct(
            workspaceId: workspace, nodeId: node, state: stateText, requestId: requestId,
            commitMessage: commitMessage, attributionKind: attributionKind, attributionOne: attributionOne,
            attributionTwo: columnOptionalText(statement, 7), storageVersion: routeStorage,
            schemaVersion: routeSchema, snapshotSHA256: routeHash, update: update,
            updateSHA256: updateHash, baseVersionVector: baseVersion,
            baseVersionVectorSHA256: baseVersionHash
        )
        let expected = LoroPageRouteWitness(
            nodeId: node, format: .loroV1, storageVersion: expectedStorage,
            schemaVersion: expectedSchema, snapshotSHA256: expectedHash
        )
        guard baseSnapshotHash == LoroMutationWire.sha256Hex(baseSnapshot),
              candidateSnapshotHash == LoroMutationWire.sha256Hex(candidateSnapshot),
              candidateVersionHash == (try VersionVectorIdentity.digest(encodedVersionVector: candidateVersion)),
              expected.storageVersion == checkpoint.route.storageVersion + 1,
              expected.schemaVersion == checkpoint.route.schemaVersion,
              expected.snapshotSHA256 == candidateSnapshotHash else {
            throw LocalWorkspaceStoreError.invalidLoroCandidate
        }
        return .init(
            state: state,
            immutable: .init(
                workspaceId: workspace, nodeId: node, intent: checkpoint.intent,
                route: checkpoint.route, update: update, updateSHA256: updateHash,
                baseVersionVector: baseVersion, baseVersionVectorSHA256: baseVersionHash,
                baseSnapshot: baseSnapshot, baseSnapshotSHA256: baseSnapshotHash,
                candidateSnapshot: candidateSnapshot, candidateSnapshotSHA256: candidateSnapshotHash,
                candidateResultVersionVector: candidateVersion,
                candidateResultVersionVectorSHA256: candidateVersionHash,
                expectedResultRoute: expected
            )
        )
    }

    private func workingRecord(from frozen: LoroFrozenLiteralCandidate) throws -> V7WorkingRecord {
        let checkpoint = frozen.checkpoint
        guard checkpoint.state == .inFlight,
              frozen.workspaceId == checkpoint.workspaceId,
              frozen.literal.workspaceId == checkpoint.workspaceId,
              frozen.literal.nodeId == checkpoint.nodeId,
              frozen.baseSnapshotSHA256 == LoroMutationWire.sha256Hex(frozen.baseSnapshot),
              frozen.baseSnapshotSHA256 == checkpoint.route.snapshotSHA256,
              frozen.literal.localSnapshotSHA256 == LoroMutationWire.sha256Hex(frozen.literal.snapshotBytes),
              frozen.literal.localSnapshotSHA256 == frozen.literal.route.snapshotSHA256,
              frozen.literal.route.storageVersion == checkpoint.route.storageVersion + 1,
              frozen.literal.route.schemaVersion == checkpoint.route.schemaVersion,
              frozen.literal.versionVectorSHA256 == (try VersionVectorIdentity.digest(encodedVersionVector: frozen.literal.versionBytes)) else {
            throw LocalWorkspaceStoreError.invalidLoroCandidate
        }
        return .init(
            state: .inFlight,
            immutable: .init(
                workspaceId: checkpoint.workspaceId,
                nodeId: checkpoint.nodeId,
                intent: checkpoint.intent,
                route: checkpoint.route,
                update: checkpoint.update,
                updateSHA256: checkpoint.updateSHA256,
                baseVersionVector: checkpoint.baseVersionVector,
                baseVersionVectorSHA256: checkpoint.baseVersionVectorSHA256,
                baseSnapshot: frozen.baseSnapshot,
                baseSnapshotSHA256: frozen.baseSnapshotSHA256,
                candidateSnapshot: frozen.literal.snapshotBytes,
                candidateSnapshotSHA256: frozen.literal.localSnapshotSHA256,
                candidateResultVersionVector: frozen.literal.versionBytes,
                candidateResultVersionVectorSHA256: frozen.literal.versionVectorSHA256,
                expectedResultRoute: frozen.literal.route
            )
        )
    }

    private func archiveRequestExists(workspaceId: EntityId, nodeId: EntityId, requestId: String) throws -> Bool {
        !(try connection.query(
            "SELECT 1 FROM loro_semantic_checkpoint_archive_v7 WHERE workspace_id=? AND node_id=? AND request_id=?;",
            [.text(workspaceId.rawValue), .text(nodeId.rawValue), .text(requestId)]
        ) { _ in true }).isEmpty
    }

    private func insertV7Working(_ record: V7WorkingRecord) throws {
        try connection.run(
            "INSERT INTO loro_semantic_candidates_v7 (\(Self.v7Columns)) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
            try record.immutable.bindings(state: record.state)
        )
    }

    /// A terminal-slot replacement is a compare-and-swap, never a delete/reinsert. The archive
    /// has already proved the outgoing row's full immutable identity in the caller's transaction.
    private func replaceAcceptedArchivedWorking(existing: V7WorkingRecord, with incoming: V7WorkingRecord) throws {
        guard existing.state == .acceptedArchived, incoming.state == .inFlight else {
            throw LocalWorkspaceStoreError.invalidLoroCandidate
        }
        let values = try incoming.immutable.bindings(state: .inFlight)
        try connection.run("""
            UPDATE loro_semantic_candidates_v7 SET
                state=?,request_id=?,commit_message=?,attribution_kind=?,attribution_one=?,attribution_two=?,
                route_storage_version=?,route_schema_version=?,route_snapshot_sha256=?,update_bytes=?,update_sha256=?,
                base_version_vector=?,base_version_vector_sha256=?,base_snapshot=?,base_snapshot_sha256=?,
                candidate_snapshot=?,candidate_snapshot_sha256=?,candidate_result_version_vector=?,candidate_result_version_vector_sha256=?,
                expected_result_storage_version=?,expected_result_schema_version=?,expected_result_snapshot_sha256=?
            WHERE workspace_id=? AND node_id=? AND state=? AND request_id=? AND update_sha256=?
              AND base_version_vector_sha256=? AND candidate_snapshot_sha256=?
              AND candidate_result_version_vector_sha256=? AND expected_result_storage_version=?
              AND expected_result_schema_version=? AND expected_result_snapshot_sha256=?;
            """, Array(values.dropFirst(2)) + [
                .text(existing.immutable.workspaceId.rawValue), .text(existing.immutable.nodeId.rawValue),
                .text(LoroSemanticCheckpointState.acceptedArchived.rawValue), .text(existing.immutable.intent.requestId),
                .text(existing.immutable.updateSHA256), .text(existing.immutable.baseVersionVectorSHA256),
                .text(existing.immutable.candidateSnapshotSHA256), .text(existing.immutable.candidateResultVersionVectorSHA256),
                .int(Int64(existing.immutable.expectedResultRoute.storageVersion)),
                .int(Int64(existing.immutable.expectedResultRoute.schemaVersion)), .text(existing.immutable.expectedResultRoute.snapshotSHA256)
            ])
        guard connection.changes() == 1 else { throw LocalWorkspaceStoreError.invalidLoroCandidate }
    }

    /// Exact accepted transition: archive the validated active row, write `loro_pages` only from
    /// the literal token, then mark that same row terminal. Any failpoint/error rolls all three
    /// writes back together; cache publication is deliberately outside this transaction.
    func acceptFrozenLiteralCandidate(actorIssued frozen: LoroFrozenLiteralCandidate, dispatched checkpoint: LoroSemanticCheckpoint) throws {
        guard checkpoint.state == .inFlight,
              checkpoint.workspaceId == frozen.workspaceId,
              checkpoint.nodeId == frozen.checkpoint.nodeId,
              checkpoint.intent == frozen.checkpoint.intent,
              checkpoint.route == frozen.checkpoint.route,
              checkpoint.updateSHA256 == frozen.checkpoint.updateSHA256,
              checkpoint.baseVersionVectorSHA256 == frozen.checkpoint.baseVersionVectorSHA256 else {
            throw LocalWorkspaceStoreError.invalidLoroCandidate
        }
        try connection.transaction {
            guard let working = try v7WorkingRecord(workspaceId: checkpoint.workspaceId, nodeId: checkpoint.nodeId),
                  working.state == .inFlight,
                  working.immutable.matches(frozen),
                  working.immutable.intent == checkpoint.intent,
                  working.immutable.route == checkpoint.route,
                  working.immutable.updateSHA256 == checkpoint.updateSHA256,
                  working.immutable.baseVersionVectorSHA256 == checkpoint.baseVersionVectorSHA256,
                  !(try archiveRequestExists(
                    workspaceId: checkpoint.workspaceId,
                    nodeId: checkpoint.nodeId,
                    requestId: checkpoint.intent.requestId
                  )) else {
                throw LocalWorkspaceStoreError.invalidLoroCandidate
            }
            try connection.run(
                "INSERT INTO loro_semantic_checkpoint_archive_v7 (\(Self.v7Columns)) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
                try working.immutable.bindings(state: .inFlight)
            )
            if failAfterV7ArchiveWrite {
                failAfterV7ArchiveWrite = false
                throw LocalWorkspaceStoreError.injectedLoroWriteFailure
            }
            try upsertAcceptedLiteralPage(frozen.literal)
            if failAfterV7AcceptedPageWrite {
                failAfterV7AcceptedPageWrite = false
                throw LocalWorkspaceStoreError.injectedLoroWriteFailure
            }
            if failBeforeV7TerminalUpdate {
                failBeforeV7TerminalUpdate = false
                throw LocalWorkspaceStoreError.injectedLoroWriteFailure
            }
            try connection.run("""
                UPDATE loro_semantic_candidates_v7 SET state=?
                WHERE workspace_id=? AND node_id=? AND request_id=? AND state=? AND update_sha256=?
                  AND base_version_vector_sha256=? AND base_snapshot_sha256=? AND candidate_snapshot_sha256=?
                  AND candidate_result_version_vector_sha256=? AND expected_result_storage_version=?
                  AND expected_result_schema_version=? AND expected_result_snapshot_sha256=?;
                """, [.text(LoroSemanticCheckpointState.acceptedArchived.rawValue)] + working.stateCASBindings(expectedState: .inFlight))
            guard connection.changes() == 1 else { throw LocalWorkspaceStoreError.invalidLoroCandidate }
        }
    }

    private func upsertAcceptedLiteralPage(_ literal: LoroLiteralPreparedPageState) throws {
        guard literal.route.nodeId == literal.nodeId,
              literal.route.format == .loroV1,
              literal.route.schemaVersion == literal.validation.schemaVersion,
              literal.route.snapshotSHA256 == literal.localSnapshotSHA256,
              literal.localSnapshotSHA256 == LoroMutationWire.sha256Hex(literal.snapshotBytes),
              literal.versionVectorSHA256 == (try VersionVectorIdentity.digest(encodedVersionVector: literal.versionBytes)) else {
            throw LocalWorkspaceStoreError.invalidLoroCandidate
        }
        try upsertLoroPage(.init(
            nodeId: literal.nodeId,
            pageSchemaVersion: literal.validation.schemaVersion,
            snapshotBytes: literal.snapshotBytes,
            localSnapshotSHA256: literal.localSnapshotSHA256,
            dirty: false,
            observedDescriptorStorageVersion: literal.route.storageVersion,
            observedDescriptorSnapshotSHA256: literal.route.snapshotSHA256
        ))
    }

    private func legacyV6Exists(workspaceId: EntityId, nodeId: EntityId) throws -> Bool {
        !(try connection.query("SELECT 1 FROM loro_semantic_candidates_v6 WHERE workspace_id=? AND node_id=?;", [.text(workspaceId.rawValue), .text(nodeId.rawValue)]) { _ in 1 }).isEmpty
    }

    private func legacyV5Exists(workspaceId: EntityId, nodeId: EntityId) throws -> Bool {
        !(try connection.query("SELECT 1 FROM loro_semantic_checkpoints_v5 WHERE workspace_id=? AND node_id=?;", [.text(workspaceId.rawValue), .text(nodeId.rawValue)]) { _ in 1 }).isEmpty
    }

    /// Canonical v7 query.  v5/v6 evidence is intentionally absent from dispatchable results.
    func activeLoroCheckpoint(workspaceId: EntityId, nodeId: EntityId) throws -> LoroSemanticCheckpoint? {
        try frozenCandidateEvidence(workspaceId: workspaceId, nodeId: nodeId)?.checkpoint
    }

    public func loroCheckpointDisposition(workspaceId: EntityId, nodeId: EntityId) throws -> LoroSemanticCheckpointDisposition {
        if let active = try activeLoroCheckpoint(workspaceId: workspaceId, nodeId: nodeId) { return .active(active) }
        if try legacyV6Exists(workspaceId: workspaceId, nodeId: nodeId) {
            return .migratedV6Quarantined(.init(workspaceId: workspaceId, nodeId: nodeId))
        }
        let exists = try connection.query("SELECT workspace_id,node_id FROM loro_semantic_checkpoints_v5 WHERE workspace_id=? AND node_id=?;", [.text(workspaceId.rawValue), .text(nodeId.rawValue)]) { statement in
            try LoroLegacySemanticCheckpointEvidence(workspaceId: EntityId(validating: columnText(statement, 0)), nodeId: EntityId(validating: columnText(statement, 1)))
        }.first
        return exists.map(LoroSemanticCheckpointDisposition.migratedV5Quarantined) ?? .none
    }

    /// Compatibility query for callers that only need active v7 state.
    public func loroCheckpoint(workspaceId: EntityId, nodeId: EntityId) throws -> LoroSemanticCheckpoint? {
        try activeLoroCheckpoint(workspaceId: workspaceId, nodeId: nodeId)
    }

    /// Durable retry transition. The SQL predicate prevents a caller from mutating the frozen A.
    public func transitionLoroCheckpoint(workspaceId: EntityId, nodeId: EntityId, from: LoroSemanticCheckpointState, to: LoroSemanticCheckpointState) throws -> LoroSemanticCheckpoint {
        let permitted: Bool
        switch (from, to) {
        case (.inFlight, .retainedRetry), (.inFlight, .retainedConflict), (.inFlight, .retainedRequestIdentity), (.retainedRetry, .inFlight): permitted = true
        default: permitted = false
        }
        guard permitted else { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
        return try connection.transaction {
            guard let record = try v7WorkingRecord(workspaceId: workspaceId, nodeId: nodeId),
                  record.state == from else {
                throw LocalWorkspaceStoreError.invalidLoroCheckpoint
            }
            let checkpoint = try record.checkpoint()
            try connection.run("""
                UPDATE loro_semantic_candidates_v7 SET state=?
                WHERE workspace_id=? AND node_id=? AND request_id=? AND state=? AND update_sha256=?
                  AND base_version_vector_sha256=? AND base_snapshot_sha256=?
                  AND candidate_snapshot_sha256=? AND candidate_result_version_vector_sha256=?
                  AND expected_result_storage_version=? AND expected_result_schema_version=?
                  AND expected_result_snapshot_sha256=?;
                """, [.text(to.rawValue)] + record.stateCASBindings(expectedState: from))
            guard connection.changes() == 1 else { throw LocalWorkspaceStoreError.invalidLoroCheckpoint }
            return checkpoint.changing(state: to)
        }
    }

    /// Retained for source compatibility only. v7 never clears checkpoint evidence: accepted
    /// rows transition to `acceptedArchived` and their full pre-terminal bytes are append-only.
    /// v5/v6 are forensic/quarantined and are likewise never modified by this path.
    public func replaceLoroPageAndClearCheckpoint(candidate: LoroPageLocalState, workspaceId: EntityId) throws {
        _ = candidate
        _ = workspaceId
        throw LocalWorkspaceStoreError.invalidLoroCandidate
    }

    private static func isLowercaseSHA256(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    private static func sha256(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
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
