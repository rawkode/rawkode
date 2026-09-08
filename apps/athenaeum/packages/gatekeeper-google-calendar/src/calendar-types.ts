// Wire/domain types for `GoogleCalendarClient` — behaviorally ported from cloudflare-os's
// `packages/gatekeeper-google/src/calendar-types.d.ts` (read per this task's hard constraint: "the
// domain behavior... NOT the code itself, different RPC/Effect stack"), re-typed via `effect/Schema`
// per this codebase's own convention (every wire/entity shape in `@athenaeum/domain` is a
// `Schema.Class`; this package follows the identical discipline for its own self-contained surface —
// see docs/gatekeeper-google-calendar-decisions.md §1 for why these types live in THIS package and
// not `@athenaeum/domain`).
//
// Shapes verified against Google's own current Calendar API v3 docs (WebFetch, this stage — not
// guessed, not merely copied from cloudflare-os):
//   - https://developers.google.com/calendar/api/v3/reference/events (Event resource: id, status,
//     summary, description, location, start/end {dateTime|date, timeZone}, attendees
//     {email,displayName,optional,responseStatus,organizer,self}, reminders {useDefault,overrides
//     {method,minutes}}, htmlLink, transparency, visibility, recurringEventId — confirmed
//     events.insert/events.patch use the identical resource shape for request and response, and
//     sendUpdates accepts all|externalOnly|none)
//   - https://developers.google.com/calendar/api/v3/reference/freebusy/query (request: timeMin,
//     timeMax, timeZone?, items[{id}]; response: calendars: {[id]: {busy:[{start,end}],
//     errors?:[{domain,reason}]}} — documented reasons include "notFound")

import * as Schema from "effect/Schema"

// --- Calendar time -----------------------------------------------------------------------------

/** All-day events use `{kind:"date", date:"YYYY-MM-DD"}` (Google's end date is EXCLUSIVE — a
 *  one-day all-day event on 2026-06-09 has `end.date === "2026-06-10"`, per the Calendar API's own
 *  documented convention, carried over from cloudflare-os's `CalendarTime` doc comment verbatim).
 *  Timed events use `{kind:"dateTime", dateTime: <RFC3339 ISO string>, timeZone?}`. */
export const CalendarTime = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("date"), date: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("dateTime"),
    dateTime: Schema.String,
    timeZone: Schema.optional(Schema.String)
  })
)
export type CalendarTime = typeof CalendarTime.Type

// --- Attendees / reminders ----------------------------------------------------------------------

export class CalendarAttendee extends Schema.Class<CalendarAttendee>("CalendarAttendee")({
  email: Schema.String,
  displayName: Schema.optional(Schema.String),
  optional: Schema.optional(Schema.Boolean),
  responseStatus: Schema.optional(
    Schema.Literal("needsAction", "declined", "tentative", "accepted")
  ),
  organizer: Schema.optional(Schema.Boolean),
  self: Schema.optional(Schema.Boolean)
}) {}

export class CalendarReminder extends Schema.Class<CalendarReminder>("CalendarReminder")({
  method: Schema.Literal("email", "popup"),
  minutes: Schema.Number
}) {}

/** Notification fan-out for a write — accepted by `events.insert`/`events.patch`/`events.delete`'s
 *  `sendUpdates` query parameter (verified against Google's docs, this stage). */
export const CalendarSendUpdates = Schema.Literal("all", "externalOnly", "none")
export type CalendarSendUpdates = typeof CalendarSendUpdates.Type

// --- Event ---------------------------------------------------------------------------------------

export class CalendarEvent extends Schema.Class<CalendarEvent>("CalendarEvent")({
  id: Schema.String,
  title: Schema.String,
  /** Provider change cursor used by downstream projections to reject an older snapshot that
   * arrives after a newer one. Google exposes this as the Event resource's `updated` field; the
   * scripted client may omit it, in which case the consumer falls back to its existing ordering
   * policy. */
  updatedAt: Schema.optional(Schema.String),
  start: CalendarTime,
  end: CalendarTime,
  status: Schema.Literal("confirmed", "tentative", "cancelled"),
  location: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  attendees: Schema.optional(Schema.Array(CalendarAttendee)),
  htmlLink: Schema.optional(Schema.String),
  transparency: Schema.optional(Schema.Literal("opaque", "transparent")),
  visibility: Schema.optional(Schema.Literal("default", "public", "private", "confidential")),
  recurringEventId: Schema.optional(Schema.String),
  /** Google's stable occurrence identity for an expanded recurring instance. */
  originalStartTime: Schema.optional(CalendarTime)
}) {}

export class CalendarEventDraft extends Schema.Class<CalendarEventDraft>("CalendarEventDraft")({
  title: Schema.String,
  start: CalendarTime,
  end: CalendarTime,
  description: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  attendees: Schema.optional(
    Schema.Array(
      Schema.Struct({
        email: Schema.String,
        displayName: Schema.optional(Schema.String),
        optional: Schema.optional(Schema.Boolean)
      })
    )
  ),
  reminders: Schema.optional(Schema.Array(CalendarReminder)),
  transparency: Schema.optional(Schema.Literal("opaque", "transparent")),
  visibility: Schema.optional(Schema.Literal("default", "public", "private", "confidential"))
}) {}

/** Only the fields present are changed — `events.patch`'s own documented semantics (a full
 *  replacement of `attendees`, per Google's docs: patch is field-level EXCEPT `attendees`, which
 *  is always whole-list). */
