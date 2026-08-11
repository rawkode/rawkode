// @enchiridion/worker-vault — typed, batched supertag accessor methods.
//
// Plan §Backend architecture, "Query surfaces — two, not one" (#2) — same
// family as `query-accessors.ts`'s `getPage`/`getPages`/`listPages`, just
// generalized from `Page`'s fixed 6 columns to every supertag's arbitrary
// effective field set. This is the CONCRETE, real-SQL implementation of
// `@enchiridion/graphql-composer`'s `SupertagAccessors` CONTRACT
// (`packages/graphql-composer/src/accessors.ts`) — read that file's header
// first; every doc comment below cross-references it rather than
// restating it.
//
// Every function here is real, purpose-built, batched SQL against
// `graph_nodes`/`graph_node_tags`/`graph_facts`/`_graph_edges` (now
// populated for real by `projection.ts`'s P1 wiring) — never one RPC per
// field (plan Risk #11), and never routed through `query-rpc.ts`'s bounded
// free-form SQL validator, matching `query-accessors.ts`'s existing style
// exactly (see that file's header for why this is a deliberately separate,
// narrower surface).
//
// `vault-do.ts` exposes each of these as its own RPC method
// (`getNodeWithFacts`/`getNodesWithFacts`/`listNodesByTag`/
// `getRelationTargets`/`getRelationSources`); `graphql/composed-schema.ts`
// adapts those RPC methods to the `SupertagAccessors` shape
// `@enchiridion/graphql-composer`'s generated resolvers are written
// against — the same adapter-in-yoga.ts pattern `query-accessors.ts`'s
// header describes for `VaultAccessors`/`Page`.
//
// PRIVACY-GATE FILTERING BOUNDARY (adversarial review finding, plan
// §Gadgets P4: "graph.query ... must itself be personVisibility-aware,
// since the P2 privacy classification for calendar-attendee Person pages
// lives only at the materialization layer and has no enforcement at the
// query layer this capability reads through").
//
// `getNodeWithFacts`/`getNodesWithFacts`/`listNodesByTag` below now accept
// an OPTIONAL `SupertagAccessorFilterOptions.excludePersonVisibility` —
// when a caller passes it, any node whose `graph_nodes.person_visibility`
// value is in that list is excluded entirely (treated exactly like a
// deleted/nonexistent node — absent from the result, never surfaced as a
// stub/redacted record). DEFAULT (option omitted) is UNCHANGED behavior:
// every node is returned regardless of its classification.
//
// WHY OPT-IN, NOT A BLANKET FILTER, AND WHY HERE (not `query-accessors.ts`
// or a filter inside VaultDO's storage layer itself): these exact three
// functions back BOTH of two very different callers —
//   1. `workers/vault/src/graphql/yoga.ts`'s `context()` — the TRUSTED
//      device/native-app GraphQL read path, behind Cloudflare Access. A
//      user's own app legitimately needs to keep seeing `"other"`-
//      visibility attendees (e.g. to render "you have a meeting with
//      jane@example.com" in the calendar UI) — that's the whole point of
//      materializing them as pages at all, just not broadly/by default to
//      OTHER surfaces. `yoga.ts` calls these with no options argument, so
//      it is completely unaffected by this change — see this file's own
//      tests for the explicit "same call without the option still returns
//      the page" proof.
//   2. `workers/gadget-host/src/graph-query-views.ts` — untrusted,
//      AI-written gadget code, which the plan explicitly calls out as the
//      surface that must be visibility-aware. That file now passes
//      `excludePersonVisibility: ["other"]` on the three views these
//      functions back (`nodeWithFacts`/`nodesWithFacts`/`nodesByTag`).
// A blanket filter (e.g. inside `hydrateNodes` unconditionally, or a
// second private query path) would either break case 1 (hiding attendees
// from the user's own app, which is not what "excluded from broad
// visibility by default" means — the owning user always sees their own
// calendar) or require a second, parallel set of accessor functions for
// case 2, doubling the SQL surface for no real gain over one function with
// an optional, default-off parameter. `query-accessors.ts` (`getPage`/
// `getPages`/`listPages`) is a separate, generic Page-shaped surface not
// modified by this pass — see this task's report for that residual scope
// boundary.

