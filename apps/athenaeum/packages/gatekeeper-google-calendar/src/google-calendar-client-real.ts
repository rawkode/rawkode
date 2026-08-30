// `GoogleCalendarClientReal` — a real HTTP client against Google's actual OAuth2 + Calendar API v3
// endpoints. Request/response shapes verified this stage against Google's own current
// documentation (WebFetch — see each method's doc comment for the exact page + what was
// confirmed), not guessed and not merely trusted from cloudflare-os's implementation (though it
// corroborates: `cloudflare-os/packages/gatekeeper-google/src/google-api.ts` +
// `calendar-api.ts` use the identical endpoints/params/response fields).
//
// **No real Google OAuth client id/secret exists in this environment** (hard constraint) — this
// Layer is real and correctly-shaped, and genuinely unreachable without configuration:
// `makeGoogleCalendarClientRealLive({clientId: undefined, clientSecret: undefined})` fails every
// method that needs a credential with `GoogleCalendarNotConfigured` before attempting any network
// I/O, and is never exercised end-to-end against the real API here. It IS exercised against a
// mocked `HttpFetch` layer (`test/google-calendar-client-real.test.ts`) to prove the request-
// building/response-parsing logic independently of network access — mirrors
// `model-client-anthropic.ts`'s own header comment on the identical constraint, verbatim in
// spirit. **A real live-API integration test is explicitly not possible in this environment.**
//
// What David would need to register in Google Cloud Console to make this real (full detail in
// docs/gatekeeper-google-calendar-decisions.md §1's "Enabling this for real" section):
//   1. A Google Cloud project with the Calendar API enabled (APIs & Services → Library →
//      "Google Calendar API" → Enable).
//   2. An OAuth 2.0 Client ID (APIs & Services → Credentials → Create Credentials → OAuth client
//      ID → Web application), giving `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`.
//   3. An OAuth consent screen configured with at least the
//      `https://www.googleapis.com/auth/calendar` scope (or `.../calendar.readonly` for a
//      read-only binding) — and `.../calendar.calendarlist.readonly` if the calendar-picker flow
//      (`listCalendars`) is used.
//   4. This Worker's real deployed callback URL added to the client's "Authorized redirect URIs"
//      list, byte-for-byte (Google's own documented requirement) — e.g.
//      `https://<router-host>/gatekeeper/google-calendar/oauth/callback`, matching whatever route
//      the next stage's OAuth-flow orchestration actually serves it on.
//   5. `wrangler secret put GOOGLE_OAUTH_CLIENT_ID` / `wrangler secret put
//      GOOGLE_OAUTH_CLIENT_SECRET` on the real deployment (never plaintext `vars` — see
//      `wrangler.jsonc`'s own comment).

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  CalendarAttendee,
  CalendarBusyBlock,
  CalendarEvent,
  type CalendarEventDraft,
  type CalendarEventPatch,
  CalendarEventsPage,
  type CalendarSendUpdates,
  type CalendarTime,
  GoogleCalendarInfo,
  OAuthTokens,
  PersonAvailability
} from "./calendar-types.js"
import {
  GoogleCalendarAuthFailed,
  GoogleCalendarNotConfigured,
  GoogleCalendarRequestFailed,
  GoogleCalendarResponseInvalid,
  GoogleCalendarSyncTokenExpired,
  type GoogleCalendarClientError
} from "./errors.js"
import { HttpFetch } from "./http-fetch.js"
import { type AuthorizationUrlOptions, type CalendarEventsListQuery, GoogleCalendarClient } from "./google-calendar-client.js"

const OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3"
const FREEBUSY_URL = `${CALENDAR_API_BASE}/freeBusy`

export interface GoogleCalendarClientRealConfig {
  /** The real secrets, read by the caller from wherever they live (Worker secret bindings, per
   *  the plan's own phrasing) — `undefined` in every environment that hasn't configured them,
   *  including this one. */
  readonly clientId: string | undefined
  readonly clientSecret: string | undefined
}

// --- Shared HTTP plumbing -----------------------------------------------------------------------

const notConfigured = (missing: string): GoogleCalendarNotConfigured =>
  new GoogleCalendarNotConfigured({
    message: `GoogleCalendarClientReal: ${missing} is not configured (no real Google OAuth credential in this environment)`
  })

