// Backend Worker entrypoint (plan §"Effect-TS integration": "The Worker fetch handler follows
// the identical shape [to the DO's RPC shim]"). Phase 0 scope: route `/api/workspace/:workspaceId` to
// that workspace's `WorkspaceDurableObject`, reached via `ctx.exports` (no explicit `durable_objects`
// binding — see wrangler.jsonc) and forward the raw `Request` to the DO's own `fetch()`, which
// hosts the actual Cap'n Web session (`workspace-durable-object.ts`). Forwarding the whole `Request`
// (rather than terminating it here) is what lets a WebSocket upgrade for `subscribeToNodes`
// transparently pass through the DO stub — standard Cloudflare Worker↔DO WebSocket proxying.

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { DevSignInInput, DevSignInOutput, EntityId, ModelClient, ModelTurnFinalText, ModelTurnToolCalls, ToolCallRequest } from "@athenaeum/domain"
import { agentEditModelClientTestHook, calendarGatekeeperClientTestHook } from "./workspace-durable-object.js"
import { makeModelClientScripted } from "./model-client-scripted.js"
import { makeDevScriptedCalendarGatekeeperClient } from "./dev-scripted-calendar-client.js"
import { extractBearerCredential, signDevCredential, verifyDevCredential } from "./dev-auth.js"

export { WorkspaceDurableObject } from "./workspace-durable-object.js"
export { UserDurableObject } from "./user-durable-object.js"
// Scratch DO for the Phase 1 FTS5-capability probe (see `fts-probe-durable-object.ts`'s doc
// comment) — exported the same way as the two production DOs so `test/fts5-search.test.ts` can
// reach it via `exports.FtsSearchProbeDurableObject.getByName(...)`, exactly as `test/support.ts`
// reaches the Worker's own `default.fetch`.
export { FtsSearchProbeDurableObject } from "./fts-probe-durable-object.js"
// Scratch DO for the Phase 1 Automerge-in-workerd capability probe (see
// `automerge-probe-durable-object.ts`'s doc comment) — same pattern as the FTS5 probe above.
export { AutomergeProbeDurableObject } from "./automerge-probe-durable-object.js"

export interface Env {
  // ctx.exports reaches WorkspaceDurableObject/UserDurableObject directly; no explicit
  // durable_objects binding needed (see wrangler.jsonc and env.d.ts's Cloudflare.GlobalProps
  // augmentation, which is what makes `ctx.exports.WorkspaceDurableObject` typed as a
  // DurableObjectNamespace).

  /** Phase 3 (`AgentEditService`): the real Anthropic API key, read from a Worker secret binding
   *  once one is configured (`wrangler secret put ANTHROPIC_API_KEY`) — per this task's hard
   *  constraint, no real key is available in this environment, so this is `undefined` here and
   *  `ModelClientAnthropic` (workspace-durable-object.ts) fails every call with `ModelUnavailable`
   *  before any network I/O. See docs/agent-model-client.md. */
  readonly ANTHROPIC_API_KEY?: string

  /**
   * AI Gateway routing (docs/ai-gateway-decisions.md), shared by every real inference client in
   * this package (`ModelClientAnthropic`, `CloudTranscriptionClientOpenAI`,
   * `RealtimeVoiceClientOpenAI` — see `ai-gateway-route.ts`'s header comment for the full
   * research trail and why this is deliberately narrower than cloudflare-os's multi-tenant
   * `AiGatewayConfig`). `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_NAME` must both be set
   * (GATEWAY mode) or both be absent (DIRECT mode, calling each provider directly — unset here,
   * matching every provider API key above, since no real Cloudflare account exists in this
   * environment); `resolveAiGatewayRoute` throws at DO construction if exactly one is set, rather
   * than silently falling back to DIRECT. Not secrets — a Cloudflare account ID and a gateway
   * name are fine as plaintext `wrangler.jsonc` vars on a real deployment.
   */
  readonly CF_AI_GATEWAY_ACCOUNT_ID?: string
  readonly CF_AI_GATEWAY_NAME?: string

