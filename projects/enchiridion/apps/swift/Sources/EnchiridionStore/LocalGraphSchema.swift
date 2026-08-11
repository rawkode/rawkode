// LocalGraphSchema.swift
// EnchiridionStore
//
// The on-device SQLite schema: GRDB `DatabaseMigrator`-managed DDL for the
// local mirror of the knowledge-graph projection contract documented in
// `apps/enchiridion/Documentation/GraphDataModel.md` and, on the backend,
// `workers/vault/src/schema.ts`'s `PROJECTION_VIEW_NAMES` table family.
//
// SHAPE, mirrored from two sources at once (both cited per table below):
//   - Column names/types: `workers/vault/src/schema.ts`'s `graph_*` DDL —
//     "you're the client-side mirror of the same contract" (task brief).
//     Timestamps are therefore epoch-millisecond `INTEGER`, matching
//     schema.ts's convention (NOT the old app's Julian/unix `REAL`
//     convention — that was a GRDB/Swift-only convention there, never part
//     of the public contract per schema.ts's own header comment).
//   - The physical-table / public-view split: the old app's
//     `GraphDatabase.swift` (`createPublicViews`) and
//     `GraphDataModel.md`'s explicit sentence "Physical tables are denied
//     by the SQLite authorizer." schema.ts's tables ARE already the public
//     shape (VaultDO's `projection.ts` writes `graph_nodes` directly, no
//     view indirection needed server-side because there's no separate
//     "private" authority table there) — but the semantic contract this
//     app also has to honor requires a real physical/public split so the
//     bounded executor's authorizer (`GraphSQLExecutor.swift`) has
//     something genuine to deny. Physical tables here are prefixed `_local_`
//     (old app used `_graph_`; renamed to `_local_` to make plain in the
//     authorizer denial messages and tests that this is the on-device
//     mirror, not VaultDO's own storage).
//
// POPULATION SCOPE (deliberately matching schema.ts's own stance — see its
// file header: "only `graph_nodes` gets real population logic ... the rest
// get their DDL ... but are otherwise empty pass-through tables for now"):
// `LocalGraphStore.writeProjection` (LocalGraphStore.swift) populates
// `_local_nodes`, `_local_facts`, `_local_edges`, `_local_node_tags` (direct
// membership only, depth 0 — no closure) and `graph_text_search` directly
// from a `PageDocumentProjection`, all of which are derivable from one
// page's CRDT projection alone. `_local_tags` (tag *definitions*:
// name/sort_order/is_base), `_local_tag_parents`, `_local_tag_closure`, and
// `_local_relation_definitions` (relation forward/inverse *names*) need the
// supertag module registry — `EnchiridionSchema`, not yet wired to runtime
// data — so those tables get DDL now and stay empty until that follow-up.
// `graph_edges`'s view still works meaningfully without relation
// definitions (see below); `graph_node_tags`/`graph_tags` will just be
// direct-membership-only / empty until then. This is a stated, documented
// gap, not a silent omission.

import Foundation
import GRDB

public enum LocalGraphSchema {
  /// Every table/view name the bounded query executor (`GraphSQLExecutor`)
  /// allows a caller to read from. TS mirror:
  /// `workers/vault/src/schema.ts`'s `PROJECTION_VIEW_NAMES`; Swift-side
  /// precedent: the old app's `GraphSQLExecutor.allowedSources`
  /// (apps/enchiridion/Sources/EnchiridionCore/GraphSQLExecutor.swift:45-60,
  /// restricted here to the P0/P1 core contract — no compiled-module views
  /// yet, since no module system exists on the Swift side today).
  public static let projectionViewNames: Set<String> = [
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
  ]

  /// FTS5 auto-generates these shadow tables for `graph_text_search`. Must
  /// never be directly queryable — mirrors the old app's
  /// `GraphSQLExecutor.ftsShadowSources` and schema.ts's
  /// `FTS_SHADOW_TABLE_NAMES`.
  public static let ftsShadowTableNames: Set<String> = [
    "graph_text_search_config",
    "graph_text_search_content",
    "graph_text_search_data",
    "graph_text_search_docsize",
    "graph_text_search_idx",
  ]

