// @enchiridion/worker-vault — vault-meta catalog.
//
// Plan §Backend architecture: "the `vault-meta` doc is a CRDT map of
// `pageID -> {docType, createdAt, tombstone?}`. It syncs first on every
// connect; devices diff it against their local catalog to discover pages
// created elsewhere ... Deletion is a catalog tombstone (last-tombstone-
// wins, explicit undelete supported); tombstone sync purges that page's
// projection rows on both sides."
//
// IMPLEMENTATION NOTE — this is a REAL CRDT map, not the plan's allowed P0
// fallback: the task brief allows "a plain DO-SQLite table ... as long as
// you document clearly that the plan calls for it to be a synced CRDT doc
// and this is a temporary simplification" for the case where "Loro maps
// aren't verifiable in this sandbox". They are verifiable here (see
// `loro-storage.ts`'s file header and `loro-storage.test.ts`, which
// exercises `LoroMap` against the real installed `loro-crdt` package under
// `bun test`), so `vault-meta` is implemented as what the plan actually
// asks for: `pageID` is just another page ID (the fixed constant
// `VAULT_META_PAGE_ID`), stored through the exact same `doc-store.ts`
// machinery (snapshot + pending-updates log, synced over the same
// WebSocket protocol) as any other page, with one root `LoroMap` container
// holding `pageID -> JSON-encoded CatalogEntry`.
//
// `vault_catalog` (the DO SQLite table from `schema.ts`) is a genuine
// reprojection of that map — same "CRDT doc is the source of authority,
// SQL table is derived/cache, rebuilt in the same transaction as the doc
// write" pattern as every other page's projection (plan: "Reprojection ...
// runs in the SAME DO SQLite transaction as the doc-storage write") — not
// a second source of truth. It exists because the bounded query surface,
// the catalog-diff computation, and startup drift-healing all want to
// range over "every page" with SQL, and re-walking a `LoroMap` for that on
// every request would be needless WASM-boundary traffic once a vault has
// thousands of pages.
//
// Map value choice: each catalog entry is stored as one JSON-string value
// per pageID key (`map.set(pageID, JSON.stringify(entry))`), not a nested
// LoroMap per entry. This is deliberate, not a shortcut: `LoroMap`'s
// per-key semantics are already last-write-wins
// (https://loro.dev — Map container), which is EXACTLY the plan's
// "last-tombstone-wins" rule for the catalog as a whole — storing the
// whole `{docType, createdAt, tombstoned, updatedAt}` record as one opaque
// value per key means a concurrent edit to one page's catalog entry can
// never partially merge with another peer's concurrent edit to the SAME
// entry (which per-field nested-map merging would allow, e.g. one peer's
// `tombstoned: true` surviving while another peer's newer `docType` change
// also survives, producing a Frankenstein record) — whole-entry LWW is the
// correct merge semantics for "this page was deleted or not", not
// field-level merge.
//
// WALL-CLOCK LWW, NOT RAW CRDT MERGE — stated explicitly so a future reader
// doesn't mistake this for an oversight: the actual winner between two
// devices' conflicting catalog entries (tombstone vs. undelete, or any
// other concurrent edit to the same pageID's entry) is decided by
// COMPARING `updatedAt` numbers in `vault-write-model.ts`'s
// `applyInboundCatalogEntries` (see its doc comment for the full
// rationale and plan citation), not by letting Loro's own CRDT map
// semantics resolve the conflict via a raw `docUpdate`-style merge of two
// `vault-meta` replicas. Those are NOT equivalent: Loro's built-in
// per-key LWW (referenced above) resolves concurrent `set()`s by internal
// (Lamport timestamp, peer ID) ordering, which has no knowledge of the
// `updatedAt` field inside the JSON payload and can disagree with it —
// verified empirically in `catalog.test.ts`'s two-replica suite. Every
// OTHER page's content merges via real Loro CRDT semantics over
// `docUpdate` frames; the catalog is the one deliberate exception, an
// intentional simplification per this task/the plan's "Catalog first"
// section, resting on devices having roughly synced clocks.

import type { LoroPageDoc } from "./loro-storage";
import type { SqlExecutor } from "./schema";

/** The fixed page ID the `vault-meta` doc is stored under in `doc-store.ts`
 *  — it is a document like any other, just one every vault has exactly
 *  one of and never appears in its own catalog. */
export const VAULT_META_PAGE_ID = "vault-meta";

const CATALOG_MAP_NAME = "catalog";