  /**
   * Optional: only needed if "Authenticated Gateway" is turned on for the gateway above in the
   * Cloudflare dashboard (off is the default for a new gateway) — a gateway-scoped "Run" token
   * minted there, NOT a Cloudflare account API token. Sent as `cf-aig-authorization: Bearer
   * {token}` on every gateway request/connect when set. A real secret once configured
   * (`wrangler secret put CF_AI_GATEWAY_TOKEN`), same discipline as `ANTHROPIC_API_KEY` above.
   */
  readonly CF_AI_GATEWAY_TOKEN?: string

  /**
   * Phase 4 prerequisite (`dev-auth.ts`'s own header comment has the full design). Gates
   * `POST /api/dev/sign-in` — the literal string `"true"` (not any other truthy value) enables
   * it, mirroring the plan's own `AUTH_GATEKEEPERS`/`DISABLE_PASSWORD_AUTH` env-var discipline
   * "for exactly this kind of thing." Unset (or anything else) means the route 404s, exactly as
   * if it didn't exist — the fail-closed default, appropriate for any deployment that isn't a
   * local dev/test loop. Set in `wrangler.jsonc`'s `vars` (loudly commented there) for local
   * dev/CI; a real deployment would leave this unset entirely once real OAuth sign-in
   * (plan risk #6, out of scope here) exists.
   */
  readonly DEV_AUTH_ENABLED?: string

  /**
   * The HMAC-SHA-256 signing key `dev-auth.ts` uses to mint/verify dev credentials. A plaintext
   * `wrangler.jsonc` var (not a `wrangler secret`) is a deliberate, documented dev-only choice —
   * see `wrangler.jsonc`'s own comment on this var for why, and what a real deployment would do
   * instead. `undefined` (unconfigured) fails the sign-in route closed with a 500, never with a
   * silently-guessable default key.
   */
  readonly DEV_AUTH_HMAC_SECRET?: string

  /**
   * Phase 5 (`CalendarService`): the service binding to `athenaeum-gatekeeper-google-calendar`
   * (see that Worker's own `wrangler.jsonc`). `undefined` in this environment — the gatekeeper
   * Worker is real and buildable but not deployed here (hard constraint: no real Google OAuth
   * client exists to make a deployment meaningful yet). `calendar-gatekeeper-client.ts`'s
   * `CalendarGatekeeperClientUnconfigured` Layer is what every `CalendarService` method actually
   * runs against until this is configured.
   */
  readonly GATEKEEPER_GOOGLE_CALENDAR?: Fetcher

  /**
   * Adversarial-review fix: the shared-secret/HMAC key `calendar-gatekeeper-client.ts` signs
   * every outgoing request to the gatekeeper Worker with, and that Worker's own `fetch()` handler
   * (`GATEKEEPER_CALLER_HMAC_SECRET` there — same value, two `wrangler secret put`s) verifies
   * before dispatching anywhere. Closes a real gap: a bare service binding alone does not prove
   * the caller is genuinely `athenaeum-backend` (`packages/router/src/index.ts` forwards any
   * `/gatekeeper/google-calendar/*` request through with no auth check, and the gatekeeper
   * Worker's `wrangler.jsonc` gets a public `*.workers.dev` URL by default) — see `gatekeeper-
   * service-credential.ts`'s header comment for the full story. Same "plaintext dev-only var, real
   * deployment uses `wrangler secret put`" discipline as `DEV_AUTH_HMAC_SECRET` above.
   * Unconfigured (or the `GATEKEEPER_GOOGLE_CALENDAR` binding itself unset) means every
   * `CalendarService` method that reaches the gatekeeper Worker runs against
   * `CalendarGatekeeperClientUnconfigured` instead — see `workspace-durable-object.ts`'s own
   * construction site for exactly where that fallback happens.
   */
  readonly GATEKEEPER_GOOGLE_CALENDAR_CALLER_HMAC_SECRET?: string

