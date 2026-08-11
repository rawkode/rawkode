// @enchiridion/worker-gadget-host — SQLite read/write for
// `gadget_definitions`: the registered code a facet is loaded from.
//
// TWO SUPPORTED CODE-STORAGE SHAPES (real, both — see `schema.ts`'s header
// point 4 for the table-level summary this file implements):
//
//   (a) INLINE (`modules` set, `r2Key` null) — the original v1 shape:
//       `modules` is a JSON-encoded `Record<string, string>` (module name
//       -> JS source), matching the shape `env.GADGET_LOADER.get(codeId,
//       callback)`'s `WorkerLoaderWorkerCode.modules` expects directly
//       (Cloudflare's `@cloudflare/workers-types`' `WorkerLoaderModule |
//       string` — this pass only ever stores plain JS source strings, the
//       `{js: string}` / `{cjs: string}` / etc. object forms remain a real,
//       documented option for a follow-up task that needs them). Used by
//       `scripts/facet-isolation-drill.ts` and
//       `scripts/capability-transport-drill.ts`'s own small, self-contained
//       test-fixture gadgets (via `GadgetSupervisorDO.registerGadget`,
//       UNCHANGED by this pass — see that method's own doc comment) and by
//       any other dev/admin-registered gadget that doesn't need R2 at all.
//   (b) R2-BACKED (`r2Key` set, `modules` null) — the PRODUCTION path: the
//       row stores a pointer into the `GADGET_CODE` R2 bucket
//       (`wrangler.jsonc`) instead of the source bytes themselves.
//       `gadget-code-loader.ts`'s `resolveGadgetModules` is the one place
//       that turns either shape into the `Record<string, string>` the
//       Worker Loader needs at actual facet-load time — this file never
//       touches R2 itself, it only stores/retrieves the pointer.
//       `GadgetSupervisorDO.registerGadgetCode` (new this pass) is this
//       shape's write path; `gadgets/morning-brief/`'s deploy script
//       (`scripts/deploy-morning-brief.ts`) is its real caller.
//
// Exactly one of the two is set per row (enforced in
// `upsertGadgetDefinition` below, not just documented) — a row with both or
// neither is a caller bug, rejected before it ever reaches SQLite.
//
// `code_version` auto-increments on every upsert of the same `id` (1 on
// first insert, `existing.codeVersion + 1` on every subsequent one,
// regardless of which of the two shapes either the old or new row uses) —
// gives a real, queryable version history for "what code is this gadget
// running right now, and how many times has it been redeployed" even
// though only the LATEST version's bytes are ever kept (no rollback
// storage in this pass — a real, bounded follow-up, not a redesign).
//
// `kind` distinguishes the plan's two v1 gadget shapes ("one headless cron
// automation ... + one UI gadget to prove the bridge") for bookkeeping —
// this worker's own dispatch logic (`gadget-supervisor-do.ts`) doesn't
// currently branch on it; a UI gadget's WKWebView bridge is a native-app
// concern layered on top of the same facet-invocation RPC every gadget
// uses (`invokeGadget`), not a different backend code path.

import type { SqlExecutor } from "./schema";

export type GadgetKind = "headless" | "ui";

export interface GadgetDefinition {
  id: string;
  kind: GadgetKind;
  mainModule: string;
  /** Inline JS source (shape (a) above) — null when `r2Key` is set. */
  modules: Record<string, string> | null;
  /** R2 object key in the `GADGET_CODE` bucket (shape (b) above) — null
   *  when `modules` is set inline. */
  r2Key: string | null;
  /** Auto-incrementing version counter — see this file's header. */
  codeVersion: number;
  compatibilityDate: string;
  createdAt: number;
  updatedAt: number;
}

interface DefinitionRow {
  id: string;
  kind: string;
  main_module: string;
  modules: string | null;
  r2_key: string | null;
  code_version: number;
  compatibility_date: string;
  created_at: number;
  updated_at: number;
  [key: string]: unknown;
}

const DEFINITION_COLUMNS = "id, kind, main_module, modules, r2_key, code_version, compatibility_date, created_at, updated_at";

function decodeRow(row: DefinitionRow): GadgetDefinition {
  return {
    id: row.id,
    kind: row.kind as GadgetKind,
    mainModule: row.main_module,
    modules: row.modules ? (JSON.parse(row.modules) as Record<string, string>) : null,
    r2Key: row.r2_key,
    codeVersion: row.code_version,
    compatibilityDate: row.compatibility_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertGadgetDefinitionInput {
  id: string;
  kind: GadgetKind;
  mainModule: string;
  /** Exactly one of `modules`/`r2Key` must be provided — see this file's
   *  header. */
  modules?: Record<string, string> | null;
  r2Key?: string | null;
  compatibilityDate: string;
}

/** Registers (or replaces — `INSERT ... ON CONFLICT DO UPDATE`, an explicit
 *  redeploy of the SAME gadget id, bumping `codeVersion`) a gadget's code.
 *  `id` is caller-supplied (not generated) so a gadget's identity is stable
 *  across code updates — capability grants (`capability_grants.gadget_id`)
 *  and schedules (`gadget_schedules.gadget_id`) key off this same id and
 *  must keep working after a code update. Throws `TypeError` if `input`
 *  doesn't set exactly one of `modules`/`r2Key` (this file's header's
 *  "exactly one" invariant, enforced here, not just documented). */
export function upsertGadgetDefinition(sql: SqlExecutor, input: UpsertGadgetDefinitionInput, now: number): GadgetDefinition {
  const modules = input.modules ?? null;
  const r2Key = input.r2Key ?? null;
  if (!modules && !r2Key) {
    throw new TypeError("upsertGadgetDefinition: exactly one of modules or r2Key must be provided (got neither)");
  }
  if (modules && r2Key) {
    throw new TypeError("upsertGadgetDefinition: exactly one of modules or r2Key must be provided (got both)");
  }

  const existing = getGadgetDefinition(sql, input.id);
  const createdAt = existing?.createdAt ?? now;
  const codeVersion = (existing?.codeVersion ?? 0) + 1;

  sql.exec(
    `INSERT INTO gadget_definitions (id, kind, main_module, modules, r2_key, code_version, compatibility_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       kind = excluded.kind, main_module = excluded.main_module, modules = excluded.modules,
       r2_key = excluded.r2_key, code_version = excluded.code_version,
       compatibility_date = excluded.compatibility_date, updated_at = excluded.updated_at`,
    input.id,
    input.kind,
    input.mainModule,
    modules ? JSON.stringify(modules) : null,
    r2Key,
    codeVersion,
    input.compatibilityDate,
    createdAt,
    now,
  );
  return {
    id: input.id,
    kind: input.kind,
    mainModule: input.mainModule,
    modules,
    r2Key,
    codeVersion,
    compatibilityDate: input.compatibilityDate,
    createdAt,
    updatedAt: now,
  };
}

export function getGadgetDefinition(sql: SqlExecutor, id: string): GadgetDefinition | undefined {
  const row = sql.exec<DefinitionRow>(`SELECT ${DEFINITION_COLUMNS} FROM gadget_definitions WHERE id = ?`, id).toArray()[0];
  return row ? decodeRow(row) : undefined;
}

export function listGadgetDefinitions(sql: SqlExecutor): GadgetDefinition[] {
  return sql.exec<DefinitionRow>(`SELECT ${DEFINITION_COLUMNS} FROM gadget_definitions ORDER BY created_at ASC`).toArray().map(decodeRow);
}
