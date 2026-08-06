// @enchiridion/worker-gatekeeper-google — the "record the failure, advance
// past it" poison-pill-isolation log for calendar cron ingest.
//
// Mirrors `workers/vault/src/rebuild-projections.ts`'s
// `recordRebuildFailure`/`readRebuildFailures` pattern one-for-one (see
// that file's "POISON-PILL ISOLATION" header comment for the full
// argument): `calendar-ingest.ts`'s `runCalendarIngest` wraps EACH event's
// materialization in its own try/catch and calls
// `recordCalendarIngestFailure` on throw, rather than letting one bad
// event's exception propagate out of the whole batch (which would also
// have skipped every later event in that same fetched batch — not just
// the failed one — see calendar-ingest.ts's file header for why that's
// the data-loss bug this exists to close).
//
// Plain functions over an injected `SqlExecutor`, same testable pattern as
// every other storage module in this worker (`approvals-store.ts`,
// `token-store.ts`, ...).

import type { SqlExecutor } from "./schema";

export interface CalendarIngestFailure {
  id: number;
  eventId: string | null;
  iCalUid: string | null;
  errorMessage: string;
  failedAt: number;
}

interface FailureRow {
  id: number;
  event_id: string | null;
  ical_uid: string | null;
  error_message: string;
  failed_at: number;
  [key: string]: unknown;
}

/** Records one event's materialization failure. Never throws itself — a
 *  failure to record a failure must not additionally abort ingest (see
 *  `calendar-ingest.ts`'s per-event try/catch, which calls this from
 *  inside its `catch` block). */
export function recordCalendarIngestFailure(
  sql: SqlExecutor,
  input: { eventId: string | null; iCalUid: string | null; errorMessage: string },
  now: number,
): void {
  sql.exec(
    `INSERT INTO calendar_ingest_failures (event_id, ical_uid, error_message, failed_at) VALUES (?, ?, ?, ?)`,
    input.eventId,
    input.iCalUid,
    input.errorMessage,
    now,
  );
}

/** Every recorded ingest failure, most recent first — the queryable half
 *  of "record the failure and advance past it" (plan §Google gatekeeper).
 *  Not filtered by run: an event that has failed across several cron
 *  ticks keeps its full history here for diagnosis. */
export function readCalendarIngestFailures(sql: SqlExecutor): CalendarIngestFailure[] {
  return sql
    .exec<FailureRow>(
      "SELECT id, event_id, ical_uid, error_message, failed_at FROM calendar_ingest_failures ORDER BY id DESC",
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      eventId: row.event_id,
      iCalUid: row.ical_uid,
      errorMessage: row.error_message,
      failedAt: row.failed_at,
    }));
}