  /**
   * Signs/verifies the `connectGoogleCalendar` -> `googleCalendarOAuthCallback` CSRF `state`
   * token (`calendar-oauth-state.ts`) — same "plaintext dev-only var, real deployment uses
   * `wrangler secret put`" discipline as `DEV_AUTH_HMAC_SECRET` above. Unconfigured means
   * `connectGoogleCalendar`/`googleCalendarOAuthCallback` fail closed with a clear
   * `ValidationError`; every other RPC method is unaffected.
   */
  readonly CALENDAR_OAUTH_STATE_SECRET?: string

  /** The fixed, Google-Cloud-Console-registered OAuth redirect URI for this deployment (the
   *  web app's own callback route, which itself calls `googleCalendarOAuthCallback` — see
   *  `calendar-service-live.ts`'s `CalendarServiceApi.connect` doc comment). Not a secret, but
   *  left unset here since no real deployment URL exists in this environment. */
  readonly CALENDAR_OAUTH_REDIRECT_URI?: string

  /** Phase 6 (`MeetingsService`): the real R2 bucket meeting audio blobs are stored in, per the
   *  plan's storage-tier split — see `wrangler.jsonc`'s own `r2_buckets` comment for why this is
   *  real and locally-simulated-in-tests, unlike the optional secrets above. Always defined once
   *  `wrangler.jsonc` binds it (never absent in this environment) — `meetings-service-live.ts`'s
   *  `MeetingAudioBucketUnconfigured` fallback exists purely as defense-in-depth. */
  readonly MEETING_AUDIO?: R2Bucket

  /** Phase 6 (`CloudTranscriptionClient`): the real OpenAI Audio API key
   *  (`cloud-transcription-client-openai.ts`) — see that file's own header comment for exactly
   *  which endpoint/model this is used against. `undefined` in this environment; see
   *  `wrangler.jsonc`'s own comment for the full rationale. */
  readonly OPENAI_TRANSCRIPTION_API_KEY?: string

  /** Phase 6 (`RealtimeVoiceClient`): the real OpenAI Realtime API key
   *  (`realtime-voice-client-openai.ts`). `undefined` in this environment; see `wrangler.jsonc`'s
   *  own comment for the full rationale. */
  readonly OPENAI_REALTIME_API_KEY?: string

  /**
   * App Library backend-execution stage: the real Worker Loader binding (`wrangler.jsonc`'s
   * `worker_loaders` — the same mechanism `cloudflare-os/packages/workshop-backend`'s own
   * `LOADER` binding backs its gadgets with). Always defined once `wrangler.jsonc` binds it —
   * unlike `GATEKEEPER_GOOGLE_CALENDAR`, a Worker Loader binding needs no external OAuth client to
   * be real and usable, the same "unconditionally bound and real" category `MEETING_AUDIO` is in
   * — `AppRuntimeService`'s `AppRuntimeServiceUnconfigured` fallback
   * (`app-runtime-service-live.ts`) exists purely as defense-in-depth, matching that binding's own
   * precedent.
   */
  readonly LOADER?: WorkerLoader
}

// Matches both the bare Cap'n Web session entrypoint (`/api/workspace/:workspaceId`, unchanged
// since Phase 0) AND, as of the App Library backend-execution stage, any sub-path under it
// (`/api/workspace/:workspaceId/apps/:appId/run/...`, `/api/workspace/:workspaceId/apps/:appId/client.js`) —
// `WorkspaceDurableObject#fetch()` itself dispatches on the sub-path (WebSocket/HTTP-batch RPC for
// the bare path, the new App HTTP routes otherwise), so this Worker-level regex only needs to
// capture the `workspaceId` segment and forward the whole request through unchanged, exactly as
// it already did for the bare path.
const WORKSPACE_PATH = /^\/api\/workspace\/([^/]+)(\/.*)?$/

