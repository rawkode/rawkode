// token-refresh.test.ts — the core "getValidAccessToken()" contract this
// task's whole OAuth pass exists to deliver, per the task brief: "Write
// tests: token refresh logic (a token that's expired or near-expiry
// triggers a refresh call; a valid token doesn't), refresh failure handling
// ... don't silently loop-retry."
//
// `fetchImpl` fakes return real Google token-endpoint-shaped JSON (same
// convention as oauth-client.test.ts), and every test asserts BOTH the
// returned value/thrown error AND the number of times the fake was called
// — the "doesn't trigger a refresh" cases would pass on return value alone
// even if a refresh call were made and its result silently discarded, so
// call-count assertions are load-bearing here, not decorative.

import { describe, expect, test } from "bun:test";
import type { FetchLike } from "./oauth-client";
import { GoogleOAuthError } from "./oauth-client";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";
import { getStoredTokens, storeInitialTokens } from "./token-store";
import { GoogleAccountNotConnectedError, getValidAccessToken, REFRESH_SKEW_MS } from "./token-refresh";

const CONFIG = {
  clientId: "test-client-id.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUri: "https://gatekeeper-google.example.com/oauth/google/callback",
};

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function countingFetch(response: () => Response): { fetchImpl: FetchLike; callCount: () => number } {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return response();
  };
  return { fetchImpl, callCount: () => calls };
}

describe("getValidAccessToken — no refresh needed", () => {
  test("a token with plenty of life left (> REFRESH_SKEW_MS) is returned with zero network calls", async () => {
    const sql = makeSql();
    const now = 1_000_000;
    storeInitialTokens(sql, { accessToken: "at-still-valid", refreshToken: "rt", expiresIn: 3600 }, now);

    const { fetchImpl, callCount } = countingFetch(() => {
      throw new Error("should not be called");
    });

    const token = await getValidAccessToken({
      sql,
      config: CONFIG,
      now: now + 1000, // well within the 3600s expiry window
      fetchImpl,
    });

    expect(token).toBe("at-still-valid");
    expect(callCount()).toBe(0);
  });

  test("a token exactly REFRESH_SKEW_MS + 1ms from expiry is still considered valid (no refresh)", async () => {
    const sql = makeSql();
    const now = 1_000_000;
    storeInitialTokens(sql, { accessToken: "at-borderline-valid", refreshToken: "rt", expiresIn: 3600 }, now);
    const expiresAt = now + 3600 * 1000;

    const { fetchImpl, callCount } = countingFetch(() => {
      throw new Error("should not be called");
    });

    const token = await getValidAccessToken({
      sql,
      config: CONFIG,
      now: expiresAt - REFRESH_SKEW_MS - 1,
      fetchImpl,
    });

    expect(token).toBe("at-borderline-valid");
    expect(callCount()).toBe(0);
  });
});

describe("getValidAccessToken — refresh triggered", () => {
  test("a token within REFRESH_SKEW_MS of expiry triggers exactly one refresh call", async () => {
    const sql = makeSql();
    const now = 1_000_000;
    storeInitialTokens(sql, { accessToken: "at-near-expiry", refreshToken: "rt-1", expiresIn: 3600 }, now);
    const expiresAt = now + 3600 * 1000;

    const { fetchImpl, callCount } = countingFetch(() =>
      jsonResponse(200, { access_token: "at-refreshed", expires_in: 3600, token_type: "Bearer" }),
    );

    const token = await getValidAccessToken({
      sql,
      config: CONFIG,
      now: expiresAt - REFRESH_SKEW_MS + 1, // just inside the skew window
      fetchImpl,
    });

    expect(token).toBe("at-refreshed");
    expect(callCount()).toBe(1);
  });

  test("an already-expired token triggers exactly one refresh call", async () => {
    const sql = makeSql();
    const now = 1_000_000;
    storeInitialTokens(sql, { accessToken: "at-expired", refreshToken: "rt-1", expiresIn: 3600 }, now);
    const expiresAt = now + 3600 * 1000;

    const { fetchImpl, callCount } = countingFetch(() =>
      jsonResponse(200, { access_token: "at-refreshed", expires_in: 3600, token_type: "Bearer" }),
    );

    const token = await getValidAccessToken({ sql, config: CONFIG, now: expiresAt + 60_000, fetchImpl });

    expect(token).toBe("at-refreshed");
    expect(callCount()).toBe(1);
  });

  test("a successful refresh persists the new access token (and expiry) to storage", async () => {
    const sql = makeSql();
    const now = 1_000_000;
    storeInitialTokens(sql, { accessToken: "at-old", refreshToken: "rt-1", expiresIn: 3600 }, now);
    const expiresAt = now + 3600 * 1000;
    const refreshTime = expiresAt + 60_000;

    const { fetchImpl } = countingFetch(() =>
      jsonResponse(200, { access_token: "at-persisted", expires_in: 1800, token_type: "Bearer" }),
    );

    await getValidAccessToken({ sql, config: CONFIG, now: refreshTime, fetchImpl });

    // A second call right after, with no fetch available, must see the
    // PERSISTED refreshed token from storage, not just the return value of
    // the first call — proves the refresh path actually wrote through.
    const secondToken = await getValidAccessToken({
      sql,
      config: CONFIG,
      now: refreshTime + 1000, // now well within the fresh 1800s expiry
      fetchImpl: async () => {
        throw new Error("should not refresh again — the just-stored token is fresh");
      },
    });

    expect(secondToken).toBe("at-persisted");
  });

  test("a refresh response that rotates the refresh_token persists the new one", async () => {
    const sql = makeSql();
    const now = 1_000_000;
    storeInitialTokens(sql, { accessToken: "at-old", refreshToken: "rt-original", expiresIn: 3600 }, now);
    const expiresAt = now + 3600 * 1000;

    const { fetchImpl } = countingFetch(() =>
      jsonResponse(200, {
        access_token: "at-2",
        expires_in: 3600,
        refresh_token: "rt-rotated",
        token_type: "Bearer",
      }),
    );

    await getValidAccessToken({ sql, config: CONFIG, now: expiresAt + 1000, fetchImpl });

    let capturedRefreshToken = "";
    await getValidAccessToken({
      sql,
      config: CONFIG,
      now: expiresAt + 3600 * 1000 + 1000, // force a second refresh to inspect what refresh_token was sent
      fetchImpl: async (_url, init) => {
        capturedRefreshToken = new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "";
        return jsonResponse(200, { access_token: "at-3", expires_in: 3600, token_type: "Bearer" });
      },
    });

    expect(capturedRefreshToken).toBe("rt-rotated");
  });
});

