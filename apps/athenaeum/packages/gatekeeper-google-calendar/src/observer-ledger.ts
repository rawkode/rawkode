// `ObserverLedger` — per-binding storage backing Strategy C (task item 2's "track which foreign
// calendars' free/busy data was actually read, and re-verify each new observer per calendar
// touched") plus the registered-observer set both strategies need for re-verification-on-every-
// open (`gatekeeper.ts`'s own doc comment: "addObserver() may be called again with the same user
// ID... The overseer may run this periodically"). Same interface/two-Layer split as every other
// service in this codebase (`GoogleCalendarClient`, `@athenaeum/domain`'s `ModelClient`): a
// zero-storage-dependency `Context.Tag` here, a real in-memory `Layer` in this file (used by
// `observer-verification.test.ts` and any future business-logic test — "Layer-based DI lets
// business-logic services swap real storage for an in-memory Layer.succeed double in plain
// Vitest, without workerd", per the plan's own "Testing payoff" paragraph), and a
// `typed-storage-effect`-backed `Layer` skeleton in `observer-ledger-typed-storage.ts` for the
// real Durable Object this gatekeeper will eventually own.

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import type { ObserverIdentity } from "./observer-verifier.js"

export interface RegisteredObserver {
  readonly observerId: string
  readonly identity: ObserverIdentity
}

export interface ObserverLedgerApi {
  /** Records that `calendarId` was touched (its free/busy was actually read) under `bindingId`
   *  (an `allVisible`-availability binding's id). Idempotent — returns `newlyTouched: false` on a
   *  calendar already in the log, which is the caller's ("has this calendar been seen before")
   *  signal for whether a re-verification sweep is needed at all (`gatekeeper.ts`: "When a later
   *  observation first touches a NEW set, the gatekeeper re-verifies all current observers"). */
  readonly recordDatasetTouch: (
    bindingId: string,
    calendarId: string
  ) => Effect.Effect<{ readonly newlyTouched: boolean }>

  readonly listTouchedCalendars: (bindingId: string) => Effect.Effect<ReadonlyArray<string>>

  /** Registers `observerId` as configured-and-verified for `bindingId`, storing `identity` so a
   *  future dataset touch can re-resolve their access token and re-verify them (per
   *  `onDatasetTouched` in observer-verification.ts). Overwrites any existing registration for the
   *  same `(bindingId, observerId)` pair — re-running `addObserver` for an already-registered
   *  observer is expected (re-verification-on-every-open), not an error. */
  readonly registerObserver: (
    bindingId: string,
    observerId: string,
    identity: ObserverIdentity
  ) => Effect.Effect<void>

  /** MUST be idempotent (`gatekeeper.ts#removeObserver`'s own documented contract) — removing an
   *  observer never-registered (or already removed) is a silent no-op, never a failure. */
  readonly removeObserver: (bindingId: string, observerId: string) => Effect.Effect<void>

  readonly listObservers: (bindingId: string) => Effect.Effect<ReadonlyArray<RegisteredObserver>>
}

export class ObserverLedger extends Context.Tag("@athenaeum/gatekeeper-google-calendar/ObserverLedger")<
  ObserverLedger,
  ObserverLedgerApi
>() {}

interface BindingState {
  readonly touchedCalendarIds: ReadonlySet<string>
  readonly observers: ReadonlyMap<string, ObserverIdentity>
}

const emptyBindingState: BindingState = { touchedCalendarIds: new Set(), observers: new Map() }

/**
 * A real (not mocked) `Layer` backed by an in-memory `Ref<Map<...>>` — appropriate for unit tests
 * and, per this stage's scope, for exercising the Strategy B/C algorithms end-to-end without a
 * real Durable Object. NOT the production storage (see `observer-ledger-typed-storage.ts`) — state
 * here does not survive a Worker restart, which is fine for tests but would silently lose Strategy
 * C's dataset log in production, so this Layer must never be wired into the real gatekeeper.
 */
export const ObserverLedgerInMemory: Layer.Layer<ObserverLedger> = Layer.effect(
  ObserverLedger,
  Effect.gen(function* () {
    const state = yield* Ref.make(new Map<string, BindingState>())

    const getBinding = (bindingId: string): Effect.Effect<BindingState> =>
      Ref.get(state).pipe(Effect.map((map) => map.get(bindingId) ?? emptyBindingState))

    const updateBinding = (
      bindingId: string,
      update: (current: BindingState) => BindingState
    ): Effect.Effect<void> =>
      Ref.update(state, (map) => {
        const next = new Map(map)
        next.set(bindingId, update(map.get(bindingId) ?? emptyBindingState))
        return next
      })

    return {
      recordDatasetTouch: (bindingId, calendarId) =>
        Effect.gen(function* () {
          const current = yield* getBinding(bindingId)
          const newlyTouched = !current.touchedCalendarIds.has(calendarId)
          if (newlyTouched) {
            yield* updateBinding(bindingId, (c) => ({
              ...c,
              touchedCalendarIds: new Set([...c.touchedCalendarIds, calendarId])
            }))
          }
          return { newlyTouched }
        }),

      listTouchedCalendars: (bindingId) => getBinding(bindingId).pipe(Effect.map((c) => [...c.touchedCalendarIds])),

      registerObserver: (bindingId, observerId, identity) =>
        updateBinding(bindingId, (c) => ({
          ...c,
          observers: new Map(c.observers).set(observerId, identity)
        })),

      removeObserver: (bindingId, observerId) =>
        updateBinding(bindingId, (c) => {
          if (!c.observers.has(observerId)) return c // idempotent no-op, per this Api's own doc comment
          const nextObservers = new Map(c.observers)
          nextObservers.delete(observerId)
          return { ...c, observers: nextObservers }
        }),

      listObservers: (bindingId) =>
        getBinding(bindingId).pipe(
          Effect.map((c) => [...c.observers.entries()].map(([observerId, identity]) => ({ observerId, identity })))
        )
    }
  })
)
