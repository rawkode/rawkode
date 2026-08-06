// @enchiridion/worker-vault — bounded SQL query surface: LEXICAL validator.
//
// Port of `GraphSQLExecutor` (from
// apps/enchiridion/Sources/EnchiridionCore/GraphSQLExecutor.swift) for
// VaultDO's `query(sql, args, limits)` RPC (plan §Backend architecture,
// "Bounded query surface").
//
// *** THIS IS NOT AN AUTHORIZER. READ THIS BEFORE TOUCHING THE ALLOWLISTS. ***
//
// The Swift original installs a real `sqlite3_set_authorizer` callback —
// SQLite itself walks the parsed query plan and calls back into app code
// for every table read, function call, and pragma, denying anything not on
// an allowlist *after the query planner has already resolved what it
// actually touches* (including views, subqueries, and anything a query
// expands into, like FTS5's internal shadow-table reads). That is a real
// security boundary: it cannot be lied to by clever SQL text, because it
// isn't looking at text at all.
//
// Cloudflare DO SQLite exposes no such hook (plan Risk #5: "DO SQLite has
// no `sqlite3_set_authorizer`"). Everything below is LEXICAL: a hand-written
// tokenizer plus pattern matching over the query *text*. It is necessarily
// weaker than a real authorizer and should be treated as a speed bump for
// one authenticated user behind Cloudflare Access (plan: "acceptable behind
// Access for one user"), not a sandbox boundary for untrusted input. Gadget
// code (P4) must never reach this function — gadgets get pre-defined
// parameterized views only (plan §Gadgets), exactly because this validator
// is not strong enough to hand to untrusted callers.
//
// Design stance, given that constraint: fail closed. When the tokenizer is
// unsure whether something is safe (an unrecognized function-call-shaped
// identifier, an unbalanced quote/comment, anything past the length cap),
// it rejects rather than guesses. Prefer being annoying to a legitimate
// query over being wrong about a dangerous one.
//
// What this validator checks, mirroring GraphSQLExecutor.swift's ported
// pieces plus the plan's explicit requirements (comment injection, stacked
// statements, PRAGMA, ATTACH):
//   1. Non-empty, under a hard length cap.
//   2. Exactly one statement — SQL comments and string/quoted-identifier
//      contents are tokenized out first, so a `;` or a banned keyword
//      hidden inside a `-- comment` or a string literal is inert; a `;`
//      that actually separates two statements is not.
//   3. First real token is `SELECT` or `WITH` (GraphSQLExecutor.swift:90-93).
//   4. No write/schema/attach/pragma/transaction keywords anywhere in the
//      token stream (PRAGMA, ATTACH, DETACH, INSERT, UPDATE, DELETE,
//      REPLACE, CREATE, ALTER, DROP, TRIGGER, VACUUM, REINDEX, ANALYZE,
//      BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE, GRANT/REVOKE, INTO,
//      EXPLAIN) — SQLite has no `sqlite3_stmt_readonly()` equivalent
//      available before executing, so this keyword scan is the substitute.
//   5. Every `FROM`/`JOIN` source resolves (after stripping an optional
//      `main.` schema qualifier — DO SQLite has no other schema unless
//      ATTACH is used, and ATTACH is already banned by #4) to an allowlisted
//      view name or a CTE name defined earlier in the same statement's
//      `WITH` clause (GraphSQLExecutor.swift's `allowedSources`).
//   6. FTS5 shadow tables (`graph_text_search_{config,content,data,docsize,
//      idx}`) are rejected if referenced ANYWHERE in the query text — not
//      just in FROM position — mirroring `forbiddenIdentifier`
//      (GraphSQLExecutor.swift:336-390), which exists because "FTS5 expands
//      a public MATCH query into reads of its private shadow tables before
//      the authorizer reports the public virtual table."
//   7. Every `identifier(` call site resolves to an allowlisted SQL
//      function (GraphSQLExecutor.swift's `allowedFunctions`) or a small
//      fixed set of SQL syntax that happens to use parenthesis-after-
//      keyword shape without being a function call (`CAST(...)`,
//      `EXISTS(...)`, `IN(...)`, `NOT(...)`, `x FILTER(...)`,
//      `OVER(...)`, `VALUES(...)`).

import { FTS_SHADOW_TABLE_NAMES as FTS_SHADOW_DEFAULT, PRIVATE_STORAGE_TABLE_NAMES } from "./schema";
export { FTS_SHADOW_DEFAULT as FTS_SHADOW_TABLE_NAMES };

