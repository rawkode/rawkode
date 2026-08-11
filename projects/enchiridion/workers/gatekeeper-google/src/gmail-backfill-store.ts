// @enchiridion/worker-gatekeeper-google — SQLite read/write for
// `gmail_backfill_state` (schema.ts, point 8). Plain functions over a
// `SqlExecutor`, no DO/Workers-runtime dependency — same pattern as
// `token-store.ts`/`materialization-store.ts`, directly unit-testable
// against `test-helpers/sqlite-storage-adapter.ts`.
//
// Single-row table (`id = 1`) — this worker backfills exactly one Gmail
// mailbox (single-user scope, matching every other "one row" table in this
// worker). `getGmailBackfillState` returning `undefined` (no row at all)
// means "backfill has never started" — `gmail-ingest.ts` treats that
// identically to `{pageToken: undefined, completed: false}` (a fresh
// `INSERT` on first write), so callers don't need a separate
// three-way-vs-two-way-state distinction.

import type { SqlExecutor } from "./schema";

export interface GmailBackfillState {
  pageToken: string | undefined;
  completed: boolean;
  updatedAt: number;
}

interface BackfillStateRow {
  page_token: string | null;
  completed: number;
  updated_at: number;
  [key: string]: unknown;
}

export function getGmailBackfillState(sql: SqlExecutor): GmailBackfillState | undefined {
  const row = sql
    .exec<BackfillStateRow>("SELECT page_token, completed, updated_at FROM gmail_backfill_state WHERE id = 1")
    .toArray()[0];
  if (!row) return undefined;
  return {
    pageToken: row.page_token ?? undefined,
    completed: row.completed !== 0,
    updatedAt: row.updated_at,
  };
}

/** Upserts the single backfill-state row. `pageToken: undefined` writes a
 *  SQL `NULL` (explicitly clearing any previously-stored token — used both
 *  by "advance to the next page" with a real token AND by the
 *  historyId-expired re-baseline path in `gmail-ingest.ts`, which resets
 *  this row back to "start from the beginning" via
 *  `{pageToken: undefined, completed: false}`). */
export function setGmailBackfillState(sql: SqlExecutor, state: GmailBackfillState): void {
  sql.exec(
    `INSERT INTO gmail_backfill_state (id, page_token, completed, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       page_token = excluded.page_token,
       completed = excluded.completed,
       updated_at = excluded.updated_at`,
    state.pageToken ?? null,
    state.completed ? 1 : 0,
    state.updatedAt,
  );
}
