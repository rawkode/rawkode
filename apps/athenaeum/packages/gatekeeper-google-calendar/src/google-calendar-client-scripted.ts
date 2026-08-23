// `GoogleCalendarClientScripted` — a deterministic test double, no network dependency. Same shape
// as `@athenaeum/backend`'s `model-client-scripted.ts`: a factory a test calls once per test case
// (never a module-level mutable queue — see that file's own doc comment for why), returning a
// `Layer` plus a handle exposing recorded calls and a fixture-mutation API, so the REST of the
// gatekeeper (observer-verification.ts, and the future calendar-merge/session logic) can be tested
// without any real Google account or network dependency.
//
// Fixtures model a small, fixed multiverse of Google accounts, each with its own calendars/events —
// exactly what `observer-verification.ts`'s tests need: "this observer's own account has writer
// access to calendar X" vs. "this observer's own account cannot see calendar Y's free/busy at
// all" are both expressed as different scripted accounts, addressed by `accessToken` (the scripted
// double treats `accessToken` as an opaque fixture-account key, not a real bearer token).

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  CalendarEvent,
  CalendarEventsPage,
  GoogleCalendarInfo,
  OAuthTokens,
  PersonAvailability
} from "./calendar-types.js"
import { GoogleCalendarNotConfigured, GoogleCalendarRequestFailed } from "./errors.js"
import {
  type AuthorizationUrlOptions,
  type CalendarEventsListQuery,
  type GoogleCalendarClientApi,
  GoogleCalendarClient,
  type SendUpdatesOptions
} from "./google-calendar-client.js"
import type { CalendarEventDraft, CalendarEventPatch } from "./calendar-types.js"

/** One scripted Google account's fixture data — keyed by an opaque `accessToken` fixture id the
 *  test chooses (e.g. `"alice-writer-token"`), never a real bearer token. */
export interface ScriptedGoogleAccount {
  /** `calendarId -> accessRole` this account has, for `getCalendar`/`listCalendars`/Strategy B. */
  readonly calendars: Readonly<Record<string, GoogleCalendarInfo["accessRole"]>>
  /** Which calendar ids (by id, not accessRole) this account can successfully read free/busy for
   *  — Strategy C's oracle. A calendar id present in `calendars` above is NOT automatically
   *  free/busy-readable in the fixture (mirrors reality: `freeBusyReader` is its own distinct
   *  access level from `writer`/`owner` on `calendarList`) — list it here explicitly too if the
   *  fixture should allow it. */
  readonly freeBusyReadableCalendarIds: ReadonlyArray<string>
  /** Events per calendar id, for `listEvents`/`getEvent`. */
  readonly events: Readonly<Record<string, ReadonlyArray<CalendarEvent>>>
}

export interface GoogleCalendarClientScriptedFixtures {
  readonly accounts: Readonly<Record<string, ScriptedGoogleAccount>>
  /** Scripted authorization-code -> token exchange results, keyed by the `code` string a test
   *  passes to `exchangeAuthorizationCode`. */
  readonly authorizationCodes?: Readonly<Record<string, OAuthTokens>>
  /** Scripted refresh-token -> token results, keyed by the `refreshToken` string. */
  readonly refreshTokens?: Readonly<Record<string, OAuthTokens>>
}

export interface RecordedCall {
  readonly method: string
  readonly args: ReadonlyArray<unknown>
}

export interface GoogleCalendarClientScriptedHandle {
  readonly layer: Layer.Layer<GoogleCalendarClient>
  readonly calls: Array<RecordedCall>
  /** Mutable in place — a test can add/patch fixture accounts mid-run (e.g. simulate an observer
   *  losing calendar access between two `addObserver` calls) without rebuilding the Layer. */
  readonly fixtures: {
    accounts: Record<string, ScriptedGoogleAccount>
  }
}

const accountNotFound = (accessToken: string): GoogleCalendarRequestFailed =>
  new GoogleCalendarRequestFailed({
    message: `GoogleCalendarClientScripted: no fixture account for accessToken "${accessToken}"`,
    status: 401
  })

const notImplementedInScript = (method: string): GoogleCalendarNotConfigured =>
  new GoogleCalendarNotConfigured({
    message: `GoogleCalendarClientScripted: "${method}" has no scripted result configured for this call`
  })