/** Default `forbiddenIdentifiers` set: FTS5's internal shadow tables plus
 *  any private storage table backing a public view (`schema.ts`'s
 *  `PRIVATE_STORAGE_TABLE_NAMES` — as of this pass, `_graph_edges`, the
 *  forward-only table behind the `graph_edges` VIEW). Same rejected-
 *  anywhere-in-the-query-text treatment as the FTS shadow tables — see this
 *  file's numbered list, item 6. */
const DEFAULT_FORBIDDEN_IDENTIFIERS: ReadonlySet<string> = new Set([
  ...FTS_SHADOW_DEFAULT,
  ...PRIVATE_STORAGE_TABLE_NAMES,
]);

export interface SqlQueryLimits {
  /** Row cap on the result set — matches `GraphQueryLimits.maximumRows`
   *  (GraphSQLExecutor.swift:6, default 5000, clamped [1, 20000]). */
  maximumRows: number;
  /** Byte cap summed over every returned cell — matches `maximumBytes`
   *  (default 8 MiB, clamped [1 KiB, 32 MiB]). */
  maximumBytes: number;
  /** Wall-clock budget in milliseconds. NOTE: unlike the Swift original's
   *  `sqlite3_progress_handler` (a true mid-query interrupt), DO SQLite's
   *  synchronous `exec()` gives JS no way to interrupt a running query —
   *  this is enforced by `query-rpc.ts` measuring elapsed time *after*
   *  `exec()` returns, which can only inform truncation of a result the
   *  engine already fully computed, not cut execution short. Documented
   *  limitation, not a guess: see `query-rpc.ts`'s file header. */
  maximumDurationMs: number;
  /** Hard cap on the SQL text length itself, checked before tokenizing. */
  maximumSqlLength: number;
}

const LIMIT_BOUNDS = {
  maximumRows: { min: 1, max: 20_000, fallback: 5_000 },
  maximumBytes: { min: 1_024, max: 32 * 1_024 * 1_024, fallback: 8 * 1_024 * 1_024 },
  maximumDurationMs: { min: 50, max: 10_000, fallback: 2_000 },
  maximumSqlLength: { min: 64, max: 256 * 1_024, fallback: 32 * 1_024 },
} as const;

function clamp(value: number, bounds: { min: number; max: number; fallback: number }): number {
  if (!Number.isFinite(value)) return bounds.fallback;
  return Math.min(Math.max(value, bounds.min), bounds.max);
}

export function normalizeLimits(limits?: Partial<SqlQueryLimits>): SqlQueryLimits {
  return {
    maximumRows: clamp(limits?.maximumRows ?? LIMIT_BOUNDS.maximumRows.fallback, LIMIT_BOUNDS.maximumRows),
    maximumBytes: clamp(
      limits?.maximumBytes ?? LIMIT_BOUNDS.maximumBytes.fallback,
      LIMIT_BOUNDS.maximumBytes,
    ),
    maximumDurationMs: clamp(
      limits?.maximumDurationMs ?? LIMIT_BOUNDS.maximumDurationMs.fallback,
      LIMIT_BOUNDS.maximumDurationMs,
    ),
    maximumSqlLength: clamp(
      limits?.maximumSqlLength ?? LIMIT_BOUNDS.maximumSqlLength.fallback,
      LIMIT_BOUNDS.maximumSqlLength,
    ),
  };
}

/** TS mirror of `GraphSQLExecutor.allowedFunctions`
 *  (GraphSQLExecutor.swift:70-77). */
export const DEFAULT_ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  "abs", "avg", "bm25", "coalesce", "count", "date", "datetime", "glob", "group_concat",
  "hex", "ifnull", "iif", "instr", "julianday", "json_array", "json_extract",
  "json_object", "json_type", "length", "like", "likely", "lower", "ltrim", "match",
  "max", "min", "nullif", "printf", "quote", "random", "replace", "round", "row_number",
  "rtrim", "snippet", "strftime", "substr", "substring", "sum", "time", "total", "trim", "typeof",
  "unicode", "unixepoch", "unlikely", "upper",
]);

/** SQL keywords that are legitimately followed by `(` without being a
 *  function call in the `sqlite3_set_authorizer` `SQLITE_FUNCTION` sense —
 *  the Swift original never needs this list because its authorizer only
 *  fires `SQLITE_FUNCTION` for real function calls; our lexical scanner
 *  can't tell the difference from text alone, so anything that isn't a
 *  function call must be enumerated explicitly or it gets rejected. */
