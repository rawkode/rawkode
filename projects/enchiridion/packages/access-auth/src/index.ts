// @enchiridion/access-auth — Cloudflare Access request verification, shared
// across every Enchiridion worker that sits behind Cloudflare Access.
//
// Extracted (verbatim logic, generalized comments) from
// `workers/vault/src/access-auth.ts`, which remains the worker's own
// untouched copy — see that file's history for the original design
// rationale and the two independent adversarial reviews that shaped it. It
// was pulled out into this package rather than duplicated a second time in
// `workers/gatekeeper-google` because its only real dependency is `jose`
// (already a dependency of `workers/vault`, pure Web Crypto, no Node-only
// APIs, not a heavy/unrelated dependency chain) — unlike, say,
// `workers/gatekeeper-google/src/schema.ts`'s deliberate duplication of
// `SqlExecutor`'s ambient type from `workers/vault/src/schema.ts` (a
// structural-typing convenience for two independently owned DO schemas with
// genuinely different tables), this module is real, security-sensitive
// verification logic with no worker-specific state — the kind of code where
// a second, silently-drifting copy is a liability, not an isolation
// boundary worth paying for. Follows `packages/graph-core`'s minimal
// package shape (no build step — `main`/`types` point straight at
// `src/index.ts`, consumed via TS project references + Bun workspaces).
//
// Every worker that imports this package still owns its OWN Cloudflare
// Access Application in the Zero Trust dashboard (own hostname, own AUD
// tag, own policy) — this module only verifies whatever
// `Cf-Access-Jwt-Assertion` JWT already arrived on a request; it has no
// opinion on which Access Application issued it beyond checking `aud`
// against whatever `ACCESS_AUD` the calling worker's own `env` supplies.
// `workers/vault/ACCESS_SETUP.md` documents the dashboard steps for
// vault's Access Application; `workers/gatekeeper-google/GOOGLE_OAUTH_SETUP.md`
// documents the same steps for gatekeeper-google's OWN, separate Access
// Application (different hostname/route, different AUD, same mechanism).
//
// Mechanism (verified against developers.cloudflare.com — see either
// worker's setup doc for the citations):
//   1. The CLIENT authenticates to Access at the edge — either a Cloudflare
//      Access *service token* pair (`CF-Access-Client-Id`/
//      `CF-Access-Client-Secret` headers, the per-device Keychain flow
//      vault's devices use) or an identity-provider browser login session
//      (the flow a human admin uses to reach gatekeeper-google's
//      browser-driven OAuth routes) — Access treats both the same way from
//      this point on.
//   2. On success, Access forwards the request to the worker's origin with
//      a `Cf-Access-Jwt-Assertion` header containing a short-lived JWT that
//      Access itself signed. The worker never sees the client's
//      credentials directly — only the JWT Access minted after validating
//      them.
//   3. This module verifies THAT JWT: signature against the team's JWKS,
//      `aud` against the calling worker's own configured Access
//      Application AUD tag, and expiry (`jwtVerify` also validates `nbf`/
//      standard time claims).
//
// This is NOT a replacement for configuring each worker's own Access
// Application/policy correctly — it is the defense-in-depth check each
// worker's own setup doc describes as the last line of defense if Access is
// ever misconfigured or bypassed at the edge (e.g. a direct
// `*.workers.dev` request that skips the custom, Access-protected
// hostname).
//
// JWKS verification uses `jose` rather than hand-rolled JWT parsing:
// getting JWT/JWKS verification subtly wrong (algorithm confusion, missing
// `exp` check, accepting `none`) is a well-known class of bug `jose`
// already closes.
//
// Caching: `jose`'s `createRemoteJWKSet` already does in-memory JWKS
// caching with a TTL (`cacheMaxAge`, default 10 minutes) and a cooldown
// against hammering the JWKS endpoint on a `kid` miss — this module keeps
// ONE such JWKS set per team domain at module scope (`jwksSets` below) so
// that caching survives across requests within the same isolate, rather
// than constructing a fresh (uncached) `RemoteJWKSet` per call. Because
// this module is now imported by more than one worker, "per team domain"
// (not "per worker") is still the right cache key: two workers sharing the
// same Cloudflare Access team but different AUD tags legitimately share one
// JWKS fetch, since the JWKS itself is team-wide, not per-application.

import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  type FetchImplementation,
  jwtVerify,
  type JWTPayload,
} from "jose";

/** Env bindings this module reads. Both are non-secret identifiers (a
 *  team domain and an Access Application's AUD tag are not credentials —
 *  see either worker's setup doc) but are still environment-specific, so
 *  they're read off `env` rather than hardcoded, the same way every other
 *  environment-specific binding in these workers is. */
export interface AccessEnv {
  /** Cloudflare Access team domain, e.g. `"rawkode.cloudflareaccess.com"`
   *  (a bare team name like `"rawkode"` is also accepted and normalized —
   *  see `normalizeAccessTeamDomain`). */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access Application's AUD tag for THIS worker (Zero Trust dashboard
   *  → Access → Applications → this worker's own application → Overview).
   *  Each worker that imports this package configures its own Access
   *  Application and its own AUD tag here — this is not a single
   *  repo-wide value. */
  ACCESS_AUD?: string;
}

