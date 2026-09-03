// Strategy B (single-ACL-unit) and Strategy C (dataset-tracking) — task item 2's core algorithms,
// ported from `docs/observers.md` §9.1's decision-table entries for "Google Calendar (selected
// calendar)" (→ B) and "Google Calendar (`allVisible` availability)" (→ C), and from
// `Gatekeeper.addObserver()`'s documented contract in `packages/workshop-shared/src/gatekeeper.ts`
// (read in full per this task's instructions). Full design writeup: docs/gatekeeper-google-
// calendar-decisions.md §2. This is the "concrete interface the next stages build against" the
// task asks this stage to report — see that section's own summary at the end of this file's
// sibling doc.
//
// **Strategy B** (`docs/observers.md` §9.1: "the resource is treated as one atomic unit... No
// `excludeObservers` is needed: the whole unit is covered up front, so nothing read later could be
// invisible to a verified observer."): a selected-calendar binding requires the observer's own
// connected account to have `writer` or `owner` `accessRole` on that SAME calendar — never
// `reader`, because "reader access hides private-event details" (task item 2's own wording,
// verbatim from `docs/observers.md`'s decision-table row and cloudflare-os's own
// `calendar-api.ts`/`calendar-types.d.ts` precedent this package's `getCalendar` behaviorally
// ports).
//
// **Strategy C** (`docs/observers.md` §9.1: "The Gatekeeper DO maintains its own log of the data
// sets it has actually observed... addObserver() verifies the observer against EVERY logged set
// so far. When a later observation first touches a NEW set, the gatekeeper re-verifies all current
// observers and sets excludeObservers for any who fail."): an `allVisible`-availability binding
// tracks every foreign calendar id whose free/busy was actually read (`ObserverLedger`), verifies
// a newly-added observer against every calendar already logged, and re-verifies every CURRENT
// observer whenever a genuinely new calendar is touched — returning the ids of any who now fail,
// for the caller to fold into a future `excludeObservers`-equivalent (see `onDatasetTouched`'s own
// doc comment for exactly what Athenaeum doesn't have yet to consume that list).

import * as Effect from "effect/Effect"
import { GoogleCalendarClient } from "./google-calendar-client.js"
import { ObserverVerificationFailed, type GoogleCalendarClientError } from "./errors.js"
import { ObserverLedger } from "./observer-ledger.js"
import type { ObserverIdentity } from "./observer-verifier.js"

/** The observer's own resolved Google access token — how the caller of every function below
 *  supplies "the observer's own connected account" concretely. Resolving an `ObserverIdentity`
 *  (a `connectionId`) into a live, possibly-just-refreshed access token is per-connection
 *  credential-lifecycle work (mirroring `GoogleCalendarClientReal`'s own documented scope line:
 *  "this client never refreshes implicitly... keeping token-lifecycle policy OUT of this thin
 *  client") that belongs to the future per-user connected-account storage this stage does not
 *  build (see `observer-verifier.ts`'s header comment). Every function here takes the already-
 *  resolved token as a plain argument rather than an `ObserverIdentity`, so this module has zero
 *  opinion about how that resolution happens — the next stage supplies a
 *  `(identity: ObserverIdentity) => Effect<string, ...>` resolver (see `onDatasetTouched`'s
 *  `resolveAccessToken` parameter) however it ends up storing/refreshing connections.
 */
export type AccessTokenResolver = (
  identity: ObserverIdentity
) => Effect.Effect<string, ObserverVerificationFailed | GoogleCalendarClientError>

/** Bounded RFC3339 window free/busy checks run against — kept small and near "now" deliberately:
 *  a free/busy ACCESS check only needs Google to answer at all for the queried calendar, not to
 *  return meaningful data, so there is no reason to query a wide window (mirrors
 *  cloudflare-os's own `hasFreeBusyAccess`: "a minimal 60-second window"). */
export const accessCheckWindow = (now: Date = new Date()): { readonly timeMin: string; readonly timeMax: string } => ({
  timeMin: now.toISOString(),
  timeMax: new Date(now.valueOf() + 60_000).toISOString()
})

// --- Strategy B ----------------------------------------------------------------------------

/**
 * Strategy B: verify `observerAccessToken`'s own account has `writer`/`owner` on `calendarId`.
 * Called once per `addObserver` (no dataset log — "the whole unit is covered up front").
 * `getCalendar` (not `listCalendars`) is the right primitive: it targets exactly the one bound
 * calendar and surfaces `accessRole: undefined`/absent identically to "no access" (Google's
 * `calendarList.get` 404s for a calendar the account cannot see at all — `getCalendar`'s own
 * `GoogleCalendarClientReal` implementation maps that to a generic request failure, which this
 * function treats the same as an insufficient role: either way, the observer cannot independently
 * read this calendar).
 */
export const verifyObserverStrategyB = (
  observerId: string,
  observerAccessToken: string,
  calendarId: string
): Effect.Effect<void, ObserverVerificationFailed, GoogleCalendarClient> =>
  Effect.gen(function* () {
    const client = yield* GoogleCalendarClient
    const result = yield* client.getCalendar(observerAccessToken, calendarId).pipe(Effect.either)
    if (result._tag === "Left") {
      return yield* Effect.fail(
        new ObserverVerificationFailed({
          observerId,
          message: `Could not read calendar "${calendarId}" with the observer's own Google account — they likely have no access to it at all.`
        })
      )
    }
    const role = result.right.accessRole
    if (role !== "writer" && role !== "owner") {
      return yield* Effect.fail(
        new ObserverVerificationFailed({
          observerId,
          message:
            `The observer's own Google account has "${role ?? "no"}" access to calendar "${calendarId}", ` +
            `but this binding requires "writer" or "owner" — reader access hides private-event details.`
        })
      )
    }
  })