const PAREN_KEYWORD_EXEMPTIONS: ReadonlySet<string> = new Set([
  "cast", "exists", "in", "not", "over", "filter", "values",
  // `AS (` is how a CTE definition opens its body (`WITH name AS (...)`) —
  // not a function call.
  "as",
]);

/** Keywords that make a statement a write, schema change, attach, pragma,
 *  or transaction-control operation — none of which belong in a read-only
 *  bounded query. Scanned across the ENTIRE token stream (not just the
 *  leading token), so `SELECT 1; PRAGMA x` (caught by the multi-statement
 *  check too, belt-and-braces) and `WITH x AS (...) INSERT INTO t ...`
 *  (which the Swift authorizer would deny structurally; we deny lexically)
 *  are both rejected. */
const DISALLOWED_KEYWORDS: ReadonlySet<string> = new Set([
  "PRAGMA", "ATTACH", "DETACH", "VACUUM", "REINDEX", "ANALYZE",
  "INSERT", "UPDATE", "DELETE", "REPLACE",
  "CREATE", "ALTER", "DROP", "TRIGGER",
  "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "TRANSACTION",
  "GRANT", "REVOKE", "INTO", "EXPLAIN",
]);

export type SqlValidationResult = { ok: true } | { ok: false; reason: string };

export interface SqlValidationOptions {
  /** Views/tables a `FROM`/`JOIN` clause may reference. Case-insensitive. */
  allowedSources: ReadonlySet<string>;
  /** Additional shadow-table-shaped names to reject anywhere in the query
   *  text, regardless of position — defaults to the FTS5 shadow tables. */
  forbiddenIdentifiers?: ReadonlySet<string>;
  /** Functions a call site may invoke — defaults to
   *  `DEFAULT_ALLOWED_FUNCTIONS`. */
  allowedFunctions?: ReadonlySet<string>;
  maximumSqlLength?: number;
}

type Token =
  | { kind: "ident"; value: string }
  | { kind: "quoted"; value: string }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string }
  | { kind: "other" };

class TokenizeError extends Error {}

function isIdentifierByte(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch.codePointAt(0)! >= 128
  );
}

/** Tokenizes `sql`, dropping whitespace/comments/operators entirely and
 *  keeping only what the validator needs to reason about: identifiers,
 *  quoted identifiers, string literals, and structural punctuation
 *  (`( ) , .` and `;`). Throws `TokenizeError` on any malformed construct
 *  (unterminated string/comment/quote) — the caller treats that as a
 *  rejection, per this module's fail-closed stance. */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;

    // Line comment.
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n" && sql[i] !== "\r") i++;
      continue;
    }
    // Block comment.
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new TokenizeError("unterminated block comment");
      i = end + 2;
      continue;
    }
    // String literal: '...' with '' escaping.
    if (ch === "'") {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        value += sql[j];
        j += 1;
      }
      if (!closed) throw new TokenizeError("unterminated string literal");
      tokens.push({ kind: "string", value });
      i = j;
      continue;
    }
    // Quoted identifier: "...", `...`, or [...].
    if (ch === '"' || ch === "`" || ch === "[") {
      const terminator = ch === "[" ? "]" : ch;
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < n) {
        if (sql[j] === terminator) {
          if (terminator !== "]" && sql[j + 1] === terminator) {
            value += terminator;
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        value += sql[j];
        j += 1;
      }
      if (!closed) throw new TokenizeError("unterminated quoted identifier");
      tokens.push({ kind: "quoted", value });
      i = j;
      continue;
    }
    // Bind parameters (?, ?NNN, :name, @name, $name) — opaque, not
    // identifiers; skip the leading sigil and any following identifier
    // chars as one "other" token so they can't accidentally be mistaken
    // for a keyword.
    if (ch === "?" || ch === ":" || ch === "@" || ch === "$") {
      let j = i + 1;
      while (j < n && isIdentifierByte(sql[j]!)) j++;
      tokens.push({ kind: "other" });
      i = j;
      continue;
    }
    // Structural punctuation the validator cares about.
    if (ch === "(" || ch === ")" || ch === "," || ch === "." || ch === ";") {
      tokens.push({ kind: "punct", value: ch });
      i += 1;
      continue;
    }
    // Identifier / keyword.
    if (isIdentifierByte(ch) && !(ch >= "0" && ch <= "9")) {
      let j = i;
      while (j < n && isIdentifierByte(sql[j]!)) j++;
      tokens.push({ kind: "ident", value: sql.slice(i, j) });
      i = j;
      continue;
    }
    // Numbers, whitespace, operators (+ - * / = < > etc.) — irrelevant to
    // the checks below; skip as a single opaque char.
    i += 1;
  }
  return tokens;
}

