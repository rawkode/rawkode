import { describe, expect, test } from "bun:test";
import { createGrant, revokeGrant } from "./capability-store";
import { CapabilityDeniedError } from "./capability-types";
import { readUpcomingCalendarEvents } from "./calendar-read-capability";
import type { CalendarReadStub } from "./gatekeeper-calendar-client";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function freshDb(): SqliteStorageAdapter {
  const db = new SqliteStorageAdapter();
  initializeSchema(db);
  return db;
}

function fakeCalendar(): CalendarReadStub & { calls: number } {
  const stub = {
    calls: 0,
    async listUpcomingEvents(maxResults?: number, windowDays?: number) {
      stub.calls++;
      return [{ id: "evt-1", title: "Standup", start: "2026-08-07T09:00:00Z", end: "2026-08-07T09:15:00Z", isAllDay: false, status: "confirmed" as const }];
    },
  };
  return stub;
}

describe("readUpcomingCalendarEvents", () => {
  test("a gadget with no gatekeeper.google.calendar.read grant is denied", async () => {
    const db = freshDb();
    const calendar = fakeCalendar();
    await expect(readUpcomingCalendarEvents(db, calendar, "gadget-1")).rejects.toThrow(CapabilityDeniedError);
    expect(calendar.calls).toBe(0);
  });

  test("a granted gadget can read upcoming events", async () => {
    const db = freshDb();
    createGrant(
      db,
      { gadgetId: "gadget-1", capabilityType: "gatekeeper.google.calendar.read", scope: { capabilityType: "gatekeeper.google.calendar.read" }, grantedBy: "system" },
      1000,
    );
    const calendar = fakeCalendar();
    const events = await readUpcomingCalendarEvents(db, calendar, "gadget-1", 5, 7);
    expect(events).toHaveLength(1);
    expect(calendar.calls).toBe(1);
  });

  // Adversarial-review finding: `requireCapability` ran once, BEFORE the
  // cross-worker `calendar.listUpcomingEvents(...)` await, with no re-check
  // after it resolved. A grant revoked while that call was in flight had no
  // effect — the already-in-progress RPC still completed and its data still
  // reached the gadget. This proves the fix: the grant is re-checked after
  // the await too, and the in-flight result is discarded (never returned)
  // if the grant is gone by the time the call resolves.
  test("a grant revoked while the cross-worker calendar call is in flight is denied, not returned", async () => {
    const db = freshDb();
    const grant = createGrant(
      db,
      { gadgetId: "gadget-1", capabilityType: "gatekeeper.google.calendar.read", scope: { capabilityType: "gatekeeper.google.calendar.read" }, grantedBy: "system" },
      1000,
    );

    // A mock accessor whose promise resolution is delayed under our
    // control — `listUpcomingEvents` is invoked (proving the INITIAL
    // `requireCapability` check passed and the cross-worker call actually
    // started), but does not resolve until this test explicitly lets it.
    let resolveInFlight!: (events: Awaited<ReturnType<CalendarReadStub["listUpcomingEvents"]>>) => void;
    const inFlight = new Promise<Awaited<ReturnType<CalendarReadStub["listUpcomingEvents"]>>>((resolve) => {
      resolveInFlight = resolve;
    });
    let calls = 0;
    const calendar: CalendarReadStub = {
      async listUpcomingEvents() {
        calls++;
        return inFlight;
      },
    };

    const resultPromise = readUpcomingCalendarEvents(db, calendar, "gadget-1");
    // At this point `readUpcomingCalendarEvents` has already run its
    // pre-check and called into `calendar.listUpcomingEvents` (JS runs
    // synchronously up to the first unresolved await) — the RPC is "in
    // flight" exactly as the task brief describes. Revoke the grant via a
    // direct DB write here, simulating a revocation landing while
    // gatekeeper-google is still processing the request.
    expect(calls).toBe(1);
    revokeGrant(db, grant.id, 2000);

    // Now let the in-flight call complete with real-looking data.
    resolveInFlight([{ id: "evt-1", title: "Standup", start: "2026-08-07T09:00:00Z", end: "2026-08-07T09:15:00Z", isAllDay: false, status: "confirmed" }]);

    await expect(resultPromise).rejects.toThrow(CapabilityDeniedError);
  });
});
