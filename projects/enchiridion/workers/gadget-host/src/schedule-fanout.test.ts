import { describe, expect, test } from "bun:test";
import { createGrant, revokeGrant } from "./capability-store";
import { GadgetInvocationTimeoutError, runScheduleFanoutTick } from "./schedule-fanout";
import { registerSchedule, listSchedules, setScheduleEnabled } from "./schedule-store";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function freshDb(): SqliteStorageAdapter {
  const db = new SqliteStorageAdapter();
  initializeSchema(db);
  return db;
}

/** Test-only shorthand for an active `schedule.cron` grant — Fix 1 means
 *  `runScheduleFanoutTick` now re-checks this for EVERY due schedule, so
 *  every test below that expects a gadget to actually be invoked (rather
 *  than exercising the denial path itself) needs one, same as a real
 *  gadget would via `schedule-capability.ts`'s `registerGadgetSchedule`. */
function grantScheduleCron(db: SqliteStorageAdapter, gadgetId: string, now: number): void {
  createGrant(db, { gadgetId, capabilityType: "schedule.cron", scope: { capabilityType: "schedule.cron", minIntervalMinutes: 1 }, grantedBy: "system" }, now);
}

describe("runScheduleFanoutTick", () => {
  test("invokes only due, enabled schedules and advances their next_due_at", async () => {
    const db = freshDb();
    grantScheduleCron(db, "gadget-due", 1000);
    grantScheduleCron(db, "gadget-not-yet", 1000);
    const due = registerSchedule(db, "gadget-due", 10, 1000); // due at 1000
    registerSchedule(db, "gadget-not-yet", 10, 5000); // due later

    const invoked: string[] = [];
    const results = await runScheduleFanoutTick(
      db,
      async (schedule) => {
        invoked.push(schedule.gadgetId);
      },
      2000,
    );

    expect(invoked).toEqual(["gadget-due"]);
    expect(results).toEqual([{ scheduleId: due.id, gadgetId: "gadget-due", outcome: "ok" }]);

    const updated = listSchedules(db, "gadget-due")[0]!;
    expect(updated.lastRunAt).toBe(2000);
    expect(updated.nextDueAt).toBe(2000 + 10 * 60 * 1000);
    expect(updated.lastResult).toBe("ok");
  });

  test("a failing gadget invocation still advances next_due_at, so it isn't retried every tick", async () => {
    const db = freshDb();
    grantScheduleCron(db, "gadget-flaky", 1000);
    registerSchedule(db, "gadget-flaky", 15, 1000);

    const results = await runScheduleFanoutTick(
      db,
      async () => {
        throw new Error("gadget threw");
      },
      1000,
    );

    expect(results[0]?.outcome).toBe("error");
    const updated = listSchedules(db, "gadget-flaky")[0]!;
    expect(updated.nextDueAt).toBe(1000 + 15 * 60 * 1000);
    expect(updated.lastResult).toContain("gadget threw");
  });

  test("one gadget's failure doesn't block another due gadget in the same tick", async () => {
    const db = freshDb();
    grantScheduleCron(db, "gadget-a", 1000);
    grantScheduleCron(db, "gadget-b", 1000);
    registerSchedule(db, "gadget-a", 10, 1000);
    registerSchedule(db, "gadget-b", 10, 1000);

    const invoked: string[] = [];
    const results = await runScheduleFanoutTick(
      db,
      async (schedule) => {
        invoked.push(schedule.gadgetId);
        if (schedule.gadgetId === "gadget-a") throw new Error("boom");
      },
      2000,
    );

    expect(invoked.sort()).toEqual(["gadget-a", "gadget-b"]);
    expect(results.find((r) => r.gadgetId === "gadget-a")?.outcome).toBe("error");
    expect(results.find((r) => r.gadgetId === "gadget-b")?.outcome).toBe("ok");
  });

  test("nothing due produces no invocations", async () => {
    const db = freshDb();
    grantScheduleCron(db, "gadget-future", 1000);
    registerSchedule(db, "gadget-future", 10, 5000);
    const results = await runScheduleFanoutTick(db, async () => {}, 1000);
    expect(results).toHaveLength(0);
  });

  // Fix 1 — a due, enabled schedule whose gadget never held (or no longer
  // holds) an active `schedule.cron` grant is denied at fan-out time too,
  // not just at registration.
  test("a due schedule for a gadget with no active grant at all is denied and disabled, never invoked", async () => {
    const db = freshDb();
    // No createGrant call at all — this schedule row exists (e.g. seeded
    // directly, or its grant was revoked and the row never got cleaned up)
    // but nothing currently authorizes `schedule.cron` for this gadget.
    const schedule = registerSchedule(db, "gadget-ungranted", 10, 1000);

    const invoked: string[] = [];
    const results = await runScheduleFanoutTick(
      db,
      async (s) => {
        invoked.push(s.gadgetId);
      },
      1000,
    );

    expect(invoked).toEqual([]);
    expect(results).toEqual([{ scheduleId: schedule.id, gadgetId: "gadget-ungranted", outcome: "denied", detail: expect.stringContaining("capability denied") }]);
    expect(listSchedules(db, "gadget-ungranted")[0]!.enabled).toBe(false);
  });

  // Fix 1 / Fix 2 — capability re-checked at fan-out time, not just at
  // registration; a revoked grant genuinely stops an already-scheduled
  // gadget, not just "eventually" once someone happens to check again.
  describe("capability revoked mid-lifecycle (Fix 1 re-check + Fix 2 auto-disable)", () => {
    test("a schedule whose grant is revoked after registration is skipped, not silently invoked, at the next fan-out tick", async () => {
      const db = freshDb();
      const grant = createGrant(
        db,
        { gadgetId: "gadget-revoked", capabilityType: "schedule.cron", scope: { capabilityType: "schedule.cron", minIntervalMinutes: 1 }, grantedBy: "system" },
        1000,
      );
      const schedule = registerSchedule(db, "gadget-revoked", 10, 1000); // due at 1000

      // First tick, while the grant is still active: invoked normally.
      const invoked: string[] = [];
      const firstTick = await runScheduleFanoutTick(
        db,
        async (s) => {
          invoked.push(s.gadgetId);
        },
        1000,
      );
      expect(invoked).toEqual(["gadget-revoked"]);
      expect(firstTick[0]?.outcome).toBe("ok");

      // Grant revoked mid-lifecycle — the schedule row itself is untouched
      // (no cascade caller involved here; this test exercises Fix 1's
      // independent, lazy re-check path on its own).
      revokeGrant(db, grant.id, 1500);

      // Next due tick: must NOT invoke the gadget's facet again, and must
      // record a "denied" outcome plus disable the row.
      const secondTickInvoked: string[] = [];
      const secondTick = await runScheduleFanoutTick(
        db,
        async (s) => {
          secondTickInvoked.push(s.gadgetId);
        },
        2000 + 10 * 60 * 1000, // when the schedule next comes due
      );
      expect(secondTickInvoked).toEqual([]); // never invoked
      expect(secondTick).toEqual([{ scheduleId: schedule.id, gadgetId: "gadget-revoked", outcome: "denied", detail: expect.stringContaining("capability denied") }]);

      const disabled = listSchedules(db, "gadget-revoked")[0]!;
      expect(disabled.enabled).toBe(false);
    });

    test("a disabled-by-revocation schedule is not re-checked-and-skipped forever — it stops appearing as due at all", async () => {
      const db = freshDb();
      const grant = createGrant(
        db,
        { gadgetId: "gadget-revoked", capabilityType: "schedule.cron", scope: { capabilityType: "schedule.cron", minIntervalMinutes: 1 }, grantedBy: "system" },
        1000,
      );
      registerSchedule(db, "gadget-revoked", 10, 1000);
      revokeGrant(db, grant.id, 1500);

      // Tick that observes the denial and disables the row.
      const firstTick = await runScheduleFanoutTick(db, async () => {}, 2000);
      expect(firstTick[0]?.outcome).toBe("denied");

      // Any subsequent tick, no matter how far in the future, finds nothing
      // due for this gadget at all — `listDueSchedules` already excludes
      // disabled rows, so there's no repeated per-tick denial cost either.
      const laterTick = await runScheduleFanoutTick(db, async () => {}, 999_999_999);
      expect(laterTick).toHaveLength(0);
    });

    test("a gadget with a still-active grant is unaffected by another gadget's revocation", async () => {
      const db = freshDb();
      const revokedGrant = createGrant(
        db,
        { gadgetId: "gadget-revoked", capabilityType: "schedule.cron", scope: { capabilityType: "schedule.cron", minIntervalMinutes: 1 }, grantedBy: "system" },
        1000,
      );
      createGrant(
        db,
        { gadgetId: "gadget-fine", capabilityType: "schedule.cron", scope: { capabilityType: "schedule.cron", minIntervalMinutes: 1 }, grantedBy: "system" },
        1000,
      );
      registerSchedule(db, "gadget-revoked", 10, 1000);
      registerSchedule(db, "gadget-fine", 10, 1000);
      revokeGrant(db, revokedGrant.id, 1500);

      const invoked: string[] = [];
      const results = await runScheduleFanoutTick(
        db,
        async (s) => {
          invoked.push(s.gadgetId);
        },
        2000,
      );

      expect(invoked).toEqual(["gadget-fine"]);
      expect(results.find((r) => r.gadgetId === "gadget-revoked")?.outcome).toBe("denied");
      expect(results.find((r) => r.gadgetId === "gadget-fine")?.outcome).toBe("ok");
    });
  });

  // Fix 2(c) — the real disable RPC's underlying mechanism
  // (`setScheduleEnabled`, wrapped by `gadget-supervisor-do.ts`'s
  // `disableGadgetSchedule`) actually stops future invocations once called
  // directly, independent of any capability check.
  describe("disableGadgetSchedule mechanism (Fix 2c)", () => {
    test("a schedule disabled directly is never invoked again, even though it keeps coming due", async () => {
      const db = freshDb();
      grantScheduleCron(db, "gadget-1", 1000);
      const schedule = registerSchedule(db, "gadget-1", 10, 1000);

      const firstInvoked: string[] = [];
      await runScheduleFanoutTick(
        db,
        async (s) => {
          firstInvoked.push(s.gadgetId);
        },
        1000,
      );
      expect(firstInvoked).toEqual(["gadget-1"]);

      // Exactly what GadgetSupervisorDO.disableGadgetSchedule(scheduleId) does.
      setScheduleEnabled(db, schedule.id, false);

      const laterInvoked: string[] = [];
      const laterResults = await runScheduleFanoutTick(
        db,
        async (s) => {
          laterInvoked.push(s.gadgetId);
        },
        2000 + 10 * 60 * 1000,
      );
      expect(laterInvoked).toEqual([]);
      expect(laterResults).toHaveLength(0);
    });
  });

  // Fix 4 — a facet invocation that never settles must not hang the whole
  // tick; a real `invokeGadget` bounds this with `AbortSignal.timeout` and
  // throws `GadgetInvocationTimeoutError` (see `schedule-fanout.ts` /
  // `gadget-supervisor-do.ts`). This mirrors the existing "one gadget's
  // failure doesn't block another due gadget in the same tick" pattern
  // above, using a fake `invokeGadget` that stands in for what the real
  // timeout produces (a REJECTED promise, not a hang) — see this file's
  // header on why fan-out logic is tested via the pure, injectable
  // `invokeGadget` callback rather than a real facet/timer.
  describe("hung facet invocation (Fix 4 timeout)", () => {
    test("a timed-out gadget gets a recorded 'timeout' outcome and does not block another due gadget in the same tick", async () => {
      const db = freshDb();
      grantScheduleCron(db, "gadget-hung", 1000);
      grantScheduleCron(db, "gadget-fine", 1000);
      registerSchedule(db, "gadget-hung", 10, 1000);
      registerSchedule(db, "gadget-fine", 10, 1000);

      const invoked: string[] = [];
      const results = await runScheduleFanoutTick(
        db,
        async (schedule) => {
          invoked.push(schedule.gadgetId);
          if (schedule.gadgetId === "gadget-hung") {
            throw new GadgetInvocationTimeoutError("gadget-hung", 30_000);
          }
        },
        2000,
      );

      // Both gadgets were reached in the same tick — the hung one didn't
      // block the other.
      expect(invoked.sort()).toEqual(["gadget-fine", "gadget-hung"]);

      const hungResult = results.find((r) => r.gadgetId === "gadget-hung")!;
      expect(hungResult.outcome).toBe("timeout");
      expect(hungResult.detail).toContain("timed out after 30000ms");
      expect(results.find((r) => r.gadgetId === "gadget-fine")?.outcome).toBe("ok");
    });

    test("a timed-out schedule still advances next_due_at, so it isn't retried every tick, and stays enabled (a timeout is not a capability denial)", async () => {
      const db = freshDb();
      grantScheduleCron(db, "gadget-hung", 1000);
      const schedule = registerSchedule(db, "gadget-hung", 10, 1000);

      await runScheduleFanoutTick(
        db,
        async () => {
          throw new GadgetInvocationTimeoutError("gadget-hung", 30_000);
        },
        1000,
      );

      const updated = listSchedules(db, "gadget-hung")[0]!;
      expect(updated.nextDueAt).toBe(1000 + 10 * 60 * 1000);
      expect(updated.enabled).toBe(true);
      expect(updated.lastResult).toContain("timeout:");
      expect(updated.id).toBe(schedule.id);
    });
  });
});
