// cloudflare-access-api.ts — real Cloudflare Access Service Token API
// client.
//
// Plan §Live Backend Connectivity (P8), "Device auth" pin: "vault gets a
// privileged Cloudflare API credential (Account-level, `Access: Service
// Tokens Edit` permission) and a new enrollment endpoint that calls
// Cloudflare's real Access Service Token API
// (`POST /accounts/{account_id}/access/service_tokens`) to mint a
// `client_id`/`client_secret` pair for a newly-pairing device."
//
// Endpoint shape verified against Cloudflare's live developer docs before
// writing this module (this task's research step):
//
//   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/access/service_tokens
//
//   Docs:
//   - https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/create/
//     (exact request/response field names for this method)
//   - https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
//     (conceptual overview, header names, "secret shown only once")
//   - ../ACCESS_SETUP.md (this codebase's own prior citation of the same
//     API, written when device provisioning was still deliberately
//     deferred — see that file's "(c) Device token provisioning" section,
//     which this task closes)
//
//   Auth: `Authorization: Bearer <token>` header, where `<token>` is an
//   ACCOUNT-level Cloudflare API token scoped with the Access service-token
//   management permission (Cloudflare's dashboard/docs have shown this
//   permission labeled both "Access: Service Tokens Edit" and "Access:
//   Service Tokens Write" across doc revisions — whichever label appears
//   when creating the token, it is the one permission that authorizes
//   exactly this API method, per Cloudflare's own reference page above).
//   Held here as `CLOUDFLARE_API_TOKEN`, a Worker secret (see
//   wrangler.jsonc's comment on this binding + ENROLLMENT.md) — NEVER
//   shipped to a device. This is a deliberately more-privileged credential
//   than anything else this worker holds; scope it to Access service-token
//   management ONLY when creating it in the Cloudflare dashboard, not a
//   broader "Edit Cloudflare Workers"-style token.
//
//   Request body: `{ name: string, duration?: string }`. `duration` is a
//   Go-duration-like string (`"60m"`, `"2h45m"`, `"8760h"`) or the literal
//   `"forever"`; Cloudflare defaults to `"8760h"` (1 year) when omitted.
//   This client always sends an explicit duration
//   (`DEFAULT_SERVICE_TOKEN_DURATION` below) rather than relying on that
//   implicit default, so `computeExpiresAt` below is always computing from
//   a value this code actually requested, not an assumption about what
//   Cloudflare would pick.
//
//   Response body: `{ success, errors, messages, result: { id, client_id,
//   client_secret, name, duration, created_at, updated_at } }`. Cloudflare
//   returns `client_secret` in PLAINTEXT only on this create call — it is
//   never retrievable again afterwards (docs: "This is the only time
//   Cloudflare Access will display the Client Secret"). `client_id`/
//   `client_secret` are exactly the `CF-Access-Client-Id`/
//   `CF-Access-Client-Secret` header pair `../access-auth.ts`'s whole
//   verification chain already assumes Access validates at the edge for
//   every device request — see that file's header for the full mechanism
//   this pair feeds into.
//
// HONESTY NOTE (required by this task): there is no real Cloudflare
// account or API credential available in this sandbox. This exact
// request/response shape is built and tested against a MOCKED HTTP
// response matching the documented shape above (see
// cloudflare-access-api.test.ts) — it has never been exercised against the
// live `api.cloudflare.com`. This matches this rebuild's established
// practice for other credential-gated integrations (the Google OAuth token
// exchange, the OpenAI realtime wire protocol) that were built and tested
// the same way before real credentials existed for them. Smoke-test this
// against a real account + a real, narrowly-scoped API token before it
// provisions a device that matters.

export interface CloudflareServiceToken {
  id: string;
  clientId: string;
  clientSecret: string;
  name: string;
  duration: string;
  createdAt: string;
  updatedAt: string;
  /** Computed here from `createdAt` + `duration` — Cloudflare's response
   *  does not include an explicit expiry timestamp, only the duration it
   *  was created with. See `parseCloudflareDurationToMs`. */
  expiresAt: string;
}

/** Env bindings this module reads. Both are read off `env` (not
 *  hardcoded), matching every other environment-specific binding in this
 *  worker (see ../access-auth.ts's identical framing for
 *  ACCESS_TEAM_DOMAIN/ACCESS_AUD). `CLOUDFLARE_API_TOKEN` is a REAL
 *  credential (`wrangler secret put`, never `vars`); `CLOUDFLARE_ACCOUNT_ID`
 *  is not a credential (an account ID alone authenticates nothing), so
 *  plain `vars` is fine for it — same non-secret reasoning wrangler.jsonc
 *  already applies to ACCESS_TEAM_DOMAIN/ACCESS_AUD/GOOGLE_CLIENT_ID. */
