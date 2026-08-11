#!/usr/bin/env bun
// DEV-ONLY TOOLING — NOT part of the production API surface.
//
// THE CAPABILITY-TRANSPORT FIX, PROVEN LIVE (not via
// `debugInvokeGadgetWithEmptyEnv`'s workaround — the REAL `invokeGadget`
// path, the REAL `WorkerLoader`/facet transport, the REAL `env.CAPABILITIES`
// loopback binding). See `gadget-env.ts`'s and `gadget-capabilities-
// entrypoint.ts`'s file headers for the full diagnosis/fix writeup this
// script verifies:
//
//   - OLD (broken): `buildGadgetEnv` returned a plain object of bare async
//     function closures placed directly on `WorkerLoaderWorkerCode.env`.
//     Every real `invokeGadget` call threw `DataCloneError: async
//     graphQuery(...) {...} could not be cloned` — no gadget capability
//     had ever actually worked end-to-end, only in unit tests that call the
//     closures directly (bypassing the Worker Loader boundary entirely).
//   - NEW (this fix): `env` carries ONE loopback Service Binding
//     (`CAPABILITIES`, `ctx.exports.GadgetCapabilities({props})`) to a real
//     `WorkerEntrypoint` (`gadget-capabilities-entrypoint.ts`) — Cloudflare's
//     own documented mechanism for a live, callable value at exactly this
//     position (`developers.cloudflare.com/workers/runtime-apis/bindings/
//     worker-loader/`'s `env` field: "Service Bindings, including loopback
//     bindings from `ctx.exports`").
//
// WHAT THIS SCRIPT PROVES, end to end, through the REAL `invoke-gadget` dev
// route (`index.ts`, which calls `GadgetSupervisorDO.invokeGadget` —
// NOT `invoke-gadget-debug-empty-env`):
//   (a) BEFORE any capability grant exists, a gadget calling
//       `env.CAPABILITIES.scheduleRegister(...)` gets a REAL
//       `CapabilityDeniedError` message back through the transport — proves
//       the call reached `requireCapability` inside `GadgetSupervisorDO`,
//       not a `DataCloneError` or any other structured-clone failure.
//   (b) AFTER granting `schedule.cron`, the SAME gadget code, SAME facet,
//       calling the SAME `env.CAPABILITIES.scheduleRegister(...)`, gets back
//       a REAL `GadgetSchedule` row (id/gadgetId/intervalMinutes/...) — a
//       genuine round trip through the Worker Loader boundary, the loopback
//       RPC channel, `requireCapability`, and `schedule-store.ts`'s SQLite
//       insert, landing back in the gadget's own `fetch()` response.
//   (c) The identical before/after pattern repeated for `graph.propose`
//       (`env.CAPABILITIES.graphPropose(...)`) — a SEPARATE capability
//       type, SEPARATE underlying `GadgetSupervisorDO` RPC method
//       (`proposeGraphWrite`), proving this isn't one lucky code path but
//       the general transport working for the capability surface as a
//       whole.
//   (d) `graph.query` (`env.CAPABILITIES.graphQuery(...)`) attempted too —
//       denied identically before a grant (same proof as (a)/(c)); after
//       granting, the call reaches PAST `requireCapability` and attempts
//       the real cross-worker dispatch to VaultDO (`graph-query-
//       capability.ts`'s `executeGraphQuery` -> `GRAPH_QUERY_VIEWS[...]
//       .execute` -> `GadgetVaultAccessorStub`). Whether that dispatch
//       itself succeeds depends on whether `workers/vault`'s `wrangler dev`
//       is ALSO running locally in this session (a real `VAULT` cross-script
//       DO binding, `wrangler.jsonc`) — this script reports which case it
//       observed rather than assuming one. Either way, the assertion that
//       matters for THIS bug is unconditional: the result is never
//       `DataCloneError`/any structured-clone failure.
//
// REQUIRES: a running `wrangler dev` instance of `workers/gadget-host`,
// started with `--var ENABLE_DEV_ADMIN_ROUTES:true` (same convention as
// `facet-isolation-drill.ts` — see that script's header). Optionally, a
// second `wrangler dev` instance of `workers/vault` (name `enchiridion-vault`,
// matching this worker's `VAULT` cross-script binding) running concurrently
// for part (d)'s full round trip — NOT required for parts (a)-(c), which
// are this script's primary, unconditional proof:
//
//   cd workers/gadget-host
//   npx wrangler dev --port 8788 --var ENABLE_DEV_ADMIN_ROUTES:true
//   # optionally, in a third terminal, for part (d)'s full round trip:
//   cd ../vault && npx wrangler dev --port 8787
//   # in a second terminal:
//   GADGET_HOST_URL=http://localhost:8788 bun scripts/capability-transport-drill.ts

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

/** Dispatches one request into a gadget's facet via the REAL
 *  `invoke-gadget` route (`GadgetSupervisorDO.invokeGadget` — the exact
 *  path a real gadget call takes, `env.CAPABILITIES` and all — see this
 *  file's header for why this is deliberately NOT
 *  `invoke-gadget-debug-empty-env`). */
