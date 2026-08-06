// schema.test.ts — DDL/migration coverage for schema.ts. Most of this
// worker's schema is exercised indirectly through the many other test
// files that call `initializeSchema` as fixture setup (projection.test.ts,
// supertag-accessors.test.ts, etc.); this file covers what those don't:
// `initializeSchema`'s own idempotency, and the `person_visibility`/
// `person_origin` additive-column migration for a DO whose `graph_nodes`
// table predates those columns (the P4 privacy-gate fix — see schema.ts's
// DDL comment on `graph_nodes` and `addPersonVisibilityColumnsIfMissing`'s
// doc comment). Mirrors `workers/gatekeeper-google/src/schema.test.ts`'s
// `granted_scopes` migration test one-for-one — same guarded-`ALTER TABLE`
// pattern, same reason to test it explicitly rather than only indirectly.

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

  test("a fresh DO's graph_nodes table already has person_visibility/person_origin from CREATE TABLE", () => {
    const sql = new SqliteStorageAdapter();
    initializeSchema(sql);
    sql.exec(
      `INSERT INTO graph_nodes (node_id, title, plain_text, kind, created_at, modified_at, person_visibility, person_origin)
       VALUES ('person_1', 'attendee@example.com', '', 'person', 1, 1, 'other', 'calendarAttendee')`,
    );
    const row = sql
      .exec<{ person_visibility: string; person_origin: string }>(
        "SELECT person_visibility, person_origin FROM graph_nodes WHERE node_id = 'person_1'",
      )
      .one();
    expect(row.person_visibility).toBe("other");
    expect(row.person_origin).toBe("calendarAttendee");
  });

  test("a pre-existing graph_nodes table without person_visibility/person_origin (simulating a DO provisioned before this pass) gets migrated in place, preserving its rows", () => {
    const sql = new SqliteStorageAdapter();

    // Simulate the OLD schema shape directly — no privacy-gate columns —
    // as if this DO had already run `initializeSchema` before this pass,
    // and already has real projected rows.
    sql.exec(
      `CREATE TABLE graph_nodes (
        node_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        plain_text TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        deleted_at INTEGER,
        is_pinned INTEGER NOT NULL DEFAULT 0
      )`,
    );
    sql.exec(
      `INSERT INTO graph_nodes (node_id, title, plain_text, kind, created_at, modified_at)
       VALUES ('page_1', 'Pre-existing Page', 'body', 'free', 999, 999)`,
    );

    // A subsequent DO wake calls initializeSchema again — must not throw,
    // and must add the missing columns without touching the existing row.
    expect(() => initializeSchema(sql)).not.toThrow();

    const row = sql
      .exec<{ title: string; person_visibility: string | null; person_origin: string | null }>(
        "SELECT title, person_visibility, person_origin FROM graph_nodes WHERE node_id = 'page_1'",
      )
      .one();
    expect(row.title).toBe("Pre-existing Page");
    expect(row.person_visibility).toBeNull();
    expect(row.person_origin).toBeNull();

    // The migrated table now accepts writes to the new columns too.
    sql.exec("UPDATE graph_nodes SET person_visibility = 'other', person_origin = 'calendarAttendee' WHERE node_id = 'page_1'");
    const updated = sql
      .exec<{ person_visibility: string | null }>("SELECT person_visibility FROM graph_nodes WHERE node_id = 'page_1'")
      .one();
    expect(updated.person_visibility).toBe("other");
  });
});
