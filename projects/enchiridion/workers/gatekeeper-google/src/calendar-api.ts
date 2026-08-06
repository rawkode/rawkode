// @enchiridion/worker-gatekeeper-google — Google Calendar API v3 HTTP
// client.
//
// Plan §Google gatekeeper: "Calendar: cron incremental sync (syncToken,
// full resync on 410)". Pure function, no DO/Workers-runtime dependency,
// injectable `fetchImpl` — same testable-HTTP-client pattern as
// `oauth-client.ts` (see that file's header). This module owns exactly one
// endpoint: `GET .../calendars/{calendarId}/events` (`events.list`). Real
// event/RSVP MUTATION calls (`events.insert`/`events.patch`) live in
// `calendar-write-model.ts`, a separate file, since they're a completely
// different part of the system (the approval-gated write-model, not
// ingest) even though they hit the same Google API surface.
//
// Response shapes below are the REAL Google Calendar API v3 `Events`
// resource and `events.list` response shape (per Google's published API
// reference — https://developers.google.com/calendar/api/v3/reference/events),
// not a simplified stand-in: field names, nesting, and the
// `start`/`end`/`originalStartTime` `{date, dateTime, timeZone}` shape,
// `nextPageToken`/`nextSyncToken` pagination-vs-sync-token mutual
// exclusivity (Google only ever returns ONE of the two on the last page —
// `nextPageToken` when more pages remain, `nextSyncToken` on the final
// page), and the `410 Gone` expired-syncToken error shape are all exactly
// what a real deployment sees.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoogleCalendarEventDateTime {
  /** Present for all-day events, `YYYY-MM-DD`, no `dateTime`/`timeZone`. */
  date?: string;
  /** Present for timed events, RFC3339 with offset. */
  dateTime?: string;
  /** IANA time zone (e.g. "Europe/London") — present alongside either
   *  `date` or `dateTime` when the event isn't in UTC. */
  timeZone?: string;
}

export interface GoogleCalendarAttendee {
  email: string;
  displayName?: string;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
  optional?: boolean;
}

export interface GoogleCalendarOrganizer {
  email: string;
  displayName?: string;
  self?: boolean;
}

export interface GoogleCalendarEvent {
  kind: "calendar#event";
  etag: string;
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  /** The iCalendar UID — the ONE field `calendar-materialization.ts` reads
   *  off this shape to derive a cloud-safe identity (see
   *  `@enchiridion/graph-core`'s `deriveCalendarMaterializedIdentity`). Per
   *  Google's docs this is present on every real event (auto-generated if
   *  the event wasn't created via iCalendar import), so treated as
   *  required here — an event missing it is a malformed response, not a
   *  normal case to silently tolerate. */
  iCalUID: string;
  start?: GoogleCalendarEventDateTime;
  end?: GoogleCalendarEventDateTime;
  /** Present only on an individual occurrence of a recurring event
   *  (`singleEvents=true` expansion) that has been individually moved —
   *  the ORIGINAL, unmoved slot, which is what identity is keyed on (see
   *  `calendar-materialization.ts`). Absent for non-recurring events and
   *  for un-moved recurring instances. */
  originalStartTime?: GoogleCalendarEventDateTime;
  recurringEventId?: string;
  organizer?: GoogleCalendarOrganizer;
  attendees?: GoogleCalendarAttendee[];
  updated?: string;
}

export interface GoogleCalendarEventsListResponse {
  kind: "calendar#events";
  etag: string;
  /** The calendar's own display title — used as the materialized event's
   *  `calendar` property (see `calendar-materialization.ts`). */
  summary: string;
  updated: string;
  /** The calendar's own IANA time zone — used as the `timeZoneIdentifier`
   *  input for all-day event identity when the event itself carries no
   *  explicit zone. */
  timeZone: string;
  accessRole?: string;
  /** Present when more pages remain — mutually exclusive with
   *  `nextSyncToken` (Google never returns both). */
  nextPageToken?: string;
  /** Present only on the LAST page of a request — the token to persist
   *  (`setSyncCursor`) for the next incremental sync. */
  nextSyncToken?: string;
  items: GoogleCalendarEvent[];
}

/** Thrown on `410 Gone` — Google's signal that a `syncToken` has expired
 *  (kept longer than Google retains incremental-sync history) or was
 *  otherwise invalidated. Per Google's docs, the required recovery is a
 *  full resync (clear the stored cursor, re-list with a time window, no
 *  syncToken) — `calendar-ingest.ts` catches this specifically. */
export class CalendarSyncTokenExpiredError extends Error {
  constructor() {
    super("Google Calendar syncToken expired or invalid (410 Gone) — a full resync is required.");
    this.name = "CalendarSyncTokenExpiredError";
  }
}

/** A real, non-410 error from the Calendar API (auth failure, rate limit,
 *  malformed request, ...) — distinct from `CalendarSyncTokenExpiredError`
 *  so callers only special-case the one recoverable status. */
export class CalendarApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CalendarApiError";
  }
}

export interface ListEventsParams {
  accessToken: string;
  /** Defaults to `"primary"` — the plan's calendar scope is the user's own
   *  primary calendar, not arbitrary shared calendars. */
  calendarId?: string;
  /** Incremental sync token from a prior page's `nextSyncToken`. Mutually
   *  exclusive with `timeMin`/`timeMax` at the CALLER level (this function
   *  doesn't enforce that — `calendar-ingest.ts` decides which mode to
   *  use) — Google's API itself rejects `orderBy` alongside `syncToken`,
   *  which is why `orderBy` is only ever sent for a time-windowed request
   *  below. */
  syncToken?: string;
  /** RFC3339 lower/upper bounds — used for the first-ever sync (no cursor
   *  yet) and full resyncs after a 410. */
  timeMin?: string;
  timeMax?: string;
  /** Continuation token from a prior page's `nextPageToken`. */
  pageToken?: string;
  fetchImpl?: FetchLike;
}

const EVENTS_ENDPOINT_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/** Fetches one page of `events.list`. `singleEvents=true` is always set —
 *  materialization operates on individual OCCURRENCES (plan: "attendees ->
 *  deterministic Person pages" per event instance; `graph-core`'s identity
 *  scheme is itself occurrence-keyed, not series-keyed), never on
 *  recurrence master events, matching the old Swift app's EventKit-level
 *  granularity. */
export async function listEventsPage(params: ListEventsParams): Promise<GoogleCalendarEventsListResponse> {
  const calendarId = params.calendarId ?? "primary";
  const url = new URL(`${EVENTS_ENDPOINT_BASE}/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("maxResults", "250");

  if (params.syncToken) {
    url.searchParams.set("syncToken", params.syncToken);
  } else {
    // Time-windowed full (re)sync — orderBy is only valid without a
    // syncToken (Google API constraint).
    url.searchParams.set("orderBy", "startTime");
    if (params.timeMin) url.searchParams.set("timeMin", params.timeMin);
    if (params.timeMax) url.searchParams.set("timeMax", params.timeMax);
  }
  if (params.pageToken) {
    url.searchParams.set("pageToken", params.pageToken);
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${params.accessToken}` },
  });

  if (response.status === 410) {
    throw new CalendarSyncTokenExpiredError();
  }
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      detail = body.error?.message ? `: ${body.error.message}` : "";
    } catch {
      // non-JSON error body — fall through with no extra detail
    }
    throw new CalendarApiError(response.status, `Google Calendar events.list failed (HTTP ${response.status})${detail}`);
  }

  return (await response.json()) as GoogleCalendarEventsListResponse;
}
