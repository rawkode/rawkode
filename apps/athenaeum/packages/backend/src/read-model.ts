// The Views+Search stage's read-model: real DO SQLite tables/views, maintained in parallel to
// `typed-storage-effect`'s KV collections, plus the `ViewSpec`→SQL compiler and bounded query
// executor that read from them.
//
// === Design decision: option (b), a parallel de-normalized read-model — not option (a) ===
//
// The task framed this as a choice: "(a) expose physical table names from typed-storage-effect's
// collection objects for view-creation purposes, or (b) have views read from a de-normalized
// read-model you maintain in parallel — pick the simpler correct option and document why."
//
// Option (a) is not actually available in a useful form. `typed-storage-effect` (see
// `collection.ts`/`kv-prefixed-view.ts`) stores every record as an **opaque serialized blob**
// under a single generic KV keyspace (`storage.kv`, itself backed by DO SQLite internally, but
// through Cloudflare's own hidden key/value table, not one column per field): a `Node` isn't a
// SQL row with `id`/`workspaceId`/`title`/`createdAt` columns, it's one `(key, value)` pair where
// `value` is the whole record blob. There is no physical relational table with real columns to
// build a `CREATE VIEW ... AS SELECT id, workspaceId, title FROM <table>` against — "the physical
// table name" for `nodes` is not a table with node-shaped columns at all. So (a) would mean
// exposing KV-blob storage as if it had columns, which it doesn't; the honest per-field SQL
// views the plan wants (queryable by column: `WHERE title = ?`, `GROUP BY <fact value>`, joins
// between `graph_facts`/`graph_nodes`/`graph_tag_closure`, `FTS5 MATCH`) are simply not
// constructible directly over that storage shape.
//
// Option (b) — real SQL tables (`rm_*`, "read-model") written explicitly alongside every
// KV-collection mutation, with the public `graph_*` views defined over *those* — is therefore
// not just simpler, it's the only one that can actually produce SQL views with real, queryable
// columns. The KV collections stay the canonical source of truth (unchanged); these tables are
// a derived, DO-instance-local secondary index of that same data, kept in sync by explicit
// writes at each mutation call site (see `graph-service-live.ts`/`notes-service-live.ts`/
// `workspace-durable-object.ts`'s `createNode`) — the same "maintain a materialized projection
// alongside the canonical write" pattern `tag-closure.ts` already establishes for
// `graph_tag_closure` specifically; this file generalizes it to every other `graph_*` view.
//
// === Authorizer / bounded-execution honesty note (task item 3) ===
//
// Investigated: `@cloudflare/workers-types`' `SqlStorage` interface (`node_modules/.../
// workers-types/index.d.ts`, `interface SqlStorage`) exposes exactly `exec(query, ...bindings)`,
// `databaseSize`, and the `Cursor`/`Statement` constructors — **no** `sqlite3_set_authorizer`
// equivalent, no query-compile hook, no cancellation token, no execution-time budget parameter.
// DO SQLite's JS binding does not expose SQLite's C-level authorizer API. This is a genuine
// platform gap, not an oversight on this stage's part — confirmed by reading the actual .d.ts,
// not assumed.
//
// What's implemented instead is an **app-layer substitute**, weaker than a true SQLite-level
// guarantee, and documented as such rather than oversold:
//   1. **Single-statement, read-only, fixed-view-only by construction**: `compileRunView` is the
//      *only* path that ever produces SQL here, and it only ever emits one `SELECT ... FROM
//      <one of the 10 GraphViewName literals> ...` statement — every identifier (view name,
//      column name, join alias) comes from a closed allowlist (`VIEW_COLUMNS`, `GraphViewName`'s
//      own schema literal), never from unsanitized caller text; every value is bound via `?`
//      parameters, never string-interpolated. There is no code path that could emit a second
//      statement, a write statement, or a reference to an `rm_*` physical table or any table
//      outside the fixed view set — but this is enforced by "the compiler never generates
//      anything else", not by SQLite refusing to execute something the compiler already wrote.
//   2. **Bounded row count**: every compiled query always carries a `LIMIT`, clamped to
//      `MAX_ROW_LIMIT` regardless of what `ViewSpec.rowLimit` requests.
//   3. **Bounded predicate shape**: `compilePredicate` caps both the total predicate-tree node
//      count (`MAX_PREDICATE_NODES`) and nesting depth (`MAX_PREDICATE_DEPTH`), rejecting an
//      oversized/deeply-nested filter with a `ValidationError` before any SQL is built — a
//      defense against a pathologically large generated `WHERE` clause (relevant given DO
//      SQLite's own 100KB max-statement-size limit, plan §"Storage & domain model").
//   4. **Bounded execution time — the honest weak point**: `SqlStorage#exec` is **synchronous**
//      and offers no cancellation/timeout mechanism at all. There is no way, from application
//      JS, to abort a query that is already executing inside `exec()` — by the time control
//      returns to this code, the query has already fully run. `runCompiledQuery` below measures
//      wall-clock time and `cursor.rowsRead` *after* execution and logs a warning if either
//      looks pathological, but this is **observability, not prevention**: it cannot stop a slow
//      query from consuming its full execution time before the warning is even emitted. The real
//      backstop against a runaway query is the Workers platform's own per-request CPU limit
//      (plan's own limits callout: "30s default CPU/request, extendable to 5 min") killing the
//      whole request — this file does not, and cannot, provide a *query-level* timeout stronger
//      than that. Anyone relying on this module should treat "bounded execution time" as
//      "bounded row count plus a hard LIMIT plus post-hoc logging", not as a real per-query
//      deadline.
//
// Net effect: (1)+(2)+(3) really do deliver "single-statement, read-only, restricted-to-the-
// fixed-view-set, row-bounded" — a genuine guarantee, just enforced by this module's own code
// discipline (a closed compiler) rather than by the database engine refusing anything else.
// (4) is not a real per-query timeout and is not claimed to be one.

