// Real, end-to-end coverage for the Phase 4 prerequisite ("Minimal real dev-auth / identity
// scheme" — see `dev-auth.ts`'s and `user-durable-object.ts`'s header comments for the design).
// Every test here exercises real code: real HMAC-SHA-256 (`crypto.subtle`), a real HTTP round
// trip through the actual Worker `fetch` handler (`index.ts#handleDevSignIn`), a real
// `UserDurableObject` (`idFromName(email)`, real `ctx.storage`), and a real Cap'n Web RPC call
// (`whoami`) proving the `CurrentUser`/`Effect.provideService` auth-context plumbing actually
// reaches a live connection — not a mock of any of these pieces.

import { describe, expect, it } from "vitest"
import { exports } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { Email, WhoamiOutput } from "@athenaeum/domain"
import { signDevCredential, verifyDevCredential } from "../src/dev-auth.js"
import { connectToWorkspace, connectToWorkspaceWithSocketAs, devSignIn, freshWorkspaceId } from "./support.js"

const DEV_HMAC_SECRET = "1aad21e410fbcfbb2c17f4f13498c21207f699bd0640fa0480c89d8623802189"

const freshEmail = (): string => `dev-auth-${crypto.randomUUID()}@rawkode.academy`

describe("dev-auth: sign+verify (unit-level, real crypto)", () => {
  it("round-trips a freshly signed credential", async () => {
    const email = Schema.decodeUnknownSync(Email)(freshEmail())
    const { credential } = await Effect.runPromise(signDevCredential(email, DEV_HMAC_SECRET, 3600))

    const user = await Effect.runPromise(verifyDevCredential(credential, DEV_HMAC_SECRET))
    expect(user.email).toBe(email)
  })

  it("rejects a credential signed with a different secret (tampering/wrong key)", async () => {
    const email = Schema.decodeUnknownSync(Email)(freshEmail())
    const { credential } = await Effect.runPromise(signDevCredential(email, DEV_HMAC_SECRET, 3600))

    const result = await Effect.runPromise(
      Effect.either(verifyDevCredential(credential, "a-completely-different-secret-0000000000000000"))
    )
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a credential whose payload was tampered with after signing (signature no longer matches)", async () => {
    const email = Schema.decodeUnknownSync(Email)(freshEmail())
    const { credential } = await Effect.runPromise(signDevCredential(email, DEV_HMAC_SECRET, 3600))

    const [payloadPart, signaturePart] = credential.split(".")
    const forgedPayload = btoa(JSON.stringify({ v: "athenaeum-dev-auth-v1", email: "attacker@evil.example", iat: 0, exp: 9_999_999_999 }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "")
    const forged = `${forgedPayload}.${signaturePart}`
    expect(forged).not.toBe(credential)
    void payloadPart

    const result = await Effect.runPromise(Effect.either(verifyDevCredential(forged, DEV_HMAC_SECRET)))
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects an expired credential (real expiry check, simulated via the injectable `now`)", async () => {
    const email = Schema.decodeUnknownSync(Email)(freshEmail())
    const issuedAt = new Date("2026-01-01T00:00:00.000Z")
    const { credential } = await Effect.runPromise(signDevCredential(email, DEV_HMAC_SECRET, 60, issuedAt))

    // Well within TTL: still valid.
    const stillValid = await Effect.runPromise(
      verifyDevCredential(credential, DEV_HMAC_SECRET, new Date(issuedAt.getTime() + 30_000))
    )
    expect(stillValid.email).toBe(email)

    // Past TTL: rejected.
    const afterExpiry = await Effect.runPromise(
      Effect.either(verifyDevCredential(credential, DEV_HMAC_SECRET, new Date(issuedAt.getTime() + 61_000)))
    )
    expect(Either.isLeft(afterExpiry)).toBe(true)
  })

  it("rejects a malformed credential string outright", async () => {
    const result = await Effect.runPromise(Effect.either(verifyDevCredential("not-a-real-credential", DEV_HMAC_SECRET)))
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("POST /api/dev/sign-in — real HTTP round trip against the real Worker", () => {
  it("issues a credential and records a real UserDurableObject profile, keyed by idFromName(email)", async () => {
    const email = freshEmail()
    const { credential, email: returnedEmail } = await devSignIn(email)
    expect(returnedEmail).toBe(email)
    expect(credential.split(".")).toHaveLength(2)

    // The identity model this stage's brief asked to cite/reuse: keyed by idFromName(email),
    // exactly like cloudflare-os's workshop-backend/src/user.ts.
    const userId = exports.UserDurableObject.idFromName(email)
    const profile = await exports.UserDurableObject.get(userId).whoami()
    expect(profile).not.toBeNull()
    expect(profile?.email).toBe(email)
  })

  it("normalizes email (trims + lower-cases) before minting the credential/profile", async () => {
    const base = freshEmail()
    const messy = `  ${base.toUpperCase()}  `

    const { email: returnedEmail } = await devSignIn(messy)
    expect(returnedEmail).toBe(base)
  })

  it("signing in twice for the same email reuses the same account (same createdAt)", async () => {
    const email = freshEmail()
    await devSignIn(email)
    const userId = exports.UserDurableObject.idFromName(email)
    const firstProfile = await exports.UserDurableObject.get(userId).whoami()

    await devSignIn(email)
    const secondProfile = await exports.UserDurableObject.get(userId).whoami()

    expect(secondProfile?.createdAt).toBe(firstProfile?.createdAt)
  })

  it("two different emails resolve to two distinct UserDurableObject identities", async () => {
    const emailA = freshEmail()
    const emailB = freshEmail()
    await devSignIn(emailA)
    await devSignIn(emailB)

    const idA = exports.UserDurableObject.idFromName(emailA)
    const idB = exports.UserDurableObject.idFromName(emailB)
    expect(idA.toString()).not.toBe(idB.toString())

    const profileA = await exports.UserDurableObject.get(idA).whoami()
    const profileB = await exports.UserDurableObject.get(idB).whoami()
    expect(profileA?.email).toBe(emailA)
    expect(profileB?.email).toBe(emailB)
  })

  it("rejects a malformed body", async () => {
    const response = await exports.default.fetch(
      new Request("https://athenaeum.invalid/api/dev/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notEmail: "oops" })
      })
    )
    expect(response.status).toBe(400)
  })
})

describe("WorkspaceDurableObject auth-context plumbing (whoami over real Cap'n Web RPC)", () => {
  it("an anonymous WebSocket connection sees authenticated: false", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const raw = await stub.whoami()
      const decoded = Schema.decodeUnknownSync(WhoamiOutput)(raw)
      expect(decoded.authenticated).toBe(false)
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("a connection presenting a valid dev credential sees authenticated: true with the right email", async () => {
    const email = freshEmail()
    const { credential } = await devSignIn(email)
    const workspaceId = freshWorkspaceId()

    const { stub, socket } = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const raw = await stub.whoami()
      const decoded = Schema.decodeUnknownSync(WhoamiOutput)(raw)
      expect(decoded.authenticated).toBe(true)
      expect(decoded.email).toBe(email)
    } finally {
      stub[Symbol.dispose]()
      socket.close()
    }
  })

  it("a connection presenting a tampered/invalid credential is rejected before the WS upgrade completes", async () => {
    const workspaceId = freshWorkspaceId()
    const response = await exports.default.fetch(
      new Request(`https://athenaeum.invalid/api/workspace/${workspaceId}`, {
        headers: { Upgrade: "websocket", Authorization: "Bearer not-a-real-credential" }
      })
    )
    expect(response.status).toBe(401)
  })
})
