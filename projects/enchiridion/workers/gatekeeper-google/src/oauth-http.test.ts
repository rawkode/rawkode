// oauth-http.test.ts — the Access-gate + config-load + route-handling
// pipeline `index.ts`'s `fetch()` actually calls for
// `/oauth/google/authorize`/`/callback` (see ./oauth-http.ts's file header
// for why this lives in a separate, cloudflare:workers-independent module
// instead of importing `index.ts` directly).
//
// Fix 1 rigor: "an unauthenticated request ... is rejected before any
// Google network call happens" is proven the same way
// `oauth-routes.test.ts`'s CSRF-before-token-exchange tests are — a
// `fetchImpl`/account stub that THROWS if invoked, not just a status-code
// assertion.

import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type FetchImplementation } from "jose";
import { handleOAuthAuthorizeRequest, handleOAuthCallbackRequest, type OAuthHttpEnv } from "./oauth-http";
import type { OAuthAccountStub } from "./oauth-routes";
import type { ConsumeOAuthStateResult } from "./oauth-state";
import type { StoreInitialTokensResult } from "./token-store";

const GOOGLE_CONFIG_VARS = {
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "https://gatekeeper-google.example.com/oauth/google/callback",
};

const TEST_AUD = "test-gatekeeper-google-aud";

/** Mints a real, validly-signed Access JWT + a fake JWKS-serving
 *  `fetchImpl`, exactly like `@enchiridion/access-auth`'s own test suite —
 *  see that package for the full rigor rationale (real RSA keypair, real
 *  signature, no step mocked to "always succeed"). */