/** Parses a token-endpoint (or general Calendar API) JSON error body, distinguishing the OAuth
 *  error codes that mean "the credential itself is bad" from a generic non-2xx failure — verified
 *  this stage against Google's docs: `invalid_grant` and `admin_policy_enforced` are the two
 *  documented codes worth a caller branching on (mirrors `cloudflare-os/google-api.ts#getAccessToken`'s
 *  own `RefreshFailure` categorization, generalized to the code-exchange call too). */
const readGoogleErrorBody = (
  response: Response
): Effect.Effect<{ error?: string; error_description?: string } | undefined, never> =>
  Effect.tryPromise(() => response.json() as Promise<{ error?: string; error_description?: string }>).pipe(
    Effect.catchAll(() => Effect.succeed(undefined))
  )

const tokenEndpointFailure = (
  response: Response,
  body: { error?: string; error_description?: string } | undefined
): GoogleCalendarClientError => {
  if (body?.error === "invalid_grant") {
    return new GoogleCalendarAuthFailed({
      reason: "invalidGrant",
      message: body.error_description ?? "invalid_grant"
    })
  }
  if (body?.error === "admin_policy_enforced") {
    return new GoogleCalendarAuthFailed({
      reason: "policyBlocked",
      message: body.error_description ?? "admin_policy_enforced"
    })
  }
  if (body?.error !== undefined) {
    return new GoogleCalendarAuthFailed({
      reason: "other",
      message: `${body.error}${body.error_description ? `: ${body.error_description}` : ""}`
    })
  }
  return new GoogleCalendarRequestFailed({
    message: `Google token endpoint returned ${response.status}`,
    status: response.status
  })
}

/** One authenticated Calendar API v3 call. `accessToken` is the caller's job to have already
 *  refreshed if needed — this client never refreshes implicitly (unlike `cloudflare-os`'s
 *  `fetchWithAuthRetry`'s one-shot 401 refresh): keeping token-lifecycle policy OUT of this thin
 *  client is a deliberate scope line, documented in decisions doc §1 ("What this client does NOT
 *  do"). A 410 is surfaced as `GoogleCalendarSyncTokenExpired` only by `listEvents` itself (the
 *  one endpoint Google documents it for); every other non-2xx maps to
 *  `GoogleCalendarRequestFailed`. */
