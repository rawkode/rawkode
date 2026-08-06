// @enchiridion/worker-vault — bounded query RPC.
//
// Plan §Backend architecture, "Bounded query surface": "one RPC
// `vault.query(sql, args, limits)` — single read-only statement,
// view/function allowlists, row/byte/time limits. Shared substrate for
// GraphQL resolvers, the assistant, and gadget `graph.query` capabilities
// (each with its own view allowlist)."
//
// Validation is `sql-validator.ts` (lexical — read that file's header
// before assuming this function is a sandbox boundary; it is not). This
// module is the execution side: run the validated statement against the
// DO's `SqlExecutor`, enforce row/byte caps while iterating, and report
// `truncated` honestly rather than silently dropping rows.
//
// TIMING LIMIT — documented gap, not an oversight: `GraphSQLExecutor.swift`
// installs `sqlite3_progress_handler`, a callback SQLite itself invokes
// periodically *during* query execution, letting the Swift original abort
// a runaway query mid-flight (`GraphQueryError.interrupted`). DO SQLite's
// `SqlStorage.exec()` is a single synchronous call with no equivalent hook
// exposed to JS — once `exec()` is called there is no way for this module
// to interrupt it before it returns. `maximumDurationMs` is therefore
// enforced AFTER THE FACT: if wall-clock time from just before `exec()` to
// just after exceeds the budget, the result is reported as `truncated:
// true` with `elapsedMs` populated so a caller can see it ran long, but
// the query has already fully executed by the time that's known. This is
// meaningfully weaker than the Swift original and is called out in the
// task report; the mitigation is the same one `sql-validator.ts` leans on
// (row/byte caps bound the result size the query CAN return, and the
// validator's view allowlist bounds what tables/indexes are even reachable
// — a runaway full scan of `graph_nodes` is bounded by vault size, not
// user input, at single-vault-per-DO scale).
//
// LIMIT INJECTION — why the row cap must be enforced INSIDE the SQL, not
// just by the JS loop below: SQLite (and bun:sqlite, the test double)
// execute a query to completion — building/streaming every row the
// query plan produces — before this module's row-counting loop ever gets
// a chance to `break`. For an ordinary `SELECT * FROM graph_nodes`, that's
// fine (bounded by vault size). But `sql-validator.ts` legally allows a
// `WITH RECURSIVE` CTE with no natural termination condition (rejecting it
// would mean rejecting every legitimate bounded-depth traversal query too
// — the validator has no way to distinguish "recurses forever" from
// "recurses until it hits a WHERE clause" from text alone). Without an
// engine-side cap, such a query does unbounded work — computed, not just
// returned — before the JS truncation loop ever runs.
//
// Fix: after validation confirms `sql` is a safe bare SELECT/WITH-SELECT
// (never before — wrapping arbitrary unvalidated text would be a real
// injection risk), wrap it as `SELECT * FROM (<validated sql>) AS
// __enchiridion_bounded_query LIMIT <maximumRows + 1>` and execute THAT.
// Verified empirically against bun:sqlite (the same SQLite engine family
// DO SQLite is built on): SQLite evaluates a FROM-clause subquery lazily
// (pull-based, one row at a time) when it isn't forced to materialize —
// wrapping a `WITH RECURSIVE ... SELECT x FROM cnt` (no termination
// condition) this way still only computes exactly `maximumRows + 1` rows
// of the infinite recursion, not the query's own naive "recurse forever"
// shape, completing in under a millisecond rather than hanging/exhausting
// memory.
//
// This wrapping approach was chosen over parsing the query text for an
// existing `LIMIT ... ` clause and comparing its numeric value (the other
// option floated for this fix) because it gets the "respect an existing,
// smaller LIMIT" behavior for free and exactly, with no text-parsing risk:
// if the validated query already has its own `LIMIT 3`, the *inner* LIMIT
// still runs first and produces at most 3 rows; the *outer*
// `LIMIT (maximumRows + 1)` then has nothing further to cut, so the
// effective bound is `min(existing LIMIT, maximumRows + 1)` — the "take
// the minimum of the two" behavior the task called out — without this
// module ever needing to know the existing LIMIT's value. Verified
// empirically too (see `query-rpc.test.ts`).
//
// One text-shape gotcha this wrapping has to handle explicitly: a
// validated query may carry a single OPTIONAL trailing `;`
// (`sql-validator.ts` allows at most one, and only trailing) — that has to
// be stripped before wrapping, or `SELECT * FROM (SELECT 1;) AS x LIMIT 5`
// is a syntax error.

