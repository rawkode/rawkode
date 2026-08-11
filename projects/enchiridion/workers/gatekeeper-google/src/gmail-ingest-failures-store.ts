// @enchiridion/worker-gatekeeper-google — the Gmail-side "record the
// failure, advance past it" poison-pill-isolation log for Gmail cron
// ingest (backfill AND incremental).
//
// A near-verbatim copy of `ingest-failures-store.ts` (Calendar's own
// version of this module) — see that file's header for the full argument
// this mirrors one-for-one. Deliberately duplicated rather than
// generalized into one shared module: this task's instructions are
// explicit that Calendar's already-adversarially-reviewed ingest path
// (`calendar-ingest.ts`, `ingest-failures-store.ts`) must not be
// refactored as a side effect of adding Gmail — sharing this module would
// mean editing `calendar-ingest.ts`'s import too, and there is no reuse
// upside big enough (four columns, two functions) to justify touching
// already-reviewed, working code for it.

import type { SqlExecutor } from "./schema";

/** Sentinel `threadId` used by `gmail-ingest.ts`'s backfill-pageToken
 *  recovery path (`runBackfillBatch`'s catch around `listThreadsPage`) to
 *  record "a stale/invalid `threads.list` pageToken was discarded and
 *  backfill was restarted from the beginning of the backfill window" as a
 *  failure kind DISTINCT from an ordinary per-thread materialization
 *  failure, which always records a real Gmail thread id here. No real
 *  Gmail thread id can ever collide with this string (Gmail thread ids are
 *  lowercase hex; this deliberately is not hex-shaped), so an
 *  operator/monitor can filter `readGmailIngestFailures()` on
 *  `failure.threadId === BACKFILL_PAGE_TOKEN_RESET_MARKER` to distinguish
 *  three cases that used to be indistinguishable (or, for the third case,
 *  entirely unrecorded):
 *    1. "one thread failed to materialize" — a real thread id here.
 *    2. "backfill self-healed from a stale pageToken" — this marker,
 *       recorded once per self-heal, with `GmailIngestResult.
 *       backfillPageTokenReset` also `true` on the SAME cron cycle.
 *    3. "backfill silently died forever" — before this fix, a stale
 *       pageToken threw out of `runBackfillBatch` with NOTHING recorded
 *       here at all (the error propagated past this store entirely,
 *       straight to `scheduled()`'s `AggregateError` logging) while
 *       `gmail_backfill_state.page_token` stayed pointed at the same dead
 *       token forever, so every later cycle failed identically — that
 *       failure mode should no longer occur (see `gmail-ingest.ts`'s file
 *       header for the fix), but if some OTHER unrecoverable error class
 *       ever wedges backfill again, its absence from this table alongside
 *       a `gmail_backfill_state.page_token` that stops advancing across
 *       cycles is exactly the signature to alert on. */
export const BACKFILL_PAGE_TOKEN_RESET_MARKER = "__backfill_page_token_reset__";

export interface GmailIngestFailure {
  id: number;
  threadId: string | null;
  errorMessage: string;
  failedAt: number;
}

interface FailureRow {
  id: number;
  thread_id: string | null;
  error_message: string;
  failed_at: number;
  [key: string]: unknown;
}

/** Records one thread's materialization failure. Never throws itself — a
 *  failure to record a failure must not additionally abort ingest (see
 *  `gmail-ingest.ts`'s per-thread try/catch, which calls this from inside
 *  its `catch` block). */
export function recordGmailIngestFailure(
  sql: SqlExecutor,
  input: { threadId: string | null; errorMessage: string },
  now: number,
): void {
  sql.exec(
    `INSERT INTO gmail_ingest_failures (thread_id, error_message, failed_at) VALUES (?, ?, ?)`,
    input.threadId,
    input.errorMessage,
    now,
  );
}

/** Every recorded Gmail ingest failure, most recent first. Not filtered by
 *  run — a thread that has failed across several cron ticks keeps its full
 *  history here for diagnosis, same convention as
 *  `readCalendarIngestFailures`. */
export function readGmailIngestFailures(sql: SqlExecutor): GmailIngestFailure[] {
  return sql
    .exec<FailureRow>("SELECT id, thread_id, error_message, failed_at FROM gmail_ingest_failures ORDER BY id DESC")
    .toArray()
    .map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      errorMessage: row.error_message,
      failedAt: row.failed_at,
    }));
}
