// Worker entrypoint for `athenaeum-gatekeeper-google-calendar` — the "own Worker package" half of
// the plan's deployment topology, now (this stage) a genuine `GatekeeperVendor` surface plus the
// dispatcher in front of `GatekeeperAccountDurableObject` ("GatekeeperUser", one per connected
// account — see that file's header comment).
//
// **`GatekeeperVendor` mapping** (task item 1, cloudflare-os's three-tier shape per the plan's own
// "reuse the interface contracts... as the target shape"):
//   - `describe()` → `GET .../describe`.
//   - `getSupportedResources()` → folded into `describe()`'s own response (`supportedResources`)
//     rather than a separate route — this vendor has exactly one resource kind today (a bound
//     Google Calendar), so a second round trip buys nothing a client couldn't get from the same
//     response `describe()` already returns.
//   - `connectAccount()` → `POST .../connect`, which **starts a real OAuth flow**: builds the
//     Google authorization URL for the caller-supplied `state`/`redirectUri`/`scopes` (the
//     ACTUAL OAuth-flow orchestration — minting/verifying `state` as a CSRF nonce, choosing
//     `redirectUri` — is the caller's job, per `AuthorizationUrlOptions`'s own doc comment; this
//     stage's caller is `athenaeum-backend`'s own `connectGoogleCalendar` RPC method, next stage's
//     wiring). Does not itself create a `GatekeeperAccountDurableObject` — that only happens once
//     `POST .../account/:email/oauth/exchange` (below) completes a real code exchange.
//
// **Cross-Worker call shape** (documented in full in `gatekeeper-account-durable-object.ts`'s and
// `rpc-boundary.ts`'s own header comments — restated briefly here at the actual entry point):
// `athenaeum-backend` reaches every route below via a plain `Fetcher` service binding
// (`env.GATEKEEPER_GOOGLE_CALENDAR.fetch(request)`, JSON in/out) — NOT a Cap'n Web session. This
// Worker's own job is exactly: verify the caller (see below), parse the path/body, dispatch to the
// right `GatekeeperAccountDurableObject` method via `ctx.exports` (same-Worker native RPC), and
// turn its plain return value / thrown `{tag,message}` envelope into an HTTP response.
//
// **Caller authentication (adversarial-review fix)** — every route requires a valid
// `GATEKEEPER_CALLER_HMAC_SECRET`-signed credential (`service-caller-auth.ts`, verified in
// `fetch()` below before any route matches). This was NOT true before this fix, and the gap was
// real, not theoretical: `packages/router/src/index.ts` forwards ANY `/gatekeeper/google-
// calendar/*` request straight to this Worker's service binding with no auth check of its own
// (router is the app's public front door), AND this package's own `wrangler.jsonc` never set
// `workers_dev: false` (Cloudflare defaults that to `true`), so a real deployment of the
// as-checked-in config had a SECOND independent public `*.workers.dev` URL into the exact same
// unauthenticated routes. Once real Google OAuth credentials are configured, either path would
// have let anyone who knows a connected user's email read/write/delete that person's real Google
// Calendar and manipulate the observer ledger — completely bypassing every `WorkspaceDurableObject`
// role gate this stage was built around. See `service-caller-auth.ts`'s and `calendar-gatekeeper-
// client.ts`'s (the minting side, in `athenaeum-backend`) own header comments for the full design.

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { makeGoogleCalendarClientRealLive } from "./google-calendar-client-real.js"
import { GoogleCalendarClient, type AuthorizationUrlOptions } from "./google-calendar-client.js"
import { HttpFetchLive } from "./http-fetch.js"
import { errorEnvelopeFromCause, parseErrorEnvelope, type ErrorEnvelope } from "./rpc-boundary.js"
import { verifyCallerCredential } from "./service-caller-auth.js"

export { GatekeeperAccountDurableObject } from "./gatekeeper-account-durable-object.js"

