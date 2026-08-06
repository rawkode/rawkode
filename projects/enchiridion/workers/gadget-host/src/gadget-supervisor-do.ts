// GadgetSupervisorDO — plan §Gadgets: "Gadget = dynamic worker loaded as a
// DO facet under GadgetSupervisorDO, isolated SQLite for private state."
//
// FACETS-VS-FALLBACK DECISION (plan Risk #2, "DO facets are beta"): this
// class uses the REAL Dynamic Workers / DO Facets API —
// `this.ctx.facets.get/abort/delete` (`DurableObjectFacets`,
// `@cloudflare/workers-types`) and `this.env.GADGET_LOADER.get(codeId,
// callback)` (`WorkerLoader`/`WorkerLoaderWorkerCode`) — NOT the deploy-free
// fallback. This was a researched decision, not an assumption:
//   - Both APIs are confirmed real and exactly this shaped in this repo's
//     own installed `@cloudflare/workers-types@4.20260702.1`
//     (`DurableObjectFacets`, `FacetStartupOptions`, `WorkerLoader`,
//     `WorkerLoaderWorkerCode`, `WorkerStub.getDurableObjectClass`) — not
//     just cited from memory, grepped directly out of `node_modules`.
//   - Cross-checked against developers.cloudflare.com/dynamic-workers/
//     (the facets usage page and the Worker Loader binding page): method
//     signatures match the installed types exactly.
//   - The ONE real caveat, confirmed from Cloudflare's own docs: "The
//     Worker Loader API is available in local development with Wrangler
//     and workerd. But to run dynamic Workers on Cloudflare, you must sign
//     up for the closed beta." That gate is a DEPLOY-time/account-time
//     concern (an actual `wrangler deploy` to a real Cloudflare account
//     needs the beta), not a build/type/local-dev blocker — `wrangler dev`
//     and this worker's own `tsc --build`/`bun test` are unaffected by it.
//   - This class follows the EXACT SAME "thin DO class, not exercised by
//     `bun test`, smoke-test with `wrangler dev` before it carries real
//     traffic" convention `workers/vault/src/vault-do.ts` and
//     `workers/gatekeeper-google/src/google-account-do.ts` ALREADY use for
//     Workers-runtime-only code this sandbox has no live account to drive
//     — i.e. "can't verify against a live Cloudflare account in this
//     sandbox" is an accepted, already-precedented constraint in this
//     codebase, not something unique to facets that should trigger the
//     fallback. `wrangler dev`/build failing "for reasons clearly tied to
//     facets not being available" (the task brief's actual fallback
//     trigger) never happened — the config and types are accepted as
//     valid by this worker's own `tsc --build` (see the task report).
// Conclusion: real facets are used; the fallback design (deploy-free,
// R2-fetched generic isolate) is NOT built, since it wasn't needed — but is
// still documented here as the standing Risk #2 mitigation if the closed
// beta application is ever denied: swap `this.ctx.facets`/`GADGET_LOADER`
// calls in `invokeGadget` below for a fetch to a generic pre-provisioned
// isolate that reads gadget code from R2 at request time; every OTHER
// module in this worker (capability store/enforcement, approvals, schedule
// fan-out) is already facets-API-agnostic and needs no change either way.
//
// GADGET CODE SHAPE REQUIREMENT (for the next tasks — headless automation,
// UI gadget host): because facets exist specifically to give dynamically
// loaded code ISOLATED SQLITE (plan: "isolated SQLite per facet"), and that
// is a Durable Object feature, gadget code loaded via `GADGET_LOADER.get`
// must itself export a class extending `DurableObject` (obtained via
// `worker.getDurableObjectClass("<ClassName>")`) — a bare `{fetch(){...}}`
// module export is NOT facet-loadable. `invokeGadget` below dispatches to
// the facet via `.fetch(request)` (a `Fetcher` stub); RPC-shaped dispatch
// (calling named methods instead of `fetch`) is possible too
// (`WorkerStub.getDurableObjectClass` is RPC-branded) but out of this
// pass's scope — headless automations and the UI-gadget WKWebView bridge
// both work fine over `fetch()`-shaped request/response, matching how the
// plan describes the UI gadget's "narrow postMessage bridge" translating
// to HTTP-shaped calls at the native-app boundary anyway.
//
// Same "deliberately thin, every real decision lives in a plain
// DO-runtime-independent module" split as `vault-do.ts`/`google-account-
// do.ts` — see each imported module's own file for its real logic/tests.

