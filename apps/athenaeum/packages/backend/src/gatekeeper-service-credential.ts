// Mints the shared-secret/HMAC credential `calendar-gatekeeper-client.ts` presents on every call
// to the `athenaeum-gatekeeper-google-calendar` Worker — the caller side of the adversarial-review
// fix (`gatekeeper-google-calendar/src/service-caller-auth.ts` is the verifier side, that file's
// own header comment has the full story).
//
// **Why this exists**: before this fix, the gatekeeper Worker's account-scoped HTTP routes
// (`worker.ts`) trusted ANY caller reaching them — dispatch to `GatekeeperAccountDurableObject`
// happened purely on `email`/`op` parsed off the URL path, with no check that the caller was
// actually `athenaeum-backend`. Two independent paths could reach those routes unauthenticated: (1)
// `packages/router/src/index.ts` forwards ANY `/gatekeeper/google-calendar/*` request straight to
// the `GATEKEEPER_GOOGLE_CALENDAR` service binding with no auth check of its own, and router is
// the app's public front door; (2) `gatekeeper-google-calendar`'s own `wrangler.jsonc` never set
// `workers_dev: false`, so a real deployment of that checked-in config also gets its own public
// `*.workers.dev` URL as a second independent unauthenticated path. Once real Google OAuth
// credentials are configured, either path would let anyone who knows a connected user's email
// read/write/delete that person's real Google Calendar, completely bypassing every
// `WorkspaceDurableObject` role gate this stage was built around.
//
// **The primitive**: real `crypto.subtle` HMAC-SHA-256 sign/verify, `base64url(payload).
// base64url(sig)` — the EXACT SAME primitive `dev-auth.ts#signDevCredential`/`verifyDevCredential`
// already establishes for user-facing dev credentials (reused here for a service-to-service
// credential instead of a user identity — no user is involved on this hop at all, so the payload
// carries no email, just a version tag + a short validity window). Deliberately NOT imported from
// `dev-auth.ts` directly even though both live in `@athenaeum/backend`: the verifying side
// (`gatekeeper-google-calendar`) is a SEPARATE package that cannot import `athenaeum-backend`
// internals (that would be a backwards dependency — "gatekeepers depend on domain, never the
// reverse," per the plan) and therefore needs its own copy of the same primitive regardless; this
// file's own copy stays deliberately parallel to that one (same base64url helpers, same
// `crypto.subtle` calls) rather than half-sharing and half-duplicating.
//
// **TTL**: short (`DEFAULT_TTL_SECONDS` below) — this credential is minted fresh on EVERY outgoing
// call (`calendar-gatekeeper-client.ts#postJson`), never cached/reused, so a short window only
// bounds the blast radius of a credential captured off the wire (e.g. a logging bug) without
// costing anything in practice: minting is one `crypto.subtle.sign` call, negligible next to the
// network round trip it accompanies.

const textEncoder = new TextEncoder()

const CREDENTIAL_VERSION = "athenaeum-gatekeeper-caller-v1"

/** Same "short-lived, minted per call" rationale as this file's header comment. 30s comfortably
 *  covers one HTTP round trip between two Workers (same Cloudflare network) with generous
 *  headroom for clock skew, while keeping a captured credential's useful window small. */
export const DEFAULT_TTL_SECONDS = 30

interface CallerCredentialPayload {
  readonly v: string
  readonly iat: number
  readonly exp: number
}

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

const importHmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])

/**
 * Mints a fresh caller credential, signed with `secret` (`Env.GATEKEEPER_CALLER_HMAC_SECRET`) and
 * valid for `ttlSeconds` from `now`. Stateless — nothing persisted, verification needs only the
 * credential string and the same shared secret, exactly like `dev-auth.ts`'s user credentials.
 */
export const signGatekeeperCallerCredential = async (
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  now: Date = new Date()
): Promise<string> => {
  const iat = Math.floor(now.getTime() / 1000)
  const exp = iat + ttlSeconds
  const payload: CallerCredentialPayload = { v: CREDENTIAL_VERSION, iat, exp }
  const payloadBytes = textEncoder.encode(JSON.stringify(payload))

  const key = await importHmacKey(secret)
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes))

  return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(signature)}`
}
