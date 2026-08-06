// @enchiridion/worker-vault — write-model: the real logic behind every
// state-changing operation VaultDO exposes, factored out of the DO class
// itself so it's unit-testable against `SqliteStorageAdapter` +real
// `loro-crdt` docs without a live Workers runtime.
//
// Plan §"Writes are RPC, not GraphQL mutations": "VaultDO's own RPC
// methods (called directly ...) are vault's write-model". `vault-do.ts`'s
// `createOrUpdatePage`/`tombstonePage`/`undeletePage` RPC methods, and its
// WebSocket `webSocketMessage` handler for inbound `docUpdate`/
// `docFullSnapshot`/`tombstone`/`catalogDiff` sync frames, are all thin
// wrappers that call straight into this module, wrapped in
// `ctx.storage.transactionSync(...)` for atomicity.
//
// Every mutating function here follows the same three-step shape:
//   1. Read-before-write (open the relevant doc(s) from `doc-store.ts`,
//      note the version vector(s) beforehand).
//   2. Mutate the CRDT doc(s) in memory, commit, and persist ONLY the net
//      new ops produced (`exportUpdatesSince(beforeVV)`) via
//      `doc-store.ts`'s `appendPendingUpdate` — never the full bytes the
//      caller handed in verbatim, because for `createOrUpdatePage` the
//      "net new ops" can include a second local edit
//      (`system.modifiedAt`) beyond whatever the caller's own bytes
//      contained.
//   3. Reproject affected projection tables (`projection.ts`/
//      `catalog.ts`'s SQL-mirror functions) and record
//      `lastProjectedVersion` bookkeeping — all in the same logical unit
//      of work the caller is expected to wrap in one SQL transaction.

import {
  purgeProjectionRowsForPages,
  readCatalogEntry,
  readCatalogEntryFromSql,
  readCatalogFromSql,
  reprojectCatalog,
  setTombstone,
  upsertCatalogEntry,
  VAULT_META_PAGE_ID,
  type CatalogEntry,
} from "./catalog";
import { appendPendingUpdate, maybeCompact, openDoc } from "./doc-store";
import { decodeVersionVector, encodeVersionVector, type LoroPageDoc } from "./loro-storage";
import { needsReprojection, recordProjectedVersionVector, refreshGraphIssues, reprojectPage } from "./projection";
import type { SqlExecutor } from "./schema";

/** Stamps the doc's `system.modifiedAt` bookkeeping key with `now` as a
 *  real local Loro op — not metadata bolted on outside the doc — so it
 *  round-trips through sync like any other content (see `projection.ts`'s
 *  file header for why a wall-clock "last touched" needs a real doc write
 *  rather than being inferred from CRDT version-vector state, which carries
 *  no wall-clock information at all). Shared by every function below that
 *  mutates a page's own doc and then commits: `createOrUpdatePage` (the
 *  direct-RPC write path) AND `applyInboundDocBytes` (the WebSocket sync
 *  write path — previously the gap this helper closes: only the RPC path
 *  used to call this, so a page edited purely via WS sync kept showing a
 *  permanently stale `modifiedAt`, frozen at its creation time). Must be
 *  called before `doc.commit()` so the edit lands in the same exported
 *  delta as the rest of the write. */
function touchModifiedAt(doc: LoroPageDoc, now: number): void {
  doc.map("system").set("modifiedAt", now);
}

// --- createOrUpdatePage --------------------------------------------------

export interface CreateOrUpdatePageResult {
  /** `false` when `updateBytes` was a pure no-op merge (the doc already
   *  had every op it contained) — nothing was persisted or reprojected. */
  applied: boolean;
  catalogEntry: CatalogEntry;
}

/** The example write-model RPC method per the task brief: "add at least
 *  one real example write method ... that applies a CRDT update, persists
 *  it, and triggers reprojection". This is what task #9 (the vault Pothos
 *  subgraph) calls for mutations, and what a future assistant/gadget
 *  proposal system calls into (plan: gadget writes are always
 *  `graph.propose()` calls, which bottom out in RPC methods shaped like
 *  this one).
 *
 *  `docType` is only consulted the FIRST time a page is seen (creating its
 *  catalog entry) — an existing page's kind isn't mutable through this
 *  method (retyping a page is out of this task's scope; the plan's
 *  "additive-only upgrades" schema-evolution rule suggests it should be
 *  its own deliberate operation, not a side effect of an ordinary
 *  content edit). */
