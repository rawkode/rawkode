// @enchiridion/worker-vault — pending blob references + GC.
//
// Plan §Backend architecture, "Blobs (R2)": "Uploading a blob registers its
// hash in a pending-references table before upload; GC only deletes objects
// that are unreferenced by any live projection *and* past a grace window
// (30 days) — otherwise an offline device's unsynced attachment reference
// gets its bytes deleted out from under it."
//
// `pending_blob_references` (schema.ts) is the P0 stand-in for that
// projection-backed reference check — see `isBlobReferencedByLivePage`'s
// doc comment below for exactly what's deferred to P1 and why.
//
// This module owns the table's read/write functions (mirrors `catalog.ts`'s
// shape: plain functions over a `SqlExecutor`, no DO-runtime dependency) and
// the GC sweep itself. `blob-routes.ts` calls the register/confirm/rollback
// functions around an actual R2 upload; `vault-do.ts` exposes `blobGcSweep`
// as an RPC method that calls `sweepBlobGarbage`.

import type { R2BucketLike } from "./r2-types";
import type { SqlExecutor } from "./schema";

export type PendingBlobReferenceStatus = "pending" | "uploaded";

export interface PendingBlobReference {
  blobID: string;
  registeredAt: number;
  uploadedAt: number | null;
  status: PendingBlobReferenceStatus;
}

interface PendingBlobReferenceRow {
  blob_id: string;
  registered_at: number;
  uploaded_at: number | null;
  status: string;
  [key: string]: unknown;
}

function fromRow(row: PendingBlobReferenceRow): PendingBlobReference {
  return {
    blobID: row.blob_id,
    registeredAt: row.registered_at,
    uploadedAt: row.uploaded_at,
    status: row.status === "uploaded" ? "uploaded" : "pending",
  };
}

/** Registers `blobID` as about to be uploaded — MUST be called before the
 *  R2 write it protects (plan: "registers its hash in a pending-references
 *  table before upload"), so a GC sweep that runs concurrently with a
 *  slow/still-in-flight upload never has a window where the object exists
 *  in R2 but nothing durable says "this was an intentional upload, not
 *  orphaned data".
 *
 *  Idempotent and non-destructive on a re-register of an already-known id
 *  (content-addressed ids are naturally re-uploaded across devices — plan:
 *  "dedup for free"): `registered_at` is NOT reset on conflict, so a blob
 *  re-uploaded long after its original registration doesn't get a second
 *  free 30-day grace window extension it didn't need (it's already
 *  `uploaded`, which `sweepBlobGarbage` treats as the meaningful state
 *  anyway — see that function). */
export function registerPendingBlobReference(sql: SqlExecutor, blobID: string, now: number): void {
  sql.exec(
    `INSERT INTO pending_blob_references (blob_id, registered_at, uploaded_at, status)
     VALUES (?, ?, NULL, 'pending')
     ON CONFLICT (blob_id) DO NOTHING`,
    blobID,
    now,
  );
}

/** Marks a registered reference as successfully uploaded — called once the
 *  R2 write (or R2 multipart `complete()`) has actually succeeded. */
export function confirmBlobUploaded(sql: SqlExecutor, blobID: string, now: number): void {
  sql.exec(
    `UPDATE pending_blob_references SET status = 'uploaded', uploaded_at = ? WHERE blob_id = ?`,
    now,
    blobID,
  );
}

/** Rolls back a registration — called when the claimed `:id` didn't match
 *  the actual uploaded bytes' derived blob id (`blob-routes.ts`'s hash
 *  mismatch path) and no R2 object was ever durably completed under that
 *  id, so there is nothing left for GC to protect. Deliberately a hard
 *  delete (not a "failed" status) — an id that never had valid bytes
 *  written under it isn't a blob this vault has ever legitimately held. */
export function deletePendingBlobReference(sql: SqlExecutor, blobID: string): void {
  sql.exec(`DELETE FROM pending_blob_references WHERE blob_id = ?`, blobID);
}

export function getPendingBlobReference(sql: SqlExecutor, blobID: string): PendingBlobReference | undefined {
  const row = sql
    .exec<PendingBlobReferenceRow>(
      `SELECT blob_id, registered_at, uploaded_at, status FROM pending_blob_references WHERE blob_id = ?`,
      blobID,
    )
    .toArray()[0];
  return row ? fromRow(row) : undefined;
}

export function listPendingBlobReferences(sql: SqlExecutor): PendingBlobReference[] {
  return sql
    .exec<PendingBlobReferenceRow>(
      `SELECT blob_id, registered_at, uploaded_at, status FROM pending_blob_references ORDER BY blob_id ASC`,
    )
    .toArray()
    .map(fromRow);
}

// --- GC ---------------------------------------------------------------

/** Default grace window: 30 days (plan §Backend architecture, "Blobs
 *  (R2)"), in milliseconds. */
