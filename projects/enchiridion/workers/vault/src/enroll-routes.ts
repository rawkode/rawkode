// enroll-routes.ts — device-enrollment provisioning endpoint (`POST
// /enroll/provision`).
//
// Plan §Live Backend Connectivity (P8), "Device auth" paragraph + §Native
// apps device-enrollment-flow bullet: "short-lived pairing code/QR from an
// already-authenticated device; the server mints the device-specific
// token — never a shared secret baked into the binary." This module
// implements that shape for real, closing the gap ../ACCESS_SETUP.md's
// "(c) Device token provisioning — deferred, and why" section explicitly
// left open (that section is updated by this same task to point here).
//
// THE BOOTSTRAP PROBLEM AND HOW THIS DESIGN RESOLVES IT: Cloudflare Access
// gates this worker's ENTIRE hostname at the edge — every route requires a
// valid `CF-Access-Client-Id`/`CF-Access-Client-Secret` pair before the
// request even reaches this Worker (see ../ACCESS_SETUP.md, ../
// access-auth.ts's header). An UNENROLLED device has no such credential,
// so it cannot reach ANY route here, including one meant to hand it a
// credential — a real chicken-and-egg problem, not a detail to wave away.
// This design resolves it by never making the new device call vault at
// all:
//
//   1. The user opens "Add a device" on an ALREADY-ENROLLED device (call it
//      A). A generates a short-lived, single-use `pairingCode` locally
//      (see apps/swift/Sources/EnchiridionCore/DeviceEnrollmentPairing.swift)
//      and calls THIS endpoint — Access-verified exactly like every other
//      route via `verifyAccessRequest`, using A's own already-valid
//      credential.
//   2. This endpoint validates the pairing code (format + not already
//      used/expired — see the idempotency-store note below), then calls
//      Cloudflare's real Access Service Token API
//      (./cloudflare-access-api.ts) to mint a BRAND NEW client_id/
//      client_secret pair, named after the new device.
//   3. The response goes back to A, over A's own already-authenticated
//      channel — never to the new device over the network.
//   4. A's app displays the minted pair to the new device OUT OF BAND: a
//      QR code (scanned by the new device's camera, iOS) or a manual
//      short-code entry screen (macOS, or iOS as a fallback) — a purely
//      local, human-mediated transfer that requires physical proximity to
//      the already-enrolled device's screen. The new device never makes a
//      network call to vault until AFTER it already holds this credential.
//
// `pairingCode`'s job here is narrower than "the" security boundary: the
// actual security boundary is that only a device already holding a valid
// Access credential can reach this endpoint at all (an attacker who
// already has that has strictly worse things to do than replay a
// provisioning call). The pairing code's real jobs are (a) making a
// retried/duplicated request from a flaky connection idempotent — the same
// code minting a SECOND real Cloudflare service token would be a genuine,
// if low-stakes, bug — and (b) giving the two on-screen prompts (already-
// enrolled device's "provisioning..." screen, new device's QR/code
// display) a concrete, human-checkable shared value.
//
// Idempotency store: a module-scope `Map`, the SAME pattern
// ../access-auth.ts already uses for its JWKS cache (see that file's
// header on why: it survives across requests within one Worker isolate,
// nothing more). This is best-effort, not distributed — a pairing code
// reused immediately after a deploy recycles the isolate would mint a
// second token instead of being rejected. Acceptable for a single-user
// system provisioning "a handful of devices" (../ACCESS_SETUP.md's own
// framing for the equivalent manual-dashboard flow this replaces);
// flagged here rather than silently assumed to be stronger than it is.

import { accessDenyResponse, type AccessEnv, verifyAccessRequest } from "./access-auth";
import { type CloudflareAccessApiEnv, createCloudflareAccessServiceToken } from "./cloudflare-access-api";

export interface EnrollEnv extends AccessEnv, CloudflareAccessApiEnv {}

/** `XXXX-XXXX`, uppercase letters + digits, excluding visually-ambiguous
 *  characters (`0`/`O`, `1`/`I`/`L`) — a pairing code is read off one
 *  device's screen and compared/typed by a human, so the alphabet is
 *  chosen for that, not for maximum entropy. 8 symbols from a 31-character
 *  alphabet is ~39 bits, comfortably enough to make guessing infeasible
 *  within the short TTL below even setting aside that guessing it buys an
 *  attacker nothing without ALSO holding a valid Access credential (see
 *  this file's header). */
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
/** "Short-lived" per the plan — this bounds how long a pairing code stays
 *  valid for a (re)submission of THIS endpoint, not the minted Cloudflare
 *  service token's own lifetime (that's `duration`/`expiresAt` in
 *  ./cloudflare-access-api.ts, a separate and much longer concern). */
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_DEVICE_NAME_LENGTH = 64;

interface UsedPairingCodeEntry {
  usedAt: number;
}

const usedPairingCodes = new Map<string, UsedPairingCodeEntry>();

/** Test-only: clears the module-level idempotency cache, matching
 *  ../access-auth.ts's `resetAccessAuthCacheForTests` convention. */
export function resetEnrollmentStateForTests(): void {
  usedPairingCodes.clear();
}