export interface CatalogEntry {
  pageID: string;
  docType: string;
  /** Epoch milliseconds. */
  createdAt: number;
  tombstoned: boolean;
  /** Epoch milliseconds of the last change to THIS catalog entry
   *  specifically (not the page's own doc) — what last-tombstone/
   *  last-write-wins compares when two catalog diffs disagree about the
   *  same pageID. Not part of the plan's literal
   *  `{docType, createdAt, tombstone?}` shape, but required to implement
   *  "last-tombstone-wins" as anything other than "whoever the CRDT map
   *  happens to have applied last" (which IS what Loro's own LWW already
   *  gives us server-side — this field is what lets `diffCatalog` reason
   *  about staleness across two independently-collected entry lists,
   *  e.g. client-vs-server, without both sides sharing one live doc). */
  updatedAt: number;
}

interface StoredCatalogValue {
  docType: string;
  createdAt: number;
  tombstoned: boolean;
  updatedAt: number;
}

function encodeEntry(entry: CatalogEntry): string {
  const value: StoredCatalogValue = {
    docType: entry.docType,
    createdAt: entry.createdAt,
    tombstoned: entry.tombstoned,
    updatedAt: entry.updatedAt,
  };
  return JSON.stringify(value);
}

function decodeEntry(pageID: string, raw: unknown): CatalogEntry | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCatalogValue>;
    if (
      typeof parsed.docType !== "string" ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.tombstoned !== "boolean" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return undefined;
    }
    return {
      pageID,
      docType: parsed.docType,
      createdAt: parsed.createdAt,
      tombstoned: parsed.tombstoned,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    // Malformed JSON in the map (shouldn't happen from a well-behaved
    // peer) — fail closed by treating the entry as absent rather than
    // throwing and taking down the whole catalog read.
    return undefined;
  }
}

/** Writes (creates or overwrites) one catalog entry. Caller is responsible
 *  for calling `doc.commit()` afterwards (batched with any other edits in
 *  the same operation, matching every other mutation path in this
 *  worker). */
export function upsertCatalogEntry(doc: LoroPageDoc, entry: CatalogEntry): void {
  doc.map(CATALOG_MAP_NAME).set(entry.pageID, encodeEntry(entry));
}

/** Applies a tombstone (or, if `undelete` is true, an explicit undelete) to
 *  an existing entry — "last-tombstone-wins, explicit undelete supported"
 *  (plan). Returns the updated entry, or `undefined` if there was no prior
 *  entry for `pageID` (nothing to tombstone/undelete — creating a
 *  tombstone for a page the catalog has never heard of is a caller bug,
 *  not something this function silently invents a record for). */
export function setTombstone(
  doc: LoroPageDoc,
  pageID: string,
  tombstoned: boolean,
  at: number,
): CatalogEntry | undefined {
  const current = readCatalogEntry(doc, pageID);
  if (!current) return undefined;
  const updated: CatalogEntry = { ...current, tombstoned, updatedAt: at };
  upsertCatalogEntry(doc, updated);
  return updated;
}

export function readCatalogEntry(doc: LoroPageDoc, pageID: string): CatalogEntry | undefined {
  const raw = doc.map(CATALOG_MAP_NAME).get(pageID);
  return decodeEntry(pageID, raw);
}

/** Every entry currently in the catalog map, decoded. Skips (rather than
 *  throws on) any value that fails to decode — see `decodeEntry`. */
export function readAllCatalogEntries(doc: LoroPageDoc): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const [pageID, raw] of doc.map(CATALOG_MAP_NAME).entries()) {
    const entry = decodeEntry(pageID, raw);
    if (entry) entries.push(entry);
  }
  return entries;
}

// --- SQL mirror ------------------------------------------------------------

interface CatalogRow {
  page_id: string;
  doc_type: string;
  created_at: number;
  tombstoned: number;
  updated_at: number;
  [key: string]: unknown;
}

function toRow(entry: CatalogEntry): CatalogRow {
  return {
    page_id: entry.pageID,
    doc_type: entry.docType,
    created_at: entry.createdAt,
    tombstoned: entry.tombstoned ? 1 : 0,
    updated_at: entry.updatedAt,
  };
}

function fromRow(row: CatalogRow): CatalogEntry {
  return {
    pageID: row.page_id,
    docType: row.doc_type,
    createdAt: row.created_at,
    tombstoned: row.tombstoned !== 0,
    updatedAt: row.updated_at,
  };
}

/** Upserts every entry into the `vault_catalog` SQL mirror — meant to be
 *  called with the doc's full `readAllCatalogEntries()` output inside the
 *  same DO SQLite transaction as the doc-storage write (plan: "runs in the
 *  SAME DO SQLite transaction as the doc-storage write"), so the mirror
 *  never observably lags the CRDT doc it derives from. */
