// Proves Strategy B and Strategy C (task item 2) against `GoogleCalendarClientScripted` +
// `ObserverLedgerInMemory` — real business-logic Effect programs, real (in-memory) storage, no
// network dependency and no real Google account, per this codebase's own "Testing payoff"
// discipline (plan §"Effect-TS integration": "Layer-based DI lets business-logic services swap
// real storage for an in-memory Layer.succeed double in plain Vitest, without workerd").

import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Email } from "@athenaeum/domain"
import { makeGoogleCalendarClientScripted, type ScriptedGoogleAccount } from "../src/google-calendar-client-scripted.js"
import { ObserverLedger, ObserverLedgerInMemory } from "../src/observer-ledger.js"
import { ObserverIdentity, mintGatekeeperUserVerifier, unwrapGatekeeperUserVerifier } from "../src/observer-verifier.js"
import { addObserverStrategyC, onDatasetTouched, removeObserverStrategyC, verifyObserverStrategyB } from "../src/observer-verification.js"

const email = (value: string) => Schema.decodeUnknownSync(Email)(value)

const writerAccount: ScriptedGoogleAccount = {
  calendars: { "team@example.com": "writer" },
  freeBusyReadableCalendarIds: ["team@example.com", "foreign-1@example.com"],
  events: {}
}

const readerOnlyAccount: ScriptedGoogleAccount = {
  calendars: { "team@example.com": "reader" },
  freeBusyReadableCalendarIds: ["team@example.com"],
  events: {}
}

const noAccessAccount: ScriptedGoogleAccount = {
  calendars: {},
  freeBusyReadableCalendarIds: [],
  events: {}
}

