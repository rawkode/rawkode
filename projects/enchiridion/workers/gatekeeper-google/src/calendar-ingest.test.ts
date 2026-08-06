import { describe, expect, test } from "bun:test";
import { initializeSchema } from "./schema";
import { getSyncCursor } from "./token-store";
import { resolveEventIdForPageID } from "./calendar-event-id-store";
import { runCalendarIngest } from "./calendar-ingest";
import { readCalendarIngestFailures } from "./ingest-failures-store";
import type { GoogleCalendarEvent, GoogleCalendarEventsListResponse } from "./calendar-api";
import { createFakeVaultEnv } from "./test-helpers/fake-vault-env";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

function fakeFetch(handler: (url: URL) => Response): typeof fetch {
  return (async (input: string) => handler(new URL(input))) as unknown as typeof fetch;
}

function page(items: GoogleCalendarEvent[], nextSyncToken?: string, nextPageToken?: string): GoogleCalendarEventsListResponse {
  return {
    kind: "calendar#events",
    etag: '"etag"',
    summary: "david@rawkode.academy",
    updated: "2026-08-06T09:00:00.000Z",
    timeZone: "Europe/London",
    accessRole: "owner",
    nextSyncToken,
    nextPageToken,
    items,
  };
}

function standupEvent(overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return {
    kind: "calendar#event",
    etag: '"e1"',
    id: "standup-1",
    status: "confirmed",
    summary: "Daily standup",
    iCalUID: "standup-1@google.com",
    start: { dateTime: "2026-08-10T09:00:00+01:00", timeZone: "Europe/London" },
    end: { dateTime: "2026-08-10T09:15:00+01:00", timeZone: "Europe/London" },
    organizer: { email: "david@rawkode.academy", displayName: "David Flanagan" },
    attendees: [{ email: "teammate@example.com", displayName: "Teammate" }],
    ...overrides,
  };
}

describe("runCalendarIngest — incremental sync happy path", () => {
  test("first-ever run (no stored cursor) does a time-windowed full sync, materializes the event + its people, and stores the returned syncToken", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    let sawTimeWindow = false;
    const fetchImpl = fakeFetch((url) => {
      if (url.searchParams.has("timeMin") && url.searchParams.has("timeMax")) sawTimeWindow = true;
      expect(url.searchParams.has("syncToken")).toBe(false);
      return new Response(JSON.stringify(page([standupEvent()], "sync-token-v1")), { status: 200 });
    });

    const result = await runCalendarIngest({ sql, env: vault.env, accessToken: "tok", now: new Date("2026-08-06T09:00:00Z"), fetchImpl });

    expect(result.fullResync).toBe(true);
    expect(sawTimeWindow).toBe(true);
    expect(result.eventCount).toBe(1);
    expect(result.materializedCount).toBe(1);
    expect(getSyncCursor(sql, "calendar")).toBe("sync-token-v1");

    // Event page + at least the organizer + attendee Person pages were pushed.
    const eventPush = vault.createOrUpdateCalls.find((c) => c.docType === "calendarMaterializedEvent");
    expect(eventPush).toBeDefined();
    const personPushes = vault.createOrUpdateCalls.filter((c) => c.docType === "person");
    expect(personPushes.length).toBe(2); // organizer + one attendee
  });

  test("a subsequent run with a stored cursor sends syncToken, not a time window", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    // Seed a cursor as if a prior run already completed.
    await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([standupEvent()], "sync-token-v1")), { status: 200 })),
    });

    let fetchInvocations = 0;
    const fetchImpl = fakeFetch((url) => {
      fetchInvocations += 1;
      expect(url.searchParams.get("syncToken")).toBe("sync-token-v1");
      expect(url.searchParams.has("timeMin")).toBe(false);
      return new Response(JSON.stringify(page([], "sync-token-v2")), { status: 200 });
    });

    const result = await runCalendarIngest({ sql, env: vault.env, accessToken: "tok", now: new Date("2026-08-06T09:05:00Z"), fetchImpl });

    expect(result.fullResync).toBe(false);
    expect(fetchInvocations).toBe(1);
    expect(getSyncCursor(sql, "calendar")).toBe("sync-token-v2");
  });

  test("follows nextPageToken across multiple pages before capturing the final page's nextSyncToken", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    let calls = 0;
    const fetchImpl = fakeFetch((url) => {
      calls += 1;
      if (!url.searchParams.has("pageToken")) {
        return new Response(
          JSON.stringify(page([standupEvent({ id: "e1", iCalUID: "e1@google.com" })], undefined, "page-2-token")),
          { status: 200 },
        );
      }
      expect(url.searchParams.get("pageToken")).toBe("page-2-token");
      return new Response(
        JSON.stringify(page([standupEvent({ id: "e2", iCalUID: "e2@google.com" })], "final-sync-token")),
        { status: 200 },
      );
    });

    const result = await runCalendarIngest({ sql, env: vault.env, accessToken: "tok", now: new Date("2026-08-06T09:00:00Z"), fetchImpl });

    expect(calls).toBe(2);
    expect(result.eventCount).toBe(2);
    expect(getSyncCursor(sql, "calendar")).toBe("final-sync-token");
  });
});