async function invokeGadget(gadgetId: string, path: string, method: string, body?: string): Promise<InvokeResult> {
  const res = await devAdmin<InvokeResult>("/dev/admin/invoke-gadget", {
    method: "POST",
    body: JSON.stringify({ gadgetId, path, method, body }),
  });
  console.log(`  invoke-gadget(${gadgetId}, ${path}) -> outer ${res.status}, inner ${res.body?.status} ${res.body?.body ?? ""}`);
  return res.body;
}

function parseInner(result: InvokeResult): { ok: boolean; result?: unknown; error?: string } {
  if (!result?.body) return { ok: false, error: "<empty response body>" };
  try {
    return JSON.parse(result.body) as { ok: boolean; result?: unknown; error?: string };
  } catch {
    return { ok: false, error: `<unparsable body: ${result.body}>` };
  }
}

/** The FAILURE SIGNATURE this whole drill exists to rule out — a
 *  structured-clone failure anywhere in the response text (the outer HTTP
 *  status, the facet's own error message, or a Worker Loader-level
 *  rejection) means the OLD bug reproduced; this script fails loudly if it
 *  ever sees it, on ANY call, granted or not. */
function assertNoStructuredCloneFailure(label: string, raw: string): void {
  const lower = raw.toLowerCase();
  assert(
    !lower.includes("dataclone") && !lower.includes("could not be cloned"),
    `${label}: response contains no DataCloneError/structured-clone-failure text (the exact bug this drill proves fixed)`,
  );
}

/** One self-contained "Gadget extends DurableObject" module — calls
 *  `env.CAPABILITIES`'s real methods (the whole point of this drill) and
 *  reports success/failure as JSON, never throwing out of `fetch()` itself,
 *  so a capability denial is a normal 200 response this script can inspect
 *  rather than an opaque 5xx. */
function gadgetModuleSource(): string {
  return `
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  async callCapability(fn) {
    try {
      const result = await fn();
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    } catch (error) {
      return new Response(
        JSON.stringify({ ok: false, error: (error && error.message) ? error.message : String(error) }),
        { status: 200 }
      );
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/schedule-register") {
      return this.callCapability(() => this.env.CAPABILITIES.scheduleRegister(60));
    }
    if (url.pathname === "/graph-propose") {
      return this.callCapability(() =>
        this.env.CAPABILITIES.graphPropose({
          pageID: "daily:2026-08-07",
          docType: "daily",
          mutation: { kind: "appendBodyText", text: "capability-transport-drill: real gadget wrote this via env.CAPABILITIES.graphPropose" },
        })
      );
    }
    if (url.pathname === "/graph-query") {
      return this.callCapability(() => this.env.CAPABILITIES.graphQuery("nodesByTag", { tagID: "task" }));
    }
    return new Response("not found", { status: 404 });
  }
}
`;
}

