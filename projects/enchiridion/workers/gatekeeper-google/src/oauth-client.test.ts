// oauth-client.test.ts — real-shaped-response tests for the Google token
// endpoint client (./oauth-client.ts). Every `fetchImpl` fake below returns
// exactly the JSON shape Google's documented OAuth 2.0 token endpoint
// returns (verified against Google's own error-response documentation —
// `{ error, error_description }` on failure; `{ access_token, expires_in,
// refresh_token?, token_type, scope }` on success) — never an
// "always succeeds" stub. Mirrors the rigor
// `workers/vault/src/access-auth.test.ts` uses for its JWKS mocking (real
// signed fixtures, not a fake that can't fail).

import { describe, expect, test } from "bun:test";
import {
  buildAuthorizationUrl,
  CALENDAR_EVENTS_SCOPE,
  exchangeAuthorizationCode,
  type FetchLike,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GoogleOAuthError,
  isOAuthScopeStage,
  refreshAccessToken,
  scopeForStage,
} from "./oauth-client";

const CONFIG = {
  clientId: "test-client-id.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUri: "https://gatekeeper-google.example.com/oauth/google/callback",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("buildAuthorizationUrl", () => {
  test("includes client_id, redirect_uri, calendar.events scope, offline+consent, and state", () => {
    const url = new URL(buildAuthorizationUrl(CONFIG, "csrf-state-123"));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(CALENDAR_EVENTS_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("csrf-state-123");
  });

  test("a custom scope overrides the default", () => {
    const url = new URL(buildAuthorizationUrl(CONFIG, "s", "https://www.googleapis.com/auth/calendar.readonly"));
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.readonly");
  });

  test("always sets include_granted_scopes=true (incremental authorization across staged consent)", () => {
    const url = new URL(buildAuthorizationUrl(CONFIG, "s"));
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  });
});

describe("scopeForStage / isOAuthScopeStage — staged-consent scope resolution", () => {
  test("scopeForStage resolves each stage to the correct Google scope URL", () => {
    expect(scopeForStage("calendar")).toBe(CALENDAR_EVENTS_SCOPE);
    expect(scopeForStage("gmail_readonly")).toBe(GMAIL_READONLY_SCOPE);
    expect(scopeForStage("gmail_send")).toBe(GMAIL_SEND_SCOPE);
    expect(scopeForStage("gmail_modify")).toBe(GMAIL_MODIFY_SCOPE);
  });

  test("the four stages resolve to four distinct scope URLs", () => {
    const resolved = new Set([
      scopeForStage("calendar"),
      scopeForStage("gmail_readonly"),
      scopeForStage("gmail_send"),
      scopeForStage("gmail_modify"),
    ]);
    expect(resolved.size).toBe(4);
  });

  test("GMAIL_READONLY_SCOPE / GMAIL_SEND_SCOPE / GMAIL_MODIFY_SCOPE are the correct Google API scope URLs", () => {
    expect(GMAIL_READONLY_SCOPE).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(GMAIL_SEND_SCOPE).toBe("https://www.googleapis.com/auth/gmail.send");
    expect(GMAIL_MODIFY_SCOPE).toBe("https://www.googleapis.com/auth/gmail.modify");
  });

  test("isOAuthScopeStage accepts exactly the four known stage keys", () => {
    expect(isOAuthScopeStage("calendar")).toBe(true);
    expect(isOAuthScopeStage("gmail_readonly")).toBe(true);
    expect(isOAuthScopeStage("gmail_send")).toBe(true);
    expect(isOAuthScopeStage("gmail_modify")).toBe(true);
  });

  test("isOAuthScopeStage rejects unknown values, including a raw Google scope URL or garbage input", () => {
    expect(isOAuthScopeStage("gmail")).toBe(false);
    expect(isOAuthScopeStage("")).toBe(false);
    expect(isOAuthScopeStage(GMAIL_READONLY_SCOPE)).toBe(false);
    expect(isOAuthScopeStage("__proto__")).toBe(false);
  });

  test("buildAuthorizationUrl(config, state, scopeForStage(stage)) builds the correct URL for each stage", () => {
    for (const [stage, expectedScope] of [
      ["calendar", CALENDAR_EVENTS_SCOPE],
      ["gmail_readonly", GMAIL_READONLY_SCOPE],
      ["gmail_send", GMAIL_SEND_SCOPE],
      ["gmail_modify", GMAIL_MODIFY_SCOPE],
    ] as const) {
      const url = new URL(buildAuthorizationUrl(CONFIG, "state-x", scopeForStage(stage)));
      expect(url.searchParams.get("scope")).toBe(expectedScope);
      expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
      expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    }
  });
});

