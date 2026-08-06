// @enchiridion/worker-vault — resumable `rebuild-projections`.
//
// Plan §Backend architecture: "`rebuild-projections` is resumable —
// checkpointed by pageID, driven by a DO alarm loop (not one synchronous
// pass over every doc)".
//
// Design: one row in `rebuild_checkpoint` (schema.ts) tracks whether a
// rebuild is running, how far it's gotten (`after_page_id`, the
// lexicographically-last page ID processed so far — `doc-store.ts`'s
// `listStoredPageIds` pagination cursor), and how many pages it's done.
// `runRebuildBatch` processes up to `batchSize` pages per call and returns
// whether more work remains; `vault-do.ts`'s `alarm()` handler calls this
// once per invocation and re-arms its own alarm (a few hundred ms out) if
// there's more to do — never one big loop inside a single alarm firing,
// so a large vault can't blow a Workers CPU/wall-time limit on one alarm.
//
// This module is intentionally SQL/doc-store-shaped but Loro-opening-
// agnostic: the actual "open this page's doc and reproject it" step is
// injected as a callback (`reprojectOnePage`) rather than hard-coded to
// `openDoc`+`reprojectPage`, so the batch-checkpointing logic itself (the
// part with resumability/correctness stakes) can be unit tested without
// needing real doc storage per test case.
//
// POISON-PILL ISOLATION: `reprojectOnePage` is called inside its own
// try/catch per page, not once per whole batch. `vault-do.ts`'s alarm
// handler runs `runRebuildBatch` inside `ctx.storage.transactionSync(...)`
// — if a single page's reprojection threw uncaught, that exception would
// propagate out of the ENTIRE transaction, rolling back every page this
// batch already succeeded on, and the checkpoint cursor would never
// advance past the bad page: every subsequent alarm retry would re-fetch
// the identical batch, hit the identical exception on the identical page,
// and wedge the "resumable rebuild" guarantee permanently. Catching per
// page means one corrupted/oversized doc costs exactly one page's
// projection (recorded in `rebuild_failures`, schema.ts), never the rest
// of the vault's rebuild.

import type { SqlExecutor } from "./schema";

export type RebuildStatus = "idle" | "running" | "completed";

export interface RebuildCheckpoint {
  status: RebuildStatus;
  afterPageID: string | null;
  processedCount: number;
  startedAt: number;
  updatedAt: number;
}

interface CheckpointRow {
  status: string;
  after_page_id: string | null;
  processed_count: number;
  started_at: number;
  updated_at: number;
  [key: string]: unknown;
}

function fromRow(row: CheckpointRow): RebuildCheckpoint {
  return {
    status: row.status as RebuildStatus,
    afterPageID: row.after_page_id,
    processedCount: row.processed_count,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

export function readCheckpoint(sql: SqlExecutor): RebuildCheckpoint | undefined {
  const row = sql
    .exec<CheckpointRow>(
      "SELECT status, after_page_id, processed_count, started_at, updated_at FROM rebuild_checkpoint WHERE id = 1",
    )
    .toArray()[0];
  return row ? fromRow(row) : undefined;
}

function writeCheckpoint(sql: SqlExecutor, checkpoint: RebuildCheckpoint): void {
  sql.exec(
    `INSERT INTO rebuild_checkpoint (id, status, after_page_id, processed_count, started_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       status = excluded.status,
       after_page_id = excluded.after_page_id,
       processed_count = excluded.processed_count,
       started_at = excluded.started_at,
       updated_at = excluded.updated_at`,
    checkpoint.status,
    checkpoint.afterPageID,
    checkpoint.processedCount,
    checkpoint.startedAt,
    checkpoint.updatedAt,
  );
}

/** Starts (or restarts) a rebuild from the very beginning — called by the
 *  `rebuild-projections` RPC. Idempotent to call while already running:
 *  restarts the cursor at the top rather than layering a second
 *  concurrent pass (a DO is single-threaded per request anyway, but the
 *  alarm loop could otherwise "resume" a half-finished rebuild from the
 *  middle if this weren't explicit about resetting). */
export function startRebuild(sql: SqlExecutor, now: number): void {
  writeCheckpoint(sql, {
    status: "running",
    afterPageID: null,
    processedCount: 0,
    startedAt: now,
    updatedAt: now,
  });
}

export interface RebuildFailure {
  pageID: string;
  errorMessage: string;
  failedAt: number;
}

interface FailureRow {
  page_id: string;
  error_message: string;
  failed_at: number;
  [key: string]: unknown;
}

function recordRebuildFailure(sql: SqlExecutor, pageID: string, errorMessage: string, failedAt: number): void {
  sql.exec(
    "INSERT INTO rebuild_failures (page_id, error_message, failed_at) VALUES (?, ?, ?)",
    pageID,
    errorMessage,
    failedAt,
  );
}

/** Every recorded rebuild failure, most recent first — the queryable half
 *  of "record the failure and advance past it" (plan). Not filtered by
 *  page or by rebuild run: a page that has failed across several rebuild
 *  attempts keeps its full history here for diagnosis. */
export function readRebuildFailures(sql: SqlExecutor): RebuildFailure[] {
  return sql
    .exec<FailureRow>("SELECT page_id, error_message, failed_at FROM rebuild_failures ORDER BY id DESC")
    .toArray()
    .map((row) => ({ pageID: row.page_id, errorMessage: row.error_message, failedAt: row.failed_at }));
}

export interface RebuildBatchResult {
  /** Page IDs processed in this batch (already reprojected by the time
   *  this returns — `runRebuildBatch` calls `reprojectOnePage` for each
   *  before returning, it doesn't hand back work for the caller to do). */
  processedPageIDs: string[];
  /** Whether more pages remain — `false` means the rebuild is complete;
   *  the caller (vault-do.ts's alarm handler) should not re-arm the alarm
   *  when this is `false`. */
  hasMore: boolean;
}

/** Processes up to `batchSize` pages starting after the checkpoint's
 *  current cursor, calling `reprojectOnePage(pageID)` for each, then
 *  advances (or completes) the checkpoint. Returns `hasMore: false` and
 *  sets `status: "completed"` once a batch comes back short (fewer than
 *  `batchSize` page IDs listed) — i.e. it just walked past the end of
 *  `doc-store.ts`'s page list. */
export function runRebuildBatch(
  sql: SqlExecutor,
  listPageIDs: (afterPageID: string | undefined, limit: number) => string[],
  reprojectOnePage: (pageID: string) => void,
  now: number,
  batchSize = 50,
): RebuildBatchResult {
  const checkpoint = readCheckpoint(sql);
  const afterPageID = checkpoint?.afterPageID ?? undefined;
  const processedSoFar = checkpoint?.processedCount ?? 0;
  const startedAt = checkpoint?.startedAt ?? now;

  const batch = listPageIDs(afterPageID, batchSize);
  for (const pageID of batch) {
    // See file header, "POISON-PILL ISOLATION" — one page's exception must
    // never abort the batch or wedge the checkpoint on that page forever.
    try {
      reprojectOnePage(pageID);
    } catch (error) {
      recordRebuildFailure(sql, pageID, error instanceof Error ? error.message : String(error), now);
    }
  }

  const hasMore = batch.length === batchSize;
  const newAfterPageID = batch.length > 0 ? batch[batch.length - 1]! : (afterPageID ?? null);

  writeCheckpoint(sql, {
    status: hasMore ? "running" : "completed",
    afterPageID: newAfterPageID,
    processedCount: processedSoFar + batch.length,
    startedAt,
    updatedAt: now,
  });

  return { processedPageIDs: batch, hasMore };
}
