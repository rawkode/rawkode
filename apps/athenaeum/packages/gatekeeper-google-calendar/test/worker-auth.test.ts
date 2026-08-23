// Adversarial-review fix verification: `worker.ts`'s `fetch()` handler must reject EVERY route
// (`describe`/`connect`/every `/account/:email/*` operation) unless the caller presents a valid
// `GATEKEEPER_CALLER_HMAC_SECRET`-signed credential (`service-caller-auth.ts`). Plain Vitest (no
// workerd/wrangler pool needed — `worker.ts#fetch` is called directly with hand-built `Env`/
// `ExecutionContext` objects, same "swap real storage for an in-memory double" discipline this
// package's other tests already use), proving the auth gate itself, not full DO dispatch (which
// genuinely does need a real Durable Object namespace — out of scope for this file; the "valid
// credential reaches the DO dispatcher" assertions below only need to observe that
// `ctx.exports.GatekeeperAccountDurableObject.getByName` gets CALLED, not that it round-trips
// through a real DO).
//
// This is also the first test in this package to exercise `worker.ts#fetch` directly at all — the
// HTTP-route layer had NO test coverage before this fix (only `GatekeeperAccountServiceLive`'s own
// business logic and `GatekeeperAccountDurableObject`'s wiring were tested, one layer down).

import { beforeEach, describe, expect, it } from "vitest"
import worker, { type Env } from "../src/worker.js"

const SECRET = "test-gatekeeper-caller-hmac-secret"
const CREDENTIAL_VERSION = "athenaeum-gatekeeper-caller-v1"

const textEncoder = new TextEncoder()

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

/** Independent re-implementation of `gatekeeper-service-credential.ts#signGatekeeperCallerCredential`
 *  (the real minting side, in `@athenaeum/backend` — deliberately not imported here, mirroring
 *  that package boundary's own "never import athenaeum-backend from a gatekeeper package"
 *  discipline) — lets this test mint credentials with full control over `secret`/`ttlSeconds`/
 *  `now` to exercise every failure mode (wrong secret, expired, malformed), not just the happy
 *  path a shared helper would make easy to over-fit to. */
const mintCredential = async (secret: string, ttlSeconds: number, now: Date = new Date()): Promise<string> => {
  const iat = Math.floor(now.getTime() / 1000)
  const exp = iat + ttlSeconds
  const payload = { v: CREDENTIAL_VERSION, iat, exp }
  const payloadBytes = textEncoder.encode(JSON.stringify(payload))
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign"
  ])
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes))
  return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(signature)}`
}

/** A `ctx.exports.GatekeeperAccountDurableObject.getByName` stub that records whether it was ever
 *  reached — the thing every "credential rejected" assertion below must prove did NOT happen (an
 *  auth bypass that still 401s the RESPONSE but already touched the DO would be a real, if
 *  narrower, bug this test is also designed to catch). */
const makeSpyCtx = (): { ctx: ExecutionContext; getByNameCalls: Array<string> } => {
  const getByNameCalls: Array<string> = []
  const stubMethods = {
    isConnected: async () => false,
    completeOAuth: async () => ({ connected: true })
  }
  const ctx = {
    exports: {
      GatekeeperAccountDurableObject: {
        getByName: (name: string) => {
          getByNameCalls.push(name)
          return stubMethods as unknown
        }
      }
    }
  } as unknown as ExecutionContext
  return { ctx, getByNameCalls }
}

const ENV_NO_SECRET: Env = {}
const ENV_WITH_SECRET: Env = { GATEKEEPER_CALLER_HMAC_SECRET: SECRET }

const describeRequest = (headers: Record<string, string> = {}): Request =>
  new Request("https://gatekeeper.internal/gatekeeper/google-calendar/describe", { headers })

const accountRequest = (op: string, headers: Record<string, string> = {}): Request =>
  new Request(`https://gatekeeper.internal/gatekeeper/google-calendar/account/${encodeURIComponent("victim@example.test")}/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({})
  })

