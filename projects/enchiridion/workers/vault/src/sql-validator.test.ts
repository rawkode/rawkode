import { describe, expect, test } from "bun:test";
import { PROJECTION_VIEW_NAMES } from "./schema";
import { validateBoundedQuery } from "./sql-validator";

const allowedSources = new Set<string>(PROJECTION_VIEW_NAMES);

function accepts(sql: string) {
  const result = validateBoundedQuery(sql, { allowedSources });
  expect(result.ok).toBe(true);
}

function rejects(sql: string, reasonIncludes?: string) {
  const result = validateBoundedQuery(sql, { allowedSources });
  expect(result.ok).toBe(false);
  if (!result.ok && reasonIncludes) {
    expect(result.reason).toContain(reasonIncludes);
  }
}

describe("validateBoundedQuery — accepted queries", () => {
  test("simple select over an allowlisted view", () => {
    accepts("SELECT node_id, title FROM graph_nodes WHERE kind = 'person'");
  });

  test("select with allowlisted function calls", () => {
    accepts("SELECT count(*), upper(title) FROM graph_nodes GROUP BY kind");
  });

  test("join across two allowlisted views", () => {
    accepts(
      "SELECT n.title, t.name FROM graph_nodes n JOIN graph_node_tags nt ON nt.node_id = n.node_id JOIN graph_tags t ON t.tag_id = nt.tag_id",
    );
  });

  test("comma-separated FROM list", () => {
    accepts("SELECT * FROM graph_nodes, graph_facts WHERE graph_facts.node_id = graph_nodes.node_id");
  });

  test("CTE referencing an allowlisted view, then queried by name", () => {
    accepts(
      "WITH recent AS (SELECT node_id FROM graph_nodes ORDER BY modified_at DESC LIMIT 10) SELECT * FROM recent",
    );
  });

  test("recursive CTE over the tag closure view", () => {
    accepts(
      "WITH RECURSIVE ancestors(tag_id) AS (SELECT tag_id FROM graph_tags WHERE tag_id = 'person' UNION SELECT parent_tag_id FROM graph_tag_parents, ancestors WHERE graph_tag_parents.tag_id = ancestors.tag_id) SELECT * FROM ancestors",
    );
  });

  test("FTS5 match query against the public virtual table", () => {
    accepts("SELECT node_id FROM graph_text_search WHERE graph_text_search MATCH 'hello'");
  });

  test("trailing semicolon is fine", () => {
    accepts("SELECT * FROM graph_nodes;");
  });

  test("trailing semicolons (plural) are fine", () => {
    accepts("SELECT * FROM graph_nodes;;;");
  });

  test("bind parameters are inert, not identifiers", () => {
    accepts("SELECT * FROM graph_nodes WHERE node_id = ?1 AND kind = :kind");
  });

  test("main. schema qualifier on an allowlisted view", () => {
    accepts("SELECT * FROM main.graph_nodes");
  });

  test("CAST/EXISTS/IN paren-keywords are not mistaken for function calls", () => {
    accepts(
      "SELECT CAST(node_id AS TEXT) FROM graph_nodes WHERE EXISTS (SELECT 1 FROM graph_facts WHERE graph_facts.node_id = graph_nodes.node_id) AND kind IN ('person', 'event')",
    );
  });

  test("a comment that is not adjacent to any statement boundary", () => {
    accepts("SELECT * FROM graph_nodes -- trailing line comment\n WHERE kind = 'person'");
  });
});

describe("validateBoundedQuery — rejected: non-SELECT/WITH statements", () => {
  test("empty query", () => rejects("   ", "empty"));
  test("INSERT", () => rejects("INSERT INTO graph_nodes (node_id) VALUES ('x')"));
  test("UPDATE", () => rejects("UPDATE graph_nodes SET title = 'x'"));
  test("DELETE", () => rejects("DELETE FROM graph_nodes"));
  test("DROP TABLE", () => rejects("DROP TABLE graph_nodes"));
  test("CREATE TABLE", () => rejects("CREATE TABLE evil (id TEXT)"));
  test("EXPLAIN prefix", () => rejects("EXPLAIN SELECT * FROM graph_nodes"));
});