// Dev-only routes backing `native/AthenaeumCore`'s `phase3-driver` CLI (Phase 3's native
// exit-criterion verification tool — see `Phase3Driver.swift`'s header comment) and reusing the
// exact same mechanism `packages/backend/test/agent-edit.test.ts`'s in-process
// `installScriptedModel` helper and the web stage's browser verification both already used: the
// live, per-call `agentEditModelClientTestHook.converse` indirection `workspace-durable-object.ts`
// exports (see that file's own doc comment on the hook — a permanent, already-shipped test-only
// injection point, same convention as `graph-service-live.ts`'s `createEdgeTestHook`). A real
// Swift CLI process talking to a real `wrangler dev` instance over plain HTTP is a different OS
// process than the Worker isolate, so — unlike an in-process Vitest test — it cannot set that
// module-level hook directly; these two routes are the only way an external process can reach it.
//
// Deliberately kept as **permanent**, not reverted after one-off use (unlike the earlier web
// stage's identical-shaped routes, added and then reverted for a single browser verification
// session): `phase3-driver` is meant to be a repeatable verification tool in the same spirit as
// `phase2-driver` ("not part of the shipped app — a verification tool, kept in this package"),
// and without a standing way to drive a deterministic model, `send-message` would be permanently
// inert (every call would just hit the real, unconfigured `ModelClientAnthropic` and fail with
// `ModelUnavailable` forever in this environment). Both routes are behind a literal `/__dev__/`
// path prefix, change no existing behavior, expose no credential or real capability (there is no
// real `ANTHROPIC_API_KEY` in this environment to leak — see `Env.ANTHROPIC_API_KEY`'s own doc
// comment — and the installed double is the same `ModelClientScripted` the backend's own test
// suite already ships), and are inert by default (`agentEditModelClientTestHook.converse` starts
// `undefined`, exactly as it does with these routes absent).
const enableScriptedModel = (url: URL): Response => {
  const title = url.searchParams.get("title") ?? "Native driver node"
  const binding = url.searchParams.get("binding") ?? "NATIVE_NODE"
  const predicateId = url.searchParams.get("predicateId") ?? "source"
  const value = url.searchParams.get("value") ?? "phase3-driver"
  // `count` (crash-safety verification stage addition): when >1, widens a single scripted turn
  // to `count` separate `createNode` tool calls instead of the original fixed createNode+addFact
  // pair — each tool call is its own `executeToolCall` (log write + flush + stamp, three separate
  // storage round trips per `agent-edit-service-live.ts`'s own doc comment), so a larger count
  // gives a real OS-level process kill (see the crash-safety verification test, which drives this
  // route) a wider real wall-clock window to land mid-turn. Defaults to 1, which is a no-op
  // behavior change — omitting `count` reproduces the original fixed two-call script exactly, so
  // `phase3-driver`'s existing calls (no `count`) are unaffected.
  const countParam = url.searchParams.get("count")
  const count = countParam === null ? 1 : Math.max(1, Number.parseInt(countParam, 10) || 1)

  const scripted =
    count === 1
      ? makeModelClientScripted([
          new ModelTurnToolCalls({
            kind: "tool_calls",
            calls: [
              new ToolCallRequest({ id: "call_1", name: "createNode", input: { title, binding } }),
              new ToolCallRequest({ id: "call_2", name: "addFact", input: { binding, predicateId, value } })
            ]
          }),
          new ModelTurnFinalText({ kind: "final_text", text: `Created "${title}" via phase3-driver.` })
        ])
      : makeModelClientScripted([
          new ModelTurnToolCalls({
            kind: "tool_calls",
            calls: Array.from(
              { length: count },
              (_, i) =>
                new ToolCallRequest({
                  id: `call_${i + 1}`,
                  name: "createNode",
                  input: { title: `${title} ${i + 1}`, binding: `${binding}_${i + 1}` }
                })
            )
          }),
          new ModelTurnFinalText({ kind: "final_text", text: `Created ${count} nodes via phase3-driver.` })
        ])
  const service = Effect.runSync(ModelClient.pipe(Effect.provide(scripted.layer)))
  agentEditModelClientTestHook.converse = service.converse
  return new Response("scripted model installed", { status: 200 })
}

const disableScriptedModel = (): Response => {
  agentEditModelClientTestHook.converse = undefined
  return new Response("scripted model cleared", { status: 200 })
}