import { DurableObject } from "cloudflare:workers";
import type { CalendarEventSummaryDTO } from "@enchiridion/gadget-gatekeeper-google-rpc-contract";
import { readUpcomingCalendarEvents } from "./calendar-read-capability";
import { createGrant, listGrants, revokeGrant } from "./capability-store";
import type { CapabilityGrant, CapabilityGrantRequest, CapabilityScope, CapabilityType, GrantRequestStatus } from "./capability-types";
import type { CalendarReadStub } from "./gatekeeper-calendar-client";
import { resolveGadgetModules } from "./gadget-code-loader";
import { buildGadgetEnv, type GadgetCapabilitiesExports } from "./gadget-env";
import { upsertGadgetDefinition, getGadgetDefinition, listGadgetDefinitions, type GadgetDefinition, type GadgetKind } from "./gadget-definition-store";
import { confirmGraphProposal, getApproval, listPendingApprovals, proposeGraphWrite, type GadgetPendingApproval } from "./graph-propose-capability";
import type { GraphProposalPayload } from "./gadget-materialized-doc";
import { executeGraphQuery } from "./graph-query-capability";
import { decideGrantRequest, getGrantRequest, listGrantRequests, requestCapabilityGrant, type DecideGrantRequestOutcome } from "./grant-request-store";
import { initializeSchema, type SqlExecutor } from "./schema";
import { registerGadgetSchedule } from "./schedule-capability";
import { GadgetInvocationTimeoutError, runScheduleFanoutTick, type ScheduleFanoutResult } from "./schedule-fanout";
import { disableAllSchedulesForGadget, listSchedules, setScheduleEnabled, type GadgetSchedule } from "./schedule-store";
import { defaultVaultAccessorStub, type GadgetVaultAccessorStub, type VaultClientEnv } from "./vault-accessor-client";

/** Fix 4 (adversarial review: "`invokeGadget` calls `await facet.fetch(...)`
 *  with no `AbortController`/timeout — a hung gadget facet blocks
 *  indefinitely ... could stall every other due gadget behind it"). 30
 *  seconds: generously above the cost of a well-behaved gadget's own
 *  capability calls (`graphQuery`/`graphPropose`/`calendarListUpcomingEvents`/
 *  `scheduleRegister` are all themselves bounded, in-process DO SQLite/RPC
 *  work, not slow network calls), but comfortably under the 5-minute gap
 *  between fan-out ticks (`wrangler.jsonc`'s `triggers.crons`) — so even a
 *  fully sequential tick (`schedule-fanout.ts`'s header on why it doesn't
 *  parallelize) that happens to hit several hung gadgets in a row still
 *  finishes well inside its own tick window rather than running into the
 *  next one, and any ONE hung gadget can only ever cost this fixed 30s
 *  slice of the tick, never the whole thing. */
const GADGET_INVOCATION_TIMEOUT_MS = 30_000;

interface Env extends VaultClientEnv {
  /** Dynamic Workers binding (plan Risk #2) — see this file's header for
   *  the facets-vs-fallback research. */
  GADGET_LOADER: WorkerLoader;
  /** Named-entrypoint Service Binding to gatekeeper-google's
   *  `CalendarReadModel` — see wrangler.jsonc's comment and
   *  `gatekeeper-calendar-client.ts`'s file header. */
  GATEKEEPER_GOOGLE: CalendarReadStub;
  /** R2 bucket holding PRODUCTION gadget code bytes (`gadget-definition-
   *  store.ts`'s "shape (b)" rows point into this bucket via their
   *  `r2Key`) — see wrangler.jsonc's comment for the bucket-ownership
   *  rationale (mirrors `workers/gatekeeper-google/wrangler.jsonc`'s
   *  `GMAIL_ATTACHMENTS` bucket: its own dedicated bucket, not shared with
   *  vault's `enchiridion-blobs`, for the same "different lifecycle,
   *  independent blast radius" reasons that file documents). Typed as the
   *  real `@cloudflare/workers-types` `R2Bucket` here — `gadget-code-
   *  loader.ts`'s `resolveGadgetModules` takes the narrower structural
   *  `R2LikeBucket` instead (see that file's header on why), and a real
   *  `R2Bucket` satisfies it for free. */
  GADGET_CODE: R2Bucket;
}

