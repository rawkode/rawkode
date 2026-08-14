// @enchiridion/worker-vault — Cloudflare Access request verification.
//
// Plan §Backend architecture, "Auth for the GraphQL endpoint" + pinned Auth
// decision ("Cloudflare Access service tokens per device (Keychain)") +
// Risks #7/#10: this module is the origin-side defense-in-depth check for
// requests that reach this worker. Access itself already gates the
// hostname at the edge (a request without a valid service token / identity
// session never reaches this worker at all under a correctly configured
// Access Application) — this module exists so the worker does not have to
// *assume* that edge policy is correctly configured for every route, and so
// there is a single, tested place that answers "is this request actually
// Access-authenticated" for `/sync`, `/blobs/*`, and `/graphql`.
//
// Mechanism (verified against developers.cloudflare.com before writing this
// — see the task's ACCESS_SETUP.md for the citations):
//   1. The CLIENT authenticates to Access at the edge by sending
//      `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers (a
//      Cloudflare Access *service token* pair) on every request — including
//      the WebSocket upgrade request for `/sync`; Access reads headers off
//      the upgrade request the same way it does any other HTTPS request,
//      there is no separate WS-specific credential channel.
//   2. On success, Access forwards the request to this worker's origin
//      with a `Cf-Access-Jwt-Assertion` header containing a short-lived JWT
//      that Access itself signed. This worker never sees
//      `CF-Access-Client-Id`/`Secret` — only the JWT Access minted after
//      validating them.
//   3. This module verifies THAT JWT: signature against the team's JWKS,
//      `aud` against the configured Access Application's AUD tag, and
//      expiry (`jwtVerify` also validates `nbf`/standard time claims).
//
// This is NOT a replacement for configuring the Access Application/policy
// correctly (see ACCESS_SETUP.md) — it is the defense-in-depth check the
// plan's "Auth for the GraphQL endpoint" paragraph describes as optional
// but worth having ("read Cf-Access-Jwt-Assertion in-worker only if
// request-level identity is ever needed") — here, request-level identity
// IS needed: this worker has no other way to refuse an unauthenticated
// request if Access is ever misconfigured or bypassed (e.g. a direct
// `*.workers.dev` request that skips the custom, Access-protected
// hostname).
//
// JWKS verification uses `jose` (Workers-runtime-supported per its own
// package.json keywords/README — pure Web Crypto, no Node-only crypto
// APIs) rather than hand-rolled JWT parsing: getting JWT/JWKS verification
// subtly wrong (algorithm confusion, missing `exp` check, accepting `none`)
// is a well-known class of bug `jose` already closes.
//
// Caching: `jose`'s `createRemoteJWKSet` already does in-memory JWKS
// caching with a TTL (`cacheMaxAge`, default 10 minutes) and a cooldown
// against hammering the JWKS endpoint on a `kid` miss — this module keeps
// ONE such JWKS set per team domain at module scope (`jwksSets` below) so
// that caching survives across requests within the same isolate, rather
// than constructing a fresh (uncached) `RemoteJWKSet` per call.

import {
  type FetchImplementation,
  type JWTPayload,
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
} from "jose";

/** Env bindings this module reads. Both are non-secret identifiers (a
 *  team domain and an Access Application's AUD tag are not credentials —
 *  see ACCESS_SETUP.md) but are still environment-specific, so they're
 *  read off `env` rather than hardcoded, the same way every other
 *  environment-specific binding in this worker is. */
export interface AccessEnv {
  /** Cloudflare Access team domain, e.g. `"rawkode.cloudflareaccess.com"`
   *  (a bare team name like `"rawkode"` is also accepted and normalized —
   *  see `normalizeAccessTeamDomain`). */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access Application's AUD tag for this worker (Zero Trust dashboard
   *  → Access → Applications → this app → Overview). */
  ACCESS_AUD?: string;
  /**
   * Explicit local-development bootstrap only. When this binding is set,
   * loopback requests may authenticate with `X-Enchiridion-Local-Token`
   * instead of Cloudflare Access. It is intentionally absent from the
   * committed Wrangler configuration and is never accepted for a
   * non-loopback host, so it cannot weaken a deployed worker by accident.
   */
  LOCAL_DEV_ACCESS_TOKEN?: string;
}

export type AccessVerifyResult =
  | { ok: true; payload: JWTPayload }
  | { ok: false; status: 401 | 403 | 500; error: string };

/** Test-only escape hatch: lets `access-auth.test.ts` point JWKS fetches at
 *  a fake server instead of the real network. Never set by production
 *  code — `index.ts`/`yoga.ts` call `verifyAccessRequest(request, env)`
 *  with no third argument. */