const callCalendarApi = (
  http: { readonly fetch: (url: string, init: RequestInit) => Promise<Response> },
  accessToken: string,
  url: string,
  init: RequestInit = {}
): Effect.Effect<Response, GoogleCalendarClientError> =>
  Effect.tryPromise({
    try: () =>
      http.fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${accessToken}`,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          Accept: "application/json"
        }
      }),
    catch: (cause) =>
      new GoogleCalendarRequestFailed({
        message: `request to Google Calendar API failed: ${cause instanceof Error ? cause.message : String(cause)}`
      })
  })

const decodeJsonBody = <A, I>(
  schema: Schema.Schema<A, I>,
  json: unknown
): Effect.Effect<A, GoogleCalendarResponseInvalid> =>
  Schema.decodeUnknown(schema)(json).pipe(
    Effect.mapError(
      (parseError) =>
        new GoogleCalendarResponseInvalid({
          message: `Google Calendar API response did not match the expected shape: ${parseError.message}`
        })
    )
  )

const readJson = (response: Response): Effect.Effect<unknown, GoogleCalendarResponseInvalid> =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) =>
      new GoogleCalendarResponseInvalid({
        message: `Google Calendar API response body was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`
      })
  })

// --- Calendar-time / event <-> Google wire-shape mapping ---------------------------------------
//
// Structural rename only (same discipline as `model-client-anthropic.ts`'s own
// `toAnthropicContentBlock` doc comment: `calendar-types.ts`'s shapes are already the right
// generalization of Google's own resource shape — verified field-for-field against
// `https://developers.google.com/calendar/api/v3/reference/events` this stage).

interface GoogleCalendarTime {
  readonly date?: string
  readonly dateTime?: string
  readonly timeZone?: string
}

interface GoogleEventWire {
  readonly id: string
  readonly summary?: string
  readonly updated?: string
  readonly description?: string
  readonly location?: string
  readonly start?: GoogleCalendarTime
  readonly end?: GoogleCalendarTime
  readonly status?: "confirmed" | "tentative" | "cancelled"
  readonly attendees?: ReadonlyArray<{
    readonly email: string
    readonly displayName?: string
    readonly optional?: boolean
    readonly responseStatus?: "needsAction" | "declined" | "tentative" | "accepted"
    readonly organizer?: boolean
    readonly self?: boolean
  }>
  readonly htmlLink?: string
  readonly transparency?: "opaque" | "transparent"
  readonly visibility?: "default" | "public" | "private" | "confidential"
  readonly recurringEventId?: string
}

const calendarTimeFromGoogle = (value: GoogleCalendarTime | undefined): CalendarTime => {
  if (value?.date !== undefined) return { kind: "date", date: value.date }
  if (value?.dateTime !== undefined) {
    return { kind: "dateTime", dateTime: value.dateTime, ...(value.timeZone ? { timeZone: value.timeZone } : {}) }
  }
  // Malformed per Google's own contract (every event has a start/end with one or the other) —
  // this should be unreachable against a real response; fails the decode explicitly rather than
  // silently fabricating an epoch date the way a looser port might.
  return { kind: "date", date: "1970-01-01" }
}

const calendarTimeToGoogle = (value: CalendarTime): GoogleCalendarTime =>
  value.kind === "date"
    ? { date: value.date }
    : { dateTime: value.dateTime, ...(value.timeZone ? { timeZone: value.timeZone } : {}) }

const calendarEventFromGoogleWire = (event: GoogleEventWire): CalendarEvent =>
  new CalendarEvent({
    id: event.id,
    title: event.summary ?? "(no title)",
    ...(event.updated ? { updatedAt: event.updated } : {}),
    start: calendarTimeFromGoogle(event.start),
    end: calendarTimeFromGoogle(event.end),
    status: event.status ?? "confirmed",
    ...(event.location ? { location: event.location } : {}),
    ...(event.description ? { description: event.description } : {}),
    ...(event.attendees
      ? { attendees: event.attendees.map((a) => new CalendarAttendee(a)) }
      : {}),
    ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
    ...(event.transparency ? { transparency: event.transparency } : {}),
    ...(event.visibility ? { visibility: event.visibility } : {}),
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {})
  })

const draftToGoogleWire = (draft: CalendarEventDraft): Record<string, unknown> => ({
  summary: draft.title,
  start: calendarTimeToGoogle(draft.start),
  end: calendarTimeToGoogle(draft.end),
  ...(draft.description ? { description: draft.description } : {}),
  ...(draft.location ? { location: draft.location } : {}),
  ...(draft.attendees ? { attendees: draft.attendees } : {}),
  ...(draft.transparency ? { transparency: draft.transparency } : {}),
  ...(draft.visibility ? { visibility: draft.visibility } : {}),
  ...(draft.reminders ? { reminders: { useDefault: false, overrides: draft.reminders } } : {})
})

const patchToGoogleWire = (patch: CalendarEventPatch): Record<string, unknown> => {
  const body: Record<string, unknown> = {}
  if (patch.title !== undefined) body.summary = patch.title
  if (patch.start !== undefined) body.start = calendarTimeToGoogle(patch.start)
  if (patch.end !== undefined) body.end = calendarTimeToGoogle(patch.end)
  if (patch.description !== undefined) body.description = patch.description
  if (patch.location !== undefined) body.location = patch.location
  if (patch.attendees !== undefined) body.attendees = patch.attendees
  if (patch.transparency !== undefined) body.transparency = patch.transparency
  if (patch.visibility !== undefined) body.visibility = patch.visibility
  return body
}

const sendUpdatesParam = (value: CalendarSendUpdates | undefined): string => value ?? "all"

// --- The Layer -----------------------------------------------------------------------------

export const makeGoogleCalendarClientRealLive = (
  config: GoogleCalendarClientRealConfig
): Layer.Layer<GoogleCalendarClient, never, HttpFetch> =>
  Layer.effect(
    GoogleCalendarClient,
    Effect.gen(function* () {
      const http = yield* HttpFetch

      const requireCredentials = (): Effect.Effect<
        { readonly clientId: string; readonly clientSecret: string },
        GoogleCalendarNotConfigured
      > =>
        config.clientId === undefined || config.clientId.length === 0
          ? Effect.fail(notConfigured("GOOGLE_OAUTH_CLIENT_ID"))
          : config.clientSecret === undefined || config.clientSecret.length === 0
            ? Effect.fail(notConfigured("GOOGLE_OAUTH_CLIENT_SECRET"))
            : Effect.succeed({ clientId: config.clientId, clientSecret: config.clientSecret })

      // https://developers.google.com/identity/protocols/oauth2/web-server (verified this stage).
      const buildAuthorizationUrl = (options: AuthorizationUrlOptions) =>
        requireCredentials().pipe(
          Effect.map(({ clientId }) => {
            const url = new URL(OAUTH_AUTHORIZE_URL)
            url.searchParams.set("client_id", clientId)
            url.searchParams.set("redirect_uri", options.redirectUri)
            url.searchParams.set("response_type", "code")
            url.searchParams.set("scope", options.scopes.join(" "))
            // Always "offline": this package's only use case is a durable server-side connection
            // (see AuthorizationUrlOptions' own doc comment) — an "online" grant would be useless
            // for the recurring hourly-reconciliation sync new-notes' cited pattern describes.
            url.searchParams.set("access_type", "offline")
            url.searchParams.set("include_granted_scopes", "true")
            if (options.forceConsent) url.searchParams.set("prompt", "consent")
            url.searchParams.set("state", options.state)
            return { url: url.toString() }
          })
        )

      const tokenRequest = (
        params: Record<string, string>
      ): Effect.Effect<OAuthTokens, GoogleCalendarClientError> =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: () =>
              http.fetch(OAUTH_TOKEN_URL, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams(params).toString()
              }),
            catch: (cause) =>
              new GoogleCalendarRequestFailed({
                message: `request to Google's OAuth token endpoint failed: ${cause instanceof Error ? cause.message : String(cause)}`
              })
          })

          if (!response.ok) {
            const body = yield* readGoogleErrorBody(response)
            return yield* Effect.fail(tokenEndpointFailure(response, body))
          }

          const json = yield* readJson(response)
          const raw = json as {
            access_token?: unknown
            expires_in?: unknown
            refresh_token?: unknown
            scope?: unknown
          }
          if (typeof raw.access_token !== "string" || typeof raw.expires_in !== "number") {
            return yield* Effect.fail(
              new GoogleCalendarResponseInvalid({
                message: "Google token endpoint response missing access_token/expires_in"
              })
            )
          }
          return new OAuthTokens({
            accessToken: raw.access_token,
            expiresInSeconds: raw.expires_in,
            ...(typeof raw.refresh_token === "string" ? { refreshToken: raw.refresh_token } : {}),
            grantedScopes: typeof raw.scope === "string" ? raw.scope.split(" ").filter(Boolean) : []
          })
        })

      // https://developers.google.com/identity/protocols/oauth2/web-server, "Exchange authorization
      // code for refresh and access tokens" (verified this stage).
      const exchangeAuthorizationCode = (code: string, redirectUri: string) =>
        requireCredentials().pipe(
          Effect.flatMap(({ clientId, clientSecret }) =>
            tokenRequest({
              code,
              client_id: clientId,
              client_secret: clientSecret,
              redirect_uri: redirectUri,
              grant_type: "authorization_code"
            })
          )
        )

      // Same endpoint, `grant_type=refresh_token` — verified this stage.
      const refreshAccessToken = (refreshToken: string) =>
        requireCredentials().pipe(
          Effect.flatMap(({ clientId, clientSecret }) =>
            tokenRequest({
              client_id: clientId,
              client_secret: clientSecret,
              refresh_token: refreshToken,
              grant_type: "refresh_token"
            })
          )
        )

      // https://developers.google.com/calendar/api/v3/reference/events/list (verified this stage
      // — see CalendarEventsListQuery's own doc comment for the syncToken-vs-window restriction
      // this method's TYPE already enforces, and GoogleCalendarSyncTokenExpired's doc comment for
      // the documented 410 behavior this method surfaces).
      const listEvents = (accessToken: string, calendarId: string, query: CalendarEventsListQuery) =>
        Effect.gen(function* () {
          const params = new URLSearchParams()
          params.set("singleEvents", String(query.singleEvents))
          if (query.mode === "window") {
            params.set("timeMin", query.timeMin)
            params.set("timeMax", query.timeMax)
            params.set("showDeleted", String(query.showDeleted))
            if (query.maxResults !== undefined) params.set("maxResults", String(query.maxResults))
          } else {
            params.set("syncToken", query.syncToken)
          }
          if (query.pageToken !== undefined) params.set("pageToken", query.pageToken)

          const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`
          const response = yield* callCalendarApi(http, accessToken, url)

          if (response.status === 410) {
            return yield* Effect.fail(new GoogleCalendarSyncTokenExpired({ calendarId }))
          }
          if (!response.ok) {
            const text = yield* Effect.tryPromise(() => response.text()).pipe(
              Effect.catchAll(() => Effect.succeed("<unreadable body>"))
            )
            return yield* Effect.fail(
              new GoogleCalendarRequestFailed({
                message: `Google Calendar events.list returned ${response.status}: ${text}`,
                status: response.status
              })
            )
          }

          const json = yield* readJson(response)
          const raw = json as { items?: ReadonlyArray<GoogleEventWire>; nextPageToken?: string; nextSyncToken?: string }
          return new CalendarEventsPage({
            items: (raw.items ?? []).map(calendarEventFromGoogleWire),
            ...(raw.nextPageToken ? { nextPageToken: raw.nextPageToken } : {}),
            ...(raw.nextSyncToken ? { nextSyncToken: raw.nextSyncToken } : {})
          })
        })

      const eventUrl = (calendarId: string, eventId: string): string =>
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`

      const requireOkEventResponse = (
        response: Response
      ): Effect.Effect<CalendarEvent, GoogleCalendarClientError> =>
        Effect.gen(function* () {
          if (!response.ok) {
            const text = yield* Effect.tryPromise(() => response.text()).pipe(
              Effect.catchAll(() => Effect.succeed("<unreadable body>"))
            )
            return yield* Effect.fail(
              new GoogleCalendarRequestFailed({
                message: `Google Calendar API returned ${response.status}: ${text}`,
                status: response.status
              })
            )
          }
          const json = yield* readJson(response)
          return calendarEventFromGoogleWire(json as GoogleEventWire)
        })

      // https://developers.google.com/calendar/api/v3/reference/events/get (verified this stage).
      const getEvent = (accessToken: string, calendarId: string, eventId: string) =>
        callCalendarApi(http, accessToken, eventUrl(calendarId, eventId)).pipe(
          Effect.flatMap(requireOkEventResponse)
        )

      // https://developers.google.com/calendar/api/v3/reference/events/insert (verified this
      // stage: same Event resource shape for request/response, sendUpdates accepted values).
      const createEvent = (
        accessToken: string,
        calendarId: string,
        draft: CalendarEventDraft,
        options?: { readonly sendUpdates?: CalendarSendUpdates }
      ) =>
        callCalendarApi(
          http,
          accessToken,
          `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${sendUpdatesParam(options?.sendUpdates)}`,
          { method: "POST", body: JSON.stringify(draftToGoogleWire(draft)) }
        ).pipe(Effect.flatMap(requireOkEventResponse))

      // https://developers.google.com/calendar/api/v3/reference/events/patch (verified this stage).
      const updateEvent = (
        accessToken: string,
        calendarId: string,
        eventId: string,
        patch: CalendarEventPatch,
        options?: { readonly sendUpdates?: CalendarSendUpdates }
      ) =>
        callCalendarApi(
          http,
          accessToken,
          `${eventUrl(calendarId, eventId)}?sendUpdates=${sendUpdatesParam(options?.sendUpdates)}`,
          { method: "PATCH", body: JSON.stringify(patchToGoogleWire(patch)) }
        ).pipe(Effect.flatMap(requireOkEventResponse))

      // https://developers.google.com/calendar/api/v3/reference/events/delete (verified this stage).
      const deleteEvent = (
        accessToken: string,
        calendarId: string,
        eventId: string,
        options?: { readonly sendUpdates?: CalendarSendUpdates }
      ) =>
        callCalendarApi(
          http,
          accessToken,
          `${eventUrl(calendarId, eventId)}?sendUpdates=${sendUpdatesParam(options?.sendUpdates)}`,
          { method: "DELETE" }
        ).pipe(
          Effect.flatMap((response) =>
            response.ok || response.status === 410 // already gone is fine — deletion is idempotent
              ? Effect.void
              : Effect.tryPromise(() => response.text())
                  .pipe(Effect.catchAll(() => Effect.succeed("<unreadable body>")))
                  .pipe(
                    Effect.flatMap((text) =>
                      Effect.fail(
                        new GoogleCalendarRequestFailed({
                          message: `Google Calendar events.delete returned ${response.status}: ${text}`,
                          status: response.status
                        })
                      )
                    )
                  )
          )
        )

      // https://developers.google.com/calendar/api/v3/reference/calendarList/list (fields
      // narrowed the same way cloudflare-os's own listCalendars does — a bounded, user-facing
      // picker list, so auto-paginating internally up to a cap is fine here, unlike events.list's
      // potentially-unbounded, incrementally-synced dataset, which stays page-at-a-time).
      const listCalendars = (accessToken: string) =>
        Effect.gen(function* () {
          const collected: Array<GoogleCalendarInfo> = []
          let pageToken: string | undefined
          const cap = 250
          do {
            const params = new URLSearchParams({
              maxResults: "250",
              minAccessRole: "writer",
              fields: "items(id,summary,description,timeZone,accessRole,primary),nextPageToken"
            })
            if (pageToken !== undefined) params.set("pageToken", pageToken)
            const response = yield* callCalendarApi(
              http,
              accessToken,
              `${CALENDAR_API_BASE}/users/me/calendarList?${params}`
            )
            if (!response.ok) {
              return yield* Effect.fail(
                new GoogleCalendarRequestFailed({
                  message: `Google Calendar calendarList.list returned ${response.status}`,
                  status: response.status
                })
              )
            }
            const json = yield* readJson(response)
            const raw = json as { items?: ReadonlyArray<Record<string, unknown>>; nextPageToken?: string }
            for (const item of raw.items ?? []) collected.push(yield* decodeJsonBody(GoogleCalendarInfo, item))
            pageToken = raw.nextPageToken
          } while (pageToken !== undefined && collected.length < cap)
          return collected.slice(0, cap)
        })

      // https://developers.google.com/calendar/api/v3/reference/calendarList/get (verified this
      // stage) — the calendar's OWN `accessRole` field is exactly Strategy B's ACL check.
      const getCalendar = (accessToken: string, calendarId: string) =>
        callCalendarApi(
          http,
          accessToken,
          `${CALENDAR_API_BASE}/users/me/calendarList/${encodeURIComponent(calendarId)}`
        ).pipe(
          Effect.flatMap((response) =>
            Effect.gen(function* () {
              if (!response.ok) {
                return yield* Effect.fail(
                  new GoogleCalendarRequestFailed({
                    message: `Google Calendar calendarList.get returned ${response.status}`,
                    status: response.status
                  })
                )
              }
              const json = yield* readJson(response)
              return yield* decodeJsonBody(GoogleCalendarInfo, json)
            })
          )
        )

      // https://developers.google.com/calendar/api/v3/reference/freebusy/query (verified this
      // stage: request {timeMin,timeMax,items:[{id}]}, response calendars:{[id]:{busy,errors}}).
      const freeBusy = (
        accessToken: string,
        calendarIds: ReadonlyArray<string>,
        timeMin: string,
        timeMax: string
      ) =>
        callCalendarApi(http, accessToken, FREEBUSY_URL, {
          method: "POST",
          body: JSON.stringify({ timeMin, timeMax, items: calendarIds.map((id) => ({ id })) })
        }).pipe(
          Effect.flatMap((response) =>
            Effect.gen(function* () {
              if (!response.ok) {
                return yield* Effect.fail(
                  new GoogleCalendarRequestFailed({
                    message: `Google Calendar freeBusy.query returned ${response.status}`,
                    status: response.status
                  })
                )
              }
              const json = yield* readJson(response)
              const raw = json as {
                calendars?: Record<
                  string,
                  { busy?: ReadonlyArray<{ start: string; end: string }>; errors?: ReadonlyArray<{ reason?: string; domain?: string }> }
                >
              }
              const calendars = raw.calendars ?? {}
              return calendarIds.map((id) => {
                const entry = calendars[id]
                const error = entry === undefined ? "notFound" : entry.errors?.[0]?.reason ?? entry.errors?.[0]?.domain
                return new PersonAvailability({
                  id,
                  busy: (entry?.busy ?? []).map((b) => new CalendarBusyBlock({ start: b.start, end: b.end })),
                  ...(error !== undefined ? { error } : {})
                })
              })
            })
          )
        )

      return {
        buildAuthorizationUrl,
        exchangeAuthorizationCode,
        refreshAccessToken,
        listEvents,
        getEvent,
        createEvent,
        updateEvent,
        deleteEvent,
        listCalendars,
        getCalendar,
        freeBusy
      }
    })
  )
