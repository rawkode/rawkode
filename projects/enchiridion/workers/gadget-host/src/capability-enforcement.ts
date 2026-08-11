// @enchiridion/worker-gadget-host — the ONE default-deny choke point.
//
// Plan §Gadgets: "Capabilities injected at load, default nothing ...
// checked at gadget invocation time." Every capability-gated module in
// this worker (`graph-query-capability.ts`, `graph-propose-capability.ts`,
// `calendar-read-capability.ts`, `schedule-capability.ts`) calls
// `requireCapability` FIRST, before doing anything else — never re-derives
// its own "is this allowed" logic. That's the whole security property this
// file provides: there is exactly one place a missing/revoked grant gets
// turned into a denial, so auditing "is default-deny real" means reading
// this one function, not four independent call sites that could each get
// it slightly wrong.
//
// RE-CHECKED ON EVERY CALL, NOT CACHED AT FACET STARTUP — this matters
// because of how DO facets actually work (`gadget-supervisor-do.ts`'s
// header on `this.ctx.facets.get`): the startup callback that builds a
// gadget's capability-bound `env` object only runs on COLD START or after
// hibernation, not on every request to an already-warm facet. If capability
// objects captured a "was this granted" boolean once at cold start, a
// revocation (`capability-store.ts`'s `revokeGrant`) would have NO EFFECT
// on an already-warm facet until it happened to hibernate and restart —
// an unbounded, unpredictable window where a revoked capability keeps
// working. Every capability closure in `gadget-env.ts` therefore calls back
// into the supervisor (and through it, `requireCapability` here) on EVERY
// invocation, re-reading `capability_grants` fresh from durable SQLite each
// time — revocation takes effect on the very next call, not "eventually".

import { getActiveGrant } from "./capability-store";
import { CapabilityDeniedError, type CapabilityGrant, type CapabilityType } from "./capability-types";
import type { SqlExecutor } from "./schema";

/** Returns the active grant for `(gadgetId, capabilityType)`, or throws
 *  `CapabilityDeniedError` if none exists (never granted, or granted then
 *  revoked). This is the ENTIRE default-deny mechanism: no grant row with
 *  `revoked_at IS NULL` for this exact pair means denied, full stop — no
 *  implicit admin bypass, no "gadget_id absent means trust it" fallback. */
export function requireCapability(sql: SqlExecutor, gadgetId: string, capabilityType: CapabilityType): CapabilityGrant {
  const grant = getActiveGrant(sql, gadgetId, capabilityType);
  if (!grant) {
    throw new CapabilityDeniedError(gadgetId, capabilityType, "no active grant — capabilities default to denied until explicitly granted");
  }
  return grant;
}
