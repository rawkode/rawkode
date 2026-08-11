// Fetch/scheduled handler for the gadget-host worker.
//
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md, plan
// §Gadgets (P4). REAL as of this pass: `GadgetSupervisorDO` (capability
// grants/requests, graph.query/graph.propose, gatekeeper.google.
// calendar.read, schedule.cron, facet loading/invocation via the real
// Dynamic Workers API — see gadget-supervisor-do.ts's file header for the
// facets-vs-fallback research this pass is built on).
//
// STILL NOT IMPLEMENTED (explicitly out of this pass's scope — see the
// task report's "what the next tasks need to know"): the actual headless
// morning-brief gadget code and the WKWebView UI-gadget host/bridge. This
// worker's `fetch()` handler has no PRODUCTION admin/approval-UI HTTP
// routes (mirrors gatekeeper-google's stance: the in-app approval UI that
// would call `GadgetSupervisorDO`'s RPC methods from a real user action is
// a separate, future native-app task) — every real capability here is
// reached via `GadgetSupervisorDO`'s own RPC surface, not HTTP. The one
// exception is the `/dev/admin/*` block below, which exists purely so a
// dev-only drill script running outside the Workers runtime has some way
// to reach that RPC surface at all (RPC methods are only callable from
// another Worker/DO holding a `DurableObjectStub`, never over plain HTTP)
// — see that block's own comment.
//
// `scheduled()` is real: the ONE static cron cadence declared in
// wrangler.jsonc drives `schedule-fanout.ts`'s tick — see that file's
// header for why this single tick (not a real per-gadget Cron Trigger) is
// the whole `schedule.cron` mechanism.

export { GadgetSupervisorDO } from "./gadget-supervisor-do";
import type { GadgetSupervisorDO } from "./gadget-supervisor-do";
// MUST be a top-level export of this module — `ctx.exports`/`this.ctx.
// exports`'s loopback-binding mechanism (`gadget-supervisor-do.ts`'s
// `invokeGadget`, via `gadget-env.ts`'s `buildGadgetEnv`) only covers
// top-level exports of the Worker's main module. See
// `gadget-capabilities-entrypoint.ts`'s header for the full capability-
// transport fix this is part of.
export { GadgetCapabilities } from "./gadget-capabilities-entrypoint";

interface Env {
  GADGET_SUPERVISOR_DO: DurableObjectNamespace<GadgetSupervisorDO>;
  // GADGET CODE STORAGE (Part 1) — see wrangler.jsonc's `r2_buckets` entry
  // and `gadget-code-loader.ts`'s header. Used directly by ONE dev-admin
  // route below (`/dev/admin/deploy-gadget-code`) to do the "upload bytes,
  // then register the pointer" two-step the production deploy flow needs
  // — see that route's own comment for why it lives here rather than as a
  // `GadgetSupervisorDO` RPC method (R2 access, unlike everything else this
  // worker does, isn't naturally a DO-owned concern).
  GADGET_CODE: R2Bucket;
  // DEV-ONLY — see the `/dev/admin/*` block below. Unset (falsy) in every
  // real `wrangler.jsonc` `vars` block committed to this repo, so these
  // routes 404 by default; a local `wrangler dev --var
  // ENABLE_DEV_ADMIN_ROUTES:true` run is the only way to turn them on.
  // Mirrors `workers/vault/src/index.ts`'s identical convention exactly —
  // see that file's header for the full rationale, not restated here.
  ENABLE_DEV_ADMIN_ROUTES?: string;
}

