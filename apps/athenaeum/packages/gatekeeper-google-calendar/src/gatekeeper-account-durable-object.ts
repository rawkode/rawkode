// `GatekeeperAccountDurableObject` — one instance per connected Google account, keyed by the
// connecting Athenaeum user's email (`ctx.id.name === email`, addressed via
// `ctx.exports.GatekeeperAccountDurableObject.getByName(email)`, mirroring
// `UserDurableObject`'s own `idFromName(email)` addressing in `@athenaeum/backend`). This is
// this stage's "GatekeeperUser" adaptation — see `gatekeeper-account-service.ts`'s header comment
// for the full design rationale; this DO class is the thin storage/dispatch shell around that
// Service, following `WorkspaceDurableObject`'s own established "DO class boundary" pattern exactly
// ("build the instance's Effect Layer once in the DO constructor... every public RPC method is a
// thin shim").
//
// **No Cap'n Web `fetch()` override here, unlike `WorkspaceDurableObject`** — this DO has no direct
// external client (a browser never connects to it). It is reached exactly two ways, both
// same-Worker/same-trust-domain: (1) `worker.ts`'s own `fetch()` handler, dispatching to these
// plain `async` methods via `ctx.exports` (native Workers RPC) after parsing an inbound HTTP
// request from `athenaeum-backend`'s service binding; (2) ANOTHER
// `GatekeeperAccountDurableObject` instance's own `addObserver`/`onCalendarTouched`, resolving an
// observer's access token via `getAccessTokenForVerification` (`this.ctx.exports
// .GatekeeperAccountDurableObject.getByName(...)`, the same "reach a sibling DO instance via
// `ctx.exports`" pattern `env.d.ts` documents as valid — "e.g. `this.ctx.exports.UserDurableObject`",
// cited from cloudflare-os). Neither caller is an untrusted external client, so there is no Cap'n
// Web object-capability surface to build here — see `rpc-boundary.ts`'s header comment for the
// full "why not Cap'n Web on this hop" reasoning.

import { DurableObject } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Schema from "effect/Schema"
import { CalendarEventDraft, CalendarEventPatch } from "./calendar-types.js"
import { GatekeeperAccountService, type GatekeeperAccountServiceApi } from "./gatekeeper-account-service.js"
import { makeGatekeeperAccountServiceLive } from "./gatekeeper-account-service-live.js"
import { makeGoogleCalendarClientRealLive } from "./google-calendar-client-real.js"
import { HttpFetchLive } from "./http-fetch.js"
import { makeObserverLedgerCollections, makeObserverLedgerTypedStorageLive } from "./observer-ledger-typed-storage.js"
import { GatekeeperUserVerifier, type ObserverIdentity } from "./observer-verifier.js"
import { errorEnvelopeFromCause, throwErrorEnvelope } from "./rpc-boundary.js"
import { makeTokenSingleton, makeTokenStoreTypedStorageLive } from "./token-store-typed-storage.js"
import type { CalendarEventsListQuery, SendUpdatesOptions } from "./google-calendar-client.js"

export interface Env {
  readonly GOOGLE_OAUTH_CLIENT_ID?: string
  readonly GOOGLE_OAUTH_CLIENT_SECRET?: string
  /** Dev-only-style HMAC secret this account's own `GatekeeperUserVerifier` tokens are signed
   *  with — see `gatekeeper-account-service-live.ts`'s `GatekeeperAccountServiceConfig` doc
   *  comment and `wrangler.jsonc`'s own comment on this var for the same "plaintext var is a
   *  deliberate, documented dev-only choice" rationale `athenaeum-backend`'s
   *  `DEV_AUTH_HMAC_SECRET` already establishes. Unconfigured means every `getVerifier`/
   *  `addObserver` call fails closed (see `#requireVerifierSecretConfigured` below), never a
   *  silently guessable default. */
  readonly GATEKEEPER_VERIFIER_HMAC_SECRET?: string
}

/** Minimal shape-check for the wire `CalendarEventsListQuery` — a plain TS discriminated union
 *  (`google-calendar-client.ts`'s own doc comment explains why it's a type, not an
 *  `effect/Schema`), so unlike `CalendarEventDraft`/`CalendarEventPatch` below there is no
 *  existing `Schema.Class` to decode through. This is an internal service-binding call, not a
 *  publicly reachable endpoint (see this file's header comment), so a loose runtime check —
 *  rejecting anything that isn't shaped like one of the two valid modes — is proportionate:
 *  enough to fail closed on a malformed body without hand-rolling a full parallel schema for a
 *  type this package already declares precisely at the TypeScript level. */
const decodeEventsListQuery = (value: unknown): CalendarEventsListQuery => {
  const v = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
  if (v === undefined) return throwErrorEnvelope({ tag: "ValidationError", message: "eventsPage: query must be an object" })
  if (
    v.mode === "window" &&
    typeof v.timeMin === "string" &&
    typeof v.timeMax === "string" &&
    typeof v.singleEvents === "boolean" &&
    typeof v.showDeleted === "boolean"
  ) {
    return value as CalendarEventsListQuery
  }
  if (v.mode === "syncToken" && typeof v.syncToken === "string" && typeof v.singleEvents === "boolean") {
    return value as CalendarEventsListQuery
  }
  return throwErrorEnvelope({ tag: "ValidationError", message: "eventsPage: query did not match either valid CalendarEventsListQuery mode" })
}