export function createOrUpdatePage(
  sql: SqlExecutor,
  pageID: string,
  docType: string,
  updateBytes: Uint8Array,
  now: number,
): CreateOrUpdatePageResult {
  const catalogEntry = ensureCatalogEntry(sql, pageID, docType, now);

  const doc = openDoc(sql, pageID);
  const beforeVV = doc.versionVector();
  const outcome = doc.importBytes(updateBytes);
  if (!outcome.changedState) {
    return { applied: false, catalogEntry };
  }

  // Our own small local edit — see `touchModifiedAt`'s doc comment for why
  // this needs to be a real doc write, shared with the inbound sync path.
  touchModifiedAt(doc, now);
  doc.commit();

  const delta = doc.exportUpdatesSince(beforeVV);
  appendPendingUpdate(sql, pageID, delta, now);
  maybeCompact(sql, pageID, doc, now);

  reprojectPage(sql, doc, pageID, catalogEntry.docType, catalogEntry.createdAt, now);
  recordProjectedVersionVector(sql, pageID, encodeVersionVector(doc.versionVector()), now);

  return { applied: true, catalogEntry };
}

function ensureCatalogEntry(sql: SqlExecutor, pageID: string, docType: string, now: number): CatalogEntry {
  const existing = readCatalogEntryFromSql(sql, pageID);
  if (existing) return existing;

  const catalogDoc = openDoc(sql, VAULT_META_PAGE_ID);
  const beforeVV = catalogDoc.versionVector();
  // Another concurrent writer (or a doc-storage row created directly
  // without going through the SQL mirror yet) could have already set the
  // CRDT-level entry even though the mirror hadn't caught up — check the
  // doc itself, not just the mirror, before minting a fresh one.
  const fromDoc = readCatalogEntry(catalogDoc, pageID);
  if (fromDoc) {
    reprojectCatalog(sql, [fromDoc]);
    return fromDoc;
  }

  const entry: CatalogEntry = { pageID, docType, createdAt: now, tombstoned: false, updatedAt: now };
  upsertCatalogEntry(catalogDoc, entry);
  catalogDoc.commit();
  appendPendingUpdate(sql, VAULT_META_PAGE_ID, catalogDoc.exportUpdatesSince(beforeVV), now);
  reprojectCatalog(sql, [entry]);
  return entry;
}

// --- tombstone / undelete -------------------------------------------------

function applyTombstoneChange(
  sql: SqlExecutor,
  pageID: string,
  tombstoned: boolean,
  now: number,
): CatalogEntry | undefined {
  const catalogDoc = openDoc(sql, VAULT_META_PAGE_ID);
  const beforeVV = catalogDoc.versionVector();
  const updated = setTombstone(catalogDoc, pageID, tombstoned, now);
  if (!updated) return undefined;
  catalogDoc.commit();
  appendPendingUpdate(sql, VAULT_META_PAGE_ID, catalogDoc.exportUpdatesSince(beforeVV), now);
  reprojectCatalog(sql, [updated]);

  if (tombstoned) {
    // "tombstone sync purges that page's projection rows on both sides"
    // (plan) — every table in catalog.ts's PURGEABLE_PROJECTION_TABLES is
    // now really populated (P1), not just graph_nodes. Purging can leave a
    // dangling `_graph_edges` row pointing AT this now-gone node (from
    // some OTHER page that still owns that edge as source) — refresh
    // `graph_issues` afterward so that shows up as `unresolvedTarget`
    // rather than silently going stale.
    purgeProjectionRowsForPages(sql, [pageID]);
    refreshGraphIssues(sql, now);
  } else {
    // Explicit undelete: the page's rows were purged when it was
    // tombstoned, so re-derive them from its (never-deleted) doc state.
    const doc = openDoc(sql, pageID);
    reprojectPage(sql, doc, pageID, updated.docType, updated.createdAt, now);
    recordProjectedVersionVector(sql, pageID, encodeVersionVector(doc.versionVector()), now);
  }

  return updated;
}

/** Write-model RPC: soft-delete. Returns `undefined` if `pageID` has no
 *  catalog entry to tombstone (matches `catalog.ts`'s `setTombstone`
 *  contract — tombstoning an unknown page is a caller bug, not something
 *  this silently invents a record for). */
export function tombstonePage(sql: SqlExecutor, pageID: string, now: number): CatalogEntry | undefined {
  return applyTombstoneChange(sql, pageID, true, now);
}

/** Write-model RPC: explicit undelete — "last-tombstone-wins, explicit
 *  undelete supported" (plan). */
export function undeletePage(sql: SqlExecutor, pageID: string, now: number): CatalogEntry | undefined {
  return applyTombstoneChange(sql, pageID, false, now);
}

// --- inbound sync: doc bytes from a peer -----------------------------

export interface ApplyInboundDocBytesResult {
  applied: boolean;
}

