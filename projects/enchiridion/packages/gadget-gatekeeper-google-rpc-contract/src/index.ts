// @enchiridion/gadget-gatekeeper-google-rpc-contract
//
// Shared, types-only contract for `workers/gadget-host`'s
// `gatekeeper.google.calendar.read` capability calling INTO
// `workers/gatekeeper-google` over a NAMED-ENTRYPOINT Cloudflare Service
// Binding — the same real-Workers-RPC shape
// `@enchiridion/gatekeeper-google-rpc-contract` already established for
// vault's `GmailReadModel` binding (see that package's file header for the
// full "why a named entrypoint, not `.fetch()`" writeup; not repeated here).
//
// SCOPE: a NEW package, not an addition to `@enchiridion/gatekeeper-google-
// rpc-contract` — that package's own header states its scope deliberately
// ("only the two RPC methods vault's composed schema actually calls"), and
// this is a different caller (gadget-host, not vault) calling a different
// method (`listUpcomingEvents`, not the Gmail methods). Same scoping
// principle, applied consistently.
//
// `CalendarReadModel` (the real, additive `WorkerEntrypoint` this contract
// describes) is a NEW, minimal, additive export on
// `workers/gatekeeper-google/src/index.ts` — mirroring `GmailReadModel`
// exactly (a new class, one new narrow method, zero changes to any existing
// method). Flagged explicitly in the P4 gadgets task report as the one
// exception to "work within workers/gadget-host/", by direct analogy to
// the plan's own explicitly-sanctioned "minimal, additive VaultDO RPC
// method" escape hatch for graph.query/graph.propose (this capability's
// narrow read has no existing gatekeeper-google RPC surface to reuse the
// way graph.query/graph.propose could reuse VaultDO's EXISTING accessor
// methods — see `@enchiridion/gadget-vault-rpc-contract`'s header for that
// contrast).
//
// `listUpcomingEvents` is a genuinely NARROW, read-only, side-effect-free
// query: a time-windowed `events.list` call (`calendar-api.ts`'s existing
// `listEventsPage`, reused as-is) with NO `syncToken`, so it never touches
// `runCalendarIngestCycle`'s own incremental-sync cursor state — a gadget
// calling this can never desynchronize calendar ingest, and this method
// never writes anything (no materialization, no VaultDO call) — it only
// returns a small summary DTO, never the raw Google API response shape
// (`GoogleCalendarEvent`), consistent with "no provider IDs leak into the
// graph" even though this DTO never enters the graph at all.

/** One upcoming Calendar event, summarized for gadget consumption — never
 *  the raw Google API shape (`GoogleCalendarEvent`, `calendar-api.ts`).
 *  Deliberately smaller than what materialization ingests: no organizer/
 *  attendee edges, no recurrence metadata, nothing that would encourage a
 *  gadget to attempt identity-sensitive reasoning that belongs to
 *  materialization instead. `id` is Google's own raw event id — safe to
 *  expose here (this DTO never crosses into the vault graph, matching
 *  `EmailMessageDTO`'s identical exposure of Gmail's raw message id, see
 *  `@enchiridion/gatekeeper-google-rpc-contract`'s doc comment for that
 *  precedent). */
export interface CalendarEventSummaryDTO {
  id: string;
  title: string;
  /** RFC3339 instant, or `YYYY-MM-DD` for an all-day event's start date —
   *  passed through from Google's `start.dateTime`/`start.date` as-is
   *  (no timezone conversion — a gadget that needs local-time reasoning
   *  does it itself, same "raw header values, unparsed" posture
   *  `EmailMessageDTO` documents for Gmail headers). */
  start: string;
  end: string;
  isAllDay: boolean;
  location?: string;
  status: "confirmed" | "tentative" | "cancelled";
}

/** Mirrors `CalendarReadModel.listUpcomingEvents`'s real parameter list.
 *  `maxResults` defaults server-side (see
 *  `DEFAULT_CALENDAR_READ_MAX_RESULTS` below) when omitted/invalid;
 *  `windowDays` bounds how far into the future the time window extends
 *  (defaults to `DEFAULT_CALENDAR_READ_WINDOW_DAYS`). */
export type ListUpcomingEventsParams = [maxResults?: number, windowDays?: number];

/** Mirrors `CalendarReadModel.listUpcomingEvents`'s real return shape —
 *  ordered by start time ascending, matching `calendar-api.ts`'s
 *  `orderBy=startTime` (only valid without a `syncToken`, which this method
 *  never sends). */
export type ListUpcomingEventsResult = CalendarEventSummaryDTO[];

export const DEFAULT_CALENDAR_READ_MAX_RESULTS = 20;
export const MAX_CALENDAR_READ_MAX_RESULTS = 50;
export const DEFAULT_CALENDAR_READ_WINDOW_DAYS = 14;
export const MAX_CALENDAR_READ_WINDOW_DAYS = 90;

/** The exact message `CalendarReadModel.listUpcomingEvents` throws when the
 *  connected Google account hasn't granted `calendar.events` — same
 *  "plain-message Error, not a subclass" convention
 *  `GMAIL_SCOPE_NOT_GRANTED_MESSAGE` documents (Workers RPC does not
 *  reliably preserve a thrown error's prototype chain across the worker
 *  boundary, only its `.message`). */
export const CALENDAR_SCOPE_NOT_GRANTED_MESSAGE =
  "Google Calendar access not granted — connect via /oauth/google/authorize?scope=calendar&reconnect=true";
