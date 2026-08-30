import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import {
  digestCalendarOAuthStateNonce,
  makeCalendarOAuthStateNonce,
  mintCalendarOAuthAttemptState,
  verifyCalendarOAuthAttemptState
} from "../src/calendar-oauth-state.js"

const secret = "test-state-secret"
const now = new Date("2026-08-30T12:00:00.000Z")

const decodePayload = (state: string): Record<string, unknown> => {
  const [payload] = state.split(".") as [string, string]
  const base64 = payload.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(payload.length / 4) * 4, "=")
  return JSON.parse(atob(base64)) as Record<string, unknown>
}

describe("calendar OAuth attempt state v2", () => {
  it("contains only a short-lived opaque nonce and time bounds", async () => {
    const nonce = makeCalendarOAuthStateNonce()
    const state = await Effect.runPromise(mintCalendarOAuthAttemptState(nonce, secret, now))
    const payload = decodePayload(state)

    const issuedAt = Math.floor(now.getTime() / 1000)
    expect(payload).toEqual({ v: "athenaeum-calendar-oauth-state-v2", nonce, iat: issuedAt, exp: issuedAt + 600 })
    expect(JSON.stringify(payload)).not.toMatch(/workspace|principal|connection|binding|email|gpc_|coa_/i)
  })

  it("rejects replay-tampered or expired input before a caller can perform provider I/O", async () => {
    const nonce = makeCalendarOAuthStateNonce()
    const state = await Effect.runPromise(mintCalendarOAuthAttemptState(nonce, secret, now))
    const tampered = `${state.slice(0, -1)}${state.endsWith("a") ? "b" : "a"}`

    await expect(Effect.runPromise(verifyCalendarOAuthAttemptState(tampered, secret, now))).rejects.toMatchObject({
      message: expect.stringMatching(/signature/i)
    })
    await expect(
      Effect.runPromise(verifyCalendarOAuthAttemptState(state, secret, new Date(now.getTime() + 10 * 60 * 1000)))
    ).rejects.toMatchObject({ message: expect.stringMatching(/expired/i) })
  })

  it("returns the nonce and its durable-only digest after verification", async () => {
    const nonce = makeCalendarOAuthStateNonce()
    const state = await Effect.runPromise(mintCalendarOAuthAttemptState(nonce, secret, now))
    const verified = await Effect.runPromise(verifyCalendarOAuthAttemptState(state, secret, now))

    expect(verified).toEqual({ nonce, nonceDigest: await Effect.runPromise(digestCalendarOAuthStateNonce(nonce)) })
  })
})
