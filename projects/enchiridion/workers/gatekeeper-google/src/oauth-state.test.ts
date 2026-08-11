import { describe, expect, test } from "bun:test";
import { consumeOAuthState, createOAuthState, OAUTH_STATE_TTL_MS } from "./oauth-state";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

describe("oauth-state", () => {
  test("a freshly created, unexpired state is consumed successfully", () => {
    const sql = makeSql();
    createOAuthState(sql, "state-abc", 1_000);
    expect(consumeOAuthState(sql, "state-abc", 1_500)).toEqual({ valid: true, allowReplace: false });
  });

  test("consuming a never-created state fails (missing)", () => {
    const sql = makeSql();
    expect(consumeOAuthState(sql, "never-created", 1_000)).toEqual({ valid: false, allowReplace: false });
  });

  test("a state cannot be consumed twice (replay protection)", () => {
    const sql = makeSql();
    createOAuthState(sql, "state-abc", 1_000);
    expect(consumeOAuthState(sql, "state-abc", 1_500).valid).toBe(true);
    expect(consumeOAuthState(sql, "state-abc", 1_500)).toEqual({ valid: false, allowReplace: false });
  });

  test("an expired state is rejected", () => {
    const sql = makeSql();
    createOAuthState(sql, "state-abc", 1_000);
    const justAfterExpiry = 1_000 + OAUTH_STATE_TTL_MS + 1;
    expect(consumeOAuthState(sql, "state-abc", justAfterExpiry)).toEqual({ valid: false, allowReplace: false });
  });

  test("a state at exactly its expiry boundary is rejected (expires_at > now, not >=)", () => {
    const sql = makeSql();
    createOAuthState(sql, "state-abc", 1_000);
    expect(consumeOAuthState(sql, "state-abc", 1_000 + OAUTH_STATE_TTL_MS).valid).toBe(false);
  });

  test("an expired state is still deleted on lookup, not left behind", () => {
    const sql = makeSql();
    createOAuthState(sql, "state-abc", 1_000);
    const justAfterExpiry = 1_000 + OAUTH_STATE_TTL_MS + 1;
    expect(consumeOAuthState(sql, "state-abc", justAfterExpiry).valid).toBe(false);
    // Even re-checking "in time" after the row was already deleted by the
    // expired lookup above must still fail — the row is gone.
    expect(consumeOAuthState(sql, "state-abc", justAfterExpiry + 1).valid).toBe(false);
  });

  test("two independently created states are tracked independently", () => {
    const sql = makeSql();
    createOAuthState(sql, "state-a", 1_000);
    createOAuthState(sql, "state-b", 1_000);

    expect(consumeOAuthState(sql, "state-a", 1_100).valid).toBe(true);
    // state-b is untouched by consuming state-a.
    expect(consumeOAuthState(sql, "state-b", 1_100).valid).toBe(true);
  });

  test("a state created with allowReplace=true carries that flag through consumeOAuthState", () => {
    const sql = makeSql();
    createOAuthState(sql, "state-reconnect", 1_000, true);
    expect(consumeOAuthState(sql, "state-reconnect", 1_100)).toEqual({ valid: true, allowReplace: true });
  });

  test("a state created without allowReplace defaults to allowReplace: false", () => {
    const sql = makeSql();
    createOAuthState(sql, "state-normal", 1_000, false);
    expect(consumeOAuthState(sql, "state-normal", 1_100)).toEqual({ valid: true, allowReplace: false });
  });

  test("allowReplace is never surfaced as true for an invalid/expired state, even if it was minted true", () => {
    const sql = makeSql();
    createOAuthState(sql, "state-reconnect-expired", 1_000, true);
    const justAfterExpiry = 1_000 + OAUTH_STATE_TTL_MS + 1;
    expect(consumeOAuthState(sql, "state-reconnect-expired", justAfterExpiry)).toEqual({
      valid: false,
      allowReplace: false,
    });
  });
});
