// @enchiridion/schema — projection SQL safety checks.
//
// Port of `ModuleRegistry.isValidProjectionViewName` /
// `ModuleRegistry.isSafeProjectionStatement`
// (apps/enchiridion/Sources/EnchiridionCore/ModuleFoundation.swift:161-181).
//
// This is deliberately NOT the same validator as
// workers/vault/src/sql-validator.ts's `validateBoundedQuery` — that one is
// a full tokenizer built for vault's *runtime* bounded-query RPC (it knows
// about an allowlist of views/functions available at query time, permits a
// single trailing `;`, and allows a `UNION` inside a recursive CTE). This
// module's job is narrower and earlier: at *module-definition/build* time,
// is a supertag module's declared `ProjectionDefinition.sql` a single, bare
// SELECT statement at all — no view/function allowlist exists yet at this
// point, module composition hasn't happened. It intentionally ports the
// Swift original's simpler, stricter, whole-text lexical checks (any `;`
// anywhere is rejected, not just a non-trailing one; exactly one `select`
// word in the entire statement, which also rejects `UNION SELECT`) rather
// than reusing vault's more permissive tokenizer — the two validators guard
// different boundaries and are allowed to disagree.

/** Port of `ModuleRegistry.isValidProjectionViewName`
 *  (ModuleFoundation.swift:161-163). Public SQL view names are not
 *  namespace-prefixed (unlike supertag/relation/view-type ids) — they only
 *  need to be a safe SQLite identifier shaped like `graph_<snake_case>`; the
 *  registry enforces global uniqueness separately (see registry.ts). */
export function isValidProjectionViewName(value: string): boolean {
  return /^graph_[a-z0-9_]+$/.test(value);
}

/** Keywords ported from `ModuleRegistry.isSafeProjectionStatement`'s
 *  `forbidden` set (ModuleFoundation.swift:175-178). */
const FORBIDDEN_PROJECTION_KEYWORDS: ReadonlySet<string> = new Set([
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "attach",
  "pragma",
  "vacuum",
  "replace",
]);

/** Port of `ModuleRegistry.isSafeProjectionStatement`
 *  (ModuleFoundation.swift:167-181). A projection body must be:
 *   1. non-empty once trimmed;
 *   2. free of `;`, `--`, and `/*` ANYWHERE in the text (not just outside
 *      string literals — the Swift original doesn't tokenize strings out
 *      either, it is deliberately conservative over the whole raw text);
 *   3. leading with `SELECT` (case-insensitive);
 *   4. free of any write/DDL/attach/pragma keyword as a whole word anywhere;
 *   5. containing exactly one `select` word in total — which also rejects
 *      `UNION SELECT`/multi-branch statements, matching the Swift original. */
export function isSafeProjectionStatement(statement: string): boolean {
  const normalized = statement.trim();
  if (normalized.length === 0) return false;
  if (normalized.includes(";")) return false;
  if (normalized.includes("--")) return false;
  if (normalized.includes("/*")) return false;
  if (!/^SELECT\b/i.test(normalized)) return false;

  const words = normalized.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  if (words.some((word) => FORBIDDEN_PROJECTION_KEYWORDS.has(word))) return false;
  return words.filter((word) => word === "select").length === 1;
}