export class CalendarEventPatch extends Schema.Class<CalendarEventPatch>("CalendarEventPatch")({
  title: Schema.optional(Schema.String),
  start: Schema.optional(CalendarTime),
  end: Schema.optional(CalendarTime),
  description: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  attendees: Schema.optional(
    Schema.Array(
      Schema.Struct({
        email: Schema.String,
        displayName: Schema.optional(Schema.String),
        optional: Schema.optional(Schema.Boolean)
      })
    )
  ),
  transparency: Schema.optional(Schema.Literal("opaque", "transparent")),
  visibility: Schema.optional(Schema.Literal("default", "public", "private", "confidential"))
}) {}

// --- Calendars -------------------------------------------------------------------------------

export class GoogleCalendarInfo extends Schema.Class<GoogleCalendarInfo>("GoogleCalendarInfo")({
  id: Schema.String,
  summary: Schema.String,
  description: Schema.optional(Schema.String),
  timeZone: Schema.optional(Schema.String),
  /** The CALLING account's own access role on this calendar — `"none"` never appears in a real
   *  `calendarList.list()`/`calendarList.get()` response (a calendar with no access isn't listed
   *  at all), but is retained as a value here since Strategy B's ACL check (observer-
   *  verification.ts) treats "role missing/unresolvable" the same as `"none"`. */
  accessRole: Schema.optional(Schema.Literal("none", "freeBusyReader", "reader", "writer", "owner")),
  primary: Schema.optional(Schema.Boolean)
}) {}

// --- events.list page ------------------------------------------------------------------------

/**
 * ONE page of `events.list` — deliberately NOT auto-paginated inside `GoogleCalendarClient` (a
 * departure from cloudflare-os's `GoogleCalendarApi#listEvents`, which loops internally to return
 * a fully-materialized array). See docs/gatekeeper-google-calendar-decisions.md §1's "Pagination
 * discipline" section for the full rationale — short version: new-notes' cited pattern
 * (`docs/architecture.md` §"Google Calendar provider projection") applies one SQLite transaction
 * PER PAGE ("One SQLite transaction applies a page's provider-managed structured records and its
 * next checkpoint... A crash before that cross-object commit resumes the immutable range before
 * fetching another page"), which requires the caller (the future Gatekeeper DO / calendar-merge
 * logic) to drive pagination itself, page-token-at-a-time, not receive an already-fully-paginated
 * array with no per-page commit point.
 */
export class CalendarEventsPage extends Schema.Class<CalendarEventsPage>("CalendarEventsPage")({
  items: Schema.Array(CalendarEvent),
  /** Present when more pages remain in THIS sync/list operation — pass back as `pageToken`. */
  nextPageToken: Schema.optional(Schema.String),
  /**
   * Present only on the LAST page of a sync-token-driven list (i.e. once `nextPageToken` is
   * absent) — per Google's docs, `nextSyncToken` is returned "once you've received all the
   * changes" (this stage's WebFetch verification: `nextPageToken`/`nextSyncToken` are mutually
   * present/absent). Absent when this page was `timeMin`/`timeMax`-driven (an initial/full sync
   * window, not `syncToken`-driven) — that mode never yields a sync token per Google's own
   * "cannot be used with syncToken" restriction on `timeMin`/`timeMax`.
   */
  nextSyncToken: Schema.optional(Schema.String)
}) {}

// --- Free/busy -------------------------------------------------------------------------------

export class CalendarBusyBlock extends Schema.Class<CalendarBusyBlock>("CalendarBusyBlock")({
  start: Schema.String,
  end: Schema.String
}) {}

export class PersonAvailability extends Schema.Class<PersonAvailability>("PersonAvailability")({
  /** The calendar id / email address that was queried. */
  id: Schema.String,
  busy: Schema.Array(CalendarBusyBlock),
  /** One of Google's documented `freeBusy` error reasons (verified this stage: `"notFound"`,
   *  `"groupTooBig"`, `"tooManyCalendarsRequested"`, `"internalError"`) when this calendar's
   *  availability could not be read — e.g. the queried account has no visibility into it at all,
   *  the exact signal Strategy B/C's `hasFreeBusyAccess` check below keys on. */
  error: Schema.optional(Schema.String)
}) {}

// --- OAuth -----------------------------------------------------------------------------------

export class OAuthTokens extends Schema.Class<OAuthTokens>("OAuthTokens")({
  accessToken: Schema.String,
  /** Seconds from "now" (request time), NOT an absolute timestamp — mirrors the token endpoint's
   *  own `expires_in` field name/shape directly rather than pre-resolving it, so the caller
   *  chooses its own clock/skew discipline (see `google-calendar-client-real.ts`'s
   *  `ACCESS_TOKEN_EXPIRY_SAFETY_MS`-equivalent comment for why resolving here would bake in an
   *  assumption this package shouldn't make on the caller's behalf). */
  expiresInSeconds: Schema.Number,
  /** Present on the FIRST authorization-code exchange only (with `access_type=offline`), per
   *  Google's own documented behavior ("only present... the first time your application exchanges
   *  an authorization code") — absent on every `refreshAccessToken` response and on a later
   *  `exchangeAuthorizationCode` call for an account that already granted offline access. Absent
   *  is a real, expected outcome the caller (whoever persists the refresh token) must handle by
   *  keeping the ORIGINAL refresh token, not by treating this as an error. */
  refreshToken: Schema.optional(Schema.String),
  /** Space-delimited scopes Google actually granted, split — may be a strict subset of what was
   *  requested (the user can decline individual scopes in the consent screen). */
  grantedScopes: Schema.Array(Schema.String)
}) {}
