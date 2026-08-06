// oauth-routes.test.ts — the callback's state-parameter CSRF check, per the
// task brief: "valid state accepted, missing/mismatched state rejected
// before any token exchange happens." Every test uses a `fetchImpl` that
// throws if called, so a rejected-state test that somehow still called
// Google's token endpoint would fail loudly, not silently pass on response
// status alone.
//
// Also covers the no-silent-replace guard (Fix 2): `storeInitialTokens` on
// an existing connection without `allowReplace` is rejected (409), and with
// `allowReplace` (threaded from `?reconnect=true`'s state flag) it
// succeeds — see `oauth-state.ts`/`token-store.ts`'s file headers for the
// full design.

import { describe, expect, test } from "bun:test";
import { CALENDAR_EVENTS_SCOPE, GMAIL_READONLY_SCOPE, scopeForStage } from "./oauth-client";
import { handleOAuthAuthorize, handleOAuthCallback, type OAuthAccountStub } from "./oauth-routes";
import type { ConsumeOAuthStateResult } from "./oauth-state";
import type { StoreInitialTokensResult } from "./token-store";

const CONFIG = {
  clientId: "test-client-id.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUri: "https://gatekeeper-google.example.com/oauth/google/callback",
};

function throwingFetch(): never {
  throw new Error("token exchange must not happen for this test case");
}

