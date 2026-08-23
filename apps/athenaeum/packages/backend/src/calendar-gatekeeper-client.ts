// `CalendarGatekeeperClient` — the interface `CalendarService` (calendar-service-live.ts) uses to
// reach the `gatekeeper-google-calendar` Worker's account-scoped calendar operations. Same
// two-Layer-split discipline as every other pluggable external client in this codebase
// (`ModelClient`/`ModelClientAnthropic`, `GoogleCalendarClient` itself): a zero-network
// `Context.Tag` here, a real `Layer` (`makeCalendarGatekeeperClientServiceBindingLive`, below) for
// production, and a test-only double (`test/calendar-gatekeeper-client-scripted.ts`) that wraps
// `@athenaeum/gatekeeper-google-calendar`'s own `GoogleCalendarClientScripted` fixture double
// directly — see that file's own header comment for why.
//
// **Why this hop is plain JSON-over-`Fetcher.fetch`, not Cap'n Web** — restated from
// `gatekeeper-google-calendar/src/rpc-boundary.ts`'s own header comment (the authoritative
// version; this is the other end of the same documented decision): `athenaeum-backend`'s
// `WorkspaceDurableObject` calls the gatekeeper Worker via a plain service binding
// (`env.GATEKEEPER_GOOGLE_CALENDAR: Fetcher`), a simple call/response with no live-stub/
// object-capability need on this specific hop (unlike `WorkspaceDurableObject`'s OWN Cap'n Web
// surface, which genuinely needs live subscriptions — `subscribeToNodes` — that a plain fetch
// cannot express). This is the concrete realization of the plan's `Rel(workspaceDo, gkCalendar,
// "startSession() via Facet...")` relationship, adapted: Athenaeum has no Dynamic-Worker-Facet
// architecture for `startSession()` to hand back a live capability stub from, so "the session" is
// simply "this account's email, addressed per-call" rather than a held-open stub.
//
// Domain-package-shaped wire types are deliberately declared LOCALLY below, not imported from
// `@athenaeum/gatekeeper-google-calendar` — production `calendar-service-live.ts` has no
// dependency on that package, keeping `athenaeum-backend`'s production dependency graph to
// `@athenaeum/domain`/`@athenaeum/typed-storage-effect` only, matching the plan's own
// package-layering direction ("gatekeepers depend on domain, never the reverse") applied one
// level further: the MAIN backend doesn't compile-time-depend on a gatekeeper package either,
// only calls it over the network. `@athenaeum/gatekeeper-google-calendar` IS a devDependency
// (package.json) for exactly one reason: `test/calendar-service.test.ts` builds a
// `CalendarGatekeeperClient` Layer that wraps that package's own `GoogleCalendarClientScripted`
// fixture double, per this task's hard constraint ("tested against the Decisions stage's
// GoogleCalendarClientScripted double with realistic fixture data").

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { GatekeeperNotConnected, OAuthExchangeFailed, UnexpectedError, type DomainError } from "@athenaeum/domain"
import { signGatekeeperCallerCredential } from "./gatekeeper-service-credential.js"

export type RemoteCalendarTime =
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "dateTime"; readonly dateTime: string; readonly timeZone?: string }

export interface RemoteCalendarAttendee {
  readonly email: string
  readonly displayName?: string
  readonly optional?: boolean
  readonly responseStatus?: "needsAction" | "declined" | "tentative" | "accepted"
  readonly organizer?: boolean
  readonly self?: boolean
}

export interface RemoteCalendarEvent {
  readonly id: string
  readonly title: string
  readonly start: RemoteCalendarTime
  readonly end: RemoteCalendarTime
  readonly status: "confirmed" | "tentative" | "cancelled"
  readonly location?: string
  readonly description?: string
  readonly attendees?: ReadonlyArray<RemoteCalendarAttendee>
  readonly recurringEventId?: string
}

export interface RemoteCalendarEventsPage {
  readonly items: ReadonlyArray<RemoteCalendarEvent>
  readonly nextPageToken?: string
  readonly nextSyncToken?: string
}

export type RemoteCalendarEventsListQuery =
  | {
      readonly mode: "window"
      readonly timeMin: string
      readonly timeMax: string
      readonly singleEvents: boolean
      readonly showDeleted: boolean
      readonly pageToken?: string
    }
  | {
      readonly mode: "syncToken"
      readonly syncToken: string
      readonly singleEvents: boolean
      readonly pageToken?: string
    }

