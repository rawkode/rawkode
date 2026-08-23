// Proves `GoogleCalendarClientReal`'s request-building/response-parsing logic is genuinely
// correct, by mocking *only* the HTTP layer (`HttpFetch`) — never the `GoogleCalendarClient`
// itself, exactly like `@athenaeum/backend`'s `model-client-anthropic.test.ts` (this task's own
// cited template). Every request URL/body/header and every response-parsing branch below runs
// through the REAL `makeGoogleCalendarClientRealLive` implementation; only the network call inside
// `HttpFetch.fetch` is a fake. **No real Google OAuth credential is used or required — exercising
// this against the live API is explicitly out of scope for this environment** (see
// `google-calendar-client-real.ts`'s own header comment for exactly what David would need to
// register in Google Cloud Console to make this real).

import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { CalendarEventDraft, CalendarEventPatch } from "../src/calendar-types.js"
import { HttpFetch } from "../src/http-fetch.js"
import { makeGoogleCalendarClientRealLive } from "../src/google-calendar-client-real.js"
import { GoogleCalendarClient, type GoogleCalendarClientApi } from "../src/google-calendar-client.js"

interface RecordedFetchCall {
  readonly url: string
  readonly init: RequestInit
}

const mockHttpFetch = (
  handler: (call: RecordedFetchCall) => Response
): { readonly layer: Layer.Layer<HttpFetch>; readonly calls: Array<RecordedFetchCall> } => {
  const calls: Array<RecordedFetchCall> = []
  const layer = Layer.succeed(HttpFetch, {
    fetch: (url, init) => {
      const call = { url, init }
      calls.push(call)
      return Promise.resolve(handler(call))
    }
  })
  return { layer, calls }
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const withClient = <A>(
  httpLayer: Layer.Layer<HttpFetch>,
  config: { readonly clientId: string | undefined; readonly clientSecret: string | undefined },
  program: (client: GoogleCalendarClientApi) => Effect.Effect<A, any>
) =>
  Effect.gen(function* () {
    const client = yield* GoogleCalendarClient
    return yield* program(client)
  }).pipe(Effect.provide(makeGoogleCalendarClientRealLive(config).pipe(Layer.provide(httpLayer))))

const CONFIGURED = { clientId: "test-client-id", clientSecret: "test-client-secret" }

describe("GoogleCalendarClientReal: unconfigured", () => {
  it("buildAuthorizationUrl fails with GoogleCalendarNotConfigured, no network call", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, {}))
    const exit = await Effect.runPromiseExit(
      withClient(mock.layer, { clientId: undefined, clientSecret: undefined }, (c) =>
        c.buildAuthorizationUrl({ state: "s", redirectUri: "https://example.com/cb", scopes: ["a"] })
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("GoogleCalendarNotConfigured")
    }
    expect(mock.calls).toHaveLength(0)
  })

  it("exchangeAuthorizationCode fails closed with a missing client secret specifically", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, {}))
    const exit = await Effect.runPromiseExit(
      withClient(mock.layer, { clientId: "id-only", clientSecret: undefined }, (c) =>
        c.exchangeAuthorizationCode("code", "https://example.com/cb")
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error._tag === "GoogleCalendarNotConfigured") {
      expect(exit.cause.error.message).toContain("GOOGLE_OAUTH_CLIENT_SECRET")
    }
    expect(mock.calls).toHaveLength(0)
  })
})

describe("GoogleCalendarClientReal: OAuth authorization URL", () => {
  it("builds accounts.google.com/o/oauth2/v2/auth with the documented required params", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, {}))
    const result = await Effect.runPromise(
      withClient(mock.layer, CONFIGURED, (c) =>
        c.buildAuthorizationUrl({
          state: "csrf-state",
          redirectUri: "https://athenaeum.example/gatekeeper/google-calendar/oauth/callback",
          scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"]
        })
      )
    )
    const url = new URL(result.url)
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(url.searchParams.get("client_id")).toBe("test-client-id")
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://athenaeum.example/gatekeeper/google-calendar/oauth/callback"
    )
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.calendarlist.readonly"
    )
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("include_granted_scopes")).toBe("true")
    expect(url.searchParams.get("state")).toBe("csrf-state")
    expect(url.searchParams.has("prompt")).toBe(false)
    expect(mock.calls).toHaveLength(0) // pure URL construction, no network call
  })

  it("sets prompt=consent when forceConsent is requested", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, {}))
    const result = await Effect.runPromise(
      withClient(mock.layer, CONFIGURED, (c) =>
        c.buildAuthorizationUrl({ state: "s", redirectUri: "https://example.com/cb", scopes: ["a"], forceConsent: true })
      )
    )
    expect(new URL(result.url).searchParams.get("prompt")).toBe("consent")
  })
})