describe("runCalendarIngest — 410 triggers a full resync", () => {
  test("an expired syncToken (410) is caught and retried as a time-windowed full sync", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    // Seed an existing (now-stale) cursor.
    await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-01T09:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([], "stale-token")), { status: 200 })),
    });

    let requestCount = 0;
    const fetchImpl = fakeFetch((url) => {
      requestCount += 1;
      if (url.searchParams.has("syncToken")) {
        return new Response(JSON.stringify({ error: { message: "Sync token invalid" } }), { status: 410 });
      }
      expect(url.searchParams.has("timeMin")).toBe(true);
      return new Response(JSON.stringify(page([standupEvent()], "fresh-sync-token")), { status: 200 });
    });

    const result = await runCalendarIngest({ sql, env: vault.env, accessToken: "tok", now: new Date("2026-08-06T09:00:00Z"), fetchImpl });

    expect(requestCount).toBe(2); // the failed syncToken attempt + the full resync
    expect(result.fullResync).toBe(true);
    expect(result.materializedCount).toBe(1);
    expect(getSyncCursor(sql, "calendar")).toBe("fresh-sync-token");
  });
});

describe("runCalendarIngest — baseline-hash prevents redundant re-materialization", () => {
  test("running ingest twice with an unchanged event pushes to VaultDO only on the first run", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    const event = standupEvent();

    const run1 = await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([event], "st-1")), { status: 200 })),
    });
    expect(run1.materializedCount).toBe(1);
    const pushesAfterRun1 = vault.createOrUpdateCalls.length;
    expect(pushesAfterRun1).toBeGreaterThan(0);

    const run2 = await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:05:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([event], "st-2")), { status: 200 })),
    });

    expect(run2.materializedCount).toBe(0);
    expect(run2.skippedCount).toBe(1);
    // No NEW vault pushes for the unchanged event/people.
    expect(vault.createOrUpdateCalls.length).toBe(pushesAfterRun1);
  });

  test("a changed provider event (new location) DOES re-materialize on the next run", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([standupEvent()], "st-1")), { status: 200 })),
    });
    const pushesAfterRun1 = vault.createOrUpdateCalls.length;

    const changed = standupEvent({ location: "Moved to the big room" });
    const run2 = await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T10:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([changed], "st-2")), { status: 200 })),
    });

    expect(run2.materializedCount).toBe(1);
    const eventPushes = vault.createOrUpdateCalls.filter((c) => c.docType === "calendarMaterializedEvent");
    expect(eventPushes.length).toBeGreaterThan(1); // the initial push + this re-materialization
    expect(vault.createOrUpdateCalls.length).toBeGreaterThan(pushesAfterRun1);
  });
});

describe("runCalendarIngest — retracting cancelled events", () => {
  test("a previously-materialized event reported as cancelled is tombstoned in VaultDO", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    const event = standupEvent();

    await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([event], "st-1")), { status: 200 })),
    });

    const cancelled: GoogleCalendarEvent = { ...event, status: "cancelled" };
    const result = await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T10:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([cancelled], "st-2")), { status: 200 })),
    });

    expect(result.retractedCount).toBe(1);
    expect(vault.tombstoneCalls.length).toBe(1);
  });

  test("a cancelled event this worker never materialized is a no-op (no tombstone call)", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    const cancelled = standupEvent({ status: "cancelled" });

    const result = await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([cancelled], "st-1")), { status: 200 })),
    });

    expect(result.retractedCount).toBe(0);
    expect(vault.tombstoneCalls.length).toBe(0);
  });
});