export const DEFAULT_GRACE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** TODO(P1 "effective-schema resolution", plan §Supertag module contract +
 *  §Phasing P1 — see `schema.ts`'s identical TODO on the projection
 *  tables): once `attachment`-type facts exist (a `graph_facts`/
 *  `graph_edges` row whose value is a `blob_<sha256>` id, referenced from a
 *  live, non-tombstoned page), replace this stub with a real query against
 *  those tables — "not referenced by any live page's attachment/blob-
 *  reference fact" is condition (a) of the plan's GC rule, and today this
 *  worker has no data source to answer it from at all.
 *
 *  Until that lands, this function is a DELIBERATE, CONSERVATIVE no-op: it
 *  always reports "referenced" (`true`), which means `sweepBlobGarbage`
 *  below can compute and report grace-window-eligible candidates (useful,
 *  inspectable dry-run output) but will never actually delete an R2 object
 *  it cannot prove is safe to remove — matching the task brief's "err
 *  toward 'don't delete' when uncertain; do not delete anything in this P0
 *  pass without an explicit dry-run mode". Exposed as an injectable
 *  parameter (not hard-coded inside `sweepBlobGarbage`) specifically so
 *  P1's real implementation is a one-line call-site swap, and so this P0
 *  pass's own tests can exercise the "some candidates ARE actually deleted"
 *  code path without waiting for P1. */
export function isBlobReferencedByLivePage(_sql: SqlExecutor, _blobID: string): boolean {
  return true;
}

export interface BlobGcOptions {
  now: number;
  /** Defaults to `DEFAULT_GRACE_WINDOW_MS` (30 days). */
  graceWindowMs?: number;
  /** Defaults to `true` — "do not delete anything in this P0 pass without
   *  an explicit dry-run mode" (task brief). A caller must pass `false`
   *  explicitly to allow real deletes (which, per `isBlobReferencedByLivePage`'s
   *  doc comment, is a no-op in practice today regardless, until P1 wires
   *  in real reference checking — this flag still exists and is respected
   *  because it's the honest, forward-compatible contract, not dead code). */
  dryRun?: boolean;
  /** Injection point for `isBlobReferencedByLivePage` — see that function's
   *  doc comment. Defaults to the conservative P0 stub. */
  isReferenced?: (sql: SqlExecutor, blobID: string) => boolean;
}

export interface BlobGcResult {
  dryRun: boolean;
  graceWindowMs: number;
  /** Every `uploaded` reference past the grace window, regardless of
   *  whether it turned out to be "referenced" — the inspectable "what is
   *  even eligible on age alone" signal the task brief asks for ("log/
   *  return what WOULD be deleted so behavior is inspectable"). */
  graceWindowEligible: string[];
  /** The subset of `graceWindowEligible` that also passed the reference
   *  check (i.e. `isReferenced` returned `false`) — these are the ones
   *  actually deleted when `dryRun` is `false`. Always a subset of
   *  `graceWindowEligible`; always empty under the default `isReferenced`
   *  stub (see that function's doc comment). */
  deletionCandidates: string[];
  /** Blob ids actually removed from R2 and from `pending_blob_references`
   *  this call — empty whenever `dryRun` is `true`. */
  deleted: string[];
}

/** The GC sweep itself (task brief: "a scheduled (or on-demand-admin-RPC,
 *  your choice, document which) sweep"). THIS P0 PASS CHOOSES: on-demand
 *  admin RPC only (`VaultDO.blobGcSweep`) — NOT wired into the nightly cron
 *  alongside backup export. Rationale: with `isBlobReferencedByLivePage`'s
 *  conservative stub, a scheduled real-delete run would be a permanent
 *  no-op today anyway (see that function's doc comment), so wiring it into
 *  `scheduled()` now would just be dead automation to remove/revisit later;
 *  simpler to add the cron line once P1's real reference check lands and
 *  actual deletion has a decision behind it, than to ship an automation
 *  hook nobody has decided the policy for yet. */
export async function sweepBlobGarbage(
  sql: SqlExecutor,
  r2: R2BucketLike,
  options: BlobGcOptions,
): Promise<BlobGcResult> {
  const graceWindowMs = options.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
  const dryRun = options.dryRun ?? true;
  const isReferenced = options.isReferenced ?? isBlobReferencedByLivePage;
  const cutoff = options.now - graceWindowMs;

  const rows = sql
    .exec<PendingBlobReferenceRow>(
      `SELECT blob_id, registered_at, uploaded_at, status FROM pending_blob_references
       WHERE status = 'uploaded' AND registered_at <= ?
       ORDER BY blob_id ASC`,
      cutoff,
    )
    .toArray();

  const graceWindowEligible = rows.map((row) => row.blob_id);
  const deletionCandidates = rows
    .filter((row) => !isReferenced(sql, row.blob_id))
    .map((row) => row.blob_id);

  const deleted: string[] = [];
  if (!dryRun) {
    for (const blobID of deletionCandidates) {
      await r2.delete(blobID);
      sql.exec(`DELETE FROM pending_blob_references WHERE blob_id = ?`, blobID);
      deleted.push(blobID);
    }
  }

  return { dryRun, graceWindowMs, graceWindowEligible, deletionCandidates, deleted };
}