describe("GoogleCalendarClientReal: authorization-code exchange", () => {
  it("POSTs the documented form-encoded body to oauth2.googleapis.com/token", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, {
        access_token: "access-123",
        expires_in: 3600,
        refresh_token: "refresh-123",
        scope: "https://www.googleapis.com/auth/calendar"
      })
    )
    const tokens = await Effect.runPromise(
      withClient(mock.layer, CONFIGURED, (c) => c.exchangeAuthorizationCode("auth-code", "https://example.com/cb"))
    )
    expect(mock.calls).toHaveLength(1)
    const call = mock.calls[0]!
    expect(call.url).toBe("https://oauth2.googleapis.com/token")
    expect(call.init.method).toBe("POST")
    const body = new URLSearchParams(call.init.body as string)
    expect(body.get("code")).toBe("auth-code")
    expect(body.get("client_id")).toBe("test-client-id")
    expect(body.get("client_secret")).toBe("test-client-secret")
    expect(body.get("redirect_uri")).toBe("https://example.com/cb")
    expect(body.get("grant_type")).toBe("authorization_code")

    expect(tokens.accessToken).toBe("access-123")
    expect(tokens.expiresInSeconds).toBe(3600)
    expect(tokens.refreshToken).toBe("refresh-123")
    expect(tokens.grantedScopes).toEqual(["https://www.googleapis.com/auth/calendar"])
  })

  it("maps a token endpoint invalid_grant error to GoogleCalendarAuthFailed(reason: invalidGrant)", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(400, { error: "invalid_grant", error_description: "Bad Request" })
    )
    const exit = await Effect.runPromiseExit(
      withClient(mock.layer, CONFIGURED, (c) => c.exchangeAuthorizationCode("bad-code", "https://example.com/cb"))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error._tag === "GoogleCalendarAuthFailed") {
      expect(exit.cause.error.reason).toBe("invalidGrant")
    } else {
      throw new Error("expected GoogleCalendarAuthFailed")
    }
  })

  it("maps admin_policy_enforced to GoogleCalendarAuthFailed(reason: policyBlocked)", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(400, { error: "admin_policy_enforced", error_description: "blocked by admin" })
    )
    const exit = await Effect.runPromiseExit(
      withClient(mock.layer, CONFIGURED, (c) => c.refreshAccessToken("some-refresh-token"))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error._tag === "GoogleCalendarAuthFailed") {
      expect(exit.cause.error.reason).toBe("policyBlocked")
    } else {
      throw new Error("expected GoogleCalendarAuthFailed")
    }
  })
})

describe("GoogleCalendarClientReal: refresh token flow", () => {
  it("POSTs grant_type=refresh_token and never returns a new refresh token", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { access_token: "fresh-access", expires_in: 1800 }))
    const tokens = await Effect.runPromise(withClient(mock.layer, CONFIGURED, (c) => c.refreshAccessToken("refresh-abc")))
    const body = new URLSearchParams(mock.calls[0]!.init.body as string)
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("refresh_token")).toBe("refresh-abc")
    expect(tokens.accessToken).toBe("fresh-access")
    expect(tokens.refreshToken).toBeUndefined()
  })
})

