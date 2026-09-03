// **Adversarial-review fix** — the one open finding from this task's own security review:
// `AppLibraryPanel.tsx`'s preview `<iframe>` builds its `client.js` `<script src>` and the App's
// own sandboxed client-side code makes its `/run` fetch calls with no way to carry the caller's
// auth credential on a GOVERNED workspace (every real signed-in user's default workspace). Two
// options were on the table, both wrong:
//   (a) leave `.../client.js` and `.../apps/:appId/run(/...)` reachable anonymously — reopening
//       exactly the hole `requireRoleForGovernedWorkspace` (`workspace-durable-object.ts`) exists
//       to close, or
//   (b) hand the sandboxed iframe the caller's own real session Bearer credential — a STRICTLY
//       WORSE hole, since that credential is valid against every other RPC method on this
//       workspace too (`createNode`, `deleteApp`, `addCollaborator`, ...), and this iframe's
//       `client` code is agent-authored, i.e. exactly the code this whole feature treats as
//       untrusted. Handing it the user's full session would let ANY App impersonate its own
//       creator against the rest of their workspace.
//
// This module is the real fix: a narrowly-scoped, short-lived, per-App "run credential" — the
// same real `crypto.subtle` HMAC-SHA-256 sign/verify primitive `dev-auth.ts`
// (`signDevCredential`/`verifyDevCredential`) and `gatekeeper-service-credential.ts`
// (`signGatekeeperCallerCredential`) already establish, reused here for a THIRD, deliberately
// distinct purpose: a capability token, not an identity token. Its payload carries no user email
// at all — just `{v, workspaceId, appId, iat, exp}` — because the security property it needs to
// prove is not "who is this," it's "this exact caller was already verified to hold 'use' role on
// this exact workspaceId/appId pair, at mint time, and nothing more." `workspace-durable-object.ts`
// mints it from `mintAppRunCredential` (only reachable after `requireRoleForGovernedWorkspace`
// already passed) and verifies it in `#handleAppRoute`'s credential check, ACCEPTING it as an
// alternative to (never a replacement for) the existing session-credential path on the two App
// HTTP routes — see that file's own doc comments on `APP_RUN_PATH`/`APP_CLIENT_JS_PATH` for the
// full acceptance logic.
//
// Deliberately its own `CREDENTIAL_VERSION` tag (distinct from `dev-auth.ts`'s
// `"athenaeum-dev-auth-v1"`) even though it reuses `env.DEV_AUTH_HMAC_SECRET` as the signing
// secret (no new secret to provision — this credential never crosses a Worker boundary, unlike
// `gatekeeper-service-credential.ts`'s, so there is no separate verifying package that would need
// its own secret): the version tag is what makes the two credential shapes mutually
// unforgeable-as-each-other — a session dev credential can never be replayed as an App-run
// credential (no `workspaceId`/`appId` fields to check) and vice versa (no `email` field), even
// though both are HMAC-signed with the same underlying secret.
//
// **TTL**: `DEFAULT_TTL_SECONDS` below is minutes, not seconds, unlike the 30s
// `gatekeeper-service-credential.ts` credential — deliberately: that credential is minted fresh on
// EVERY outgoing service-to-service call and never reused, so 30s only needs to cover one HTTP
// round trip. This one is minted ONCE per iframe load and then reused for the whole preview
// session (every `/run` fetch the App's client code makes while the user interacts with it), so it
// needs to outlive a plausible interactive session, not just a single request. The blast radius of
// a captured App-run credential is also inherently small regardless of TTL: it authorizes nothing
// beyond invoking this one App's own already-zero-ambient-access sandboxed code
// (`app-runtime-service-live.ts`) or reading back the App's own client source — never any other
// RPC method, any other App, or any other workspace. A future stage could add token refresh for
// longer sessions; not needed for this stage's real, working preview/run round trip.

import * as Effect from "effect/Effect"
import { EntityId, Unauthorized } from "@athenaeum/domain"

const textEncoder = new TextEncoder()

const CREDENTIAL_VERSION = "athenaeum-app-run-v1"

/** See this file's header comment ("TTL") for the full rationale — long enough to cover a real
 *  interactive preview session, short enough to keep a captured token's useful window bounded. */
export const DEFAULT_TTL_SECONDS = 600

