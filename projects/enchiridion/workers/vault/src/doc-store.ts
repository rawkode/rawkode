// @enchiridion/worker-vault — per-page doc storage.
//
// Plan §Backend architecture: "VaultDO ... holds Loro doc storage in DO
// SQLite (latest shallow snapshot + pending updates per doc) ... periodic
// compaction via Loro shallow export."
//
// Storage shape (see `schema.ts`'s `doc_snapshots`/`doc_pending_updates`
// DDL): one row in `doc_snapshots` per page holding the latest exported
// snapshot + the version vector as of that snapshot, plus an append-only
// log in `doc_pending_updates` of update bytes applied since. Serving an
// incremental sync update never requires re-exporting a full snapshot —
// the pending-updates log already has the bytes, or (if the log is empty
// because nothing has changed since the last snapshot) the diff is
// computed live against the hydrated doc.
//
// `openDoc`/`applyLocalUpdate`/`applyRemoteBytes` all hydrate a fresh
// `LoroPageDoc` per call rather than keeping a live in-memory map of open
// docs across requests — correct for the Hibernation API's "resumable from
// durable state only, no in-memory handshake progress" requirement (plan),
// at the cost of re-parsing snapshot+log bytes on every call. Acceptable
// for P0/one-vault scale; an in-memory LRU of hydrated docs (invalidated
// on write) is the obvious follow-up if profiling ever shows this hot.

import { decodeVersionVector, encodeVersionVector, LoroPageDoc } from "./loro-storage";
import type { SqlExecutor } from "./schema";

interface SnapshotRow {
  snapshot: ArrayBuffer;
  version_vector: ArrayBuffer;
  [key: string]: unknown;
}

