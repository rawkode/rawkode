// @enchiridion/worker-gadget-host — builds the capability-bound `env`
// object handed to a gadget's dynamic-worker code via
// `env.GADGET_LOADER.get(codeId, callback)`'s `WorkerLoaderWorkerCode.env`
// field (`@cloudflare/workers-types`' `WorkerLoaderWorkerCode.env?: any`).
//
// REDESIGNED (this pass) — see `gadget-capabilities-entrypoint.ts`'s header
// for the full live-`wrangler dev`-verified diagnosis and fix. Short
// version: the OLD design here returned a plain object of async function
// closures, which Cloudflare's Worker Loader structured-clones before it
// reaches the facet's isolate — plain functions don't survive that,
// reproducing `DataCloneError` on every real `invokeGadget` call. The FIX
// is Cloudflare's own documented pattern for this exact position
// (`WorkerLoaderWorkerCode.env`'s "Service Bindings, including loopback
// bindings from `ctx.exports`" — see the linked doc quote in
// `gadget-capabilities-entrypoint.ts`): `env` now carries ONE loopback
// Service Binding (`CAPABILITIES`) to `GadgetCapabilities` (a real
// `WorkerEntrypoint`, that file), bound to this specific gadget's identity
// via `props` at construction time — not four bare function values.
//
// DEFAULT NOTHING, FUNCTIONALLY NOT STRUCTURALLY: unchanged in spirit from
// before this fix — `buildGadgetEnv` always returns the SAME `CAPABILITIES`
// binding regardless of which capabilities are CURRENTLY granted (a facet
// only rebuilds its `env` on cold start / after hibernation — see `gadget-
// supervisor-do.ts`'s header on `this.ctx.facets.get`'s callback timing — so
// a structural "only present if currently granted" design would leave a
// capability granted AFTER cold start invisible until the facet happens to
// restart). "Default nothing" is still a real, always-current guarantee —
// it's enforced by `requireCapability` INSIDE `GadgetSupervisorDO`'s RPC
// methods (`gadget-capabilities-entrypoint.ts`'s `GadgetCapabilities`
// forwards every call there, re-checked fresh every single time), not by
// which keys exist on this object.
//
// BLOCKER FIX PRESERVED (two independent adversarial reviews, unchanged by
// this transport redesign): `graphConfirmProposal` is still NOT reachable
// from gadget code anywhere in this file or `GadgetCapabilities` — see
// that file's own comment on the same point, and `graph-propose-
// capability.ts`'s header for the full rationale.

/** A narrow, structural slice of `this.ctx.exports`
 *  (`DurableObjectState<Props>.exports` / `ExecutionContext<Props>.exports`,
 *  `@cloudflare/workers-types`) — just the one loopback-binding constructor
 *  this file actually calls. Kept local and minimal rather than typed as
 *  the real `Cloudflare.Exports` (which requires a `Cloudflare.GlobalProps`
 *  declaration-merge this worker doesn't carry — see
 *  `gadget-capabilities-entrypoint.ts`'s header on why this file casts at
 *  the boundary instead, same "one cast at the one point RPC is
 *  dispatched" convention `vault-accessor-client.ts`/`gatekeeper-calendar-
 *  client.ts` already use), so this file stays fully unit-testable with a
 *  plain mock object — no `cloudflare:workers` import needed here at all. */
export interface GadgetCapabilitiesExports {
  GadgetCapabilities(opts: { props: { gadgetId: string } }): unknown;
}

/** The one capability-bound stub a gadget's `env.CAPABILITIES` resolves to
 *  once the real Worker Loader RPC channel is live — see
 *  `gadget-capabilities-entrypoint.ts`'s `GadgetCapabilities` for the real
 *  implementation each method forwards to. Typed by hand here (not derived
 *  from `GadgetCapabilities` via `Rpc.Provider`) for the same "avoid the
 *  auto-derived-`unknown`-return-becomes-`never`" reason documented in that
 *  file's header. */
export interface GadgetCapabilitiesStub {
  graphQuery(viewName: string, params: unknown): Promise<unknown>;
  graphPropose(payload: unknown): Promise<unknown>;
  calendarListUpcomingEvents(maxResults?: number, windowDays?: number): Promise<unknown>;
  scheduleRegister(intervalMinutes: number): Promise<unknown>;
}

/** The ENTIRE surface a gadget's own dynamic-worker code can reach beyond
 *  its own isolated SQLite — one named binding, not four bare top-level
 *  functions (the old, structured-clone-incompatible shape). There is
 *  deliberately no raw `env.VAULT`/`env.GATEKEEPER_GOOGLE` binding
 *  passthrough here — `CAPABILITIES` is the only thing gadget code ever
 *  sees, and every method on it is itself narrow and named, never a
 *  forwarded binding a gadget could widen. */
export interface GadgetCapabilityEnv {
  CAPABILITIES: GadgetCapabilitiesStub;
}

/** Builds the `env` value `gadget-supervisor-do.ts`'s `invokeGadget` passes
 *  as `WorkerLoaderWorkerCode.env`. `exportsObj` is `this.ctx.exports` (cast
 *  to `GadgetCapabilitiesExports` at the call site — see that file);
 *  `gadgetId` becomes the loopback binding's `props.gadgetId`, i.e. the
 *  identity every `GadgetCapabilities` method call is permanently bound to
 *  for this facet's lifetime (not gadget-suppliable per call — see
 *  `gadget-capabilities-entrypoint.ts`'s header). */
export function buildGadgetEnv(exportsObj: GadgetCapabilitiesExports, gadgetId: string): GadgetCapabilityEnv {
  return {
    CAPABILITIES: exportsObj.GadgetCapabilities({ props: { gadgetId } }) as unknown as GadgetCapabilitiesStub,
  };
}
