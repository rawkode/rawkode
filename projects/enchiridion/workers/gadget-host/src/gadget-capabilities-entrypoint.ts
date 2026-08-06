// @enchiridion/worker-gadget-host — the REAL cross-isolate transport for a
// gadget's capability-bound `env`, replacing `gadget-env.ts`'s old "plain
// object of async function closures" design.
//
// WHY THIS FILE EXISTS (the bug this fixes — see the task report for the
// full live-`wrangler dev` diagnosis): `gadget-supervisor-do.ts`'s
// `invokeGadget` hands a gadget's dynamic-worker code an `env` via
// `env.GADGET_LOADER.get(codeId, callback)`'s returned
// `WorkerLoaderWorkerCode.env`. Cloudflare's own Worker Loader docs
// (developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/,
// the `WorkerCode.env` field) say verbatim: "`env` is serialized and
// transferred into the dynamic Worker ... It may contain: Structured
// clonable types. Service Bindings, including loopback bindings from
// `ctx.exports`." A plain async function closure (what `gadget-env.ts`
// used to put directly on `env`) is NEITHER of those — it is not
// structured-clonable (confirmed live: `DataCloneError: async graphQuery(...)
// {...} could not be cloned`) and it is not a Service Binding either. The
// old file's header cited `cloudflare:workers`'s `Rpc.Stubable` type
// (`RpcTargetBranded | ((...args) => any)`) as justification that a plain
// function is a valid RPC-stubable value — TRUE for values returned FROM an
// already-established RPC call (e.g. a method's return value), or for
// values placed on a binding declared in `wrangler.jsonc` — but NOT true
// for the top-level values placed directly on `WorkerLoaderWorkerCode.env`
// specifically, which goes through structured serialization BEFORE the
// facet's isolate ever gets a chance to wrap it as an RPC stub. This is the
// "may differ from the DO/WorkerEntrypoint RPC binding case" distinction
// the task brief asked to verify — verified, and it does differ.
//
// THE FIX, PER CLOUDFLARE'S OWN DOCUMENTED PATTERN (same page, "Custom
// bindings" section, quoted verbatim in full): define a `WorkerEntrypoint`
// subclass implementing the capability's RPC methods (THIS class), then
// hand the dynamic Worker a LOOPBACK SERVICE BINDING to it —
// `ctx.exports.<ClassName>({ props: {...} })` — as the `env` value, not
// the class/closures directly:
//
//     export class Greeter extends WorkerEntrypoint {
//       greet() { return `Hello, ${this.ctx.props.name}!`; }
//     }
//     let worker = env.LOADER.get("alice", () => ({
//       env: { GREETER: ctx.exports.Greeter({ props: { name: "Alice" } }) },
//       // ... code ...
//     }));
//
// A loopback binding IS a real Service Binding (the docs: "you can define
// a binding with any arbitrary API, by defining a `WorkerEntrypoint` class
// implementing an RPC API, and then giving it to the dynamic Worker as a
// Service Binding") — it survives `env`'s structured-clone boundary because
// the runtime recognizes it as a binding reference, not a plain value, and
// wires up a real RPC channel to it, exactly like a `wrangler.jsonc`-
// declared Service Binding does. This is the ONE difference from every
// other RPC surface already proven in this codebase (`gatekeeper-google`'s
// `CalendarWriteModel`/`GmailWriteModel`, `vault`'s DO RPC methods): those
// are ALL either (a) `WorkerEntrypoint`s bound via a static `services` entry
// in `wrangler.jsonc`, or (b) a Durable Object's own RPC methods reached via
// a `DurableObjectStub` — never a value constructed at Worker-Loader-`env`-
// build time. `ctx.exports`' LOOPBACK path is exactly the same underlying
// mechanism (a `WorkerEntrypoint`, RPC dispatch) applied to a binding built
// dynamically per-invocation instead of declared statically — the part
// that's actually new here is `ctx.exports` + the `WorkerCode.env` position,
// not `WorkerEntrypoint`/RPC itself.
//
// `RpcTarget` WAS INVESTIGATED AND REJECTED FOR THIS SPECIFIC POSITION (per
// the task brief's explicit ask not to assume it transfers): a bare
// `RpcTarget` subclass instance is neither "a structured clonable type" nor
// "a Service Binding" — it is a value ONLY meaningful already-inside an
// established RPC channel (e.g. returned from a `WorkerEntrypoint` method,
// or passed as an RPC call argument), which is exactly the class of thing
// the docs describe `env` as NOT accepting directly. `RpcTarget` instances
// remain fine to use elsewhere in this worker's RPC surfaces (e.g. as a
// method's return value); they are simply not the mechanism for THIS
// specific boundary (`WorkerLoaderWorkerCode.env`'s top-level shape), which
// is what the task brief asked to confirm rather than assume.
//
// WHY THIS CLASS IS A THIN FORWARDER, NOT WHERE THE CAPABILITY LOGIC LIVES:
// `requireCapability`/the four `*-capability.ts` modules' enforcement logic
// is UNCHANGED by this fix (task brief: "Do not change any capability
// enforcement logic ... this is purely a transport/surface redesign") and
// still needs `GadgetSupervisorDO`'s OWN SQLite (`capability_grants`,
// `gadget_pending_approvals`, `gadget_schedules` — `schema.ts`) to run at
// all. A `WorkerEntrypoint` loopback instance has no storage of its own —
// it is NOT the same object as the `GadgetSupervisorDO` instance that
// loaded the facet, just a real RPC channel BACK to it (same "same fixed
// `idFromName("default")` instance every other worker in this system
// resolves to" pattern `vault-accessor-client.ts`/`gatekeeper-calendar-
// client.ts` already use) — so every method below does exactly one thing:
// forward `(gadgetId, ...args)` to the matching `GadgetSupervisorDO` RPC
// method (`gadget-supervisor-do.ts`), which is where `requireCapability`
// actually runs, unchanged, every single call, exactly as before.
// `gadgetId` comes from `this.ctx.props` (set once, at loopback-binding
// construction time in `gadget-env.ts`'s `buildGadgetEnv` — see that file)
// — NOT gadget-suppliable as a call argument, so a gadget cannot pass a
// DIFFERENT gadget's id to widen its own capability surface; it can only
// ever act as the identity it was constructed with.
//
// NOT UNIT-TESTED (same established convention as `gadget-supervisor-do.ts`,
// `workers/gatekeeper-google/src/index.ts`'s `CalendarWriteModel`/
// `GmailWriteModel`/`GmailReadModel`/`CalendarReadModel`): this file imports
// `cloudflare:workers`, which `bun test` cannot resolve outside the Workers
// runtime (see `gmail-read-model.test.ts`'s header for the established
// reason, not restated here) — smoke-tested against a REAL `wrangler dev`
// instance instead (see `scripts/capability-transport-drill.ts`), the same
// bar every other `cloudflare:workers`-importing file in this worker is
// held to.
//
// ONE CAST AT THE ONE POINT RPC IS DISPATCHED: `supervisorStub` below casts
// straight to a local, minimal, structural stub type rather than relying on
// `DurableObjectStub<GadgetSupervisorDO>`'s auto-derived RPC method types —
// same pattern `vault-accessor-client.ts`/`gatekeeper-calendar-client.ts`
// already use (see either file's header). This isn't just style
// consistency: `@cloudflare/workers-types`' auto-derived `Rpc.Provider<T>`
// mapped type resolves a method's `unknown`-typed return (e.g.
// `graphQuery`'s `Promise<unknown>`, since a gadget's query result shape
// genuinely varies per view) to `never` (`Rpc.Result<R>`'s fallback branch:
// `unknown` satisfies neither its `Stubable` nor `Serializable<R>` checks),
// which would make the auto-derived stub type actively wrong to use here —
// the local structural type sidesteps that entirely.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { CalendarEventSummaryDTO } from "@enchiridion/gadget-gatekeeper-google-rpc-contract";
import type { GraphProposalPayload } from "./gadget-materialized-doc";
import type { GadgetPendingApproval } from "./graph-propose-capability";
import type { GadgetSchedule } from "./schedule-store";