function pruneExpiredCodes(now: number): void {
  for (const [code, entry] of usedPairingCodes) {
    if (now - entry.usedAt > PAIRING_CODE_TTL_MS) {
      usedPairingCodes.delete(code);
    }
  }
}

export function validatePairingCodeFormat(code: unknown): code is string {
  return typeof code === "string" && PAIRING_CODE_PATTERN.test(code);
}

/** Generates a pairing code in this endpoint's expected format, using the
 *  Workers-runtime `crypto.getRandomValues` (real CSPRNG, not `Math.random`
 *  — matches this codebase's existing convention for id generation, e.g.
 *  `schema.ts`'s deterministic-ID derivation callers elsewhere use
 *  `crypto.subtle` for hashing). Real pairing-code generation happens
 *  CLIENT-SIDE (the already-enrolled device's Swift app — see
 *  DeviceEnrollmentPairing.swift), not here; this is exported so this
 *  module's own tests exercise the exact format the server validates
 *  against, and as a reference implementation the Swift side's generator
 *  is a straight port of. */
export function generatePairingCode(randomBytes: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(8))): string {
  const bytes = randomBytes();
  const chars = Array.from(bytes, (b) => PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}`;
}

export interface ProvisionDeviceRequestBody {
  pairingCode: string;
  deviceName: string;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface HandleProvisionOptions {
  /** Test-only escape hatch, forwarded to ./cloudflare-access-api.ts. */
  fetchImpl?: typeof fetch;
  /** Test-only clock override, so pairing-code TTL tests don't need real
   *  wall-clock sleeps. */
  now?: () => number;
}

/**
 * Handles `POST /enroll/provision`. See this file's header for the full
 * protocol design. Auth-gating: identical `verifyAccessRequest` check
 * every other vault route uses (../access-auth.ts) — ONLY a request
 * carrying a valid Access-issued JWT (i.e. from a device Access already
 * authenticated with a valid service-token pair) reaches the pairing-code/
 * Cloudflare-API logic below.
 */
export async function handleEnrollProvisionRequest(
  request: Request,
  env: EnrollEnv,
  options: HandleProvisionOptions = {},
): Promise<Response> {
  const access = await verifyAccessRequest(
    request,
    env,
    options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
  );
  if (!access.ok) {
    return accessDenyResponse(access);
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed — POST only" }, 405);
  }

  let body: Partial<ProvisionDeviceRequestBody>;
  try {
    body = (await request.json()) as Partial<ProvisionDeviceRequestBody>;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const validated = validateProvisionRequest(body);
  if (!validated.ok) {
    return jsonResponse({ error: validated.error }, 400);
  }
  const { pairingCode, deviceName } = validated.value;

  const now = options.now?.() ?? Date.now();
  pruneExpiredCodes(now);
  if (usedPairingCodes.has(pairingCode)) {
    return jsonResponse(
      { error: "pairing code already used or expired — generate a new one on the already-enrolled device" },
      409,
    );
  }

  const tokenName = buildServiceTokenName(deviceName, now);
  const result = await createCloudflareAccessServiceToken(tokenName, env, { fetchImpl: options.fetchImpl });
  if (!result.ok) {
    return jsonResponse({ error: result.error }, result.status);
  }

  // Only mark the code used AFTER a successful mint — a failed Cloudflare
  // API call (e.g. transient 5xx) should let the caller retry with the
  // same code rather than burning it on a request that never actually
  // provisioned anything.
  usedPairingCodes.set(pairingCode, { usedAt: now });

  return jsonResponse(
    {
      pairingCode,
      deviceName,
      clientId: result.token.clientId,
      clientSecret: result.token.clientSecret,
      mintedAt: result.token.createdAt,
      expiresAt: result.token.expiresAt,
    },
    201,
  );
}

function validateProvisionRequest(
  body: Partial<ProvisionDeviceRequestBody>,
): { ok: true; value: ProvisionDeviceRequestBody } | { ok: false; error: string } {
  if (!validatePairingCodeFormat(body.pairingCode)) {
    return {
      ok: false,
      error: "pairingCode must match XXXX-XXXX (uppercase letters/digits, excluding 0/O/1/I/L)",
    };
  }
  if (typeof body.deviceName !== "string" || body.deviceName.trim().length === 0) {
    return { ok: false, error: "deviceName is required" };
  }
  if (body.deviceName.length > MAX_DEVICE_NAME_LENGTH) {
    return { ok: false, error: `deviceName must be at most ${MAX_DEVICE_NAME_LENGTH} characters` };
  }
  return { ok: true, value: { pairingCode: body.pairingCode, deviceName: body.deviceName.trim() } };
}

/** Cloudflare service-token names are just labels (shown in the Zero
 *  Trust dashboard) — slugified device name + a timestamp so re-enrolling
 *  a device with the same name (lost/reset device) never collides with
 *  its predecessor's still-visible dashboard entry. */
function buildServiceTokenName(deviceName: string, now: number): string {
  const slug =
    deviceName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "")
      .slice(0, 40) || "device";
  return `enchiridion-${slug}-${now}`;
}
