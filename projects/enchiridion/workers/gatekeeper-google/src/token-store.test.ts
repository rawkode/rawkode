import { describe, expect, test } from "bun:test";
import { CALENDAR_EVENTS_SCOPE, GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from "./oauth-client";
import { initializeSchema } from "./schema";
import {
  deleteStoredTokens,
  getGrantedScopes,
  getStoredTokens,
  getSyncCursor,
  hasGrantedScope,
  setSyncCursor,
  storeInitialTokens,
  updateAccessToken,
} from "./token-store";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

describe("token-store — oauth_tokens", () => {
  test("getStoredTokens returns undefined before any tokens are stored", () => {
    const sql = makeSql();
    expect(getStoredTokens(sql)).toBeUndefined();
  });

  test("storeInitialTokens persists a row readable by getStoredTokens", () => {
    const sql = makeSql();
    storeInitialTokens(sql, { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 }, 1_000);

    const stored = getStoredTokens(sql);
    expect(stored).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 1_000 + 3600 * 1000,
      updatedAt: 1_000,
    });
  });

  test("storeInitialTokens returns {status: 'stored'} on first connection", () => {
    const sql = makeSql();
    const result = storeInitialTokens(sql, { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 }, 1_000);
    expect(result).toEqual({ status: "stored" });
  });

  test("storeInitialTokens called again WITHOUT allowReplace is refused (Fix 2: no silent replace)", () => {
    const sql = makeSql();
    storeInitialTokens(sql, { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 }, 1_000);
    const result = storeInitialTokens(sql, { accessToken: "at-2", refreshToken: "rt-2", expiresIn: 7200 }, 2_000);

    expect(result).toEqual({ status: "already-connected" });
    // The original credential is untouched — no partial/silent write.
    const stored = getStoredTokens(sql);
    expect(stored).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 1_000 + 3600 * 1000,
      updatedAt: 1_000,
    });
  });

  test("storeInitialTokens called again WITH allowReplace: true replaces the prior credential", () => {
    const sql = makeSql();
    storeInitialTokens(sql, { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 }, 1_000);
    const result = storeInitialTokens(
      sql,
      { accessToken: "at-2", refreshToken: "rt-2", expiresIn: 7200 },
      2_000,
      { allowReplace: true },
    );

    expect(result).toEqual({ status: "stored" });
    const stored = getStoredTokens(sql);
    expect(stored).toEqual({
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: 2_000 + 7200 * 1000,
      updatedAt: 2_000,
    });
  });

  test("allowReplace: true on a FIRST connection (nothing to replace yet) still just stores normally", () => {
    const sql = makeSql();
    const result = storeInitialTokens(
      sql,
      { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 },
      1_000,
      { allowReplace: true },
    );
    expect(result).toEqual({ status: "stored" });
    expect(getStoredTokens(sql)?.accessToken).toBe("at-1");
  });

  test("deleteStoredTokens clears the row, allowing a subsequent storeInitialTokens WITHOUT allowReplace to succeed", () => {
    const sql = makeSql();
    storeInitialTokens(sql, { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 }, 1_000);
    deleteStoredTokens(sql);
    expect(getStoredTokens(sql)).toBeUndefined();

    const result = storeInitialTokens(sql, { accessToken: "at-2", refreshToken: "rt-2", expiresIn: 3600 }, 2_000);
    expect(result).toEqual({ status: "stored" });
    expect(getStoredTokens(sql)?.accessToken).toBe("at-2");
  });

  test("deleteStoredTokens on an already-disconnected account is a no-op, not an error", () => {
    const sql = makeSql();
    expect(() => deleteStoredTokens(sql)).not.toThrow();
    expect(getStoredTokens(sql)).toBeUndefined();
  });

  test("updateAccessToken with no refreshToken leaves the stored refresh_token untouched", () => {
    const sql = makeSql();
    storeInitialTokens(sql, { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 }, 1_000);
    updateAccessToken(sql, { accessToken: "at-2", expiresIn: 3600 }, 5_000);

    const stored = getStoredTokens(sql);
    expect(stored?.accessToken).toBe("at-2");
    expect(stored?.refreshToken).toBe("rt-1");
    expect(stored?.expiresAt).toBe(5_000 + 3600 * 1000);
    expect(stored?.updatedAt).toBe(5_000);
  });

  test("updateAccessToken with a new refreshToken (Google rotation) replaces it", () => {
    const sql = makeSql();
    storeInitialTokens(sql, { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 }, 1_000);
    updateAccessToken(sql, { accessToken: "at-2", refreshToken: "rt-2-rotated", expiresIn: 3600 }, 5_000);

    expect(getStoredTokens(sql)?.refreshToken).toBe("rt-2-rotated");
  });
});

