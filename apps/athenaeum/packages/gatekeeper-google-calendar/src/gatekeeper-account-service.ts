// `GatekeeperAccountService` — the real logic behind this stage's "GatekeeperUser" adaptation
// (task item 2). Per `workspace-durable-object.ts`'s own established "DO class boundary" pattern
// ("one DO class, composed from separate Effect Services... real logic lives in the per-domain
// *-service-live.ts modules"), `GatekeeperAccountDurableObject` (this package's DO) is a thin
// Cap'n-Web-free RPC/storage-composition shell; every real behavior below is this Service,
// testable with plain Vitest + in-memory `Layer`s (`TokenStoreInMemory`, `ObserverLedgerInMemory`)
// with zero `workerd`/DO dependency — the same "Testing payoff" the plan promises for every other
// Effect Service in this codebase.
//
// **Adaptation from cloudflare-os's `GatekeeperUser`** (documented in full in
// docs/gatekeeper-google-calendar-decisions.md, restated here at the point that actually
// implements it): cloudflare-os's `GatekeeperUser` is a `WorkerEntrypoint` living inside a
// per-vendor `UserAccount` Durable Object owned by the User DO; `getGatekeeperClassFor()` hands
// back a `Fetcher` scoped to one connected account. Athenaeum has no User-DO-owned per-vendor
// account registry (Phase 4's `UserDurableObject` only holds the workspace catalog — see
// `user-durable-object.ts`). This stage's adaptation, pragmatic per the task's own instruction:
// **one `GatekeeperAccountDurableObject`, in THIS gatekeeper's own Worker, per connected Google
// account — keyed by the connecting Athenaeum user's email** (`ctx.id.name === email`, mirroring
// `UserDurableObject`'s own `idFromName(email)` addressing). The refresh token lives in that DO's
// storage (`TokenStore`/`token-store-typed-storage.ts`) and is never returned across the RPC
// boundary — only derived data (calendars, events, free/busy, a boolean `connected` flag) is.
// `WorkspaceDurableObject` (the "main backend Worker") reaches this account's calendar operations via
// a plain HTTP service-binding call to this Worker's own `worker.ts` fetch handler, which
// dispatches to this DO's methods over same-Worker `ctx.exports` (native Workers RPC) — see
// `worker.ts`'s own header comment for why that hop is plain JSON-over-fetch, not a second Cap'n
// Web session: `getGatekeeperClassFor()`'s literal cloudflare-os equivalent (handing back a live
// capability stub) is exactly what this stage deliberately simplifies away, since Athenaeum has
// no Dynamic-Worker-Facet architecture for such a stub to be scoped by.

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type {
  CalendarEvent,
  CalendarEventDraft,
  CalendarEventPatch,
  CalendarEventsPage,
  GoogleCalendarInfo,
  PersonAvailability
} from "./calendar-types.js"
import type { GatekeeperAccountServiceError, GatekeeperAccountNotConnected } from "./errors.js"
import type { CalendarEventsListQuery, SendUpdatesOptions } from "./google-calendar-client.js"
import type { GatekeeperUserVerifier, ObserverIdentity } from "./observer-verifier.js"

/** Private proof that an opaque OAuth attempt reached this account's durable completion fact. */
export interface OAuthCompletionReceipt {
  readonly receiptDigest: string
  readonly completionFactDigest: string
  readonly completedAt: string
}

/** Supplied by the DO wrapper (`gatekeeper-account-durable-object.ts`), which alone has
 *  `ctx.exports` access to reach a DIFFERENT account's own DO instance — see that file's own
 *  `addObserver` doc comment. Re-exported here (not redefined) from `observer-verification.ts`'s
 *  own `AccessTokenResolver`, which this service's `addObserver`/`onCalendarTouched` delegate to
 *  directly, unchanged. */
export type { AccessTokenResolver } from "./observer-verification.js"

export interface GatekeeperAccountServiceApi {
  // --- OAuth lifecycle (ctx.exports-only at the DO layer — see that file) -------------------
  readonly connect: (
    attemptId: string | undefined,
    code: string,
    redirectUri: string
  ) => Effect.Effect<OAuthCompletionReceipt | undefined, GatekeeperAccountServiceError>
  /** Looks up a completed opaque attempt without exchanging a provider code again. */
  readonly getOAuthCompletion: (attemptId: string) => Effect.Effect<OAuthCompletionReceipt, GatekeeperAccountServiceError>
  readonly disconnect: Effect.Effect<void>
  readonly isConnected: Effect.Effect<boolean>
  /** The account's own, currently-valid access token — refreshed if expired/expiring. Used by
   *  THIS account's own calendar operations below, AND (via the DO wrapper's `ctx.exports`)
   *  by another account's `addObserver` call resolving THIS account as an observer's identity —
   *  see `gatekeeper-account-durable-object.ts`'s `getAccessTokenForVerification` doc comment. */
  readonly getAccessToken: Effect.Effect<string, GatekeeperAccountServiceError>