async function signAccessToken(teamDomain: string): Promise<{ token: string; accessFetchImpl: FetchImplementation }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = "test-key-1";
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const token = await new SignJWT({ email: "admin@rawkode.academy" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setIssuer(`https://${teamDomain}`)
    .setAudience(TEST_AUD)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(privateKey);

  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  const accessFetchImpl: FetchImplementation = async (url) => {
    if (url !== certsUrl) throw new Error(`unexpected Access JWKS fetch in test: ${url}`);
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { token, accessFetchImpl };
}

let domainCounter = 0;
function uniqueTeamDomain(): string {
  domainCounter += 1;
  return `oauth-http-test-${domainCounter}-${Date.now()}.cloudflareaccess.com`;
}

function envFor(teamDomain: string): OAuthHttpEnv {
  return { ...GOOGLE_CONFIG_VARS, ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: TEST_AUD };
}

function requestWithAccessToken(url: string, token?: string): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request(url, { headers });
}

function throwingAccount(): OAuthAccountStub {
  return {
    beginOAuthState: () => {
      throw new Error("beginOAuthState must not be called for an unauthenticated request");
    },
    consumeOAuthState: () => {
      throw new Error("consumeOAuthState must not be called for an unauthenticated request");
    },
    storeInitialTokens: () => {
      throw new Error("storeInitialTokens must not be called for an unauthenticated request");
    },
  };
}

describe("handleOAuthAuthorizeRequest — Access gate (Fix 1)", () => {
  test("an unauthenticated request (no Cf-Access-Jwt-Assertion header) is rejected with 401 BEFORE touching the account stub or Google", async () => {
    const teamDomain = uniqueTeamDomain();
    // The global `jose` JWKS fetch is never reached either — no header
    // means `verifyAccessRequest` returns before it would ever call
    // `getJwks`/`jwtVerify` (see @enchiridion/access-auth's own tests for
    // this same guarantee at the package level). We additionally assert
    // NOTHING on the account stub was ever invoked, matching the task's
    // "assert the fake fetch was never called" rigor.
    const response = await handleOAuthAuthorizeRequest(
      requestWithAccessToken("https://gatekeeper-google.example.com/oauth/google/authorize"),
      envFor(teamDomain),
      throwingAccount(),
    );

    expect(response.status).toBe(401);
  });

  test("an unauthenticated request with a garbage Access token is rejected (403) before touching the account stub", async () => {
    const teamDomain = uniqueTeamDomain();
    const response = await handleOAuthAuthorizeRequest(
      requestWithAccessToken("https://gatekeeper-google.example.com/oauth/google/authorize", "not-a-real-jwt"),
      envFor(teamDomain),
      throwingAccount(),
    );

    expect([401, 403]).toContain(response.status);
  });

  test("?scope=gmail_readonly resolves to the Gmail readonly scope in the redirect URL", async () => {
    const teamDomain = uniqueTeamDomain();
    const { token, accessFetchImpl } = await signAccessToken(teamDomain);
    const { account } = fakeAccountForAuthorize();

    const realFetch = globalThis.fetch;
    globalThis.fetch = accessFetchImpl as unknown as typeof fetch;
    try {
      const response = await handleOAuthAuthorizeRequest(
        requestWithAccessToken(
          "https://gatekeeper-google.example.com/oauth/google/authorize?scope=gmail_readonly",
          token,
        ),
        envFor(teamDomain),
        account,
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(new URL(location).searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("no ?scope= param defaults to the calendar stage (backward compatible)", async () => {
    const teamDomain = uniqueTeamDomain();
    const { token, accessFetchImpl } = await signAccessToken(teamDomain);
    const { account } = fakeAccountForAuthorize();

    const realFetch = globalThis.fetch;
    globalThis.fetch = accessFetchImpl as unknown as typeof fetch;
    try {
      const response = await handleOAuthAuthorizeRequest(
        requestWithAccessToken("https://gatekeeper-google.example.com/oauth/google/authorize", token),
        envFor(teamDomain),
        account,
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(new URL(location).searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.events");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("an unrecognized ?scope= value is rejected with 400 BEFORE touching the account stub or Google", async () => {
    const teamDomain = uniqueTeamDomain();
    const { token, accessFetchImpl } = await signAccessToken(teamDomain);

    const realFetch = globalThis.fetch;
    globalThis.fetch = accessFetchImpl as unknown as typeof fetch;
    try {
      const response = await handleOAuthAuthorizeRequest(
        requestWithAccessToken(
          "https://gatekeeper-google.example.com/oauth/google/authorize?scope=not-a-real-stage",
          token,
        ),
        envFor(teamDomain),
        throwingAccount(),
      );
      expect(response.status).toBe(400);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("an authenticated request passes the Access gate and proceeds to mint a state / redirect to Google", async () => {
    // `handleOAuthAuthorizeRequest` (like index.ts's real production call
    // site) doesn't expose a `fetchImpl` seam into `verifyAccessRequest` —
    // that escape hatch is `@enchiridion/access-auth`'s own test-only
    // option, never threaded through production callers. To exercise the
    // ALLOW path here with real signature verification (not a stub that
    // always returns ok), this test temporarily substitutes `globalThis.fetch`
    // for the one real network call `jose`'s `createRemoteJWKSet` makes
    // (the JWKS fetch) — restored in `finally`, and using a
    // never-reused team domain so this doesn't pollute the module-level
    // JWKS cache for any other test.
    const teamDomain = uniqueTeamDomain();
    const { token, accessFetchImpl } = await signAccessToken(teamDomain);
    const { account, calls } = fakeAccountForAuthorize();

    const realFetch = globalThis.fetch;
    globalThis.fetch = accessFetchImpl as unknown as typeof fetch;
    try {
      const response = await handleOAuthAuthorizeRequest(
        requestWithAccessToken("https://gatekeeper-google.example.com/oauth/google/authorize", token),
        envFor(teamDomain),
        account,
      );
      expect(response.status).toBe(302);
      expect(calls.beginOAuthState).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

function fakeAccountForAuthorize(): {
  account: Pick<OAuthAccountStub, "beginOAuthState">;
  calls: { beginOAuthState: number };
} {
  const calls = { beginOAuthState: 0 };
  return {
    account: {
      beginOAuthState: async () => {
        calls.beginOAuthState += 1;
        return "minted-state-token";
      },
    },
    calls,
  };
}

describe("handleOAuthCallbackRequest — Access gate (Fix 1) + Fix 3 (no unhandled crash)", () => {
  function fakeAccount(overrides: {
    consumeOAuthState?: () => ConsumeOAuthStateResult;
    storeInitialTokens?: () => StoreInitialTokensResult;
  } = {}): { account: OAuthAccountStub; calls: { consumeOAuthState: number; storeInitialTokens: number } } {
    const calls = { consumeOAuthState: 0, storeInitialTokens: 0 };
    return {
      account: {
        beginOAuthState: async () => "unused",
        consumeOAuthState: async () => {
          calls.consumeOAuthState += 1;
          return overrides.consumeOAuthState ? overrides.consumeOAuthState() : { valid: true, allowReplace: false };
        },
        storeInitialTokens: async () => {
          calls.storeInitialTokens += 1;
          return overrides.storeInitialTokens ? overrides.storeInitialTokens() : { status: "stored" };
        },
      },
      calls,
    };
  }

  test("an unauthenticated callback request never reaches consumeOAuthState or any token exchange", async () => {
    const teamDomain = uniqueTeamDomain();
    let fetchCalled = false;
    const { account, calls } = fakeAccount();

    const response = await handleOAuthCallbackRequest(
      requestWithAccessToken(
        "https://gatekeeper-google.example.com/oauth/google/callback?code=auth-code&state=some-state",
      ),
      envFor(teamDomain),
      account,
      async () => {
        fetchCalled = true;
        throw new Error("token exchange must not happen for an unauthenticated callback request");
      },
    );

    expect(response.status).toBe(401);
    expect(fetchCalled).toBe(false);
    expect(calls.consumeOAuthState).toBe(0);
    expect(calls.storeInitialTokens).toBe(0);
  });

  test("Access env not configured on this worker fails closed (500), not a silent bypass", async () => {
    const { account } = fakeAccount();
    const response = await handleOAuthCallbackRequest(
      requestWithAccessToken(
        "https://gatekeeper-google.example.com/oauth/google/callback?code=auth-code&state=some-state",
        "irrelevant-token",
      ),
      { ...GOOGLE_CONFIG_VARS }, // no ACCESS_TEAM_DOMAIN/ACCESS_AUD at all
      account,
    );
    expect(response.status).toBe(500);
  });
});
