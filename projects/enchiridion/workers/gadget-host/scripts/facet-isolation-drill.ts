#!/usr/bin/env bun
// DEV-ONLY TOOLING — NOT part of the production API surface.
//
// The facet-isolation drill (plan §Gadgets, P4, adversarial-review
// finding): "Facet-to-facet storage isolation — the core claim this whole
// security model rests on — has no test anywhere in this codebase, only
// Cloudflare's documentation of intended behavior; needs a real
// `wrangler dev`/Miniflare integration test before it carries real gadget
// code, mirroring the bar P0's WebSocket Hibernation risk already set."
//
// This script drives that scenario against a REAL, RUNNING `wrangler dev`
// instance of `workers/gadget-host` (real Miniflare/workerd-simulated
// Durable Object + REAL Dynamic Workers / DO Facets — `this.ctx.facets`,
// `GADGET_LOADER` — not a unit-test double) — see
// `workers/vault/scripts/p0-exit-drill.ts` for the sibling precedent this
// mirrors (real running server, real HTTP requests, captured output, not
// simulated). ACTUALLY RUN in this pass (see the task report for full
// output) — this is not an aspirational/unverified script.
//
// WHAT THIS PROVES: two independently-registered gadgets, each loaded as
// its OWN facet under the SAME `GadgetSupervisorDO` instance, each get
// their own isolated SQLite:
//   (a) gadget A writes a row into a table it creates in ITS OWN facet
//       storage, then reads it back through ITS OWN facet — proves a
//       facet's storage persists and is reachable through its own
//       `fetch()` handler.
//   (b) gadget B (a SEPARATE facet, separate gadget id, same supervisor
//       DO) reads from the SAME table name gadget A wrote into — proves
//       gadget B's facet has its OWN, EMPTY copy of that table, not a
//       shared one (SQLite table names don't collide across facets
//       because there is no shared database underneath them at all). A
//       cross-check (gadget B writes+reads its OWN row under the SAME id)
//       proves B's empty read was real isolation, not a broken facet; a
//       final re-read of gadget A proves A's row was untouched by B's
//       write under that same id — two fully separate databases, not one
//       shared table with row-level scoping.
//   (c) the SUPERVISOR DO's own SQLite (`schema.ts`'s fixed table list)
//       does NOT contain either gadget's private table — isolation cuts
//       the OTHER way too: a facet's storage is invisible from the
//       supervisor's own SQLite, not just from a sibling facet.
//
// HOW GADGET CODE GETS LOADED: `GadgetSupervisorDO.registerGadget(...)`
// stores raw JS module source (`gadget-definition-store.ts`); at
// invocation time the real Dynamic Workers API
// (`env.GADGET_LOADER.get(...)` + `this.ctx.facets.get(...)`) loads it and
// dispatches via `worker.getDurableObjectClass("Gadget").fetch(...)` —
// see `gadget-supervisor-do.ts`'s file header for the full
// facets-vs-fallback research this rests on. This script writes two tiny,
// self-contained "Gadget extends DurableObject" module source strings
// (below) — no external gadget code exists yet in this repo (headless
// automation/UI-gadget code is explicitly future work per `index.ts`'s
// header), so this drill supplies its own minimal, purpose-built gadget
// code, same as `p0-exit-drill.ts` writes its own minimal test page/blob
// rather than depending on a real device's data.
//
// WHY THIS SCRIPT CALLS `debugInvokeGadgetWithEmptyEnv`, NOT THE REAL
// `invokeGadget`: this drill is scoped to ONE security property (per-facet
// SQLite storage isolation), and `debugInvokeGadgetWithEmptyEnv` is the
// narrowest way to reach a real dynamically-loaded facet without a
// capability surface muddying what's under test at all — that's still true
// today, unchanged.
//
// HISTORICAL NOTE — RESOLVED: an earlier run of this drill against a real
// `wrangler dev` instance ALSO surfaced a genuine, reproducible, unrelated
// bug: `invokeGadget`'s real capability-bound `env` (`gadget-env.ts`'s
// `buildGadgetEnv`, at the time a plain object of async function closures)
// threw `DataCloneError: async graphQuery(...) {...} could not be cloned`
// on EVERY call, because `WorkerLoaderWorkerCode.env` gets structured-cloned
// before it reaches the facet's isolate, and plain functions do not
// survive that. That bug is FIXED (see `gadget-env.ts`'s and
// `gadget-capabilities-entrypoint.ts`'s headers for the full writeup, and
// `scripts/capability-transport-drill.ts` for the live re-verification
// against the REAL `invokeGadget` path this drill deliberately still
// doesn't use) — `debugInvokeGadgetWithEmptyEnv` is kept here purely
// because an empty `env: {}` is still the right tool for THIS drill's
// narrower job, not because the real path is broken.
//
// REQUIRES: a running `wrangler dev` instance of `workers/gadget-host`,
// started with `--var ENABLE_DEV_ADMIN_ROUTES:true` (see `src/index.ts`'s
// `/dev/admin/*` block — added specifically so this drill has a way to
// reach `GadgetSupervisorDO`'s RPC surface from outside the Workers
// runtime, since RPC methods are only callable from another Worker/DO
// holding a `DurableObjectStub`, never over plain HTTP). This script does
// NOT start `wrangler dev` itself:
//
//   cd workers/gadget-host
//   npx wrangler dev --port 8788 --var ENABLE_DEV_ADMIN_ROUTES:true
//   # in a second terminal:
//   GADGET_HOST_URL=http://localhost:8788 bun scripts/facet-isolation-drill.ts
//
// GATE THIS SCRIPT DOES *NOT* HIT: Cloudflare's "Worker Loader API is
// available in local development with Wrangler and workerd. But to run
// dynamic Workers on Cloudflare, you must sign up for the closed beta" —
// per `gadget-supervisor-do.ts`'s header, that gate is a DEPLOY-time/
// account-time concern (`wrangler deploy` to a real Cloudflare account),
// not a `wrangler dev` blocker. Confirmed live in this pass: `wrangler
// dev` for this worker started cleanly with `env.GADGET_LOADER` bound as
// "Worker Loader / local" (no beta-signup error at any point), and this
// script's facets/gadget-loading calls all succeeded against it — this
// script exercises exactly the `wrangler dev`-local path the docs say is
// unrestricted, and that held up in practice, not just on paper.