interface PendingUpdateRow {
  update_bytes: ArrayBuffer;
  [key: string]: unknown;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Reads whatever is stored for `pageID` (snapshot + pending updates, both
 *  possibly empty) and hydrates a live `LoroPageDoc`. A page with no
 *  snapshot row at all yields a brand-new empty doc — this is how a page
 *  gets its first-ever write: `applyLocalUpdate`/`applyRemoteBytes` call
 *  this first, mutate, then persist, with no separate "create" step
 *  required (mirrors `LoroEngine`'s auto-create-on-first-write contract,
 *  CRDTEngine.swift:133-138). */
export function openDoc(sql: SqlExecutor, pageID: string): LoroPageDoc {
  const snapshotRow = sql
    .exec<SnapshotRow>("SELECT snapshot, version_vector FROM doc_snapshots WHERE page_id = ?", pageID)
    .toArray()[0];
  const pendingRows = sql
    .exec<PendingUpdateRow>(
      "SELECT update_bytes FROM doc_pending_updates WHERE page_id = ? ORDER BY id ASC",
      pageID,
    )
    .toArray();
  const pending = pendingRows.map((row) => new Uint8Array(row.update_bytes));

  if (!snapshotRow) {
    // No snapshot row at all: either a brand-new page, or (shouldn't
    // normally happen — every write path creates an empty-doc snapshot
    // row on first write via `appendPendingUpdate` — but handled rather
    // than assumed impossible) pending updates with no snapshot yet.
    // Either way, start from an empty doc and replay whatever pending
    // updates exist directly (no snapshot to open from).
    const doc = LoroPageDoc.create();
    for (const update of pending) {
      doc.importBytes(update);
    }
    return doc;
  }
  return LoroPageDoc.open(new Uint8Array(snapshotRow.snapshot), pending);
}

/** Persists `doc` as the new latest snapshot for `pageID`, clearing the
 *  pending-updates log (the snapshot now subsumes it) — this is
 *  `doc-store.ts`'s compaction step, using Loro's SHALLOW snapshot export
 *  per the plan ("periodic compaction via Loro shallow export"). Callers
 *  decide *when* to compact — the live write paths do so via `maybeCompact`
 *  below (a pending-update-count threshold check on every write, not a
 *  timer); `backup.ts`'s restore path calls this directly, unconditionally,
 *  since a freshly-restored doc always starts from a snapshot anyway. This
 *  function is the mechanical "do it now". Must be called inside the same
 *  SQL transaction as any reprojection write that depends on this doc's
 *  new state (plan: reprojection "runs in the SAME DO SQLite transaction
 *  as the doc-storage write"). */
export function compactDoc(sql: SqlExecutor, pageID: string, doc: LoroPageDoc, now: number): void {
  const snapshot = toArrayBuffer(doc.exportShallowSnapshot());
  const vv = toArrayBuffer(encodeVersionVector(doc.versionVector()));
  sql.exec(
    `INSERT INTO doc_snapshots (page_id, snapshot, is_shallow, version_vector, updated_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (page_id) DO UPDATE SET
       snapshot = excluded.snapshot,
       is_shallow = excluded.is_shallow,
       version_vector = excluded.version_vector,
       updated_at = excluded.updated_at`,
    pageID,
    snapshot,
    vv,
    now,
  );
  sql.exec("DELETE FROM doc_pending_updates WHERE page_id = ?", pageID);
}

/** Appends `updateBytes` to the pending-updates log for `pageID` without
 *  touching the snapshot row — the cheap path for every individual write,
 *  so a burst of small edits doesn't re-export+store a full snapshot per
 *  keystroke. `compactDoc` is what eventually folds this log back into a
 *  fresh snapshot; `maybeCompact` below is what actually decides *when*
 *  that happens on the live write path (a pending-update-count threshold,
 *  checked by `vault-write-model.ts`'s `createOrUpdatePage`/
 *  `applyInboundDocBytes` right after they call this function). If there is
 *  no snapshot row yet for this page, one is created (an empty-doc
 *  snapshot) so `openDoc` always has a well-defined base to replay onto. */
export function appendPendingUpdate(
  sql: SqlExecutor,
  pageID: string,
  updateBytes: Uint8Array,
  now: number,
): void {
  const hasSnapshot =
    sql.exec<{ page_id: string }>("SELECT page_id FROM doc_snapshots WHERE page_id = ?", pageID).toArray()
      .length > 0;
  if (!hasSnapshot) {
    const empty = LoroPageDoc.create();
    const snapshot = toArrayBuffer(empty.exportSnapshot());
    const vv = toArrayBuffer(encodeVersionVector(empty.versionVector()));
    sql.exec(
      "INSERT INTO doc_snapshots (page_id, snapshot, is_shallow, version_vector, updated_at) VALUES (?, ?, 0, ?, ?)",
      pageID,
      snapshot,
      vv,
      now,
    );
  }
  sql.exec(
    "INSERT INTO doc_pending_updates (page_id, update_bytes, created_at) VALUES (?, ?, ?)",
    pageID,
    toArrayBuffer(updateBytes),
    now,
  );
}

/** How many pending updates a page accumulates before its next write
 *  triggers compaction — the live-write-path compaction trigger (see
 *  `maybeCompact` below). Threshold-based rather than time-debounced: a
 *  busy page's pending-updates log needs folding back into a snapshot
 *  roughly in proportion to how much it's grown, and checking "how many
 *  rows are queued" needs no timer/alarm machinery — the very next write to
 *  a page that has crossed this line pays the (cheap, O(1) Loro
 *  shallow-export) cost of compacting it before returning. */
export const COMPACTION_PENDING_UPDATE_THRESHOLD = 50;

/** How many rows are currently queued in `doc_pending_updates` for
 *  `pageID` — what `maybeCompact` checks against
 *  `COMPACTION_PENDING_UPDATE_THRESHOLD`, exported separately so tests and
 *  telemetry can read it without reaching into raw SQL. */
export function countPendingUpdates(sql: SqlExecutor, pageID: string): number {
  const row = sql
    .exec<{ n: number }>("SELECT count(*) as n FROM doc_pending_updates WHERE page_id = ?", pageID)
    .toArray()[0];
  return row ? row.n : 0;
}

/** Compacts `pageID`'s doc storage — via `compactDoc` — if and only if its
 *  pending-updates log has reached `COMPACTION_PENDING_UPDATE_THRESHOLD`.
 *  This is the fix for compaction previously only ever running from
 *  `backup.ts`'s restore path: without a call to this (or `compactDoc`
 *  directly) on the LIVE write path, `doc_pending_updates` grew unbounded
 *  for a live vault's whole lifetime, and a live (never-restored) doc could
 *  never become `doc.isShallow()`, which made `loro-storage.ts`'s
 *  `needsFullSnapshotFor` compaction-horizon check permanently unreachable
 *  for real traffic. `vault-write-model.ts`'s `createOrUpdatePage` and
 *  `applyInboundDocBytes` — the two live write paths — call this right
 *  after `appendPendingUpdate`, passing the SAME `doc` instance they just
 *  wrote to (already hydrated, already holding the new op), so this never
 *  re-opens/re-hydrates anything extra. Returns whether it actually
 *  compacted (purely informative — callers don't need to branch on it). */
export function maybeCompact(sql: SqlExecutor, pageID: string, doc: LoroPageDoc, now: number): boolean {
  if (countPendingUpdates(sql, pageID) < COMPACTION_PENDING_UPDATE_THRESHOLD) return false;
  compactDoc(sql, pageID, doc, now);
  return true;
}

/** Every distinct page ID that has doc storage — used by
 *  `rebuild-projections.ts`'s checkpoint loop and by the R2 backup export.
 *  Ordered so pagination via `afterPageID` (lexicographic `> ?`) is stable
 *  across calls even as new pages are added mid-rebuild. */
export function listStoredPageIds(sql: SqlExecutor, afterPageID?: string, limit = 500): string[] {
  const rows = afterPageID
    ? sql
        .exec<{ page_id: string }>(
          "SELECT page_id FROM doc_snapshots WHERE page_id > ? ORDER BY page_id ASC LIMIT ?",
          afterPageID,
          limit,
        )
        .toArray()
    : sql
        .exec<{ page_id: string }>("SELECT page_id FROM doc_snapshots ORDER BY page_id ASC LIMIT ?", limit)
        .toArray();
  return rows.map((r) => r.page_id);
}

export function docExists(sql: SqlExecutor, pageID: string): boolean {
  return (
    sql.exec<{ page_id: string }>("SELECT page_id FROM doc_snapshots WHERE page_id = ?", pageID).toArray()
      .length > 0
  );
}

export { decodeVersionVector, encodeVersionVector };
