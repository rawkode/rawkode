import { describe, expect, test } from "bun:test";
import { createGrant } from "./capability-store";
import { CapabilityDeniedError } from "./capability-types";
import { registerGadgetSchedule } from "./schedule-capability";
import { MAX_SCHEDULES_PER_GADGET, ScheduleLimitExceededError } from "./schedule-store";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function freshDb(): SqliteStorageAdapter {
  const db = new SqliteStorageAdapter();
  initializeSchema(db);
  return db;
}

describe("registerGadgetSchedule", () => {
  test("a gadget with no schedule.cron grant is denied", () => {
    const db = freshDb();
    expect(() => registerGadgetSchedule(db, "gadget-1", 60, 1000)).toThrow(CapabilityDeniedError);
  });

  test("a granted gadget may register a schedule at or slower than its grant's minimum interval", () => {
    const db = freshDb();
    createGrant(db, { gadgetId: "gadget-1", capabilityType: "schedule.cron", scope: { capabilityType: "schedule.cron", minIntervalMinutes: 30 }, grantedBy: "system" }, 1000);

    const schedule = registerGadgetSchedule(db, "gadget-1", 60, 2000);
    expect(schedule.gadgetId).toBe("gadget-1");
    expect(schedule.intervalMinutes).toBe(60);
    expect(schedule.nextDueAt).toBe(2000); // due immediately
  });

  test("requesting a MORE FREQUENT interval than the grant allows is denied, not clamped", () => {
    const db = freshDb();
    createGrant(db, { gadgetId: "gadget-1", capabilityType: "schedule.cron", scope: { capabilityType: "schedule.cron", minIntervalMinutes: 60 }, grantedBy: "system" }, 1000);
    expect(() => registerGadgetSchedule(db, "gadget-1", 5, 2000)).toThrow(CapabilityDeniedError);
  });

  test("an interval exactly at the grant's floor is allowed", () => {
    const db = freshDb();
    createGrant(db, { gadgetId: "gadget-1", capabilityType: "schedule.cron", scope: { capabilityType: "schedule.cron", minIntervalMinutes: 60 }, grantedBy: "system" }, 1000);
    expect(() => registerGadgetSchedule(db, "gadget-1", 60, 2000)).not.toThrow();
  });

  // Fix 3 — the per-gadget schedule-count cap applies through this real,
  // gadget-callable entry point too (`gadget-env.ts`'s `scheduleRegister`
  // calls exactly this function), not just at `schedule-store.ts`'s lower
  // level. A grant permits the CAPABILITY; it never permits unbounded
  // registrations under it.
  test("a granted gadget looping on registerGadgetSchedule is rejected once it hits the per-gadget cap, with a clear error", () => {
    const db = freshDb();
    createGrant(db, { gadgetId: "gadget-loop", capabilityType: "schedule.cron", scope: { capabilityType: "schedule.cron", minIntervalMinutes: 1 }, grantedBy: "system" }, 1000);

    for (let i = 0; i < MAX_SCHEDULES_PER_GADGET; i++) {
      expect(() => registerGadgetSchedule(db, "gadget-loop", 1, 1000)).not.toThrow();
    }

    expect(() => registerGadgetSchedule(db, "gadget-loop", 1, 1000)).toThrow(ScheduleLimitExceededError);
    try {
      registerGadgetSchedule(db, "gadget-loop", 1, 1000);
      throw new Error("expected registerGadgetSchedule to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleLimitExceededError);
      expect((error as Error).message).toContain("gadget-loop");
      expect((error as Error).message).toContain(String(MAX_SCHEDULES_PER_GADGET));
    }
  });
});