/** Skips from an opening `(` token at `openIndex` to the index just past
 *  its matching `)`, respecting nested parens. Returns `tokens.length` if
 *  unbalanced (caller treats that as a rejection via the overall
 *  try/catch). */
function skipBalancedParens(tokens: Token[], openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct" && t.value === "(") depth++;
    else if (t.kind === "punct" && t.value === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new TokenizeError("unbalanced parentheses");
}

/** Collects CTE names bound by a leading `WITH [RECURSIVE] name [(...)] AS
 *  (...) [, name2 ...]` clause, so the FROM/JOIN source check treats them
 *  as allowed. Returns an empty set if the statement doesn't start with
 *  `WITH`. */
function collectCteNames(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  if (tokens.length === 0) return names;
  const first = tokens[0]!;
  if (!(first.kind === "ident" && first.value.toUpperCase() === "WITH")) return names;

  let i = 1;
  if (tokens[i]?.kind === "ident" && (tokens[i] as { value: string }).value.toUpperCase() === "RECURSIVE") {
    i++;
  }
  while (i < tokens.length) {
    const nameToken = tokens[i];
    if (!nameToken || nameToken.kind !== "ident") break;
    names.add(nameToken.value.toLowerCase());
    i++;
    // Optional column name list: (col1, col2).
    if (tokens[i]?.kind === "punct" && (tokens[i] as { value: string }).value === "(") {
      i = skipBalancedParens(tokens, i);
    }
    const asToken = tokens[i];
    if (!(asToken?.kind === "ident" && asToken.value.toUpperCase() === "AS")) break;
    i++;
    if (!(tokens[i]?.kind === "punct" && (tokens[i] as { value: string }).value === "(")) break;
    i = skipBalancedParens(tokens, i);
    if (tokens[i]?.kind === "punct" && (tokens[i] as { value: string }).value === ",") {
      i++;
      continue;
    }
    break;
  }
  return names;
}

/** Resolves the source name immediately following a `FROM`/`JOIN` token at
 *  `index`, stripping an optional `main.` schema qualifier. Returns
 *  `undefined` if what follows isn't a plain identifier (e.g. a `(`
 *  subquery/derived-table, which is validated by the rest of the token
 *  scan instead — the identifiers *inside* it still get visited when the
 *  scan reaches their own FROM/JOIN tokens). */
function resolveSourceName(tokens: Token[], index: number): string | undefined {
  const first = tokens[index];
  if (!first || (first.kind !== "ident" && first.kind !== "quoted" && first.kind !== "string")) {
    return undefined;
  }
  if (tokens[index + 1]?.kind === "punct" && (tokens[index + 1] as { value: string }).value === ".") {
    const second = tokens[index + 2];
    if (second && (second.kind === "ident" || second.kind === "quoted" || second.kind === "string")) {
      return second.value.toLowerCase();
    }
  }
  return first.value.toLowerCase();
}

export function validateBoundedQuery(sql: string, options: SqlValidationOptions): SqlValidationResult {
  const maximumSqlLength = options.maximumSqlLength ?? LIMIT_BOUNDS.maximumSqlLength.fallback;
  const forbiddenIdentifiers = options.forbiddenIdentifiers ?? DEFAULT_FORBIDDEN_IDENTIFIERS;
  const allowedFunctions = options.allowedFunctions ?? DEFAULT_ALLOWED_FUNCTIONS;

  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty query" };
  }
  if (trimmed.length > maximumSqlLength) {
    return { ok: false, reason: `query exceeds maximum length of ${maximumSqlLength} characters` };
  }
  if (trimmed.includes("\u0000")) {
    return { ok: false, reason: "query contains a NUL byte" };
  }

  let tokens: Token[];
  try {
    tokens = tokenize(trimmed);
  } catch (error) {
    return { ok: false, reason: `unparseable query: ${(error as Error).message}` };
  }

  const significant = tokens.filter((t) => t.kind !== "other");
  if (significant.length === 0) {
    return { ok: false, reason: "empty query" };
  }

  // (1) Exactly one statement: at most one `;`, and only trailing ones.
  const firstSemicolon = significant.findIndex((t) => t.kind === "punct" && t.value === ";");
  if (firstSemicolon !== -1) {
    for (let i = firstSemicolon; i < significant.length; i++) {
      const t = significant[i]!;
      if (!(t.kind === "punct" && t.value === ";")) {
        return { ok: false, reason: "multiple statements are not allowed" };
      }
    }
  }
  const body = firstSemicolon === -1 ? significant : significant.slice(0, firstSemicolon);
  if (body.length === 0) {
    return { ok: false, reason: "empty query" };
  }

  // (2) First token must be SELECT or WITH.
  const leading = body[0]!;
  const leadingWord = leading.kind === "ident" ? leading.value.toUpperCase() : "";
  if (leadingWord !== "SELECT" && leadingWord !== "WITH") {
    return { ok: false, reason: "only SELECT/WITH statements are allowed" };
  }

  // (3) No disallowed keywords anywhere.
  for (const t of body) {
    if (t.kind === "ident" && DISALLOWED_KEYWORDS.has(t.value.toUpperCase())) {
      return { ok: false, reason: `disallowed keyword: ${t.value.toUpperCase()}` };
    }
  }

  // (4) FTS shadow tables (or any other explicitly forbidden identifier)
  // banned anywhere, regardless of quoting.
  for (const t of body) {
    if (t.kind === "ident" || t.kind === "quoted" || t.kind === "string") {
      if (forbiddenIdentifiers.has(t.value.toLowerCase())) {
        return { ok: false, reason: `access to ${t.value.toLowerCase()} is not allowed` };
      }
    }
  }

  // (5) FROM/JOIN sources must resolve to an allowlisted view or a CTE
  // name bound earlier in this statement.
  const cteNames = collectCteNames(body);
  const allowed = options.allowedSources;
  for (let i = 0; i < body.length; i++) {
    const t = body[i]!;
    if (t.kind !== "ident") continue;
    const word = t.value.toUpperCase();
    if (word !== "FROM" && word !== "JOIN") continue;

    let cursor = i + 1;
    // FROM supports a comma-separated source list; JOIN takes exactly one.
    // Loop at least once, and keep going after a comma only when we just
    // consumed a FROM-style list (harmless to also allow it after JOIN —
    // SQLite itself would reject the resulting grammar, and we're already
    // fail-closed on anything else in the statement).
    for (;;) {
      if (tokens[cursor]?.kind === "punct" && (tokens[cursor] as { value: string }).value === "(") {
        // Derived table / subquery — its own tokens get validated when the
        // scan reaches them directly; nothing to resolve here.
        break;
      }
      const name = resolveSourceName(body, cursor);
      if (name === undefined) {
        // Not a plain identifier immediately after FROM/JOIN (e.g. a
        // table-valued function call, or malformed SQL) — fail closed.
        return { ok: false, reason: "unable to verify a query source; rejecting" };
      }
      if (!allowed.has(name) && !cteNames.has(name)) {
        return { ok: false, reason: `access to table/view "${name}" is not allowed` };
      }
      // Advance past the resolved name (and its optional `main.` prefix).
      cursor += body[cursor + 1]?.kind === "punct" && (body[cursor + 1] as { value: string }).value === "." ? 3 : 1;
      if (body[cursor]?.kind === "punct" && (body[cursor] as { value: string }).value === ",") {
        cursor += 1;
        continue;
      }
      break;
    }
  }

  // (6) Every `identifier(` call site must be an allowlisted function or a
  // recognized non-function paren keyword. CTE names are exempt too — a
  // recursive CTE's column list looks identical in text
  // (`ancestors(tag_id) AS (...)`) to a function call, but it's a name
  // declaration, not an invocation.
  for (let i = 0; i < body.length; i++) {
    const t = body[i]!;
    if (t.kind !== "ident") continue;
    const next = body[i + 1];
    if (!(next?.kind === "punct" && next.value === "(")) continue;
    const name = t.value.toLowerCase();
    if (allowedFunctions.has(name) || PAREN_KEYWORD_EXEMPTIONS.has(name) || cteNames.has(name)) continue;
    return { ok: false, reason: `access to the ${name} function is not allowed` };
  }

  return { ok: true };
}
