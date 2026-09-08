// Real (not fabricated) HMAC-signed dev-auth credentials — see `@athenaeum/domain`'s `auth.ts`
// header comment for the full design rationale (identity model cited from cloudflare-os's
// `workshop-backend/src/user.ts`/`src/auth/login-flow.ts`; credential shape deliberately
// stateless/self-verifying rather than cloudflare-os's own opaque-token-plus-DO-storage scheme).
//
// This module owns the one thing `domain/src/auth.ts` deliberately does not: actual
// `crypto.subtle` HMAC-SHA-256 signing/verification, reusing the exact primitives cloudflare-os's
// `workshop-backend/src/sharing.ts#hashShareKey` already established as this codebase's
// crypto/HMAC discipline (`crypto.subtle.importKey("raw", ..., {name:"HMAC", hash:"SHA-256"},
// false, [usage])`), extended here with `crypto.subtle.sign`/`crypto.subtle.verify` for a signed
// (not just hashed) token, since a share key only ever needs "does this raw value hash to a
// known row" while a session credential needs "was this exact payload signed by us and has it
// not expired" with no storage lookup at all.
//
// **HARD CONSTRAINT compliance**: this is explicitly NOT OAuth, NOT a magic link, and mints
// nothing resembling a real identity-provider token — it is a directly-issued, self-signed
// credential for local testing, gated behind `DEV_AUTH_ENABLED` (checked by the caller —
// `index.ts`'s `POST /api/dev/sign-in` route — before this module is ever reached), mirroring
// the plan's own `AUTH_GATEKEEPERS`/`DISABLE_PASSWORD_AUTH` env-var-gating discipline for exactly
// this kind of environment-dependent capability. `DEV_AUTH_HMAC_SECRET` (`wrangler.jsonc`'s
// `vars`, loudly commented there) is a plaintext dev-only value — in any real deployment this
// would be `wrangler secret put DEV_AUTH_HMAC_SECRET` (or, better, `DEV_AUTH_ENABLED` simply
// unset so this whole code path is unreachable) once a real OAuth "gatekeeper-as-auth" sign-in
// (plan risk #6, `docs/oauth-signin.md`) replaces it — out of scope for this stage.

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { AuthenticatedUser, Email, IsoDateTimeString, Unauthorized } from "@athenaeum/domain"

const textEncoder = new TextEncoder()

/** Versions the payload shape so a future format change fails closed on old tokens instead of
 *  misinterpreting them — cheap insurance for a token whose lifetime (see `DEV_CREDENTIAL_TTL_
 *  SECONDS` at the call site) can outlive a single `wrangler dev` process restart. */
const CREDENTIAL_VERSION = "athenaeum-dev-auth-v1"

interface DevCredentialPayload {
  readonly v: string
  readonly email: string
  /** Unix seconds, not `IsoDateTimeString` — keeps the signed payload's JSON tiny and avoids
   *  round-tripping through `Date` parsing before the signature is even checked. */
  readonly iat: number
  readonly exp: number
}

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

const base64UrlDecode = (value: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return undefined
  }
}

const importHmacKey = (secret: string, usage: "sign" | "verify"): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage])

/**
 * Mints a fresh dev credential for `email`, signed with `secret` and valid for `ttlSeconds` from
 * `now`. Stateless: nothing is written to any Durable Object here — verification (below) needs
 * only the credential string and the same `secret`, no round trip to whichever `UserDurableObject`
 * issued it. Real HMAC-SHA-256 over `{v, email, iat, exp}`, `base64url(payload).base64url(sig)`.
 */
export const signDevCredential = (
  email: Email,
  secret: string,
  ttlSeconds: number,
  now: Date = new Date()
): Effect.Effect<{ credential: string; issuedAt: IsoDateTimeString; expiresAt: IsoDateTimeString }, never> =>
  Effect.promise(async () => {
    const iat = Math.floor(now.getTime() / 1000)
    const exp = iat + ttlSeconds
    const payload: DevCredentialPayload = { v: CREDENTIAL_VERSION, email, iat, exp }
    const payloadBytes = textEncoder.encode(JSON.stringify(payload))

    const key = await importHmacKey(secret, "sign")
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes))

    return {
      credential: `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(signature)}`,
      issuedAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date(iat * 1000).toISOString()),
      expiresAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date(exp * 1000).toISOString())
    }
  })