import { propertyKeyToString } from "@enchiridion/schema";
import type { SupertagListOptions, SupertagListResult, SupertagNodeRecord } from "@enchiridion/graphql-composer";
import type { SqlExecutor } from "./schema";
import { supertagRegistry } from "./supertag-registry";

// --- graph_nodes -----------------------------------------------------------

interface NodeRow {
  node_id: string;
  created_at: number;
  modified_at: number;
  deleted_at: number | null;
  person_visibility: string | null;
  [key: string]: unknown;
}

const NODE_COLUMNS = "node_id, created_at, modified_at, deleted_at, person_visibility";

/** Optional accessor-level privacy-gate filter — see this file's header
 *  addendum ("PRIVACY-GATE FILTERING BOUNDARY") for the full rationale on
 *  why this is opt-in (default: no filtering) rather than a blanket
 *  exclusion. */
export interface SupertagAccessorFilterOptions {
  /** When given (and non-empty), a node whose `graph_nodes.person_visibility`
   *  value is IN this list is excluded from the result — as if it didn't
   *  exist, matching every other accessor here's "absence means empty/not
   *  found" convention (a deleted or unknown id). A node with a `NULL`
   *  `person_visibility` (the normal case — not a materialized Person
   *  page at all) is never excluded by this option, regardless of its
   *  contents. Omitted/`undefined` (the default on every existing call
   *  site) applies no filtering whatsoever. */
  excludePersonVisibility?: readonly string[];
}

/** Appends a `graph_nodes.person_visibility NOT IN (...)`-shaped exclusion
 *  clause (`NULL`-safe: `NULL` never matches an `IN` list in SQL, so this
 *  spells that out explicitly rather than relying on that behavior
 *  implicitly) to `conditions`/`args` in place — shared by `hydrateNodes`
 *  (id-list lookups) and `listNodesByTag` (its own paginated id-selection
 *  query, which needs the SAME exclusion applied BEFORE its `LIMIT` so
 *  `hasMore`/cursor pagination stays correct — filtering only the already
 *  page-sized result would silently under-fill a page). `columnRef` lets
 *  the caller supply a table alias (`listNodesByTag` queries `graph_nodes`
 *  as `n`). */
function appendPersonVisibilityExclusion(
  conditions: string[],
  args: unknown[],
  excludePersonVisibility: readonly string[] | undefined,
  columnRef: string,
): void {
  if (!excludePersonVisibility || excludePersonVisibility.length === 0) return;
  const placeholders = excludePersonVisibility.map(() => "?").join(", ");
  conditions.push(`(${columnRef} IS NULL OR ${columnRef} NOT IN (${placeholders}))`);
  args.push(...excludePersonVisibility);
}

// --- graph_node_tags (direct only — see SupertagNodeRecord.tagIDs's doc
// comment in accessors.ts: "NOT the effective/closure set") --------------

interface TagRow {
  node_id: string;
  tag_id: string;
  [key: string]: unknown;
}

function readDirectTagIDsByNode(sql: SqlExecutor, nodeIDs: readonly string[]): Map<string, string[]> {
  const byNode = new Map<string, string[]>();
  if (nodeIDs.length === 0) return byNode;
  const placeholders = nodeIDs.map(() => "?").join(", ");
  const rows = sql
    .exec<TagRow>(
      `SELECT node_id, tag_id FROM graph_node_tags WHERE direct = 1 AND node_id IN (${placeholders})`,
      ...nodeIDs,
    )
    .toArray();
  for (const row of rows) {
    const list = byNode.get(row.node_id);
    if (list) list.push(row.tag_id);
    else byNode.set(row.node_id, [row.tag_id]);
  }
  return byNode;
}

// --- graph_facts -> SupertagNodeRecord.facts --------------------------------

interface FactRow {
  node_id: string;
  tag_id: string;
  field_id: string;
  value_index: number;
  value_type: string;
  text_value: string | null;
  number_value: number | null;
  boolean_value: number | null;
  local_date_value: string | null;
  date_time_value: number | null;
  [key: string]: unknown;
}