import type { SqlCursor, SqlExecutor } from "./schema";
import { normalizeLimits, type SqlQueryLimits, validateBoundedQuery } from "./sql-validator";

export interface BoundedQueryOptions {
  allowedSources: ReadonlySet<string>;
  allowedFunctions?: ReadonlySet<string>;
  limits?: Partial<SqlQueryLimits>;
}

export interface BoundedQueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  elapsedMs: number;
}

export class BoundedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundedQueryError";
  }
}

/** Strips any trailing `;` (and surrounding whitespace) from an already-
 *  validated query. Safe to call only on text that has already passed
 *  `validateBoundedQuery` (which guarantees at most one statement, with
 *  only a single, optional, TRAILING `;` permitted) — this is not a
 *  general-purpose SQL sanitizer. */
function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

/** Wraps an already-validated query so SQLite itself stops producing rows
 *  at `maximumRows + 1` — see this file's "LIMIT INJECTION" header comment
 *  for why wrapping (rather than editing/appending to the query's own
 *  LIMIT clause) is the chosen technique and why it's correct even when
 *  the query already has its own (possibly smaller) LIMIT. The `+ 1` lets
 *  the row-counting loop below observe one row past the cap and report
 *  `truncated: true`, matching this module's existing truncation
 *  semantics exactly. */
function injectRowLimitCap(sql: string, maximumRows: number): string {
  const body = stripTrailingSemicolon(sql);
  return `SELECT * FROM (${body}) AS __enchiridion_bounded_query LIMIT ${maximumRows + 1}`;
}

function byteLength(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length * 2; // conservative UTF-16 estimate
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return (value as ArrayBufferView).byteLength;
  return 0;
}

/** Executes `sql` against `executor` if (and only if) it passes
 *  `validateBoundedQuery`, enforcing `limits` while collecting rows.
 *  Throws `BoundedQueryError` for a rejected query (callers — the RPC
 *  method, GraphQL resolvers, gadget capabilities — decide how to surface
 *  that; this module doesn't know about GraphQL error shapes or RPC
 *  transport). */
export function runBoundedQuery(
  executor: SqlExecutor,
  sql: string,
  args: readonly unknown[],
  options: BoundedQueryOptions,
): BoundedQueryResult {
  const limits = normalizeLimits(options.limits);

  const validation = validateBoundedQuery(sql, {
    allowedSources: options.allowedSources,
    allowedFunctions: options.allowedFunctions,
    maximumSqlLength: limits.maximumSqlLength,
  });
  if (!validation.ok) {
    throw new BoundedQueryError(validation.reason);
  }

  const boundedSql = injectRowLimitCap(sql, limits.maximumRows);

  const startedAt = performance.now();
  let cursor: SqlCursor<Record<string, unknown>>;
  try {
    cursor = executor.exec<Record<string, unknown>>(boundedSql, ...args);
  } catch (error) {
    throw new BoundedQueryError(
      `query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const columns = cursor.columnNames;
  const rows: unknown[][] = [];
  let bytes = 0;
  let truncated = false;

  for (const row of cursor.raw<unknown[]>()) {
    if (rows.length >= limits.maximumRows) {
      truncated = true;
      break;
    }
    let rowBytes = 0;
    for (const value of row) {
      rowBytes += byteLength(value);
    }
    if (bytes + rowBytes > limits.maximumBytes) {
      truncated = true;
      break;
    }
    bytes += rowBytes;
    rows.push(row);
  }

  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs > limits.maximumDurationMs) {
    // See file header: the query has already finished by the time we can
    // know this. Reported, not prevented.
    truncated = true;
  }

  return { columns, rows, truncated, elapsedMs };
}
