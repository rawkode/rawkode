#!/usr/bin/env bun
// DEV/OPERATOR TOOLING — the real deploy/registration flow for the
// `morning-brief` gadget (Part 2 of the gadgets-productivity pass), and the
// template for registering any FUTURE gadget through the same production
// code-storage path (Part 1).
//
// THE FLOW, END TO END:
//   1. BUNDLE — `gadgets/morning-brief/index.ts` (+ its local `./logic`
//      import) is bundled to a SINGLE, self-contained JS file via
//      `Bun.build` (`cloudflare:workers` marked `external` — it's a
//      workerd built-in module, resolved by the runtime the gadget's
//      facet actually runs in, not something to bundle in). One file
//      because the current R2-backed registry design (`../src/gadget-
//      code-loader.ts`) stores ONE source text per `r2Key` and maps it
//      to `mainModule` at load time — see that file's header. A future
//      gadget needing multiple R2-stored modules would need to extend
//      that design; this one doesn't.
//   2. UPLOAD + REGISTER — the bundled text is POSTed to the running
//      gadget-host instance's `/dev/admin/deploy-gadget-code` route
//      (`../src/index.ts`), which computes a content-addressed R2 key
//      (sha256 of the bundle, matching this codebase's `blob_<sha256>`
//      convention elsewhere), writes it to the `GADGET_CODE` bucket, and
//      calls `GadgetSupervisorDO.registerGadgetCode` to point the
//      `morning-brief` gadget id at it (bumping `codeVersion` on every
//      redeploy — `../src/gadget-definition-store.ts`).
//   3. GRANT CAPABILITIES — three grants, matching the task's explicit
//      scoping requirement (NOT unrestricted access):
//        - `graph.query` — `views: ["page"]` ONLY (the one view this
//          gadget's own logic calls, `gadgets/morning-brief/logic.ts`'s
//          `runMorningBrief`).
//        - `graph.propose` — `pagePrefixes: ["daily:"]`, `pageIDs: []`.
//          Scoped to daily pages only, per the task brief's explicit ask
//          — this gadget can NEVER propose a write to any other page,
//          enforced by `../src/graph-propose-capability.ts`'s
//          `isPageInScope`, not just by this script's own good behavior.
//        - `schedule.cron` — `minIntervalMinutes: 60` (a floor; see step
//          4 for the actual registered interval).
//   4. REGISTER SCHEDULE — `registerGadgetSchedule(gadgetId,
//      intervalMinutes)` directly (not via the gadget calling
//      `env.CAPABILITIES.scheduleRegister` itself — this is a one-time
//      deploy-time setup action, not something the gadget's own `/cron`
//      handler needs to do on every invocation). `intervalMinutes: 1440`
//      (once daily) for real operation; a newly registered schedule is
//      due IMMEDIATELY (`../src/schedule-store.ts`'s `registerSchedule`:
//      `nextDueAt = now`), so the very next fan-out tick (or a directly
//      triggered one, see `morning-brief-live-drill.ts`) picks it up
//      without waiting a full day.
//
// PRODUCTION FLOW vs. THIS SCRIPT — stated plainly, not overstated: this
// script talks to gadget-host's `/dev/admin/*` routes (`ENABLE_DEV_ADMIN_
// ROUTES`-gated, off by default in every committed `wrangler.jsonc`,
// same convention as every other dev-admin route in this worker — see
// `../src/index.ts`'s header). A REAL production deploy needs an
// equivalent, PROPERLY AUTHENTICATED admin path (either a real admin
// HTTP route behind Cloudflare Access, or a one-off `wrangler`-invoked
// script using a service-bound RPC connection) — building that auth layer
// is explicitly out of THIS task's scope (mirrors gatekeeper-google's own
// "the in-app approval UI is a separate, future native-app task" stance,
// `../src/index.ts`'s header). What this script proves and documents is
// the DATA FLOW (bundle -> content-addressed R2 upload -> registry pointer
// -> scoped grants -> schedule) — the exact same calls a production admin
// path would make, just reached over an unauthenticated dev route today.
//
// USAGE:
//   cd workers/gadget-host
//   npx wrangler dev --port 8788 --var ENABLE_DEV_ADMIN_ROUTES:true
//   # in a second terminal:
//   GADGET_HOST_URL=http://localhost:8788 bun scripts/deploy-morning-brief.ts

import { resolve } from "node:path";

const GADGET_HOST_URL = process.env.GADGET_HOST_URL ?? "http://localhost:8788";
export const MORNING_BRIEF_GADGET_ID = "morning-brief";
const MAIN_MODULE = "index.js";
const COMPATIBILITY_DATE = "2026-08-01";

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

