// @enchiridion/worker-gadget-host — DO SQLite schema for `GadgetSupervisorDO`.
//
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md, plan
// §Gadgets (P4): "Gadget = dynamic worker loaded as a DO facet under
// GadgetSupervisorDO, isolated SQLite for private state. Capabilities
// injected at load, default nothing." This file owns the SUPERVISOR's own
// SQLite (capability grants/requests, graph-proposal approvals, cron
// schedules, registered gadget code) — each facet gets its OWN, separate,
// isolated SQLite database (per-facet, managed by the Workers runtime, not
// this file — see `gadget-supervisor-do.ts`'s header on `this.ctx.facets`).
//
// Same three-part convention every other worker's `schema.ts` in this repo
// uses: `SqlExecutor`/`SqlCursor` (a structural subset of Cloudflare's real
// `SqlStorage`, so every module in this worker is unit-testable against
// `test-helpers/sqlite-storage-adapter.ts`'s real `bun:sqlite`-backed
// implementation without a live Workers runtime), `initializeSchema` (one
// idempotent `CREATE TABLE IF NOT EXISTS` pass run from the DO's
// constructor), and named table lists other modules import rather than
// restating.
//
// Table families:
//   1. Capability grants/requests — `capability_grants`, plan: "a
//      GadgetCapabilityGrant model (capability type, scope/params,
//      granted-at, revocable) stored in DO SQLite, checked at gadget
//      invocation time — default deny". `capability_grant_requests` is the
//      plan's "Grant requests: a gadget requesting a capability creates a
//      grant-request record requiring in-app approval" — a PENDING request
//      grants nothing; only `capability-enforcement.ts`'s check against
//      `capability_grants` ever allows a call through (see that file).
//   2. graph.propose() approval gate — `gadget_pending_approvals` /
//      `gadget_action_log`, deliberately SHAPED IDENTICALLY to
//      `workers/gatekeeper-google/src/schema.ts`'s `pending_approvals` /
//      `action_log` (see `gadget-approvals-store.ts`'s header for the
//      column-by-column mirroring — the task brief's "graph.propose()
//      creates a real approval record indistinguishable in shape from the
//      existing calendar/Gmail approval infrastructure" requirement). A
//      `gadget_id` column is added (gatekeeper-google's tables don't need
//      one — it manages a single external account, not multiple gadgets).
//   3. `schedule.cron` — `gadget_schedules`: plan's fan-out design (see
//      `schedule-fanout.ts`'s header) — one supervisor-level cron tick
//      polls this table for due rows, rather than a true per-gadget Cron
//      Trigger (Workers Cron Triggers are static, deploy-time
//      `wrangler.jsonc` config; there is no runtime API to register a new
//      one per gadget without a fresh deploy, which would defeat the
//      deploy-free gadget-creation UX the plan cares about).
//   4. `gadget_definitions` — the registered gadget code a facet is loaded
//      from (`this.env.GADGET_LOADER.get(gadgetId, callback)`,
//      `gadget-supervisor-do.ts`). REAL code storage as of this pass — see
//      `gadget-definition-store.ts`'s header for the two supported shapes:
//      (a) `modules` — inline JS source, JSON-encoded (the original v1
//      shape; still used by `scripts/facet-isolation-drill.ts` and
//      `scripts/capability-transport-drill.ts`'s own small, self-contained
//      test fixtures, and by any dev/admin-registered gadget that doesn't
//      need R2 at all), or (b) `r2_key` — a pointer into the `GADGET_CODE`
//      R2 bucket (`wrangler.jsonc`), the PRODUCTION path real gadgets
//      (e.g. `gadgets/morning-brief/`) are registered through
//      (`gadget-code-loader.ts` resolves either shape to the same
//      `modules` map the Worker Loader needs at facet-load time). Exactly
//      one of the two is set per row — enforced in
//      `gadget-definition-store.ts`'s `upsertGadgetDefinition`.
//      `code_version` auto-increments on every upsert of the same `id`, so
//      a gadget's registered code has a real, queryable version history
//      even though only the LATEST version's bytes are kept (no rollback
//      storage yet — a real follow-up, not this pass's scope).
//   5. `gadget_doc_state` — `graph.propose()`'s execution-time synthetic
//      "device" doc snapshot per page, mirroring
//      `workers/gatekeeper-google/src/materialization-store.ts`'s
//      `calendar_materialization_state` table and its file header's
//      causal-history/LWW-lamport argument for WHY a per-page snapshot must
//      be persisted and reopened (not a fresh `LoroDoc()` per proposal) —
//      see `gadget-materialized-doc.ts`.

export interface SqlExecutor {
  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T>;
}

export interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
  raw<U extends unknown[]>(): IterableIterator<U>;
  columnNames: string[];
  [Symbol.iterator](): IterableIterator<T>;
}

const DDL_STATEMENTS: readonly string[] = [
  // --- Capability grants -------------------------------------------------
  `CREATE TABLE IF NOT EXISTS capability_grants (
    id TEXT PRIMARY KEY,
    gadget_id TEXT NOT NULL,
    capability_type TEXT NOT NULL,
    scope TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    granted_by TEXT NOT NULL,
    revoked_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS capability_grants_gadget_type
     ON capability_grants (gadget_id, capability_type, revoked_at)`,

  // --- Capability grant requests ------------------------------------------
  `CREATE TABLE IF NOT EXISTS capability_grant_requests (
    id TEXT PRIMARY KEY,
    gadget_id TEXT NOT NULL,
    capability_type TEXT NOT NULL,
    scope TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    resulting_grant_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS capability_grant_requests_gadget_status
     ON capability_grant_requests (gadget_id, status)`,

  // --- graph.propose() approval gate — mirrors gatekeeper-google's
  // pending_approvals/action_log column-for-column, plus gadget_id. -------
  `CREATE TABLE IF NOT EXISTS gadget_pending_approvals (
    id TEXT PRIMARY KEY,
    gadget_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    version_token TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS gadget_pending_approvals_status
     ON gadget_pending_approvals (status)`,
  `CREATE TABLE IF NOT EXISTS gadget_action_log (
    id TEXT PRIMARY KEY,
    approval_id TEXT,
    gadget_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    outcome TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  // --- schedule.cron -------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS gadget_schedules (
    id TEXT PRIMARY KEY,
    gadget_id TEXT NOT NULL,
    interval_minutes INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_due_at INTEGER NOT NULL,
    last_run_at INTEGER,
    last_result TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS gadget_schedules_due
     ON gadget_schedules (enabled, next_due_at)`,

  // --- Registered gadget code — see this file's header point 4. `modules`
  // and `r2_key` are each nullable; exactly one is set per row. ----------
  `CREATE TABLE IF NOT EXISTS gadget_definitions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    main_module TEXT NOT NULL,
    modules TEXT,
    r2_key TEXT,
    code_version INTEGER NOT NULL DEFAULT 1,
    compatibility_date TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  // --- graph.propose() execution-time synthetic-device doc snapshot ------
  `CREATE TABLE IF NOT EXISTS gadget_doc_state (
    page_id TEXT PRIMARY KEY,
    doc_snapshot BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

export function initializeSchema(sql: SqlExecutor): void {
  for (const statement of DDL_STATEMENTS) {
    sql.exec(statement);
  }
}