async function main(): Promise<void> {
  console.log(`Capability-transport drill (REAL invokeGadget, REAL env.CAPABILITIES) — gadget-host worker at ${GADGET_HOST_URL}`);

  section("(0) Register one gadget definition");
  const gadgetId = `transport-drill-gadget-${Date.now()}`;
  const compatibilityDate = "2026-08-01";
  const { status: registerStatus } = await devAdmin("/dev/admin/register-gadget", {
    method: "POST",
    body: JSON.stringify({ id: gadgetId, kind: "headless", mainModule: "gadget.js", modules: { "gadget.js": gadgetModuleSource() }, compatibilityDate }),
  });
  console.log(`  register-gadget(${gadgetId}) -> ${registerStatus}`);
  assert(registerStatus === 200, "registered gadget definition");

  // -------------------------------------------------------------------
  // (a) schedule.cron — BEFORE any grant: real denial, not DataCloneError.
  // -------------------------------------------------------------------
  section("(a) schedule.cron BEFORE grant — real CapabilityDeniedError through the REAL transport");

  const beforeGrantRaw = await invokeGadget(gadgetId, "/schedule-register", "GET");
  assertNoStructuredCloneFailure("schedule-register (before grant)", beforeGrantRaw?.body ?? "");
  const beforeGrant = parseInner(beforeGrantRaw);
  assert(beforeGrant.ok === false, "scheduleRegister denied before any grant exists (env.CAPABILITIES reached the real supervisor, not a clone failure)");
  assert(
    typeof beforeGrant.error === "string" && beforeGrant.error.includes("capability denied"),
    `denial reason names the real capability-enforcement path (got: ${JSON.stringify(beforeGrant.error)})`,
  );

  // -------------------------------------------------------------------
  // (b) schedule.cron — AFTER granting: a real GadgetSchedule row back.
  // -------------------------------------------------------------------
  section("(b) schedule.cron AFTER grant — a real GadgetSchedule row round-trips through env.CAPABILITIES");

  const { status: grantScheduleStatus } = await devAdmin("/dev/admin/grant-capability", {
    method: "POST",
    body: JSON.stringify({
      gadgetId,
      capabilityType: "schedule.cron",
      scope: { capabilityType: "schedule.cron", minIntervalMinutes: 30 },
      grantedBy: "capability-transport-drill",
    }),
  });
  assert(grantScheduleStatus === 200, "granted schedule.cron");

  const afterGrantRaw = await invokeGadget(gadgetId, "/schedule-register", "GET");
  assertNoStructuredCloneFailure("schedule-register (after grant)", afterGrantRaw?.body ?? "");
  const afterGrant = parseInner(afterGrantRaw);
  assert(afterGrant.ok === true, "scheduleRegister succeeded once granted");
  const scheduleRow = afterGrant.result as { id?: string; gadgetId?: string; intervalMinutes?: number } | undefined;
  assert(typeof scheduleRow?.id === "string" && scheduleRow.id.length > 0, `got back a real GadgetSchedule row with an id (${JSON.stringify(scheduleRow)})`);
  assert(scheduleRow?.gadgetId === gadgetId, "the returned schedule row's gadgetId matches this gadget (env.CAPABILITIES bound the right identity)");
  assert(scheduleRow?.intervalMinutes === 60, "the returned schedule row's intervalMinutes matches what the gadget code requested (60)");

  // -------------------------------------------------------------------
  // (c) graph.propose — same before/after pattern, a DIFFERENT capability
  //     and a DIFFERENT underlying GadgetSupervisorDO RPC method.
  // -------------------------------------------------------------------
  section("(c) graph.propose BEFORE/AFTER grant — the transport works for a second, independent capability");

  const proposeBeforeRaw = await invokeGadget(gadgetId, "/graph-propose", "GET");
  assertNoStructuredCloneFailure("graph-propose (before grant)", proposeBeforeRaw?.body ?? "");
  const proposeBefore = parseInner(proposeBeforeRaw);
  assert(proposeBefore.ok === false, "graphPropose denied before any graph.propose grant exists");

  const { status: grantProposeStatus } = await devAdmin("/dev/admin/grant-capability", {
    method: "POST",
    body: JSON.stringify({
      gadgetId,
      capabilityType: "graph.propose",
      scope: { capabilityType: "graph.propose", pageIDs: [], pagePrefixes: ["daily:"] },
      grantedBy: "capability-transport-drill",
    }),
  });
  assert(grantProposeStatus === 200, "granted graph.propose (pagePrefixes: [\"daily:\"])");

  const proposeAfterRaw = await invokeGadget(gadgetId, "/graph-propose", "GET");
  assertNoStructuredCloneFailure("graph-propose (after grant)", proposeAfterRaw?.body ?? "");
  const proposeAfter = parseInner(proposeAfterRaw);
  assert(proposeAfter.ok === true, "graphPropose succeeded once granted");
  const approval = proposeAfter.result as { status?: string; id?: string; gadgetId?: string } | undefined;
  assert(approval?.status === "pending", `got back a real pending approval record (${JSON.stringify(approval)})`);
  assert(approval?.gadgetId === gadgetId, "the returned approval's gadgetId matches this gadget");

  // -------------------------------------------------------------------
  // (d) graph.query — same before/after pattern; the "after" leg's full
  //     success additionally depends on workers/vault's wrangler dev also
  //     running (see this file's header) — reported, not assumed.
  // -------------------------------------------------------------------
  section("(d) graph.query BEFORE/AFTER grant");

  const queryBeforeRaw = await invokeGadget(gadgetId, "/graph-query", "GET");
  assertNoStructuredCloneFailure("graph-query (before grant)", queryBeforeRaw?.body ?? "");
  const queryBefore = parseInner(queryBeforeRaw);
  assert(queryBefore.ok === false, "graphQuery denied before any graph.query grant exists");

  const { status: grantQueryStatus } = await devAdmin("/dev/admin/grant-capability", {
    method: "POST",
    body: JSON.stringify({
      gadgetId,
      capabilityType: "graph.query",
      scope: { capabilityType: "graph.query", views: ["nodesByTag"] },
      grantedBy: "capability-transport-drill",
    }),
  });
  assert(grantQueryStatus === 200, "granted graph.query (views: [\"nodesByTag\"])");

  const queryAfterRaw = await invokeGadget(gadgetId, "/graph-query", "GET");
  assertNoStructuredCloneFailure("graph-query (after grant)", queryAfterRaw?.body ?? "");
  const queryAfter = parseInner(queryAfterRaw);
  if (queryAfter.ok === true) {
    console.log(`  graph.query fully round-tripped through a live VaultDO too: ${JSON.stringify(queryAfter.result)}`);
    assert(true, "graphQuery succeeded end-to-end (workers/vault's wrangler dev was also running) — the strongest possible proof");
  } else {
    console.log(`  graph.query reached past requireCapability and attempted the real cross-worker VaultDO dispatch, which failed for an environmental reason (expected unless workers/vault's wrangler dev is also running): ${queryAfter.error}`);
    assert(
      typeof queryAfter.error === "string" && !queryAfter.error.toLowerCase().includes("capability denied"),
      "graphQuery's post-grant failure (if any) is NOT a capability denial and NOT a clone failure — it got past requireCapability and attempted the real dispatch",
    );
  }

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
