// @enchiridion/worker-gadget-host — the `schedule.cron` fan-out tick.
//
// WHY THIS EXISTS INSTEAD OF A REAL PER-GADGET CRON TRIGGER (plan §Gadgets,
// design note the task brief asks to be documented clearly):
//
// Cloudflare Workers Cron Triggers are STATIC, deploy-time configuration —
// a fixed list of cron expressions in `wrangler.jsonc`'s `triggers.crons`,
// each firing the worker's own `scheduled()` handler. There is no runtime
// API to register a NEW Cron Trigger for a specific gadget at grant time;
// the only way to add one would be editing `wrangler.jsonc` and running
// `wrangler deploy` again. That directly conflicts with the plan's whole
// reason for gadgets existing at all — "If facets aren't available on the
// account, the fallback must stay deploy-free ... 'wrangler deploy per
// gadget' would kill the runtime-creation UX that is the point of gadgets"
// (plan §Gadgets) — and the same "no deploy per gadget" principle applies
// just as much to a gadget's SCHEDULE as it does to its CODE: a design that
// requires a fresh deploy every time someone grants `schedule.cron` to a
// new gadget would be exactly the deploy-per-gadget UX the plan already
// rejected, just for a different reason (scheduling instead of loading).
//
// THE DESIGN: `wrangler.jsonc`'s `triggers.crons` declares exactly ONE
// static cron expression (this worker's own fan-out cadence — see that
// file's comment for the chosen interval), firing `index.ts`'s
// `scheduled()`, which calls `GadgetSupervisorDO.runScheduleFanoutTick()`.
// THAT single, fixed tick is what polls `gadget_schedules` (via
// `schedule-store.ts`'s `listDueSchedules`) for every row whose
// `next_due_at <= now`, regardless of which gadget it belongs to or when
// it was registered — registering a new schedule (`schedule-
// capability.ts`'s `registerGadgetSchedule`) is a pure SQLite INSERT, no
// deploy involved, and it becomes live on the VERY NEXT fan-out tick.
//
// TRADE-OFF, STATED PLAINLY: a gadget's requested `intervalMinutes` is a
// FLOOR on how often it *could* run, not a guarantee of exactly-that-often
// scheduling — actual firing granularity is bounded below by the
// supervisor's own static tick cadence (if the tick fires every 5 minutes,
// a schedule registered for "every 2 minutes" still only actually runs
// every 5). This is the same kind of approximation gatekeeper-google's own
// 5-minute cron cadence already accepts for Calendar/Gmail polling — not a
// new risk category this design introduces, just the same one applied to
// gadget schedules.
//
// PURE, INJECTABLE `invokeGadget` — this function has no facet/Workers-
// runtime dependency of its own; `gadget-supervisor-do.ts`'s
// `runScheduleFanoutTick` passes a real `invokeGadget` that calls
// `this.ctx.facets.get(...)`. Tests pass a fake, so fan-out due-selection/
// advancement logic is fully unit-tested without a live Workers runtime —
// same "plain module, DO wires it up" split every other real-logic module
// in this codebase uses.

import { requireCapability } from "./capability-enforcement";
import { CapabilityDeniedError } from "./capability-types";
import { listDueSchedules, markScheduleRun, setScheduleEnabled, type GadgetSchedule } from "./schedule-store";
import type { SqlExecutor } from "./schema";

export interface ScheduleFanoutResult {
  scheduleId: string;
  gadgetId: string;
  outcome: "ok" | "error" | "denied" | "timeout";
  detail?: string;
}

/** Thrown by a real `invokeGadget` implementation (`gadget-supervisor-
 *  do.ts`'s `invokeGadget`, wired in as the callback below) when a facet
 *  invocation exceeds ITS OWN timeout budget — Fix 4 (adversarial review:
 *  "a hung gadget facet blocks indefinitely ... could stall every other due
 *  gadget behind it"). Deliberately defined HERE, not in
 *  `gadget-supervisor-do.ts`, so this file's `outcome: "timeout"` branch
 *  below — and every test exercising it — can construct/detect the exact
 *  same class via the plain injectable `invokeGadget` callback, with no
 *  Workers-runtime/facets dependency. */