const GADGET_HOST_URL = process.env.GADGET_HOST_URL ?? "http://localhost:8788";

let passCount = 0;
let failCount = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (condition) {
    passCount += 1;
    console.log(`  PASS: ${message}`);
  } else {
    failCount += 1;
    console.error(`  FAIL: ${message}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function devAdmin<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${GADGET_HOST_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  let body: T;
  try {
    body = (await res.json()) as T;
  } catch {
    body = undefined as unknown as T;
  }
  return { status: res.status, body };
}

interface InvokeResult {
  status: number;
  body: string;
}

/** Dispatches one request into a gadget's facet via the
 *  `debugInvokeGadgetWithEmptyEnv` RPC (see this file's header for why not
 *  the real `invokeGadget`) and parses the inner `{rows}` JSON body a
 *  successful `/read` returns. */
async function invokeGadget(gadgetId: string, path: string, method: string, body?: string): Promise<InvokeResult> {
  const res = await devAdmin<InvokeResult>("/dev/admin/invoke-gadget-debug-empty-env", {
    method: "POST",
    body: JSON.stringify({ gadgetId, path, method, body }),
  });
  console.log(`  invoke-gadget(${gadgetId}, ${path}) -> outer ${res.status}, inner ${res.body?.status} ${res.body?.body ?? ""}`);
  return res.body;
}

function parseRows(result: InvokeResult): Array<{ id: string; body: string }> {
  if (!result?.body) return [];
  try {
    return (JSON.parse(result.body).rows as Array<{ id: string; body: string }>) ?? [];
  } catch {
    return [];
  }
}

/** One self-contained "Gadget extends DurableObject" module — writes to
 *  and reads from a table it creates in ITS OWN facet's isolated SQLite
 *  (`this.ctx.storage.sql`, per-facet per the Dynamic Workers model — see
 *  this file's header). Deliberately uses the SAME table/column names
 *  across both gadget definitions below (`secret_notes`) so a leak
 *  between facets would be trivially visible as "gadget B can see gadget
 *  A's row", not masked by incidental naming differences. */
function gadgetModuleSource(): string {
  return `
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS secret_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)"
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/write" && request.method === "POST") {
      const { id, body } = await request.json();
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO secret_notes (id, body) VALUES (?, ?)",
        id,
        body
      );
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.pathname === "/read" && request.method === "GET") {
      const rows = [...this.ctx.storage.sql.exec("SELECT id, body FROM secret_notes")];
      return new Response(JSON.stringify({ rows }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }
}
`;
}

async function main(): Promise<void> {
  console.log(`Facet isolation drill — gadget-host worker at ${GADGET_HOST_URL}`);

  // -------------------------------------------------------------------
  // (0) Register two DISTINCT gadget definitions — same module source
  //     (deliberately), different gadget ids. Each will be loaded as its
  //     own facet under the same GadgetSupervisorDO instance.
  // -------------------------------------------------------------------
  section("(0) Register two gadget definitions");

  const gadgetAId = `drill-gadget-a-${Date.now()}`;
  const gadgetBId = `drill-gadget-b-${Date.now()}`;
  const compatibilityDate = "2026-08-01";
  const source = gadgetModuleSource();

  for (const id of [gadgetAId, gadgetBId]) {
    const { status, body } = await devAdmin("/dev/admin/register-gadget", {
      method: "POST",
      body: JSON.stringify({ id, kind: "headless", mainModule: "gadget.js", modules: { "gadget.js": source }, compatibilityDate }),
    });
    console.log(`  register-gadget(${id}) -> ${status}`);
    assert(status === 200, `registered gadget definition "${id}"`);
  }

  // -------------------------------------------------------------------
  // (a) Gadget A writes a private row into its own facet, then reads it
  //     back through its own facet.
  // -------------------------------------------------------------------
  section("(a) Gadget A writes + reads its own facet storage");

  const secretBody = `secret written by ${gadgetAId} at ${new Date().toISOString()}`;
  const writeA = await invokeGadget(gadgetAId, "/write", "POST", JSON.stringify({ id: "note-1", body: secretBody }));
  assert(writeA?.status === 200, "gadget A's facet accepted the write");

  const readAAfterWrite = parseRows(await invokeGadget(gadgetAId, "/read", "GET"));
  assert(readAAfterWrite.length === 1 && readAAfterWrite[0]?.body === secretBody, "gadget A reads back its own private row through its own facet");

  // -------------------------------------------------------------------
  // (b) Gadget B — a SEPARATE facet, same supervisor DO — reads the SAME
  //     table name and must see NOTHING gadget A wrote.
  // -------------------------------------------------------------------
  section("(b) Gadget B's facet cannot see gadget A's private row");

  const readBResult = await invokeGadget(gadgetBId, "/read", "GET");
  const readBRows = parseRows(readBResult);
  assert(readBResult?.status === 200, "gadget B's facet responded normally (its own table exists, empty)");
  assert(readBRows.length === 0, "gadget B's own copy of `secret_notes` is EMPTY — gadget A's row did not leak across facets");
  assert(
    !readBRows.some((row) => row.body === secretBody),
    "gadget B's facet storage does not contain gadget A's exact secret string anywhere",
  );

  // Cross-check: writing into gadget B's OWN facet (SAME row id, "note-1",
  // as gadget A used) and reading it back proves B's earlier empty read
  // was real isolation, not a broken/no-op facet.
  const bOwnBody = `secret written by ${gadgetBId} at ${new Date().toISOString()}`;
  await invokeGadget(gadgetBId, "/write", "POST", JSON.stringify({ id: "note-1", body: bOwnBody }));
  const readBAfterOwnWrite = parseRows(await invokeGadget(gadgetBId, "/read", "GET"));
  assert(
    readBAfterOwnWrite.length === 1 && readBAfterOwnWrite[0]?.body === bOwnBody,
    "gadget B's own facet storage genuinely works (writes its own row, reads it back) — B's earlier empty read was real isolation, not a broken facet",
  );

  // Re-read gadget A once more — proves A's row is still intact and
  // unaffected by B's independent write under the SAME id ("note-1").
  const readAAgain = parseRows(await invokeGadget(gadgetAId, "/read", "GET"));
  assert(
    readAAgain.length === 1 && readAAgain[0]?.body === secretBody,
    "gadget A's row (same id 'note-1') is UNCHANGED by gadget B's write under the same id — confirms two fully separate SQLite databases, not one shared table with row-level scoping",
  );

  // -------------------------------------------------------------------
  // (c) The supervisor DO's own SQLite must not contain either gadget's
  //     private table.
  // -------------------------------------------------------------------
  section("(c) Supervisor DO's own SQLite does not contain a gadget's private table");

  const tablesRes = await devAdmin<string[]>("/dev/admin/supervisor-tables", { method: "GET" });
  console.log(`  supervisor-tables -> ${tablesRes.status} ${JSON.stringify(tablesRes.body)}`);
  assert(tablesRes.status === 200, "supervisor-tables route responded 200");
  const supervisorTables = tablesRes.body ?? [];
  assert(!supervisorTables.includes("secret_notes"), "the supervisor DO's own SQLite has no `secret_notes` table — gadget facet storage did not leak into it");
  // `schema.ts`'s DDL_STATEMENTS' fixed table list, PLUS Miniflare's own
  // internal bookkeeping table (`__miniflare_do_name` — not application
  // data, added by the local-dev simulation layer itself, present on every
  // DO regardless of this worker's own schema; allow-listed explicitly
  // rather than silently ignored, so a genuinely unexpected table name
  // still fails this assertion loudly).
  const expectedSupervisorTables = [
    "__miniflare_do_name",
    "capability_grants",
    "capability_grant_requests",
    "gadget_action_log",
    "gadget_definitions",
    "gadget_doc_state",
    "gadget_pending_approvals",
    "gadget_schedules",
  ];
  const unexpected = supervisorTables.filter((name) => !expectedSupervisorTables.includes(name));
  assert(unexpected.length === 0, `every supervisor table is a known schema.ts table or Miniflare's own internal table (unexpected: ${JSON.stringify(unexpected)})`);

  // -------------------------------------------------------------------
  section("Summary");
  console.log(`  ${passCount} assertions passed, ${failCount} failed`);
  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Drill script crashed:", error);
  process.exit(1);
});
