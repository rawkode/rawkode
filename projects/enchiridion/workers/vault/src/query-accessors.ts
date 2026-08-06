// @enchiridion/worker-vault — typed, batched accessor RPC methods.
//
// Plan §Backend architecture, "Query surfaces — two, not one" (a second
// adversarial review's finding): a single generic SQL RPC and GraphQL
// resolvers want different shapes, so this is deliberately a SEPARATE
// surface from `query-rpc.ts`'s bounded free-form SQL RPC — "Typed
// accessor RPC methods for GraphQL resolver use — getPage(id),
// listPagesByTag(tagId, cursor), and similar, batched per top-level
// GraphQL operation (a DataLoader-style single batched RPC call, not one
// `query()` call per field). This is what vault's Pothos resolvers
// actually call."
//
// Every function here is real, purpose-built SQL against `graph_nodes`
// (the only projection table with real population logic as of this P0
// pass — see `projection.ts`'s file header for why the rest of the
// public-view contract is DDL-only so far), not string-built SQL routed
// through `query-rpc.ts`'s validator — the whole point of this module is
// that these are typed and purpose-built, not general-purpose.
//
// `vault-do.ts` exposes each of these as its own RPC method
// (`getPage`/`getPages`/`listPages`); `src/graphql/schema.ts`'s Pothos
// resolvers call those RPC methods (via a `VaultAccessors` adapter in
// `src/graphql/yoga.ts`), never `vault.query()` — see that file's header
// for the full wiring.

import type { SqlExecutor } from "./schema";

/** What a GraphQL `Page` (and any other typed accessor caller) needs off
 *  `graph_nodes` — plan step 2's minimum: "id, kind, title, createdAt,
 *  modifiedAt, deletedAt/tombstone status". */
export interface PageAccessorRow {
  id: string;
  kind: string;
  title: string;
  createdAt: number;
  modifiedAt: number;
  deletedAt: number | null;
}

interface GraphNodeRow {
  node_id: string;
  kind: string;
  title: string;
  created_at: number;
  modified_at: number;
  deleted_at: number | null;
  [key: string]: unknown;
}

function toPageAccessorRow(row: GraphNodeRow): PageAccessorRow {
  return {
    id: row.node_id,
    kind: row.kind,
    title: row.title,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    deletedAt: row.deleted_at,
  };
}

const PAGE_COLUMNS = "node_id, kind, title, created_at, modified_at, deleted_at";

/** Single-page lookup. Returns `undefined` for an unknown OR
 *  tombstoned-and-purged page id — both look identical ("no row") today,
 *  since tombstoning a page purges its `graph_nodes` row outright rather
 *  than flagging it (see `vault-write-model.ts`'s `applyTombstoneChange`);
 *  `deletedAt` stays part of this row's shape for forward-compatibility
 *  with a future soft-delete variant, not because it's ever populated by
 *  the current tombstone path. */
export function getPage(sql: SqlExecutor, id: string): PageAccessorRow | undefined {
  const row = sql
    .exec<GraphNodeRow>(`SELECT ${PAGE_COLUMNS} FROM graph_nodes WHERE node_id = ?`, id)
    .toArray()[0];
  return row ? toPageAccessorRow(row) : undefined;
}

/** Batched multi-page lookup — one round trip for N ids. Plan Risk #11
 *  ("DO-RPC-per-field N+1"): "Build the typed accessor methods batched
 *  (one RPC per top-level GraphQL operation) from the start ... retrofitting
 *  batching after resolvers ship naively is the expensive order to do this
 *  in." This P0 schema's `Page` type has no relation fields yet (those
 *  need `graph_edges`, P1's "effective-schema resolution" territory — see
 *  `projection.ts`'s file header), so nothing calls this yet, but it's
 *  wired now so a future relation-field resolver (e.g. "pages referenced
 *  by this page") has a batched accessor ready rather than reaching for
 *  one `getPage` call per referenced id. Unknown ids are simply absent
 *  from the result (not an error); result order is not guaranteed to
 *  match `ids`' order — callers that care re-key by `.id`. */
export function getPages(sql: SqlExecutor, ids: readonly string[]): PageAccessorRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = sql
    .exec<GraphNodeRow>(`SELECT ${PAGE_COLUMNS} FROM graph_nodes WHERE node_id IN (${placeholders})`, ...ids)
    .toArray();
  return rows.map(toPageAccessorRow);
}

export interface ListPagesOptions {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
}

export interface ListPagesResult {
  items: PageAccessorRow[];
  nextCursor: string | null;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** Paginated listing — plan step 2's minimum: "listPages(options: {limit,
 *  cursor, includeDeleted})". Cursor is a plain `node_id` (keyset
 *  pagination in the primary key's lexical order) — deliberately simple
 *  per the task brief ("a plain list with a limit is fine for P0, don't
 *  over-build"); no `OFFSET`-based paging (doesn't scale, and isn't
 *  stable under concurrent inserts). `includeDeleted`/`deleted_at IS NOT
 *  NULL` never actually matches a row today (tombstoning purges the row —
 *  see `getPage`'s doc comment) but the option is real and wired so a
 *  future soft-delete variant of tombstoning doesn't need a signature
 *  change here. */
export function listPages(sql: SqlExecutor, options: ListPagesOptions = {}): ListPagesResult {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const conditions: string[] = [];
  const args: unknown[] = [];

  if (!options.includeDeleted) {
    conditions.push("deleted_at IS NULL");
  }
  if (options.cursor) {
    conditions.push("node_id > ?");
    args.push(options.cursor);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  // Fetch one extra row to learn whether a further page exists, without a
  // separate COUNT(*) round trip.
  args.push(limit + 1);

  const rows = sql
    .exec<GraphNodeRow>(
      `SELECT ${PAGE_COLUMNS} FROM graph_nodes ${where} ORDER BY node_id LIMIT ?`,
      ...args,
    )
    .toArray();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(toPageAccessorRow);
  const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

  return { items, nextCursor };
}