export class GatekeeperAccountDurableObject extends DurableObject<Env> {
  readonly #runtime: ManagedRuntime.ManagedRuntime<GatekeeperAccountService, never>
  readonly #connectionId: string
  readonly #verifierHmacSecret: string | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // New connections are addressed by a random `gpc_…` custody key. The token-owning DO never
    // derives an Athenaeum email from its name; legacy email-named instances remain reachable only
    // through the authenticated migration adapter in worker.ts.
    this.#connectionId = ctx.id.name ?? "unknown"
    this.#verifierHmacSecret = env.GATEKEEPER_VERIFIER_HMAC_SECRET

    const tokenSingleton = makeTokenSingleton(ctx.storage)
    const observerLedgerCollections = makeObserverLedgerCollections(ctx.storage)

    const googleCalendarClientLive = makeGoogleCalendarClientRealLive({
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET
    }).pipe(Layer.provide(HttpFetchLive))
    const observerLedgerLive = makeObserverLedgerTypedStorageLive(observerLedgerCollections)
    const tokenStoreLive = makeTokenStoreTypedStorageLive(tokenSingleton)

    const accountServiceLive = makeGatekeeperAccountServiceLive({
      connectionId: this.#connectionId,
      // A verifier can never be minted/unwrapped without a configured secret — checked at call
      // time (`#requireVerifierSecretConfigured`, not here), so an unconfigured secret fails
      // closed per-call with a clear message rather than at DO construction (every non-observer
      // calendar operation must keep working with no verifier secret configured at all).
      verifierHmacSecret: this.#verifierHmacSecret ?? ""
    }).pipe(Layer.provide(Layer.mergeAll(googleCalendarClientLive, observerLedgerLive, tokenStoreLive)))

