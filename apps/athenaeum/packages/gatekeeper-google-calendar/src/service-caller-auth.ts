// Verifies the shared-secret/HMAC credential `athenaeum-backend`'s `calendar-gatekeeper-client.ts`
// (`@athenaeum/backend/src/gatekeeper-service-credential.ts`, the minting side — that file's own
// header comment has the full "why this exists" story) presents on every call to THIS Worker.
// `worker.ts`'s `fetch()` handler runs `verifyCallerCredential` before dispatching ANY route
// (`describe`/`connect`/every `/account/:email/*` operation) to `GatekeeperAccountDurableObject`.
//
// **Deliberately package-local, not imported from `@athenaeum/backend`**: this package cannot
// depend on `athenaeum-backend` (that would be a backwards dependency — "gatekeepers depend on
// domain, never the reverse," per the plan) even though the minting side's primitive is byte-for-
// byte the same `crypto.subtle` HMAC-SHA-256 scheme `dev-auth.ts` already establishes for
// `athenaeum-backend`'s own user-facing dev credentials — see this package's `rpc-boundary.ts` and
// `calendar-gatekeeper-client.ts`'s own header comments for the established precedent of
// duplicating a small primitive across this exact package boundary rather than sharing code
// across it.
//
// **Fails closed on every ambiguous case**: no `Authorization` header, a malformed credential, a
// bad signature, an expired credential, OR an unconfigured `GATEKEEPER_CALLER_HMAC_SECRET` on this
// deployment — every one of those is treated as "reject," never as "allow." An unconfigured secret
// failing closed (rather than "no secret configured means skip the check") is the one deliberately
// conservative choice here: it means this Worker refuses every request until BOTH sides of the
// deployment are configured together, which is exactly what should happen for a not-yet-deployed
// stage like this one (see this package's own `wrangler.jsonc` comment on why the secret is
// genuinely absent in this environment, same "no real Google credentials exist here either"
// carve-out as `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`).

const textEncoder = new TextEncoder()

const CREDENTIAL_VERSION = "athenaeum-gatekeeper-caller-v1"

interface CallerCredentialPayload {
  readonly v: string
  readonly iat: number
  readonly exp: number
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

const importHmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"])

/** Extracts the `Authorization: Bearer <credential>` header — same shape/rationale as
 *  `dev-auth.ts#extractBearerCredential`, minus that function's `?token=` query-param fallback
 *  (irrelevant here: this hop is a plain service-binding `fetch()` call, never a browser
 *  `WebSocket` upgrade that can't set custom headers). */
const extractBearerCredential = (request: Request): string | undefined => {
  const header = request.headers.get("Authorization")
  if (header === null) return undefined
  const match = /^Bearer\s+(.+)$/.exec(header)
  return match?.[1]
}

/**
 * Returns `true` only if `request` carries a currently-valid caller credential signed with
 * `secret`. `secret` being `undefined`/empty (this deployment's `GATEKEEPER_CALLER_HMAC_SECRET`
 * unconfigured) always returns `false` — see this file's header comment on why that's the correct,
 * fail-closed behavior rather than a bypassed check.
 */
export const verifyCallerCredential = async (
  request: Request,
  secret: string | undefined,
  now: Date = new Date()
): Promise<boolean> => {
  if (secret === undefined || secret.length === 0) return false

  const credential = extractBearerCredential(request)
  if (credential === undefined) return false

  const parts = credential.split(".")
  if (parts.length !== 2) return false
  const [payloadPart, signaturePart] = parts as [string, string]

  const payloadBytes = base64UrlDecode(payloadPart)
  const signatureBytes = base64UrlDecode(signaturePart)
  if (payloadBytes === undefined || signatureBytes === undefined) return false

  const key = await importHmacKey(secret)
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes.buffer as ArrayBuffer,
    payloadBytes.buffer as ArrayBuffer
  )
  if (!valid) return false

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes))
  } catch {
    return false
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).v !== CREDENTIAL_VERSION ||
    typeof (parsed as Record<string, unknown>).iat !== "number" ||
    typeof (parsed as Record<string, unknown>).exp !== "number"
  ) {
    return false
  }
  const payload = parsed as CallerCredentialPayload

  const nowSeconds = Math.floor(now.getTime() / 1000)
  return nowSeconds < payload.exp
}