export interface RemoteGoogleCalendarInfo {
  readonly id: string
  readonly summary: string
  readonly accessRole?: "none" | "freeBusyReader" | "reader" | "writer" | "owner"
  readonly primary?: boolean
}

export interface CalendarGatekeeperClientApi {
  /** `GatekeeperVendor.connectAccount()` — builds the real Google authorization URL. */
  readonly buildAuthorizationUrl: (
    state: string,
    redirectUri: string
  ) => Effect.Effect<{ readonly url: string }, DomainError>
  /** Completes the OAuth code exchange for `email`'s `GatekeeperAccountDurableObject`, creating
   *  it on first success (idempotent per this stage's own "DO constructed on first request"
   *  Cloudflare semantics — see `gatekeeper-account-durable-object.ts`). Fails
   *  `OAuthExchangeFailed` (domain, errors.ts) on any gatekeeper-side failure. */
  readonly exchangeAndConnect: (email: string, code: string, redirectUri: string) => Effect.Effect<void, DomainError>
  readonly listCalendars: (email: string) => Effect.Effect<ReadonlyArray<RemoteGoogleCalendarInfo>, DomainError>
  readonly eventsPage: (
    email: string,
    calendarId: string,
    query: RemoteCalendarEventsListQuery
  ) => Effect.Effect<RemoteCalendarEventsPage, DomainError>

  // --- Observer verification (docs/observers.md §7, Strategy B/C) — task: "wire the observer
  // verification mechanism into the REAL Phase 4 SharingService". Both routes already exist on
  // the gatekeeper Worker (`worker.ts`'s `get-verifier`/`add-observer`/`on-calendar-touched`
  // account routes, built in the prior stage) — this is `athenaeum-backend`'s own client for them.

  /** `GatekeeperUser.getVerifier()`'s real entry point for `observerEmail`'s OWN connected
   *  account — mints an opaque token proving "this Athenaeum account is the one that connected
   *  this Google account." Fails (via the envelope->DomainError mapping below) if `observerEmail`
   *  has never connected a Google account at all — exactly the case every reviewer of this stage
   *  hits, since no real Google account exists in this environment (hard constraint). */
  readonly mintObserverVerifier: (observerEmail: string) => Effect.Effect<{ readonly token: string }, DomainError>

  /** `Gatekeeper.addObserver()`'s real entry point, issued against `boundByEmail`'s account (the
   *  one the binding is bound to) — it alone can verify an observer against ITS OWN calendar
   *  access/dataset log. `mode`/`calendarId` come from the binding (`GoogleCalendarBindingConfig`).
   *  Never itself distinguishes "observer not connected" from "observer connected but lacks
   *  access" beyond the envelope's `message` — `calendar-service-live.ts#verifyObserver` folds
   *  every failure mode here into the same `"denied"` outcome, per this task's own instruction
   *  that a non-qualifying viewer is EXCLUDED, not an error that blocks `addCollaborator`. */
  readonly addObserver: (
    boundByEmail: string,
    bindingId: string,
    observerId: string,
    verifierToken: string,
    mode: "selected" | "allVisible",
    calendarId: string
  ) => Effect.Effect<void, DomainError>

  /** Strategy C's "a new observation just read a calendar we've never logged before" half
   *  (`onDatasetTouched`, gatekeeper-google-calendar's own `observer-verification.ts`) — issued
   *  against `boundByEmail`'s account. Returns the observer ids (this design: emails) that FAILED
   *  re-verification against the newly touched calendar, for the caller to persist as newly
   *  denied. */
  readonly notifyCalendarTouched: (
    boundByEmail: string,
    bindingId: string,
    calendarId: string
  ) => Effect.Effect<{ readonly failedObserverIds: ReadonlyArray<string> }, DomainError>
}

export class CalendarGatekeeperClient extends Context.Tag("@athenaeum/backend/CalendarGatekeeperClient")<
  CalendarGatekeeperClient,
  CalendarGatekeeperClientApi
>() {}

