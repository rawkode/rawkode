// @enchiridion/worker-vault — DO SQLite schema
//
// Every table VaultDO's storage layer owns, in one place, so `doc-store.ts`,
// `catalog.ts`, `projection.ts`, `query-rpc.ts`, and `rebuild-projections.ts`
// all agree on names/columns instead of re-declaring DDL locally.
//
// Three families of tables:
//
// 1. Doc storage (`doc_snapshots`, `doc_pending_updates`) — plan
//    §Backend architecture, "VaultDO ... holds Loro doc storage in DO
//    SQLite (latest shallow snapshot + pending updates per doc)".
// 2. Catalog mirror (`vault_catalog`) — the plan's `vault-meta` doc IS a
//    real Loro CRDT map (see `catalog.ts`); this table is a queryable
//    SQL-side reprojection of that map (same pattern as every other page's
//    projection: CRDT doc is the source of authority, this table is
//    derived/cache), not a "temporary simplification" substitute — Loro's
//    JS map API is fully verified working in this sandbox (see
//    `loro-storage.ts`'s file header).
// 3. Projection tables — the public-view contract of
//    `apps/enchiridion/Documentation/GraphDataModel.md`. Per plan §Phasing
//    P0 and the implementing task's scope, only `graph_nodes` gets real
//    population logic here (`projection.ts`); the rest get their DDL so the
//    bounded-query allowlist and future population code (P1's
//    `packages/projection`, "effective-schema resolution") have a stable
//    target, but are otherwise empty pass-through tables for now.
//
// DO SQLite storage: `SqlStorage.exec()` is synchronous (no async I/O —
// the whole DO SQLite database is memory-mapped into the isolate), so every
// function in this module is synchronous too.

/** Every table/view name the bounded query RPC (`query-rpc.ts`) allows a
 *  caller to read from — the TS mirror of `GraphSQLExecutor.allowedSources`
 *  (apps/enchiridion/Sources/EnchiridionCore/GraphSQLExecutor.swift:45-60),
 *  restricted to the P0 subset actually populated (no `graph_workouts_v1`
 *  etc. — those are P1 module-projection territory). */
export const PROJECTION_VIEW_NAMES = [
  "graph_nodes",
  "graph_tags",
  "graph_tag_parents",
  "graph_tag_closure",
  "graph_node_tags",
  "graph_facts",
  "graph_relation_definitions",
  "graph_edges",
  "graph_issues",
  "graph_text_search",
] as const;

/** FTS5 auto-generates these shadow tables for `graph_text_search`. They
 *  must never be directly queryable — mirrors
 *  `GraphSQLExecutor.ftsShadowSources` (GraphSQLExecutor.swift:62-68). */
export const FTS_SHADOW_TABLE_NAMES = [
  "graph_text_search_config",
  "graph_text_search_content",
  "graph_text_search_data",
  "graph_text_search_docsize",
  "graph_text_search_idx",
] as const;

/** Private storage tables backing a public view — must never be directly
 *  queryable by the bounded query surface, same reasoning as the FTS5
 *  shadow tables above (`sql-validator.ts`'s default `forbiddenIdentifiers`
 *  includes both sets). `_graph_edges` is the forward-only storage table
 *  behind the public `graph_edges` VIEW (see this file's DDL comment on
 *  that table) — querying it directly would leak the "forward-only, no
 *  inverse row" storage detail the view exists to hide. */
export const PRIVATE_STORAGE_TABLE_NAMES = ["_graph_edges"] as const;

/** Minimal ambient shape of Cloudflare's `SqlStorage` this module needs —
 *  declared locally (rather than importing `@cloudflare/workers-types`'
 *  `SqlStorage` directly) so `schema.ts`/`doc-store.ts`/etc. can be unit
 *  tested against the bun:sqlite-backed adapter in
 *  `test-helpers/sqlite-storage-adapter.ts`, which implements this same
 *  shape. Kept structurally identical to the real `SqlStorage` interface
 *  (same method signature) so no adapting is needed at the call site in
 *  `vault-do.ts`. */
