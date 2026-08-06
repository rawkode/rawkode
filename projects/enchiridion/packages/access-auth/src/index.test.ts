// index.test.ts — real crypto round-trip tests for `verifyAccessRequest`
// (./index.ts). Mirrors `workers/vault/src/access-auth.test.ts`'s rigor
// exactly (that file is untouched — this package is the new shared home
// for the logic, not a replacement for vault's own copy): no step here is
// mocked to "always succeed", every test signs a genuine JWT with a genuine
// RSA keypair (via `jose`'s own `generateKeyPair`/`SignJWT`), serves it
// through a FAKE JWKS HTTP response (`options.fetchImpl`, ./index.ts's
// test-only escape hatch), and lets `verifyAccessRequest` do real
// signature/claim verification against it — the same code path production
// requests go through, just pointed at a fake JWKS server instead of
// `https://<team>.cloudflareaccess.com`.
//
// Each test uses its own unique team domain (see `uniqueDomain` below) so
// the module-level JWKS cache in index.ts (one `RemoteJWKSet` per team
// domain, see that file's header) never lets one test's fake JWKS response
// leak into another test.

import { describe, expect, test } from "bun:test";
import { exportJWK, type FetchImplementation, generateKeyPair, SignJWT } from "jose";
import { normalizeAccessTeamDomain, verifyAccessRequest } from "./index";

const HEADER_NAME = "Cf-Access-Jwt-Assertion";
const TEST_AUD = "test-access-application-aud-tag";

let domainCounter = 0;
/** A fresh, never-reused team domain per test — see this file's header on
 *  why (JWKS cache isolation). */
function uniqueDomain(): string {
  domainCounter += 1;
  return `test-team-${domainCounter}-${Date.now()}.cloudflareaccess.com`;
}

interface SignedTestToken {
  token: string;
  fetchImpl: FetchImplementation;
}

/** Generates a real RSA keypair, signs a real JWT with it (RS256, matching
 *  what Cloudflare Access actually issues), and returns a `fetch`
 *  implementation that serves that key's public JWK from
 *  `/cdn-cgi/access/certs` — exactly the shape `verifyAccessRequest`
 *  expects to fetch. `claimOverrides` lets individual tests produce an
 *  otherwise-valid-but-wrong token (bad aud, expired, etc). */