export interface Env {
  readonly GOOGLE_OAUTH_CLIENT_ID?: string
  readonly GOOGLE_OAUTH_CLIENT_SECRET?: string
  readonly GATEKEEPER_VERIFIER_HMAC_SECRET?: string
  /** Adversarial-review fix — see `service-caller-auth.ts`'s header comment for the full "why this
   *  exists" story. Shared with `athenaeum-backend`'s own `GATEKEEPER_GOOGLE_CALENDAR_CALLER_HMAC_
   *  SECRET` (same value, two deployments' worth of `wrangler secret put`) — `calendar-gatekeeper-
   *  client.ts` signs every outgoing request with it, this Worker's `fetch()` handler verifies
   *  every incoming one against it before dispatching anywhere. Unconfigured (as in this
   *  environment — no real deployment exists to share a secret between) means EVERY route rejects
   *  with 401, never a bypassed check — see `verifyCallerCredential`'s own doc comment. */
  readonly GATEKEEPER_CALLER_HMAC_SECRET?: string
}

const VENDOR_DESCRIPTION = {
  vendorId: "google-calendar",
  displayName: "Google Calendar",
  supportedResources: [
    {
      kind: "calendar",
      /** Mirrors `GatekeeperBindingConfig`'s own `mode` literal — the two observer-verification
       *  strategies this vendor's Calendar resource supports (`docs/observers.md` §9.1). */
      modes: ["selected", "allVisible"]
    }
  ]
} as const

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "Access-Control-Allow-Origin": "*" } })

const statusForEnvelope = (envelope: ErrorEnvelope): number =>
  envelope.tag === "ValidationError" ? 400 : envelope.tag === "GatekeeperAccountNotConnected" ? 409 : 502

const errorResponse = (error: unknown): Response => {
  const envelope = parseErrorEnvelope(error)
  return json(envelope, statusForEnvelope(envelope))
}

