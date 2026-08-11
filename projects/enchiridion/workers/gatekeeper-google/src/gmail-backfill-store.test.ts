import { describe, expect, test } from "bun:test";
import { initializeSchema } from "./schema";
import { getGmailBackfillState, setGmailBackfillState } from "./gmail-backfill-store";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

describe("gmail-backfill-store", () => {
  test("no row yet returns undefined", () => {
    const sql = makeSql();
    expect(getGmailBackfillState(sql)).toBeUndefined();
  });

  test("round-trips pageToken/completed/updatedAt", () => {
    const sql = makeSql();
    setGmailBackfillState(sql, { pageToken: "next-page-1", completed: false, updatedAt: 1000 });
    expect(getGmailBackfillState(sql)).toEqual({ pageToken: "next-page-1", completed: false, updatedAt: 1000 });
  });

  test("a second write upserts (single row, id = 1) rather than inserting a duplicate", () => {
    const sql = makeSql();
    setGmailBackfillState(sql, { pageToken: "page-1", completed: false, updatedAt: 1000 });
    setGmailBackfillState(sql, { pageToken: "page-2", completed: false, updatedAt: 2000 });
    expect(getGmailBackfillState(sql)).toEqual({ pageToken: "page-2", completed: false, updatedAt: 2000 });
  });

  test("pageToken: undefined writes NULL, clearing a previously-stored token (the re-baseline reset path)", () => {
    const sql = makeSql();
    setGmailBackfillState(sql, { pageToken: "page-1", completed: false, updatedAt: 1000 });
    setGmailBackfillState(sql, { pageToken: undefined, completed: false, updatedAt: 2000 });
    expect(getGmailBackfillState(sql)).toEqual({ pageToken: undefined, completed: false, updatedAt: 2000 });
  });

  test("completed flips to true once backfill exhausts pagination", () => {
    const sql = makeSql();
    setGmailBackfillState(sql, { pageToken: undefined, completed: true, updatedAt: 3000 });
    expect(getGmailBackfillState(sql)?.completed).toBe(true);
  });
});