describe("validateBoundedQuery — rejected: stacked statements", () => {
  test("classic stacked-statement injection", () => {
    rejects("SELECT * FROM graph_nodes; DROP TABLE graph_nodes", "multiple statements");
  });

  test("stacked statement disguised with a trailing comment on the first", () => {
    rejects("SELECT * FROM graph_nodes; -- comment\nDROP TABLE graph_nodes", "multiple statements");
  });

  test("semicolon hidden inside a string literal is NOT a stacked statement", () => {
    accepts("SELECT * FROM graph_nodes WHERE title = 'a; DROP TABLE graph_nodes'");
  });

  test("semicolon hidden inside a line comment is NOT a stacked statement", () => {
    accepts("SELECT * FROM graph_nodes -- ; DROP TABLE graph_nodes\n WHERE kind = 'person'");
  });

  test("semicolon hidden inside a block comment is NOT a stacked statement", () => {
    accepts("SELECT * FROM graph_nodes /* ; DROP TABLE graph_nodes */ WHERE kind = 'person'");
  });
});

describe("validateBoundedQuery — rejected: comment-injection bypass attempts", () => {
  test("block comment splicing SELECT and a forbidden keyword together", () => {
    rejects("SELECT/**/*, /**/ATTACH/**/DATABASE 'x' AS y FROM graph_nodes", "ATTACH");
  });

  test("unterminated block comment fails closed", () => {
    rejects("SELECT * FROM graph_nodes /* unterminated");
  });

  test("unterminated string literal fails closed", () => {
    rejects("SELECT * FROM graph_nodes WHERE title = 'unterminated");
  });
});

describe("validateBoundedQuery — rejected: PRAGMA / ATTACH / transaction control", () => {
  // These lead with the disallowed keyword, so they're actually rejected by
  // the "first token must be SELECT/WITH" check (§3) before the anywhere-
  // in-statement keyword scan (§4) even runs — still a correct rejection,
  // just via an earlier rule. See the "anywhere in the statement" tests
  // below for §4 exercised on its own.
  test("PRAGMA", () => rejects("PRAGMA table_info(graph_nodes)"));
  test("ATTACH DATABASE", () => rejects("ATTACH DATABASE 'x.db' AS x"));
  test("BEGIN", () => rejects("BEGIN"));

  test("bare pragma-shaped function name is not allowlisted", () => {
    rejects("SELECT pragma_table_info('graph_nodes')");
  });

  test("keyword hidden inside a WITH...AS body", () => {
    rejects("WITH x AS (SELECT 1) INSERT INTO graph_nodes VALUES (1)");
  });

  test("PRAGMA keyword appearing mid-statement (not leading) is still caught by the anywhere-scan", () => {
    rejects(
      "SELECT * FROM graph_nodes UNION SELECT * FROM graph_nodes WHERE PRAGMA = 1",
      "PRAGMA",
    );
  });

  test("ATTACH keyword appearing mid-statement (not leading) is still caught by the anywhere-scan", () => {
    rejects(
      "WITH x AS (SELECT 1) SELECT * FROM x WHERE 1 = 1 AND ATTACH = 2",
      "ATTACH",
    );
  });
});

describe("validateBoundedQuery — rejected: table/view access", () => {
  test("unknown table", () => {
    rejects("SELECT * FROM sqlite_master", 'access to table/view "sqlite_master"');
  });

  test("FTS5 shadow table referenced directly", () => {
    rejects("SELECT * FROM graph_text_search_data", "graph_text_search_data");
  });

  test("FTS5 shadow table referenced via a quoted identifier", () => {
    rejects('SELECT * FROM "graph_text_search_content"', "graph_text_search_content");
  });

  test("FTS5 shadow table referenced via a single-quoted string in FROM position", () => {
    rejects("SELECT * FROM 'graph_text_search_config'", "graph_text_search_config");
  });

  test("sqlite internal catalog table", () => {
    rejects("SELECT * FROM sqlite_schema");
  });

  test("a join pulling in an unauthorized table", () => {
    rejects("SELECT * FROM graph_nodes JOIN secrets ON secrets.node_id = graph_nodes.node_id", "secrets");
  });
});

describe("validateBoundedQuery — rejected: function calls", () => {
  test("load_extension", () => rejects("SELECT load_extension('evil.so')", "load_extension"));
  test("random unallowlisted function", () => rejects("SELECT zeroblob(1000000000)"));
});

describe("validateBoundedQuery — limits", () => {
  test("query exceeding the configured length cap is rejected", () => {
    const sql = `SELECT * FROM graph_nodes WHERE node_id = '${"a".repeat(200)}'`;
    const result = validateBoundedQuery(sql, { allowedSources, maximumSqlLength: 64 });
    expect(result.ok).toBe(false);
  });
});
