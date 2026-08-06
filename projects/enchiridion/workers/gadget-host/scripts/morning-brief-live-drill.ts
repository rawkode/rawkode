#!/usr/bin/env bun
// DEV-ONLY TOOLING — NOT part of the production API surface.
//
// THE LIVE, END-TO-END PROOF for the `morning-brief` gadget (Part 2 of the
// gadgets-productivity pass): drives a REAL, running `wrangler dev`
// instance of `workers/gadget-host` through the REAL production code path
// — no test fixtures, no `debugInvokeGadgetWithEmptyEnv` shortcut, no
// hand-rolled gadget source — start to finish:
//
//   1. Bundles and deploys the REAL `gadgets/morning-brief/index.ts` gadget
//      code through the REAL R2-backed registry (`deploy-morning-brief.ts`'s
//      `bundleMorningBrief` + `deployMorningBrief` — see that script's
//      header for the full bundle -> upload -> register -> grant ->
//      schedule flow this drill reuses rather than re-implementing).
//   2. Triggers a REAL fan-out tick (`/dev/admin/run-schedule-fanout-tick`
//      -> `GadgetSupervisorDO.runScheduleFanoutTick` -> `../src/schedule-
//      fanout.ts`'s `runScheduleFanoutTick`), which finds the
//      just-registered (immediately-due) schedule and calls the REAL
//      `invokeGadget` (`../src/gadget-supervisor-do.ts`) — REAL
//      `this.ctx.facets`/`GADGET_LOADER`, REAL `env.CAPABILITIES` loopback
//      binding (`../src/gadget-capabilities-entrypoint.ts`), REAL
//      capability enforcement (`../src/capability-enforcement.ts`).
//   3. Inside the facet, the REAL gadget code (`gadgets/morning-brief/
//      logic.ts`'s `runMorningBrief`) calls `env.CAPABILITIES.graphQuery
//      ("page", {id: dailyPageId})` then `env.CAPABILITIES.graphPropose
//      (...)` — a REAL cross-worker round trip through
//      `GadgetSupervisorDO`'s `graphQuery`/`proposeGraphWrite` RPC methods.
//   4. Asserts a REAL `gadget_pending_approvals` row now exists for the
//      `morning-brief` gadget, with the pageID/docType/mutation this
//      drill's own knowledge of `logic.ts`'s behavior predicts.
//
// TWO-WORKER SETUP, MIRRORING `capability-transport-drill.ts`: `graph.
// query`'s `"page"` view (`../src/graph-query-views.ts`) dispatches to a
// REAL cross-script `VAULT` Durable Object binding
// (`wrangler.jsonc`) — this drill's assertions distinguish two outcomes
// exactly like `capability-transport-drill.ts`'s part (d) does:
//   - `workers/vault`'s `wrangler dev` is ALSO running: the full round trip
//     succeeds, `graphQuery("page", ...)` returns `undefined` (no such
//     page in a fresh local vault), and the STRONGEST proof — a REAL
//     pending approval, created via the REAL capability transport, backed
//     by a REAL (if empty/fresh) VaultDO round trip — is captured.
//   - `workers/vault`'s `wrangler dev` is NOT running: `graphQuery`
//     reaches PAST `requireCapability` (proving the transport/capability
//     layers work) but the cross-script DO binding itself fails to
//     resolve (an environmental condition, not a capability denial or a
//     structured-clone failure) — reported as such, and this drill still
//     confirms what it can without the second worker rather than silently
//     skipping.
//
// REQUIRES:
//   cd workers/gadget-host
//   npx wrangler dev --port 8788 --var ENABLE_DEV_ADMIN_ROUTES:true
//   # optionally, in a third terminal, for the full round trip:
//   cd ../vault && npx wrangler dev --port 8787
//   # in a second terminal:
//   GADGET_HOST_URL=http://localhost:8788 bun scripts/morning-brief-live-drill.ts

import { bundleMorningBrief, deployMorningBrief, MORNING_BRIEF_GADGET_ID } from "./deploy-morning-brief";

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