/** Parses this package's own gatekeeper-side `{tag, message}` envelope (`rpc-boundary.ts` in
 *  `@athenaeum/gatekeeper-google-calendar`, restated locally rather than imported — see this
 *  file's own header comment on why production has no compile-time dependency on that package)
 *  into a `DomainError`. Deliberately `UnexpectedError` (a flat `message`), not
 *  `GatekeeperNotConnected` — THIS layer (a raw HTTP client) has no `workspaceId`/`gatekeeperKind` in
 *  scope to populate that error's real shape with (see its own doc comment: it carries those two
 *  fields, not a free-form message). `calendar-service-live.ts`, which DOES have workspace context,
 *  is where a `GatekeeperNotConnected` is actually constructed when appropriate (e.g. "no binding
 *  found for this workspace") — this function only needs to get SOME typed `DomainError` across this
 *  boundary without losing the gatekeeper's own diagnostic message. */
const domainErrorFromEnvelope = (envelope: { readonly tag: string; readonly message: string }): DomainError =>
  new UnexpectedError({ message: `gatekeeper-google-calendar: ${envelope.tag}: ${envelope.message}` })

const parseEnvelope = (value: unknown): { readonly tag: string; readonly message: string } => {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).tag === "string" &&
    typeof (value as Record<string, unknown>).message === "string"
  ) {
    return value as { tag: string; message: string }
  }
  return { tag: "UnexpectedError", message: JSON.stringify(value) }
}

/**
 * `POST`s `body` to `path` on `fetcher`, signing the request with a fresh, short-lived
 * `GATEKEEPER_CALLER_HMAC_SECRET`-signed credential (adversarial-review fix — see `gatekeeper-
 * service-credential.ts`'s header comment for the full "why this exists" story: a service binding
 * alone does not prove the caller is genuinely `athenaeum-backend`, since `packages/router/src/
 * index.ts` forwards any `/gatekeeper/google-calendar/*` request through unauthenticated, and
 * `gatekeeper-google-calendar`'s own `wrangler.jsonc` gets a public `*.workers.dev` URL by
 * default). `callerHmacSecret` must be the SAME value as the gatekeeper Worker's own
 * `GATEKEEPER_CALLER_HMAC_SECRET` — `makeCalendarGatekeeperClientServiceBindingLive`'s own doc
 * comment covers what happens when it's misconfigured/empty on this side.
 */
