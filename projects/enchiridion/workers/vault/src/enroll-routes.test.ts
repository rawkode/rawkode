// enroll-routes.test.ts — tests for `POST /enroll/provision`
// (./enroll-routes.ts). Auth-gating tests sign REAL JWTs against a REAL
// RSA keypair and serve them through a fake JWKS endpoint, the identical
// pattern ./access-auth.test.ts already established (see that file's
// header) — this proves `handleEnrollProvisionRequest` genuinely goes
// through `verifyAccessRequest`'s real signature/claim verification, not
// a stubbed-out "assume auth passed" shortcut. The Cloudflare Access
// Service Token API itself is mocked (./cloudflare-access-api.test.ts
// already proves the real request shape against that mock separately).

import { describe, expect, test } from "bun:test";
import { exportJWK, type FetchImplementation, generateKeyPair, SignJWT } from "jose";
import { resetAccessAuthCacheForTests } from "./access-auth";
import {
  generatePairingCode,
  type HandleProvisionOptions,
  handleEnrollProvisionRequest,
  resetEnrollmentStateForTests,
  validatePairingCodeFormat,
} from "./enroll-routes";

const HEADER_NAME = "Cf-Access-Jwt-Assertion";
const TEST_AUD = "test-vault-access-application-aud";

let domainCounter = 0;
function uniqueDomain(): string {
  domainCounter += 1;
  return `test-team-${domainCounter}-${Date.now()}.cloudflareaccess.com`;
}

/** Mirrors ./access-auth.test.ts's `signTestToken` exactly — see that
 *  file's header for why each step is real crypto, not a mock. */
