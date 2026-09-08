// `GoogleCalendarClient` — the pluggable Google Calendar API client interface (task item 1). Same
// split as `@athenaeum/domain`'s `ModelClient`/`ModelClientAnthropic`/`ModelClientScripted`: this
// file owns only the *interface* (a `Context.Tag`, zero HTTP/env dependencies), with two real
// `Layer` implementations in sibling files. See docs/gatekeeper-google-calendar-decisions.md §1
// for the full design writeup (pagination discipline, OAuth flow shape, what's verified against
// Google's real docs vs. what genuinely cannot be tested without a live key here).
//
// Covers, per the task's explicit list: OAuth authorization-URL construction, authorization-code-
// for-tokens exchange, refresh-token flow, `events.list` (syncToken/pageToken/timeMin/timeMax/
// singleEvents/showDeleted — see `CalendarEventsListQuery`'s own doc comment for why this is a
// discriminated union, not five independent optional fields), and single-event CRUD. Also
// `listCalendars`/`getCalendar` (calendar picker + Strategy B's ACL check) and `freeBusy`
// (Strategy C's per-calendar access oracle) — both needed by `observer-verification.ts`, and both
// real Calendar API v3 methods cloudflare-os's own `GoogleCalendarApi` already established as
// necessary for exactly this purpose (`hasFreeBusyAccess`, `calendarPickerRank`).

import type * as Effect from "effect/Effect"
import * as Context from "effect/Context"
import {
  type CalendarEvent,
  type CalendarEventDraft,
  type CalendarEventPatch,
  type CalendarEventsPage,
  type CalendarSendUpdates,
  type GoogleCalendarInfo,
  type OAuthTokens,
  type PersonAvailability
} from "./calendar-types.js"
import type { GoogleCalendarClientError } from "./errors.js"

// --- OAuth -----------------------------------------------------------------------------------

export interface AuthorizationUrlOptions {
  /** Opaque CSRF/session-binding value round-tripped through the `state` query parameter — the
   *  caller's job to generate and verify (mirrors cloudflare-os's own `generateNonce()`/`state`
   *  discipline in `google.ts`; this package does not mint or validate it, matching this package's
   *  "client, not the whole OAuth flow orchestrator" scope — see decisions doc §1). */
  readonly state: string
  /** Exact registered redirect URI — MUST byte-for-byte match a URI registered in Google Cloud
   *  Console for this OAuth client (Google's own documented requirement: "case, and trailing
   *  slash must all match"). */
  readonly redirectUri: string
  /** OAuth scopes to request, space-joined by this method — at minimum
   *  `https://www.googleapis.com/auth/calendar` (read/write) or `.../calendar.readonly`,
   *  plus `.../calendar.calendarlist.readonly` if the calendar-picker flow (`listCalendars`)
   *  is used at connect time. */
  readonly scopes: ReadonlyArray<string>
  /** Forces the consent screen even if previously granted — set `true` on a fresh connect so a
   *  refresh token is reliably issued (see `OAuthTokens.refreshToken`'s own doc comment: Google
   *  only issues one on request `access_type=offline`, and re-prompts inconsistently without
   *  `prompt=consent` if scopes were already granted once). */
  readonly forceConsent?: boolean
}

// --- events.list query -------------------------------------------------------------------------

/**
 * `events.list`'s query parameters, encoded as a discriminated union so the TWO valid modes are
 * the only ones representable — Google's own documented restriction (verified this stage,
 * `https://developers.google.com/calendar/api/v3/reference/events/list`): `syncToken` cannot be
 * combined with `timeMin`, `timeMax`, `showDeleted`, `orderBy`, `updatedMin`, `q`, or the
 * extended-property/iCalUID filters — "several query parameters... cannot be specified together
 * with syncToken to ensure consistency of the client state." A caller cannot accidentally
 * construct the illegal combination; the type system rules it out. `singleEvents` is NOT in
 * Google's restricted list (confirmed) and applies to both modes — new-notes' cited pattern
 * (`docs/architecture.md` §"Google Calendar provider projection") always sends `true`, so both
 * variants require it explicitly rather than defaulting it, forcing every call site to make the
 * choice visible.
 *
 * "window" mode is the initial/full(-window) sync — `showDeleted: true` per new-notes' cited
 * pattern, so tombstones inside the window are visible on first sync. "syncToken" mode is every
 * subsequent incremental sync — deleted events surface automatically as `status: "cancelled"`
 * without `showDeleted` (Google folds deletions into sync-token results unconditionally; that's
 * exactly why `showDeleted` is disallowed alongside it, not an oversight).
 */
export type CalendarEventsListQuery =
  | {
      readonly mode: "window"
      readonly timeMin: string
      readonly timeMax: string
      readonly singleEvents: boolean
      readonly showDeleted: boolean
      readonly pageToken?: string
      readonly maxResults?: number
    }
  | {
      readonly mode: "syncToken"
      readonly syncToken: string
      readonly singleEvents: boolean
      readonly pageToken?: string
    }

// --- Single-event CRUD options ------------------------------------------------------------------

export interface SendUpdatesOptions {
  readonly sendUpdates?: CalendarSendUpdates
}

// --- The service -----------------------------------------------------------------------------