// Web-stage addition (item 2, "calendar-merged day view... verify via a real browser session...
// using the backend's scripted calendar double wired in for verification, same pattern as Phase
// 3's scripted-model dev route"): identical shape to `enableScriptedModel`/`disableScriptedModel`
// above, but for `calendarGatekeeperClientTestHook.api` (`workspace-durable-object.ts`'s own doc
// comment on that hook already anticipated exactly this: "so `syncGoogleCalendar`/
// `connectGoogleCalendar`/etc. can be driven against deterministic fixture data — same mechanism,
// same rationale as `agentEditModelClientTestHook`"). Kept permanent for the same reason the
// scripted-model routes are permanent (this file's own comment above): a repeatable verification
// tool, not a one-off. See `dev-scripted-calendar-client.ts`'s header comment for exactly why this
// installs a LOCAL fixture double rather than `@athenaeum/gatekeeper-google-calendar`'s own
// `GoogleCalendarClientScripted` (devDependency-only, by design). Same "no real secret exposed"
// safety argument as the scripted-model routes: there is no real `GATEKEEPER_GOOGLE_CALENDAR`
// service binding configured in this environment for these routes to bypass or leak (see
// `Env.GATEKEEPER_GOOGLE_CALENDAR`'s own doc comment) — installing the double only changes what
// `CalendarService` sees for the lifetime of this Worker isolate, never what's actually deployed.
const enableScriptedCalendar = (): Response => {
  calendarGatekeeperClientTestHook.api = makeDevScriptedCalendarGatekeeperClient()
  return new Response("scripted calendar gatekeeper client installed", { status: 200 })
}

const disableScriptedCalendar = (): Response => {
  calendarGatekeeperClientTestHook.api = undefined
  return new Response("scripted calendar gatekeeper client cleared", { status: 200 })
}

/** How long a dev credential stays valid. Generous enough for a local dev/test session to not
 *  expire mid-use, short enough that a leaked dev credential (this route has no rate limiting —
 *  it is not meant to be internet-facing, see `DEV_AUTH_ENABLED`'s own doc comment) is not a
 *  long-lived liability. */
const DEV_CREDENTIAL_TTL_SECONDS = 60 * 60

/**
 * `POST /api/dev/sign-in` — the dev-only, gated stand-in for real OAuth sign-in (see
 * `dev-auth.ts`'s and `Env.DEV_AUTH_ENABLED`'s doc comments for the full rationale/gating). Body
 * `{"email": "<address>"}`; response `DevSignInOutput` (`{credential, email, issuedAt,
 * expiresAt}`). The credential is a Bearer token `WorkspaceDurableObject`'s `fetch()` accepts via the
 * `Authorization` header or a `?token=` query parameter (`dev-auth.ts#extractBearerCredential`).
 *
 * Sequencing mirrors cloudflare-os's own login flow exactly (`login-flow.ts`'s
 * `LoginConnectCallbackImpl#complete`): resolve/create the email-keyed `UserDurableObject` first
 * (`ensureProfile`, real storage, not a formality), *then* mint the credential — so a credential
 * is never handed out for an identity whose account record doesn't exist yet.
 */
const handleDevSignIn = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
  if (env.DEV_AUTH_ENABLED !== "true") {
    // Deliberately indistinguishable from "this route doesn't exist" — see Env.DEV_AUTH_ENABLED's
    // doc comment: the fail-closed default reveals nothing about dev auth's existence.
    return new Response("Not Found", { status: 404 })
  }
  if (env.DEV_AUTH_HMAC_SECRET === undefined || env.DEV_AUTH_HMAC_SECRET.length === 0) {
    return new Response(
      "Dev auth is enabled (DEV_AUTH_ENABLED=true) but DEV_AUTH_HMAC_SECRET is not configured.",
      { status: 500 }
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response("Expected a JSON body.", { status: 400 })
  }

  const rawEmail = typeof body === "object" && body !== null ? (body as Record<string, unknown>).email : undefined
  if (typeof rawEmail !== "string") {
    return new Response('Invalid request body: expected {"email": "<address>"}.', { status: 400 })
  }
  // Normalization happens here, once, at the one place a raw string first becomes an `Email` —
  // see `Email`'s own doc comment in domain/src/auth.ts for why the schema itself only validates
  // format and does not normalize.
  const decodeExit = Effect.runSyncExit(Schema.decodeUnknown(DevSignInInput)({ email: rawEmail.trim().toLowerCase() }))
  if (Exit.isFailure(decodeExit)) {
    return new Response('Invalid request body: "email" is not a valid-looking email address.', { status: 400 })
  }
  const { email } = decodeExit.value

  const userId = ctx.exports.UserDurableObject.idFromName(email)
  await ctx.exports.UserDurableObject.get(userId).ensureProfile(email)

  const { credential, issuedAt, expiresAt } = await Effect.runPromise(
    signDevCredential(email, env.DEV_AUTH_HMAC_SECRET, DEV_CREDENTIAL_TTL_SECONDS)
  )

  const output = new DevSignInOutput({ credential, email, issuedAt, expiresAt })
  return new Response(JSON.stringify(Schema.encodeSync(DevSignInOutput)(output)), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  })
}

