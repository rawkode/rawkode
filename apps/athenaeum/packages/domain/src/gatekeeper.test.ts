import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  GatekeeperUserVerifier,
  ObserverVerificationDenied,
  ObserverVerificationGranted,
  ObserverVerificationResult,
  ObserverVerificationStrategy
} from "./gatekeeper.js"

describe("GatekeeperUserVerifier", () => {
  it("round-trips an opaque token, and never interprets its contents", () => {
    const verifier = new GatekeeperUserVerifier({ token: "not-actually-parsed-here" })
    const encoded = Schema.encodeSync(GatekeeperUserVerifier)(verifier)
    expect(Schema.decodeUnknownSync(GatekeeperUserVerifier)(encoded)).toEqual(verifier)
    expect(encoded.token).toBe("not-actually-parsed-here")
  })
})

describe("ObserverVerificationStrategy", () => {
  it("accepts every strategy from docs/observers.md §9.1's decision table", () => {
    for (const strategy of ["A", "B", "C", "D"]) {
      expect(Schema.decodeUnknownSync(ObserverVerificationStrategy)(strategy)).toBe(strategy)
    }
  })

  it("rejects an unrecognized strategy", () => {
    const result = Schema.decodeUnknownEither(ObserverVerificationStrategy)("E")
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("ObserverVerificationResult", () => {
  it("round-trips a Strategy B grant", () => {
    const result = new ObserverVerificationGranted({ outcome: "granted", strategy: "B" })
    const encoded = Schema.encodeSync(ObserverVerificationResult)(result)
    expect(Schema.decodeUnknownSync(ObserverVerificationResult)(encoded)).toEqual(result)
  })

  it("round-trips a Strategy C denial with a human-readable message", () => {
    const result = new ObserverVerificationDenied({
      outcome: "denied",
      strategy: "C",
      message: "The observer's own Google account cannot read free/busy for calendar \"team@example.com\"."
    })
    const encoded = Schema.encodeSync(ObserverVerificationResult)(result)
    expect(Schema.decodeUnknownSync(ObserverVerificationResult)(encoded)).toEqual(result)
  })

  it("discriminates granted vs. denied by the outcome field", () => {
    const granted = Schema.decodeUnknownSync(ObserverVerificationResult)({
      outcome: "granted",
      strategy: "B"
    })
    expect(granted).toBeInstanceOf(ObserverVerificationGranted)

    const denied = Schema.decodeUnknownSync(ObserverVerificationResult)({
      outcome: "denied",
      strategy: "C",
      message: "no access"
    })
    expect(denied).toBeInstanceOf(ObserverVerificationDenied)
  })
})