function successfulExchangeFetch() {
  return async () =>
    new Response(
      JSON.stringify({ access_token: "at", expires_in: 3600, refresh_token: "rt", token_type: "Bearer" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

/** A hand-written fake of the DO RPC surface `oauth-routes.ts` depends on —
 *  records every call so tests can assert not just the return value but
 *  exactly what was (and wasn't) invoked. */
function fakeAccount(overrides: {
  beginOAuthState?: (reconnect: boolean) => Promise<string> | string;
  consumeOAuthState?: (state: string) => Promise<ConsumeOAuthStateResult> | ConsumeOAuthStateResult;
  storeInitialTokens?: (
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
    allowReplace: boolean,
  ) => Promise<StoreInitialTokensResult> | StoreInitialTokensResult;
} = {}) {
  const calls = {
    beginOAuthState: [] as boolean[],
    consumeOAuthState: [] as string[],
    storeInitialTokens: [] as [string, string, number, boolean][],
  };
  const account: OAuthAccountStub = {
    beginOAuthState: async (reconnect = false) => {
      calls.beginOAuthState.push(reconnect);
      return overrides.beginOAuthState ? await overrides.beginOAuthState(reconnect) : "generated-state-token";
    },
    consumeOAuthState: async (state) => {
      calls.consumeOAuthState.push(state);
      return overrides.consumeOAuthState
        ? await overrides.consumeOAuthState(state)
        : { valid: true, allowReplace: false };
    },
    storeInitialTokens: async (accessToken, refreshToken, expiresIn, allowReplace) => {
      calls.storeInitialTokens.push([accessToken, refreshToken, expiresIn, allowReplace]);
      return overrides.storeInitialTokens
        ? await overrides.storeInitialTokens(accessToken, refreshToken, expiresIn, allowReplace)
        : { status: "stored" };
    },
  };
  return { account, calls };
}

describe("handleOAuthAuthorize", () => {
  test("mints a state via the account stub and redirects to Google with it", async () => {
    const { account, calls } = fakeAccount({ beginOAuthState: async () => "csrf-state-xyz" });

    const result = await handleOAuthAuthorize(CONFIG, account);

    expect(calls.beginOAuthState).toEqual([false]);
    expect(result.status).toBe(302);
    const url = new URL(result.location);
    expect(url.searchParams.get("state")).toBe("csrf-state-xyz");
    expect(url.searchParams.get("scope")).toBe(CALENDAR_EVENTS_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  test("options.reconnect: true is threaded through to beginOAuthState", async () => {
    const { account, calls } = fakeAccount();

    await handleOAuthAuthorize(CONFIG, account, { reconnect: true });

    expect(calls.beginOAuthState).toEqual([true]);
  });

  test("omitting options (or reconnect) defaults to a non-reconnect state", async () => {
    const { account, calls } = fakeAccount();

    await handleOAuthAuthorize(CONFIG, account);
    await handleOAuthAuthorize(CONFIG, account, {});

    expect(calls.beginOAuthState).toEqual([false, false]);
  });
});

describe("handleOAuthCallback — CSRF state check", () => {
  test("a valid, matching state is accepted and proceeds to token exchange", async () => {
    const { account, calls } = fakeAccount({ consumeOAuthState: () => ({ valid: true, allowReplace: false }) });
    let exchangeCalled = false;

    const result = await handleOAuthCallback(
      { code: "auth-code", state: "valid-state", error: null },
      CONFIG,
      account,
      async () => {
        exchangeCalled = true;
        return new Response(
          JSON.stringify({ access_token: "at", expires_in: 3600, refresh_token: "rt", token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    expect(calls.consumeOAuthState).toEqual(["valid-state"]);
    expect(exchangeCalled).toBe(true);
    expect(result.status).toBe(200);
    expect(calls.storeInitialTokens).toEqual([["at", "rt", 3600, false]]);
  });

  test("a missing state parameter is rejected with 400 BEFORE any state check or token exchange", async () => {
    const { account, calls } = fakeAccount();

    const result = await handleOAuthCallback(
      { code: "auth-code", state: null, error: null },
      CONFIG,
      account,
      throwingFetch,
    );

    expect(result.status).toBe(400);
    expect(result.body).toContain("state");
    expect(calls.consumeOAuthState).toEqual([]);
    expect(calls.storeInitialTokens).toEqual([]);
  });

  test("a mismatched/unknown state is rejected with 403 and NEVER reaches token exchange", async () => {
    const { account, calls } = fakeAccount({ consumeOAuthState: () => ({ valid: false, allowReplace: false }) });

    const result = await handleOAuthCallback(
      { code: "auth-code", state: "attacker-supplied-state", error: null },
      CONFIG,
      account,
      throwingFetch, // would throw if handleOAuthCallback ever called it
    );

    expect(result.status).toBe(403);
    expect(result.body.toLowerCase()).toContain("state");
    expect(calls.consumeOAuthState).toEqual(["attacker-supplied-state"]);
    expect(calls.storeInitialTokens).toEqual([]);
  });

  test("an expired state (consumeOAuthState returns valid: false) is rejected the same way as mismatched", async () => {
    const { account, calls } = fakeAccount({ consumeOAuthState: () => ({ valid: false, allowReplace: false }) });

    const result = await handleOAuthCallback(
      { code: "auth-code", state: "expired-state", error: null },
      CONFIG,
      account,
      throwingFetch,
    );

    expect(result.status).toBe(403);
    expect(calls.storeInitialTokens).toEqual([]);
  });

  test("a missing code parameter is rejected with 400 before the state check", async () => {
    const { account, calls } = fakeAccount();

    const result = await handleOAuthCallback(
      { code: null, state: "some-state", error: null },
      CONFIG,
      account,
      throwingFetch,
    );

    expect(result.status).toBe(400);
    expect(result.body).toContain("code");
    // The state check never even runs — nothing to verify state against
    // without a code to eventually exchange.
    expect(calls.consumeOAuthState).toEqual([]);
  });

  test("Google's ?error=access_denied short-circuits before any state check", async () => {
    const { account, calls } = fakeAccount();

    const result = await handleOAuthCallback(
      { code: null, state: null, error: "access_denied" },
      CONFIG,
      account,
      throwingFetch,
    );

    expect(result.status).toBe(400);
    expect(result.body).toContain("access_denied");
    expect(calls.consumeOAuthState).toEqual([]);
  });

  test("a valid state but a token exchange that returns no refresh_token fails closed (500), still stores nothing", async () => {
    const { account, calls } = fakeAccount({ consumeOAuthState: () => ({ valid: true, allowReplace: false }) });

    const result = await handleOAuthCallback(
      { code: "auth-code", state: "valid-state", error: null },
      CONFIG,
      account,
      async () =>
        new Response(JSON.stringify({ access_token: "at", expires_in: 3600, token_type: "Bearer" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    expect(result.status).toBe(500);
    expect(calls.storeInitialTokens).toEqual([]);
  });
});

describe("handleOAuthAuthorize — staged scope (AuthorizeOptions.scope)", () => {
  test("options.scope is threaded into the authorization URL's scope param", async () => {
    const { account } = fakeAccount();

    const result = await handleOAuthAuthorize(CONFIG, account, { scope: scopeForStage("gmail_readonly") });

    const url = new URL(result.location);
    expect(url.searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);
  });

  test("omitting options.scope falls back to buildAuthorizationUrl's default (calendar.events)", async () => {
    const { account } = fakeAccount();

    const result = await handleOAuthAuthorize(CONFIG, account);

    const url = new URL(result.location);
    expect(url.searchParams.get("scope")).toBe(CALENDAR_EVENTS_SCOPE);
  });

  test("reconnect and scope are independent — both are threaded through together", async () => {
    const { account, calls } = fakeAccount();

    const result = await handleOAuthAuthorize(CONFIG, account, {
      reconnect: true,
      scope: scopeForStage("gmail_readonly"),
    });

    expect(calls.beginOAuthState).toEqual([true]);
    expect(new URL(result.location).searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);
  });
});

describe("handleOAuthCallback — granted-scope pass-through to storeInitialTokens", () => {
  /** A fake that also records the 5th `grantedScopes` arg — kept separate
   *  from the file's main `fakeAccount()` helper (whose `calls.storeInitialTokens`
   *  tuple shape earlier tests already assert against exactly) so this
   *  addition can't perturb any pre-existing assertion. */
  function fakeAccountCapturingScope(overrides: {
    consumeOAuthState?: () => ConsumeOAuthStateResult;
    storeInitialTokens?: () => StoreInitialTokensResult;
  } = {}): { account: OAuthAccountStub; calls: { storeInitialTokens: Array<[string, string, number, boolean, string | undefined]> } } {
    const calls = { storeInitialTokens: [] as Array<[string, string, number, boolean, string | undefined]> };
    const account: OAuthAccountStub = {
      beginOAuthState: async () => "generated-state-token",
      consumeOAuthState: async () =>
        overrides.consumeOAuthState ? overrides.consumeOAuthState() : { valid: true, allowReplace: false },
      storeInitialTokens: async (accessToken, refreshToken, expiresIn, allowReplace, grantedScopes) => {
        calls.storeInitialTokens.push([accessToken, refreshToken, expiresIn, allowReplace, grantedScopes]);
        return overrides.storeInitialTokens ? overrides.storeInitialTokens() : { status: "stored" };
      },
    };
    return { account, calls };
  }

  test("Google's returned scope is passed through to storeInitialTokens's 5th argument", async () => {
    const { account, calls } = fakeAccountCapturingScope();

    const result = await handleOAuthCallback(
      { code: "auth-code", state: "valid-state", error: null },
      CONFIG,
      account,
      async () =>
        new Response(
          JSON.stringify({
            access_token: "at",
            expires_in: 3600,
            refresh_token: "rt",
            scope: GMAIL_READONLY_SCOPE,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    expect(result.status).toBe(200);
    expect(calls.storeInitialTokens).toEqual([["at", "rt", 3600, false, GMAIL_READONLY_SCOPE]]);
  });

  test("a NARROWER granted scope than requested (partial consent decline) still completes the callback successfully, without crashing", async () => {
    const { account, calls } = fakeAccountCapturingScope();

    // The authorize call would have requested a combined/incremental scope
    // set, but the token response only grants the calendar half — this
    // must not throw anywhere in the callback pipeline.
    const result = await handleOAuthCallback(
      { code: "auth-code", state: "valid-state", error: null },
      CONFIG,
      account,
      async () =>
        new Response(
          JSON.stringify({
            access_token: "at",
            expires_in: 3600,
            refresh_token: "rt",
            scope: CALENDAR_EVENTS_SCOPE,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    expect(result.status).toBe(200);
    expect(calls.storeInitialTokens).toEqual([["at", "rt", 3600, false, CALENDAR_EVENTS_SCOPE]]);
  });

  test("a token response with no scope field at all leaves the 5th argument undefined, not a crash", async () => {
    const { account, calls } = fakeAccountCapturingScope();

    const result = await handleOAuthCallback(
      { code: "auth-code", state: "valid-state", error: null },
      CONFIG,
      account,
      async () =>
        new Response(
          JSON.stringify({ access_token: "at", expires_in: 3600, refresh_token: "rt", token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    expect(result.status).toBe(200);
    expect(calls.storeInitialTokens).toEqual([["at", "rt", 3600, false, undefined]]);
  });
});

describe("handleOAuthCallback — no-silent-replace guard (Fix 2)", () => {
  test("storeInitialTokens reporting already-connected (no reconnect intent) is surfaced as 409, not 200", async () => {
    const { account, calls } = fakeAccount({
      consumeOAuthState: () => ({ valid: true, allowReplace: false }),
      storeInitialTokens: () => ({ status: "already-connected" }),
    });

    const result = await handleOAuthCallback(
      { code: "auth-code", state: "valid-state", error: null },
      CONFIG,
      account,
      successfulExchangeFetch(),
    );

    expect(result.status).toBe(409);
    expect(result.body.toLowerCase()).toContain("already connected");
    // storeInitialTokens WAS called (that's how we learn it's already
    // connected) — but with allowReplace: false, matching the state's flag.
    expect(calls.storeInitialTokens).toEqual([["at", "rt", 3600, false]]);
  });

  test("a state minted with allowReplace passes allowReplace: true through to storeInitialTokens, which then succeeds", async () => {
    const { account, calls } = fakeAccount({
      consumeOAuthState: () => ({ valid: true, allowReplace: true }),
      storeInitialTokens: () => ({ status: "stored" }),
    });

    const result = await handleOAuthCallback(
      { code: "auth-code", state: "reconnect-state", error: null },
      CONFIG,
      account,
      successfulExchangeFetch(),
    );

    expect(result.status).toBe(200);
    expect(calls.storeInitialTokens).toEqual([["at", "rt", 3600, true]]);
  });

  test("full authorize -> callback round trip: ?reconnect=true's allowReplace flag survives to storeInitialTokens", async () => {
    // Simulates the real flow end to end at the oauth-routes level: the
    // SAME in-memory "state store" both handlers share (a plain Map here,
    // GoogleAccountDO's SQLite oauth_state table in production) is what
    // carries allowReplace from authorize to callback — never a
    // client-supplied value on the callback request itself.
    const stateStore = new Map<string, boolean>();
    const account: OAuthAccountStub = {
      beginOAuthState: async (reconnect = false) => {
        const state = "shared-state-token";
        stateStore.set(state, reconnect);
        return state;
      },
      consumeOAuthState: async (state) => {
        const allowReplace = stateStore.get(state);
        stateStore.delete(state);
        return allowReplace === undefined ? { valid: false, allowReplace: false } : { valid: true, allowReplace };
      },
      storeInitialTokens: async (_at, _rt, _exp, allowReplace) => (allowReplace ? { status: "stored" } : { status: "already-connected" }),
    };

    const authorizeResult = await handleOAuthAuthorize(CONFIG, account, { reconnect: true });
    const state = new URL(authorizeResult.location).searchParams.get("state")!;

    const callbackResult = await handleOAuthCallback(
      { code: "auth-code", state, error: null },
      CONFIG,
      account,
      successfulExchangeFetch(),
    );

    expect(callbackResult.status).toBe(200);
  });
});
