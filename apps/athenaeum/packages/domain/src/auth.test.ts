import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { AuthenticatedUser, CurrentUser, Email, requireAuthenticatedUser } from "./auth.js"
import { Unauthorized } from "./errors.js"
import { IsoDateTimeString } from "./node.js"

describe("Email", () => {
  it("accepts a lower-cased, valid-looking address", () => {
    const decoded = Schema.decodeUnknownSync(Email)("david@rawkode.academy")
    expect(decoded).toBe("david@rawkode.academy")
  })

  it("rejects an upper-cased address (normalization is the caller's job, not this schema's)", () => {
    expect(() => Schema.decodeUnknownSync(Email)("David@Rawkode.Academy")).toThrow()
  })

  it("rejects a string with no @", () => {
    expect(() => Schema.decodeUnknownSync(Email)("not-an-email")).toThrow()
  })
})

describe("requireAuthenticatedUser", () => {
  const user = new AuthenticatedUser({
    email: Schema.decodeUnknownSync(Email)("david@rawkode.academy"),
    issuedAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date(0).toISOString()),
    expiresAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date(1_000_000).toISOString())
  })

  it("succeeds with the user when CurrentUser is Some", async () => {
    const result = await requireAuthenticatedUser.pipe(
      Effect.provideService(CurrentUser, Option.some(user)),
      Effect.runPromise
    )
    expect(result).toEqual(user)
  })

  it("fails closed with Unauthorized when CurrentUser is None (anonymous connection)", async () => {
    const result = await requireAuthenticatedUser.pipe(
      Effect.provideService(CurrentUser, Option.none()),
      Effect.either,
      Effect.runPromise
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(Unauthorized)
    }
  })
})