/** Step 1 — bundles `gadgets/morning-brief/index.ts` (and its local
 *  `./logic` import) into one self-contained JS text. Exported so
 *  `morning-brief-live-drill.ts` can reuse it without shelling out to this
 *  script twice. */
export async function bundleMorningBrief(): Promise<string> {
  const entrypoint = resolve(import.meta.dir, "../gadgets/morning-brief/index.ts");
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
    external: ["cloudflare:workers"],
  });
  if (!result.success) {
    const messages = result.logs.map((log) => log.message).join("\n");
    throw new Error(`bundling gadgets/morning-brief/index.ts failed:\n${messages}`);
  }
  const output = result.outputs.find((o) => o.kind === "entry-point");
  if (!output) {
    throw new Error("bundling gadgets/morning-brief/index.ts produced no entry-point output");
  }
  return output.text();
}

/** Steps 2-4 — deploys the given (already-bundled) source as the
 *  `morning-brief` gadget's code, grants its three scoped capabilities,
 *  and registers its daily schedule. Exported so
 *  `morning-brief-live-drill.ts` can call this directly and then trigger a
 *  fan-out tick against the SAME running instance without re-shelling out. */
export async function deployMorningBrief(source: string): Promise<{ r2Key: string; codeVersion: number }> {
  const deployRes = await devAdmin<{ r2Key: string; definition: { codeVersion: number } }>("/dev/admin/deploy-gadget-code", {
    method: "POST",
    body: JSON.stringify({ id: MORNING_BRIEF_GADGET_ID, kind: "headless", mainModule: MAIN_MODULE, compatibilityDate: COMPATIBILITY_DATE, source }),
  });
  if (deployRes.status !== 200) {
    throw new Error(`deploy-gadget-code failed: ${deployRes.status} ${JSON.stringify(deployRes.body)}`);
  }
  console.log(`  deployed morning-brief code -> r2Key=${deployRes.body.r2Key}, codeVersion=${deployRes.body.definition.codeVersion}`);

  const grants: Array<{ capabilityType: string; scope: Record<string, unknown> }> = [
    { capabilityType: "graph.query", scope: { capabilityType: "graph.query", views: ["page"] } },
    { capabilityType: "graph.propose", scope: { capabilityType: "graph.propose", pageIDs: [], pagePrefixes: ["daily:"] } },
    { capabilityType: "schedule.cron", scope: { capabilityType: "schedule.cron", minIntervalMinutes: 60 } },
  ];
  for (const grant of grants) {
    const res = await devAdmin("/dev/admin/grant-capability", {
      method: "POST",
      body: JSON.stringify({ gadgetId: MORNING_BRIEF_GADGET_ID, capabilityType: grant.capabilityType, scope: grant.scope, grantedBy: "deploy-morning-brief-script" }),
    });
    if (res.status !== 200) {
      throw new Error(`grant-capability(${grant.capabilityType}) failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    console.log(`  granted ${grant.capabilityType} (${JSON.stringify(grant.scope)})`);
  }

  const scheduleRes = await devAdmin<{ id: string; intervalMinutes: number }>("/dev/admin/register-schedule", {
    method: "POST",
    body: JSON.stringify({ gadgetId: MORNING_BRIEF_GADGET_ID, intervalMinutes: 1440 }),
  });
  if (scheduleRes.status !== 200) {
    throw new Error(`register-schedule failed: ${scheduleRes.status} ${JSON.stringify(scheduleRes.body)}`);
  }
  console.log(`  registered daily schedule -> ${scheduleRes.body.id} (every ${scheduleRes.body.intervalMinutes}m, due immediately)`);

  return { r2Key: deployRes.body.r2Key, codeVersion: deployRes.body.definition.codeVersion };
}

async function main(): Promise<void> {
  console.log(`Deploying morning-brief gadget to ${GADGET_HOST_URL}`);
  console.log("(1) Bundling gadgets/morning-brief/index.ts...");
  const source = await bundleMorningBrief();
  console.log(`  bundled ${source.length} bytes`);

  console.log("(2)-(4) Uploading, registering, granting capabilities, scheduling...");
  const result = await deployMorningBrief(source);

  console.log("\nDone.");
  console.log(`  gadgetId=${MORNING_BRIEF_GADGET_ID} r2Key=${result.r2Key} codeVersion=${result.codeVersion}`);
  console.log("  Trigger a fan-out tick to run it now: POST /dev/admin/run-schedule-fanout-tick");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("deploy-morning-brief crashed:", error);
    process.exit(1);
  });
}
