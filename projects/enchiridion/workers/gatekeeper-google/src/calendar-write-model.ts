// @enchiridion/worker-gatekeeper-google — real Google Calendar API MUTATION
// calls (`events.insert`, and a GET+PATCH pair for RSVP — Calendar has no
// dedicated RSVP endpoint, see `rsvpToCalendarEvent`'s doc comment). Pure
// functions, injectable `fetchImpl`, same testable-HTTP-client pattern as
// `calendar-api.ts`/`oauth-client.ts`. Deliberately separate from
// `calendar-api.ts` (read-only `events.list`) even though both hit the
// same Google API surface — this file is the write-model's actual
// provider call, only ever invoked from `write-model.ts`'s
// `confirmApproval`, never from ingest.

import { CalendarApiError, type FetchLike, type GoogleCalendarEvent, type GoogleCalendarEventDateTime } from "./calendar-api";

const EVENTS_BASE = "https://www.googleapis.com/calendar/v3/calendars";

function eventUrl(calendarId: string, eventId?: string): string {
  const base = `${EVENTS_BASE}/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

async function parseErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ? `: ${body.error.message}` : "";
  } catch {
    return "";
  }
}

export interface CreateEventInput {
  calendarId?: string;
  summary: string;
  description?: string;
  location?: string;
  start: GoogleCalendarEventDateTime;
  end: GoogleCalendarEventDateTime;
  attendeeEmails?: string[];
}

/** `POST .../events` (`events.insert`) — the real create-event mutation,
 *  only ever called from `write-model.ts`'s `confirmApproval`, after the
 *  approval-gate CAS has already transitioned `pending -> confirmed`. */
export async function createCalendarEvent(
  accessToken: string,
  input: CreateEventInput,
  fetchImpl: FetchLike = fetch,
): Promise<GoogleCalendarEvent> {
  const calendarId = input.calendarId ?? "primary";
  const response = await fetchImpl(eventUrl(calendarId), {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: input.start,
      end: input.end,
      attendees: input.attendeeEmails?.map((email) => ({ email })),
    }),
  });
  if (!response.ok) {
    throw new CalendarApiError(response.status, `Google Calendar events.insert failed (HTTP ${response.status})${await parseErrorDetail(response)}`);
  }
  return (await response.json()) as GoogleCalendarEvent;
}

/** `eventPageID` is the VAULT PageID of the materialized Event page a
 *  caller actually has — NOT Google's raw event id, mirroring
 *  `gmail-triage.ts`'s `ArchiveThreadInput.threadPageID`/`.threadId?`
 *  design ("threadPageID vs. RAW GMAIL THREAD ID") for the write direction,
 *  applied here to close the gap P5 originally flagged and P7 flagged
 *  again: `write-model.ts`'s `proposeRsvp` resolves `eventPageID` against
 *  `calendar-event-id-store.ts` (via `resolveEventIdOrThrow`) at PROPOSE
 *  time, rejecting immediately if unresolvable, and populates `eventId`/
 *  `calendarId` onto the approval's stored payload — the exact same
 *  "mint/resolve once at propose time, thread it through unchanged to
 *  confirm time" shape `gmail-triage.ts`'s `threadId` and
 *  `gmail-send.ts`'s `SendEmailInput.messageId` already established.
 *  `eventId`/`calendarId` are optional on the TYPE (not required) for the
 *  same reason `ArchiveThreadInput.threadId?` is optional: so this file's
 *  own direct unit tests can call `rsvpToCalendarEvent` without needing to
 *  fabricate a full propose-time payload — `requireEventId` below is the
 *  defense-in-depth check that a real approval's payload was actually
 *  resolved before any Calendar API call is attempted. */
export interface RsvpInput {
  eventPageID: string;
  eventId?: string;
  calendarId?: string;
  responseStatus: "accepted" | "declined" | "tentative";
}

/** Defense-in-depth check mirroring `gmail-triage.ts`'s `requireThreadId`
 *  exactly — see `RsvpInput`'s doc comment above. A missing `eventId` here
 *  means `write-model.ts`'s `proposeRsvp` was bypassed (a caller bug, e.g.
 *  a direct unit test), not a Calendar API failure — the real "unresolvable
 *  eventPageID" rejection happens earlier, at propose time
 *  (`RsvpEventNotFoundError`), never here. */
function requireEventId(input: RsvpInput): string {
  if (!input.eventId) {
    throw new Error(
      `missing resolved Google Calendar eventId for eventPageID "${input.eventPageID}" — this approval's payload should have been resolved at propose time (write-model.ts's proposeRsvp via resolveEventIdForPageID); this is a caller bug, not a Calendar API failure`,
    );
  }
  return input.eventId;
}

/** Sibling of `requireEventId` above, same defense-in-depth posture applied
 *  to the OTHER field `write-model.ts`'s `proposeRsvp` resolves and stores
 *  onto the approval's payload alongside `eventId` (`resolveEventIdOrThrow`
 *  always resolves BOTH `eventId` and `calendarId` together — see
 *  `calendar-event-id-store.ts`'s `CalendarEventIdMapping`). Deliberately
 *  loud (throws) here rather than silently falling back to `"primary"` the
 *  way `createCalendarEvent`'s unrelated `CreateEventInput.calendarId` does
 *  — that field is a genuinely optional caller choice with no resolution
 *  step behind it; THIS one is a resolved value, so a missing `calendarId`
 *  on an otherwise-populated (has `eventId`) payload means resolution was
 *  bypassed or a payload shape changed unexpectedly, not a caller who
 *  simply omitted an optional field — silently defaulting would have
 *  masked exactly that bug class instead of surfacing it. */
function requireCalendarId(input: RsvpInput): string {
  if (!input.calendarId) {
    throw new Error(
      `missing resolved Google Calendar calendarId for eventPageID "${input.eventPageID}" — this approval's payload should have been resolved at propose time (write-model.ts's proposeRsvp via resolveEventIdForPageID); this is a caller bug, not a Calendar API failure`,
    );
  }
  return input.calendarId;
}

/** Google Calendar has no dedicated "RSVP" endpoint — responding to an
 *  invite is modeled as updating the CALLER's own entry in the event's
 *  `attendees` array, and `events.patch`'s documented semantics REPLACE
 *  the whole `attendees` array with whatever is sent (it does not merge
 *  element-by-element) — see
 *  https://developers.google.com/calendar/api/v3/reference/events/patch.
 *  So this is a real GET-then-PATCH pair, not a single call: fetch the
 *  event, replace only the attendee row with `self: true` (the API marks
 *  exactly the authenticated user's own row this way), PATCH the full
 *  array back. If the event has no `self` attendee row (the caller isn't
 *  actually invited), this throws rather than inventing one — an RSVP for
 *  an event you're not invited to is a caller bug, not something to
 *  silently paper over.
 *
 * Fix 4 (concurrency guard): the GET and PATCH aren't atomic — a concurrent
 * external change to the event's attendee list (someone else RSVPing,
 * accepting/declining, or the organizer editing attendees) between our GET
 * and our PATCH would otherwise get silently clobbered, since the PATCH
 * REPLACES the full array with what THIS call's GET saw, not a merge. The
 * GET response's `etag` (`GoogleCalendarEvent.etag`, always present per
 * Google's API reference) is sent back as an `If-Match` precondition header
 * on the PATCH — Google's Calendar API v3 supports conditional requests via
 * standard HTTP `ETag`/`If-Match` (see
 * https://developers.google.com/calendar/api/guides/performance#etags) — so
 * a PATCH racing a concurrent write sees its precondition fail (`412`)
 * instead of silently overwriting the newer state. `confirmApproval`
 * (`write-model.ts`) already wraps this whole call in a try/catch that
 * turns ANY thrown error (including the `CalendarApiError` a 412 throws
 * here) into `{status: "failed", reason}` via `markFailed` — never an
 * unhandled crash and never a silent overwrite — so a 412 needs no special
 * handling above this function; it only needs a message clear enough for
 * that "failed" outcome to be actionable (propose a fresh RSVP) rather than
 * a generic HTTP error. */
export async function rsvpToCalendarEvent(
  accessToken: string,
  input: RsvpInput,
  fetchImpl: FetchLike = fetch,
): Promise<GoogleCalendarEvent> {
  const eventId = requireEventId(input);
  const calendarId = requireCalendarId(input);
  const url = eventUrl(calendarId, eventId);
  const headers = { authorization: `Bearer ${accessToken}` };

  const getResponse = await fetchImpl(url, { headers });
  if (!getResponse.ok) {
    throw new CalendarApiError(getResponse.status, `Google Calendar events.get failed (HTTP ${getResponse.status})${await parseErrorDetail(getResponse)}`);
  }
  const event = (await getResponse.json()) as GoogleCalendarEvent;
  const attendees = event.attendees ?? [];
  if (!attendees.some((a) => a.self)) {
    throw new Error(`Cannot RSVP to event ${eventId} — the authenticated account is not among its attendees.`);
  }
  const updatedAttendees = attendees.map((a) => (a.self ? { ...a, responseStatus: input.responseStatus } : a));

  const patchResponse = await fetchImpl(url, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json", "If-Match": event.etag },
    body: JSON.stringify({ attendees: updatedAttendees }),
  });
  if (!patchResponse.ok) {
    if (patchResponse.status === 412) {
      throw new CalendarApiError(
        412,
        `Google Calendar events.patch failed: concurrent modification detected (If-Match precondition failed against etag ${event.etag}) — the event's attendee list changed between GET and PATCH; propose a fresh RSVP`,
      );
    }
    throw new CalendarApiError(patchResponse.status, `Google Calendar events.patch failed (HTTP ${patchResponse.status})${await parseErrorDetail(patchResponse)}`);
  }
  return (await patchResponse.json()) as GoogleCalendarEvent;
}