/** The identity this loopback binding acts as — set once, at construction
 *  time (`gadget-env.ts`'s `buildGadgetEnv`), never gadget-suppliable per
 *  call. See this file's header. */
export interface GadgetCapabilitiesProps {
  gadgetId: string;
}

interface Env {
  /** Real, `wrangler.jsonc`-declared, script-wide binding (already used by
   *  `index.ts`'s `defaultSupervisorStub`) — available here too, since
   *  bindings apply to the whole Worker script, not just its default
   *  export. Deliberately untyped generic (`DurableObjectNamespace`, no
   *  `<GadgetSupervisorDO>` type param) — see this file's header on why
   *  `supervisorStub` below casts instead of relying on the auto-derived
   *  RPC provider type. */
  GADGET_SUPERVISOR_DO: DurableObjectNamespace;
}

/** The exact narrow slice of `GadgetSupervisorDO`'s RPC surface this class
 *  forwards to — see that file for each method's real implementation
 *  (unchanged by this fix). Kept separate from `GadgetSupervisorDO`'s own
 *  type so this file has no compile-time dependency on
 *  `gadget-supervisor-do.ts` at all (avoids a needless import cycle: that
 *  file constructs THIS class's loopback binding via `gadget-env.ts`). */
interface GadgetSupervisorCapabilityStub {
  graphQuery(gadgetId: string, viewName: string, params: unknown): Promise<unknown>;
  proposeGraphWrite(gadgetId: string, payload: GraphProposalPayload): Promise<GadgetPendingApproval>;
  calendarListUpcomingEvents(gadgetId: string, maxResults?: number, windowDays?: number): Promise<CalendarEventSummaryDTO[]>;
  registerGadgetSchedule(gadgetId: string, intervalMinutes: number): Promise<GadgetSchedule>;
}