async function signTestToken(
  teamDomain: string,
  claimOverrides: { aud?: string; expiresInSeconds?: number; issuer?: string } = {},
): Promise<SignedTestToken> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = "test-key-1";
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };

  const expiresInSeconds = claimOverrides.expiresInSeconds ?? 300;
  const token = await new SignJWT({ email: "device@example.com" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setIssuer(claimOverrides.issuer ?? `https://${teamDomain}`)
    .setAudience(claimOverrides.aud ?? TEST_AUD)
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(privateKey);

  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  const fetchImpl: FetchImplementation = async (url) => {
    if (url !== certsUrl) {
      throw new Error(`unexpected fetch in test: ${url}`);
    }
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { token, fetchImpl };
}

function requestWithToken(token?: string): Request {
  const headers = new Headers();
  if (token !== undefined) {
    headers.set(HEADER_NAME, token);
  }
  return new Request("https://example-worker.example.com/some-route", { headers });
}

describe("normalizeAccessTeamDomain", () => {
  test("appends .cloudflareaccess.com to a bare team name", () => {
    expect(normalizeAccessTeamDomain("rawkode")).toBe("rawkode.cloudflareaccess.com");
  });

  test("leaves an already-qualified domain alone", () => {
    expect(normalizeAccessTeamDomain("rawkode.cloudflareaccess.com")).toBe("rawkode.cloudflareaccess.com");
  });

  test("strips a https:// prefix and trailing slash", () => {
    expect(normalizeAccessTeamDomain("https://rawkode.cloudflareaccess.com/")).toBe(
      "rawkode.cloudflareaccess.com",
    );
  });
});

describe("verifyAccessRequest", () => {
  test("accepts a validly signed token with correct aud/iss/exp", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain);

    const result = await verifyAccessRequest(
      requestWithToken(token),
      { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: TEST_AUD },
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.aud).toBe(TEST_AUD);
      expect(result.payload.email).toBe("device@example.com");
    }
  });

  test("rejects a request with no Cf-Access-Jwt-Assertion header at all", async () => {
    const teamDomain = uniqueDomain();
    const result = await verifyAccessRequest(requestWithToken(undefined), {
      ACCESS_TEAM_DOMAIN: teamDomain,
      ACCESS_AUD: TEST_AUD,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toContain(HEADER_NAME);
    }
  });

  test("rejects an expired token", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain, { expiresInSeconds: -60 });

    const result = await verifyAccessRequest(
      requestWithToken(token),
      { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: TEST_AUD },
      { fetchImpl },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error.toLowerCase()).toContain("expired");
    }
  });

  test("rejects a token with the wrong aud", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain, { aud: "someone-elses-application" });

    const result = await verifyAccessRequest(
      requestWithToken(token),
      { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: TEST_AUD },
      { fetchImpl },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error.toLowerCase()).toContain("claim");
    }
  });

  test("rejects a token with the wrong issuer", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain, {
      issuer: "https://someone-elses-team.cloudflareaccess.com",
    });

    const result = await verifyAccessRequest(
      requestWithToken(token),
      { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: TEST_AUD },
      { fetchImpl },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });

  test("rejects a token whose signature does not match the served JWKS (tampered payload)", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain);

    // Corrupt the signature segment (third dot-separated part) — this
    // produces a well-formed-looking JWT whose signature no longer
    // verifies against the served public key, i.e. a genuine signature
    // verification failure, not just a decode error.
    //
    // Replace the FIRST base64url character of the signature (not the
    // last): a raw RSA signature's byte length is never a multiple of 3
    // (2048-bit keys sign 256 bytes, 256 % 3 == 1), so the *last*
    // base64url character of the encoding falls in a trailing partial
    // group where only its top 2 of 6 bits are actually significant — the
    // bottom 4 are unused padding. Swapping between two characters that
    // happen to share those top 2 bits (e.g. "A" and "B", both 0) changes
    // the text but not the decoded bytes, silently producing a
    // byte-for-byte identical, still-valid signature (~25% of the time,
    // confirmed empirically) and making this assertion flaky. The first
    // character, by contrast, is always part of a complete 4-char/3-byte
    // group where all 6 of its bits are significant, so choosing any
    // different character there is guaranteed to change the decoded
    // signature bytes.
    const parts = token.split(".");
    const header = parts[0];
    const payload = parts[1];
    const signature = parts[2] ?? "";
    const tamperedSignatureChar = signature.at(0) === "A" ? "B" : "A";
    const tamperedToken = `${header}.${payload}.${tamperedSignatureChar}${signature.slice(1)}`;

    const result = await verifyAccessRequest(
      requestWithToken(tamperedToken),
      { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: TEST_AUD },
      { fetchImpl },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error.toLowerCase()).toContain("signature");
    }
  });

  test("rejects a token signed by a completely different keypair than what's in the JWKS", async () => {
    const teamDomain = uniqueDomain();
    // Serve team A's real JWKS...
    const { fetchImpl } = await signTestToken(teamDomain);
    // ...but present a token signed by an unrelated keypair (simulates a
    // forged/stolen-key token, or a `kid` collision with a different key).
    const { token: foreignToken } = await signTestToken(teamDomain);

    const result = await verifyAccessRequest(
      requestWithToken(foreignToken),
      { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: TEST_AUD },
      { fetchImpl },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect([401, 403]).toContain(result.status);
    }
  });

  test("returns 500 when ACCESS_TEAM_DOMAIN/ACCESS_AUD are not configured", async () => {
    const result = await verifyAccessRequest(requestWithToken("irrelevant"), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
    }
  });

  test("caches the JWKS across repeated requests instead of refetching every time", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain);

    let fetchCount = 0;
    const countingFetch: FetchImplementation = async (url, options) => {
      fetchCount += 1;
      return fetchImpl(url, options);
    };

    const env = { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: TEST_AUD };
    const first = await verifyAccessRequest(requestWithToken(token), env, { fetchImpl: countingFetch });
    const second = await verifyAccessRequest(requestWithToken(token), env, { fetchImpl: countingFetch });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fetchCount).toBe(1);
  });

  test("two different AUD tags on the same team domain both verify against the same cached JWKS", async () => {
    // Simulates vault and gatekeeper-google sharing one Cloudflare Access
    // team but each having their own Access Application (own AUD tag) —
    // see this file's header on why "per team domain" (not "per worker" or
    // "per AUD") is the correct JWKS cache key. Both tokens below are
    // signed with the SAME keypair (as they would be in reality — one
    // team-wide JWKS signs every Access Application's tokens), just with
    // different `aud` claims.
    const teamDomain = uniqueDomain();
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const kid = "shared-team-key-1";
    const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };

    async function signFor(aud: string): Promise<string> {
      return new SignJWT({ email: "device@example.com" })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuedAt()
        .setIssuer(`https://${teamDomain}`)
        .setAudience(aud)
        .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
        .sign(privateKey);
    }

    const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
    let fetchCount = 0;
    const countingFetch: FetchImplementation = async (url) => {
      fetchCount += 1;
      if (url !== certsUrl) throw new Error(`unexpected fetch in test: ${url}`);
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const vaultResult = await verifyAccessRequest(
      requestWithToken(await signFor("vault-application-aud")),
      { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: "vault-application-aud" },
      { fetchImpl: countingFetch },
    );
    const gatekeeperResult = await verifyAccessRequest(
      requestWithToken(await signFor("gatekeeper-google-application-aud")),
      { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: "gatekeeper-google-application-aud" },
      { fetchImpl: countingFetch },
    );

    expect(vaultResult.ok).toBe(true);
    expect(gatekeeperResult.ok).toBe(true);
    // Both AUDs resolved against the same cached JWKS entry for this team
    // domain — only one fetch, even though two different Access
    // Applications' tokens were verified.
    expect(fetchCount).toBe(1);
  });
});
