// @enchiridion/worker-gadget-host — the `schedule.cron` capability's
// enforcement + dispatch.
//
// Plan §Gadgets: "schedule.cron (allows a gadget to register a recurring
// invocation) ... design the data model; actual cron-trigger wiring for
// dynamically-registered gadget schedules is a real Workers constraint ...
// so this likely needs a single supervisor-level cron tick that fans out
// to any gadgets holding this capability and checks if they're due." See
// `schedule-fanout.ts` for that tick; this file is the REGISTRATION side —
// a gadget calling this to ask for a recurring invocation in the first
// place.
//
// ENFORCEMENT: two checks, same "grant existence, then grant's own scope"
// two-layer shape `graph-query-capability.ts` uses.
//   1. `requireCapability` — an active `schedule.cron` grant at all.
//   2. The grant's `scope.minIntervalMinutes` FLOOR — a gadget requesting a
//      MORE FREQUENT interval than its grant allows is denied outright
//      (never silently clamped up to the floor — clamping would let a
//      gadget's registered behavior silently diverge from what it actually
//      asked for, which is worse than a loud denial it can react to).

import { requireCapability } from "./capability-enforcement";
import { CapabilityDeniedError } from "./capability-types";
import { registerSchedule as insertSchedule, type GadgetSchedule } from "./schedule-store";
import type { SqlExecutor } from "./schema";

export function registerGadgetSchedule(sql: SqlExecutor, gadgetId: string, intervalMinutes: number, now: number): GadgetSchedule {
  const grant = requireCapability(sql, gadgetId, "schedule.cron");
  if (grant.scope.capabilityType !== "schedule.cron") {
    throw new CapabilityDeniedError(gadgetId, "schedule.cron", "grant scope is malformed (type mismatch)");
  }
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    throw new TypeError("schedule.cron: intervalMinutes must be a positive number");
  }
  if (intervalMinutes < grant.scope.minIntervalMinutes) {
    throw new CapabilityDeniedError(
      gadgetId,
      "schedule.cron",
      `requested interval (${intervalMinutes}m) is more frequent than this grant allows (minimum ${grant.scope.minIntervalMinutes}m)`,
    );
  }
  return insertSchedule(sql, gadgetId, intervalMinutes, now);
}