  public static var migrator: DatabaseMigrator {
    var migrator = DatabaseMigrator()

    migrator.registerMigration("v1-graph-projection") { db in
      // --- Physical tables (never directly queryable via the bounded
      // executor — see this file's header). Column shapes match
      // schema.ts's DDL_STATEMENTS byte-for-byte in name/intent, adapted
      // from CREATE TABLE graph_x to CREATE TABLE _local_x + a passthrough
      // view named graph_x.

      // schema.ts: graph_nodes.
      try db.execute(sql: """
        CREATE TABLE _local_nodes (
          node_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          plain_text TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          modified_at INTEGER NOT NULL,
          deleted_at INTEGER,
          is_pinned INTEGER NOT NULL DEFAULT 0
        )
        """)

      // schema.ts: graph_tags. Population deferred — see file header.
      try db.execute(sql: """
        CREATE TABLE _local_tags (
          tag_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          deleted INTEGER NOT NULL DEFAULT 0,
          is_base INTEGER NOT NULL DEFAULT 0
        )
        """)

      // schema.ts: graph_tag_parents. Population deferred.
      try db.execute(sql: """
        CREATE TABLE _local_tag_parents (
          tag_id TEXT NOT NULL,
          parent_tag_id TEXT NOT NULL,
          PRIMARY KEY (tag_id, parent_tag_id)
        )
        """)

      // schema.ts: graph_tag_closure. Population deferred.
      try db.execute(sql: """
        CREATE TABLE _local_tag_closure (
          descendant_tag_id TEXT NOT NULL,
          ancestor_tag_id TEXT NOT NULL,
          depth INTEGER NOT NULL,
          PRIMARY KEY (descendant_tag_id, ancestor_tag_id)
        )
        """)
      try db.execute(sql: """
        CREATE INDEX _local_tag_closure_on_ancestor
          ON _local_tag_closure (ancestor_tag_id, descendant_tag_id)
        """)

      // schema.ts: graph_node_tags. `LocalGraphStore.writeProjection`
      // writes direct-membership rows only (depth 0, direct 1) — no
      // ancestor closure until `_local_tag_closure` is populated.
      try db.execute(sql: """
        CREATE TABLE _local_node_tags (
          node_id TEXT NOT NULL,
          tag_id TEXT NOT NULL,
          depth INTEGER NOT NULL DEFAULT 0,
          direct INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (node_id, tag_id)
        )
        """)

      // schema.ts: graph_facts.
      try db.execute(sql: """
        CREATE TABLE _local_facts (
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
        )
        """)
      try db.execute(sql: "CREATE INDEX _local_facts_on_node ON _local_facts (node_id)")

      // schema.ts: graph_relation_definitions. Population deferred (no
      // declared-relation registry wired to Swift yet — see
      // `BuiltInRelations`'s TODO in EnchiridionCore/PageModels.swift).
      try db.execute(sql: """
        CREATE TABLE _local_relation_definitions (
          relation_id TEXT PRIMARY KEY,
          forward_name TEXT NOT NULL,
          inverse_name TEXT NOT NULL,
          targets_per_source INTEGER,
          sources_per_target INTEGER,
          is_system INTEGER NOT NULL DEFAULT 0
        )
        """)

      // schema.ts: graph_edges (there, already the post-expansion shape;
      // here, `_local_edges` stores ONE row per canonical edge — same as
      // the old app's `_graph_edges` — and the `graph_edges` VIEW below
      // does the forward/inverse expansion, same as the old app's
      // `createPublicViews`).
      try db.execute(sql: """
        CREATE TABLE _local_edges (
          edge_id TEXT PRIMARY KEY,
          relation_id TEXT NOT NULL,
          source_node_id TEXT NOT NULL,
          target_node_id TEXT NOT NULL,
          origin TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
        """)
      try db.execute(sql: "CREATE INDEX _local_edges_on_source ON _local_edges (relation_id, source_node_id)")
      try db.execute(sql: "CREATE INDEX _local_edges_on_target ON _local_edges (relation_id, target_node_id)")

      // schema.ts: graph_issues. Population deferred (cardinality/issue
      // detection is downstream projection logic not yet written on either
      // side — see PageModels.swift's header, "not yet written —
      // packages/projection is still a stub").
      try db.execute(sql: """
        CREATE TABLE _local_issues (
          issue_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          node_id TEXT,
          edge_id TEXT,
          relation_id TEXT,
          message TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
        """)

      // schema.ts: graph_text_search (FTS5 virtual table — already public
      // by name on both sides, no view indirection; its shadow tables are
      // what the authorizer + lexical pre-check must deny).
      try db.execute(sql: """
        CREATE VIRTUAL TABLE graph_text_search USING fts5(node_id UNINDEXED, title, body)
        """)

      // --- Public views — the only names `GraphSQLExecutor` allowlists.

      try db.execute(sql: """
        CREATE VIEW graph_nodes AS
        SELECT node_id, title, plain_text, kind, created_at, modified_at, deleted_at, is_pinned
        FROM _local_nodes
        """)

      try db.execute(sql: """
        CREATE VIEW graph_tags AS
        SELECT tag_id, name, sort_order, deleted, is_base
        FROM _local_tags
        """)

      try db.execute(sql: """
        CREATE VIEW graph_tag_parents AS
        SELECT tag_id, parent_tag_id
        FROM _local_tag_parents
        """)

      try db.execute(sql: """
        CREATE VIEW graph_tag_closure AS
        SELECT descendant_tag_id, ancestor_tag_id, depth
        FROM _local_tag_closure
        """)

      // NOTE: deliberately NOT joined against `_local_tag_closure` (unlike
      // the old app's `graph_node_tags` view) — that join would return
      // *zero* rows for every direct membership until closure rows exist
      // too (an INNER JOIN requiring each tag's own depth-0 closure row),
      // which is a worse regression than a flat passthrough while the
      // registry doesn't exist yet. TODO(P1+, once `_local_tag_closure` is
      // populated): switch to the closure-joined form so ancestor tags are
      // included, matching GraphDataModel.md's full contract.
      try db.execute(sql: """
        CREATE VIEW graph_node_tags AS
        SELECT node_id, tag_id, depth, direct
        FROM _local_node_tags
        """)

      try db.execute(sql: """
        CREATE VIEW graph_facts AS
        SELECT fact_id, node_id, predicate_id, tag_id, field_id, value_index,
               value_type, text_value, number_value, boolean_value,
               local_date_value, date_time_value, origin, created_at
        FROM _local_facts
        """)

      try db.execute(sql: """
        CREATE VIEW graph_relation_definitions AS
        SELECT relation_id, forward_name, inverse_name, targets_per_source, sources_per_target, is_system
        FROM _local_relation_definitions
        """)

      // Forward/inverse expansion, same shape as the old app's
      // `graph_edges` view. LEFT JOIN (not INNER, unlike the old app) with
      // a COALESCE fallback to the raw relation ID as the display name —
      // `_local_relation_definitions` is empty until the registry lands
      // (see file header), and an INNER JOIN would make every edge
      // disappear from this view until then, which would make the store
      // useless for edge queries in the interim. The fallback is honest
      // (it surfaces the synthetic relation ID, never a fabricated name).
      try db.execute(sql: """
        CREATE VIEW graph_edges AS
        SELECT e.edge_id,
               e.source_node_id AS from_node_id,
               e.target_node_id AS to_node_id,
               e.relation_id,
               COALESCE(r.forward_name, e.relation_id) AS relationship_name,
               'forward' AS direction,
               e.source_node_id AS canonical_source_node_id,
               e.target_node_id AS canonical_target_node_id,
               e.origin,
               e.created_at
        FROM _local_edges e
        LEFT JOIN _local_relation_definitions r ON r.relation_id = e.relation_id
        UNION ALL
        SELECT e.edge_id,
               e.target_node_id AS from_node_id,
               e.source_node_id AS to_node_id,
               e.relation_id,
               COALESCE(r.inverse_name, e.relation_id) AS relationship_name,
               'inverse' AS direction,
               e.source_node_id AS canonical_source_node_id,
               e.target_node_id AS canonical_target_node_id,
               e.origin,
               e.created_at
        FROM _local_edges e
        LEFT JOIN _local_relation_definitions r ON r.relation_id = e.relation_id
        """)

      try db.execute(sql: """
        CREATE VIEW graph_issues AS
        SELECT issue_id, kind, node_id, edge_id, relation_id, message, created_at
        FROM _local_issues
        """)
    }

    // task #66 ("Assistant read tools") addition. `person_visibility`/
    // `person_origin` — PRIVACY GATE. Mirrors `workers/vault/src/schema.ts`'s
    // own `graph_nodes` DDL byte-for-byte in name/intent (nullable `TEXT`,
    // same two column names, same `addColumnIfMissing`-style additive
    // migration there) and `EnchiridionCore.PersonVisibility`/`PersonOrigin`
    // (`PageModels.swift`) — which `LocalGraphStore.writeProjection`
    // (LocalGraphStore.swift) already receives via
    // `PageDocumentProjection.objectMetadata.personVisibility`/
    // `.personOrigin` but, before this migration, had nowhere to persist
    // them: `_local_nodes`/`graph_nodes` simply had no such columns yet.
    // Plan §Google gatekeeper: calendar-attendee Person pages "are excluded
    // from broad sync/assistant-grounding surfaces by default" — this
    // column is what `EnchiridionStore/AssistantReadTools.swift`'s
    // `searchPages` filters on to honor that for the assistant specifically
    // (`gadget-host/src/graph-query-views.ts`'s server-side
    // `GADGET_EXCLUDED_PERSON_VISIBILITY` filter is the same idea, one
    // layer over).
    //
    // A separate migration (not folded into "v1-graph-projection" above)
    // because GRDB's `DatabaseMigrator` treats already-registered
    // migrations as immutable/applied — see the plan's "Schema migration"
    // pin ("additive-only means renames/retypes need new field IDs +
    // reconciliation materializers") applied here to this local mirror's
    // own DDL, not just supertag fields.
    migrator.registerMigration("v2-assistant-person-visibility") { db in
      try db.execute(sql: "ALTER TABLE _local_nodes ADD COLUMN person_visibility TEXT")
      try db.execute(sql: "ALTER TABLE _local_nodes ADD COLUMN person_origin TEXT")

      // The `graph_nodes` view's column list must include the two new
      // columns, so it has to be dropped and recreated (SQLite has no
      // `CREATE OR REPLACE VIEW`/`ALTER VIEW`).
      try db.execute(sql: "DROP VIEW graph_nodes")
      try db.execute(sql: """
        CREATE VIEW graph_nodes AS
        SELECT node_id, title, plain_text, kind, created_at, modified_at, deleted_at, is_pinned,
               person_visibility, person_origin
        FROM _local_nodes
        """)
    }

    // Task #78 ("Durable local CRDT snapshot persistence" — see
    // `LocalGraphStore.swift`'s former "Design note: wiring `VaultSyncClient`
    // updates into reprojection" section, which documented exactly this gap:
    // before this migration, NOTHING in this package durably persisted a
    // page's raw Loro document snapshot anywhere — `PageEditorController`'s
    // `durableDocument` was in-memory only, and every write path
    // (`PageEditorController`, `ShareCapture`, the assistant's confirmed-
    // task-mutation apply step) discarded its `PageDocument.MutationResult.document`
    // bytes the moment it had extracted a `PageDocumentProjection` from
    // them. This table is the fix: one row per page, holding the CURRENT
    // `LoroDoc.exportSnapshot()` bytes plus enough metadata (`version`, an
    // encoded `PageDocumentVersion` — `LocalGraphStore.swift`'s
    // `PageDocumentSnapshotRecord`) for a future sync-reprojection consumer
    // to pick up without any further schema change — see this file's
    // header for why that consumer itself is still out of scope here.
    //
    // Deliberately a PHYSICAL table only (`_local_` naming convention this
    // file already uses for physical, non-bounded-query-reachable storage),
    // and deliberately NOT added to `projectionViewNames` — a page's raw
    // CRDT bytes are never a legitimate bounded-SQL read target (they are
    // opaque Loro binary, not a projected column), so the bounded executor
    // must keep denying it exactly like every other `_local_*` table
    // (`GraphSQLExecutor.swift`'s allowlist-only authorizer already does
    // this for free — nothing else to change there).
    //
    // Kept as a table in this same schema/database file (not a sibling
    // SQLite file with its own `DatabasePool`/migrator) so every existing
    // production location that already resolves ONE `LocalGraphStore`
    // path — `LocalGraphStoreLocation.openAppGroupStore()`, shared by the
    // main app, both widgets, and both share extensions — gets snapshot
    // persistence for free, with no second file to keep in sync, no second
    // App Group container lookup, and no second migrator's bookkeeping
    // table sharing (or racing on) the same physical file. The old design
    // note's "not this store's job" framing was scoped to that task's own
    // remit (a pure projection store, no snapshot concept existed yet at
    // all) rather than a permanent constraint — this migration extends
    // `LocalGraphStore`'s job description deliberately, while preserving
    // the exact invariant that note protected: CRDT bytes stay physically
    // and access-control-wise separate from the projection tables/views.
    migrator.registerMigration("v3-page-document-snapshots") { db in
      try db.execute(sql: """
        CREATE TABLE _local_page_snapshots (
          page_id TEXT PRIMARY KEY,
          snapshot BLOB NOT NULL,
          version BLOB NOT NULL,
          updated_at INTEGER NOT NULL
        )
        """)
    }

    return migrator
  }
}
