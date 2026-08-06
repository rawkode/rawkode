// Plan P0 exit test (§Verification): "projection row queryable via a
// GraphQL query hitting vault's own /graphql endpoint directly." This file
// exercises the real Pothos schema (`./schema.ts`) with `graphql`'s own
// `graphql()` execution function — a real GraphQL query string, parsed,
// validated, and executed against the real schema — with `VaultAccessors`
// wired directly to `../query-accessors.ts`'s real SQL functions against a
// real (bun:sqlite-backed) `SqliteStorageAdapter` database, matching every
// other test file in this directory's "no mocks, real SQLite" convention
// (see `../test-helpers/sqlite-storage-adapter.ts`'s file header). This
// covers everything `./yoga.ts` would add on top (HTTP transport, resolving
// a DurableObjectStub) except the DO/Workers runtime itself, which — like
// `../vault-do.ts` — needs `wrangler dev` to exercise for real (see that
// file's header for why `bun test` can't drive it in this sandbox).

import { describe, expect, test } from "bun:test";
import { graphql } from "graphql";
import { getPage, listPages } from "../query-accessors";
import { initializeSchema } from "../schema";
import { SqliteStorageAdapter } from "../test-helpers/sqlite-storage-adapter";
import { schema, type VaultGraphQLContext } from "./schema";

function seededSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  const rows = [
    { id: "page_1", title: "First Page", kind: "note", createdAt: 1_000, modifiedAt: 2_000 },
    { id: "page_2", title: "Second Page", kind: "task", createdAt: 1_500, modifiedAt: 2_500 },
    { id: "page_3", title: "Third Page", kind: "note", createdAt: 1_750, modifiedAt: 2_750 },
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

/** Wires the schema's `VaultAccessors` context directly to
 *  `../query-accessors.ts`'s real functions — no VaultDO/DO-stub/RPC layer
 *  involved, matching what `./yoga.ts`'s `context()` does at request time,
 *  minus the DurableObjectStub indirection (which needs a live Workers
 *  runtime — see this file's header). */
function contextFor(sql: SqliteStorageAdapter): VaultGraphQLContext {
  return {
    vault: {
      getPage: async (id) => getPage(sql, id),
      listPages: async (options) => listPages(sql, options),
    },
  };
}

describe("vault GraphQL schema — Query.page", () => {
  test("resolves a real graph_nodes projection row end-to-end through a GraphQL query", async () => {
    const sql = seededSql();
    const result = await graphql({
      schema,
      source: `
        query {
          page(id: "page_1") {
            id
            kind
            title
            createdAt
            modifiedAt
          }
        }
      `,
      contextValue: contextFor(sql),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      page: {
        id: "page_1",
        kind: "note",
        title: "First Page",
        createdAt: 1_000,
        modifiedAt: 2_000,
      },
    });
  });

  test("returns null (not an error) for an id with no graph_nodes row", async () => {
    const sql = seededSql();
    const result = await graphql({
      schema,
      source: `query { page(id: "does-not-exist") { id } }`,
      contextValue: contextFor(sql),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ page: null });
  });

  test("exposes deletedAt as null for a non-deleted page", async () => {
    const sql = seededSql();
    const result = await graphql({
      schema,
      source: `query { page(id: "page_1") { deletedAt } }`,
      contextValue: contextFor(sql),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ page: { deletedAt: null } });
  });
});

describe("vault GraphQL schema — Query.pages", () => {
  test("lists pages ordered by id, honoring a limit and reporting nextCursor", async () => {
    const sql = seededSql();
    const result = await graphql({
      schema,
      source: `
        query {
          pages(limit: 2) {
            items { id title }
            nextCursor
          }
        }
      `,
      contextValue: contextFor(sql),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      pages: {
        items: [
          { id: "page_1", title: "First Page" },
          { id: "page_2", title: "Second Page" },
        ],
        nextCursor: "page_2",
      },
    });
  });

  test("cursor argument resumes strictly after the given page id", async () => {
    const sql = seededSql();
    const result = await graphql({
      schema,
      source: `
        query {
          pages(limit: 10, cursor: "page_2") {
            items { id }
            nextCursor
          }
        }
      `,
      contextValue: contextFor(sql),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      pages: { items: [{ id: "page_3" }], nextCursor: null },
    });
  });

  test("with no rows at all, returns an empty connection rather than erroring", async () => {
    const sql = new SqliteStorageAdapter();
    initializeSchema(sql);
    const result = await graphql({
      schema,
      source: `query { pages { items { id } nextCursor } }`,
      contextValue: contextFor(sql),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ pages: { items: [], nextCursor: null } });
  });
});