/**
 * Verifies a dev credential minted by `signDevCredential` against the same `secret`. Fails closed
 * with `Unauthorized` for every failure mode (malformed shape, bad base64, wrong version, invalid
 * signature, expired) — never leaks which one beyond the human-readable `message`, matching
 * `errors.ts`'s `Unauthorized` doc comment ("a caller-facing authentication failure should never
 * leak *why* verification failed beyond a message"). Uses `crypto.subtle.verify` — a real,
 * constant-time HMAC comparison, not a manual byte-by-byte compare that could leak timing.
 */
export const verifyDevCredential = (
  credential: string,
  secret: string,
  now: Date = new Date()
): Effect.Effect<AuthenticatedUser, Unauthorized> =>
  Effect.gen(function* () {
    const parts = credential.split(".")
    if (parts.length !== 2) {
      return yield* Effect.fail(new Unauthorized({ message: "Malformed dev credential." }))
    }
    const [payloadPart, signaturePart] = parts as [string, string]

    const payloadBytes = base64UrlDecode(payloadPart)
    const signatureBytes = base64UrlDecode(signaturePart)
    if (payloadBytes === undefined || signatureBytes === undefined) {
      return yield* Effect.fail(new Unauthorized({ message: "Malformed dev credential." }))
    }

    const key = yield* Effect.promise(() => importHmacKey(secret, "verify"))
    const valid = yield* Effect.promise(() =>
      crypto.subtle.verify("HMAC", key, signatureBytes.buffer as ArrayBuffer, payloadBytes.buffer as ArrayBuffer)
    )
    if (!valid) {
      return yield* Effect.fail(new Unauthorized({ message: "Invalid dev credential signature." }))
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(payloadBytes)) as unknown,
      catch: () => new Unauthorized({ message: "Malformed dev credential payload." })
    })
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>).v !== CREDENTIAL_VERSION ||
      typeof (parsed as Record<string, unknown>).email !== "string" ||
      typeof (parsed as Record<string, unknown>).iat !== "number" ||
      typeof (parsed as Record<string, unknown>).exp !== "number"
    ) {
      return yield* Effect.fail(new Unauthorized({ message: "Unrecognized dev credential payload." }))
    }
    const payload = parsed as DevCredentialPayload

    const nowSeconds = Math.floor(now.getTime() / 1000)
    if (nowSeconds >= payload.exp) {
      return yield* Effect.fail(new Unauthorized({ message: "Dev credential has expired." }))
    }

    const email = yield* Schema.decodeUnknown(Email)(payload.email).pipe(
      Effect.mapError(() => new Unauthorized({ message: "Dev credential names an invalid email." }))
    )

    return new AuthenticatedUser({
      email,
      issuedAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date(payload.iat * 1000).toISOString()),
      expiresAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date(payload.exp * 1000).toISOString())
    })
  })

/**
 * Extracts a Bearer credential from a request bound for `WorkspaceDurableObject`. Checked in two
 * places, in order: the standard `Authorization: Bearer <credential>` header (works for HTTP
 * batch calls and any client — native, test — that can set arbitrary headers), then a `?token=`
 * query parameter (the documented fallback for browser `WebSocket` upgrades: the browser
 * `WebSocket` constructor cannot set custom headers at all — capnweb's own
 * `newWorkersRpcResponse` doc comment notes the general shape of this problem: "if your API uses
 * in-band authorization... cross-origin requests should be safe" — a URL-embedded, short-lived,
 * single-purpose bearer token is the standard real-world workaround, not a shortcut invented for
 * this stage). Returns `undefined` (not a failure) when neither is present — every RPC surface
 * stays fully open to anonymous callers until a future stage actually gates something on
 * `CurrentUser`, per this stage's explicit non-goal ("no observers yet... don't build observer
 * verification logic").
 */
export const extractBearerCredential = (request: Request, url: URL): string | undefined => {
  const header = request.headers.get("Authorization")
  if (header !== null) {
    const match = /^Bearer\s+(.+)$/.exec(header)
    if (match) return match[1]
  }
  const queryToken = url.searchParams.get("token")
  return queryToken ?? undefined
}
