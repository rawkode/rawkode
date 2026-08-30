// `GatekeeperAccountServiceLive` — the real implementation behind `GatekeeperAccountService`. See
// that file's header comment for the full "GatekeeperUser adaptation" design; this file is where
// it actually runs.
//
// Every method below is exposed at the `GatekeeperAccountServiceApi` interface with a closed `R`
// (no third Effect type parameter — i.e. `R = never`), matching every other fully-resolved Live
// service in this codebase (`GraphService`, `NotesService`, …). `GoogleCalendarClient`/
// `ObserverLedger` are resolved ONCE here (`yield* GoogleCalendarClient`/`yield* ObserverLedger`,
// at Layer-construction time) and closed over as plain values, then explicitly re-provided
// (`Effect.provideService`) into the handful of methods that call into `observer-verification.ts`'s
// own functions (which independently `yield* GoogleCalendarClient`/`yield* ObserverLedger`
// themselves) — needed because those functions' own requirement does NOT automatically propagate
// through a value returned (not yielded) from the outer `Effect.gen`, the standard Effect
// closure-capture gotcha this comment exists to flag for the next reader.

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  GatekeeperAccountNotConnected,
  type GatekeeperAccountServiceError,
  type GoogleCalendarClientError
} from "./errors.js"
import { GoogleCalendarClient } from "./google-calendar-client.js"
import { ObserverLedger } from "./observer-ledger.js"
import {
  addObserverStrategyC,
  onDatasetTouched,
  removeObserverStrategyC,
  verifyObserverStrategyB,
  type AccessTokenResolver
} from "./observer-verification.js"
import { GatekeeperAccountService, type GatekeeperAccountServiceApi } from "./gatekeeper-account-service.js"
import { TokenStore } from "./token-store.js"
import { mintGatekeeperUserVerifier, unwrapGatekeeperUserVerifier, type ObserverIdentity } from "./observer-verifier.js"

/** Refresh proactively once an access token is within this margin of its documented expiry —
 *  mirrors the standard "refresh a bit early, not exactly at the deadline" discipline (avoids a
 *  request that starts valid but expires mid-flight to Google). Deliberately generous per this
 *  workspace's own resource-limit convention (favor headroom over precision). */
const ACCESS_TOKEN_REFRESH_SAFETY_MARGIN_MS = 60_000

/** How long a minted `GatekeeperUserVerifier` stays valid before the overseer-equivalent
 *  (`ensureObserver`-analog, next stage) must mint a fresh one. `docs/observers.md` re-mints on
 *  every open, so this only needs to outlive one open-and-verify round trip — an hour is generous
 *  headroom for that, matching `dev-auth.ts`'s own `DEV_CREDENTIAL_TTL_SECONDS` precedent. */
const VERIFIER_TTL_SECONDS = 60 * 60

export interface GatekeeperAccountServiceConfig {
  /** Opaque DO custody key. An Athenaeum principal is deliberately not retained in this token-owning
   *  service; the backend verifies that relationship before invoking this Worker. */
  readonly connectionId: string
  /** Signs/verifies this account's own minted `GatekeeperUserVerifier` tokens — see
   *  `observer-verifier.ts`'s header comment for why this is an HMAC secret local to this
   *  package/Worker, not shared with `athenaeum-backend`'s own `DEV_AUTH_HMAC_SECRET`. */
  readonly verifierHmacSecret: string
}