const postJson = (
  fetcher: Fetcher,
  callerHmacSecret: string,
  path: string,
  body: unknown
): Effect.Effect<unknown, DomainError> =>
  Effect.tryPromise({
    try: async () => {
      // `baseOrigin` is an arbitrary-but-fixed placeholder, never actually resolved over DNS: a
      // `Fetcher.fetch()` service-binding call routes purely by the target Worker's OWN `fetch()`
      // handler reading `request.url`'s path — the host is ignored for binding dispatch (standard
      // Cloudflare service-binding behavior) — so any syntactically valid absolute URL works.
      const credential = await signGatekeeperCallerCredential(callerHmacSecret)
      const response = await fetcher.fetch(
        new Request(`https://gatekeeper.internal${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
          body: JSON.stringify(body)
        })
      )
      const json: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw domainErrorFromEnvelope(parseEnvelope(json))
      return json
    },
    catch: (cause) =>
      cause instanceof GatekeeperNotConnected || cause instanceof OAuthExchangeFailed
        ? cause
        : new UnexpectedError({
            message: `CalendarGatekeeperClient: request to ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`
          })
  })

/**
 * Production `Layer`: a plain JSON-over-`fetch` client against the `GATEKEEPER_GOOGLE_CALENDAR`
 * service binding — see this file's header comment for why this hop is deliberately not Cap'n
 * Web. `callerHmacSecret` is required (not optional) here on purpose: the ONLY caller of this
 * function (`workspace-durable-object.ts`) already fails closed to `CalendarGatekeeperClientUnconfigured`
 * whenever `Env.GATEKEEPER_GOOGLE_CALENDAR_CALLER_HMAC_SECRET` is unset — see that call site's own
 * doc comment — so by the time this function runs, an empty secret would only ever be a caller
 * bug, not an expected "unconfigured deployment" state; it is not re-validated a second time here.
 */
export const makeCalendarGatekeeperClientServiceBindingLive = (
  fetcher: Fetcher,
  callerHmacSecret: string
): Layer.Layer<CalendarGatekeeperClient> => {
  const accountPath = (email: string, op: string): string =>
    `/gatekeeper/google-calendar/account/${encodeURIComponent(email)}/${op}`

  const api: CalendarGatekeeperClientApi = {
    buildAuthorizationUrl: (state, redirectUri) =>
      postJson(fetcher, callerHmacSecret, "/gatekeeper/google-calendar/connect", { state, redirectUri }) as Effect.Effect<
        { readonly url: string },
        DomainError
      >,

    exchangeAndConnect: (email, code, redirectUri) =>
      postJson(fetcher, callerHmacSecret, accountPath(email, "oauth-exchange"), { code, redirectUri }).pipe(Effect.asVoid),

    listCalendars: (email) =>
      postJson(fetcher, callerHmacSecret, accountPath(email, "list-calendars"), {}) as Effect.Effect<
        ReadonlyArray<RemoteGoogleCalendarInfo>,
        DomainError
      >,

    eventsPage: (email, calendarId, query) =>
      postJson(fetcher, callerHmacSecret, accountPath(email, "events-page"), { calendarId, query }) as Effect.Effect<
        RemoteCalendarEventsPage,
        DomainError
      >,

    mintObserverVerifier: (observerEmail) =>
      postJson(fetcher, callerHmacSecret, accountPath(observerEmail, "get-verifier"), {}) as Effect.Effect<
        { readonly token: string },
        DomainError
      >,

    addObserver: (boundByEmail, bindingId, observerId, verifierToken, mode, calendarId) =>
      postJson(fetcher, callerHmacSecret, accountPath(boundByEmail, "add-observer"), {
        bindingId,
        observerId,
        verifierToken,
        mode,
        calendarId
      }).pipe(Effect.asVoid),

    notifyCalendarTouched: (boundByEmail, bindingId, calendarId) =>
      postJson(fetcher, callerHmacSecret, accountPath(boundByEmail, "on-calendar-touched"), {
        bindingId,
        calendarId
      }) as Effect.Effect<{ readonly failedObserverIds: ReadonlyArray<string> }, DomainError>
  }

  return Layer.succeed(CalendarGatekeeperClient, api)
}

/** Used when `env.GATEKEEPER_GOOGLE_CALENDAR` is unset (no service binding configured — the
 *  expected state in this environment, and any deployment that hasn't wired up the
 *  `athenaeum-gatekeeper-google-calendar` Worker yet). Every method fails closed with a clear
 *  `UnexpectedError` rather than the DO construction itself throwing — every OTHER RPC method on
 *  `WorkspaceDurableObject` keeps working normally; only the eight gatekeeper-rpc.ts methods that
 *  actually reach this Tag are affected, exactly mirroring `ModelClientAnthropic`'s own "no API
 *  key configured" pattern (fails cleanly per-call, not at Layer-build time). */
export const CalendarGatekeeperClientUnconfigured: Layer.Layer<CalendarGatekeeperClient> = Layer.succeed(
  CalendarGatekeeperClient,
  {
    buildAuthorizationUrl: () =>
      Effect.fail(
        new UnexpectedError({
          message: "GATEKEEPER_GOOGLE_CALENDAR service binding is not configured on this deployment."
        })
      ),
    exchangeAndConnect: () =>
      Effect.fail(
        new UnexpectedError({
          message: "GATEKEEPER_GOOGLE_CALENDAR service binding is not configured on this deployment."
        })
      ),
    listCalendars: () =>
      Effect.fail(
        new UnexpectedError({
          message: "GATEKEEPER_GOOGLE_CALENDAR service binding is not configured on this deployment."
        })
      ),
    eventsPage: () =>
      Effect.fail(
        new UnexpectedError({
          message: "GATEKEEPER_GOOGLE_CALENDAR service binding is not configured on this deployment."
        })
      ),
    mintObserverVerifier: () =>
      Effect.fail(
        new UnexpectedError({
          message: "GATEKEEPER_GOOGLE_CALENDAR service binding is not configured on this deployment."
        })
      ),
    addObserver: () =>
      Effect.fail(
        new UnexpectedError({
          message: "GATEKEEPER_GOOGLE_CALENDAR service binding is not configured on this deployment."
        })
      ),
    notifyCalendarTouched: () =>
      Effect.fail(
        new UnexpectedError({
          message: "GATEKEEPER_GOOGLE_CALENDAR service binding is not configured on this deployment."
        })
      )
  }
)