async function signTestToken(teamDomain: string): Promise<{ token: string; fetchImpl: FetchImplementation }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = "test-key-1";
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };

  const token = await new SignJWT({ email: "already-enrolled-device@example.com" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setIssuer(`https://${teamDomain}`)
    .setAudience(TEST_AUD)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(privateKey);

  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  const fetchImpl: FetchImplementation = async (url) => {
    if (url !== certsUrl) throw new Error(`unexpected JWKS fetch in test: ${url}`);
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { token, fetchImpl };
}

interface TestSetup {
  env: {
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    CLOUDFLARE_API_TOKEN: string;
    CLOUDFLARE_ACCOUNT_ID: string;
  };
  accessToken: string;
  jwksFetch: FetchImplementation;
}

async function setup(): Promise<TestSetup> {
  const teamDomain = uniqueDomain();
  const { token, fetchImpl } = await signTestToken(teamDomain);
  return {
    env: {
      ACCESS_TEAM_DOMAIN: teamDomain,
      ACCESS_AUD: TEST_AUD,
      CLOUDFLARE_API_TOKEN: "test-cf-api-token",
      CLOUDFLARE_ACCOUNT_ID: "test-account-id",
    },
    accessToken: token,
    jwksFetch: fetchImpl,
  };
}

/** Combines the Access JWKS fetch (verifyAccessRequest's dependency) and
 *  the Cloudflare Access API fetch (createCloudflareAccessServiceToken's
 *  dependency) into ONE fetchImpl, since `handleEnrollProvisionRequest`
 *  only accepts a single `options.fetchImpl` — routed by hostname. This
 *  mirrors how the real Workers `fetch` global would actually be shared;
 *  it's not a shortcut specific to this test file. */
function combinedFetch(jwksFetch: FetchImplementation, cfFetch?: FetchImplementation): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.includes("/cdn-cgi/access/certs")) {
      return jwksFetch(url, init as never) as unknown as Response;
    }
    if (url.includes("api.cloudflare.com")) {
      if (!cfFetch) throw new Error("unexpected Cloudflare API call in this test");
      return cfFetch(url, init as never) as unknown as Response;
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

function mockCloudflareMintSuccess(): { fetchImpl: FetchImplementation; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchImplementation = async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        success: true,
        result: {
          id: "svc-1",
          client_id: "minted-client-id.access",
          client_secret: "minted-client-secret",
          name: "enchiridion-new-device-1",
          duration: "8760h",
          created_at: "2026-08-06T00:00:00Z",
          updated_at: "2026-08-06T00:00:00Z",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetchImpl, calls };
}

function provisionRequest(body: unknown, token?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== undefined) headers.set(HEADER_NAME, token);
  return new Request("https://vault.example.com/enroll/provision", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function callHandler(
  request: Request,
  env: TestSetup["env"],
  jwksFetch: FetchImplementation,
  cfFetch?: FetchImplementation,
  extra: Partial<HandleProvisionOptions> = {},
): Promise<Response> {
  return handleEnrollProvisionRequest(request, env, {
    fetchImpl: combinedFetch(jwksFetch, cfFetch),
    ...extra,
  });
}

describe("generatePairingCode / validatePairingCodeFormat", () => {
  test("generates a code matching the validated format", () => {
    const code = generatePairingCode();
    expect(validatePairingCodeFormat(code)).toBe(true);
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  test("excludes visually-ambiguous characters (0/O/1/I/L)", () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).not.toMatch(/[0O1IL]/);
    }
  });

  test("rejects malformed codes", () => {
    expect(validatePairingCodeFormat("abcd-efgh")).toBe(false); // lowercase
    expect(validatePairingCodeFormat("ABCDEFGH")).toBe(false); // no hyphen
    expect(validatePairingCodeFormat("ABC-DEFG")).toBe(false); // wrong grouping
    expect(validatePairingCodeFormat("AB0D-EFGH")).toBe(false); // ambiguous char
    expect(validatePairingCodeFormat(123)).toBe(false); // wrong type
    expect(validatePairingCodeFormat(undefined)).toBe(false);
  });
});

describe("handleEnrollProvisionRequest — auth gating", () => {
  test("rejects a request with no Access JWT at all (device never reached Access, or Access misconfigured)", async () => {
    resetAccessAuthCacheForTests();
    resetEnrollmentStateForTests();
    const { env, jwksFetch } = await setup();

    const response = await callHandler(
      provisionRequest({ pairingCode: generatePairingCode(), deviceName: "New iPhone" }, undefined),
      env,
      jwksFetch,
    );

    expect(response.status).toBe(401);
  });

  test("rejects a request with a validly-signed JWT for a DIFFERENT Access Application (wrong aud)", async () => {
    resetAccessAuthCacheForTests();
    resetEnrollmentStateForTests();
    const { env, jwksFetch } = await setup();

    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const kid = "other-key";
    const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
    const wrongAudToken = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setIssuer(`https://${env.ACCESS_TEAM_DOMAIN}`)
      .setAudience("someone-elses-application")
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(privateKey);
    const wrongJwksFetch: FetchImplementation = async (url) => {
      if (url !== `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`) throw new Error("unexpected");
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const response = await callHandler(
      provisionRequest({ pairingCode: generatePairingCode(), deviceName: "New iPhone" }, wrongAudToken),
      env,
      wrongJwksFetch,
    );

    expect(response.status).toBe(403);
  });

  test("never calls the Cloudflare Access API when auth fails", async () => {
    resetAccessAuthCacheForTests();
    resetEnrollmentStateForTests();
    const { env, jwksFetch } = await setup();

    const response = await callHandler(
      provisionRequest({ pairingCode: generatePairingCode(), deviceName: "New iPhone" }, "not-a-real-jwt"),
      env,
      jwksFetch,
      async () => {
        throw new Error("Cloudflare API must not be called when Access auth fails");
      },
    );

    expect([401, 403]).toContain(response.status);
  });
});

describe("handleEnrollProvisionRequest — request validation", () => {
  test("rejects a malformed pairingCode with 400, without touching Cloudflare's API", async () => {
    resetAccessAuthCacheForTests();
    resetEnrollmentStateForTests();
    const { env, accessToken, jwksFetch } = await setup();

    const response = await callHandler(
      provisionRequest({ pairingCode: "not-valid", deviceName: "New iPhone" }, accessToken),
      env,
      jwksFetch,
      async () => {
        throw new Error("must not reach Cloudflare API for an invalid pairing code");
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("pairingCode");
  });

  test("rejects a missing/empty deviceName with 400", async () => {
    resetAccessAuthCacheForTests();
    resetEnrollmentStateForTests();
    const { env, accessToken, jwksFetch } = await setup();

    const response = await callHandler(
      provisionRequest({ pairingCode: generatePairingCode(), deviceName: "   " }, accessToken),
      env,
      jwksFetch,
    );

    expect(response.status).toBe(400);
  });

  test("rejects a non-POST method", async () => {
    resetAccessAuthCacheForTests();
    resetEnrollmentStateForTests();
    const { env, accessToken, jwksFetch } = await setup();
    const request = new Request("https://vault.example.com/enroll/provision", {
      method: "GET",
      headers: { [HEADER_NAME]: accessToken },
    });

    const response = await callHandler(request, env, jwksFetch);
    expect(response.status).toBe(405);
  });

  test("rejects invalid JSON body with 400", async () => {
    resetAccessAuthCacheForTests();
    resetEnrollmentStateForTests();
    const { env, accessToken, jwksFetch } = await setup();
    const request = new Request("https://vault.example.com/enroll/provision", {
      method: "POST",
      headers: { [HEADER_NAME]: accessToken, "content-type": "application/json" },
      body: "{not json",
    });

    const response = await callHandler(request, env, jwksFetch);
    expect(response.status).toBe(400);
  });
});

describe("handleEnrollProvisionRequest — happy path", () => {
  test("mints a fresh client_id/client_secret pair via the Cloudflare Access API and returns it", async () => {
    resetAccessAuthCacheForTests();
    resetEnrollmentStateForTests();
    const { env, accessToken, jwksFetch } = await setup();
    const { fetchImpl: cfFetch, calls } = mockCloudflareMintSuccess();
    const pairingCode = generatePairingCode();

    const response = await callHandler(
      provisionRequest({ pairingCode, deviceName: "David's New iPhone" }, accessToken),
      env,
      jwksFetch,
      cfFetch,
    );

    expect(response.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/accounts/test-account-id/access/service_tokens");

    const body = (await response.json()) as {
      pairingCode: string;
      deviceName: string;
      clientId: string;
      clientSecret: string;
      mintedAt: string;
      expiresAt: string;
    };
    expect(body.pairingCode).toBe(pairingCode);
    expect(body.deviceName).toBe("David's New iPhone");
    expect(body.clientId).toBe("minted-client-id.access");
    expect(body.clientSecret).toBe("minted-client-secret");
    expect(typeof body.expiresAt).toBe("string");
  });

  test("names the minted Cloudflare service token after the device (slugified) with a timestamp suffix", async () => {
    resetAccessAuthCacheForTests();
    resetEnrollmentStateForTests();
    const { env, accessToken, jwksFetch } = await setup();
    const capturedBodies: string[] = [];
    const cfFetch: FetchImplementation = async (url, init) => {
      capturedBodies.push(String((init as RequestInit)?.body));
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            id: "svc-1",
            client_id: "cid",
            client_secret: "csecret",
            name: "captured",
            duration: "8760h",
            created_at: "2026-08-06T00:00:00Z",
            updated_at: "2026-08-06T00:00:00Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await callHandler(
      provisionRequest({ pairingCode: generatePairingCode(), deviceName: "David's iPhone 15!!" }, accessToken),
      env,
      jwksFetch,
      cfFetch,
    );

    const parsed = JSON.parse(capturedBodies[0]!);
    expect(parsed.name).toMatch(/^enchiridion-david-s-iphone-15-\d+$/);
  });
});

describe("handleEnrollProvisionRequest — replay protection", () => {
  test("rejects reusing the same pairing code with 409, without minting a second token", async () => {
    resetAccessAuthCacheForTests();
    resetEnrollmentStateForTests();
    const { env, accessToken, jwksFetch } = await setup();
    const { fetchImpl: cfFetch, calls } = mockCloudflareMintSuccess();
    const pairingCode = generatePairingCode();

    const first = await callHandler(
      provisionRequest({ pairingCode, deviceName: "Device A" }, accessToken),
      env,
      jwksFetch,
      cfFetch,
    );
    expect(first.status).toBe(201);

    const second = await callHandler(
      provisionRequest({ pairingCode, deviceName: "Device A" }, accessToken),
      env,
      jwksFetch,
      cfFetch,
    );
    expect(second.status).toBe(409);
    expect(calls).toHaveLength(1); // Cloudflare's API was only ever called once.
  });

  test("allows reusing a pairing code after it has expired (TTL), via an injected clock", async () => {
    resetAccessAuthCacheForTests();
    resetEnrollmentStateForTests();
    const { env, accessToken, jwksFetch } = await setup();
    const { fetchImpl: cfFetch, calls } = mockCloudflareMintSuccess();
    const pairingCode = generatePairingCode();
    let now = 1_000_000;

    const first = await callHandler(
      provisionRequest({ pairingCode, deviceName: "Device A" }, accessToken),
      env,
      jwksFetch,
      cfFetch,
      { now: () => now },
    );
    expect(first.status).toBe(201);

    now += 6 * 60 * 1000; // 6 minutes later — past the 5-minute TTL.
    const second = await callHandler(
      provisionRequest({ pairingCode, deviceName: "Device A" }, accessToken),
      env,
      jwksFetch,
      cfFetch,
      { now: () => now },
    );
    expect(second.status).toBe(201);
    expect(calls).toHaveLength(2);
  });

  test("does NOT burn the pairing code if the Cloudflare API call fails, so a caller can retry", async () => {
    resetAccessAuthCacheForTests();
    resetEnrollmentStateForTests();
    const { env, accessToken, jwksFetch } = await setup();
    const pairingCode = generatePairingCode();
    let shouldFail = true;
    const cfFetch: FetchImplementation = async () => {
      if (shouldFail) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: "transient" }] }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            id: "svc-1",
            client_id: "cid",
            client_secret: "csecret",
            name: "n",
            duration: "8760h",
            created_at: "2026-08-06T00:00:00Z",
            updated_at: "2026-08-06T00:00:00Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const failed = await callHandler(
      provisionRequest({ pairingCode, deviceName: "Device A" }, accessToken),
      env,
      jwksFetch,
      cfFetch,
    );
    expect(failed.status).toBe(500);

    shouldFail = false;
    const retried = await callHandler(
      provisionRequest({ pairingCode, deviceName: "Device A" }, accessToken),
      env,
      jwksFetch,
      cfFetch,
    );
    expect(retried.status).toBe(201);
  });
});
