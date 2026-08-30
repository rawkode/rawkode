/**
 * Workspace-private identity digests for calendar observations.
 *
 * Calendar attendee addresses are low-entropy identifiers. A plain SHA-256 digest is therefore
 * a dictionary oracle to anybody who can see the observation/event payload. Use the Web Crypto
 * HMAC primitive instead: the digest remains deterministic inside one workspace, but cannot be
 * reproduced without the deployment's private key.
 */

import { canonicalJsonBytes } from "@athenaeum/domain"

const encoder = new TextEncoder()

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")

export const hmacSha256Hex = async (secret: string, value: Uint8Array): Promise<string> => {
  if (secret.trim().length === 0) throw new Error("calendar attendee digest secret is not configured")
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign("HMAC", key, value)
  return hex(new Uint8Array(signature))
}

export const calendarAttendeeDigest = async (
  secret: string,
  workspaceId: string,
  email: string
): Promise<string> =>
  hmacSha256Hex(
    secret,
    canonicalJsonBytes({ domain: "athenaeum.calendar-attendee.v1", workspaceId, email: email.trim().toLowerCase() })
  )