describe("observer-verifier: opaque GatekeeperUserVerifier mint/unwrap", () => {
  const secret = "test-hmac-secret"
  const identity = new ObserverIdentity({ observerEmail: email("bob@example.com"), connectionId: "conn-1" })

  it("round-trips: mint then unwrap recovers the identity", async () => {
    const verifier = await Effect.runPromise(mintGatekeeperUserVerifier(identity, secret, 3600))
    const recovered = await Effect.runPromise(unwrapGatekeeperUserVerifier(verifier, secret))
    expect(recovered).toEqual(identity)
  })

  it("is opaque: the token string does not contain the email/connectionId in plaintext", async () => {
    const verifier = await Effect.runPromise(mintGatekeeperUserVerifier(identity, secret, 3600))
    expect(verifier.token).not.toContain("bob@example.com")
    expect(verifier.token).not.toContain("conn-1")
  })

  it("rejects a token signed with a different secret", async () => {
    const verifier = await Effect.runPromise(mintGatekeeperUserVerifier(identity, secret, 3600))
    const exit = await Effect.runPromiseExit(unwrapGatekeeperUserVerifier(verifier, "wrong-secret"))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("rejects an expired token", async () => {
    const now = new Date("2026-01-01T00:00:00Z")
    const verifier = await Effect.runPromise(mintGatekeeperUserVerifier(identity, secret, 60, now))
    const later = new Date(now.valueOf() + 120_000)
    const exit = await Effect.runPromiseExit(unwrapGatekeeperUserVerifier(verifier, secret, later))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("VerifierUnwrapFailed")
    }
  })
})

describe("Strategy B (selected-calendar binding)", () => {
  it("passes for writer access", async () => {
    const scripted = makeGoogleCalendarClientScripted({
      accounts: { "writer-token": writerAccount }
    })
    const exit = await Effect.runPromiseExit(
      verifyObserverStrategyB("observer-1", "writer-token", "team@example.com").pipe(Effect.provide(scripted.layer))
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("fails for reader-only access — reader hides private-event details", async () => {
    const scripted = makeGoogleCalendarClientScripted({ accounts: { "reader-token": readerOnlyAccount } })
    const exit = await Effect.runPromiseExit(
      verifyObserverStrategyB("observer-1", "reader-token", "team@example.com").pipe(Effect.provide(scripted.layer))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("ObserverVerificationFailed")
      expect(exit.cause.error.observerId).toBe("observer-1")
    }
  })

  it("fails for an account with no access to the calendar at all", async () => {
    const scripted = makeGoogleCalendarClientScripted({ accounts: { "no-access-token": noAccessAccount } })
    const exit = await Effect.runPromiseExit(
      verifyObserverStrategyB("observer-1", "no-access-token", "team@example.com").pipe(Effect.provide(scripted.layer))
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("Strategy C (allVisible-availability binding)", () => {
  const bindingId = "binding-allvisible-1"

  it("addObserver registers with no prior dataset touches (nothing to verify against yet)", async () => {
    const scripted = makeGoogleCalendarClientScripted({ accounts: { "writer-token": writerAccount } })
    const identity = new ObserverIdentity({ observerEmail: email("bob@example.com"), connectionId: "conn-bob" })

    const program = Effect.gen(function* () {
      yield* addObserverStrategyC(bindingId, "observer-bob", identity, "writer-token")
      const ledger = yield* ObserverLedger
      return yield* ledger.listObservers(bindingId)
    }).pipe(Effect.provide(Layer.mergeAll(scripted.layer, ObserverLedgerInMemory)))

    const observers = await Effect.runPromise(program)
    expect(observers).toEqual([{ observerId: "observer-bob", identity }])
  })

  it("addObserver re-verifies against every calendar already logged, failing if any is unreadable", async () => {
    const scripted = makeGoogleCalendarClientScripted({
      accounts: {
        "writer-token": writerAccount, // can read team@example.com and foreign-1@example.com
        "limited-token": { ...writerAccount, freeBusyReadableCalendarIds: ["team@example.com"] } // NOT foreign-1
      }
    })

    const program = (accessToken: string, identity: ObserverIdentity, observerId: string) =>
      Effect.gen(function* () {
        const ledger = yield* ObserverLedger
        yield* ledger.recordDatasetTouch(bindingId, "team@example.com")
        yield* ledger.recordDatasetTouch(bindingId, "foreign-1@example.com")
        return yield* addObserverStrategyC(bindingId, observerId, identity, accessToken)
      }).pipe(Effect.provide(Layer.mergeAll(scripted.layer, ObserverLedgerInMemory)))

    const okIdentity = new ObserverIdentity({ observerEmail: email("full@example.com"), connectionId: "c1" })
    const okExit = await Effect.runPromiseExit(program("writer-token", okIdentity, "observer-full"))
    expect(Exit.isSuccess(okExit)).toBe(true)

    const limitedIdentity = new ObserverIdentity({ observerEmail: email("limited@example.com"), connectionId: "c2" })
    const failExit = await Effect.runPromiseExit(program("limited-token", limitedIdentity, "observer-limited"))
    expect(Exit.isFailure(failExit)).toBe(true)
    if (Exit.isFailure(failExit) && failExit.cause._tag === "Fail") {
      expect(failExit.cause.error._tag).toBe("ObserverVerificationFailed")
      expect(failExit.cause.error.observerId).toBe("observer-limited")
    }
  })

  it("onDatasetTouched is a no-op (no re-verification) when the calendar was already logged", async () => {
    const scripted = makeGoogleCalendarClientScripted({ accounts: {} })
    const program = Effect.gen(function* () {
      const ledger = yield* ObserverLedger
      yield* ledger.recordDatasetTouch(bindingId, "team@example.com")
      // Second touch of the SAME calendar — must not attempt any resolveAccessToken call.
      return yield* onDatasetTouched(bindingId, "team@example.com", () =>
        Effect.die("resolveAccessToken should not be called for an already-touched calendar")
      )
    }).pipe(Effect.provide(Layer.mergeAll(scripted.layer, ObserverLedgerInMemory)))

    const result = await Effect.runPromise(program)
    expect(result).toEqual({ failedObserverIds: [] })
  })

  it("onDatasetTouched re-verifies every current observer against a genuinely NEW calendar, reporting failures", async () => {
    const scripted = makeGoogleCalendarClientScripted({
      accounts: {
        "writer-token": writerAccount, // freeBusyReadable: team@example.com, foreign-1@example.com
        "narrow-token": { ...writerAccount, freeBusyReadableCalendarIds: ["team@example.com"] } // cannot read foreign-1
      }
    })
    const goodIdentity = new ObserverIdentity({ observerEmail: email("good@example.com"), connectionId: "good" })
    const badIdentity = new ObserverIdentity({ observerEmail: email("bad@example.com"), connectionId: "bad" })

    const resolveAccessToken = (identity: ObserverIdentity) =>
      identity.connectionId === "good" ? Effect.succeed("writer-token") : Effect.succeed("narrow-token")

    const program = Effect.gen(function* () {
      // Both observers already configured (registered directly on the ledger, bypassing
      // addObserverStrategyC's own initial check — simulating "they were added before this
      // calendar was ever touched", the exact scenario onDatasetTouched exists for).
      const ledger = yield* ObserverLedger
      yield* ledger.registerObserver(bindingId, "observer-good", goodIdentity)
      yield* ledger.registerObserver(bindingId, "observer-bad", badIdentity)

      return yield* onDatasetTouched(bindingId, "foreign-1@example.com", resolveAccessToken)
    }).pipe(Effect.provide(Layer.mergeAll(scripted.layer, ObserverLedgerInMemory)))

    const result = await Effect.runPromise(program)
    expect(result.failedObserverIds).toEqual(["observer-bad"])
  })

  it("removeObserverStrategyC is idempotent", async () => {
    const program = Effect.gen(function* () {
      yield* removeObserverStrategyC(bindingId, "never-registered")
      const ledger = yield* ObserverLedger
      return yield* ledger.listObservers(bindingId)
    }).pipe(Effect.provide(ObserverLedgerInMemory))
    const observers = await Effect.runPromise(program)
    expect(observers).toEqual([])
  })
})