export type AccessVerifyResult =
  | { ok: true; payload: JWTPayload }
  | { ok: false; status: 401 | 403 | 500; error: string };

/** Test-only escape hatch: lets a consuming worker's own access-auth tests
 *  point JWKS fetches at a fake server instead of the real network. Never
 *  set by production code — every real call site calls
 *  `verifyAccessRequest(request, env)` with no third argument. */
export interface VerifyAccessOptions {
  /** Matches `jose`'s own `FetchImplementation` shape (narrower than
   *  `typeof fetch` — see `jose`'s `customFetch` docs), not the ambient
   *  `fetch` global, which `@cloudflare/workers-types` augments with
   *  extra members (e.g. `preconnect`) real fetch implementations have
   *  but a hand-written test fake has no reason to. */
  fetchImpl?: FetchImplementation;
}

const HEADER_NAME = "Cf-Access-Jwt-Assertion";

/** One cached `RemoteJWKSet` per normalized team domain, module-scoped so
 *  it survives across requests within the same Worker isolate (this is the
 *  "cache the JWKS in-memory (module-level, with a TTL)" requirement — see
 *  this file's header for why the TTL/cooldown themselves are `jose`'s,
 *  not reimplemented here). Tests use per-test-unique team domains so cache
 *  entries never leak between test cases; `resetAccessAuthCacheForTests`
 *  exists as an extra safety net. */
const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Accepts a bare team name (`"rawkode"`), a full Access team domain
 *  (`"rawkode.cloudflareaccess.com"`), or either of those with a
 *  `https://`/trailing-slash decoration, and returns the bare host to use
 *  in both the JWKS URL and the expected `iss` claim. Bare names are
 *  assumed to be `<name>.cloudflareaccess.com` per Cloudflare's default
 *  team-domain shape; anything already containing a `.` is treated as
 *  already-fully-qualified (covers a custom Access domain, if ever
 *  configured). */
export function normalizeAccessTeamDomain(rawDomain: string): string {
  const stripped = rawDomain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (stripped.includes(".")) return stripped;
  return `${stripped}.cloudflareaccess.com`;
}

function getJwks(teamDomain: string, fetchImpl?: FetchImplementation): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksSets.get(teamDomain);
  if (cached) return cached;

  const jwksUrl = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
  const set = createRemoteJWKSet(jwksUrl, fetchImpl ? { [customFetch]: fetchImpl } : undefined);
  jwksSets.set(teamDomain, set);
  return set;
}

/** Test-only: clears the module-level JWKS cache. Production code never
 *  calls this — a Worker isolate simply lives with whatever it cached
 *  until `jose`'s own TTL/cooldown decide to refetch. */
export function resetAccessAuthCacheForTests(): void {
  jwksSets.clear();
}

/**
 * Verifies that `request` carries a valid Cloudflare Access JWT
 * (`Cf-Access-Jwt-Assertion` header — see this file's header comment for
 * the full client → Access → origin flow this checks the last leg of).
 *
 * Returns `{ ok: true, payload }` on success (the verified JWT claims, in
 * case a caller ever wants request-level identity — e.g. which device or
 * admin made a request), or `{ ok: false, status, error }` describing
 * exactly why verification failed (missing header, expired token, wrong
 * audience, bad signature, or — a 500, not a 401/403 — this worker's own
 * Access env vars being unconfigured, which is a deploy-config bug, not a
 * caller's fault).
 */
export async function verifyAccessRequest(
  request: Request,
  env: AccessEnv,
  options: VerifyAccessOptions = {},
): Promise<AccessVerifyResult> {
  const token = request.headers.get(HEADER_NAME);
  if (!token) {
    return { ok: false, status: 401, error: `missing ${HEADER_NAME} header` };
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return {
      ok: false,
      status: 500,
      error: "Access auth is not configured on this worker (ACCESS_TEAM_DOMAIN/ACCESS_AUD missing) — see this worker's setup doc",
    };
  }

  const teamDomain = normalizeAccessTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const jwks = getJwks(teamDomain, options.fetchImpl);

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${teamDomain}`,
      audience: env.ACCESS_AUD,
    });
    return { ok: true, payload };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      return { ok: false, status: 401, error: "Access token expired" };
    }
    if (error instanceof joseErrors.JWTClaimValidationFailed) {
      return { ok: false, status: 403, error: `Access token claim validation failed: ${error.message}` };
    }
    if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { ok: false, status: 403, error: "Access token signature verification failed" };
    }
    if (error instanceof joseErrors.JWKSNoMatchingKey) {
      return { ok: false, status: 403, error: "Access token signed by an unknown key (kid not in team JWKS)" };
    }
    return {
      ok: false,
      status: 401,
      error: `Access token verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Builds the 401/403/500 `Response` for a failed `verifyAccessRequest`
 *  result — shared by every call site across every worker importing this
 *  package, so the deny body shape is consistent repo-wide. Never called
 *  for `{ ok: true }` — callers branch on `result.ok` first. */
export function accessDenyResponse(result: Extract<AccessVerifyResult, { ok: false }>): Response {
  return new Response(JSON.stringify({ error: result.error }), {
    status: result.status,
    headers: { "content-type": "application/json" },
  });
}
