import { describe, expect, test } from "bun:test";
import { PROJECTION_VIEW_NAMES, initializeSchema } from "./schema";
import { BoundedQueryError, runBoundedQuery } from "./query-rpc";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

const allowedSources = new Set<string>(PROJECTION_VIEW_NAMES);

function seededSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  for (let i = 0; i < 5; i++) {
    sql.exec(
      "INSERT INTO graph_nodes (node_id, title, plain_text, kind, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
      `p${i}`,
      `Title ${i}`,
      `Body ${i}`,
      "free",
      i,
      i,
    );
  }
  return sql;
}

describe("runBoundedQuery — happy path", () => {
  test("returns columns and rows for an allowlisted query", () => {
    const sql = seededSql();
    const result = runBoundedQuery(sql, "SELECT node_id, title FROM graph_nodes ORDER BY node_id", [], {
      allowedSources,
    });
    expect(result.truncated).toBe(false);
    expect(result.columns).toEqual(["node_id", "title"]);
    expect(result.rows).toHaveLength(5);
    expect(result.rows[0]).toEqual(["p0", "Title 0"]);
  });

  test("positional bind parameters work", () => {
    const sql = seededSql();
    const result = runBoundedQuery(sql, "SELECT node_id FROM graph_nodes WHERE node_id = ?", ["p2"], {
      allowedSources,
    });
    expect(result.rows).toEqual([["p2"]]);
  });
});

describe("runBoundedQuery — rejects invalid queries before executing", () => {
  test("throws BoundedQueryError for a write statement", () => {
    const sql = seededSql();
    expect(() =>
      runBoundedQuery(sql, "DELETE FROM graph_nodes", [], { allowedSources }),
    ).toThrow(BoundedQueryError);
  });

  test("throws for a non-allowlisted physical table, even though it really exists in the db", () => {
    const sql = seededSql();
    expect(() =>
      runBoundedQuery(sql, "SELECT * FROM doc_snapshots", [], { allowedSources }),
    ).toThrow(BoundedQueryError);
  });

  test("throws for stacked statements rather than silently running only the first", () => {
    const sql = seededSql();
    expect(() =>
      runBoundedQuery(sql, "SELECT * FROM graph_nodes; DELETE FROM graph_nodes", [], {
        allowedSources,
      }),
    ).toThrow(BoundedQueryError);

    // Prove the DELETE really never ran.
    const stillThere = runBoundedQuery(sql, "SELECT count(*) as n FROM graph_nodes", [], {
      allowedSources,
    });
    expect(stillThere.rows).toEqual([[5]]);
  });
});

describe("runBoundedQuery — row limit enforcement", () => {
  test("truncates and reports truncated: true once maximumRows is hit", () => {
    const sql = seededSql();
    const result = runBoundedQuery(sql, "SELECT node_id FROM graph_nodes ORDER BY node_id", [], {
      allowedSources,
      limits: { maximumRows: 2 },
    });
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rows).toEqual([["p0"], ["p1"]]);
  });

  test("does not truncate when the result fits under the row cap", () => {
    const sql = seededSql();
    const result = runBoundedQuery(sql, "SELECT node_id FROM graph_nodes", [], {
      allowedSources,
      limits: { maximumRows: 100 },
    });
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(5);
  });
});

describe("runBoundedQuery — byte limit enforcement", () => {
  test("truncates once the cumulative byte estimate exceeds maximumBytes, even though the row cap alone would allow more", () => {
    const sql = new SqliteStorageAdapter();
    initializeSchema(sql);
    // Each row's plain_text is ~500 chars (~1000 bytes at the estimator's
    // 2-bytes-per-char rate) — three of these exceed the smallest
    // configurable byte cap (1024, per sql-validator's LIMIT_BOUNDS) well
    // before a generous row cap would stop them.
    const big = "x".repeat(500);
    for (let i = 0; i < 10; i++) {
      sql.exec(
        "INSERT INTO graph_nodes (node_id, title, plain_text, kind, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
        `p${i}`,
        `Title ${i}`,
        big,
        "free",
        i,
        i,
      );
    }

    const result = runBoundedQuery(sql, "SELECT plain_text FROM graph_nodes ORDER BY node_id", [], {
      allowedSources,
      limits: { maximumBytes: 1024, maximumRows: 100 },
    });
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBeLessThan(10);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

describe("runBoundedQuery — engine-side LIMIT injection (bounds computation, not just the returned array)", () => {
  test("a WITH RECURSIVE CTE with no natural termination is bounded by the injected LIMIT and completes quickly", () => {
    const sql = seededSql();
    // No WHERE clause, no base-case cutoff — this recurses forever unless
    // something outside the query text itself stops it.
    const unboundedRecursion =
      "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt) SELECT x FROM cnt";

    const startedAt = performance.now();
    const result = runBoundedQuery(sql, unboundedRecursion, [], {
      allowedSources,
      limits: { maximumRows: 10 },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(10);
    expect(result.rows[0]).toEqual([1]);
    expect(result.rows[9]).toEqual([10]);
    // If the engine actually ran this to completion before truncating, this
    // test would hang/exhaust memory rather than complete in milliseconds.
    expect(elapsedMs).toBeLessThan(1000);
  });

  test("a query with its own smaller LIMIT still respects that smaller value (not widened to the cap)", () => {
    const sql = seededSql();
    const result = runBoundedQuery(sql, "SELECT node_id FROM graph_nodes ORDER BY node_id LIMIT 2", [], {
      allowedSources,
      limits: { maximumRows: 100 },
    });
    expect(result.truncated).toBe(false);
    expect(result.rows).toEqual([["p0"], ["p1"]]);
  });

  test("bind parameters still work through the injected wrapping", () => {
    const sql = seededSql();
    const result = runBoundedQuery(sql, "SELECT node_id FROM graph_nodes WHERE node_id = ? ORDER BY node_id", ["p3"], {
      allowedSources,
      limits: { maximumRows: 100 },
    });
    expect(result.rows).toEqual([["p3"]]);
  });
});
