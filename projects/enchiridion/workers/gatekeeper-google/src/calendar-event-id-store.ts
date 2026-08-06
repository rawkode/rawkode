// @enchiridion/worker-gatekeeper-google — SQLite read/write for
// `calendar_event_ids` (schema.ts, point 15). Plain functions over a
// `SqlExecutor`, no DO/Workers-runtime dependency — same pattern as
// `gmail-body-store.ts`'s `resolveThreadIdForPageID`/`recordThreadMessages`,
// which this file is the calendar-side twin of.
//
// PURPOSE (plan §"Live Backend Connectivity (P8)", closing the gap P5
// originally flagged and P7 flagged again): `write-model.ts`'s
// `proposeRsvp` must resolve a caller-supplied vault-side `eventPageID` to
// Google Calendar's REAL `eventId` server-side, at propose time, BEFORE any
// approval row is created — exactly the same "resolve local ID to real
// provider ID, reject immediately if unresolvable" pattern
// `gmail-body-store.ts`'s `resolveThreadIdForPageID` already established
// for Gmail triage (`write-model.ts`'s `resolveThreadIdOrThrow`). This
// table is what makes that resolution possible for Calendar: a plain
// `(page_id) -> (event_id, calendar_id)` mapping, upserted by
// `calendar-ingest.ts` on every ingested (non-cancelled) occurrence.
//
// UPSERT, NOT INSERT-OR-IGNORE: unlike `gmail_thread_messages` (append-only
// per message id), a page's Google event id is a SINGLE stable value for
// that page's lifetime once Google assigns it — `calendar-ingest.ts` calls
// `recordCalendarEventId` on every sync cycle that observes the occurrence
// again (materialized or merely unchanged), so this is naturally an upsert,
// not a set of accumulating rows.
//
// REMOVED ON CANCELLATION: `deleteCalendarEventId` is called from
// `calendar-ingest.ts`'s retraction path (mirroring
// `retractCancelledEvent`'s own `calendar_materialization_state` cleanup) so
// a cancelled/retracted event can never resolve for a FRESH `proposeRsvp`
// call afterward — an already-pending approval proposed before cancellation
// still carries its resolved `eventId` in its own payload (see
// `write-model.ts`'s `proposeRsvp`), so this cleanup only prevents new
// proposals, it does not retroactively invalidate one already in flight
// (Google's own `events.patch` call at confirm time is what would reject
// that, via a 404/410 `CalendarApiError`).

import type { SqlExecutor } from "./schema";

export interface CalendarEventIdMapping {
  eventId: string;
  calendarId: string;
}

interface CalendarEventIdRow {
  event_id: string;
  calendar_id: string;
  [key: string]: unknown;
}

/** Upserts the `(eventId, calendarId)` Google identifies `pageID`'s
 *  materialized Event page by. Called by `calendar-ingest.ts` on every
 *  ingested non-cancelled occurrence — safe to call repeatedly with the
 *  same values (a no-op update), and safe to call with updated values
 *  (Google never actually changes an existing event's `id`, but this stays
 *  correct even if that assumption is ever wrong). */
export function recordCalendarEventId(sql: SqlExecutor, pageID: string, eventId: string, calendarId: string): void {
  sql.exec(
    `INSERT INTO calendar_event_ids (page_id, event_id, calendar_id)
     VALUES (?, ?, ?)
     ON CONFLICT (page_id) DO UPDATE SET
       event_id = excluded.event_id,
       calendar_id = excluded.calendar_id`,
    pageID,
    eventId,
    calendarId,
  );
}

/** VAULT Event `pageID` -> REAL Google Calendar `(eventId, calendarId)`
 *  lookup — the calendar twin of `gmail-body-store.ts`'s
 *  `resolveThreadIdForPageID`. Returns `undefined` (never a thrown error)
 *  for an unknown/unresolvable `pageID` — the caller (`write-model.ts`'s
 *  `proposeRsvp`) is what turns that into a rejection, at PROPOSE time,
 *  before any approval row is created. */
export function resolveEventIdForPageID(sql: SqlExecutor, pageID: string): CalendarEventIdMapping | undefined {
  const row = sql
    .exec<CalendarEventIdRow>("SELECT event_id, calendar_id FROM calendar_event_ids WHERE page_id = ?", pageID)
    .toArray()[0];
  return row ? { eventId: row.event_id, calendarId: row.calendar_id } : undefined;
}

/** Removes `pageID`'s mapping — called from `calendar-ingest.ts`'s
 *  retraction path when the provider reports the event `cancelled`. See
 *  this file's header, "REMOVED ON CANCELLATION". A no-op if no mapping
 *  exists (matches `deleteMaterializationState`'s / `deletePendingBlobReference`'s
 *  established "delete is idempotent" convention elsewhere in this
 *  codebase). */
export function deleteCalendarEventId(sql: SqlExecutor, pageID: string): void {
  sql.exec("DELETE FROM calendar_event_ids WHERE page_id = ?", pageID);
}