export class GadgetSupervisorDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeSchema(this.sql);
  }

  private get sql(): SqlExecutor {
    // Same narrowing-cast pattern as `vault-do.ts`/`google-account-do.ts`'s
    // `sql` getters — see either's comment for the full rationale.
    return this.ctx.storage.sql as unknown as SqlExecutor;
  }

  private get vault(): GadgetVaultAccessorStub {
    return defaultVaultAccessorStub(this.env);
  }

  // ---------------------------------------------------------------------
  // Gadget code registration (data model only — see gadget-definition-
  // store.ts's header)
  // ---------------------------------------------------------------------

  async registerGadget(
    id: string,
    kind: GadgetKind,
    mainModule: string,
    modules: Record<string, string>,
    compatibilityDate: string,
  ): Promise<GadgetDefinition> {
    return upsertGadgetDefinition(this.sql, { id, kind, mainModule, modules, compatibilityDate }, Date.now());
  }

  /** THE PRODUCTION registration path (`gadget-definition-store.ts`'s
   *  "shape (b)") — `r2Key` must already exist in the `GADGET_CODE` bucket
   *  (this method does not itself write to R2; see `index.ts`'s
   *  `/dev/admin/deploy-gadget-code` route and `gadgets/morning-brief/`'s
   *  deploy script, `scripts/deploy-morning-brief.ts`, for the real
   *  bundle -> upload -> register flow this method is the last step of).
   *  `registerGadget` above (inline `modules`) is UNCHANGED and remains the
   *  path `facet-isolation-drill.ts`/`capability-transport-drill.ts`'s own
   *  self-contained test fixtures use — this is an ADDITIVE second path,
   *  not a replacement. */
  async registerGadgetCode(id: string, kind: GadgetKind, mainModule: string, r2Key: string, compatibilityDate: string): Promise<GadgetDefinition> {
    return upsertGadgetDefinition(this.sql, { id, kind, mainModule, r2Key, compatibilityDate }, Date.now());
  }

  async getGadget(id: string): Promise<GadgetDefinition | undefined> {
    return getGadgetDefinition(this.sql, id);
  }

  async listGadgets(): Promise<GadgetDefinition[]> {
    return listGadgetDefinitions(this.sql);
  }

  // ---------------------------------------------------------------------
  // Capability grants / grant requests
  // ---------------------------------------------------------------------

  async requestCapabilityGrant(gadgetId: string, capabilityType: CapabilityType, scope: CapabilityScope, reason?: string): Promise<CapabilityGrantRequest> {
    return requestCapabilityGrant(this.sql, { gadgetId, capabilityType, scope, reason }, Date.now());
  }

  async getCapabilityGrantRequest(id: string): Promise<CapabilityGrantRequest | undefined> {
    return getGrantRequest(this.sql, id);
  }

  async listCapabilityGrantRequests(status?: GrantRequestStatus): Promise<CapabilityGrantRequest[]> {
    return listGrantRequests(this.sql, status);
  }

  /** The in-app approval decision (plan: "Grant requests ... requiring
   *  in-app approval"; the approval UI itself is a future native-app task —
   *  see this file's header and `grant-request-store.ts`'s). */
  async decideCapabilityGrantRequest(requestId: string, decision: "approved" | "denied", decidedBy: string): Promise<DecideGrantRequestOutcome> {
    return decideGrantRequest(this.sql, requestId, decision, decidedBy, Date.now());
  }

  /** Direct grant creation, bypassing a grant REQUEST — exposed for
   *  operator/admin use (e.g. seeding a grant during local development)
   *  and tests. The normal in-app path is request -> decide, above. */
  async grantCapability(gadgetId: string, capabilityType: CapabilityType, scope: CapabilityScope, grantedBy: string): Promise<CapabilityGrant> {
    return createGrant(this.sql, { gadgetId, capabilityType, scope, grantedBy }, Date.now());
  }

  /** Fix 2(b) — cascade-disable: revoking a `schedule.cron` grant must stop
   *  that gadget's schedules IMMEDIATELY, not just whenever
   *  `runScheduleFanoutTick` next happens to re-check one of them (Fix 1 —
   *  see that function's header for how the two layers divide the work,
   *  eager here vs. lazy there). The grant is looked up BEFORE revoking
   *  purely to learn which `(gadgetId, capabilityType)` pair it was for —
   *  `capability-store.ts`'s `revokeGrant` only takes a bare `grantId` and
   *  doesn't return the row it touched. */
  async revokeCapabilityGrant(grantId: string): Promise<void> {
    const grant = listGrants(this.sql).find((g) => g.id === grantId);
    revokeGrant(this.sql, grantId, Date.now());
    if (grant && grant.capabilityType === "schedule.cron") {
      disableAllSchedulesForGadget(this.sql, grant.gadgetId);
    }
  }

  async listCapabilityGrants(gadgetId?: string): Promise<CapabilityGrant[]> {
    return listGrants(this.sql, gadgetId);
  }

  // ---------------------------------------------------------------------
  // graph.query — see graph-query-capability.ts
  // ---------------------------------------------------------------------

  /** NEW IN THIS PASS (capability-transport fix — see `gadget-env.ts`'s and
   *  `gadget-capabilities-entrypoint.ts`'s headers for the full writeup):
   *  gadget code no longer calls `executeGraphQuery` via a bare closure
   *  placed directly on `env` (that was the `DataCloneError` bug) — it goes
   *  through `GadgetCapabilities` (a loopback `WorkerEntrypoint`), which
   *  forwards here. `executeGraphQuery` itself, including its capability
   *  enforcement and the re-check-after-cross-worker-await fix, is
   *  completely unchanged — this method is a thin, one-line delegate, same
   *  as `proposeGraphWrite`/`registerGadgetSchedule` below always were. */
  async graphQuery(gadgetId: string, viewName: string, params: unknown): Promise<unknown> {
    return executeGraphQuery(this.sql, this.vault, gadgetId, viewName, params);
  }

  // ---------------------------------------------------------------------
  // graph.propose() — see graph-propose-capability.ts
  // ---------------------------------------------------------------------

  async proposeGraphWrite(gadgetId: string, payload: GraphProposalPayload): Promise<GadgetPendingApproval> {
    return proposeGraphWrite(this.sql, gadgetId, payload, Date.now());
  }

  /** `confirmedBy` — the human-driven in-app approval action's caller
   *  identity (plan §Gadgets, `graph-propose-capability.ts`'s
   *  `confirmGraphProposal` header for the full defense-in-depth
   *  rationale). Which identity string a real caller supplies is a future
   *  native-app task's concern; this method's only job is to keep that a
   *  required, explicit, non-gadget-suppliable parameter all the way
   *  through to the enforcement layer — gadget code has no path to
   *  `GadgetSupervisorDO`'s own RPC surface at all (see `gadget-env.ts`),
   *  so this stays unreachable from gadget code regardless. */
  async confirmGraphProposal(approvalId: string, versionToken: string, confirmedBy: string): ReturnType<typeof confirmGraphProposal> {
    return confirmGraphProposal(this.sql, this.vault, approvalId, versionToken, confirmedBy, Date.now());
  }

  async getApproval(id: string): Promise<GadgetPendingApproval | undefined> {
    return getApproval(this.sql, id);
  }

  async listPendingApprovals(gadgetId?: string): Promise<GadgetPendingApproval[]> {
    return listPendingApprovals(this.sql, gadgetId);
  }

  // ---------------------------------------------------------------------
  // gatekeeper.google.calendar.read — see calendar-read-capability.ts
  // ---------------------------------------------------------------------

  /** NEW IN THIS PASS (capability-transport fix) — same "thin delegate,
   *  `GadgetCapabilities` forwards here, enforcement unchanged" shape as
   *  `graphQuery` above. See that method's doc comment. */
  async calendarListUpcomingEvents(gadgetId: string, maxResults?: number, windowDays?: number): Promise<CalendarEventSummaryDTO[]> {
    return readUpcomingCalendarEvents(this.sql, this.env.GATEKEEPER_GOOGLE, gadgetId, maxResults, windowDays);
  }

  // ---------------------------------------------------------------------
  // schedule.cron — see schedule-capability.ts / schedule-fanout.ts
  // ---------------------------------------------------------------------

  async registerGadgetSchedule(gadgetId: string, intervalMinutes: number): Promise<GadgetSchedule> {
    return registerGadgetSchedule(this.sql, gadgetId, intervalMinutes, Date.now());
  }

  async listGadgetSchedules(gadgetId?: string): Promise<GadgetSchedule[]> {
    return listSchedules(this.sql, gadgetId);
  }

  /** Fix 2(c) — a real, directly-callable disable path for a single
   *  schedule row (native-app "turn this automation off" action, ops
   *  intervention, ...). Delegates to `schedule-store.ts`'s
   *  `setScheduleEnabled`, which before this task had no caller anywhere in
   *  the codebase — the row existed, the column existed, nothing ever
   *  flipped it. A disabled schedule is immediately excluded from
   *  `listDueSchedules`, so it stops being invoked from the very next
   *  fan-out tick onward (not merely "marked" while still firing). */
  async disableGadgetSchedule(scheduleId: string): Promise<void> {
    setScheduleEnabled(this.sql, scheduleId, false);
  }

  /** Called from `index.ts`'s `scheduled()` handler on the ONE static cron
   *  cadence declared in `wrangler.jsonc` — see `schedule-fanout.ts`'s
   *  header for why this single tick, not a real per-gadget Cron Trigger,
   *  is the whole `schedule.cron` fan-out mechanism. */
  async runScheduleFanoutTick(): Promise<ScheduleFanoutResult[]> {
    return runScheduleFanoutTick(
      this.sql,
      async (schedule) => {
        await this.invokeGadget(schedule.gadgetId, { path: "/cron" });
      },
      Date.now(),
    );
  }

  // ---------------------------------------------------------------------
  // Facet loading + invocation — the one piece of this file that's real
  // Dynamic-Workers/facets API, per this file's header decision.
  // ---------------------------------------------------------------------

  /** Loads (or resumes) `gadgetId`'s facet and dispatches one request to
   *  it. `this.ctx.facets.get(name, callback)`'s callback only runs on
   *  cold start / after hibernation (see `gadget-env.ts`'s header for why
   *  the capability env it builds is designed around that) — a warm facet
   *  serving a second call in quick succession skips straight to
   *  `.fetch(request)` on the cached stub, exactly per the documented API. */
  async invokeGadget(gadgetId: string, requestInit: { path: string; method?: string; body?: string }): Promise<{ status: number; body: string }> {
    const definition = getGadgetDefinition(this.sql, gadgetId);
    if (!definition) {
      return { status: 404, body: `unknown gadget: ${gadgetId}` };
    }

    const facet = this.ctx.facets.get(gadgetId, async () => {
      // Capability-transport fix (see `gadget-env.ts`'s and
      // `gadget-capabilities-entrypoint.ts`'s headers for the full
      // live-`wrangler dev`-verified diagnosis): `env` now carries ONE
      // loopback Service Binding (`CAPABILITIES`, to `GadgetCapabilities`)
      // instead of a plain object of bare async function closures — the
      // old shape structured-clone-failed on every real call
      // (`DataCloneError`). `this.ctx` (a `DurableObjectState`) is cast to
      // `{ exports: GadgetCapabilitiesExports }` here rather than relying on
      // `@cloudflare/workers-types`' `.exports` typing directly: this
      // worker's `tsconfig.json` intentionally stays on the DEFAULT
      // (non-`/experimental`) `@cloudflare/workers-types` entry point (only
      // the `/experimental` variant currently types `DurableObjectState.
      // exports`/`ExecutionContext.exports` at all — `ctx.exports` is new
      // enough that it hasn't reached the stable typings yet), so this
      // stays a narrow, local, one-line cast (same "one cast at the one
      // point RPC is dispatched" convention `vault-accessor-client.ts`/
      // `gatekeeper-calendar-client.ts` already use) instead of a
      // worker-wide typings-package swap. The cast is purely a
      // TypeScript-side convenience — `this.ctx.exports.GadgetCapabilities`
      // is a REAL loopback binding at runtime regardless; runtime behavior
      // is driven by `GadgetCapabilities` being a top-level export of
      // `index.ts` and `wrangler.jsonc`'s `enable_ctx_exports`
      // compatibility flag, not by anything TypeScript infers.
      const exportsObj = (this.ctx as unknown as { exports: GadgetCapabilitiesExports }).exports;
      const capabilityEnv = buildGadgetEnv(exportsObj, gadgetId);
      const worker = this.env.GADGET_LOADER.get(gadgetId, async () => ({
        compatibilityDate: definition.compatibilityDate,
        mainModule: definition.mainModule,
        // Part 1 (gadget code storage) — resolves EITHER of `gadget-
        // definition-store.ts`'s two shapes (inline `modules` or an R2
        // `r2Key` pointer into `GADGET_CODE`) to the plain source-text map
        // the Worker Loader needs. See `gadget-code-loader.ts`'s header —
        // this is the one call site that turns a registry row into real
        // bytes, at LOAD time (cold start / post-hibernation only, per
        // this function's own header), never at registration time.
        modules: await resolveGadgetModules(this.env.GADGET_CODE, definition),
        env: capabilityEnv,
        // No network egress for gadget code — every external effect it
        // can have goes through `env.CAPABILITIES` above, never a raw
        // `fetch()` from inside the gadget's own isolate (plan: "default
        // access to nothing").
        globalOutbound: null,
      }));
      return { class: worker.getDurableObjectClass("Gadget") };
    });

    const url = `https://gadget.internal${requestInit.path}`;
    let response: Response;
    try {
      response = await facet.fetch(url, {
        method: requestInit.method ?? "GET",
        body: requestInit.body,
        // Fix 4 — see GADGET_INVOCATION_TIMEOUT_MS's doc above. A hung
        // facet's `fetch()` promise is forced to REJECT once the signal
        // fires instead of hanging forever, turning "indefinite stall"
        // into a bounded, catchable failure.
        signal: AbortSignal.timeout(GADGET_INVOCATION_TIMEOUT_MS),
      });
    } catch (error) {
      // `AbortSignal.timeout` aborts with a `DOMException` named
      // "TimeoutError" (distinct from a manually-aborted "AbortError") —
      // translated into a clearly-named, catchable error here so callers
      // (`runScheduleFanoutTick`'s per-schedule try/catch) record a real
      // "timeout" outcome rather than an opaque, unhandled DOMException.
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new GadgetInvocationTimeoutError(gadgetId, GADGET_INVOCATION_TIMEOUT_MS);
      }
      throw error;
    }
    return { status: response.status, body: await response.text() };
  }

  /** Plan §Gadgets' "capability grant, revocable" applies to gadget CODE
   *  too, in the same shutdown-not-just-disable sense — aborting a facet
   *  invalidates its stubs (storage is preserved; `deleteGadgetFacetStorage`
   *  below is the separate, destructive follow-up). */
  async abortGadget(gadgetId: string, reason: string): Promise<void> {
    this.ctx.facets.abort(gadgetId, reason);
  }

  /** Permanently deletes a facet's isolated SQLite — the plan's "isolated
   *  SQLite per facet" cuts both ways: a removed/untrusted gadget's private
   *  state can be wiped without touching anything else in this DO. */
  async deleteGadgetFacetStorage(gadgetId: string): Promise<void> {
    this.ctx.facets.delete(gadgetId);
  }

  // ---------------------------------------------------------------------
  // DEV/DRILL-ONLY — added for `scripts/facet-isolation-drill.ts`.
  // ---------------------------------------------------------------------

  /** HISTORICAL NOTE — RESOLVED (see the earlier task report AND
   *  `gadget-env.ts`'s / `gadget-capabilities-entrypoint.ts`'s headers for
   *  the full writeup and this fix's own live-`wrangler dev` proof,
   *  `scripts/capability-transport-drill.ts`): a previous pass found that
   *  calling the REAL `invokeGadget` above against a REAL `wrangler dev`
   *  instance threw `DataCloneError: async graphQuery(...) {...} could not
   *  be cloned` — `buildGadgetEnv`'s OLD implementation returned a plain
   *  object of bare async FUNCTION closures, and `env.GADGET_LOADER.get
   *  (codeId, callback)`'s returned `WorkerLoaderWorkerCode.env` gets
   *  structured-cloned before it reaches the facet's isolate — plain
   *  functions do not survive that. FIXED: `buildGadgetEnv` now returns a
   *  loopback Service Binding (`ctx.exports.GadgetCapabilities({props})`)
   *  instead of bare closures — Cloudflare's own Worker Loader docs
   *  document exactly this as the supported shape for `env` values beyond
   *  plain structured-clonable data. `invokeGadget` (above) now uses that
   *  real, fixed path directly — this method is kept only because it's
   *  still useful for `facet-isolation-drill.ts`'s narrower purpose
   *  (proving per-facet SQLite storage isolation without a capability
   *  surface muddying what's under test at all), not because the real path
   *  is broken anymore.
   *
   *  This debug-only method loads the SAME gadget code via the SAME real
   *  `this.ctx.facets`/`GADGET_LOADER` APIs `invokeGadget` uses, but with a
   *  plain, empty, trivially-cloneable `env: {}` instead of
   *  `buildGadgetEnv`'s `CAPABILITIES` binding. A test gadget invoked this
   *  way has NO capability surface at all (not even the ones a real gadget
   *  would get) — acceptable because this drill's toy gadget code only
   *  ever touches `this.ctx.storage.sql`, its own facet's isolated SQLite,
   *  and never calls into `env` at all. Not reachable by gadget code
   *  itself, only by this DO's own RPC/stub surface (i.e. `index.ts`'s
   *  dev-only `/dev/admin/*` routes). */
  async debugInvokeGadgetWithEmptyEnv(gadgetId: string, requestInit: { path: string; method?: string; body?: string }): Promise<{ status: number; body: string }> {
    const definition = getGadgetDefinition(this.sql, gadgetId);
    if (!definition) {
      return { status: 404, body: `unknown gadget: ${gadgetId}` };
    }
    const facet = this.ctx.facets.get(`${gadgetId}::debug-empty-env`, async () => {
      const worker = this.env.GADGET_LOADER.get(`${gadgetId}::debug-empty-env`, async () => ({
        compatibilityDate: definition.compatibilityDate,
        mainModule: definition.mainModule,
        // Same `resolveGadgetModules` resolution as the real `invokeGadget`
        // above (see that call site's comment) — kept consistent here too
        // even though every real caller of this debug-only method so far
        // registers inline-`modules` gadgets, so this resolves to a no-op
        // passthrough for them.
        modules: await resolveGadgetModules(this.env.GADGET_CODE, definition),
        env: {},
        globalOutbound: null,
      }));
      return { class: worker.getDurableObjectClass("Gadget") };
    });
    const url = `https://gadget.internal${requestInit.path}`;
    const response = await facet.fetch(url, { method: requestInit.method ?? "GET", body: requestInit.body });
    return { status: response.status, body: await response.text() };
  }

  /** Lists this SUPERVISOR's OWN SQLite table names (never a facet's — a
   *  facet has no way to reach this method at all) so the drill can assert
   *  none of them is a gadget-private table name a compromised/buggy
   *  facet might somehow have leaked into the supervisor's own storage:
   *  the supervisor's schema is fully enumerated in `schema.ts`'s
   *  `DDL_STATEMENTS`, so any table name outside that fixed list appearing
   *  here would itself be an isolation failure worth catching — not just
   *  the reverse direction (a facet reading the supervisor's or another
   *  facet's rows), which the drill checks separately via
   *  `debugInvokeGadgetWithEmptyEnv` above. Not reachable by gadget code
   *  itself — only via this DO's own RPC/stub surface (i.e. `index.ts`'s
   *  dev-only `/dev/admin/*` routes, gated behind
   *  `ENABLE_DEV_ADMIN_ROUTES`). */
  async debugListOwnTableNames(): Promise<string[]> {
    return this.sql
      .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .toArray()
      .map((row) => row.name);
  }
}