// --- Strategy C ------------------------------------------------------------------------------

/** One calendar-access check, shared by both Strategy C entry points below — "can this observer's
 *  own account independently read free/busy for this ONE calendar." Uses `freeBusy` (not
 *  `getCalendar`): an `allVisible` binding's whole point is querying calendars the CONNECTED
 *  ACCOUNT (not necessarily the observer) has only free/busy visibility into, possibly without
 *  `calendarList` access at all (`freeBusyReader`-level sharing, per `GoogleCalendarInfo.accessRole`'s
 *  own doc comment) — `getCalendar` would reject an access level `freeBusy` itself doesn't need. */
const verifyObserverCanReadFreeBusy = (
  observerId: string,
  observerAccessToken: string,
  calendarId: string,
  now: Date = new Date()
): Effect.Effect<void, ObserverVerificationFailed, GoogleCalendarClient> =>
  Effect.gen(function* () {
    const client = yield* GoogleCalendarClient
    const window = accessCheckWindow(now)
    const results = yield* client
      .freeBusy(observerAccessToken, [calendarId], window.timeMin, window.timeMax)
      .pipe(
        Effect.mapError(
          () =>
            new ObserverVerificationFailed({
              observerId,
              message: `Free/busy lookup failed for calendar "${calendarId}" using the observer's own account.`
            })
        )
      )
    const entry = results[0]
    if (entry === undefined || entry.error !== undefined) {
      return yield* Effect.fail(
        new ObserverVerificationFailed({
          observerId,
          message:
            `The observer's own Google account cannot read free/busy for calendar "${calendarId}"` +
            (entry?.error ? ` (${entry.error})` : "") +
            " — this binding has read availability data for that calendar."
        })
      )
    }
  })

/**
 * Strategy C, the `addObserver` half: register `observerId` for `bindingId`, first verifying them
 * against EVERY calendar this binding's dataset log already contains ("addObserver() verifies the
 * observer against every logged set so far"). Fails without registering if any check fails — a
 * partially-verified observer is never persisted (mirrors `docs/sharing.md`-adjacent
 * `ensureObserver` discipline elsewhere in this codebase: verify-then-persist, never the reverse).
 */
export const addObserverStrategyC = (
  bindingId: string,
  observerId: string,
  identity: ObserverIdentity,
  observerAccessToken: string,
  now: Date = new Date()
): Effect.Effect<void, ObserverVerificationFailed, GoogleCalendarClient | ObserverLedger> =>
  Effect.gen(function* () {
    const ledger = yield* ObserverLedger
    const touched = yield* ledger.listTouchedCalendars(bindingId)
    yield* Effect.forEach(
      touched,
      (calendarId) => verifyObserverCanReadFreeBusy(observerId, observerAccessToken, calendarId, now),
      { discard: true }
    )
    yield* ledger.registerObserver(bindingId, observerId, identity)
  })

export const removeObserverStrategyC = (
  bindingId: string,
  observerId: string
): Effect.Effect<void, never, ObserverLedger> =>
  Effect.gen(function* () {
    const ledger = yield* ObserverLedger
    yield* ledger.removeObserver(bindingId, observerId)
  })

/**
 * Strategy C, the "a new observation just read a calendar we've never logged before" half —
 * `docs/observers.md` §9.1: "When a later observation first touches a new set, the gatekeeper
 * re-verifies all current observers and sets excludeObservers for any who fail." Call this
 * whenever the real free/busy-reading code path (calendar-merge, next stage) successfully reads a
 * calendar under an `allVisible` binding, BEFORE returning that data to the caller.
 *
 * Returns `failedObserverIds` rather than acting on them directly — this package has no
 * `ObservationDescription.excludeObservers`/`ApprovalQueue` equivalent to hand them to yet
 * (Athenaeum's nearest analog, `AgentEditService`'s `changes`/`pending` stream, has no per-
 * observer visibility gate at all — see docs/gatekeeper-google-calendar-decisions.md §2's "What
 * Athenaeum does not have yet" for the honest gap this leaves). The next stage's job is exactly
 * this: decide what "block this observation for these observers" means once Athenaeum has
 * something to block it FROM.
 *
 * `resolveAccessToken` is supplied by the caller (see `AccessTokenResolver`'s own doc comment) —
 * this function has no opinion on where a registered observer's live access token comes from,
 * only on the verification algorithm once it has one. A resolver failure for one observer is
 * treated identically to a failed access check (they end up in `failedObserverIds`) — an observer
 * whose connection is broken is exactly as unable to independently see this data as one who was
 * never granted access, from this algorithm's point of view.
 */
export const onDatasetTouched = (
  bindingId: string,
  calendarId: string,
  resolveAccessToken: AccessTokenResolver,
  now: Date = new Date()
): Effect.Effect<{ readonly failedObserverIds: ReadonlyArray<string> }, never, GoogleCalendarClient | ObserverLedger> =>
  Effect.gen(function* () {
    const ledger = yield* ObserverLedger
    const { newlyTouched } = yield* ledger.recordDatasetTouch(bindingId, calendarId)
    if (!newlyTouched) return { failedObserverIds: [] }

    const observers = yield* ledger.listObservers(bindingId)
    const failed: Array<string> = []
    for (const { observerId, identity } of observers) {
      const outcome = yield* resolveAccessToken(identity).pipe(
        Effect.flatMap((token) => verifyObserverCanReadFreeBusy(observerId, token, calendarId, now)),
        Effect.either
      )
      if (outcome._tag === "Left") failed.push(observerId)
    }
    return { failedObserverIds: failed }
  })