describe("exchangeAuthorizationCode", () => {
  test("posts grant_type=authorization_code with the code and redirect_uri, returns parsed tokens", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const fetchImpl: FetchLike = async (url, init) => {
      capturedUrl = url;
      capturedBody = String(init?.body ?? "");
      return jsonResponse(200, {
        access_token: "ya29.access-token-value",
        expires_in: 3599,
        refresh_token: "1//refresh-token-value",
        scope: CALENDAR_EVENTS_SCOPE,
        token_type: "Bearer",
      });
    };

    const result = await exchangeAuthorizationCode(CONFIG, "auth-code-xyz", fetchImpl);

    expect(capturedUrl).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(capturedBody);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code-xyz");
    expect(form.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(form.get("client_id")).toBe(CONFIG.clientId);
    expect(form.get("client_secret")).toBe(CONFIG.clientSecret);

    expect(result).toEqual({
      accessToken: "ya29.access-token-value",
      expiresIn: 3599,
      refreshToken: "1//refresh-token-value",
      scope: CALENDAR_EVENTS_SCOPE,
    });
  });

  test("a response with no refresh_token field leaves refreshToken undefined", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, { access_token: "at", expires_in: 3599, token_type: "Bearer" });

    const result = await exchangeAuthorizationCode(CONFIG, "code", fetchImpl);
    expect(result.refreshToken).toBeUndefined();
  });

  test("a response with no scope field leaves scope undefined (never crashes on a missing field)", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, { access_token: "at", expires_in: 3599, refresh_token: "rt", token_type: "Bearer" });

    const result = await exchangeAuthorizationCode(CONFIG, "code", fetchImpl);
    expect(result.scope).toBeUndefined();
  });

  test("a granted-scope set NARROWER than what was requested (partial consent decline) is passed through as-is, not rejected", async () => {
    // Simulates requesting a combined/incremental scope set (e.g. via
    // include_granted_scopes=true across staged consent) but Google only
    // actually granting a subset — the exchange must not throw or silently
    // drop the narrower value; `token-store.ts`'s `storeInitialTokens`
    // persists exactly what's returned here.
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, {
        access_token: "at",
        expires_in: 3599,
        refresh_token: "rt",
        // Requested CALENDAR_EVENTS_SCOPE + GMAIL_READONLY_SCOPE together
        // (a hypothetical combined request), but the user only approved
        // the calendar half.
        scope: CALENDAR_EVENTS_SCOPE,
        token_type: "Bearer",
      });

    const result = await exchangeAuthorizationCode(CONFIG, "code", fetchImpl);
    expect(result.scope).toBe(CALENDAR_EVENTS_SCOPE);
    expect(result.scope).not.toContain("gmail.readonly");
  });

  test("an invalid_grant error response (e.g. a reused/expired code) throws GoogleOAuthError", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(400, { error: "invalid_grant", error_description: "Malformed auth code." });

    await expect(exchangeAuthorizationCode(CONFIG, "bad-code", fetchImpl)).rejects.toThrow(GoogleOAuthError);
  });
});

describe("refreshAccessToken", () => {
  test("posts grant_type=refresh_token with the stored refresh token, returns parsed tokens", async () => {
    let capturedBody = "";
    const fetchImpl: FetchLike = async (_url, init) => {
      capturedBody = String(init?.body ?? "");
      return jsonResponse(200, {
        access_token: "ya29.new-access-token",
        expires_in: 3599,
        scope: CALENDAR_EVENTS_SCOPE,
        token_type: "Bearer",
      });
    };

    const result = await refreshAccessToken(CONFIG, "1//stored-refresh-token", fetchImpl);

    const form = new URLSearchParams(capturedBody);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("1//stored-refresh-token");
    expect(form.get("client_id")).toBe(CONFIG.clientId);
    expect(form.get("client_secret")).toBe(CONFIG.clientSecret);

    expect(result).toEqual({
      accessToken: "ya29.new-access-token",
      expiresIn: 3599,
      refreshToken: undefined,
      scope: CALENDAR_EVENTS_SCOPE,
    });
  });

  test("a revoked grant (invalid_grant) throws a GoogleOAuthError carrying Google's error code", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      });

    let caught: unknown;
    try {
      await refreshAccessToken(CONFIG, "1//revoked-refresh-token", fetchImpl);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GoogleOAuthError);
    expect((caught as GoogleOAuthError).code).toBe("invalid_grant");
    expect((caught as GoogleOAuthError).message).toContain("Token has been expired or revoked");
  });

  test("an invalid_client error (wrong client secret) throws GoogleOAuthError with that code", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(401, { error: "invalid_client", error_description: "Unauthorized" });

    let caught: unknown;
    try {
      await refreshAccessToken(CONFIG, "rt", fetchImpl);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GoogleOAuthError);
    expect((caught as GoogleOAuthError).code).toBe("invalid_client");
  });

  test("a 5xx with no parseable error body still throws (does not crash trying to read .error)", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(503, { message: "backend unavailable" });

    let caught: unknown;
    try {
      await refreshAccessToken(CONFIG, "rt", fetchImpl);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GoogleOAuthError);
    expect((caught as GoogleOAuthError).code).toBe("http_503");
  });

  test("a non-JSON response body throws a plain Error, not a GoogleOAuthError", async () => {
    const fetchImpl: FetchLike = async () => new Response("<html>not json</html>", { status: 502 });

    await expect(refreshAccessToken(CONFIG, "rt", fetchImpl)).rejects.toThrow(/non-JSON/);
  });

  test("a 2xx response missing access_token/expires_in throws a plain Error", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, { token_type: "Bearer" });

    await expect(refreshAccessToken(CONFIG, "rt", fetchImpl)).rejects.toThrow(/unexpected shape/);
  });
});
