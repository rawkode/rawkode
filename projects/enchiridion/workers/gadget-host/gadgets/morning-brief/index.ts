// @enchiridion/gadget morning-brief — the ACTUAL gadget entry point loaded
// as a DO facet (`../../src/gadget-supervisor-do.ts`'s `invokeGadget`).
//
// EXPORT CONTRACT (re-confirmed against `gadget-supervisor-do.ts`'s own
// header before writing this file, per the task brief's explicit ask):
// "gadget code loaded via `GADGET_LOADER.get` must itself export a class
// extending `DurableObject` (obtained via `worker.getDurableObjectClass
// ("Gadget")`) — a bare `{fetch(){...}}` module export is NOT
// facet-loadable" and "dispatches to the facet via `.fetch(request)`". This
// file exports EXACTLY that: a class named `Gadget` (the fixed name every
// `getDurableObjectClass("Gadget")` call site in this worker expects —
// see `gadget-supervisor-do.ts`'s `invokeGadget`/
// `debugInvokeGadgetWithEmptyEnv`, both of which hardcode that string)
// extending `DurableObject`, whose `fetch(request)` handles the one route
// `schedule-fanout.ts`'s tick actually calls: `{path: "/cron"}`.
//
// DEPLOY SHAPE: this file (plus `./logic.ts`) is BUNDLED to a single,
// self-contained JS file by `../../scripts/deploy-morning-brief.ts` before
// upload to the `GADGET_CODE` R2 bucket — see that script's header for the
// full bundle -> upload -> register -> grant -> schedule flow. The
// `import { ... } from "./logic"` below is a real, bundler-resolved local
// import (not type-only) — it survives into the bundled output, unlike the
// `import type` in `logic.ts` itself (fully erased, no runtime trace).
//
// NOT UNIT-TESTED HERE (same established convention as `../../src/
// gadget-supervisor-do.ts`'s own header): this file imports
// `cloudflare:workers`, unresolvable under plain `bun test` outside the
// Workers runtime. `./logic.ts`'s `runMorningBrief` carries every real
// decision this gadget makes and IS fully unit-tested (`logic.test.ts`)
// with a mocked `MorningBriefCapabilities` — this file is intentionally a
// thin wrapper with nothing else to test, mirroring `gadget-capabilities-
// entrypoint.ts`'s "thin forwarder, logic lives elsewhere" shape.

import { DurableObject } from "cloudflare:workers";
import { runMorningBrief, type MorningBriefCapabilities } from "./logic";

interface Env {
  /** The ENTIRE surface this gadget can reach beyond its own isolated
   *  SQLite — see `../../src/gadget-env.ts`'s `GadgetCapabilityEnv` header
   *  for why this is the only binding any gadget ever gets. */
  CAPABILITIES: MorningBriefCapabilities;
}

export class Gadget extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/cron") {
      try {
        const result = await runMorningBrief(this.env.CAPABILITIES, new Date());
        return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { "content-type": "application/json" } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return new Response(JSON.stringify({ ok: false, error: message }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  }
}
