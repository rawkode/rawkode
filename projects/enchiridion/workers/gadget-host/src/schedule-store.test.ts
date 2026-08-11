import { describe, expect, test } from "bun:test";
import {
  MAX_SCHEDULES_PER_GADGET,
  ScheduleLimitExceededError,
  countSchedules,
  disableAllSchedulesForGadget,
  listDueSchedules,
  listSchedules,
  registerSchedule,
  setScheduleEnabled,
} from "./schedule-store";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function freshDb(): SqliteStorageAdapter {
  const db = new SqliteStorageAdapter();
  initializeSchema(db);
  return db;
}

describe("registerSchedule — Fix 3 per-gadget cap", () => {
  test("registering up to MAX_SCHEDULES_PER_GADGET schedules succeeds", () => {
    const db = freshDb();
    for (let i = 0; i < MAX_SCHEDULES_PER_GADGET; i++) {
      registerSchedule(db, "gadget-1", 60, 1000);
    }
    expect(countSchedules(db, "gadget-1")).toBe(MAX_SCHEDULES_PER_GADGET);
  });

  test("registering past the cap is rejected with a clear error, not silently accepted", () => {
    const db = freshDb();
    for (let i = 0; i < MAX_SCHEDULES_PER_GADGET; i++) {
      registerSchedule(db, "gadget-1", 60, 1000);
    }

    expect(() => registerSchedule(db, "gadget-1", 60, 1000)).toThrow(ScheduleLimitExceededError);
    try {
      registerSchedule(db, "gadget-1", 60, 1000);
      throw new Error("expected registerSchedule to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleLimitExceededError);
      expect((error as Error).message).toContain("gadget-1");
      expect((error as Error).message).toContain(String(MAX_SCHEDULES_PER_GADGET));
    }

    // The row count never grew past the cap — the rejected call is a true no-op.
    expect(countSchedules(db, "gadget-1")).toBe(MAX_SCHEDULES_PER_GADGET);
  });

  test("a gadget stuck in a scheduleRegister loop cannot starve the fan-out tick past the cap", () => {
    const db = freshDb();
    let accepted = 0;
    for (let i = 0; i < 1000; i++) {
      try {
        registerSchedule(db, "gadget-loop", 1, 1000); // every registration is immediately due
        accepted++;
      } catch {
        // expected once the cap is hit
      }
    }
    expect(accepted).toBe(MAX_SCHEDULES_PER_GADGET);
    expect(listDueSchedules(db, 1000)).toHaveLength(MAX_SCHEDULES_PER_GADGET);
  });

  test("the cap is per-gadget, not global — another gadget is unaffected", () => {
    const db = freshDb();
    for (let i = 0; i < MAX_SCHEDULES_PER_GADGET; i++) {
      registerSchedule(db, "gadget-1", 60, 1000);
    }
    expect(() => registerSchedule(db, "gadget-2", 60, 1000)).not.toThrow();
    expect(countSchedules(db, "gadget-2")).toBe(1);
  });

  test("disabled rows still count toward the cap — disabling is not a way to farm more slots", () => {
    const db = freshDb();
    const schedules = [];
    for (let i = 0; i < MAX_SCHEDULES_PER_GADGET; i++) {
      schedules.push(registerSchedule(db, "gadget-1", 60, 1000));
    }
    for (const schedule of schedules) {
      setScheduleEnabled(db, schedule.id, false);
    }
    expect(() => registerSchedule(db, "gadget-1", 60, 1000)).toThrow(ScheduleLimitExceededError);
  });
});

describe("setScheduleEnabled", () => {
  test("disabling a schedule removes it from listDueSchedules even though it's still due", () => {
    const db = freshDb();
    const schedule = registerSchedule(db, "gadget-1", 60, 1000); // due at 1000
    expect(listDueSchedules(db, 2000)).toHaveLength(1);

    setScheduleEnabled(db, schedule.id, false);
    expect(listDueSchedules(db, 2000)).toHaveLength(0);

    const stored = listSchedules(db, "gadget-1")[0]!;
    expect(stored.enabled).toBe(false);
  });

  test("re-enabling a schedule makes it due again", () => {
    const db = freshDb();
    const schedule = registerSchedule(db, "gadget-1", 60, 1000);
    setScheduleEnabled(db, schedule.id, false);
    setScheduleEnabled(db, schedule.id, true);
    expect(listDueSchedules(db, 2000)).toHaveLength(1);
  });
});

describe("disableAllSchedulesForGadget — Fix 2b cascade", () => {
  test("disables every enabled schedule for the gadget, leaves other gadgets untouched", () => {
    const db = freshDb();
    registerSchedule(db, "gadget-1", 60, 1000);
    registerSchedule(db, "gadget-1", 30, 1000);
    registerSchedule(db, "gadget-2", 60, 1000);

    disableAllSchedulesForGadget(db, "gadget-1");

    const gadget1 = listSchedules(db, "gadget-1");
    expect(gadget1.every((s) => s.enabled === false)).toBe(true);
    const gadget2 = listSchedules(db, "gadget-2");
    expect(gadget2.every((s) => s.enabled === true)).toBe(true);

    expect(listDueSchedules(db, 2000).map((s) => s.gadgetId)).toEqual(["gadget-2"]);
  });

  test("is idempotent — calling twice doesn't throw and leaves rows disabled", () => {
    const db = freshDb();
    registerSchedule(db, "gadget-1", 60, 1000);
    disableAllSchedulesForGadget(db, "gadget-1");
    expect(() => disableAllSchedulesForGadget(db, "gadget-1")).not.toThrow();
    expect(listSchedules(db, "gadget-1").every((s) => s.enabled === false)).toBe(true);
  });

  test("a gadget with no schedules is a no-op", () => {
    const db = freshDb();
    expect(() => disableAllSchedulesForGadget(db, "gadget-none")).not.toThrow();
  });
});