export function reprojectCatalog(sql: SqlExecutor, entries: readonly CatalogEntry[]): void {
  for (const entry of entries) {
    const row = toRow(entry);
    // Tie-break: `>=`, not `>` — on an EXACT-equal `updatedAt`, the
    // incoming entry still overwrites. This must agree with
    // `vault-write-model.ts`'s `applyInboundCatalogEntries` filter (which
    // decides whether an entry reaches this call at all for that call
    // site) — both now treat equal timestamps as "incoming wins", not
    // "existing wins". They used to disagree (that filter used strict
    // `<`), which was harmless only by accident (that specific call site
    // always filters before reaching here); other callers of this
    // function (`ensureCatalogEntry`, `applyTombstoneChange`) go straight
    // to this guard with no upstream filter, so the two had to actually
    // agree, not just coincidentally not collide.
    sql.exec(
      `INSERT INTO vault_catalog (page_id, doc_type, created_at, tombstoned, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (page_id) DO UPDATE SET
         doc_type = excluded.doc_type,
         created_at = excluded.created_at,
         tombstoned = excluded.tombstoned,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= vault_catalog.updated_at`,
      row.page_id,
      row.doc_type,
      row.created_at,
      row.tombstoned,
      row.updated_at,
    );
  }
}

export function readCatalogFromSql(sql: SqlExecutor): CatalogEntry[] {
  return sql
    .exec<CatalogRow>(
      "SELECT page_id, doc_type, created_at, tombstoned, updated_at FROM vault_catalog",
    )
    .toArray()
    .map(fromRow);
}

export function readCatalogEntryFromSql(sql: SqlExecutor, pageID: string): CatalogEntry | undefined {
  const row = sql
    .exec<CatalogRow>(
      "SELECT page_id, doc_type, created_at, tombstoned, updated_at FROM vault_catalog WHERE page_id = ?",
      pageID,
    )
    .toArray()[0];
  return row ? fromRow(row) : undefined;
}

/** Deletes every projection row belonging to a tombstoned page — plan:
 *  "tombstone sync purges that page's projection rows on both sides". P0
 *  scope note: only `graph_nodes` is populated by `projection.ts` yet
 *  (see `schema.ts`'s DDL comments), so that's the only table with real
 *  rows to purge today; the rest are listed so P1 doesn't have to
 *  rediscover which tables need a purge-on-tombstone hook when
 *  `packages/projection` starts populating them. */
const PURGEABLE_PROJECTION_TABLES = [
  "graph_nodes",
  "graph_node_tags",
  "graph_facts",
  "_graph_edges",
  "graph_issues",
] as const;

export function purgeProjectionRowsForPages(sql: SqlExecutor, pageIDs: readonly string[]): void {
  if (pageIDs.length === 0) return;
  const placeholders = pageIDs.map(() => "?").join(", ");
  for (const table of PURGEABLE_PROJECTION_TABLES) {
    if (table === "_graph_edges") {
      // `_graph_edges` (the private forward-only storage table behind the
      // public `graph_edges` VIEW — schema.ts) has no single `node_id`
      // column — an edge references a page via `source_node_id`/
      // `target_node_id`, so a purge must match either side of the edge.
      sql.exec(
        `DELETE FROM _graph_edges WHERE source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders})`,
        ...pageIDs,
        ...pageIDs,
      );
      continue;
    }
    sql.exec(`DELETE FROM ${table} WHERE node_id IN (${placeholders})`, ...pageIDs);
  }
  sql.exec(`DELETE FROM projection_state WHERE page_id IN (${placeholders})`, ...pageIDs);
}

// --- Diffing -----------------------------------------------------------

/** Entries in `remote` that `local` is missing or has a strictly staler
 *  copy of (by `updatedAt`) — the plan's "devices diff [the catalog]
 *  against their local catalog to discover pages created elsewhere".
 *  Symmetric: called with (serverEntries, clientEntries) it tells the
 *  server what to push to a client; called the other way round it tells a
 *  client what it's ahead on. VaultDO only ever needs the first direction
 *  in this P0 pass (see `vault-do.ts`'s `catalogRequest` handler), but the
 *  function itself doesn't assume a direction. */
export function diffCatalog(
  local: readonly CatalogEntry[],
  remote: readonly CatalogEntry[],
): CatalogEntry[] {
  const localByID = new Map(local.map((e) => [e.pageID, e]));
  const missingOrStale: CatalogEntry[] = [];
  for (const entry of remote) {
    const existing = localByID.get(entry.pageID);
    if (!existing || existing.updatedAt < entry.updatedAt) {
      missingOrStale.push(entry);
    }
  }
  return missingOrStale;
}
