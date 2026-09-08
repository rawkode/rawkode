// Web-stage task item 1: "A minimal dev sign-in screen... clearly labeled as a dev-only
// stand-in." This module owns the browser-side half of `backend/src/index.ts`'s
// `POST /api/dev/sign-in` route and `dev-auth.ts`'s credential shape — plain HTTP, exactly like
// that route is itself deliberately plain HTTP rather than a Cap'n Web RPC method (`auth.ts`'s own
// header comment: "sign-in happens *before* any WorkspaceDurableObject/Cap'n Web session exists").
//
// HARD CONSTRAINT reminder (this module is the most auth-adjacent file in `web`, worth restating
// here too): this is NOT OAuth, NOT a magic link, NOT any kind of real identity-provider flow —
// it is a thin client for the backend's already-gated (`DEV_AUTH_ENABLED`), already-honest
// dev-only credential mint. `SignIn.tsx` is the only UI surface that calls `signIn` below, and its
// own copy repeats the same "dev-only stand-in" framing for the end user, not just this comment.
//
// Uses a RELATIVE `fetch("/api/dev/sign-in")`, not `backend-host.ts`'s `backendWsBase` — see that
// file's header comment for why: Vite's dev-server proxy (`vite.config.ts`'s `server.proxy["/api"]`)
// forwards this same-origin request to the real backend, so the browser never makes a cross-origin
// call and the backend's dev sign-in route (which sets no CORS headers of its own — unlike the
// workspace/user WebSocket routes' POST-batch fallback) never needs to.

import * as Schema from "effect/Schema"
import { Email } from "@athenaeum/domain"

const STORAGE_KEY = "athenaeum:devSession"

export interface DevSession {
  readonly email: string
  readonly credential: string
  readonly issuedAt: string
  readonly expiresAt: string
}

const isSession = (value: unknown): value is DevSession =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>).email === "string" &&
  typeof (value as Record<string, unknown>).credential === "string" &&
  typeof (value as Record<string, unknown>).issuedAt === "string" &&
  typeof (value as Record<string, unknown>).expiresAt === "string"

/** Reads the persisted session, if any, and it hasn't already expired (client-side check only —
 *  the real gate is the backend re-verifying the credential's signature/expiry on every
 *  `WorkspaceDurableObject`/`UserDurableObject` connection; this is purely "don't bother trying to use
 *  an obviously-expired credential and show a stale sign-in screen instead"). */
export const loadSession = (): DevSession | undefined => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (!isSession(parsed)) return undefined
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) return undefined
    return parsed
  } catch {
    return undefined
  }
}

const saveSession = (session: DevSession): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    // best-effort — a failed persist just means a reload re-prompts sign-in, not a broken session
  }
}

export const clearSession = (): void => {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // best-effort, same as saveSession
  }
}

/** Real HTTP round trip to `POST /api/dev/sign-in` — mints (or reuses) the account, then a fresh
 *  HMAC-signed dev credential (`dev-auth.ts#signDevCredential`), real end to end. Normalizes
 *  `email` the same way `index.ts#handleDevSignIn` itself does (trim + lower-case) before even
 *  sending it, so the client-side `Email` format check below matches what the server will accept.
 *  Throws a plain `Error` with a human-readable message on any failure (bad email, dev auth
 *  disabled, network failure) — `SignIn.tsx` displays `error.message` directly. */
export const signIn = async (rawEmail: string): Promise<DevSession> => {
  const email = rawEmail.trim().toLowerCase()
  const decoded = Schema.decodeUnknownEither(Email)(email)
  if (decoded._tag === "Left") {
    throw new Error("Enter a valid-looking email address.")
  }

  const response = await fetch("/api/dev/sign-in", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: decoded.right })
  })

  if (response.status === 404) {
    throw new Error(
      "Dev sign-in is not enabled on this backend (DEV_AUTH_ENABLED is unset) — this is expected for a real deployment, not a bug."
    )
  }
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Sign-in failed (${response.status}): ${text}`)
  }

  const body: unknown = await response.json()
  if (!isSession(body)) {
    throw new Error("Sign-in succeeded but the response was not in the expected shape.")
  }

  saveSession(body)
  return body
}
