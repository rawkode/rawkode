// @enchiridion/worker-gadget-host — SQLite read/write for `gadget_doc_state`.
//
// Mirrors `workers/gatekeeper-google/src/materialization-store.ts` exactly
// (see that file's header, and `gadget-materialized-doc.ts`'s header, for
// the full "why a persisted per-page snapshot, not a fresh LoroDoc() per
// call" causal-history argument — not restated here). Simpler than
// gatekeeper-google's version: no per-field baseline hash bookkeeping,
// since `graph.propose()` has no "did the source change" question to
// answer — every confirmed proposal is an explicit, one-shot mutation, not
// a recurring reconciliation against an external provider.

import type { SqlExecutor } from "./schema";

interface StateRow {
  page_id: string;
  doc_snapshot: ArrayBuffer;
  updated_at: number;
  [key: string]: unknown;
}

/** Mirrors `workers/vault/src/doc-store.ts`'s `toArrayBuffer` — DO SQLite's
 *  real `SqlStorage` (and `bun:sqlite` via the test adapter) both bind BLOB
 *  columns as `ArrayBuffer`. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function getDocState(sql: SqlExecutor, pageID: string): Uint8Array | undefined {
  const row = sql.exec<StateRow>("SELECT page_id, doc_snapshot, updated_at FROM gadget_doc_state WHERE page_id = ?", pageID).toArray()[0];
  return row ? new Uint8Array(row.doc_snapshot) : undefined;
}

export function setDocState(sql: SqlExecutor, pageID: string, snapshot: Uint8Array, now: number): void {
  sql.exec(
    `INSERT INTO gadget_doc_state (page_id, doc_snapshot, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (page_id) DO UPDATE SET doc_snapshot = excluded.doc_snapshot, updated_at = excluded.updated_at`,
    pageID,
    toArrayBuffer(snapshot),
    now,
  );
}
