// @enchiridion/worker-gatekeeper-google — SQLite read/write for
// `gmail_participant_stats` (schema.ts, point 9) — the participant
// quality-gate ledger. See `gmail-materialization.ts`'s file header for the
// full heuristic writeup ("has the user ever sent TO this address"); this
// module is just the persistence, same plain-functions-over-`SqlExecutor`
// pattern as every other storage module in this worker.

import type { SqlExecutor } from "./schema";
import { normalizeEmail } from "./gmail-address";

interface ParticipantStatsRow {
  email: string;
  sent_to_count: number;
  [key: string]: unknown;
}

/** Records that the user's own account sent a message TO `email` (a
 *  `SENT`-labeled message's To/Cc recipient — see
 *  `gmail-materialization.ts`). Idempotent-in-spirit but NOT
 *  idempotent-in-fact: calling this twice for the same real-world message
 *  double-counts — callers (`gmail-ingest.ts`) are expected to call this
 *  once per (thread, recipient) pair per ingest pass, not once per
 *  message, since the exact count value is never read, only
 *  `hasExchangedMailWith`'s `> 0` check — an inflated count changes
 *  nothing observable. */
export function recordSentTo(sql: SqlExecutor, email: string, now: number): void {
  const normalized = normalizeEmail(email);
  sql.exec(
    `INSERT INTO gmail_participant_stats (email, sent_to_count, updated_at)
     VALUES (?, 1, ?)
     ON CONFLICT (email) DO UPDATE SET
       sent_to_count = sent_to_count + 1,
       updated_at = excluded.updated_at`,
    normalized,
    now,
  );
}

/** The participant quality gate itself: `true` once the user has EVER sent
 *  a message to this address (`recordSentTo` has fired at least once for
 *  it, in this or any prior ingest cycle — the ledger is cumulative for
 *  the address's lifetime, see schema.ts's file header point 9). */
export function hasExchangedMailWith(sql: SqlExecutor, email: string): boolean {
  const normalized = normalizeEmail(email);
  const row = sql
    .exec<ParticipantStatsRow>("SELECT email, sent_to_count FROM gmail_participant_stats WHERE email = ?", normalized)
    .toArray()[0];
  return (row?.sent_to_count ?? 0) > 0;
}

/** Bulk variant of `hasExchangedMailWith` — one query for a whole batch's
 *  worth of candidate addresses rather than N round trips, used by
 *  `gmail-ingest.ts`'s second (materialize) pass over a backfill/
 *  incremental batch (see that file's header on the two-pass batch design
 *  this exists to support). Returns the SET of addresses (already
 *  email-normalized) that currently qualify. An empty `emails` input
 *  short-circuits to an empty set without touching SQLite at all. */
export function qualifyingParticipants(sql: SqlExecutor, emails: readonly string[]): Set<string> {
  const normalized = [...new Set(emails.map(normalizeEmail))];
  if (normalized.length === 0) return new Set();
  const placeholders = normalized.map(() => "?").join(", ");
  const rows = sql
    .exec<ParticipantStatsRow>(
      `SELECT email, sent_to_count FROM gmail_participant_stats WHERE email IN (${placeholders}) AND sent_to_count > 0`,
      ...normalized,
    )
    .toArray();
  return new Set(rows.map((row) => row.email));
}
