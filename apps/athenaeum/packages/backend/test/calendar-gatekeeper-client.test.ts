// Proves `calendar-gatekeeper-client.ts`'s real `makeCalendarGatekeeperClientServiceBindingLive`
// signs every outgoing request with a genuinely valid caller credential — the adversarial-review
// fix's client-side half (the server-side half, `worker.ts`'s verification of that credential, is
// proven end-to-end in `@athenaeum/gatekeeper-google-calendar`'s own `test/worker-auth.test.ts`).
// Mocks *only* the HTTP transport (a hand-rolled `Fetcher` stub — the `.fetch(request)` service-
// binding call, never the `CalendarGatekeeperClient` itself), same "mock only the HTTP layer"
// discipline `model-client-anthropic.test.ts` already establishes for this codebase's other real
// external-HTTP client. Independently re-verifies the signed credential using a hand-written
// re-implementation of `service-caller-auth.ts`'s own algorithm (not by importing that package,
// mirroring `worker-auth.test.ts`'s identical "never import athenaeum-backend from a gatekeeper
// package, or vice versa" discipline) — proving cross-package interoperability, not just "some
// string got attached to a header."

import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { makeCalendarGatekeeperClientServiceBindingLive, CalendarGatekeeperClient } from "../src/calendar-gatekeeper-client.js"

const SECRET = "test-gatekeeper-caller-hmac-secret"
const CREDENTIAL_VERSION = "athenaeum-gatekeeper-caller-v1"
const textEncoder = new TextEncoder()

const base64UrlDecode = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Independent re-implementation of `service-caller-auth.ts#verifyCallerCredential`'s core check
 *  (the real gatekeeper-side verifier lives in a different package this test deliberately does
 *  not import — see this file's header comment). Returns the decoded payload on success so tests
 *  can also assert on `exp`/`iat` shape, not just pass/fail. */
const independentlyVerify = async (
  credential: string,
  secret: string
): Promise<{ readonly v: string; readonly iat: number; readonly exp: number } | undefined> => {
  const parts = credential.split(".")
  if (parts.length !== 2) return undefined
  const [payloadPart, signaturePart] = parts as [string, string]
  const payloadBytes = base64UrlDecode(payloadPart)
  const signatureBytes = base64UrlDecode(signaturePart)
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify"
  ])
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes.buffer as ArrayBuffer,
    payloadBytes.buffer as ArrayBuffer
  )
  if (!valid) return undefined
  const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as { v: string; iat: number; exp: number }
  if (parsed.v !== CREDENTIAL_VERSION) return undefined
  return parsed
}

/** A `Fetcher` stub that records every request it receives and returns a canned `Response` —
 *  the ONLY mocked seam, exactly mirroring `model-client-anthropic.test.ts#mockHttpFetch`. */
const mockFetcher = (
  handler: (request: Request) => Response
): { readonly fetcher: Fetcher; readonly requests: Array<Request> } => {
  const requests: Array<Request> = []
  const fetcher = {
    fetch: (request: Request) => {
      requests.push(request.clone())
      return Promise.resolve(handler(request))
    }
  } as unknown as Fetcher
  return { fetcher, requests }
}

describe("calendar-gatekeeper-client.ts: real service-binding client signs every request (adversarial-review fix)", () => {
  it("attaches an Authorization: Bearer credential that independently verifies against the SAME secret the caller was configured with", async () => {
    const { fetcher, requests } = mockFetcher(() => Response.json({ url: "https://accounts.google.test/o/oauth2/auth?..." }))
    const layer = makeCalendarGatekeeperClientServiceBindingLive(fetcher, SECRET)

    const exit = await Effect.runPromiseExit(
      Effect.flatMap(CalendarGatekeeperClient, (client) => client.buildAuthorizationUrl("state-123", "https://example.test/cb")).pipe(
        Effect.provide(layer)
      )
    )
    expect(Exit.isSuccess(exit)).toBe(true)

    expect(requests).toHaveLength(1)
    const authHeader = requests[0]!.headers.get("authorization")
    expect(authHeader).toMatch(/^Bearer /)
    const credential = authHeader!.slice("Bearer ".length)

    const payload = await independentlyVerify(credential, SECRET)
    expect(payload).toBeDefined()
    expect(payload!.exp).toBeGreaterThan(payload!.iat)
    expect(payload!.exp - payload!.iat).toBeLessThanOrEqual(60) // short-lived, per gatekeeper-service-credential.ts's DEFAULT_TTL_SECONDS

    // Independent verification against the WRONG secret must fail — proves the signature is a
    // genuine function of the configured secret, not a fixed/predictable string.
    const wrongSecretResult = await independentlyVerify(credential, "a-different-secret")
    expect(wrongSecretResult).toBeUndefined()
  })

  it("mints a credential fresh at CALL time (not cached at Layer-construction time) — both calls carry a currently-valid, independently-verifiable credential", async () => {
    const { fetcher, requests } = mockFetcher(() => Response.json({ url: "https://accounts.google.test/o/oauth2/auth?..." }))
    const layer = makeCalendarGatekeeperClientServiceBindingLive(fetcher, SECRET)

    const program = Effect.flatMap(CalendarGatekeeperClient, (client) =>
      client.buildAuthorizationUrl("state-1", "https://example.test/cb")
    ).pipe(Effect.provide(layer))

    await Effect.runPromise(program)
    await Effect.runPromise(program)

    expect(requests).toHaveLength(2)
    for (const request of requests) {
      const credential = request.headers.get("authorization")!.slice("Bearer ".length)
      const payload = await independentlyVerify(credential, SECRET)
      expect(payload).toBeDefined()
      // A cached/stale credential minted once at Layer-construction time (a real bug this test
      // would catch) would still verify, but `iat` would not track wall-clock time at call time —
      // asserting it's within a tight, current window is what actually distinguishes "minted per
      // call" from "minted once and reused."
      expect(Math.abs(payload!.iat - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2)
    }
  })

  it("propagates a real 401 Unauthorized envelope from the gatekeeper Worker as a DomainError — proves the client's own error-envelope parsing still works with signing added, and this is exactly what a caller with a MISCONFIGURED secret would see in production", async () => {
    const { fetcher } = mockFetcher(() =>
      Response.json({ tag: "Unauthorized", message: "Missing or invalid gatekeeper caller credential." }, { status: 401 })
    )
    // Deliberately mismatched vs. what the (mocked) server would actually check — simulating the
    // real-world failure mode this whole fix defends against being silently ignored: a caller
    // whose secret doesn't match the deployed gatekeeper's own `GATEKEEPER_CALLER_HMAC_SECRET`.
    const layer = makeCalendarGatekeeperClientServiceBindingLive(fetcher, "some-secret")

    const exit = await Effect.runPromiseExit(
      Effect.flatMap(CalendarGatekeeperClient, (client) =>
        client.buildAuthorizationUrl("state-123", "https://example.test/cb")
      ).pipe(Effect.provide(layer))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const message = String((exit.cause as { toString?: () => string }).toString?.() ?? exit.cause)
      expect(message).toContain("Unauthorized")
    }
  })
})
