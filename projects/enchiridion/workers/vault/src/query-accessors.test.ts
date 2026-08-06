import { describe, expect, test } from "bun:test";
import { getPage, getPages, listPages } from "./query-accessors";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function seededSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  const rows = [
    { id: "page_1", title: "First Page", kind: "note", createdAt: 1000, modifiedAt: 2000 },
    { id: "page_2", title: "Second Page", kind: "task", createdAt: 1500, modifiedAt: 2500 },
    { id: "page_3", title: "Third Page", kind: "note", createdAt: 1750, modifiedAt: 2750 },
  ];
  for (const row of rows) {
    sql.exec(
      "INSERT INTO graph_nodes (node_id, title, plain_text, kind, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
      row.id,
      row.title,
      "",
      row.kind,
      row.createdAt,
      row.modifiedAt,
    );
  }
  return sql;
}

describe("getPage", () => {
  test("returns the projected row for a known page", () => {
    const sql = seededSql();
    expect(getPage(sql, "page_1")).toEqual({
      id: "page_1",
      kind: "note",
      title: "First Page",
      createdAt: 1000,
      modifiedAt: 2000,
      deletedAt: null,
    });
  });

  test("returns undefined for an unknown page id", () => {
    const sql = seededSql();
    expect(getPage(sql, "does-not-exist")).toBeUndefined();
  });
});

describe("getPages", () => {
  test("returns a batched lookup for multiple ids in one call", () => {
    const sql = seededSql();
    const rows = getPages(sql, ["page_1", "page_3"]);
    expect(rows.map((r) => r.id).sort()).toEqual(["page_1", "page_3"]);
  });

  test("silently omits unknown ids rather than erroring", () => {
    const sql = seededSql();
    const rows = getPages(sql, ["page_1", "does-not-exist"]);
    expect(rows.map((r) => r.id)).toEqual(["page_1"]);
  });

  test("returns an empty array for an empty id list without querying", () => {
    const sql = seededSql();
    expect(getPages(sql, [])).toEqual([]);
  });
});

describe("listPages", () => {
  test("lists all pages ordered by node_id when under the limit", () => {
    const sql = seededSql();
    const result = listPages(sql);
    expect(result.items.map((r) => r.id)).toEqual(["page_1", "page_2", "page_3"]);
    expect(result.nextCursor).toBeNull();
  });

  test("honors limit and reports a nextCursor when more rows exist", () => {
    const sql = seededSql();
    const result = listPages(sql, { limit: 2 });
    expect(result.items.map((r) => r.id)).toEqual(["page_1", "page_2"]);
    expect(result.nextCursor).toBe("page_2");
  });

  test("cursor resumes strictly after the given page id", () => {
    const sql = seededSql();
    const result = listPages(sql, { cursor: "page_2" });
    expect(result.items.map((r) => r.id)).toEqual(["page_3"]);
    expect(result.nextCursor).toBeNull();
  });

  test("excludes soft-deleted rows by default", () => {
    const sql = seededSql();
    sql.exec("UPDATE graph_nodes SET deleted_at = ? WHERE node_id = ?", 9999, "page_2");
    const result = listPages(sql);
    expect(result.items.map((r) => r.id)).toEqual(["page_1", "page_3"]);
  });

  test("includeDeleted: true includes soft-deleted rows", () => {
    const sql = seededSql();
    sql.exec("UPDATE graph_nodes SET deleted_at = ? WHERE node_id = ?", 9999, "page_2");
    const result = listPages(sql, { includeDeleted: true });
    expect(result.items.map((r) => r.id)).toEqual(["page_1", "page_2", "page_3"]);
  });

  test("clamps an excessive limit to the maximum", () => {
    const sql = seededSql();
    const result = listPages(sql, { limit: 10_000 });
    expect(result.items).toHaveLength(3);
    expect(result.nextCursor).toBeNull();
  });
});
