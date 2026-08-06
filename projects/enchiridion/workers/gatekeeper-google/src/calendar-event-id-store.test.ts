import { describe, expect, test } from "bun:test";
import { deleteCalendarEventId, recordCalendarEventId, resolveEventIdForPageID } from "./calendar-event-id-store";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

describe("recordCalendarEventId / resolveEventIdForPageID — vault Event pageID -> real Google (eventId, calendarId) lookup (RSVP write-model)", () => {
  test("resolves a page id that has been recorded to its real eventId/calendarId", () => {
    const sql = makeSql();
    recordCalendarEventId(sql, "event_page_aaa", "evt-real-1", "primary");
    expect(resolveEventIdForPageID(sql, "event_page_aaa")).toEqual({ eventId: "evt-real-1", calendarId: "primary" });
  });

  test("an unknown page id resolves to undefined, not an error — the caller (proposeRsvp) is what turns that into a rejection", () => {
    const sql = makeSql();
    expect(resolveEventIdForPageID(sql, "event_page_never_seen")).toBeUndefined();
  });

  test("does not confuse two different page ids with different event ids", () => {
    const sql = makeSql();
    recordCalendarEventId(sql, "event_page_aaa", "evt-real-1", "primary");
    recordCalendarEventId(sql, "event_page_bbb", "evt-real-2", "primary");
    expect(resolveEventIdForPageID(sql, "event_page_aaa")).toEqual({ eventId: "evt-real-1", calendarId: "primary" });
    expect(resolveEventIdForPageID(sql, "event_page_bbb")).toEqual({ eventId: "evt-real-2", calendarId: "primary" });
  });

  test("recording the same page id again UPSERTS (updates in place) rather than erroring or duplicating", () => {
    const sql = makeSql();
    recordCalendarEventId(sql, "event_page_aaa", "evt-real-1", "primary");
    recordCalendarEventId(sql, "event_page_aaa", "evt-real-1-again", "primary");
    expect(resolveEventIdForPageID(sql, "event_page_aaa")).toEqual({ eventId: "evt-real-1-again", calendarId: "primary" });
  });
});

describe("deleteCalendarEventId — removed on cancellation so a retracted event can never resolve for a fresh RSVP proposal", () => {
  test("removes a previously recorded mapping", () => {
    const sql = makeSql();
    recordCalendarEventId(sql, "event_page_aaa", "evt-real-1", "primary");
    deleteCalendarEventId(sql, "event_page_aaa");
    expect(resolveEventIdForPageID(sql, "event_page_aaa")).toBeUndefined();
  });

  test("is a no-op (never throws) for a page id with no mapping at all", () => {
    const sql = makeSql();
    expect(() => deleteCalendarEventId(sql, "event_page_never_seen")).not.toThrow();
  });

  test("deleting one page id's mapping leaves an unrelated page id's mapping intact", () => {
    const sql = makeSql();
    recordCalendarEventId(sql, "event_page_aaa", "evt-real-1", "primary");
    recordCalendarEventId(sql, "event_page_bbb", "evt-real-2", "primary");
    deleteCalendarEventId(sql, "event_page_aaa");
    expect(resolveEventIdForPageID(sql, "event_page_aaa")).toBeUndefined();
    expect(resolveEventIdForPageID(sql, "event_page_bbb")).toEqual({ eventId: "evt-real-2", calendarId: "primary" });
  });
});