describe("getValidAccessToken — refresh failure handling", () => {
  test("a revoked grant (invalid_grant) surfaces as GoogleOAuthError, not swallowed", async () => {
    const sql = makeSql();
    const now = 1_000_000;
    storeInitialTokens(sql, { accessToken: "at-old", refreshToken: "rt-revoked", expiresIn: 3600 }, now);
    const expiresAt = now + 3600 * 1000;

    const { fetchImpl, callCount } = countingFetch(() =>
      jsonResponse(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }),
    );

    let caught: unknown;
    try {
      await getValidAccessToken({ sql, config: CONFIG, now: expiresAt + 1000, fetchImpl });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GoogleOAuthError);
    expect((caught as GoogleOAuthError).code).toBe("invalid_grant");
    // Exactly one attempt — a revoked grant is not transient, so this must
    // NOT loop-retry against Google's token endpoint.
    expect(callCount()).toBe(1);
  });

  test("a refresh failure does not corrupt the stored (now-stale) token — it stays as before the attempt", async () => {
    const sql = makeSql();
    const now = 1_000_000;
    storeInitialTokens(sql, { accessToken: "at-old", refreshToken: "rt-revoked", expiresIn: 3600 }, now);
    const expiresAt = now + 3600 * 1000;

    const { fetchImpl } = countingFetch(() => jsonResponse(400, { error: "invalid_grant" }));

    await expect(getValidAccessToken({ sql, config: CONFIG, now: expiresAt + 1000, fetchImpl })).rejects.toThrow(
      GoogleOAuthError,
    );

    // storage was never updated by the failed attempt — updateAccessToken
    // is only called after a successful requestRefresh in token-refresh.ts.
    expect(getStoredTokens(sql)?.accessToken).toBe("at-old");
  });

  test("no stored credential at all throws GoogleAccountNotConnectedError, makes zero network calls", async () => {
    const sql = makeSql();
    const { fetchImpl, callCount } = countingFetch(() => {
      throw new Error("should not be called — nothing to refresh");
    });

    await expect(getValidAccessToken({ sql, config: CONFIG, now: Date.now(), fetchImpl })).rejects.toThrow(
      GoogleAccountNotConnectedError,
    );
    expect(callCount()).toBe(0);
  });

  test("a network-level failure (fetch rejects) propagates rather than being swallowed", async () => {
    const sql = makeSql();
    const now = 1_000_000;
    storeInitialTokens(sql, { accessToken: "at-old", refreshToken: "rt", expiresIn: 3600 }, now);
    const expiresAt = now + 3600 * 1000;

    const fetchImpl: FetchLike = async () => {
      throw new Error("simulated network failure");
    };

    await expect(getValidAccessToken({ sql, config: CONFIG, now: expiresAt + 1000, fetchImpl })).rejects.toThrow(
      "simulated network failure",
    );
  });
});

