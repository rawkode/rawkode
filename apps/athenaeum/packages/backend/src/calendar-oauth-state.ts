// The `state` CSRF-nonce token round-tripped through `connectGoogleCalendar` ->
// `googleCalendarOAuthCallback` (gatekeeper-rpc.ts's own header comment: "the caller [backend] is
// responsible for minting and verifying it as a CSRF nonce" — `google-calendar-client.ts`'s
// `AuthorizationUrlOptions.state` doc comment says the identical thing from the client-package
// side: "the caller's job to generate and verify"). Same real HMAC-SHA-256 discipline as
// `dev-auth.ts`/`gatekeeper-google-calendar`'s own `observer-verifier.ts` (`crypto.subtle
// .importKey("raw", ..., {name:"HMAC", hash:"SHA-256"}, false, [usage])`), reused a third time
// here rather than a fourth bespoke implementation.
//
// Embeds `{workspaceId, boundByEmail}` so `googleCalendarOAuthCallback` can recover which workspace/caller
// started the flow without a separate server-side session store — the token itself IS the
// session, exactly like `dev-auth.ts`'s stateless credential.

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { EntityId, Unauthorized } from "@athenaeum/domain"

const textEncoder = new TextEncoder()
const STATE_VERSION = "athenaeum-calendar-oauth-state-v1"

interface StatePayload {
  readonly v: string
  readonly workspaceId: string
  readonly boundByEmail: string
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

/** How long a `connectGoogleCalendar` state token stays redeemable — generous enough to survive a
 *  real Google consent-screen round trip (the user reads/clicks through it), matching this
 *  workspace's own "favor headroom over precision" resource-limit convention. */
const STATE_TTL_SECONDS = 10 * 60

export const mintCalendarOAuthState = (
  workspaceId: EntityId,
  boundByEmail: string,
  secret: string,
  now: Date = new Date()
): Effect.Effect<string, never> =>
  Effect.promise(async () => {
    const iat = Math.floor(now.getTime() / 1000)
    const payload: StatePayload = { v: STATE_VERSION, workspaceId, boundByEmail, iat, exp: iat + STATE_TTL_SECONDS }
    const payloadBytes = textEncoder.encode(JSON.stringify(payload))
    const key = await importHmacKey(secret, "sign")
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes))
    return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(signature)}`
  })

export const verifyCalendarOAuthState = (
  state: string,
  secret: string,
  now: Date = new Date()
): Effect.Effect<{ readonly workspaceId: EntityId; readonly boundByEmail: string }, Unauthorized> =>
  Effect.gen(function* () {
    const parts = state.split(".")
    if (parts.length !== 2) return yield* Effect.fail(new Unauthorized({ message: "Malformed OAuth state." }))
    const [payloadPart, signaturePart] = parts as [string, string]
    const payloadBytes = base64UrlDecode(payloadPart)
    const signatureBytes = base64UrlDecode(signaturePart)
    if (payloadBytes === undefined || signatureBytes === undefined) {
      return yield* Effect.fail(new Unauthorized({ message: "Malformed OAuth state." }))
    }
    const key = yield* Effect.promise(() => importHmacKey(secret, "verify"))
    const valid = yield* Effect.promise(() =>
      crypto.subtle.verify("HMAC", key, signatureBytes.buffer as ArrayBuffer, payloadBytes.buffer as ArrayBuffer)
    )
    if (!valid) return yield* Effect.fail(new Unauthorized({ message: "Invalid OAuth state signature." }))

    const parsed = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(payloadBytes)) as unknown,
      catch: () => new Unauthorized({ message: "Malformed OAuth state payload." })
    })
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>).v !== STATE_VERSION ||
      typeof (parsed as Record<string, unknown>).workspaceId !== "string" ||
      typeof (parsed as Record<string, unknown>).boundByEmail !== "string" ||
      typeof (parsed as Record<string, unknown>).exp !== "number"
    ) {
      return yield* Effect.fail(new Unauthorized({ message: "Unrecognized OAuth state payload." }))
    }
    const payload = parsed as StatePayload
    const nowSeconds = Math.floor(now.getTime() / 1000)
    if (nowSeconds >= payload.exp) return yield* Effect.fail(new Unauthorized({ message: "OAuth state has expired." }))

    const workspaceId = yield* Schema.decodeUnknown(EntityId)(payload.workspaceId).pipe(
      Effect.mapError(() => new Unauthorized({ message: "OAuth state names an invalid workspaceId." }))
    )
    return { workspaceId, boundByEmail: payload.boundByEmail }
  })