export const makeGatekeeperAccountServiceLive = (
  config: GatekeeperAccountServiceConfig
): Layer.Layer<GatekeeperAccountService, never, GoogleCalendarClient | ObserverLedger | TokenStore> =>
  Layer.effect(
    GatekeeperAccountService,
    Effect.gen(function* () {
      const client = yield* GoogleCalendarClient
      const ledger = yield* ObserverLedger
      const tokens = yield* TokenStore

      /** Re-provides the two services `observer-verification.ts`'s own functions independently
       *  `yield*` — see this file's header comment for why this is necessary, not redundant. */
      const withObserverServices = <A, E>(
        effect: Effect.Effect<A, E, GoogleCalendarClient | ObserverLedger>
      ): Effect.Effect<A, E> =>
        effect.pipe(
          Effect.provideService(GoogleCalendarClient, client),
          Effect.provideService(ObserverLedger, ledger)
        )

      const completionDigest = (attemptId: string, code: string, redirectUri: string): Effect.Effect<string> =>
        Effect.promise(async () => {
          const bytes = new TextEncoder().encode(`${config.connectionId}\u0000${attemptId}\u0000${code}\u0000${redirectUri}`)
          const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
          return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
        })

      const connect: GatekeeperAccountServiceApi["connect"] = (attemptId, code, redirectUri) =>
        Effect.gen(function* () {
          const current = yield* tokens.get
          const requestDigest = attemptId === undefined ? undefined : yield* completionDigest(attemptId, code, redirectUri)
          if (attemptId !== undefined && current.completion !== undefined) {
            if (current.completion.attemptId === attemptId && current.completion.requestDigest === requestDigest && current.connected) return
            return yield* Effect.fail(new GatekeeperAccountNotConnected({ message: "OAuth completion does not match this connection." }))
          }
          const exchanged = yield* client.exchangeAuthorizationCode(code, redirectUri)
          const refreshToken = exchanged.refreshToken ?? current.refreshToken
          if (refreshToken === undefined || refreshToken.trim().length === 0) {
            return yield* Effect.fail(new GatekeeperAccountNotConnected({ message: "OAuth completion did not grant durable access." }))
          }
          yield* tokens.put({
            connected: true,
            accessToken: exchanged.accessToken,
            accessTokenExpiresAtMs: Date.now() + exchanged.expiresInSeconds * 1000,
            // Google only returns a refresh token on the FIRST exchange (OAuthTokens.refreshToken's
            // own doc comment) — keep the original if this exchange didn't return a new one.
            refreshToken,
            ...(attemptId !== undefined && requestDigest !== undefined
              ? { completion: { attemptId, requestDigest, completedAt: new Date().toISOString() } }
              : {})
          })
        })

      const disconnect: GatekeeperAccountServiceApi["disconnect"] = tokens.clear

      const isConnected: GatekeeperAccountServiceApi["isConnected"] = tokens.get.pipe(
        Effect.map((t) => t.connected)
      )

      /** Forces a real refresh (ignores whatever is cached) and persists the result — the ONE
       *  place `refreshAccessToken` is called, so both the proactive-expiry path and the reactive
       *  401-retry path below share identical persistence logic. */
      const refreshNow: Effect.Effect<string, GatekeeperAccountServiceError> = Effect.gen(function* () {
        const current = yield* tokens.get
        if (current.refreshToken === undefined || current.refreshToken.trim().length === 0) {
          return yield* Effect.fail(
            new GatekeeperAccountNotConnected({
              message: "This calendar connection has no durable authorization."
            })
          )
        }
        const refreshed = yield* client.refreshAccessToken(current.refreshToken)
        yield* tokens.put({
          connected: true,
          accessToken: refreshed.accessToken,
          accessTokenExpiresAtMs: Date.now() + refreshed.expiresInSeconds * 1000,
          // Never rotated on this grant type (OAuthTokens.refreshToken's own doc comment) — keep
          // the same one this refresh was called with.
          refreshToken: current.refreshToken,
          ...(current.completion === undefined ? {} : { completion: current.completion })
        })
        return refreshed.accessToken
      })

      const getAccessToken: GatekeeperAccountServiceApi["getAccessToken"] = Effect.gen(function* () {
        const current = yield* tokens.get
        if (!current.connected) {
          return yield* Effect.fail(
            new GatekeeperAccountNotConnected({
          message: "This calendar connection has not completed the OAuth flow."
            })
          )
        }
        const stillValid =
          current.accessToken !== undefined &&
          current.accessTokenExpiresAtMs !== undefined &&
          current.accessTokenExpiresAtMs - ACCESS_TOKEN_REFRESH_SAFETY_MARGIN_MS > Date.now()
        if (stillValid) return current.accessToken as string
        return yield* refreshNow
      })

      /**
       * Wraps one Google Calendar call with this account's resolved access token, retrying ONCE
       * on a 401 by forcing a real refresh first (task item 5: "refresh-token-on-401 retry").
       * Deliberately NOT built into `GoogleCalendarClientReal` itself — see that file's own doc
       * comment ("this client never refreshes implicitly... keeping token-lifecycle policy OUT of
       * this thin client is a deliberate scope line") — this is exactly where that policy lives
       * instead: the account-service layer, which alone owns the refresh token.
       */
      const withAccessTokenRetry = <A>(
        op: (accessToken: string) => Effect.Effect<A, GoogleCalendarClientError>
      ): Effect.Effect<A, GatekeeperAccountServiceError> =>
        getAccessToken.pipe(
          Effect.flatMap((accessToken) =>
            op(accessToken).pipe(
              Effect.catchIf(
                (error): error is GoogleCalendarClientError & { status?: number } =>
                  error._tag === "GoogleCalendarRequestFailed" && error.status === 401,
                () => refreshNow.pipe(Effect.flatMap(op))
              )
            )
          )
        )

      const listCalendars: GatekeeperAccountServiceApi["listCalendars"] = withAccessTokenRetry((token) =>
        client.listCalendars(token)
      )

      const eventsPage: GatekeeperAccountServiceApi["eventsPage"] = (calendarId, query) =>
        withAccessTokenRetry((token) => client.listEvents(token, calendarId, query))

      const createEvent: GatekeeperAccountServiceApi["createEvent"] = (calendarId, draft, options) =>
        withAccessTokenRetry((token) => client.createEvent(token, calendarId, draft, options))

      const updateEvent: GatekeeperAccountServiceApi["updateEvent"] = (calendarId, eventId, patch, options) =>
        withAccessTokenRetry((token) => client.updateEvent(token, calendarId, eventId, patch, options))

      const deleteEvent: GatekeeperAccountServiceApi["deleteEvent"] = (calendarId, eventId, options) =>
        withAccessTokenRetry((token) => client.deleteEvent(token, calendarId, eventId, options))

      const freeBusy: GatekeeperAccountServiceApi["freeBusy"] = (calendarIds, timeMin, timeMax) =>
        withAccessTokenRetry((token) => client.freeBusy(token, calendarIds, timeMin, timeMax))

      const getVerifier: GatekeeperAccountServiceApi["getVerifier"] = (observerEmail) => Effect.gen(function* () {
        const current = yield* Effect.orDie(tokens.get)
        if (!current.connected) {
          return yield* Effect.fail(
            new GatekeeperAccountNotConnected({
            message: "This calendar connection has not completed the OAuth flow."
            })
          )
        }
        return yield* mintGatekeeperUserVerifier(
          { observerEmail, connectionId: config.connectionId } as ObserverIdentity,
          config.verifierHmacSecret,
          VERIFIER_TTL_SECONDS
        )
      })

      const addObserver: GatekeeperAccountServiceApi["addObserver"] = (
        bindingId,
        observerId,
        verifier,
        mode,
        calendarId,
        resolveAccessToken
      ) =>
        withObserverServices(
          Effect.gen(function* () {
            const identity = yield* unwrapGatekeeperUserVerifier(verifier, config.verifierHmacSecret)
            if (mode === "selected") {
              const token = yield* resolveAccessToken(identity)
              yield* verifyObserverStrategyB(observerId, token, calendarId)
            } else {
              const token = yield* resolveAccessToken(identity)
              yield* addObserverStrategyC(bindingId, observerId, identity, token)
            }
          })
        )

      const removeObserver: GatekeeperAccountServiceApi["removeObserver"] = (bindingId, observerId) =>
        withObserverServices(removeObserverStrategyC(bindingId, observerId))

      const onCalendarTouched: GatekeeperAccountServiceApi["onCalendarTouched"] = (
        bindingId,
        calendarId,
        resolveAccessToken
      ) => withObserverServices(onDatasetTouched(bindingId, calendarId, resolveAccessToken as AccessTokenResolver))

      return {
        connect,
        disconnect,
        isConnected,
        getAccessToken,
        listCalendars,
        eventsPage,
        createEvent,
        updateEvent,
        deleteEvent,
        freeBusy,
        getVerifier,
        addObserver,
        removeObserver,
        onCalendarTouched
      } satisfies GatekeeperAccountServiceApi
    })
  )