const readJsonBody = async (request: Request): Promise<Record<string, unknown>> => {
  if (request.method === "GET" || request.method === "HEAD") return {}
  try {
    const body: unknown = await request.json()
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** `POST .../connect` — `GatekeeperVendor.connectAccount()`: builds the real Google OAuth
 *  authorization URL. Uses its own throwaway `GoogleCalendarClientReal` (not routed through any
 *  particular account's DO — building an authorization URL needs only the vendor's own client
 *  credentials, not an account's storage, since no account exists yet at this point in the flow). */
const handleConnect = async (request: Request, env: Env): Promise<Response> => {
  const body = await readJsonBody(request)
  const { redirectUri, state, scopes, forceConsent } = body as {
    redirectUri?: unknown
    state?: unknown
    scopes?: unknown
    forceConsent?: unknown
  }
  if (typeof redirectUri !== "string" || typeof state !== "string") {
    return json({ tag: "ValidationError", message: "connect: expected {redirectUri, state} strings" }, 400)
  }
  const options: AuthorizationUrlOptions = {
    redirectUri,
    state,
    scopes: Array.isArray(scopes) && scopes.every((s) => typeof s === "string") ? scopes : DEFAULT_SCOPES,
    ...(typeof forceConsent === "boolean" ? { forceConsent } : {})
  }
  const clientLayer = makeGoogleCalendarClientRealLive({
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET
  })
  const program = Effect.flatMap(GoogleCalendarClient, (client) => client.buildAuthorizationUrl(options)).pipe(
    Effect.provide(clientLayer),
    Effect.provide(HttpFetchLive)
  )
  const exit = await Effect.runPromiseExit(program)
  if (Exit.isSuccess(exit)) return json(exit.value)
  const envelope = errorEnvelopeFromCause(exit.cause)
  return json(envelope, statusForEnvelope(envelope))
}

/** Google's own documented default scopes for a read/write calendar connection, per
 *  `google-calendar-client-real.ts`'s header comment ("at minimum
 *  https://www.googleapis.com/auth/calendar... plus .../calendar.calendarlist.readonly if the
 *  calendar-picker flow is used"). Used when the caller doesn't override `scopes` explicitly. */
const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
]

/** Every `/account/:email/<op>` route, dispatched to the matching `GatekeeperAccountDurableObject`
 *  method by name. `email` is taken directly from the path — safe ONLY because `fetch()` (below)
 *  already verified the caller presented a valid `GATEKEEPER_CALLER_HMAC_SECRET`-signed credential
 *  before this function is ever reached (adversarial-review fix: this file used to claim that
 *  safety purely from "a same-Worker-trust-domain caller, athenaeum-backend's own service binding"
 *  — TRACING the actual request path showed that claim was false: `packages/router/src/index.ts`
 *  forwards ANY `/gatekeeper/google-calendar/*` request straight to this Worker's service binding
 *  with no auth check of its own, and this package's own `wrangler.jsonc` never set
 *  `workers_dev: false` either, so a real deployment had two independent unauthenticated paths in.
 *  See `service-caller-auth.ts`'s header comment for the full story). The Athenaeum-identity/role
 *  check (`WorkspaceDurableObject`'s `requireRoleForGovernedWorkspace`) still happens one hop back, exactly
 *  as before — this credential proves "the caller is genuinely `athenaeum-backend`," a DIFFERENT,
 *  additional guarantee neither `requireRoleForGovernedWorkspace` nor a bare service binding provide
 *  once a second, unauthenticated path to this same Worker exists. */
const ACCOUNT_ROUTE = /^\/gatekeeper\/google-calendar\/account\/([^/]+)\/([a-z-]+)$/

const handleAccountRoute = async (request: Request, env: Env, ctx: ExecutionContext, email: string, op: string): Promise<Response> => {
  const stub = ctx.exports.GatekeeperAccountDurableObject.getByName(decodeURIComponent(email))
  const body = await readJsonBody(request)

  try {
    switch (op) {
      case "oauth-exchange": {
        const { code, redirectUri } = body as { code?: unknown; redirectUri?: unknown }
        if (typeof code !== "string" || typeof redirectUri !== "string") {
          return json({ tag: "ValidationError", message: "oauth-exchange: expected {code, redirectUri} strings" }, 400)
        }
        return json(await stub.completeOAuth(code, redirectUri))
      }
      case "disconnect":
        await stub.disconnect()
        return json({ disconnected: true })
      case "is-connected":
        return json({ connected: await stub.isConnected() })
      case "list-calendars":
        return json(await stub.listCalendars())
      case "events-page": {
        const { calendarId, query } = body as { calendarId?: unknown; query?: unknown }
        if (typeof calendarId !== "string") return json({ tag: "ValidationError", message: "events-page: calendarId required" }, 400)
        return json(await stub.eventsPage(calendarId, query))
      }
      case "create-event": {
        const { calendarId, draft, sendUpdates } = body as { calendarId?: unknown; draft?: unknown; sendUpdates?: unknown }
        if (typeof calendarId !== "string") return json({ tag: "ValidationError", message: "create-event: calendarId required" }, 400)
        return json(await stub.createEvent(calendarId, draft, sendUpdatesOption(sendUpdates)))
      }
      case "update-event": {
        const { calendarId, eventId, patch, sendUpdates } = body as {
          calendarId?: unknown
          eventId?: unknown
          patch?: unknown
          sendUpdates?: unknown
        }
        if (typeof calendarId !== "string" || typeof eventId !== "string") {
          return json({ tag: "ValidationError", message: "update-event: calendarId/eventId required" }, 400)
        }
        return json(await stub.updateEvent(calendarId, eventId, patch, sendUpdatesOption(sendUpdates)))
      }
      case "delete-event": {
        const { calendarId, eventId, sendUpdates } = body as { calendarId?: unknown; eventId?: unknown; sendUpdates?: unknown }
        if (typeof calendarId !== "string" || typeof eventId !== "string") {
          return json({ tag: "ValidationError", message: "delete-event: calendarId/eventId required" }, 400)
        }
        await stub.deleteEvent(calendarId, eventId, sendUpdatesOption(sendUpdates))
        return json({ deleted: true })
      }
      case "free-busy": {
        const { calendarIds, timeMin, timeMax } = body as { calendarIds?: unknown; timeMin?: unknown; timeMax?: unknown }
        if (!Array.isArray(calendarIds) || typeof timeMin !== "string" || typeof timeMax !== "string") {
          return json({ tag: "ValidationError", message: "free-busy: expected {calendarIds[], timeMin, timeMax}" }, 400)
        }
        return json(await stub.freeBusy(calendarIds, timeMin, timeMax))
      }
      case "get-verifier":
        return json(await stub.getVerifier())
      case "add-observer": {
        const { bindingId, observerId, verifierToken, mode, calendarId } = body as {
          bindingId?: unknown
          observerId?: unknown
          verifierToken?: unknown
          mode?: unknown
          calendarId?: unknown
        }
        if (
          typeof bindingId !== "string" ||
          typeof observerId !== "string" ||
          typeof verifierToken !== "string" ||
          (mode !== "selected" && mode !== "allVisible") ||
          typeof calendarId !== "string"
        ) {
          return json({ tag: "ValidationError", message: "add-observer: missing/invalid fields" }, 400)
        }
        await stub.addObserver(bindingId, observerId, verifierToken, mode, calendarId)
        return json({ added: true })
      }
      case "remove-observer": {
        const { bindingId, observerId } = body as { bindingId?: unknown; observerId?: unknown }
        if (typeof bindingId !== "string" || typeof observerId !== "string") {
          return json({ tag: "ValidationError", message: "remove-observer: bindingId/observerId required" }, 400)
        }
        await stub.removeObserver(bindingId, observerId)
        return json({ removed: true })
      }
      case "on-calendar-touched": {
        const { bindingId, calendarId } = body as { bindingId?: unknown; calendarId?: unknown }
        if (typeof bindingId !== "string" || typeof calendarId !== "string") {
          return json({ tag: "ValidationError", message: "on-calendar-touched: bindingId/calendarId required" }, 400)
        }
        return json(await stub.onCalendarTouched(bindingId, calendarId))
      }
      default:
        return json({ tag: "ValidationError", message: `Unknown account operation "${op}"` }, 404)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

const sendUpdatesOption = (value: unknown): { sendUpdates?: "all" | "externalOnly" | "none" } | undefined =>
  value === "all" || value === "externalOnly" || value === "none" ? { sendUpdates: value } : undefined

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // Adversarial-review fix: EVERY route below (including `describe`, which leaks nothing
    // sensitive on its own but is gated too for uniform simplicity — there is no legitimate
    // caller of this Worker other than `athenaeum-backend`'s own service binding) now requires a
    // valid `GATEKEEPER_CALLER_HMAC_SECRET`-signed credential — see `service-caller-auth.ts`'s
    // header comment for the full "why" and `handleAccountRoute`'s own doc comment for exactly
    // what this closes that a bare service binding + `requireRoleForGovernedWorkspace` did not.
    if (!(await verifyCallerCredential(request, env.GATEKEEPER_CALLER_HMAC_SECRET))) {
      return json({ tag: "Unauthorized", message: "Missing or invalid gatekeeper caller credential." }, 401)
    }

    if (url.pathname === "/gatekeeper/google-calendar/describe") {
      return json(VENDOR_DESCRIPTION)
    }
    if (url.pathname === "/gatekeeper/google-calendar/connect" && request.method === "POST") {
      return handleConnect(request, env)
    }
    const accountMatch = url.pathname.match(ACCOUNT_ROUTE)
    if (accountMatch) {
      const [, email, op] = accountMatch as unknown as [string, string, string]
      return handleAccountRoute(request, env, ctx, email, op)
    }

    return new Response("Not Found", { status: 404 })
  }
} satisfies ExportedHandler<Env>