export interface VerifyAccessOptions {
  /** Matches `jose`'s own `FetchImplementation` shape (narrower than
   *  `typeof fetch` — see `jose`'s `customFetch` docs), not the ambient
   *  `fetch` global, which `@cloudflare/workers-types` augments with
   *  extra members (e.g. `preconnect`) real fetch implementations have
   *  but a hand-written test fake has no reason to. */
  fetchImpl?: FetchImplementation;
}

const HEADER_NAME = "Cf-Access-Jwt-Assertion";
const LOCAL_DEV_TOKEN_HEADER = "X-Enchiridion-Local-Token";

/**
 * A local `wrangler dev` server is the only supported place for the
 * development-token path. Keep this check here, beside the auth decision,
 * rather than relying on a launch-script convention: a mistakenly deployed
 * `LOCAL_DEV_ACCESS_TOKEN` binding must still never become an origin-auth
 * bypass for an internet-reachable hostname.
 */
function isLoopbackRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * Returns `undefined` when the normal Cloudflare Access path must run.
 * When local development has been explicitly enabled for a loopback request,
 * it returns either a synthetic local identity or a fail-closed 401.
 */
function verifyLocalDevelopmentRequest(
  request: Request,
  env: AccessEnv,
): AccessVerifyResult | undefined {
  if (!env.LOCAL_DEV_ACCESS_TOKEN || !isLoopbackRequest(request)) return undefined;

  if (request.headers.get(LOCAL_DEV_TOKEN_HEADER) !== env.LOCAL_DEV_ACCESS_TOKEN) {
    return { ok: false, status: 401, error: `missing or invalid ${LOCAL_DEV_TOKEN_HEADER} header` };
  }

  return {
    ok: true,
    payload: {
      sub: "enchiridion-local-development",
      iss: "enchiridion-local-development",
    },
  };
}

/** One cached `RemoteJWKSet` per normalized team domain, module-scoped so
 *  it survives across requests within the same Worker isolate (this is the
 *  "cache the JWKS in-memory (module-level, with a TTL)" requirement — see
 *  this file's header for why the TTL/cooldown themselves are `jose`'s,
 *  not reimplemented here). Tests use per-test-unique team domains (see
 *  `access-auth.test.ts`) so cache entries never leak between test cases;
 *  `resetAccessAuthCacheForTests` exists as an extra safety net. */
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
  const stripped = rawDomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (stripped.includes(".")) return stripped;
  return `${stripped}.cloudflareaccess.com`;
}

function getJwks(
  teamDomain: string,
  fetchImpl?: FetchImplementation,
): ReturnType<typeof createRemoteJWKSet> {
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
 * case a caller ever wants request-level identity — e.g. which device
 * made a write, per the plan's "Auth for the GraphQL endpoint" paragraph),
 * or `{ ok: false, status, error }` describing exactly why verification
 * failed (missing header, expired token, wrong audience, bad signature,
 * or — a 500, not a 401/403 — this worker's own Access env vars being
 * unconfigured, which is a deploy-config bug, not a caller's fault).
 */
export async function verifyAccessRequest(
  request: Request,
  env: AccessEnv,
  options: VerifyAccessOptions = {},
): Promise<AccessVerifyResult> {
  const localDevelopmentResult = verifyLocalDevelopmentRequest(request, env);
  if (localDevelopmentResult) return localDevelopmentResult;

  const token = request.headers.get(HEADER_NAME);
  if (!token) {
    return { ok: false, status: 401, error: `missing ${HEADER_NAME} header` };
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return {
      ok: false,
      status: 500,
      error:
        "Access auth is not configured on this worker (ACCESS_TEAM_DOMAIN/ACCESS_AUD missing) — see ACCESS_SETUP.md",
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
      return {
        ok: false,
        status: 403,
        error: `Access token claim validation failed: ${error.message}`,
      };
    }
    if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { ok: false, status: 403, error: "Access token signature verification failed" };
    }
    if (error instanceof joseErrors.JWKSNoMatchingKey) {
      return {
        ok: false,
        status: 403,
        error: "Access token signed by an unknown key (kid not in team JWKS)",
      };
    }
    return {
      ok: false,
      status: 401,
      error: `Access token verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Builds the 401/403/500 `Response` for a failed `verifyAccessRequest`
 *  result — shared by every call site (`index.ts`'s `/sync`/`/blobs/*`,
 *  `yoga.ts`'s pre-Yoga check) so the deny body shape is consistent. Never
 *  called for `{ ok: true }` — callers branch on `result.ok` first. */
export function accessDenyResponse(result: Extract<AccessVerifyResult, { ok: false }>): Response {
  return new Response(JSON.stringify({ error: result.error }), {
    status: result.status,
    headers: { "content-type": "application/json" },
  });
}
