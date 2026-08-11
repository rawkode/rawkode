// schema.test.ts — DDL/migration coverage for schema.ts. Most of this
// worker's schema is exercised indirectly through token-store.test.ts /
// oauth-state.test.ts / etc. (real tables, real queries); this file covers
// what those don't: `initializeSchema`'s own idempotency, and the
// `granted_scopes` additive-column migration for a DO whose `oauth_tokens`
// table predates that column (see schema.ts's file header, point 1, and
// `addGrantedScopesColumnIfMissing`'s doc comment).

import { describe, expect, test } from "bun:test";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

describe("initializeSchema", () => {
  test("is safe to call twice in a row (idempotent CREATE TABLE + column migration)", () => {
    const sql = new SqliteStorageAdapter();
    expect(() => {
      initializeSchema(sql);
      initializeSchema(sql);
    }).not.toThrow();
  });

  test("a fresh DO's oauth_tokens table already has granted_scopes from CREATE TABLE", () => {
    const sql = new SqliteStorageAdapter();
    initializeSchema(sql);
    sql.exec(
      "INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, updated_at, granted_scopes) VALUES (1, 'at', 'rt', 1, 1, 'scope-a')",
    );
    const row = sql.exec<{ granted_scopes: string }>("SELECT granted_scopes FROM oauth_tokens WHERE id = 1").one();
    expect(row.granted_scopes).toBe("scope-a");
  });

  test("a pre-existing oauth_tokens table without granted_scopes (simulating a DO provisioned before this column existed) gets migrated in place, preserving its row", () => {
    const sql = new SqliteStorageAdapter();

    // Simulate the OLD schema shape directly — no `granted_scopes` column —
    // as if this DO had already run `initializeSchema` before that column
    // was added, and already has a real stored connection.
    sql.exec(
      `CREATE TABLE oauth_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    sql.exec(
      "INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, updated_at) VALUES (1, 'pre-existing-at', 'pre-existing-rt', 999, 999)",
    );

    // A subsequent DO wake calls initializeSchema again — must not throw,
    // and must add the missing column without touching the existing row.
    expect(() => initializeSchema(sql)).not.toThrow();

    const row = sql
      .exec<{ access_token: string; refresh_token: string; granted_scopes: string | null }>(
        "SELECT access_token, refresh_token, granted_scopes FROM oauth_tokens WHERE id = 1",
      )
      .one();
    expect(row.access_token).toBe("pre-existing-at");
    expect(row.refresh_token).toBe("pre-existing-rt");
    expect(row.granted_scopes).toBeNull();

    // The migrated table now accepts writes to the new column too.
    sql.exec("UPDATE oauth_tokens SET granted_scopes = 'newly-migrated-scope' WHERE id = 1");
    const updated = sql
      .exec<{ granted_scopes: string | null }>("SELECT granted_scopes FROM oauth_tokens WHERE id = 1")
      .one();
    expect(updated.granted_scopes).toBe("newly-migrated-scope");
  });

  test("a fresh DO's pending_approvals table already has provider_message_id from CREATE TABLE (Fix 2)", () => {
    const sql = new SqliteStorageAdapter();
    initializeSchema(sql);
    sql.exec(
      "INSERT INTO pending_approvals (id, action_type, payload, version_token, status, result, created_at, updated_at, provider_message_id) VALUES ('a1', 'sendEmail', '{}', 'vt', 'pending', NULL, 1, 1, '<msg-1@example>')",
    );
    const row = sql
      .exec<{ provider_message_id: string }>("SELECT provider_message_id FROM pending_approvals WHERE id = 'a1'")
      .one();
    expect(row.provider_message_id).toBe("<msg-1@example>");
  });

  test("a pre-existing pending_approvals table without provider_message_id (simulating a DO provisioned before Fix 2) gets migrated in place, preserving its row", () => {
    const sql = new SqliteStorageAdapter();

    sql.exec(
      `CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        version_token TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    sql.exec(
      "INSERT INTO pending_approvals (id, action_type, payload, version_token, status, result, created_at, updated_at) VALUES ('a1', 'createEvent', '{}', 'vt', 'pending', NULL, 1, 1)",
    );

    expect(() => initializeSchema(sql)).not.toThrow();

    const row = sql
      .exec<{ id: string; provider_message_id: string | null }>(
        "SELECT id, provider_message_id FROM pending_approvals WHERE id = 'a1'",
      )
      .one();
    expect(row.id).toBe("a1");
    expect(row.provider_message_id).toBeNull();
  });
});
