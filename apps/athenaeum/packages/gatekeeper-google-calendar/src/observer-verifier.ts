// The opaque `GatekeeperUserVerifier`-minting mechanism (task item 2's "Design the opaque
// GatekeeperUserVerifier-minting mechanism per cloudflare-os's pattern... adapted to Athenaeum's
// actual sharing model from Phase 4"). Full rationale in docs/gatekeeper-google-calendar-
// decisions.md §2.
//
// **cloudflare-os's pattern** (`packages/workshop-shared/src/gatekeeper.ts`,
// `GatekeeperUserVerifier`'s own doc comment): "the prospective observer's own connected account
// mints an opaque `GatekeeperUserVerifier` (via `GatekeeperUser.getVerifier()`)... the gatekeeper
// 'unwraps' it (today, by calling semi-private methods it defined on its own verifier object)."
// That works because cloudflare-os has a separate `GatekeeperUser` WorkerEntrypoint per connected
// account, living in a per-vendor `UserAccount` Durable Object, reachable as a `Fetcher` the
// Overseer passes around without ever seeing inside it.
//
// **Athenaeum has no equivalent today.** Phase 4 built `SharingService`/`AuthenticatedUser` (an
// Athenaeum-account identity: `{email, issuedAt, expiresAt}`, verified via a stateless HMAC
// bearer credential — see `@athenaeum/domain`'s `auth.ts` header comment) but nothing like
// cloudflare-os's separate per-vendor connected-account `Fetcher` object, because Phase 4
// deliberately shipped "no observers yet... no external-service data exists to leak until Phase
// 5" (the plan's own words). This package — being Phase 5's first gatekeeper — is where a real
// "connected Google account" concept has to be invented for Athenaeum, not borrowed.
//
// **The adaptation this stage makes:** since THIS gatekeeper Worker will be the sole owner of
// "which Google account did observer X connect" storage (there is no separate User DO in this
// design to delegate that to — see `docs/gatekeeper-google-calendar-decisions.md`'s "Why the
// verifier is minted inside this Worker, not a separate User DO" for the full argument), minting
// naturally becomes something THIS gatekeeper does on the observer's behalf, once it has verified
// — via Athenaeum's own `AuthenticatedUser`/dev-auth bearer credential, not a fabricated mechanism
// — that the caller genuinely IS that observer. The opacity property cloudflare-os's design
// protects (the workspace/overseer layer that shuttles the verifier around can never read the
// observer's Google identity out of it) is preserved by making the token itself an HMAC-signed,
// self-verifying opaque blob — REUSING `@athenaeum/backend`'s own `dev-auth.ts` HMAC discipline
// (`crypto.subtle.importKey("raw", ..., {name:"HMAC", hash:"SHA-256"}, false, [usage])`,
// `base64url(payload).base64url(signature)`) rather than inventing a new one. Only code inside
// this package (holding the signing secret) can produce a token `unwrapGatekeeperUserVerifier`
// accepts; nothing else reads it.
//
// This is a genuinely different trust boundary than cloudflare-os's (same-Worker HMAC opacity vs.
// cross-Worker `Fetcher` capability opacity) — flagged explicitly, not glossed over, in the
// decisions doc. Once this gatekeeper is wired to `WorkspaceDurableObject` over a real Cap'n Web
// service-binding boundary (this stage's explicit non-goal — see this package's `wrangler.jsonc`
// header comment), the SAME opaque token becomes the payload a real `Fetcher<GatekeeperUserVerifier>`
// stub carries across that boundary — the token format does not need to change, only its transport.

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Email } from "@athenaeum/domain"
import { VerifierUnwrapFailed } from "./errors.js"

const textEncoder = new TextEncoder()

/** Versions the payload shape — same discipline as `dev-auth.ts`'s `CREDENTIAL_VERSION`, and a
 *  deliberately distinct string from it (this is a different token family, minted/verified by a
 *  different Worker with its own signing secret — collision would be harmless but confusing). */
const VERIFIER_VERSION = "athenaeum-gatekeeper-google-calendar-verifier-v1"

/**
 * What a verifier proves, once unwrapped: "this Athenaeum account (`observerEmail`) is the one
 * that connected the Google account referenced by `connectionId`." `connectionId` is opaque
 * OUTSIDE this package — it is a key into this gatekeeper's own per-observer connected-account
 * storage (`docs/gatekeeper-google-calendar-decisions.md` §2's `GoogleAccountConnection` sketch;
 * NOT built this stage — see that doc's "What the next stage builds" list), never a Google
 * identifier or token itself. Deliberately NOT the access token directly: a verifier is minted
 * once and may be re-verified many times (`addObserver` "may be called again with the same user
 * ID... re-run the same verifications", per `gatekeeper.ts`'s own doc comment) across a token's
 * natural expiry/refresh cycle, so it must reference the connection, not a point-in-time token.
 */
export class ObserverIdentity extends Schema.Class<ObserverIdentity>("ObserverIdentity")({
  observerEmail: Email,
  connectionId: Schema.String
}) {}