describe("worker.ts fetch(): caller-credential gate (adversarial-review fix)", () => {
  let ctx: ExecutionContext
  let getByNameCalls: Array<string>

  beforeEach(() => {
    const spy = makeSpyCtx()
    ctx = spy.ctx
    getByNameCalls = spy.getByNameCalls
  })

  it("rejects a request with NO Authorization header at all — the exact unauthenticated-router-forwarding path this fix closes", async () => {
    const response = await worker.fetch(accountRequest("is-connected"), ENV_WITH_SECRET, ctx)
    expect(response.status).toBe(401)
    expect(getByNameCalls).toHaveLength(0)
  })

  it("rejects a request signed with the WRONG secret", async () => {
    const credential = await mintCredential("wrong-secret", 30)
    const response = await worker.fetch(
      accountRequest("is-connected", { Authorization: `Bearer ${credential}` }),
      ENV_WITH_SECRET,
      ctx
    )
    expect(response.status).toBe(401)
    expect(getByNameCalls).toHaveLength(0)
  })

  it("rejects an EXPIRED credential, even signed with the right secret", async () => {
    const credential = await mintCredential(SECRET, -1) // exp = 1 second ago
    const response = await worker.fetch(
      accountRequest("is-connected", { Authorization: `Bearer ${credential}` }),
      ENV_WITH_SECRET,
      ctx
    )
    expect(response.status).toBe(401)
    expect(getByNameCalls).toHaveLength(0)
  })

  it("rejects a malformed Authorization header", async () => {
    const response = await worker.fetch(
      accountRequest("is-connected", { Authorization: "Bearer not.a.valid.credential" }),
      ENV_WITH_SECRET,
      ctx
    )
    expect(response.status).toBe(401)
    expect(getByNameCalls).toHaveLength(0)
  })

  it("fails CLOSED — rejects even a well-formed, correctly-signed credential when the deployment's own GATEKEEPER_CALLER_HMAC_SECRET is unconfigured", async () => {
    const credential = await mintCredential(SECRET, 30)
    const response = await worker.fetch(
      accountRequest("is-connected", { Authorization: `Bearer ${credential}` }),
      ENV_NO_SECRET,
      ctx
    )
    expect(response.status).toBe(401)
    expect(getByNameCalls).toHaveLength(0)
  })

  it("rejects an unauthenticated call to /describe too — every route is gated uniformly, not just the account-scoped ones", async () => {
    const response = await worker.fetch(describeRequest(), ENV_WITH_SECRET, ctx)
    expect(response.status).toBe(401)
  })

  it("rejects an unauthenticated call to /connect too", async () => {
    const response = await worker.fetch(
      new Request("https://gatekeeper.internal/gatekeeper/google-calendar/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirectUri: "https://example.test/callback", state: "abc" })
      }),
      ENV_WITH_SECRET,
      ctx
    )
    expect(response.status).toBe(401)
  })

  it("ACCEPTS a valid, correctly-signed, unexpired credential and reaches the DO dispatcher", async () => {
    const credential = await mintCredential(SECRET, 30)
    const response = await worker.fetch(
      accountRequest("is-connected", { Authorization: `Bearer ${credential}` }),
      ENV_WITH_SECRET,
      ctx
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ connected: false })
    // Proves the credential didn't just avoid a 401 — it actually reached real dispatch logic.
    expect(getByNameCalls).toEqual(["victim@example.test"])
  })

  it("ACCEPTS a valid credential on /describe (no DO involved)", async () => {
    const credential = await mintCredential(SECRET, 30)
    const response = await worker.fetch(describeRequest({ Authorization: `Bearer ${credential}` }), ENV_WITH_SECRET, ctx)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { vendorId: string }
    expect(body.vendorId).toBe("google-calendar")
  })

  it("also accepts the credential via a query-string-free, header-only Bearer token exactly as calendar-gatekeeper-client.ts sends it (no ?token= fallback exists on this hop, unlike dev-auth.ts's browser-WebSocket case)", async () => {
    const credential = await mintCredential(SECRET, 30)
    const request = new Request(
      `https://gatekeeper.internal/gatekeeper/google-calendar/account/${encodeURIComponent("victim@example.test")}/is-connected?token=${credential}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    )
    const response = await worker.fetch(request, ENV_WITH_SECRET, ctx)
    // A `?token=` query param is NOT a supported fallback on this hop (see `service-caller-
    // auth.ts`'s header comment) — must still be rejected even though the credential is valid.
    expect(response.status).toBe(401)
  })
})