describe("token-store — granted-scope tracking", () => {
  test("storeInitialTokens with grantedScopes persists it, readable via getStoredTokens", () => {
    const sql = makeSql();
    storeInitialTokens(
      sql,
      { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600, grantedScopes: CALENDAR_EVENTS_SCOPE },
      1_000,
    );
    expect(getStoredTokens(sql)?.grantedScopes).toBe(CALENDAR_EVENTS_SCOPE);
  });

  test("storeInitialTokens without grantedScopes leaves it undefined, not a crash or empty string", () => {
    const sql = makeSql();
    storeInitialTokens(sql, { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 }, 1_000);
    expect(getStoredTokens(sql)?.grantedScopes).toBeUndefined();
  });

  test("getGrantedScopes splits a space-delimited multi-scope string", () => {
    const sql = makeSql();
    storeInitialTokens(
      sql,
      {
        accessToken: "at-1",
        refreshToken: "rt-1",
        expiresIn: 3600,
        grantedScopes: `${CALENDAR_EVENTS_SCOPE} ${GMAIL_READONLY_SCOPE}`,
      },
      1_000,
    );
    expect(getGrantedScopes(sql)).toEqual([CALENDAR_EVENTS_SCOPE, GMAIL_READONLY_SCOPE]);
  });

  test("getGrantedScopes returns undefined when nothing is connected", () => {
    const sql = makeSql();
    expect(getGrantedScopes(sql)).toBeUndefined();
  });

  test("hasGrantedScope: no connection at all -> false for every scope", () => {
    const sql = makeSql();
    expect(hasGrantedScope(sql, CALENDAR_EVENTS_SCOPE)).toBe(false);
    expect(hasGrantedScope(sql, GMAIL_READONLY_SCOPE)).toBe(false);
  });

  test("hasGrantedScope: a connection with recorded scopes checks exact membership", () => {
    const sql = makeSql();
    storeInitialTokens(
      sql,
      {
        accessToken: "at-1",
        refreshToken: "rt-1",
        expiresIn: 3600,
        grantedScopes: `${CALENDAR_EVENTS_SCOPE} ${GMAIL_READONLY_SCOPE}`,
      },
      1_000,
    );
    expect(hasGrantedScope(sql, CALENDAR_EVENTS_SCOPE)).toBe(true);
    expect(hasGrantedScope(sql, GMAIL_READONLY_SCOPE)).toBe(true);
    expect(hasGrantedScope(sql, GMAIL_SEND_SCOPE)).toBe(false);
  });

  test("hasGrantedScope: a legacy connection with no recorded granted_scopes falls back to calendar-only", () => {
    const sql = makeSql();
    // Simulates a connection stored before scope tracking existed — no
    // grantedScopes passed at all, matching the pre-this-feature call
    // shape `storeInitialTokens(sql, {accessToken, refreshToken, expiresIn}, now)`.
    storeInitialTokens(sql, { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 }, 1_000);

    expect(hasGrantedScope(sql, CALENDAR_EVENTS_SCOPE)).toBe(true);
    expect(hasGrantedScope(sql, GMAIL_READONLY_SCOPE)).toBe(false);
    expect(hasGrantedScope(sql, GMAIL_SEND_SCOPE)).toBe(false);
  });

  test("a NARROWER granted-scope set than requested (partial consent decline) is stored and reported correctly, without crashing", () => {
    const sql = makeSql();
    // The caller intended to request calendar + gmail_readonly together
    // (e.g. via include_granted_scopes incremental auth), but the user's
    // token response only actually grants calendar — storeInitialTokens
    // must persist exactly that narrower value, not throw, and hasGrantedScope
    // must reflect it accurately (not the originally-requested set).
    expect(() =>
      storeInitialTokens(
        sql,
        { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600, grantedScopes: CALENDAR_EVENTS_SCOPE },
        1_000,
      ),
    ).not.toThrow();

    expect(hasGrantedScope(sql, CALENDAR_EVENTS_SCOPE)).toBe(true);
    expect(hasGrantedScope(sql, GMAIL_READONLY_SCOPE)).toBe(false);
    expect(getGrantedScopes(sql)).toEqual([CALENDAR_EVENTS_SCOPE]);
  });

  test("reconnecting (allowReplace) with an accumulated/wider scope set overwrites the prior value", () => {
    const sql = makeSql();
    storeInitialTokens(
      sql,
      { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600, grantedScopes: CALENDAR_EVENTS_SCOPE },
      1_000,
    );
    storeInitialTokens(
      sql,
      {
        accessToken: "at-2",
        refreshToken: "rt-2",
        expiresIn: 3600,
        grantedScopes: `${CALENDAR_EVENTS_SCOPE} ${GMAIL_READONLY_SCOPE}`,
      },
      2_000,
      { allowReplace: true },
    );

    expect(hasGrantedScope(sql, CALENDAR_EVENTS_SCOPE)).toBe(true);
    expect(hasGrantedScope(sql, GMAIL_READONLY_SCOPE)).toBe(true);
  });
});

describe("token-store — sync_cursors", () => {
  test("getSyncCursor returns undefined for an unset resource", () => {
    const sql = makeSql();
    expect(getSyncCursor(sql, "calendar")).toBeUndefined();
  });

  test("setSyncCursor then getSyncCursor round-trips", () => {
    const sql = makeSql();
    setSyncCursor(sql, "calendar", "sync-token-abc", 1_000);
    expect(getSyncCursor(sql, "calendar")).toBe("sync-token-abc");
  });

  test("setSyncCursor upserts — a later call for the same resource overwrites, not duplicates", () => {
    const sql = makeSql();
    setSyncCursor(sql, "calendar", "sync-token-1", 1_000);
    setSyncCursor(sql, "calendar", "sync-token-2", 2_000);
    expect(getSyncCursor(sql, "calendar")).toBe("sync-token-2");
  });

  test("different resources (calendar vs. a future gmail) are independent", () => {
    const sql = makeSql();
    setSyncCursor(sql, "calendar", "calendar-cursor", 1_000);
    setSyncCursor(sql, "gmail", "gmail-history-id", 1_000);

    expect(getSyncCursor(sql, "calendar")).toBe("calendar-cursor");
    expect(getSyncCursor(sql, "gmail")).toBe("gmail-history-id");
  });
});