interface AppRunCredentialPayload {
  readonly v: string
  readonly workspaceId: string
  readonly appId: string
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
 * Mints a fresh App-run credential scoped to exactly `{workspaceId, appId}`, signed with `secret`
 * (`Env.DEV_AUTH_HMAC_SECRET` — reused, see this file's header comment for why that's safe) and
 * valid for `ttlSeconds` from `now`. Stateless, same as `dev-auth.ts#signDevCredential` — nothing
 * persisted, verification needs only the credential string and the same secret.
 */
export const signAppRunCredential = (
  workspaceId: EntityId,
  appId: EntityId,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  now: Date = new Date()
): Effect.Effect<{ credential: string; expiresAt: Date }, never> =>
  Effect.promise(async () => {
    const iat = Math.floor(now.getTime() / 1000)
    const exp = iat + ttlSeconds
    const payload: AppRunCredentialPayload = { v: CREDENTIAL_VERSION, workspaceId, appId, iat, exp }
    const payloadBytes = textEncoder.encode(JSON.stringify(payload))

    const key = await importHmacKey(secret, "sign")
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes))

    return {
      credential: `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(signature)}`,
      expiresAt: new Date(exp * 1000)
    }
  })

/** The verified, decoded shape of an App-run credential — deliberately carries no user identity
 *  (no `email`), only the exact `{workspaceId, appId}` capability it was minted for. See this
 *  file's header comment for why that's the correct shape for a capability token. */
export interface VerifiedAppRunCredential {
  readonly workspaceId: string
  readonly appId: string
}

/**
 * Verifies an App-run credential minted by `signAppRunCredential` against the same `secret`. Fails
 * closed with `Unauthorized` for every failure mode (malformed shape, bad base64, wrong version —
 * including a well-formed `dev-auth.ts` SESSION credential, which carries no `workspaceId`/`appId`
 * fields and thus fails this shape check even though it was signed with the same underlying
 * secret — invalid signature, expired), same discipline as `dev-auth.ts#verifyDevCredential`. Does
 * NOT check that the returned `workspaceId`/`appId` match the route actually being called — the
 * caller (`workspace-durable-object.ts`'s `#handleAppRoute`) is responsible for that comparison,
 * since only it knows which route this credential is being presented against.
 */
export const verifyAppRunCredential = (
  credential: string,
  secret: string,
  now: Date = new Date()
): Effect.Effect<VerifiedAppRunCredential, Unauthorized> =>
  Effect.gen(function* () {
    const parts = credential.split(".")
    if (parts.length !== 2) {
      return yield* Effect.fail(new Unauthorized({ message: "Malformed App run credential." }))
    }
    const [payloadPart, signaturePart] = parts as [string, string]

    const payloadBytes = base64UrlDecode(payloadPart)
    const signatureBytes = base64UrlDecode(signaturePart)
    if (payloadBytes === undefined || signatureBytes === undefined) {
      return yield* Effect.fail(new Unauthorized({ message: "Malformed App run credential." }))
    }

    const key = yield* Effect.promise(() => importHmacKey(secret, "verify"))
    const valid = yield* Effect.promise(() =>
      crypto.subtle.verify("HMAC", key, signatureBytes.buffer as ArrayBuffer, payloadBytes.buffer as ArrayBuffer)
    )
    if (!valid) {
      return yield* Effect.fail(new Unauthorized({ message: "Invalid App run credential signature." }))
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(payloadBytes)) as unknown,
      catch: () => new Unauthorized({ message: "Malformed App run credential payload." })
    })
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>).v !== CREDENTIAL_VERSION ||
      typeof (parsed as Record<string, unknown>).workspaceId !== "string" ||
      typeof (parsed as Record<string, unknown>).appId !== "string" ||
      typeof (parsed as Record<string, unknown>).iat !== "number" ||
      typeof (parsed as Record<string, unknown>).exp !== "number"
    ) {
      return yield* Effect.fail(new Unauthorized({ message: "Unrecognized App run credential payload." }))
    }
    const payload = parsed as AppRunCredentialPayload

    const nowSeconds = Math.floor(now.getTime() / 1000)
    if (nowSeconds >= payload.exp) {
      return yield* Effect.fail(new Unauthorized({ message: "App run credential has expired." }))
    }

    return { workspaceId: payload.workspaceId, appId: payload.appId }
  })