  // --- Calendar operations (task item 3/4: "expose calendar operations as RPC methods") -----
  // Every one of these resolves this account's own access token internally, retrying ONCE on a
  // 401 (task item 5: "refresh-token-on-401 retry") by forcing a real refresh before re-issuing
  // the SAME call — see `gatekeeper-account-service-live.ts`'s `withAccessTokenRetry` doc comment.
  readonly listCalendars: Effect.Effect<ReadonlyArray<GoogleCalendarInfo>, GatekeeperAccountServiceError>
  readonly eventsPage: (
    calendarId: string,
    query: CalendarEventsListQuery
  ) => Effect.Effect<CalendarEventsPage, GatekeeperAccountServiceError>
  readonly createEvent: (
    calendarId: string,
    draft: CalendarEventDraft,
    options?: SendUpdatesOptions
  ) => Effect.Effect<CalendarEvent, GatekeeperAccountServiceError>
  readonly updateEvent: (
    calendarId: string,
    eventId: string,
    patch: CalendarEventPatch,
    options?: SendUpdatesOptions
  ) => Effect.Effect<CalendarEvent, GatekeeperAccountServiceError>
  readonly deleteEvent: (
    calendarId: string,
    eventId: string,
    options?: SendUpdatesOptions
  ) => Effect.Effect<void, GatekeeperAccountServiceError>
  readonly freeBusy: (
    calendarIds: ReadonlyArray<string>,
    timeMin: string,
    timeMax: string
  ) => Effect.Effect<ReadonlyArray<PersonAvailability>, GatekeeperAccountServiceError>

  // --- Observer verification (docs/observers.md §7's `Gatekeeper` contract, Strategy B/C) ----
  /** Mints a `GatekeeperUserVerifier` proving "this Athenaeum account is the one that connected
   *  THIS Google account" — called when this account acts as an OBSERVER of someone ELSE's
   *  binding (`observer-verifier.ts`'s own `mintGatekeeperUserVerifier`, bound to this account's
   *  own identity). Requires `connect()` to have succeeded at least once (fails
   *  `GatekeeperAccountNotConnected` otherwise) — an account that never connected has nothing to
   *  vouch for. */
  readonly getVerifier: (observerEmail: string) => Effect.Effect<GatekeeperUserVerifier, GatekeeperAccountNotConnected>
  /** `Gatekeeper.addObserver()`'s real implementation for whichever binding calls it (this
   *  account is the one whose calendar connection the binding is bound to). `mode`/`calendarId`
   *  come from the binding (this service has no binding storage of its own — see
   *  `observer-ledger.ts`'s own `bindingId`-keyed design, which already anticipates this: one
   *  ledger, many bindings, all against this same account's own touched-calendar log).
   *  `resolveAccessToken` is how the OBSERVER's own access token gets resolved — see this file's
   *  `AccessTokenResolver` re-export. */
  readonly addObserver: (
    bindingId: string,
    observerId: string,
    verifier: GatekeeperUserVerifier,
    mode: "selected" | "allVisible",
    calendarId: string,
    resolveAccessToken: (identity: ObserverIdentity) => Effect.Effect<string, GatekeeperAccountServiceError>
  ) => Effect.Effect<void, GatekeeperAccountServiceError>
  readonly removeObserver: (
    bindingId: string,
    observerId: string
  ) => Effect.Effect<void>
  /** Strategy C's "a new observation just read a calendar we've never logged before" half — see
   *  `observer-verification.ts#onDatasetTouched`'s own doc comment for the full contract and the
   *  honest gap in what happens to `failedObserverIds` (no `excludeObservers` consumer exists in
   *  Athenaeum yet). No-op (never called) for a `"selected"`-mode binding — Strategy B has no
   *  dataset log. */
  readonly onCalendarTouched: (
    bindingId: string,
    calendarId: string,
    resolveAccessToken: (identity: ObserverIdentity) => Effect.Effect<string, GatekeeperAccountServiceError>
  ) => Effect.Effect<{ readonly failedObserverIds: ReadonlyArray<string> }, never>
}

export class GatekeeperAccountService extends Context.Tag(
  "@athenaeum/gatekeeper-google-calendar/GatekeeperAccountService"
)<GatekeeperAccountService, GatekeeperAccountServiceApi>() {}