const FACT_COLUMNS =
  "node_id, tag_id, field_id, value_index, value_type, text_value, number_value, boolean_value, local_date_value, date_time_value";

/** Maps one `graph_facts` row to its JS value, per accessors.ts's
 *  documented convention: text/url/email/phone/select -> string; number ->
 *  number; boolean -> boolean; date/dateTime -> epoch-ms number (`date`
 *  rows store `value_type = 'localDate'`, per `@enchiridion/projection`'s
 *  `facts.ts`, as an ISO date-only string — parsed here to epoch ms so
 *  `date` and `dateTime` fields share one JS representation, matching
 *  `graphql-composer`'s own `date`/`dateTime` -> `Float` mapping). Returns
 *  `undefined` for a row whose typed column doesn't actually hold a value
 *  (shouldn't happen for a well-formed row — defensive, not silently
 *  wrong). */
function factJsValue(row: FactRow): unknown {
  switch (row.value_type) {
    case "text":
    case "select":
    case "url":
    case "email":
    case "phone":
      return row.text_value ?? undefined;
    case "number":
      return row.number_value ?? undefined;
    case "boolean":
      return row.boolean_value === null ? undefined : row.boolean_value !== 0;
    case "localDate": {
      if (!row.local_date_value) return undefined;
      const parsed = Date.parse(row.local_date_value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case "dateTime":
      return row.date_time_value ?? undefined;
    default:
      return undefined;
  }
}

/** Whether the field a `graph_facts` row belongs to is declared
 *  `allowsMultiple` — looked up on the OWNING supertag (`row.tag_id`,
 *  which is always the schema that declared the field, per
 *  `@enchiridion/projection`'s `facts.ts` header: "the schema that
 *  DECLARED a field ... stays the same across inheritance"), never the
 *  queried subtype. Missing supertag/field (a fact whose declaring field
 *  was removed from the registry since it was written) defaults to
 *  singular — matches `SupertagNodeRecord.facts`'s doc comment that a key
 *  simply absent means "no value set", never an error; a value that DOES
 *  exist for an unknown field is still surfaced (better to show slightly
 *  stale data than silently drop it), just not as a list. */
function fieldAllowsMultiple(tagID: string, fieldID: string): boolean {
  return supertagRegistry.getSupertag(tagID)?.fields?.[fieldID]?.allowsMultiple === true;
}

function readFactsByNode(sql: SqlExecutor, nodeIDs: readonly string[]): Map<string, Record<string, unknown>> {
  const byNode = new Map<string, Record<string, unknown>>();
  if (nodeIDs.length === 0) return byNode;
  const placeholders = nodeIDs.map(() => "?").join(", ");
  const rows = sql
    .exec<FactRow>(`SELECT ${FACT_COLUMNS} FROM graph_facts WHERE node_id IN (${placeholders})`, ...nodeIDs)
    .toArray();

  interface Group {
    tagID: string;
    fieldID: string;
    values: { value: unknown; valueIndex: number }[];
  }
  const groupsByNode = new Map<string, Map<string, Group>>();

  for (const row of rows) {
    const value = factJsValue(row);
    if (value === undefined) continue;
    const key = propertyKeyToString({ supertagID: row.tag_id, fieldID: row.field_id });
    let nodeGroups = groupsByNode.get(row.node_id);
    if (!nodeGroups) {
      nodeGroups = new Map();
      groupsByNode.set(row.node_id, nodeGroups);
    }
    let group = nodeGroups.get(key);
    if (!group) {
      group = { tagID: row.tag_id, fieldID: row.field_id, values: [] };
      nodeGroups.set(key, group);
    }
    group.values.push({ value, valueIndex: row.value_index });
  }

  for (const [nodeID, nodeGroups] of groupsByNode) {
    const facts: Record<string, unknown> = {};
    for (const [key, group] of nodeGroups) {
      group.values.sort((a, b) => a.valueIndex - b.valueIndex);
      facts[key] = fieldAllowsMultiple(group.tagID, group.fieldID)
        ? group.values.map((v) => v.value)
        : group.values[0]?.value;
    }
    byNode.set(nodeID, facts);
  }
  return byNode;
}

/** Batched hydration: `graph_nodes` + direct tags + facts, joined into
 *  `SupertagNodeRecord`s, for every LIVE (non-deleted) node in `nodeIDs`.
 *  Shared by `getNodeWithFacts`/`getNodesWithFacts`/`listNodesByTag` so
 *  the tag/fact-joining logic exists exactly once. `options.
 *  excludePersonVisibility`, when given, excludes matching nodes from the
 *  result entirely — see `SupertagAccessorFilterOptions`'s doc comment. */
function hydrateNodes(
  sql: SqlExecutor,
  nodeIDs: readonly string[],
  options: SupertagAccessorFilterOptions = {},
): SupertagNodeRecord[] {
  if (nodeIDs.length === 0) return [];
  const placeholders = nodeIDs.map(() => "?").join(", ");
  const conditions = ["deleted_at IS NULL", `node_id IN (${placeholders})`];
  const args: unknown[] = [...nodeIDs];
  appendPersonVisibilityExclusion(conditions, args, options.excludePersonVisibility, "person_visibility");
  const nodeRows = sql
    .exec<NodeRow>(`SELECT ${NODE_COLUMNS} FROM graph_nodes WHERE ${conditions.join(" AND ")}`, ...args)
    .toArray();
  if (nodeRows.length === 0) return [];

  const liveIDs = nodeRows.map((r) => r.node_id);
  const tagsByNode = readDirectTagIDsByNode(sql, liveIDs);
  const factsByNode = readFactsByNode(sql, liveIDs);

  return nodeRows.map((row) => ({
    id: row.node_id,
    tagIDs: tagsByNode.get(row.node_id) ?? [],
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    deletedAt: row.deleted_at,
    facts: factsByNode.get(row.node_id) ?? {},
  }));
}

// --- SupertagAccessors methods ----------------------------------------------

/** Mirrors `getPage(id)` — see `accessors.ts`'s doc comment: "Root singular
 *  query fields ... call this directly." `options` is new (see
 *  `SupertagAccessorFilterOptions`) and optional — every EXISTING caller
 *  (the trusted device/native-app GraphQL read path, `graphql/yoga.ts`)
 *  keeps calling this with just `(sql, id)` and sees no behavior change. */
export function getNodeWithFacts(
  sql: SqlExecutor,
  id: string,
  options?: SupertagAccessorFilterOptions,
): SupertagNodeRecord | undefined {
  return hydrateNodes(sql, [id], options)[0];
}

/** Mirrors `getPages(ids)` — batched, one round trip. Unknown/deleted ids
 *  (and now, when `options.excludePersonVisibility` is given, matching
 *  ids) are simply absent from the result (not an error), matching
 *  `accessors.ts`'s documented contract. */
export function getNodesWithFacts(
  sql: SqlExecutor,
  ids: readonly string[],
  options?: SupertagAccessorFilterOptions,
): SupertagNodeRecord[] {
  return hydrateNodes(sql, ids, options);
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** Mirrors `listPages(options)`, filtered to nodes DIRECTLY carrying
 *  `tagID` (not the effective/closure set — a `Person` query should not
 *  return every `Company`/`Organization` just because `company` inherits
 *  `organization`'s fields; each supertag gets its own root query field in
 *  the composed schema). Cursor semantics match `query-accessors.ts`'s
 *  `listPages`: an opaque `node_id`-shaped keyset cursor.
 *
 *  `options.excludePersonVisibility` (see `SupertagAccessorFilterOptions`)
 *  is applied INSIDE the paginated id-selection query below, before
 *  `LIMIT` — not as a post-filter over an already-`LIMIT`ed page — so
 *  `hasMore`/`nextCursor` stay correct: a post-filter would silently
 *  return fewer than `limit` items on a page containing excluded nodes
 *  without telling the caller more pages remain. */
export function listNodesByTag(
  sql: SqlExecutor,
  tagID: string,
  options: SupertagListOptions & SupertagAccessorFilterOptions = {},
): SupertagListResult {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const conditions = ["t.tag_id = ?", "t.direct = 1", "n.deleted_at IS NULL"];
  const args: unknown[] = [tagID];
  if (options.cursor) {
    conditions.push("n.node_id > ?");
    args.push(options.cursor);
  }
  appendPersonVisibilityExclusion(conditions, args, options.excludePersonVisibility, "n.person_visibility");
  args.push(limit + 1);

  const rows = sql
    .exec<{ node_id: string }>(
      `SELECT n.node_id FROM graph_nodes n
       JOIN graph_node_tags t ON t.node_id = n.node_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY n.node_id
       LIMIT ?`,
      ...args,
    )
    .toArray();

  const hasMore = rows.length > limit;
  const pageIDs = (hasMore ? rows.slice(0, limit) : rows).map((r) => r.node_id);
  // No need to pass `options` through to `hydrateNodes` here — `pageIDs`
  // is already exclusion-filtered by the query above; re-filtering would
  // be a harmless no-op, not a correctness requirement.
  const items = hydrateNodes(sql, pageIDs);
  // Re-sort to match the id-keyset order the SQL query above already
  // produced — `hydrateNodes`'s own `IN (...)` lookups don't guarantee
  // result order matches `pageIDs`' order.
  const itemsByID = new Map(items.map((item) => [item.id, item] as const));
  const ordered = pageIDs.map((id) => itemsByID.get(id)).filter((item): item is SupertagNodeRecord => item !== undefined);

  return {
    items: ordered,
    nextCursor: hasMore ? (pageIDs[pageIDs.length - 1] ?? null) : null,
  };
}

// --- _graph_edges (forward-only storage) -> relation accessors -------------

interface EdgeEndpointRow {
  source_node_id: string;
  target_node_id: string;
  edge_id: string;
  [key: string]: unknown;
}

/** Mirrors `getRelationTargets(relationID, sourceNodeIDs)` — batched
 *  FORWARD canonical-edge resolution, straight off `_graph_edges` (the
 *  private, forward-only storage table — no VIEW involved, this accessor
 *  already knows the direction it wants). Ordered by `edge_id` for
 *  determinism; a source id with no outgoing edge for `relationID` is
 *  simply absent from the returned map, matching the documented "absence
 *  means empty, not error" convention. */
export function getRelationTargets(
  sql: SqlExecutor,
  relationID: string,
  sourceNodeIDs: readonly string[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (sourceNodeIDs.length === 0) return result;
  const placeholders = sourceNodeIDs.map(() => "?").join(", ");
  const rows = sql
    .exec<EdgeEndpointRow>(
      `SELECT source_node_id, target_node_id, edge_id FROM _graph_edges
       WHERE relation_id = ? AND source_node_id IN (${placeholders})
       ORDER BY edge_id`,
      relationID,
      ...sourceNodeIDs,
    )
    .toArray();
  for (const row of rows) {
    const list = result.get(row.source_node_id);
    if (list) list.push(row.target_node_id);
    else result.set(row.source_node_id, [row.target_node_id]);
  }
  return result;
}

/** Mirrors `getRelationSources(relationID, targetNodeIDs)` — the INVERSE
 *  of `getRelationTargets` above: for every `targetNodeID`, the source ids
 *  whose forward edge points at it. Still a single query against
 *  `_graph_edges` (grouped by `target_node_id` instead of
 *  `source_node_id`) — this is the query-time backlink projection the
 *  plan's "backlinks are projections, never materialized" rule describes,
 *  not a second stored/inverse row. */
export function getRelationSources(
  sql: SqlExecutor,
  relationID: string,
  targetNodeIDs: readonly string[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (targetNodeIDs.length === 0) return result;
  const placeholders = targetNodeIDs.map(() => "?").join(", ");
  const rows = sql
    .exec<EdgeEndpointRow>(
      `SELECT source_node_id, target_node_id, edge_id FROM _graph_edges
       WHERE relation_id = ? AND target_node_id IN (${placeholders})
       ORDER BY edge_id`,
      relationID,
      ...targetNodeIDs,
    )
    .toArray();
  for (const row of rows) {
    const list = result.get(row.target_node_id);
    if (list) list.push(row.source_node_id);
    else result.set(row.target_node_id, [row.source_node_id]);
  }
  return result;
}