describe("GoogleCalendarClientReal: events.list", () => {
  it("window mode sends timeMin/timeMax/showDeleted/singleEvents, never syncToken", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { items: [] }))
    await Effect.runPromise(
      withClient(mock.layer, CONFIGURED, (c) =>
        c.listEvents("access-tok", "primary", {
          mode: "window",
          timeMin: "2026-01-01T00:00:00.000Z",
          timeMax: "2026-02-01T00:00:00.000Z",
          singleEvents: true,
          showDeleted: true
        })
      )
    )
    const url = new URL(mock.calls[0]!.url)
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events")
    expect(url.searchParams.get("timeMin")).toBe("2026-01-01T00:00:00.000Z")
    expect(url.searchParams.get("timeMax")).toBe("2026-02-01T00:00:00.000Z")
    expect(url.searchParams.get("singleEvents")).toBe("true")
    expect(url.searchParams.get("showDeleted")).toBe("true")
    expect(url.searchParams.has("syncToken")).toBe(false)
    expect(mock.calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer access-tok" })
  })

  it("syncToken mode sends only syncToken/singleEvents/pageToken, never timeMin/timeMax/showDeleted", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { items: [], nextSyncToken: "sync-2" }))
    await Effect.runPromise(
      withClient(mock.layer, CONFIGURED, (c) =>
        c.listEvents("access-tok", "primary", { mode: "syncToken", syncToken: "sync-1", singleEvents: true, pageToken: "page-2" })
      )
    )
    const url = new URL(mock.calls[0]!.url)
    expect(url.searchParams.get("syncToken")).toBe("sync-1")
    expect(url.searchParams.get("pageToken")).toBe("page-2")
    expect(url.searchParams.get("singleEvents")).toBe("true")
    expect(url.searchParams.has("timeMin")).toBe(false)
    expect(url.searchParams.has("timeMax")).toBe(false)
    expect(url.searchParams.has("showDeleted")).toBe(false)
  })

  it("parses items, nextPageToken, and nextSyncToken from the response envelope", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, {
        items: [
          {
            id: "evt-1",
            summary: "Standup",
            start: { dateTime: "2026-01-05T09:00:00-08:00", timeZone: "America/Los_Angeles" },
            end: { dateTime: "2026-01-05T09:30:00-08:00", timeZone: "America/Los_Angeles" },
            status: "confirmed",
            attendees: [{ email: "a@example.com", responseStatus: "accepted" }]
          }
        ],
        nextPageToken: "page-3"
      })
    )
    const page = await Effect.runPromise(
      withClient(mock.layer, CONFIGURED, (c) =>
        c.listEvents("access-tok", "primary", {
          mode: "window",
          timeMin: "2026-01-01T00:00:00.000Z",
          timeMax: "2026-02-01T00:00:00.000Z",
          singleEvents: true,
          showDeleted: true
        })
      )
    )
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.id).toBe("evt-1")
    expect(page.items[0]!.title).toBe("Standup")
    expect(page.items[0]!.start).toEqual({
      kind: "dateTime",
      dateTime: "2026-01-05T09:00:00-08:00",
      timeZone: "America/Los_Angeles"
    })
    expect(page.items[0]!.attendees).toEqual([{ email: "a@example.com", responseStatus: "accepted" }])
    expect(page.nextPageToken).toBe("page-3")
    expect(page.nextSyncToken).toBeUndefined()
  })

  it("all-day events decode date (not dateTime), with Google's documented exclusive end date preserved as-is", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, {
        items: [
          {
            id: "evt-allday",
            summary: "Offsite",
            start: { date: "2026-06-09" },
            end: { date: "2026-06-10" },
            status: "confirmed"
          }
        ]
      })
    )
    const page = await Effect.runPromise(
      withClient(mock.layer, CONFIGURED, (c) =>
        c.listEvents("access-tok", "primary", {
          mode: "window",
          timeMin: "2026-01-01T00:00:00.000Z",
          timeMax: "2026-02-01T00:00:00.000Z",
          singleEvents: true,
          showDeleted: true
        })
      )
    )
    expect(page.items[0]!.start).toEqual({ kind: "date", date: "2026-06-09" })
    expect(page.items[0]!.end).toEqual({ kind: "date", date: "2026-06-10" })
  })

  it("maps a 410 response to GoogleCalendarSyncTokenExpired", async () => {
    const mock = mockHttpFetch(() => new Response("Gone", { status: 410 }))
    const exit = await Effect.runPromiseExit(
      withClient(mock.layer, CONFIGURED, (c) =>
        c.listEvents("access-tok", "primary", { mode: "syncToken", syncToken: "expired-token", singleEvents: true })
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("GoogleCalendarSyncTokenExpired")
      if (exit.cause.error._tag === "GoogleCalendarSyncTokenExpired") {
        expect(exit.cause.error.calendarId).toBe("primary")
      }
    }
  })
})