/**
 * `GET/POST /api/user` — the Cap'n Web session entrypoint for the caller's OWN account catalog
 * (`createWorkspace`/`listWorkspaces`, task item 3). Unlike `/api/workspace/:workspaceId`, the target
 * `UserDurableObject` is never named by the client — it's derived from the caller's verified
 * Bearer credential's email (`idFromName(email)`, the identical addressing `handleDevSignIn`
 * already uses), so a caller can only ever reach their OWN catalog, never another account's, no
 * matter what URL they request. Requires a valid credential outright (401 if absent/invalid) —
 * there's no anonymous "whose catalog" case, unlike the workspace route's optional auth.
 *
 * Verifying here (to route to the right DO) and again inside `UserDurableObject#fetch()` is
 * deliberate double-checking, not redundant waste: this Worker-level check exists purely to pick
 * WHICH DO instance to address; that DO instance independently re-verifies before trusting the
 * connection as itself, the same defense-in-depth relationship `workspace-durable-object.ts`'s
 * `requireOwnWorkspace` has to the URL's `workspaceId`.
 */
const handleUserRequest = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
  const url = new URL(request.url)
  const bearer = extractBearerCredential(request, url)
  if (bearer === undefined) {
    return new Response("Authentication required.", { status: 401 })
  }
  if (env.DEV_AUTH_HMAC_SECRET === undefined || env.DEV_AUTH_HMAC_SECRET.length === 0) {
    return new Response(
      "Dev auth credential presented, but this deployment has no DEV_AUTH_HMAC_SECRET configured.",
      { status: 500 }
    )
  }
  const exit = await Effect.runPromiseExit(verifyDevCredential(bearer, env.DEV_AUTH_HMAC_SECRET))
  if (Exit.isFailure(exit)) {
    return new Response("Invalid or expired credential.", { status: 401 })
  }

  const userId = ctx.exports.UserDurableObject.idFromName(exit.value.email)
  return ctx.exports.UserDurableObject.get(userId).fetch(request)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/__dev__/enable-scripted-model") {
      return enableScriptedModel(url)
    }
    if (url.pathname === "/__dev__/disable-scripted-model") {
      return disableScriptedModel()
    }
    if (url.pathname === "/__dev__/enable-scripted-calendar") {
      return enableScriptedCalendar()
    }
    if (url.pathname === "/__dev__/disable-scripted-calendar") {
      return disableScriptedCalendar()
    }
    if (url.pathname === "/api/dev/sign-in" && request.method === "POST") {
      return handleDevSignIn(request, env, ctx)
    }
    if (url.pathname === "/api/user") {
      return handleUserRequest(request, env, ctx)
    }

    const match = url.pathname.match(WORKSPACE_PATH)

    if (!match) {
      return new Response("Not Found — expected /api/workspace/:workspaceId", { status: 404 })
    }

    const exit = Effect.runSyncExit(Schema.decodeUnknown(EntityId)(match[1]))
    if (Exit.isFailure(exit)) {
      return new Response(`Invalid workspaceId: ${match[1]} (must be a ULID or UUID)`, { status: 400 })
    }
    const workspaceId = exit.value

    const workspaceStub = ctx.exports.WorkspaceDurableObject.getByName(workspaceId)
    return workspaceStub.fetch(request)
  }
} satisfies ExportedHandler<Env>