export interface CloudflareAccessApiEnv {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

export type CreateServiceTokenResult =
  | { ok: true; token: CloudflareServiceToken }
  | { ok: false; status: number; error: string };

/** Cloudflare's own documented default for this endpoint when `duration`
 *  is omitted — sent explicitly here rather than relied upon implicitly
 *  (see this file's header). One year is a reasonable per-device
 *  credential lifetime for a single-user, handful-of-devices system; the
 *  Swift-side expiry-warning UX (DeviceEnrollmentPairing.swift) is what
 *  makes a year-long lifetime safe to use without silent expiry. */
const DEFAULT_SERVICE_TOKEN_DURATION = "8760h";

export interface CreateServiceTokenOptions {
  /** Test-only escape hatch — production code never passes this, matching
   *  ../access-auth.ts's `VerifyAccessOptions.fetchImpl` convention. */
  fetchImpl?: typeof fetch;
  duration?: string;
}

/** Calls Cloudflare's real Access Service Token create API (this file's
 *  header has the full citation) to mint a fresh client_id/client_secret
 *  pair named `name`. Returns a discriminated result rather than throwing,
 *  matching `../access-auth.ts`'s `AccessVerifyResult` convention, so
 *  callers (enroll-routes.ts) can map failures to HTTP responses without a
 *  try/catch at every call site. */
export async function createCloudflareAccessServiceToken(
  name: string,
  env: CloudflareAccessApiEnv,
  options: CreateServiceTokenOptions = {},
): Promise<CreateServiceTokenResult> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return {
      ok: false,
      status: 500,
      error:
        "Cloudflare API credentials are not configured on this worker " +
        "(CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID missing) — see ENROLLMENT.md",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const duration = options.duration ?? DEFAULT_SERVICE_TOKEN_DURATION;
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/access/service_tokens`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, duration }),
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: `Cloudflare API request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let body: CloudflareServiceTokenApiResponse;
  try {
    body = (await response.json()) as CloudflareServiceTokenApiResponse;
  } catch {
    return { ok: false, status: response.status || 502, error: "Cloudflare API returned a non-JSON response" };
  }

  if (!response.ok || body?.success !== true) {
    const message =
      Array.isArray(body?.errors) && body.errors.length > 0
        ? body.errors.map((e) => e?.message ?? JSON.stringify(e)).join("; ")
        : `Cloudflare API request failed with status ${response.status}`;
    return { ok: false, status: response.status || 502, error: message };
  }

  const result = body.result;
  if (!result?.client_id || !result?.client_secret) {
    return { ok: false, status: 502, error: "Cloudflare API response missing client_id/client_secret" };
  }

  return {
    ok: true,
    token: {
      id: String(result.id),
      clientId: String(result.client_id),
      clientSecret: String(result.client_secret),
      name: String(result.name ?? name),
      duration: String(result.duration ?? duration),
      createdAt: String(result.created_at),
      updatedAt: String(result.updated_at ?? result.created_at),
      expiresAt: computeExpiresAt(String(result.created_at), String(result.duration ?? duration)),
    },
  };
}

/** Shape of Cloudflare's real API response body for this endpoint, per
 *  this file's header citation. Only the fields this module reads are
 *  typed — Cloudflare's actual response may include more (e.g. a
 *  `result_info` pagination block on list endpoints; not applicable to
 *  this single-resource create call, but kept loose rather than asserting
 *  an exhaustive shape this code doesn't otherwise depend on). */
interface CloudflareServiceTokenApiResponse {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  messages?: unknown[];
  result?: {
    id?: string;
    client_id?: string;
    client_secret?: string;
    name?: string;
    duration?: string;
    created_at?: string;
    updated_at?: string;
  };
}

/** Parses a Cloudflare duration string (`"8760h"`, `"2h45m"`, `"90s"`,
 *  `"forever"`) into milliseconds. Returns `null` for `"forever"` or an
 *  unparseable string — callers treat `null` as "no computable expiry."
 *  Exported for direct unit testing; also used by `computeExpiresAt`. */
export function parseCloudflareDurationToMs(duration: string): number | null {
  const trimmed = duration.trim();
  if (trimmed === "forever") return null;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(trimmed);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/** `createdAt + duration`, as an ISO-8601 string. Falls back to a
 *  far-future sentinel (JS's max representable `Date`) for `"forever"`
 *  tokens or an unparseable input, rather than throwing — a provisioning
 *  response should still succeed even if expiry math can't be computed;
 *  the Swift client treats a far-future `expiresAt` as "no warning
 *  needed," which is the correct behavior for a `"forever"` token anyway. */
function computeExpiresAt(createdAt: string, duration: string): string {
  const createdMs = Date.parse(createdAt);
  const durationMs = parseCloudflareDurationToMs(duration);
  if (Number.isNaN(createdMs) || durationMs === null) {
    return new Date(8640000000000000).toISOString();
  }
  return new Date(createdMs + durationMs).toISOString();
}