    this.#runtime = ManagedRuntime.make(accountServiceLive)
  }

  #requireVerifierSecretConfigured(): void {
    if (this.#verifierHmacSecret === undefined || this.#verifierHmacSecret.length === 0) {
      throwErrorEnvelope({
        tag: "GatekeeperAccountNotConnected",
        message: "GATEKEEPER_VERIFIER_HMAC_SECRET is not configured on this deployment."
      })
    }
  }

  /** Every method below funnels through this — runs `f(service)` against this instance's
   *  `ManagedRuntime` (built exactly once, in the constructor, per `WorkspaceDurableObject`'s own
   *  established rationale) and either returns the success value or throws the `{tag, message}`
   *  envelope (`rpc-boundary.ts`). */
  #run<A, E>(f: (service: GatekeeperAccountServiceApi) => Effect.Effect<A, E>): Promise<A> {
    return this.#runtime.runPromiseExit(Effect.flatMap(GatekeeperAccountService, f)).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value
      return throwErrorEnvelope(errorEnvelopeFromCause(exit.cause))
    })
  }

  // --- OAuth lifecycle -------------------------------------------------------------------------
  //
  // NOT named `connect` — `DurableObject`'s own base class reserves that name for its TCP-socket
  // RPC surface (`connect(socket: Socket): void | Promise<void>`); this method completes the
  // OAuth code exchange, hence `completeOAuth`.

  async completeOAuth(
    code: string,
    redirectUri: string,
    attemptId?: string
  ): Promise<{ readonly connected: boolean } | { readonly receiptDigest: string; readonly completionFactDigest: string; readonly completedAt: string }> {
    const receipt = await this.#run((s) => s.connect(attemptId, code, redirectUri))
    return receipt === undefined ? { connected: true } : receipt
  }

  async oauthStatus(attemptId: string): Promise<{ readonly receiptDigest: string; readonly completionFactDigest: string; readonly completedAt: string }> {
    return this.#run((s) => s.getOAuthCompletion(attemptId))
  }

  async disconnect(): Promise<void> {
    await this.#run((s) => s.disconnect)
  }

  async isConnected(): Promise<boolean> {
    return this.#run((s) => s.isConnected)
  }

  /** `ctx.exports`-only (see file header) — never returns the access token to an external HTTP
   *  caller; only ANOTHER `GatekeeperAccountDurableObject` (resolving an observer's identity
   *  during `addObserver`/`onCalendarTouched`) ever calls this. */
  async getAccessTokenForVerification(): Promise<string> {
    return this.#run((s) => s.getAccessToken)
  }

  // --- Calendar operations -----------------------------------------------------------------------

  async listCalendars(): Promise<unknown> {
    return this.#run((s) => s.listCalendars)
  }

  async eventsPage(calendarId: string, rawQuery: unknown): Promise<unknown> {
    const query = decodeEventsListQuery(rawQuery)
    return this.#run((s) => s.eventsPage(calendarId, query))
  }

  async createEvent(calendarId: string, rawDraft: unknown, options?: SendUpdatesOptions): Promise<unknown> {
    const decodeExit = await Effect.runPromiseExit(Schema.decodeUnknown(CalendarEventDraft)(rawDraft))
    if (Exit.isFailure(decodeExit)) {
      return throwErrorEnvelope({ tag: "ValidationError", message: "createEvent: draft did not match CalendarEventDraft" })
    }
    return this.#run((s) => s.createEvent(calendarId, decodeExit.value, options))
  }

  async updateEvent(calendarId: string, eventId: string, rawPatch: unknown, options?: SendUpdatesOptions): Promise<unknown> {
    const decodeExit = await Effect.runPromiseExit(Schema.decodeUnknown(CalendarEventPatch)(rawPatch))
    if (Exit.isFailure(decodeExit)) {
      return throwErrorEnvelope({ tag: "ValidationError", message: "updateEvent: patch did not match CalendarEventPatch" })
    }
    return this.#run((s) => s.updateEvent(calendarId, eventId, decodeExit.value, options))
  }

  async deleteEvent(calendarId: string, eventId: string, options?: SendUpdatesOptions): Promise<void> {
    await this.#run((s) => s.deleteEvent(calendarId, eventId, options))
  }

  async freeBusy(calendarIds: ReadonlyArray<string>, timeMin: string, timeMax: string): Promise<unknown> {
    return this.#run((s) => s.freeBusy(calendarIds, timeMin, timeMax))
  }

  // --- Observer verification (docs/observers.md §7) ---------------------------------------------

  async getVerifier(observerEmail: string): Promise<{ readonly token: string }> {
    this.#requireVerifierSecretConfigured()
    const verifier = await this.#run((s) => s.getVerifier(observerEmail))
    return { token: verifier.token }
  }

  /**
   * `Gatekeeper.addObserver()`'s real entry point (`docs/observers.md` §7). `mode`/`calendarId`
   * come from the caller (`worker.ts`, which reads them off the workspace's `GatekeeperBinding`) —
   * this DO holds no binding storage of its own (see `gatekeeper-account-service.ts`'s own doc
   * comment on this). `resolveAccessToken` is built HERE (not passed in — only a same-Worker DO
   * method can reach `this.ctx.exports`) by addressing the OBSERVER's own
   * `GatekeeperAccountDurableObject` — a DIFFERENT instance, keyed by `identity.connectionId`
   * (this design's `connectionId === observerEmail`, see `GatekeeperAccountServiceLive#getVerifier`'s
   * own construction) — and calling ITS `getAccessTokenForVerification()`, the cross-DO
   * `ctx.exports` hop this file's header comment describes.
   */
  async addObserver(
    bindingId: string,
    observerId: string,
    verifierToken: string,
    mode: "selected" | "allVisible",
    calendarId: string
  ): Promise<void> {
    this.#requireVerifierSecretConfigured()
    const verifier = new GatekeeperUserVerifier({ token: verifierToken })
    await this.#run((s) => s.addObserver(bindingId, observerId, verifier, mode, calendarId, this.#resolveObserverAccessToken))
  }

  async removeObserver(bindingId: string, observerId: string): Promise<void> {
    await this.#run((s) => s.removeObserver(bindingId, observerId))
  }

  /** Called by the future calendar-merge/sync loop (backend, via `worker.ts`) whenever an
   *  `allVisible` binding's free/busy read successfully touches a calendar. See
   *  `observer-verification.ts#onDatasetTouched`'s own doc comment for the honest gap in what
   *  happens to `failedObserverIds` today (returned to the caller, not yet acted on — no
   *  `excludeObservers` consumer exists in Athenaeum yet). */
  async onCalendarTouched(bindingId: string, calendarId: string): Promise<{ readonly failedObserverIds: ReadonlyArray<string> }> {
    return this.#run((s) => s.onCalendarTouched(bindingId, calendarId, this.#resolveObserverAccessToken))
  }

  /** The cross-DO hop itself — resolves `identity.connectionId` (an email, in this design) to a
   *  live access token by addressing that OTHER account's own DO instance. Never fails with a
   *  typed `GatekeeperAccountServiceError` of its own; any failure (the sibling DO throwing its
   *  own envelope, e.g. because that account was never connected) is treated uniformly as
   *  "cannot verify this observer" by `rpc-boundary.ts`'s own defect-flattening — deliberately
   *  simple rather than parsing the sibling's thrown envelope and re-deriving a matching typed
   *  error, since either way the caller-visible outcome is the same denial. */
  readonly #resolveObserverAccessToken = (identity: ObserverIdentity): Effect.Effect<string, never> =>
    Effect.tryPromise({
      try: () => this.ctx.exports.GatekeeperAccountDurableObject.getByName(identity.connectionId).getAccessTokenForVerification(),
      catch: (cause) => cause
    }).pipe(Effect.catchAll((error) => Effect.die(error)))
}