// ── Risk #15: concurrent-refresh race — genuinely closed, not relocated ──
//
// Reproduces the REAL shape of the bug: `calendar-ingest-cycle.ts`,
// `gmail-ingest-cycle.ts`, and `gmail-body-ingest-cycle.ts` each call
// `getValidAccessToken` independently, with their own fresh `deps` object,
// but sharing the SAME `sql` (one `GoogleAccountDO` instance's storage).
// These tests use REAL concurrent calls (`Promise.all` over overlapping
// `getValidAccessToken` invocations), not sequential calls dressed up to
// look concurrent — matching this project's established rigor for proving
// a race is closed (e.g. task #90's TaskWriteService CAS test used real
// `async let`/`withTaskGroup` races). A fake `fetchImpl` with a real
// artificial delay (`setTimeout`) widens the interleaving window so the
// test would reliably FAIL (assert more than one network call, or a lost
// update) against the pre-migration implementation, which had no lock at
// all — every one of these racing calls would have independently decided
// to refresh.
describe("getValidAccessToken — concurrent-refresh race (Risk #15) is genuinely closed", () => {
  test("N concurrent callers with the same near-expiry token trigger exactly ONE network refresh call, and all N resolve to the same refreshed token", async () => {
    const sql = makeSql();
    const now = 1_000_000;
    storeInitialTokens(sql, { accessToken: "at-old", refreshToken: "rt-1", expiresIn: 3600 }, now);
    const expiresAt = now + 3600 * 1000;
    const refreshMoment = expiresAt + 1000; // past expiry — every caller needs a refresh

    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      // Real artificial delay — widens the window during which OTHER
      // concurrent callers are in-flight, so this test actually exercises
      // interleaving rather than accidentally running sequentially.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse(200, { access_token: "at-refreshed-once", expires_in: 3600, token_type: "Bearer" });
    };

    const CONCURRENT_CALLERS = 5;
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_CALLERS }, () =>
        getValidAccessToken({ sql, config: CONFIG, now: refreshMoment, fetchImpl }),
      ),
    );

    // The whole point: however many callers raced in, Google's token
    // endpoint was hit exactly once — not up to CONCURRENT_CALLERS times.
    expect(calls).toBe(1);
    for (const result of results) {
      expect(result).toBe("at-refreshed-once");
    }
    // Storage reflects the single winning refresh, not a partially-applied
    // or corrupted mix of concurrent writes.
    expect(getStoredTokens(sql)?.accessToken).toBe("at-refreshed-once");
  });

  test("a caller that loses the race observes the WINNER's freshly-persisted token, never sends the winner's now-superseded refresh_token to Google itself", async () => {
    const sql = makeSql();
    const now = 1_000_000;
    storeInitialTokens(sql, { accessToken: "at-old", refreshToken: "rt-original", expiresIn: 3600 }, now);
    const expiresAt = now + 3600 * 1000;
    const refreshMoment = expiresAt + 1000;

    const sentRefreshTokens: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const sent = new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "";
      sentRefreshTokens.push(sent);
      await new Promise((resolve) => setTimeout(resolve, 15));
      return jsonResponse(200, { access_token: "at-2", expires_in: 3600, token_type: "Bearer" });
    };

    await Promise.all([
      getValidAccessToken({ sql, config: CONFIG, now: refreshMoment, fetchImpl }),
      getValidAccessToken({ sql, config: CONFIG, now: refreshMoment, fetchImpl }),
      getValidAccessToken({ sql, config: CONFIG, now: refreshMoment, fetchImpl }),
    ]);

    // Only ONE request ever reached Google, and it carried the original
    // (not-yet-spent) refresh token — no racing caller sent a second,
    // now-stale copy of it (which is exactly what would happen if
    // rotation were ever enabled and this race weren't closed: the loser
    // would send an already-spent refresh_token and get invalid_grant).
    expect(sentRefreshTokens).toEqual(["rt-original"]);
  });

  test("two DIFFERENT sessions (distinct SqlExecutor instances, i.e. distinct GoogleAccountDO instances) refresh independently, NOT serialized against each other", async () => {
    const sqlA = makeSql();
    const sqlB = makeSql();
    const now = 1_000_000;
    storeInitialTokens(sqlA, { accessToken: "at-old-a", refreshToken: "rt-a", expiresIn: 3600 }, now);
    storeInitialTokens(sqlB, { accessToken: "at-old-b", refreshToken: "rt-b", expiresIn: 3600 }, now);
    const expiresAt = now + 3600 * 1000;
    const refreshMoment = expiresAt + 1000;

    const order: string[] = [];
    const fetchImplFor = (label: string, delayMs: number): FetchLike => async () => {
      order.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(`${label}:end`);
      return jsonResponse(200, { access_token: `at-refreshed-${label}`, expires_in: 3600, token_type: "Bearer" });
    };

    // A is deliberately slower than B — if sessions were wrongly sharing
    // one global lock, B (a different account's DO) would be blocked
    // until A's slow refresh finished, so B's "end" would never appear
    // before A's "end". With independent per-session locks, B finishes
    // first despite starting after A.
    const [tokenA, tokenB] = await Promise.all([
      getValidAccessToken({ sql: sqlA, config: CONFIG, now: refreshMoment, fetchImpl: fetchImplFor("a", 40) }),
      getValidAccessToken({ sql: sqlB, config: CONFIG, now: refreshMoment, fetchImpl: fetchImplFor("b", 5) }),
    ]);

    expect(tokenA).toBe("at-refreshed-a");
    expect(tokenB).toBe("at-refreshed-b");
    expect(order.indexOf("b:end")).toBeLessThan(order.indexOf("a:end"));
  });
});