/** Handles an inbound `docUpdate` OR `docFullSnapshot` sync frame — both
 *  are handled identically here because `LoroDoc.import()` distinguishes
 *  update-vs-snapshot bytes by content, not by a caller flag (see
 *  `loro-storage.ts`'s `LoroPageDoc.importBytes`), so there is no
 *  behavioral difference at this layer between "apply an update" and
 *  "apply a snapshot" — only the WIRE message type differs, and that's
 *  already been resolved into raw bytes by the time this is called.
 *
 *  If the page has no catalog entry yet (a client is telling us about a
 *  page before we've learned of it via a `catalogDiff`), the bytes are
 *  still durably persisted — durability of doc storage must never depend
 *  on catalog sync having already happened — but reprojection is skipped
 *  until a catalog entry exists; boot-time drift-heal
 *  (`projection.needsReprojection`, driven from `vault-do.ts`) picks it up
 *  once the catalog entry eventually arrives.
 *
 *  Also stamps `system.modifiedAt` via `touchModifiedAt`, same as
 *  `createOrUpdatePage` — this is the WebSocket sync write path (the actual
 *  normal way devices sync per the plan), so it needs the identical
 *  local-edit treatment or `modifiedAt` would only ever advance for pages
 *  written through the direct RPC path. */
export function applyInboundDocBytes(
  sql: SqlExecutor,
  pageID: string,
  bytes: Uint8Array,
  now: number,
): ApplyInboundDocBytesResult {
  const doc = openDoc(sql, pageID);
  const beforeVV = doc.versionVector();
  const outcome = doc.importBytes(bytes);
  if (!outcome.changedState) {
    return { applied: false };
  }
  touchModifiedAt(doc, now);
  doc.commit();
  const delta = doc.exportUpdatesSince(beforeVV);
  appendPendingUpdate(sql, pageID, delta, now);
  maybeCompact(sql, pageID, doc, now);

  const catalogEntry = readCatalogEntryFromSql(sql, pageID);
  if (catalogEntry) {
    reprojectPage(sql, doc, pageID, catalogEntry.docType, catalogEntry.createdAt, now);
    recordProjectedVersionVector(sql, pageID, encodeVersionVector(doc.versionVector()), now);
  }
  return { applied: true };
}

// --- inbound sync: catalog entries pushed by a peer -----------------------

/** Handles an inbound `catalogDiff` (a peer pushing entries it believes
 *  this DO is missing or has stale — plan: "since catalog sync can flow
 *  either direction once diffed", per the Swift side's doc comment).
 *  Applies each entry via `catalog.ts`'s last-write-wins comparison
 *  (skips entries the DO's catalog is already strictly ahead of by
 *  `updatedAt`), returns the entries actually applied so `vault-do.ts` can
 *  purge projection rows for any newly-tombstoned pages.
 *
 *  DESIGN NOTE — this is wall-clock LWW, deliberately NOT raw Loro CRDT
 *  merge (plan §Backend architecture, "Catalog first": "Conflict
 *  resolution over the wire is wall-clock (`updatedAt`) LWW, not raw Loro
 *  CRDT merge"). `catalogDiff` wire frames carry decoded `CatalogEntry`
 *  JSON, not raw Loro update bytes, so the winner here is whichever entry
 *  has the larger `updatedAt` — a plain number comparison — not whichever
 *  op Loro's own internal (Lamport-timestamp, peer-ID) conflict resolution
 *  would pick if two replicas' `vault-meta` docs were merged directly via
 *  `exportUpdatesSince`/`importBytes` (the mechanism every OTHER page's
 *  content uses over `docUpdate` frames). Verified empirically (see
 *  `catalog.test.ts`'s two-replica suite): a raw Loro merge of two
 *  genuinely concurrent catalog edits does NOT reliably pick the entry
 *  with the larger `updatedAt` — Loro has no idea our JSON payload even
 *  contains a timestamp, so its resolution is peer-ID/causal-order based
 *  and can disagree with wall-clock LWW. This function (called for every
 *  inbound `catalogDiff`, including entries this replica re-applies as a
 *  fresh LOCAL Loro op via `upsertCatalogEntry` below) is what actually
 *  makes "last-tombstone-wins" true in practice — an intentional
 *  simplification, not an oversight, resting on devices having roughly
 *  synced clocks (true by default for iOS/macOS). Revisit only if
 *  clock-skew-driven wrong-winner cases actually surface. */