export class GadgetInvocationTimeoutError extends Error {
  constructor(gadgetId: string, timeoutMs: number) {
    super(`gadget "${gadgetId}" facet invocation timed out after ${timeoutMs}ms`);
    this.name = "GadgetInvocationTimeoutError";
  }
}

/** One fan-out tick: finds every due, enabled schedule and invokes its
 *  gadget, ADVANCING `next_due_at` regardless of outcome (see this file's
 *  header — a failing gadget must not get retried on every subsequent tick
 *  faster than its own interval). Schedules are processed SEQUENTIALLY
 *  (not `Promise.all`-parallel) — same "don't multiply up one tick's total
 *  load" reasoning `workers/gatekeeper-google/src/index.ts`'s
 *  `scheduled()` documents for its own four sequential steps — and each
 *  gadget invocation is independently try/caught so one gadget's failure
 *  never blocks the rest of the tick.
 *
 *  FIX 1 (adversarial review: "`schedule.cron` is re-checked at fan-out
 *  time, not just at registration"): a schedule surviving in this table
 *  proves nothing about whether its gadget STILL holds an active
 *  `schedule.cron` grant — `schedule-capability.ts`'s `registerGadgetSchedule`
 *  only ever checked that ONCE, at registration. Every due schedule is
 *  therefore re-checked against `capability-enforcement.ts`'s
 *  `requireCapability` immediately before invocation, on the SAME
 *  "re-checked every call, not cached" footing every other capability in
 *  this worker already gets (`capability-enforcement.ts`'s header). A
 *  denial here means the grant was revoked (or never existed) sometime
 *  between registration and now: the gadget is skipped for this tick AND
 *  its schedule row is disabled on the spot (Fix 2's `setScheduleEnabled`)
 *  so it stops being fan-out-eligible from this point on, rather than
 *  being silently re-denied every single tick forever (which would still
 *  cost one `requireCapability` lookup per tick, indefinitely, for a grant
 *  that is never coming back). This is the LAZY half of Fix 2's two-layer
 *  disable design; `gadget-supervisor-do.ts`'s `revokeCapabilityGrant`
 *  cascade is the EAGER half that disables immediately at revocation time
 *  instead of waiting for a schedule to happen to come due again. */
export async function runScheduleFanoutTick(
  sql: SqlExecutor,
  invokeGadget: (schedule: GadgetSchedule) => Promise<void>,
  now: number,
): Promise<ScheduleFanoutResult[]> {
  const due = listDueSchedules(sql, now);
  const results: ScheduleFanoutResult[] = [];

  for (const schedule of due) {
    try {
      requireCapability(sql, schedule.gadgetId, "schedule.cron");
    } catch (error) {
      if (!(error instanceof CapabilityDeniedError)) {
        throw error;
      }
      setScheduleEnabled(sql, schedule.id, false);
      results.push({ scheduleId: schedule.id, gadgetId: schedule.gadgetId, outcome: "denied", detail: error.message });
      continue;
    }

    try {
      await invokeGadget(schedule);
      markScheduleRun(sql, schedule.id, now, schedule.intervalMinutes, "ok");
      results.push({ scheduleId: schedule.id, gadgetId: schedule.gadgetId, outcome: "ok" });
    } catch (error) {
      const outcome: ScheduleFanoutResult["outcome"] = error instanceof GadgetInvocationTimeoutError ? "timeout" : "error";
      const detail = error instanceof Error ? error.message : String(error);
      markScheduleRun(sql, schedule.id, now, schedule.intervalMinutes, `${outcome}: ${detail}`);
      results.push({ scheduleId: schedule.id, gadgetId: schedule.gadgetId, outcome, detail });
    }
  }

  return results;
}