describe("GoogleCalendarClientReal: single-event CRUD", () => {
  it("createEvent POSTs the mapped draft with sendUpdates and returns the decoded event", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, {
        id: "new-evt",
        summary: "1:1",
        start: { dateTime: "2026-03-01T10:00:00Z" },
        end: { dateTime: "2026-03-01T10:30:00Z" },
        status: "confirmed"
      })
    )
    const draft = new CalendarEventDraft({
      title: "1:1",
      start: { kind: "dateTime", dateTime: "2026-03-01T10:00:00Z" },
      end: { kind: "dateTime", dateTime: "2026-03-01T10:30:00Z" },
      attendees: [{ email: "bob@example.com" }]
    })
    const created = await Effect.runPromise(
      withClient(mock.layer, CONFIGURED, (c) => c.createEvent("access-tok", "primary", draft, { sendUpdates: "externalOnly" }))
    )
    const url = new URL(mock.calls[0]!.url)
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events")
    expect(url.searchParams.get("sendUpdates")).toBe("externalOnly")
    expect(mock.calls[0]!.init.method).toBe("POST")
    const body = JSON.parse(mock.calls[0]!.init.body as string)
    expect(body.summary).toBe("1:1")
    expect(body.attendees).toEqual([{ email: "bob@example.com" }])
    expect(created.id).toBe("new-evt")
  })

  it("updateEvent PATCHes only the fields present on the patch", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, {
        id: "evt-1",
        summary: "Rescheduled",
        start: { dateTime: "2026-03-02T10:00:00Z" },
        end: { dateTime: "2026-03-02T10:30:00Z" },
        status: "confirmed"
      })
    )
    const patch = new CalendarEventPatch({
      title: "Rescheduled",
      start: { kind: "dateTime", dateTime: "2026-03-02T10:00:00Z" },
      end: { kind: "dateTime", dateTime: "2026-03-02T10:30:00Z" }
    })
    await Effect.runPromise(withClient(mock.layer, CONFIGURED, (c) => c.updateEvent("access-tok", "primary", "evt-1", patch)))
    expect(mock.calls[0]!.init.method).toBe("PATCH")
    const body = JSON.parse(mock.calls[0]!.init.body as string)
    expect(body).toEqual({
      summary: "Rescheduled",
      start: { dateTime: "2026-03-02T10:00:00Z" },
      end: { dateTime: "2026-03-02T10:30:00Z" }
    })
    expect("description" in body).toBe(false)
    expect("attendees" in body).toBe(false)
  })

  it("deleteEvent DELETEs and treats 410 (already gone) as success", async () => {
    const mock = mockHttpFetch(() => new Response(null, { status: 410 }))
    await Effect.runPromise(withClient(mock.layer, CONFIGURED, (c) => c.deleteEvent("access-tok", "primary", "evt-1")))
    expect(mock.calls[0]!.init.method).toBe("DELETE")
  })

  it("getEvent GETs the event by id", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, {
        id: "evt-9",
        summary: "Retro",
        start: { dateTime: "2026-03-03T10:00:00Z" },
        end: { dateTime: "2026-03-03T11:00:00Z" },
        status: "confirmed"
      })
    )
    const event = await Effect.runPromise(withClient(mock.layer, CONFIGURED, (c) => c.getEvent("access-tok", "primary", "evt-9")))
    expect(new URL(mock.calls[0]!.url).pathname).toBe("/calendar/v3/calendars/primary/events/evt-9")
    expect(event.title).toBe("Retro")
  })
})

describe("GoogleCalendarClientReal: calendars", () => {
  it("getCalendar returns the calling account's own accessRole", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, { id: "team@example.com", summary: "Team calendar", accessRole: "writer" })
    )
    const info = await Effect.runPromise(withClient(mock.layer, CONFIGURED, (c) => c.getCalendar("access-tok", "team@example.com")))
    expect(info.accessRole).toBe("writer")
  })

  it("listCalendars requests minAccessRole=writer", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { items: [] }))
    await Effect.runPromise(withClient(mock.layer, CONFIGURED, (c) => c.listCalendars("access-tok")))
    const url = new URL(mock.calls[0]!.url)
    expect(url.searchParams.get("minAccessRole")).toBe("writer")
  })
})

describe("GoogleCalendarClientReal: freeBusy", () => {
  it("POSTs timeMin/timeMax/items and maps a documented error reason per calendar", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, {
        calendars: {
          "readable@example.com": { busy: [{ start: "2026-01-01T09:00:00Z", end: "2026-01-01T10:00:00Z" }] },
          "hidden@example.com": { errors: [{ domain: "global", reason: "notFound" }] }
        }
      })
    )
    const results = await Effect.runPromise(
      withClient(mock.layer, CONFIGURED, (c) =>
        c.freeBusy("access-tok", ["readable@example.com", "hidden@example.com"], "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")
      )
    )
    const body = JSON.parse(mock.calls[0]!.init.body as string)
    expect(body).toEqual({
      timeMin: "2026-01-01T00:00:00Z",
      timeMax: "2026-01-02T00:00:00Z",
      items: [{ id: "readable@example.com" }, { id: "hidden@example.com" }]
    })
    expect(results[0]).toEqual({ id: "readable@example.com", busy: [{ start: "2026-01-01T09:00:00Z", end: "2026-01-01T10:00:00Z" }] })
    expect(results[1]).toEqual({ id: "hidden@example.com", busy: [], error: "notFound" })
  })

  it("maps a calendar absent from the response entirely to error: notFound", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { calendars: {} }))
    const results = await Effect.runPromise(
      withClient(mock.layer, CONFIGURED, (c) => c.freeBusy("access-tok", ["missing@example.com"], "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"))
    )
    expect(results[0]!.error).toBe("notFound")
  })
})
