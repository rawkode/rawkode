// `TokenStore` — per-account OAuth token storage, the thing `GatekeeperAccountService` (task
// item 2's "GatekeeperUser... stores refresh token securely, never logged/returned to clients")
// actually persists. Same two-Layer split as `GoogleCalendarClient`/`ObserverLedger`: a
// zero-storage-dependency `Context.Tag` here plus a real in-memory `Layer` (this file — used by
// `gatekeeper-account-service.test.ts` and any future business-logic test, per the plan's own
// "Testing payoff" paragraph), and a `typed-storage-effect`-backed real `Layer` in
// `token-store-typed-storage.ts` for the real `GatekeeperAccountDurableObject`.
//
// **"Never logged/returned to clients"**: nothing in this module (or `gatekeeper-account-
// service-live.ts`, which is the only thing that reads/writes through this Tag) ever puts a
// `StoredTokens` value — or `accessToken`/`refreshToken` individually — into an RPC response,
// a thrown error's `message`, or a `console.log`. The only things that ever cross the
// `GatekeeperAccountDurableObject`'s own boundary (worker.ts) are: a boolean `connected` flag
// (`isConnected()`), and derived DATA the tokens were used to fetch from Google (calendars,
// events, free/busy) — never the tokens themselves.

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"

export interface StoredTokens {
  readonly connected: boolean
  readonly accessToken?: string
  /** Epoch milliseconds — computed once from the token endpoint's `expires_in` (seconds-from-now)
   *  at the moment it was received, per `OAuthTokens.expiresInSeconds`'s own doc comment ("the
   *  caller chooses its own clock/skew discipline"). */
  readonly accessTokenExpiresAtMs?: number
  /** Absent only if this account has never completed a code exchange at all — once granted,
   *  Google's token endpoint does not return a new one on every exchange/refresh (`OAuthTokens
   *  .refreshToken`'s own doc comment: "the caller... keeps using the ORIGINAL refresh token"), so
   *  a later `connect()`/refresh call must never overwrite a present value with `undefined`. */
  readonly refreshToken?: string
}

export const DISCONNECTED_TOKENS: StoredTokens = { connected: false }

export interface TokenStoreApi {
  readonly get: Effect.Effect<StoredTokens>
  readonly put: (tokens: StoredTokens) => Effect.Effect<void>
  readonly clear: Effect.Effect<void>
}

export class TokenStore extends Context.Tag("@athenaeum/gatekeeper-google-calendar/TokenStore")<
  TokenStore,
  TokenStoreApi
>() {}

/** Real (not mocked) in-memory `Layer` — appropriate for unit tests, matching `ObserverLedger
 *  InMemory`'s own doc comment verbatim: NOT the production storage (see
 *  `token-store-typed-storage.ts`), since state here does not survive a Worker restart. */
export const TokenStoreInMemory: Layer.Layer<TokenStore> = Layer.effect(
  TokenStore,
  Effect.gen(function* () {
    const ref = yield* Ref.make<StoredTokens>(DISCONNECTED_TOKENS)
    return {
      get: Ref.get(ref),
      put: (tokens) => Ref.set(ref, tokens),
      clear: Ref.set(ref, DISCONNECTED_TOKENS)
    }
  })
)
