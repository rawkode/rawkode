// @enchiridion/worker-gatekeeper-google — SQLite read/write for
// `calendar_materialization_state` (schema.ts). Plain functions over a
// `SqlExecutor`, no DO/Workers-runtime dependency — same pattern as
// `token-store.ts`, directly unit-testable against
// `test-helpers/sqlite-storage-adapter.ts`.

import type { SqlExecutor } from "./schema";

export interface MaterializationState {
  pageID: string;
  /** Each owned field's own baseline hash (see
   *  `calendar-materialization.ts`'s `eventFieldBaselineHashes`/
   *  `personFieldBaselineHashes`), keyed by field name — NOT one bundled
   *  hash for the whole page. `materialization.ts` diffs this against a
   *  freshly computed map to decide exactly which fields changed. */
  fieldHashes: Record<string, string>;
  /** A full Loro `exportSnapshot()` blob — see schema.ts's file header
   *  (point 4) for why this worker persists the whole doc snapshot, not
   *  just the hash. */
  docSnapshot: Uint8Array;
  lastSyncedAt: number;
}

interface StateRow {
  page_id: string;
  field_hashes: string;
  doc_snapshot: ArrayBuffer;
  last_synced_at: number;
  [key: string]: unknown;
}

/** Mirrors `workers/vault/src/doc-store.ts`'s `toArrayBuffer` — DO SQLite's
 *  real `SqlStorage` (and `bun:sqlite` via the test adapter) both bind
 *  BLOB columns as `ArrayBuffer`, not `Uint8Array` directly. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function getMaterializationState(sql: SqlExecutor, pageID: string): MaterializationState | undefined {
  const row = sql
    .exec<StateRow>(
      "SELECT page_id, field_hashes, doc_snapshot, last_synced_at FROM calendar_materialization_state WHERE page_id = ?",
      pageID,
    )
    .toArray()[0];
  if (!row) return undefined;
  return {
    pageID: row.page_id,
    fieldHashes: JSON.parse(row.field_hashes) as Record<string, string>,
    docSnapshot: new Uint8Array(row.doc_snapshot),
    lastSyncedAt: row.last_synced_at,
  };
}

export function setMaterializationState(sql: SqlExecutor, state: MaterializationState): void {
  sql.exec(
    `INSERT INTO calendar_materialization_state (page_id, field_hashes, doc_snapshot, last_synced_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (page_id) DO UPDATE SET
       field_hashes = excluded.field_hashes,
       doc_snapshot = excluded.doc_snapshot,
       last_synced_at = excluded.last_synced_at`,
    state.pageID,
    JSON.stringify(state.fieldHashes),
    toArrayBuffer(state.docSnapshot),
    state.lastSyncedAt,
  );
}

/** Used when a materialized page is tombstoned (event cancelled at the
 *  provider) — its local state is no longer meaningful, and keeping it
 *  around would let a later re-created page with the SAME deterministic id
 *  (e.g. the event un-cancelled) incorrectly resume from stale doc bytes
 *  instead of starting fresh. */
export function deleteMaterializationState(sql: SqlExecutor, pageID: string): void {
  sql.exec("DELETE FROM calendar_materialization_state WHERE page_id = ?", pageID);
}
