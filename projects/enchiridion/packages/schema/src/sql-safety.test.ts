import { describe, expect, test } from "bun:test";
import { isSafeProjectionStatement, isValidProjectionViewName } from "./sql-safety";

describe("isValidProjectionViewName", () => {
  test("accepts graph_-prefixed snake_case names", () => {
    expect(isValidProjectionViewName("graph_workouts_v1")).toBe(true);
    expect(isValidProjectionViewName("graph_module_alpha_value_v1")).toBe(true);
  });

  test("rejects names without the graph_ prefix", () => {
    expect(isValidProjectionViewName("workouts")).toBe(false);
    expect(isValidProjectionViewName("graph")).toBe(false);
  });

  test("rejects uppercase, spaces, and punctuation", () => {
    expect(isValidProjectionViewName("graph_Workouts")).toBe(false);
    expect(isValidProjectionViewName("graph_workouts v1")).toBe(false);
    expect(isValidProjectionViewName("graph_workouts;drop")).toBe(false);
  });
});

describe("isSafeProjectionStatement", () => {
  test("accepts a plain single SELECT", () => {
    expect(isSafeProjectionStatement("SELECT 1 AS value")).toBe(true);
    expect(isSafeProjectionStatement("select node_id, title from graph_nodes")).toBe(true);
  });

  test("rejects empty/whitespace-only statements", () => {
    expect(isSafeProjectionStatement("")).toBe(false);
    expect(isSafeProjectionStatement("   ")).toBe(false);
  });

  test("rejects statements not leading with SELECT", () => {
    expect(isSafeProjectionStatement("DELETE FROM pages")).toBe(false);
    expect(isSafeProjectionStatement("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(false);
  });

  test("rejects a semicolon anywhere, including a stacked statement", () => {
    expect(isSafeProjectionStatement("SELECT 1; DELETE FROM pages")).toBe(false);
    expect(isSafeProjectionStatement("SELECT 1;")).toBe(false);
  });

  test("rejects line and block comments anywhere", () => {
    expect(isSafeProjectionStatement("SELECT 1 -- sneaky")).toBe(false);
    expect(isSafeProjectionStatement("SELECT 1 /* sneaky */")).toBe(false);
  });

  test("rejects write/DDL/attach/pragma keywords as whole words anywhere", () => {
    for (const keyword of ["insert", "update", "delete", "drop", "alter", "create", "attach", "pragma", "vacuum", "replace"]) {
      expect(isSafeProjectionStatement(`SELECT ${keyword} FROM graph_nodes`)).toBe(false);
    }
  });

  test("rejects a second SELECT (e.g. UNION) even without a semicolon", () => {
    expect(isSafeProjectionStatement("SELECT 1 UNION SELECT 2")).toBe(false);
  });

  test("does not false-positive on a keyword that's only a substring of an identifier", () => {
    // "selection" contains "select" as a substring but is tokenized as one
    // whole word distinct from "select" by the non-alphanumeric split.
    expect(isSafeProjectionStatement("SELECT selection_id FROM graph_nodes")).toBe(true);
  });
});