export function applyInboundCatalogEntries(
  sql: SqlExecutor,
  entries: readonly CatalogEntry[],
  now: number,
): CatalogEntry[] {
  if (entries.length === 0) return [];
  const local = readCatalogFromSql(sql);
  const localByID = new Map(local.map((e) => [e.pageID, e]));

  // Tie-break on `updatedAt` EQUAL to the local entry: apply (incoming
  // wins), not skip. This must match `catalog.ts`'s `reprojectCatalog` SQL
  // upsert guard (`WHERE excluded.updated_at >= vault_catalog.updated_at`)
  // exactly — an earlier version of this filter used strict `<` here,
  // which silently disagreed with that `>=` guard on an exact-equal
  // timestamp (this filter would drop the entry as "not newer" while the
  // SQL guard, reached from other call sites with the same entry, would
  // have accepted it). Both now agree: ties go to the incoming entry.
  const toApply = entries.filter((entry) => {
    const existing = localByID.get(entry.pageID);
    return !existing || existing.updatedAt <= entry.updatedAt;
  });
  if (toApply.length === 0) return [];

  const catalogDoc = openDoc(sql, VAULT_META_PAGE_ID);
  const beforeVV = catalogDoc.versionVector();
  for (const entry of toApply) {
    upsertCatalogEntry(catalogDoc, entry);
  }
  catalogDoc.commit();
  appendPendingUpdate(sql, VAULT_META_PAGE_ID, catalogDoc.exportUpdatesSince(beforeVV), now);
  reprojectCatalog(sql, toApply);

  const newlyTombstoned = toApply.filter((e) => e.tombstoned).map((e) => e.pageID);
  if (newlyTombstoned.length > 0) {
    purgeProjectionRowsForPages(sql, newlyTombstoned);
    // See applyTombstoneChange's identical comment: a purge can leave a
    // dangling edge elsewhere in the vault pointing at a now-gone node.
    refreshGraphIssues(sql, now);
  }

  return toApply;
}

/** The full current catalog, in the wire message's entry shape (which is
 *  structurally identical to `catalog.ts`'s `CatalogEntry` — see
 *  `sync-protocol.ts`'s file header on the two staying in sync). Used to
 *  answer an inbound `catalogRequest`. */
export function catalogSnapshotForWire(sql: SqlExecutor): CatalogEntry[] {
  return readCatalogFromSql(sql);
}

// --- outbound sync: computing what to send in response to a peer's VV ---

export type DocSyncResponse =
  | { kind: "update"; bytes: Uint8Array }
  | { kind: "fullSnapshot"; bytes: Uint8Array };

/** Answers a peer's `docVersionVector` message: either the incremental
 *  ops they're missing, or — if their version predates this doc's
 *  compaction horizon — a full snapshot (plan: "the device-in-a-drawer
 *  case"; see `loro-storage.ts`'s `needsFullSnapshotFor` for how the
 *  horizon check itself works). */
export function computeDocSyncResponse(
  sql: SqlExecutor,
  pageID: string,
  peerVersionVectorBytes: Uint8Array,
): DocSyncResponse {
  const doc = openDoc(sql, pageID);
  const peerVV = decodeVersionVector(peerVersionVectorBytes);
  if (doc.needsFullSnapshotFor(peerVV)) {
    return { kind: "fullSnapshot", bytes: doc.exportSnapshot() };
  }
  return { kind: "update", bytes: doc.exportUpdatesSince(peerVV) };
}

// --- boot-time drift heal -------------------------------------------------

/** For one page: is its currently-stored doc state ahead of what was last
 *  reprojected? If so, reproject it now. Returns whether it reprojected.
 *  `vault-do.ts`'s constructor calls this over every stored page id on
 *  boot (plan: "On DO startup/first request, compare a stored
 *  `lastProjectedVersion` against actual doc state and auto-heal drift by
 *  reprojecting anything behind"). Skips pages with no catalog entry
 *  (nothing to reproject with — see `applyInboundDocBytes`'s note on the
 *  same situation) and the `vault-meta` page itself (it projects into
 *  `vault_catalog`, not `graph_nodes`, via `catalog.ts`'s own
 *  reprojection path, not this one). */
export function healPageDriftIfNeeded(sql: SqlExecutor, pageID: string, now: number): boolean {
  if (pageID === VAULT_META_PAGE_ID) return false;
  const catalogEntry = readCatalogEntryFromSql(sql, pageID);
  if (!catalogEntry) return false;

  const doc = openDoc(sql, pageID);
  const currentVV = encodeVersionVector(doc.versionVector());
  if (!needsReprojection(sql, pageID, currentVV)) return false;

  reprojectPage(sql, doc, pageID, catalogEntry.docType, catalogEntry.createdAt, now);
  recordProjectedVersionVector(sql, pageID, currentVV, now);
  return true;
}