describe("runCalendarIngest — calendar_event_ids bookkeeping (plan §'Live Backend Connectivity (P8)', proposeRsvp real event-ID verification)", () => {
  test("records the real Google eventId/calendarId for a materialized event page, resolvable via resolveEventIdForPageID", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    const event = standupEvent();

    const result = await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([event], "st-1")), { status: 200 })),
    });
    expect(result.materializedCount).toBe(1);

    const eventPush = vault.createOrUpdateCalls.find((c) => c.docType === "calendarMaterializedEvent");
    expect(eventPush).toBeDefined();
    expect(resolveEventIdForPageID(sql, eventPush!.pageID)).toEqual({ eventId: "standup-1", calendarId: "primary" });
  });

  test("is recorded even on a re-sync run where the event is unchanged (skipped, not re-materialized) — the mapping must stay resolvable regardless of whether THIS cycle wrote to VaultDO", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    const event = standupEvent();

    await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([event], "st-1")), { status: 200 })),
    });
    const eventPush = vault.createOrUpdateCalls.find((c) => c.docType === "calendarMaterializedEvent")!;

    const run2 = await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:05:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([event], "st-2")), { status: 200 })),
    });
    expect(run2.skippedCount).toBe(1);
    expect(resolveEventIdForPageID(sql, eventPush.pageID)).toEqual({ eventId: "standup-1", calendarId: "primary" });
  });

  test("removes the mapping once the provider reports the event cancelled — a fresh RSVP proposal against that page must then be rejected", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    const event = standupEvent();

    await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([event], "st-1")), { status: 200 })),
    });
    const eventPush = vault.createOrUpdateCalls.find((c) => c.docType === "calendarMaterializedEvent")!;
    expect(resolveEventIdForPageID(sql, eventPush.pageID)).toBeDefined();

    const cancelled: GoogleCalendarEvent = { ...event, status: "cancelled" };
    await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T10:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([cancelled], "st-2")), { status: 200 })),
    });

    expect(resolveEventIdForPageID(sql, eventPush.pageID)).toBeUndefined();
  });
});

describe("runCalendarIngest — poison-pill isolation (one event's materialization failure must not sink the batch)", () => {
  test("a multi-event batch where one event's materialization throws mid-batch: the rest still succeed, the failure is recorded, and the cursor only advances once the whole batch has been attempted", async () => {
    const sql = makeSql();
    // The 2nd event-page push (of 3) throws — simulates
    // `materializeEventOccurrence`/`pushPageUpdate` failing partway
    // through a fetched batch (e.g. a transient VaultDO RPC error).
    const vault = createFakeVaultEnv({ failEventPushIndex: 2 });

    const e1 = standupEvent({ id: "e1", iCalUID: "e1@google.com", summary: "Event 1" });
    const e2 = standupEvent({ id: "e2", iCalUID: "e2@google.com", summary: "Event 2 (poison)" });
    const e3 = standupEvent({ id: "e3", iCalUID: "e3@google.com", summary: "Event 3" });

    const result = await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([e1, e2, e3], "sync-token-after-batch")), { status: 200 })),
    });

    // All 3 events were attempted: 2 materialized, 1 recorded as a failure
    // — none of e2's failure silently skipped e3 (the batch kept going).
    expect(result.eventCount).toBe(3);
    expect(result.materializedCount).toBe(2);
    expect(result.failedCount).toBe(1);

    const eventPushes = vault.createOrUpdateCalls.filter((c) => c.docType === "calendarMaterializedEvent");
    expect(eventPushes.length).toBe(2); // e1 and e3 — e2's push threw and was never recorded as a call

    // The failure was durably recorded, not just swallowed.
    const failures = readCalendarIngestFailures(sql);
    expect(failures.length).toBe(1);
    expect(failures[0]?.eventId).toBe("e2");
    expect(failures[0]?.iCalUid).toBe("e2@google.com");
    expect(failures[0]?.errorMessage).toContain("simulated VaultDO failure");

    // The cursor only advances after the WHOLE batch (all 3 events) has
    // been attempted — this is the fix: it must NOT be lost/skipped just
    // because event 2 failed, since the batch did fully complete overall.
    expect(getSyncCursor(sql, "calendar")).toBe("sync-token-after-batch");
  });

  test("REGRESSION GUARD: the batch's later events are NOT silently dropped by an earlier event's failure — this is the exact behavior the original (pre-fix) code got wrong (an uncaught exception mid-loop aborted the rest of the batch after the cursor had already been advanced)", async () => {
    const sql = makeSql();
    // Failure on the FIRST event this time — under the original bug, this
    // would have aborted the loop before event 2/3 were ever attempted
    // (while the cursor had already silently advanced past all three).
    // Under the fix, `runCalendarIngest` never throws for a single bad
    // event, and events 2/3 are still fully attempted.
    const vault = createFakeVaultEnv({ failEventPushIndex: 1 });
    const failing = standupEvent({ id: "e1", iCalUID: "e1@google.com" });
    const e2 = standupEvent({ id: "e2", iCalUID: "e2@google.com" });
    const e3 = standupEvent({ id: "e3", iCalUID: "e3@google.com" });

    const result = await runCalendarIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(page([failing, e2, e3], "st-1")), { status: 200 })),
    });

    expect(result.failedCount).toBe(1);
    // e2 and e3 — the events AFTER the failing one in iteration order —
    // were still materialized, proving the loop didn't abort.
    expect(result.materializedCount).toBe(2);
    const eventPushes = vault.createOrUpdateCalls.filter((c) => c.docType === "calendarMaterializedEvent");
    expect(eventPushes.map((c) => c.pageID).length).toBe(2);
    expect(getSyncCursor(sql, "calendar")).toBe("st-1");
  });
});