export const makeGoogleCalendarClientScripted = (
  initialFixtures: GoogleCalendarClientScriptedFixtures
): GoogleCalendarClientScriptedHandle => {
  const fixtures = { accounts: { ...initialFixtures.accounts } }
  const calls: Array<RecordedCall> = []
  const record = (method: string, args: ReadonlyArray<unknown>) => calls.push({ method, args })

  const account = (accessToken: string): Effect.Effect<ScriptedGoogleAccount, GoogleCalendarRequestFailed> => {
    const found = fixtures.accounts[accessToken]
    return found === undefined ? Effect.fail(accountNotFound(accessToken)) : Effect.succeed(found)
  }

  const api: GoogleCalendarClientApi = {
    buildAuthorizationUrl: (options: AuthorizationUrlOptions) => {
      record("buildAuthorizationUrl", [options])
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
      url.searchParams.set("client_id", "scripted-client-id")
      url.searchParams.set("redirect_uri", options.redirectUri)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("scope", options.scopes.join(" "))
      url.searchParams.set("access_type", "offline")
      url.searchParams.set("state", options.state)
      return Effect.succeed({ url: url.toString() })
    },

    exchangeAuthorizationCode: (code: string, redirectUri: string) => {
      record("exchangeAuthorizationCode", [code, redirectUri])
      const tokens = initialFixtures.authorizationCodes?.[code]
      return tokens === undefined
        ? Effect.fail(notImplementedInScript("exchangeAuthorizationCode"))
        : Effect.succeed(tokens)
    },

    refreshAccessToken: (refreshToken: string) => {
      record("refreshAccessToken", [refreshToken])
      const tokens = initialFixtures.refreshTokens?.[refreshToken]
      return tokens === undefined
        ? Effect.fail(notImplementedInScript("refreshAccessToken"))
        : Effect.succeed(tokens)
    },

    listEvents: (accessToken: string, calendarId: string, query: CalendarEventsListQuery) => {
      record("listEvents", [accessToken, calendarId, query])
      return account(accessToken).pipe(
        Effect.map(
          (acc) => new CalendarEventsPage({ items: acc.events[calendarId] ?? [] })
        )
      )
    },

    getEvent: (accessToken: string, calendarId: string, eventId: string) => {
      record("getEvent", [accessToken, calendarId, eventId])
      return account(accessToken).pipe(
        Effect.flatMap((acc) => {
          const found = (acc.events[calendarId] ?? []).find((e) => e.id === eventId)
          return found === undefined
            ? Effect.fail(
                new GoogleCalendarRequestFailed({
                  message: `GoogleCalendarClientScripted: no fixture event "${eventId}" on calendar "${calendarId}"`,
                  status: 404
                })
              )
            : Effect.succeed(found)
        })
      )
    },

    createEvent: (accessToken: string, calendarId: string, draft: CalendarEventDraft, options?: SendUpdatesOptions) => {
      record("createEvent", [accessToken, calendarId, draft, options])
      return account(accessToken).pipe(
        Effect.map(() => {
          const created = new CalendarEvent({
            id: `scripted-event-${calls.length}`,
            title: draft.title,
            start: draft.start,
            end: draft.end,
            status: "confirmed",
            ...(draft.description ? { description: draft.description } : {}),
            ...(draft.location ? { location: draft.location } : {})
          })
          const existing = fixtures.accounts[accessToken]!
          fixtures.accounts[accessToken] = {
            ...existing,
            events: { ...existing.events, [calendarId]: [...(existing.events[calendarId] ?? []), created] }
          }
          return created
        })
      )
    },

    updateEvent: (
      accessToken: string,
      calendarId: string,
      eventId: string,
      patch: CalendarEventPatch,
      options?: SendUpdatesOptions
    ) => {
      record("updateEvent", [accessToken, calendarId, eventId, patch, options])
      return account(accessToken).pipe(
        Effect.flatMap((acc) => {
          const existingEvents = acc.events[calendarId] ?? []
          const index = existingEvents.findIndex((e) => e.id === eventId)
          if (index < 0) {
            return Effect.fail(
              new GoogleCalendarRequestFailed({
                message: `GoogleCalendarClientScripted: no fixture event "${eventId}" on calendar "${calendarId}"`,
                status: 404
              })
            )
          }
          const current = existingEvents[index]!
          const updated = new CalendarEvent({
            ...current,
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.start !== undefined ? { start: patch.start } : {}),
            ...(patch.end !== undefined ? { end: patch.end } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.location !== undefined ? { location: patch.location } : {})
          })
          const nextEvents = [...existingEvents]
          nextEvents[index] = updated
          fixtures.accounts[accessToken] = { ...acc, events: { ...acc.events, [calendarId]: nextEvents } }
          return Effect.succeed(updated)
        })
      )
    },

    deleteEvent: (accessToken: string, calendarId: string, eventId: string, options?: SendUpdatesOptions) => {
      record("deleteEvent", [accessToken, calendarId, eventId, options])
      return account(accessToken).pipe(
        Effect.map((acc) => {
          fixtures.accounts[accessToken] = {
            ...acc,
            events: { ...acc.events, [calendarId]: (acc.events[calendarId] ?? []).filter((e) => e.id !== eventId) }
          }
        })
      )
    },

    listCalendars: (accessToken: string) => {
      record("listCalendars", [accessToken])
      return account(accessToken).pipe(
        Effect.map((acc) =>
          Object.entries(acc.calendars)
            .filter(([, role]) => role === "writer" || role === "owner")
            .map(([id, role]) => new GoogleCalendarInfo({ id, summary: id, ...(role ? { accessRole: role } : {}) }))
        )
      )
    },

    getCalendar: (accessToken: string, calendarId: string) => {
      record("getCalendar", [accessToken, calendarId])
      return account(accessToken).pipe(
        Effect.flatMap((acc) => {
          const role = acc.calendars[calendarId]
          return role === undefined
            ? Effect.fail(
                new GoogleCalendarRequestFailed({
                  message: `GoogleCalendarClientScripted: account has no access to calendar "${calendarId}"`,
                  status: 404
                })
              )
            : Effect.succeed(new GoogleCalendarInfo({ id: calendarId, summary: calendarId, accessRole: role }))
        })
      )
    },

    freeBusy: (accessToken: string, calendarIds: ReadonlyArray<string>, timeMin: string, timeMax: string) => {
      record("freeBusy", [accessToken, calendarIds, timeMin, timeMax])
      return account(accessToken).pipe(
        Effect.map((acc) =>
          calendarIds.map(
            (id) =>
              new PersonAvailability({
                id,
                busy: [],
                ...(acc.freeBusyReadableCalendarIds.includes(id) ? {} : { error: "notFound" })
              })
          )
        )
      )
    }
  }

  return { layer: Layer.succeed(GoogleCalendarClient, api), calls, fixtures }
}