import * as Effect from "effect/Effect"
import { UnexpectedError, ValidationError, type GraphViewName, type ViewPredicate, type ViewSpec } from "@athenaeum/domain"

// ================================================================================================
// DDL — physical `rm_*` tables (never queried directly by the compiler) plus the public `graph_*`
// views (the only names `compileRunView` may ever reference). Idempotent: called once from
// `WorkspaceDurableObject`'s constructor on every construction (including re-construction after
// eviction), same as `ensureBaseTagsSeeded`'s own idempotency discipline.

const DDL_STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS rm_nodes (
     id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL, title TEXT NOT NULL, createdAt TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS rm_nodes_workspaceId ON rm_nodes(workspaceId)`,

  `CREATE TABLE IF NOT EXISTS rm_tags (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, builtin INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS rm_tag_parents (
     tagId TEXT NOT NULL, parentId TEXT NOT NULL, PRIMARY KEY (tagId, parentId)
   )`,

  `CREATE TABLE IF NOT EXISTS rm_tag_closure (
     ancestorId TEXT NOT NULL, descendantId TEXT NOT NULL, PRIMARY KEY (ancestorId, descendantId)
   )`,
  `CREATE INDEX IF NOT EXISTS rm_tag_closure_descendant ON rm_tag_closure(descendantId)`,

  `CREATE TABLE IF NOT EXISTS rm_node_tags (
     nodeId TEXT NOT NULL, tagId TEXT NOT NULL, PRIMARY KEY (nodeId, tagId)
   )`,
  `CREATE INDEX IF NOT EXISTS rm_node_tags_tagId ON rm_node_tags(tagId)`,

  `CREATE TABLE IF NOT EXISTS rm_facts (
     id TEXT PRIMARY KEY, nodeId TEXT NOT NULL, predicateId TEXT NOT NULL, value TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS rm_facts_nodeId ON rm_facts(nodeId)`,
  `CREATE INDEX IF NOT EXISTS rm_facts_predicateId ON rm_facts(predicateId)`,

  `CREATE TABLE IF NOT EXISTS rm_relation_definitions (
     id TEXT PRIMARY KEY, forwardName TEXT NOT NULL, inverseName TEXT NOT NULL,
     sourceTagId TEXT NOT NULL, targetTagId TEXT NOT NULL, cardinality TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS rm_edges (
     id TEXT PRIMARY KEY, relationDefinitionId TEXT NOT NULL,
     sourceNodeId TEXT NOT NULL, targetNodeId TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS rm_edges_source ON rm_edges(sourceNodeId)`,
  `CREATE INDEX IF NOT EXISTS rm_edges_target ON rm_edges(targetNodeId)`,

  `CREATE TABLE IF NOT EXISTS rm_graph_issues (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, relationDefinitionId TEXT NOT NULL,
     nodeId TEXT NOT NULL, conflictingEdgeIds TEXT NOT NULL, createdAt TEXT NOT NULL
   )`,

  // The public, authorizer-allowlisted read-only views (plan §"Storage & domain model" /
  // GraphDataModel.md §"SQL versus Cypher" — exact name list).
  `CREATE VIEW IF NOT EXISTS graph_nodes AS SELECT id, workspaceId, title, createdAt FROM rm_nodes`,
  `CREATE VIEW IF NOT EXISTS graph_tags AS SELECT id, name, builtin FROM rm_tags`,
  `CREATE VIEW IF NOT EXISTS graph_tag_parents AS SELECT tagId, parentId FROM rm_tag_parents`,
  `CREATE VIEW IF NOT EXISTS graph_tag_closure AS SELECT ancestorId, descendantId FROM rm_tag_closure`,
  `CREATE VIEW IF NOT EXISTS graph_node_tags AS SELECT nodeId, tagId FROM rm_node_tags`,
  `CREATE VIEW IF NOT EXISTS graph_facts AS SELECT id, nodeId, predicateId, value FROM rm_facts`,
  `CREATE VIEW IF NOT EXISTS graph_relation_definitions AS
     SELECT id, forwardName, inverseName, sourceTagId, targetTagId, cardinality
     FROM rm_relation_definitions`,
  `CREATE VIEW IF NOT EXISTS graph_edges AS
     SELECT id, relationDefinitionId, sourceNodeId, targetNodeId FROM rm_edges`,
  `CREATE VIEW IF NOT EXISTS graph_issues AS
     SELECT id, kind, relationDefinitionId, nodeId, conflictingEdgeIds, createdAt FROM rm_graph_issues`,

  // `graph_text_search` is deliberately the FTS5 virtual table itself, not a view wrapping a
  // separate `rm_*` table: SQLite's `MATCH` operator is resolved against the FTS5 virtual
  // table's own module, and a plain `CREATE VIEW ... AS SELECT * FROM <fts5 table>` cannot be
  // relied on to preserve that (query-flattening behavior around virtual-table `MATCH` isn't
  // guaranteed the way it is for ordinary column predicates). Naming the vtab itself
  // `graph_text_search` sidesteps that ambiguity entirely and keeps this row's storage and its
  // public read-only name identical, mirroring `fts-probe-durable-object.ts`'s already-confirmed
  // shape (`title`, `body` columns) plus `nodeId` to correlate hits back to a node.
  `CREATE VIRTUAL TABLE IF NOT EXISTS graph_text_search USING fts5(nodeId UNINDEXED, title, body)`
]

/** Idempotent — safe to call on every `WorkspaceDurableObject` construction, including
 *  re-construction after eviction (mirrors `ensureBaseTagsSeeded`'s own idempotency). Plain
 *  synchronous DDL, not wrapped in Effect: called once from the DO constructor alongside the
 *  other non-Effect setup work there, before any RPC method (which *does* run through Effect)
 *  can possibly execute. */
export const ensureGraphViews = (sql: SqlStorage): void => {
  for (const statement of DDL_STATEMENTS) {
    sql.exec(statement)
  }
}

// ================================================================================================
// Read-model writers — one per collection, called by `graph-service-live.ts`/
// `notes-service-live.ts`/`workspace-durable-object.ts`'s `createNode` immediately after the
// corresponding `typed-storage-effect` collection write succeeds. `INSERT OR REPLACE` (SQLite's
// upsert-by-primary-key form) throughout, since every one of these mirrors a KV `put` that may be
// either a first insert or an update.

const toReadModelError = (action: string) => (cause: unknown): UnexpectedError =>
  new UnexpectedError({
    message: `read-model ${action} failed: ${cause instanceof Error ? cause.message : String(cause)}`
  })

export const upsertNode = (
  sql: SqlStorage,
  node: { readonly id: string; readonly workspaceId: string; readonly title: string; readonly createdAt: string }
): Effect.Effect<void, UnexpectedError> =>
  Effect.try({
    try: () =>
      void sql.exec(
        `INSERT OR REPLACE INTO rm_nodes (id, workspaceId, title, createdAt) VALUES (?, ?, ?, ?)`,
        node.id,
        node.workspaceId,
        node.title,
        node.createdAt
      ),
    catch: toReadModelError("upsertNode")
  })

export const upsertTag = (
  sql: SqlStorage,
  tag: { readonly id: string; readonly name: string; readonly builtin: boolean }
): Effect.Effect<void, UnexpectedError> =>
  Effect.try({
    try: () =>
      void sql.exec(
        `INSERT OR REPLACE INTO rm_tags (id, name, builtin) VALUES (?, ?, ?)`,
        tag.id,
        tag.name,
        tag.builtin ? 1 : 0
      ),
    catch: toReadModelError("upsertTag")
  })

export const replaceTagParents = (
  sql: SqlStorage,
  tagId: string,
  parentIds: ReadonlyArray<string>
): Effect.Effect<void, UnexpectedError> =>
  Effect.try({
    try: () => {
      sql.exec(`DELETE FROM rm_tag_parents WHERE tagId = ?`, tagId)
      for (const parentId of parentIds) {
        sql.exec(`INSERT OR REPLACE INTO rm_tag_parents (tagId, parentId) VALUES (?, ?)`, tagId, parentId)
      }
    },
    catch: toReadModelError("replaceTagParents")
  })

/** Mirrors `tag-closure.ts`'s `recomputeAndPersistTagClosure`'s own "recompute the whole workspace's
 *  closure from scratch" contract exactly — called with the *complete* fresh closure row set on
 *  every tag create/parent-change, never a partial delta. */
export const replaceAllTagClosure = (
  sql: SqlStorage,
  rows: ReadonlyArray<{ readonly ancestorId: string; readonly descendantId: string }>
): Effect.Effect<void, UnexpectedError> =>
  Effect.try({
    try: () => {
      sql.exec(`DELETE FROM rm_tag_closure`)
      for (const row of rows) {
        sql.exec(
          `INSERT OR REPLACE INTO rm_tag_closure (ancestorId, descendantId) VALUES (?, ?)`,
          row.ancestorId,
          row.descendantId
        )
      }
    },
    catch: toReadModelError("replaceAllTagClosure")
  })

export const upsertNodeTag = (
  sql: SqlStorage,
  nodeId: string,
  tagId: string
): Effect.Effect<void, UnexpectedError> =>
  Effect.try({
    try: () =>
      void sql.exec(`INSERT OR REPLACE INTO rm_node_tags (nodeId, tagId) VALUES (?, ?)`, nodeId, tagId),
    catch: toReadModelError("upsertNodeTag")
  })

/** `upsertNodeTag`'s delete counterpart — the read-model half of `GraphService.unassignTag`
 *  (supertag-centering pass, docs/supertag-centering-decisions.md §2's `unassignTag` addition),
 *  mirroring `deleteEdge`'s own "keep both tiers in sync at every mutation site" shape exactly:
 *  removing a `#tag` chip from a note's rich text must retract the row from `rm_node_tags` (and
 *  therefore `graph_node_tags`), not just the canonical KV `NodeTagsCollections` row. */
export const deleteNodeTag = (
  sql: SqlStorage,
  nodeId: string,
  tagId: string
): Effect.Effect<void, UnexpectedError> =>
  Effect.try({
    try: () => void sql.exec(`DELETE FROM rm_node_tags WHERE nodeId = ? AND tagId = ?`, nodeId, tagId),
    catch: toReadModelError("deleteNodeTag")
  })

export const upsertFact = (
  sql: SqlStorage,
  fact: { readonly id: string; readonly nodeId: string; readonly predicateId: string; readonly value: unknown }
): Effect.Effect<void, UnexpectedError> =>
  Effect.try({
    try: () =>
      void sql.exec(
        `INSERT OR REPLACE INTO rm_facts (id, nodeId, predicateId, value) VALUES (?, ?, ?, ?)`,
        fact.id,
        fact.nodeId,
        fact.predicateId,
        JSON.stringify(fact.value)
      ),
    catch: toReadModelError("upsertFact")
  })

export const upsertRelationDefinition = (
  sql: SqlStorage,
  relationDefinition: {
    readonly id: string
    readonly forwardName: string
    readonly inverseName: string
    readonly sourceTagId: string
    readonly targetTagId: string
    readonly cardinality: string
  }
): Effect.Effect<void, UnexpectedError> =>
  Effect.try({
    try: () =>
      void sql.exec(
        `INSERT OR REPLACE INTO rm_relation_definitions
           (id, forwardName, inverseName, sourceTagId, targetTagId, cardinality)
         VALUES (?, ?, ?, ?, ?, ?)`,
        relationDefinition.id,
        relationDefinition.forwardName,
        relationDefinition.inverseName,
        relationDefinition.sourceTagId,
        relationDefinition.targetTagId,
        relationDefinition.cardinality
      ),
    catch: toReadModelError("upsertRelationDefinition")
  })

export const upsertEdge = (
  sql: SqlStorage,
  edge: {
    readonly id: string
    readonly relationDefinitionId: string
    readonly sourceNodeId: string
    readonly targetNodeId: string
  }
): Effect.Effect<void, UnexpectedError> =>
  Effect.try({
    try: () =>
      void sql.exec(
        `INSERT OR REPLACE INTO rm_edges (id, relationDefinitionId, sourceNodeId, targetNodeId)
         VALUES (?, ?, ?, ?)`,
        edge.id,
        edge.relationDefinitionId,
        edge.sourceNodeId,
        edge.targetNodeId
      ),
    catch: toReadModelError("upsertEdge")
  })

/** Removes one edge from the read-model (`rm_edges`, and therefore `graph_edges`) — the
 *  `upsertEdge` counterpart needed once a mutation path can actually retract an edge rather than
 *  only ever adding one. First real caller: `syncNoteReferences`' reconciliation (rich-text-editor
 *  pass, entity-reference-to-edge projection) removing a stale `"mentions"` edge whose target node
 *  is no longer `@`-referenced from the note. Without this, a deleted edge would keep appearing in
 *  every `ViewSpec`/search query compiled against `graph_edges` forever, even though the canonical
 *  KV `EdgesRepository` row (and therefore `listBacklinks`, which reads the KV index directly, not
 *  this read-model) had already forgotten it — the same "keep both tiers in sync at every mutation
 *  site" discipline every other `upsert*`/`replace*` helper in this file follows. */
export const deleteEdge = (sql: SqlStorage, edgeId: string): Effect.Effect<void, UnexpectedError> =>
  Effect.try({
    try: () => void sql.exec(`DELETE FROM rm_edges WHERE id = ?`, edgeId),
    catch: toReadModelError("deleteEdge")
  })

export const upsertGraphIssue = (
  sql: SqlStorage,
  issue: {
    readonly id: string
    readonly kind: string
    readonly relationDefinitionId: string
    readonly nodeId: string
    readonly conflictingEdgeIds: ReadonlyArray<string>
    readonly createdAt: string
  }
): Effect.Effect<void, UnexpectedError> =>
  Effect.try({
    try: () =>
      void sql.exec(
        `INSERT OR REPLACE INTO rm_graph_issues
           (id, kind, relationDefinitionId, nodeId, conflictingEdgeIds, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        issue.id,
        issue.kind,
        issue.relationDefinitionId,
        issue.nodeId,
        JSON.stringify(issue.conflictingEdgeIds),
        issue.createdAt
      ),
    catch: toReadModelError("upsertGraphIssue")
  })

/** Re-indexes one node's full-text row (title + current page body, `""` if it has no page yet).
 *  Delete-then-insert rather than `UPDATE`: FTS5 doesn't track an application-chosen primary key
 *  the way an ordinary table would (only an implicit `rowid`), so "does a row for this nodeId
 *  already exist" isn't cheap to check — delete-then-insert is simple and correct regardless,
 *  at the cost of an unindexed `nodeId` scan on delete (fine at Phase 1's per-workspace scale). */
export const indexNodeText = (
  sql: SqlStorage,
  nodeId: string,
  title: string,
  body: string
): Effect.Effect<void, UnexpectedError> =>
  Effect.try({
    try: () => {
      sql.exec(`DELETE FROM graph_text_search WHERE nodeId = ?`, nodeId)
      sql.exec(`INSERT INTO graph_text_search (nodeId, title, body) VALUES (?, ?, ?)`, nodeId, title, body)
    },
    catch: toReadModelError("indexNodeText")
  })

// ================================================================================================
// ViewSpec → SQL compiler (task item 2).

/** Every column a `ViewSpec` may reference on each fixed view (`graph_text_search` excluded —
 *  see `compileRunView`'s doc comment for why it's not part of the general compiler at all). This
 *  is the allowlist half of the "query-shape allowlist" app-layer authorizer substitute described
 *  in this module's header comment: any `column`/`groupBy`/`sortColumn`/`visibleColumns` entry
 *  not in the relevant list here is rejected before any SQL is built. */
const VIEW_COLUMNS: { readonly [K in Exclude<GraphViewName, "graph_text_search">]: ReadonlyArray<string> } = {
  graph_nodes: ["id", "workspaceId", "title", "createdAt"],
  graph_tags: ["id", "name", "builtin"],
  graph_tag_parents: ["tagId", "parentId"],
  graph_tag_closure: ["ancestorId", "descendantId"],
  graph_node_tags: ["nodeId", "tagId"],
  graph_facts: ["id", "nodeId", "predicateId", "value"],
  graph_relation_definitions: [
    "id",
    "forwardName",
    "inverseName",
    "sourceTagId",
    "targetTagId",
    "cardinality"
  ],
  graph_edges: ["id", "relationDefinitionId", "sourceNodeId", "targetNodeId"],
  graph_issues: ["id", "kind", "relationDefinitionId", "nodeId", "conflictingEdgeIds", "createdAt"]
}

/**
 * The subset of each view's own `VIEW_COLUMNS` whose *value* is itself a node id — i.e. every
 * column `compileRunView` must run through `CalendarService#hiddenCalendarDerivedNodeIds`'s
 * exclusion set before a row reaches an RPC caller (adversarial-review fix: `views-service-
 * live.ts`'s `runView`/`searchNodes` used to have zero awareness of that gate at all, so a viewer
 * correctly excluded from `listNodes`/`getNode`/`listCalendarEvents` could still see a hidden
 * calendar-derived node's raw id via `runView("graph_node_tags", ...)` — see this repo's Phase 5
 * adversarial-review notes for the live probe that demonstrated it). Deliberately a closed,
 * hand-maintained allowlist (same discipline as `VIEW_COLUMNS` itself) rather than a heuristic
 * ("any column whose name contains 'nodeId'") — a view with no node-id-bearing column at all
 * (`graph_tags`, `graph_tag_parents`, `graph_tag_closure`, `graph_relation_definitions`) simply
 * has no entry here and is correctly never filtered. `graph_edges` names TWO node-id columns
 * (an edge's source AND target) — a row is hidden if EITHER end is a hidden node, since a
 * relationship naming an excluded node leaks that node's existence/connectivity either way.
 */
const NODE_ID_COLUMNS: { readonly [K in Exclude<GraphViewName, "graph_text_search">]?: ReadonlyArray<string> } = {
  graph_nodes: ["id"],
  graph_node_tags: ["nodeId"],
  graph_facts: ["nodeId"],
  graph_edges: ["sourceNodeId", "targetNodeId"],
  graph_issues: ["nodeId"]
}

/** Hard clamp applied to every compiled query's `LIMIT`, regardless of what `ViewSpec.rowLimit`
 *  asks for (bounded-execution task item 3, guarantee (2) in this module's header comment). */
export const MAX_ROW_LIMIT = 500
const MAX_PREDICATE_NODES = 64
const MAX_PREDICATE_DEPTH = 8
const SLOW_QUERY_WARN_MS = 200
const MAX_ROWS_READ_WARN = 50_000

export interface CompiledQuery {
  readonly sql: string
  readonly params: ReadonlyArray<SqlStorageValue>
  /** Row-key aliases (see `NODE_ID_COLUMNS`) whose value is a node id this query's rows are
   *  "about" — `filterAndStripHiddenNodeRows` (below) excludes any row where one of these holds a
   *  node id in the caller's `CalendarService#hiddenCalendarDerivedNodeIds` set, uniformly across
   *  every view, independent of whether `ViewSpec.visibleColumns` happened to request that
   *  column. Empty for a view with no node-id-bearing column at all. */
  readonly nodeIdAliases: ReadonlyArray<string>
  /** The subset of `nodeIdAliases` that exist ONLY to make that filter possible — i.e. were NOT
   *  already one of `visibleColumns` — and so must be stripped from every surviving row before
   *  it's returned to the RPC caller, so a caller who never asked for a node-id column never
   *  receives one as a side effect of this filter's own implementation. */
  readonly internalOnlyAliases: ReadonlyArray<string>
}

/** A JSON-safe `ViewPredicate` leaf `value` becomes one bound SQL parameter, JSON-encoded the
 *  same way `upsertFact` encodes `graph_facts.value` — the two must agree byte-for-byte for `eq`/
 *  `in` comparisons against fact values to actually match stored rows. Valid ONLY for `field.kind
 *  === "fact"` — see `paramForFieldValue` below for why a plain `column` comparison must NOT go
 *  through this encoding. */
const jsonParam = (value: unknown): SqlStorageValue => JSON.stringify(value)

/**
 * Supertag-centering pass — adversarial-review fix: `compilePredicate`'s `eq`/`in` cases used to
 * call `jsonParam` unconditionally for every `FieldRef`, including `{kind: "column", ...}`. That
 * is correct ONLY for `{kind: "fact", ...}` (`graph_facts.value` really is stored
 * `JSON.stringify`-encoded — `upsertFact`'s own `JSON.stringify(fact.value)` call, and
 * `jsonParam`'s own doc comment above says so explicitly). Every plain `column` (`nodeId`,
 * `tagId`, `id`, `title`, ...) is stored as its raw value (`upsertNodeTag`/`upsertNode`/etc. all
 * bind the plain string/number directly, never through `JSON.stringify`) — so
 * `field: {kind:"column", column:"nodeId"}, value: "<uuid>"` was compiling to `v.nodeId =
 * '"<uuid>"'` (a JSON-quoted string), which can never equal the raw, unquoted TEXT column value.
 * Silent zero-rows, not a thrown error — found for real during this pass's own browser
 * verification (`NoteTags.tsx`'s `graph_node_tags` filter and `SupertagFieldPopover.tsx`'s
 * `graph_facts` filter, both filtering by the `column` `nodeId` per decisions doc §1's own named
 * read pattern, both returned `[]` against a row proven to exist by direct SQLite inspection).
 * `eq`/`in` against a `column` field had **no prior test coverage anywhere in this codebase**
 * (confirmed by grep before this fix) — `GraphView.tsx`'s own pre-existing filter use is `hasTag`
 * only, a different `ViewPredicate` op compiled by entirely separate code below, not through
 * `jsonParam` at all.
 */
const paramForFieldValue = (
  field: { readonly kind: "column"; readonly column: string } | { readonly kind: "fact"; readonly predicateId: string },
  value: unknown
): SqlStorageValue => {
  if (field.kind === "fact") return jsonParam(value)
  // Raw column comparison: bind the scalar directly, matching every `upsert*` writer's own
  // encoding for that column. Booleans become 0/1 (`upsertTag`'s own `tag.builtin ? 1 : 0`
  // convention); an array/object value has no raw-column representation a real column could ever
  // hold, so it falls back to `jsonParam` — no worse than the prior always-`jsonParam` behavior
  // for that (already-nonsensical) case, and never the common path this fix targets.
  if (value === null || typeof value === "string" || typeof value === "number") return value
  if (typeof value === "boolean") return value ? 1 : 0
  return jsonParam(value)
}

interface Fragment {
  readonly sql: string
  readonly params: ReadonlyArray<SqlStorageValue>
}

/** Compiles one `FieldRef` (view-spec.ts) to a SQL expression fragment, valid only in a `WHERE`
 *  position against the base view aliased `v` (see `compileRunView`). `column` refs are checked
 *  against `columns`; `fact` refs compile to a correlated scalar subquery against the
 *  `graph_facts` view and are only meaningful (and only permitted) when the outer query targets
 *  `graph_nodes`, where `v.id` is a real node id `graph_facts.nodeId` can join against. */
const compileFieldRef = (
  field: { readonly kind: "column"; readonly column: string } | { readonly kind: "fact"; readonly predicateId: string },
  viewName: GraphViewName,
  columns: ReadonlySet<string>
): Effect.Effect<Fragment, ValidationError> => {
  if (field.kind === "column") {
    if (!columns.has(field.column)) {
      return Effect.fail(
        new ValidationError({ message: `ViewSpec filter references unknown column '${field.column}' on view ${viewName}` })
      )
    }
    return Effect.succeed({ sql: `v.${field.column}`, params: [] })
  }
  if (viewName !== "graph_nodes") {
    return Effect.fail(
      new ValidationError({
        message: `ViewSpec filter's fact field reference ('${field.predicateId}') is only valid against graph_nodes (got ${viewName})`
      })
    )
  }
  return Effect.succeed({
    sql: `(SELECT gf.value FROM graph_facts gf WHERE gf.nodeId = v.id AND gf.predicateId = ?)`,
    params: [field.predicateId]
  })
}

/** Recursively compiles one `ViewPredicate` node (view-spec.ts) into a boolean SQL expression
 *  fragment, enforcing the predicate-tree size/depth caps (guarantee (3) in this module's header
 *  comment) as it walks. `counter` is a shared mutable box across the whole recursive walk
 *  (not per-branch) so the cap is on the *total* tree size, not any one branch's size. */
const compilePredicate = (
  predicate: ViewPredicate,
  viewName: GraphViewName,
  columns: ReadonlySet<string>,
  depth: number,
  counter: { count: number }
): Effect.Effect<Fragment, ValidationError> =>
  Effect.gen(function* () {
    counter.count += 1
    if (counter.count > MAX_PREDICATE_NODES) {
      return yield* Effect.fail(
        new ValidationError({ message: `ViewSpec filter exceeds the maximum predicate node count (${MAX_PREDICATE_NODES})` })
      )
    }
    if (depth > MAX_PREDICATE_DEPTH) {
      return yield* Effect.fail(
        new ValidationError({ message: `ViewSpec filter exceeds the maximum nesting depth (${MAX_PREDICATE_DEPTH})` })
      )
    }

    switch (predicate.op) {
      case "eq": {
        const field = yield* compileFieldRef(predicate.field, viewName, columns)
        return { sql: `${field.sql} = ?`, params: [...field.params, paramForFieldValue(predicate.field, predicate.value)] }
      }
      case "in": {
        if (predicate.values.length === 0) {
          // An empty IN-list can never match anything; compile to a literal false rather than
          // emitting invalid `IN ()` SQL.
          return { sql: "0", params: [] }
        }
        const field = yield* compileFieldRef(predicate.field, viewName, columns)
        const placeholders = predicate.values.map(() => "?").join(", ")
        return {
          sql: `${field.sql} IN (${placeholders})`,
          params: [...field.params, ...predicate.values.map((v) => paramForFieldValue(predicate.field, v))]
        }
      }
      case "hasTag": {
        if (viewName !== "graph_nodes") {
          return yield* Effect.fail(
            new ValidationError({ message: `hasTag predicates are only valid against graph_nodes (got ${viewName})` })
          )
        }
        // "Does this node carry tagId, directly or via an ancestor tag" — a set-membership test
        // against the *closure* (view-spec.ts's own doc comment), joined through the real
        // node→tag membership relation this stage adds (`graph_node_tags`).
        return {
          sql:
            `v.id IN (SELECT nt.nodeId FROM graph_node_tags nt ` +
            `JOIN graph_tag_closure tc ON tc.descendantId = nt.tagId WHERE tc.ancestorId = ?)`,
          params: [predicate.tagId]
        }
      }
      case "and":
      case "or": {
        if (predicate.predicates.length === 0) {
          // Vacuous and/or: "and" of nothing is true, "or" of nothing is false.
          return { sql: predicate.op === "and" ? "1" : "0", params: [] }
        }
        const compiled = yield* Effect.forEach(predicate.predicates, (child) =>
          compilePredicate(child, viewName, columns, depth + 1, counter)
        )
        const joiner = predicate.op === "and" ? " AND " : " OR "
        return {
          sql: `(${compiled.map((c) => c.sql).join(joiner)})`,
          params: compiled.flatMap((c) => c.params)
        }
      }
    }
  })

interface ResolvedRef {
  readonly expr: string
  readonly join?: string
  readonly joinParams: ReadonlyArray<SqlStorageValue>
}

/** Resolves a bare `groupBy`/`sortColumn` string (view-spec.ts's `ViewSpec` — plain strings, not
 *  `FieldRef`s) to a SQL expression. Resolution order: a real allowlisted column on `viewName`
 *  first; otherwise, **only when `viewName` is `graph_nodes`**, fall back to treating the name as
 *  a `Fact.predicateId` and resolve it via a `LEFT JOIN` against `graph_facts` — the same
 *  convention `view-spec.test.ts`'s own round-trip fixture already exercises unprefixed
 *  (`groupBy: "status"`, not `"fact:status"`): a bare name that isn't a real column is assumed to
 *  name a fact, with no special syntax required. `joinAlias` must be unique per call site
 *  (`compileRunView` uses `"gb"`/`"so"`) so a query needing both a group-by fact and a
 *  differently-named sort fact gets two independent joins, not a clash. */
const resolveNamedRef = (
  name: string,
  viewName: GraphViewName,
  columns: ReadonlySet<string>,
  joinAlias: string
): Effect.Effect<ResolvedRef, ValidationError> => {
  if (columns.has(name)) {
    return Effect.succeed({ expr: `v.${name}`, joinParams: [] })
  }
  if (viewName === "graph_nodes") {
    return Effect.succeed({
      expr: `${joinAlias}.value`,
      join: `LEFT JOIN graph_facts ${joinAlias} ON ${joinAlias}.nodeId = v.id AND ${joinAlias}.predicateId = ?`,
      joinParams: [name]
    })
  }
  return Effect.fail(new ValidationError({ message: `Unknown column '${name}' on view ${viewName}` }))
}

/**
 * Compiles a `{viewName, viewSpec}` pair (`RunViewInput`, graph-rpc.ts) into one parameterized,
 * read-only, single-statement, bounded SQL query. Never touches `sql.exec` itself — pure
 * compilation, so it can be unit-tested (and its rejections asserted on) without a real DO.
 *
 * `graph_text_search` is rejected outright: FTS5's `MATCH` query syntax (a small query language
 * of its own — phrase/prefix/column-filter/boolean operators) doesn't fit the `eq`/`in`/`hasTag`
 * grammar `ViewPredicate` models, and bolting a `MATCH`-shaped escape hatch onto this compiler
 * would reopen exactly the "arbitrary SQL text from the caller" hole the rest of this module is
 * built to close. Full-text search has its own dedicated, narrower RPC (`searchNodes`,
 * `search-rpc.ts`) instead — see this file's header comment and `search-rpc.ts`'s doc comment.
 */
export const compileRunView = (
  viewName: GraphViewName,
  spec: ViewSpec
): Effect.Effect<CompiledQuery, ValidationError> =>
  Effect.gen(function* () {
    if (viewName === "graph_text_search") {
      return yield* Effect.fail(
        new ValidationError({ message: "graph_text_search is queried via searchNodes, not runView" })
      )
    }

    const columns = new Set(VIEW_COLUMNS[viewName])

    if (spec.visibleColumns.length === 0) {
      return yield* Effect.fail(new ValidationError({ message: "visibleColumns must name at least one column" }))
    }
    for (const column of spec.visibleColumns) {
      if (!columns.has(column)) {
        return yield* Effect.fail(
          new ValidationError({ message: `visibleColumns references unknown column '${column}' on view ${viewName}` })
        )
      }
    }

    const joins: Array<string> = []
    const joinParams: Array<SqlStorageValue> = []
    const selectParts = spec.visibleColumns.map((column) => `v.${column} AS ${column}`)

    // Adversarial-review fix: always select every node-id-bearing column this view has
    // (`NODE_ID_COLUMNS`), REGARDLESS of `visibleColumns` — reusing the real alias when the
    // caller already requested that column, else adding an internal-only alias — so
    // `filterAndStripHiddenNodeRows` can enforce `CalendarService#hiddenCalendarDerivedNodeIds`
    // uniformly on every `runView` call, not only the ones that happen to ask for a node-id
    // column. `columnName`/`viewName` are both from the closed `VIEW_COLUMNS`/`GraphViewName`
    // allowlists (never caller text), so interpolating them into SQL here is exactly as safe as
    // every other identifier this compiler already emits.
    const nodeIdAliases: Array<string> = []
    const internalOnlyAliases: Array<string> = []
    const visibleColumnSet = new Set(spec.visibleColumns)
    for (const [index, columnName] of (NODE_ID_COLUMNS[viewName] ?? []).entries()) {
      if (visibleColumnSet.has(columnName)) {
        nodeIdAliases.push(columnName)
        continue
      }
      const alias = `__nid_${index}`
      selectParts.push(`v.${columnName} AS ${alias}`)
      nodeIdAliases.push(alias)
      internalOnlyAliases.push(alias)
    }

    let groupByExpr: string | undefined
    if (spec.groupBy !== undefined) {
      const resolved = yield* resolveNamedRef(spec.groupBy, viewName, columns, "gb")
      if (resolved.join !== undefined) {
        joins.push(resolved.join)
        joinParams.push(...resolved.joinParams)
      }
      groupByExpr = resolved.expr
      // "Board" rendering annotates every row with its group value rather than collapsing rows
      // with a literal SQL `GROUP BY` — a board still shows one row (card) per node, per column;
      // grouping/bucketing by `groupValue` is the client's job, this just makes the value
      // available. See this function's own doc comment / the backend Views-stage report for the
      // full reasoning.
      selectParts.push(`${resolved.expr} AS groupValue`)
    }

    let orderExpr: string | undefined
    if (spec.sortColumn !== undefined) {
      if (spec.sortColumn === spec.groupBy && groupByExpr !== undefined) {
        orderExpr = groupByExpr
      } else {
        const resolved = yield* resolveNamedRef(spec.sortColumn, viewName, columns, "so")
        if (resolved.join !== undefined) {
          joins.push(resolved.join)
          joinParams.push(...resolved.joinParams)
        }
        orderExpr = resolved.expr
      }
    }

    let whereSql = ""
    let whereParams: ReadonlyArray<SqlStorageValue> = []
    if (spec.filter !== undefined) {
      const compiled = yield* compilePredicate(spec.filter, viewName, columns, 0, { count: 0 })
      whereSql = ` WHERE ${compiled.sql}`
      whereParams = compiled.params
    }

    const rowLimit = Math.min(spec.rowLimit, MAX_ROW_LIMIT)

    const sql =
      `SELECT ${selectParts.join(", ")} FROM ${viewName} AS v` +
      joins.map((join) => ` ${join}`).join("") +
      whereSql +
      (orderExpr !== undefined ? ` ORDER BY ${orderExpr} ${spec.sortDescending === true ? "DESC" : "ASC"}` : "") +
      ` LIMIT ?`

    return { sql, params: [...joinParams, ...whereParams, rowLimit], nodeIdAliases, internalOnlyAliases }
  })

/**
 * Enforces `CalendarService#hiddenCalendarDerivedNodeIds` against a `runCompiledQuery` result —
 * the read-model-layer half of the adversarial-review fix (`views-service-live.ts`'s own doc
 * comment has the full story). Excludes any row where ONE OR MORE of `compiled.nodeIdAliases`
 * holds a node id in `hiddenNodeIds` (an edge row is hidden if EITHER its source or target is
 * hidden — see `NODE_ID_COLUMNS`'s own doc comment), then strips `compiled.internalOnlyAliases`
 * from every surviving row so a caller who never requested a node-id column never receives one.
 * A no-op (identity function on `rows`) whenever the view has no node-id column at all
 * (`nodeIdAliases.length === 0`) — e.g. `graph_tags`/`graph_relation_definitions`, which have
 * nothing calendar-derived-node-shaped to hide in the first place.
 */
export const filterAndStripHiddenNodeRows = (
  rows: ReadonlyArray<Record<string, SqlStorageValue>>,
  compiled: CompiledQuery,
  hiddenNodeIds: ReadonlySet<string>
): ReadonlyArray<Record<string, SqlStorageValue>> => {
  const stripInternal = (row: Record<string, SqlStorageValue>): Record<string, SqlStorageValue> => {
    if (compiled.internalOnlyAliases.length === 0) return row
    const stripped = { ...row }
    for (const alias of compiled.internalOnlyAliases) delete stripped[alias]
    return stripped
  }
  if (compiled.nodeIdAliases.length === 0 || hiddenNodeIds.size === 0) {
    return rows.map(stripInternal)
  }
  const kept: Array<Record<string, SqlStorageValue>> = []
  for (const row of rows) {
    const isHidden = compiled.nodeIdAliases.some((alias) => {
      const value = row[alias]
      return typeof value === "string" && hiddenNodeIds.has(value)
    })
    if (isHidden) continue
    kept.push(stripInternal(row))
  }
  return kept
}

/** Executes a `compileRunView`-produced query against real DO SQLite and returns its rows as
 *  plain objects. See this module's header comment (guarantee (4)) for why the timing/row-count
 *  checks here are post-hoc logging, not a preemptive timeout. */
export const runCompiledQuery = (
  sql: SqlStorage,
  compiled: CompiledQuery
): Effect.Effect<ReadonlyArray<Record<string, SqlStorageValue>>, UnexpectedError> =>
  Effect.try({
    try: () => {
      const startedAt = Date.now()
      const cursor = sql.exec(compiled.sql, ...compiled.params)
      const rows = cursor.toArray()
      const elapsedMs = Date.now() - startedAt
      if (cursor.rowsRead > MAX_ROWS_READ_WARN) {
        console.warn(`[views] query scanned ${cursor.rowsRead} rows (> ${MAX_ROWS_READ_WARN}): ${compiled.sql}`)
      }
      if (elapsedMs > SLOW_QUERY_WARN_MS) {
        console.warn(`[views] slow query (${elapsedMs}ms): ${compiled.sql}`)
      }
      return rows
    },
    catch: toReadModelError("runCompiledQuery")
  })

// ================================================================================================
// Full-text search (task item 5) — `graph_text_search` MATCH queries. Separate from
// `compileRunView` on purpose (see that function's doc comment).

export const MAX_SEARCH_RESULTS = 200

/** Turns a free-text query into an FTS5 query expression that only ever performs *prefix phrase*
 *  matching on each whitespace-separated token (`"word"*`), never passing the caller's raw text
 *  through as FTS5 query syntax. This is a safety measure, not just a formatting choice: FTS5
 *  `MATCH` strings are themselves a small query language (boolean `AND`/`OR`/`NOT`, column
 *  filters like `title:`, unbalanced-quote errors), so binding a caller's raw string as the
 *  `MATCH` parameter would let search input accidentally (or deliberately) change query
 *  *structure*, not just filter content — the same class of concern `compileRunView`'s
 *  parameterization discipline exists for. Quoting each token as an escaped phrase neutralizes
 *  all of that while still matching the task's own bar ("a known substring/term"): a `*` suffix
 *  on a quoted phrase is FTS5's documented prefix-query syntax, so a token still matches as a
 *  prefix of a longer indexed word, not only a whole-word exact match. */
const toFtsQuery = (raw: string): Effect.Effect<string, ValidationError> => {
  const tokens = raw.trim().split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length === 0) {
    return Effect.fail(new ValidationError({ message: "search query must contain at least one term" }))
  }
  return Effect.succeed(tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" "))
}

export interface SearchRow {
  readonly nodeId: string
  readonly title: string
  readonly body: string
}

export const searchNodesReadModel = (
  sql: SqlStorage,
  query: string,
  limit: number
): Effect.Effect<ReadonlyArray<SearchRow>, ValidationError | UnexpectedError> =>
  Effect.gen(function* () {
    const ftsQuery = yield* toFtsQuery(query)
    const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_SEARCH_RESULTS)
    return yield* Effect.try({
      try: () =>
        sql
          .exec<{ nodeId: string; title: string; body: string }>(
            `SELECT nodeId, title, body FROM graph_text_search WHERE graph_text_search MATCH ? ORDER BY rank LIMIT ?`,
            ftsQuery,
            boundedLimit
          )
          .toArray(),
      catch: toReadModelError("searchNodesReadModel")
    })
  })