export interface SqlExecutor {
  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T>;
}

export interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
  raw<U extends unknown[]>(): IterableIterator<U>;
  columnNames: string[];
  [Symbol.iterator](): IterableIterator<T>;
}

const DDL_STATEMENTS: readonly string[] = [
  // --- Doc storage -----------------------------------------------------
  //
  // Doc-per-page: `doc_snapshots` holds the latest exported Loro snapshot
  // for a page; `doc_pending_updates` is the append-only log of update
  // bytes applied since that snapshot, so serving an incremental sync
  // update never requires re-exporting a full snapshot (plan: "a log of
  // pending update bytes since that snapshot"). Compaction (folding
  // pending updates into a fresh snapshot and clearing the log) is
  // `doc-store.ts`'s `compactDoc`.
  `CREATE TABLE IF NOT EXISTS doc_snapshots (
    page_id TEXT PRIMARY KEY,
    snapshot BLOB NOT NULL,
    is_shallow INTEGER NOT NULL DEFAULT 0,
    version_vector BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS doc_pending_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    update_bytes BLOB NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS doc_pending_updates_page_id
    ON doc_pending_updates (page_id, id)`,

  // --- Catalog mirror ----------------------------------------------------
  //
  // Derived from the `vault-meta` Loro doc's root map (see `catalog.ts`).
  // `tombstoned`/`tombstoned_at` implement "last-tombstone-wins, explicit
  // undelete supported" (plan) — undelete is just a later catalog entry
  // with `tombstoned = 0` and a newer `updated_at`.
  `CREATE TABLE IF NOT EXISTS vault_catalog (
    page_id TEXT PRIMARY KEY,
    doc_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    tombstoned INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,

  // --- Reprojection bookkeeping -------------------------------------------
  //
  // "On DO startup/first request, compare a stored `lastProjectedVersion`
  // against actual doc state and auto-heal drift by reprojecting anything
  // behind" (plan). One row per page; `version_vector` is the Loro version
  // vector (encoded bytes) as of the last successful reprojection.
  `CREATE TABLE IF NOT EXISTS projection_state (
    page_id TEXT PRIMARY KEY,
    last_projected_version_vector BLOB NOT NULL,
    projected_at INTEGER NOT NULL
  )`,

  // `rebuild-projections` resumable checkpoint — single row, driven by a DO
  // alarm loop rather than one synchronous pass over every doc (plan:
  // "resumable — checkpointed by pageID, driven by a DO alarm loop").
  `CREATE TABLE IF NOT EXISTS rebuild_checkpoint (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL,
    after_page_id TEXT,
    processed_count INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  // `rebuild-projections` per-page failure log — plan: rebuild-projections
  // "isolates per-page failures (one corrupted/oversized doc must not
  // wedge the whole batch — record the failure and advance past it)".
  // `runRebuildBatch` (rebuild-projections.ts) wraps each page's
  // reprojection in its own try/catch and writes one row here per failed
  // attempt (not upserted by page_id, so a page that fails again on a
  // later rebuild run keeps its full history rather than clobbering the
  // earlier diagnostic). Deliberately NOT in `PROJECTION_VIEW_NAMES` —
  // worker bookkeeping, not a public graph-view table.
  `CREATE TABLE IF NOT EXISTS rebuild_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    error_message TEXT NOT NULL,
    failed_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS rebuild_failures_page_id
    ON rebuild_failures (page_id, failed_at)`,

  // --- Projection tables ---------------------------------------------------
  //
  // `graph_nodes`: real population logic in `projection.ts`. Column shape
  // ported from the old app's public view
  // (apps/enchiridion/Sources/EnchiridionCore/GraphDatabase.swift:156-167,
  // `graph_nodes` view over the `pages` table) — `node_id`/`title`/
  // `plain_text`/`kind`/`created_at`/`modified_at`/`deleted_at`/
  // `is_pinned`. Timestamps are epoch-millisecond integers here (DO SQLite
  // has no native date type; the old app's `REAL` julian/unix timestamps
  // are a GRDB/Swift convention, not part of the public contract).
  //
  // `person_visibility`/`person_origin` (nullable `TEXT`) — PRIVACY GATE
  // (adversarial review finding, plan §Gadgets P4: "the P2 privacy
  // classification for calendar-attendee Person pages lives only at the
  // materialization layer and has no enforcement at the query layer").
  // Mirrors `@enchiridion/projection`'s `GraphNodeRow.personVisibility`/
  // `.personOrigin` (`packages/projection/src/index.ts`, itself reading
  // `workers/gatekeeper-google/src/materialized-doc.ts`'s
  // `objectMetadata.personVisibility`/`.personOrigin` doc-level metadata —
  // NOT a supertag field). `NULL` for the overwhelming majority of nodes
  // (anything that isn't a Person page materialized from an external
  // provider); `'other'`/`'calendarAttendee'` (or `'gmailCorrespondent'`)
  // for an attendee-derived Person page that hasn't been promoted,
  // `'promoted'` for one a user has explicitly promoted. Read by
  // `supertag-accessors.ts`'s `SupertagAccessorFilterOptions` to enforce
  // the gate at the query layer for gadget-facing accessor calls — see
  // that file's header for the full trusted-path-vs-gadget-path boundary
  // decision. Declared here (`CREATE TABLE IF NOT EXISTS`) for a FRESH DO;
  // `addPersonVisibilityColumnsIfMissing` below is the guarded-`ALTER
  // TABLE` migration for a DO whose `graph_nodes` table predates these
  // columns — mirrors `workers/gatekeeper-google/src/schema.ts`'s
  // `addGrantedScopesColumnIfMissing` pattern exactly (see that file's
  // header point 1: `CREATE TABLE IF NOT EXISTS` alone is a no-op against
  // an already-existing table, so a real `ALTER TABLE` is still needed for
  // any vault DO that booted before this pass).
  `CREATE TABLE IF NOT EXISTS graph_nodes (
    node_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    plain_text TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    deleted_at INTEGER,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    person_visibility TEXT,
    person_origin TEXT
  )`,

  // TODO(P1 "effective-schema resolution", packages/projection): the
  // remaining public-view-contract tables get DDL now (so the bounded
  // query allowlist and rebuild-projections' schema are stable) but no
  // population logic in this P0 pass — `projection.ts` only writes
  // `graph_nodes`. Column shapes ported from GraphDatabase.swift's view
  // definitions (createPublicViews, lines noted per table) so P1 doesn't
  // need to invent shapes.
  // graph_tags: GraphDatabase.swift:169-178
  `CREATE TABLE IF NOT EXISTS graph_tags (
    tag_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    is_base INTEGER NOT NULL DEFAULT 0
  )`,
  // graph_tag_parents: GraphDatabase.swift:180-182
  `CREATE TABLE IF NOT EXISTS graph_tag_parents (
    tag_id TEXT NOT NULL,
    parent_tag_id TEXT NOT NULL,
    PRIMARY KEY (tag_id, parent_tag_id)
  )`,
  // graph_tag_closure: GraphDatabase.swift:184-188
  `CREATE TABLE IF NOT EXISTS graph_tag_closure (
    descendant_tag_id TEXT NOT NULL,
    ancestor_tag_id TEXT NOT NULL,
    depth INTEGER NOT NULL,
    PRIMARY KEY (descendant_tag_id, ancestor_tag_id)
  )`,
  // graph_node_tags: GraphDatabase.swift:190-199
  `CREATE TABLE IF NOT EXISTS graph_node_tags (
    node_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    direct INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (node_id, tag_id)
  )`,
  // graph_facts: GraphDatabase.swift:50-66, 201-207
  `CREATE TABLE IF NOT EXISTS graph_facts (
    fact_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    predicate_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    field_id TEXT NOT NULL,
    value_index INTEGER NOT NULL DEFAULT 0,
    value_type TEXT NOT NULL,
    text_value TEXT,
    number_value REAL,
    boolean_value INTEGER,
    local_date_value TEXT,
    date_time_value INTEGER,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // graph_relation_definitions: GraphDatabase.swift:209-214.
  // `targets_per_source`/`sources_per_target` are TEXT ("one"|"many"), NOT
  // INTEGER — matches @enchiridion/projection's `GraphRelationDefinitionRow`
  // (packages/projection/src/edges.ts), which emits those two fields as
  // strings (mirroring the old app's own TEXT columns,
  // GraphDatabase.swift:12), not the placeholder INTEGER type this DDL used
  // before packages/projection existed to check against.
  `CREATE TABLE IF NOT EXISTS graph_relation_definitions (
    relation_id TEXT PRIMARY KEY,
    forward_name TEXT NOT NULL,
    inverse_name TEXT NOT NULL,
    targets_per_source TEXT,
    sources_per_target TEXT,
    is_system INTEGER NOT NULL DEFAULT 0
  )`,
  // _graph_edges: PRIVATE, forward-only edge storage — matches
  // @enchiridion/projection's `GraphEdgeRow` shape exactly (edge_id,
  // relation_id, source_node_id, target_node_id, origin, created_at). One
  // row per canonical edge, forward direction only, ever — backlinks are
  // never materialized (GraphDataModel.md evolution rule #3,
  // packages/projection/src/edges.ts's header). Never exposed to the
  // bounded query surface directly (not in `PROJECTION_VIEW_NAMES` below,
  // and explicitly denied by `sql-validator.ts`'s forbidden-identifiers
  // check — see `PRIVATE_STORAGE_TABLE_NAMES` below) — only the public
  // `graph_edges` VIEW immediately after it is queryable, mirroring the old
  // app's `_graph_edges` (private table) / `graph_edges` (public view)
  // split (GraphDatabase.swift:67-77, 216-244).
  `CREATE TABLE IF NOT EXISTS _graph_edges (
    edge_id TEXT PRIMARY KEY,
    relation_id TEXT NOT NULL,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS _graph_edges_source ON _graph_edges (source_node_id)`,
  `CREATE INDEX IF NOT EXISTS _graph_edges_target ON _graph_edges (target_node_id)`,
  `CREATE INDEX IF NOT EXISTS _graph_edges_relation ON _graph_edges (relation_id)`,
  // graph_edges: the public VIEW — UNION ALL of the forward projection
  // (straight off `_graph_edges`) and the inverse projection (source/target
  // swapped, `inverse_name` instead of `forward_name`) computed at query
  // time, never stored. Exact SQL ported from GraphDatabase.swift:216-244,
  // as given verbatim in packages/projection/src/index.ts's header ("WIRING
  // NOTES FOR THE FOLLOW-UP TASK", point 4a) — not re-derived here.
  `CREATE VIEW IF NOT EXISTS graph_edges AS
    SELECT e.edge_id,
           e.source_node_id AS from_node_id,
           e.target_node_id AS to_node_id,
           e.relation_id,
           r.forward_name AS relationship_name,
           'forward' AS direction,
           e.source_node_id AS canonical_source_node_id,
           e.target_node_id AS canonical_target_node_id,
           e.origin,
           e.created_at
    FROM _graph_edges e
    JOIN graph_relation_definitions r ON r.relation_id = e.relation_id
    UNION ALL
    SELECT e.edge_id,
           e.target_node_id AS from_node_id,
           e.source_node_id AS to_node_id,
           e.relation_id,
           r.inverse_name AS relationship_name,
           'inverse' AS direction,
           e.source_node_id AS canonical_source_node_id,
           e.target_node_id AS canonical_target_node_id,
           e.origin,
           e.created_at
    FROM _graph_edges e
    JOIN graph_relation_definitions r ON r.relation_id = e.relation_id`,
  // graph_issues: GraphDatabase.swift:246-250
  `CREATE TABLE IF NOT EXISTS graph_issues (
    issue_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    node_id TEXT,
    edge_id TEXT,
    relation_id TEXT,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // graph_text_search: GraphDatabase.swift:112-114 (FTS5 virtual table).
  `CREATE VIRTUAL TABLE IF NOT EXISTS graph_text_search
    USING fts5(node_id UNINDEXED, title, body)`,

  // --- Blob references (blob-store.ts) --------------------------------
  //
  // Plan §Backend architecture, "Blobs (R2)": "Uploading a blob registers
  // its hash in a pending-references table before upload; GC only deletes
  // objects that are unreferenced by any live projection *and* past a
  // grace window (30 days)". One row per distinct `blob_<sha256>` id ever
  // registered; `status` moves 'pending' -> 'uploaded' once the R2 write
  // actually completes (see `blob-routes.ts`). Deliberately NOT in
  // `PROJECTION_VIEW_NAMES` above — this is worker bookkeeping, not a
  // public graph-view table, so the bounded query RPC never exposes it.
  `CREATE TABLE IF NOT EXISTS pending_blob_references (
    blob_id TEXT PRIMARY KEY,
    registered_at INTEGER NOT NULL,
    uploaded_at INTEGER,
    status TEXT NOT NULL DEFAULT 'pending'
  )`,

  // `backup.ts` resumable checkpoint — `rebuild_checkpoint`'s sibling, one
  // row, driven by the same DO alarm loop (plan §Backend architecture,
  // "Backup / disaster recovery"). `timestamp` identifies which backup run
  // (R2 key prefix `backups/<timestamp>/`) this checkpoint belongs to.
  `CREATE TABLE IF NOT EXISTS backup_checkpoint (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    after_page_id TEXT,
    processed_count INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

/** Additive migration for a DO whose `graph_nodes` table was created before
 *  `person_visibility`/`person_origin` existed — see the DDL comment on
 *  `graph_nodes` above for the full rationale. Same idempotent-by-catching-
 *  the-expected-error shape as `workers/gatekeeper-google/src/schema.ts`'s
 *  `addGrantedScopesColumnIfMissing`/`addProviderMessageIdColumnIfMissing`
 *  (SQLite has no `ADD COLUMN IF NOT EXISTS`; "already applied" is
 *  detected by catching the "duplicate column" error `ALTER TABLE` raises,
 *  not by checking first) — this file doesn't currently share that helper
 *  module with gatekeeper-google (two independently deployed workers, no
 *  shared runtime package between them, matching that file's own header),
 *  so the small helper is duplicated here rather than imported. */
function addColumnIfMissing(sql: SqlExecutor, table: string, column: string, columnType: string): void {
  try {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnType}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("duplicate column")) {
      throw error;
    }
  }
}

function addPersonVisibilityColumnsIfMissing(sql: SqlExecutor): void {
  addColumnIfMissing(sql, "graph_nodes", "person_visibility", "TEXT");
  addColumnIfMissing(sql, "graph_nodes", "person_origin", "TEXT");
}

/** Idempotently creates every table this DO owns. Safe to call on every DO
 *  wake (constructor), matching the plan's "no in-memory handshake
 *  progress" hibernation requirement — schema state must be durable and
 *  re-derivable from a cold start, never assumed already-applied. */
export function initializeSchema(sql: SqlExecutor): void {
  for (const statement of DDL_STATEMENTS) {
    sql.exec(statement);
  }
  addPersonVisibilityColumnsIfMissing(sql);
}