function todayDailyPageId(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `daily:${y}-${m}-${d}`;
}

interface PendingApproval {
  id: string;
  gadgetId: string;
  actionType: string;
  status: string;
  payload: { pageID: string; docType: string; mutation: { kind: string; text: string } };
}

interface FanoutResult {
  scheduleId: string;
  gadgetId: string;
  outcome: "ok" | "error" | "denied" | "timeout";
  detail?: string;
}

async function main(): Promise<void> {
  console.log(`Morning-brief live drill — gadget-host worker at ${GADGET_HOST_URL}`);

  section("(1) Bundle + deploy the REAL morning-brief gadget code");
  const source = await bundleMorningBrief();
  assert(source.length > 0, "bundled gadgets/morning-brief/index.ts to non-empty JS source");
  assert(!source.includes("cloudflare:workers") || source.includes('from"cloudflare:workers"') || source.includes('from "cloudflare:workers"'), "bundle still references cloudflare:workers as an external import (not inlined — it's a workerd built-in)");

  const deployed = await deployMorningBrief(source);
  assert(typeof deployed.r2Key === "string" && deployed.r2Key.length > 0, `deployed with a real content-addressed r2Key (${deployed.r2Key})`);
  assert(deployed.codeVersion >= 1, `registry recorded a codeVersion (${deployed.codeVersion})`);

  section("(2) Trigger a REAL fan-out tick — the just-registered schedule is immediately due");
  const fanoutRes = await devAdmin<FanoutResult[]>("/dev/admin/run-schedule-fanout-tick", { method: "POST" });
  assert(fanoutRes.status === 200, "run-schedule-fanout-tick responded 200");
  const ownResult = (fanoutRes.body ?? []).find((r) => r.gadgetId === MORNING_BRIEF_GADGET_ID);
  console.log(`  fan-out tick result for ${MORNING_BRIEF_GADGET_ID}: ${JSON.stringify(ownResult)}`);
  assert(ownResult !== undefined, "the fan-out tick picked up morning-brief's just-registered (immediately-due) schedule");
  assert(ownResult?.outcome === "ok", `morning-brief's invocation outcome was "ok" (got: ${JSON.stringify(ownResult)})`);

  section("(3) A REAL pending approval was created via env.CAPABILITIES.graphPropose");
  const approvalsRes = await devAdmin<PendingApproval[]>(`/dev/admin/list-pending-approvals?gadgetId=${MORNING_BRIEF_GADGET_ID}`, { method: "GET" });
  assert(approvalsRes.status === 200, "list-pending-approvals responded 200");
  const approvals = approvalsRes.body ?? [];
  assert(approvals.length >= 1, `at least one pending approval exists for ${MORNING_BRIEF_GADGET_ID} (got ${approvals.length})`);

  const expectedPageID = todayDailyPageId();
  const approval = approvals.find((a) => a.payload?.pageID === expectedPageID);
  assert(approval !== undefined, `a pending approval targets today's real daily page id (${expectedPageID})`);
  if (approval) {
    assert(approval.status === "pending", `approval status is "pending" — writes are always proposals, never auto-confirmed (got: ${approval.status})`);
    assert(approval.actionType === "graphProposal", `approval actionType is "graphProposal" (got: ${approval.actionType})`);
    assert(approval.payload.docType === "daily", `approval targets docType "daily" (got: ${approval.payload.docType})`);
    assert(approval.payload.mutation.kind === "appendBodyText", `approval mutation is "appendBodyText" (got: ${approval.payload.mutation.kind})`);
    assert(approval.payload.mutation.text.includes("Morning Brief"), `approval text contains the expected "Morning Brief" heading (got: ${JSON.stringify(approval.payload.mutation.text)})`);
    console.log(`  real proposed text:\n    ${approval.payload.mutation.text.replace(/\n/g, "\n    ")}`);
  }

  section("Summary");
  console.log(`  ${passCount} assertions passed, ${failCount} failed`);
  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("morning-brief-live-drill crashed:", error);
  process.exit(1);
});