export interface GoogleCalendarClientApi {
  /** Builds the URL to send the user's browser to, per Google's OAuth2 authorization-code flow
   *  (verified this stage against `https://developers.google.com/identity/protocols/oauth2/web-
   *  server`): `https://accounts.google.com/o/oauth2/v2/auth` with `client_id`, `redirect_uri`,
   *  `response_type=code`, `scope`, `access_type=offline` (always — this package's only use case
   *  is a durable server-side connection, so online-only tokens are never useful),
   *  `include_granted_scopes=true`, and `state`. Pure URL construction — no network I/O, so this
   *  is the one method that works identically whether or not real credentials are configured
   *  UNLESS `clientId` itself is unconfigured, in which case it fails the same way every other
   *  method does (see `GoogleCalendarClientReal`'s own doc comment). */
  readonly buildAuthorizationUrl: (
    options: AuthorizationUrlOptions
  ) => Effect.Effect<{ readonly url: string }, GoogleCalendarClientError>

  /** Exchanges an authorization code for tokens — `POST https://oauth2.googleapis.com/token`,
   *  `grant_type=authorization_code`. `redirectUri` MUST be the exact same value passed to
   *  `buildAuthorizationUrl` (Google validates it matches). */
  readonly exchangeAuthorizationCode: (
    code: string,
    redirectUri: string
  ) => Effect.Effect<OAuthTokens, GoogleCalendarClientError>

  /** Exchanges a refresh token for a fresh access token — same token endpoint,
   *  `grant_type=refresh_token`. Never returns a NEW refresh token (Google's token endpoint does
   *  not rotate refresh tokens on this grant type) — `OAuthTokens.refreshToken` is always absent
   *  on this method's result; callers keep using the original. */
  readonly refreshAccessToken: (
    refreshToken: string
  ) => Effect.Effect<OAuthTokens, GoogleCalendarClientError>

  /** One page of events on `calendarId`. See `CalendarEventsListQuery`'s own doc comment for the
   *  two valid query modes and why pagination is caller-driven (page-at-a-time), not
   *  auto-looped inside this method. Fails `GoogleCalendarSyncTokenExpired` on Google's documented
   *  410 response for an expired `syncToken` — the caller's remediation (new-notes' cited pattern:
   *  clear the stored token, install a fresh bounded window, retry once in "window" mode) is
   *  deliberately NOT built into this method; it is exactly the kind of "gatekeeper's own storage
   *  and retry policy" logic this package's client/observer split keeps out of the client (see
   *  decisions doc §1). */
  readonly listEvents: (
    accessToken: string,
    calendarId: string,
    query: CalendarEventsListQuery
  ) => Effect.Effect<CalendarEventsPage, GoogleCalendarClientError>

  readonly getEvent: (
    accessToken: string,
    calendarId: string,
    eventId: string
  ) => Effect.Effect<CalendarEvent, GoogleCalendarClientError>

  readonly createEvent: (
    accessToken: string,
    calendarId: string,
    draft: CalendarEventDraft,
    options?: SendUpdatesOptions
  ) => Effect.Effect<CalendarEvent, GoogleCalendarClientError>

  /** Only the fields set on `patch` are changed (Google's own field-level PATCH semantics) —
   *  EXCEPT `attendees`, which (per Google's docs and `CalendarEventPatch`'s own doc comment) is
   *  always a full replacement, never a merge. */
  readonly updateEvent: (
    accessToken: string,
    calendarId: string,
    eventId: string,
    patch: CalendarEventPatch,
    options?: SendUpdatesOptions
  ) => Effect.Effect<CalendarEvent, GoogleCalendarClientError>

  readonly deleteEvent: (
    accessToken: string,
    calendarId: string,
    eventId: string,
    options?: SendUpdatesOptions
  ) => Effect.Effect<void, GoogleCalendarClientError>

  /** Calendars the account has write-or-better access to (`minAccessRole=writer`) — the picker
   *  list shown when the user selects which calendar to bind. */
  readonly listCalendars: (
    accessToken: string
  ) => Effect.Effect<ReadonlyArray<GoogleCalendarInfo>, GoogleCalendarClientError>

  /** Metadata for exactly one calendar, INCLUDING the calling account's own `accessRole` on it —
   *  Strategy B's (`observer-verification.ts`) primary check: "does the observer's own account
   *  have writer/owner on THIS calendar." */
  readonly getCalendar: (
    accessToken: string,
    calendarId: string
  ) => Effect.Effect<GoogleCalendarInfo, GoogleCalendarClientError>

  /** `POST https://www.googleapis.com/calendar/v3/freeBusy` — busy-block-only availability for
   *  one or more calendars/people, never event details. Strategy C's per-calendar access oracle:
   *  a calendar the queried account cannot see returns `error: "notFound"` (or another documented
   *  reason) in that entry rather than failing the whole call, which is exactly what lets a
   *  caller check "can THIS observer see availability for THAT calendar" without a special-cased
   *  single-calendar method (mirrors cloudflare-os's own `hasFreeBusyAccess`, which is a thin
   *  wrapper over this same primitive). */
  readonly freeBusy: (
    accessToken: string,
    calendarIds: ReadonlyArray<string>,
    timeMin: string,
    timeMax: string
  ) => Effect.Effect<ReadonlyArray<PersonAvailability>, GoogleCalendarClientError>
}

export class GoogleCalendarClient extends Context.Tag(
  "@athenaeum/gatekeeper-google-calendar/GoogleCalendarClient"
)<GoogleCalendarClient, GoogleCalendarClientApi>() {}
