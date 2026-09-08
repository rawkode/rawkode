// Real, unit-level coverage for `app-run-credential.ts` — the adversarial-review fix's own
// sign/verify primitive. Same "real `crypto.subtle` HMAC-SHA-256, no mock" discipline
// `dev-auth.test.ts` already establishes for the session-credential analog, applied here to the
// App-run (capability, not identity) credential.

import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { Email, EntityId } from "@athenaeum/domain"
import { signAppRunCredential, verifyAppRunCredential } from "../src/app-run-credential.js"
import { signDevCredential } from "../src/dev-auth.js"

const SECRET = "1aad21e410fbcfbb2c17f4f13498c21207f699bd0640fa0480c89d8623802189"

const freshId = (): EntityId => Schema.decodeUnknownSync(EntityId)(crypto.randomUUID())

describe("app-run-credential: sign+verify (unit-level, real crypto)", () => {
  it("round-trips a freshly signed credential, naming the exact workspaceId/appId it was minted for", async () => {
    const workspaceId = freshId()
    const appId = freshId()
    const { credential } = await Effect.runPromise(signAppRunCredential(workspaceId, appId, SECRET))

    const verified = await Effect.runPromise(verifyAppRunCredential(credential, SECRET))
    expect(verified.workspaceId).toBe(workspaceId)
    expect(verified.appId).toBe(appId)
  })

  it("rejects a credential signed with a different secret (tampering/wrong key)", async () => {
    const workspaceId = freshId()
    const appId = freshId()
    const { credential } = await Effect.runPromise(signAppRunCredential(workspaceId, appId, SECRET))

    const result = await Effect.runPromise(
      Effect.either(verifyAppRunCredential(credential, "a-completely-different-secret-0000000000000000"))
    )
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects an expired credential (real expiry check, simulated via the injectable `now`)", async () => {
    const workspaceId = freshId()
    const appId = freshId()
    const issuedAt = new Date("2026-01-01T00:00:00.000Z")
    const { credential } = await Effect.runPromise(signAppRunCredential(workspaceId, appId, SECRET, 60, issuedAt))

    const stillValid = await Effect.runPromise(
      verifyAppRunCredential(credential, SECRET, new Date(issuedAt.getTime() + 30_000))
    )
    expect(stillValid.workspaceId).toBe(workspaceId)

    const afterExpiry = await Effect.runPromise(
      Effect.either(verifyAppRunCredential(credential, SECRET, new Date(issuedAt.getTime() + 61_000)))
    )
    expect(Either.isLeft(afterExpiry)).toBe(true)
  })

  it("rejects a malformed credential string outright", async () => {
    const result = await Effect.runPromise(Effect.either(verifyAppRunCredential("not-a-real-credential", SECRET)))
    expect(Either.isLeft(result)).toBe(true)
  })

  it("a real dev-auth SESSION credential (same secret) is never accepted as an App-run credential — the version-tag/shape check keeps the two kinds mutually unforgeable-as-each-other", async () => {
    const email = Schema.decodeUnknownSync(Email)(`app-run-credential-${crypto.randomUUID()}@rawkode.academy`)
    const { credential: sessionCredential } = await Effect.runPromise(signDevCredential(email, SECRET, 3600))

    const result = await Effect.runPromise(Effect.either(verifyAppRunCredential(sessionCredential, SECRET)))
    expect(Either.isLeft(result)).toBe(true)
  })
})