function supervisorStub(env: Env): GadgetSupervisorCapabilityStub {
  const id = env.GADGET_SUPERVISOR_DO.idFromName("default");
  return env.GADGET_SUPERVISOR_DO.get(id) as unknown as GadgetSupervisorCapabilityStub;
}

/** MUST be exported from `index.ts` (this worker's main module) — `ctx.
 *  exports`/`this.ctx.exports`'s loopback-binding mechanism only covers
 *  TOP-LEVEL exports of the main module (Cloudflare's `ctx.exports` docs:
 *  "automatically-configured bindings corresponding to your Worker's
 *  top-level exports"). `ctx.exports` itself needs no explicit
 *  compatibility flag for this worker — CONFIRMED LIVE (`workerd`'s own
 *  startup error the one time `enable_ctx_exports` WAS listed explicitly
 *  in `wrangler.jsonc`): "The compatibility flag enable_ctx_exports became
 *  the default as of 2025-11-17 so does not need to be specified anymore."
 *  See `wrangler.jsonc`'s `compatibility_flags` comment for the full
 *  citation. */
export class GadgetCapabilities extends WorkerEntrypoint<Env, GadgetCapabilitiesProps> {
  async graphQuery(viewName: string, params: unknown): Promise<unknown> {
    return supervisorStub(this.env).graphQuery(this.ctx.props.gadgetId, viewName, params);
  }

  async graphPropose(payload: GraphProposalPayload): Promise<GadgetPendingApproval> {
    return supervisorStub(this.env).proposeGraphWrite(this.ctx.props.gadgetId, payload);
  }

  // graphConfirmProposal is deliberately NOT here — same structural
  // "gadgets can never reach the confirm step" fix `gadget-env.ts`'s old
  // implementation carried, preserved unchanged by this transport redesign.
  // See graph-propose-capability.ts's header for the full rationale.

  async calendarListUpcomingEvents(maxResults?: number, windowDays?: number): Promise<CalendarEventSummaryDTO[]> {
    return supervisorStub(this.env).calendarListUpcomingEvents(this.ctx.props.gadgetId, maxResults, windowDays);
  }

  async scheduleRegister(intervalMinutes: number): Promise<GadgetSchedule> {
    return supervisorStub(this.env).registerGadgetSchedule(this.ctx.props.gadgetId, intervalMinutes);
  }
}