/** The opaque envelope — same "opaque to everyone except the minter/unwrapper" property as
 *  cloudflare-os's `GatekeeperUserVerifier`, realized as a signed string instead of an RPC
 *  capability (see this file's header comment for why). `Schema.Class` wrapping a bare string
 *  (rather than a plain `type GatekeeperUserVerifier = string`) mirrors this codebase's own
 *  convention of never passing a bare wire-critical string around untyped (see `auth.ts`'s
 *  `DevSignInOutput.credential` precedent, which makes the identical choice for the same reason). */
export class GatekeeperUserVerifier extends Schema.Class<GatekeeperUserVerifier>("GatekeeperUserVerifier")({
  token: Schema.String
}) {}

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

interface VerifierPayload {
  readonly v: string
  readonly observerEmail: string
  readonly connectionId: string
  readonly iat: number
  readonly exp: number
}

/**
 * Mints a verifier for `identity`, valid for `ttlSeconds`. The CALLER is responsible for having
 * already established that `identity.observerEmail` is genuinely who is asking (i.e. this is
 * invoked from a code path already holding a verified `AuthenticatedUser` whose `.email` matches
 * — never from an unauthenticated context) — this function itself does not re-check that, exactly
 * as cloudflare-os's `GatekeeperUser.getVerifier()` trusts that it is only ever called on the
 * account's own `GatekeeperUser` object, never handed someone else's.
 */
export const mintGatekeeperUserVerifier = (
  identity: ObserverIdentity,
  secret: string,
  ttlSeconds: number,
  now: Date = new Date()
): Effect.Effect<GatekeeperUserVerifier, never> =>
  Effect.promise(async () => {
    const iat = Math.floor(now.getTime() / 1000)
    const exp = iat + ttlSeconds
    const payload: VerifierPayload = {
      v: VERIFIER_VERSION,
      observerEmail: identity.observerEmail,
      connectionId: identity.connectionId,
      iat,
      exp
    }
    const payloadBytes = textEncoder.encode(JSON.stringify(payload))
    const key = await importHmacKey(secret, "sign")
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes))
    return new GatekeeperUserVerifier({
      token: `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(signature)}`
    })
  })

/**
 * Unwraps a verifier minted by `mintGatekeeperUserVerifier` against the same `secret`. Fails
 * closed with `VerifierUnwrapFailed` for every failure mode (malformed shape, bad signature,
 * expired, wrong version) — same "never leak which failure mode beyond a message" discipline as
 * `dev-auth.ts#verifyDevCredential`'s own doc comment, and the direct model this function ports.
 */
export const unwrapGatekeeperUserVerifier = (
  verifier: GatekeeperUserVerifier,
  secret: string,
  now: Date = new Date()
): Effect.Effect<ObserverIdentity, VerifierUnwrapFailed> =>
  Effect.gen(function* () {
    const parts = verifier.token.split(".")
    if (parts.length !== 2) {
      return yield* Effect.fail(new VerifierUnwrapFailed({ message: "Malformed verifier token." }))
    }
    const [payloadPart, signaturePart] = parts as [string, string]

    const payloadBytes = base64UrlDecode(payloadPart)
    const signatureBytes = base64UrlDecode(signaturePart)
    if (payloadBytes === undefined || signatureBytes === undefined) {
      return yield* Effect.fail(new VerifierUnwrapFailed({ message: "Malformed verifier token." }))
    }

    const key = yield* Effect.promise(() => importHmacKey(secret, "verify"))
    const valid = yield* Effect.promise(() =>
      crypto.subtle.verify("HMAC", key, signatureBytes.buffer as ArrayBuffer, payloadBytes.buffer as ArrayBuffer)
    )
    if (!valid) {
      return yield* Effect.fail(new VerifierUnwrapFailed({ message: "Invalid verifier signature." }))
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(payloadBytes)) as unknown,
      catch: () => new VerifierUnwrapFailed({ message: "Malformed verifier payload." })
    })
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>).v !== VERIFIER_VERSION ||
      typeof (parsed as Record<string, unknown>).observerEmail !== "string" ||
      typeof (parsed as Record<string, unknown>).connectionId !== "string" ||
      typeof (parsed as Record<string, unknown>).exp !== "number"
    ) {
      return yield* Effect.fail(new VerifierUnwrapFailed({ message: "Unrecognized verifier payload." }))
    }
    const payload = parsed as VerifierPayload

    const nowSeconds = Math.floor(now.getTime() / 1000)
    if (nowSeconds >= payload.exp) {
      return yield* Effect.fail(new VerifierUnwrapFailed({ message: "Verifier has expired." }))
    }

    const email = yield* Schema.decodeUnknown(Email)(payload.observerEmail).pipe(
      Effect.mapError(() => new VerifierUnwrapFailed({ message: "Verifier names an invalid email." }))
    )

    return new ObserverIdentity({ observerEmail: email, connectionId: payload.connectionId })
  })