function defaultSupervisorStub(env: Env): DurableObjectStub<GadgetSupervisorDO> {
  const id = env.GADGET_SUPERVISOR_DO.idFromName("default");
  return env.GADGET_SUPERVISOR_DO.get(id);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // -----------------------------------------------------------------
    // DEV-ONLY DEBUG ROUTES — NOT part of gadget-host's production API
    // surface (this worker deliberately has none yet — see this file's
    // header). Added for `scripts/facet-isolation-drill.ts` (plan
    // §Gadgets: "Facet-to-facet storage isolation ... needs a real
    // `wrangler dev`/Miniflare integration test before it carries real
    // gadget code"), which needs some way to reach `GadgetSupervisorDO`'s
    // RPC methods from outside the Workers runtime — a thin pass-through
    // route is the only way in. Mirrors `workers/vault/src/index.ts`'s
    // `/dev/admin/*` block exactly (same `ENABLE_DEV_ADMIN_ROUTES`-gated,
    // off-by-default pattern — see that file's header for the full
    // rationale, not restated here). This worker has no Access-auth wiring
    // of its own yet to layer on top (every real route here is DO-RPC-only
    // today, per this file's header), so these are gated purely by the env
    // var, same posture vault's own dev routes fall back to once Access
    // verification passes — the point in both cases is "off by default in
    // every committed config, only reachable at all in an explicit local
    // dev session", not a second auth layer.
    if (url.pathname.startsWith("/dev/admin/")) {
      if (env.ENABLE_DEV_ADMIN_ROUTES !== "true") {
        return new Response("not found", { status: 404 });
      }
      const stub = defaultSupervisorStub(env);

      if (url.pathname === "/dev/admin/register-gadget" && request.method === "POST") {
        const body = (await request.json()) as {
          id: string;
          kind: "headless" | "ui";
          mainModule: string;
          modules: Record<string, string>;
          compatibilityDate: string;
        };
        const result = await stub.registerGadget(body.id, body.kind, body.mainModule, body.modules, body.compatibilityDate);
        return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/dev/admin/invoke-gadget" && request.method === "POST") {
        const body = (await request.json()) as { gadgetId: string; path: string; method?: string; body?: string };
        const result = await stub.invokeGadget(body.gadgetId, { path: body.path, method: body.method, body: body.body });
        return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Direct grant creation (`GadgetSupervisorDO.grantCapability` —
      // "exposed for operator/admin use ... and tests", that method's own
      // doc comment) reachable from outside the Workers runtime, same
      // reason every route in this block exists. Added for
      // `scripts/capability-transport-drill.ts`, which needs to grant (and
      // observe the pre-grant denial of) each capability type against a
      // REAL running gadget-host instance.
      if (url.pathname === "/dev/admin/grant-capability" && request.method === "POST") {
        const body = (await request.json()) as {
          gadgetId: string;
          capabilityType: import("./capability-types").CapabilityType;
          scope: import("./capability-types").CapabilityScope;
          grantedBy: string;
        };
        const result = await stub.grantCapability(body.gadgetId, body.capabilityType, body.scope, body.grantedBy);
        return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
      }
      // See `gadget-supervisor-do.ts`'s `debugInvokeGadgetWithEmptyEnv` doc
      // comment (HISTORICAL NOTE — RESOLVED) — this route used to be the
      // only way to reach a facet at all (the real `invoke-gadget` route
      // above threw `DataCloneError` on every call). That capability-
      // transport bug is fixed (`gadget-env.ts`/`gadget-capabilities-
      // entrypoint.ts`); this route is kept only for
      // `facet-isolation-drill.ts`'s narrower "storage isolation with no
      // capability surface" scenario, not as a workaround anymore.
      if (url.pathname === "/dev/admin/invoke-gadget-debug-empty-env" && request.method === "POST") {
        const body = (await request.json()) as { gadgetId: string; path: string; method?: string; body?: string };
        const result = await stub.debugInvokeGadgetWithEmptyEnv(body.gadgetId, { path: body.path, method: body.method, body: body.body });
        return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/dev/admin/supervisor-tables" && request.method === "GET") {
        const result = await stub.debugListOwnTableNames();
        return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
      }
      // -----------------------------------------------------------------
      // Part 1 (gadget code storage) + Part 2 (morning-brief gadget) dev
      // routes — added so `scripts/deploy-morning-brief.ts` and
      // `scripts/morning-brief-live-drill.ts` have a way to reach both the
      // R2 bucket (only bound to THIS worker's `env`, never to a script
      // running outside the Workers runtime) and `GadgetSupervisorDO`'s
      // RPC surface from a plain HTTP call, same reason every route in
      // this block exists.
      // -----------------------------------------------------------------
      if (url.pathname === "/dev/admin/deploy-gadget-code" && request.method === "POST") {
        // Does the "upload bytes, then register the pointer" two-step in
        // one route (rather than a raw `env.GADGET_CODE.put` route plus a
        // separate `registerGadgetCode` route) because the R2 key is
        // CONTENT-ADDRESSED (sha256 of the bundled source, matching the
        // plan's `blob_<sha256>` convention for R2 objects elsewhere in
        // this codebase — vault's blob store, gatekeeper-google's Gmail
        // attachments) and computing it needs the source bytes right here
        // anyway; splitting it into two routes would just move that
        // computation to the caller for no real benefit.
        const body = (await request.json()) as {
          id: string;
          kind: "headless" | "ui";
          mainModule: string;
          compatibilityDate: string;
          source: string;
        };
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.source));
        const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        const r2Key = `gadgets/${body.id}/${hex}.js`;
        await env.GADGET_CODE.put(r2Key, body.source);
        const result = await stub.registerGadgetCode(body.id, body.kind, body.mainModule, r2Key, body.compatibilityDate);
        return new Response(JSON.stringify({ r2Key, definition: result }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/dev/admin/register-schedule" && request.method === "POST") {
        const body = (await request.json()) as { gadgetId: string; intervalMinutes: number };
        const result = await stub.registerGadgetSchedule(body.gadgetId, body.intervalMinutes);
        return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/dev/admin/run-schedule-fanout-tick" && request.method === "POST") {
        const result = await stub.runScheduleFanoutTick();
        return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/dev/admin/list-pending-approvals" && request.method === "GET") {
        const gadgetId = url.searchParams.get("gadgetId") ?? undefined;
        const result = await stub.listPendingApprovals(gadgetId);
        return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }

    return new Response(
      "not found — GadgetSupervisorDO has no HTTP route surface; use its RPC methods " +
        "(registerGadget/requestCapabilityGrant/decideCapabilityGrantRequest/proposeGraphWrite/" +
        "confirmGraphProposal/registerGadgetSchedule/invokeGadget/...) instead.\n" +
        "Plan: /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md",
      { status: 404 },
    );
  },

  /** "Cron-triggered ... single supervisor-level cron tick" (plan §Gadgets'
   *  `schedule.cron` design, `schedule-fanout.ts`'s header) — the ONLY
   *  cadence this worker declares (`wrangler.jsonc`'s `triggers.crons`).
   *  Delegates entirely to `GadgetSupervisorDO.runScheduleFanoutTick()`. */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const stub = defaultSupervisorStub(env) as unknown as { runScheduleFanoutTick(): Promise<unknown> };
    await stub.runScheduleFanoutTick();
  },
};
