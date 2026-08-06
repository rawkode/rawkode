import { describe, expect, test } from "bun:test";
import { derivePersonPageId } from "@enchiridion/graph-core";
import type { GoogleCalendarEvent, GoogleCalendarEventsListResponse } from "./calendar-api";
import { eventBaselineHash, normalizeOccurrence, personBaselineHash } from "./calendar-materialization";

// Real-shaped fixtures (Google Calendar API v3 `events.list` response) —
// see calendar-api.ts's file header for why these mirror the real
// documented shape rather than a simplified stand-in.
function listResponse(items: GoogleCalendarEvent[]): GoogleCalendarEventsListResponse {
  return {
    kind: "calendar#events",
    etag: '"p32sample"',
    summary: "david@rawkode.academy",
    updated: "2026-08-06T09:00:00.000Z",
    timeZone: "Europe/London",
    accessRole: "owner",
    items,
  };
}

const TIMED_EVENT: GoogleCalendarEvent = {
  kind: "calendar#event",
  etag: '"3123456789000000"',
  id: "abc123def456",
  status: "confirmed",
  summary: "Team sync",
  location: "Meeting Room 1",
  iCalUID: "abc123def456@google.com",
  start: { dateTime: "2026-08-10T10:00:00+01:00", timeZone: "Europe/London" },
  end: { dateTime: "2026-08-10T10:30:00+01:00", timeZone: "Europe/London" },
  organizer: { email: "david@rawkode.academy", displayName: "David Flanagan" },
  attendees: [
    { email: "david@rawkode.academy", displayName: "David Flanagan", organizer: true, self: true, responseStatus: "accepted" },
    { email: "guest@example.com", displayName: "Guest Person", responseStatus: "needsAction" },
  ],
  updated: "2026-08-06T09:00:00.000Z",
};

const ALL_DAY_EVENT: GoogleCalendarEvent = {
  kind: "calendar#event",
  etag: '"3123456789000001"',
  id: "allday789",
  status: "confirmed",
  summary: "Conference",
  iCalUID: "allday789@google.com",
  start: { date: "2026-09-01" },
  end: { date: "2026-09-03" },
  updated: "2026-08-06T09:00:00.000Z",
};

describe("normalizeOccurrence", () => {
  test("derives a stable pageID for a timed event, matching graph-core's identity scheme", async () => {
    const occurrence = await normalizeOccurrence(TIMED_EVENT, listResponse([TIMED_EVENT]));
    expect(occurrence).toBeDefined();
    expect(occurrence?.pageID).toMatch(/^calendar_event_[0-9a-f]{40}$/);
    expect(occurrence?.title).toBe("Team sync");
    expect(occurrence?.isAllDay).toBe(false);
    expect(occurrence?.calendarTitle).toBe("david@rawkode.academy");
    expect(occurrence?.location).toBe("Meeting Room 1");
  });

  test("is deterministic — the same event normalizes to the same pageID every time", async () => {
    const list = listResponse([TIMED_EVENT]);
    const first = await normalizeOccurrence(TIMED_EVENT, list);
    const second = await normalizeOccurrence(TIMED_EVENT, list);
    expect(first?.pageID).toBe(second!.pageID);
  });

  test("derives all-day events using the civil day + calendar's time zone", async () => {
    const occurrence = await normalizeOccurrence(ALL_DAY_EVENT, listResponse([ALL_DAY_EVENT]));
    expect(occurrence).toBeDefined();
    expect(occurrence?.isAllDay).toBe(true);
    expect(occurrence?.pageID).toMatch(/^calendar_event_[0-9a-f]{40}$/);
  });

  test("a moved recurring instance keeps the ORIGINAL slot's identity but shows the moved time", async () => {
    const moved: GoogleCalendarEvent = {
      ...TIMED_EVENT,
      id: "recur-instance-1",
      iCalUID: "recurring-series@google.com",
      recurringEventId: "recurring-series",
      originalStartTime: { dateTime: "2026-08-11T10:00:00+01:00", timeZone: "Europe/London" },
      start: { dateTime: "2026-08-11T14:00:00+01:00", timeZone: "Europe/London" },
      end: { dateTime: "2026-08-11T14:30:00+01:00", timeZone: "Europe/London" },
    };
    const unmovedIdentity: GoogleCalendarEvent = {
      ...moved,
      originalStartTime: undefined,
      start: { dateTime: "2026-08-11T10:00:00+01:00", timeZone: "Europe/London" },
      end: { dateTime: "2026-08-11T10:30:00+01:00", timeZone: "Europe/London" },
    };

    const movedOccurrence = await normalizeOccurrence(moved, listResponse([moved]));
    const unmovedOccurrence = await normalizeOccurrence(unmovedIdentity, listResponse([unmovedIdentity]));

    // Same identity (both keyed off the original 10:00 slot)...
    expect(movedOccurrence?.pageID).toBe(unmovedOccurrence?.pageID);
    // ...but the moved instance displays its NEW time.
    expect(movedOccurrence?.start).toBe(new Date("2026-08-11T14:00:00+01:00").toISOString());
  });

  test("returns undefined for an event with a blank iCalendar UID", async () => {
    const bad: GoogleCalendarEvent = { ...TIMED_EVENT, iCalUID: "   " };
    expect(await normalizeOccurrence(bad, listResponse([bad]))).toBeUndefined();
  });

  test("returns undefined when start/end are missing", async () => {
    const bad: GoogleCalendarEvent = { ...TIMED_EVENT, start: undefined, end: undefined };
    expect(await normalizeOccurrence(bad, listResponse([bad]))).toBeUndefined();
  });

  test("excludes resource attendees (e.g. meeting rooms) from the Person-page candidate list", async () => {
    const withRoom: GoogleCalendarEvent = {
      ...TIMED_EVENT,
      attendees: [
        ...(TIMED_EVENT.attendees ?? []),
        { email: "room-1@resource.calendar.google.com", resource: true, responseStatus: "accepted" },
      ],
    };
    const occurrence = await normalizeOccurrence(withRoom, listResponse([withRoom]));
    expect(occurrence?.attendees.some((a) => a.email.includes("resource.calendar.google.com"))).toBe(false);
  });
});

describe("eventBaselineHash — change detection", () => {
  test("is stable for an unchanged occurrence", async () => {
    const occurrence = await normalizeOccurrence(TIMED_EVENT, listResponse([TIMED_EVENT]));
    const first = await eventBaselineHash(occurrence!);
    const second = await eventBaselineHash(occurrence!);
    expect(first).toBe(second);
  });

  test("changes when the title changes", async () => {
    const occurrence = await normalizeOccurrence(TIMED_EVENT, listResponse([TIMED_EVENT]));
    const renamed = { ...occurrence!, title: "Team sync (renamed)" };
    expect(await eventBaselineHash(occurrence!)).not.toBe(await eventBaselineHash(renamed));
  });

  test("changes when the attendee list changes, even if title/time are unchanged", async () => {
    const occurrence = await normalizeOccurrence(TIMED_EVENT, listResponse([TIMED_EVENT]));
    const withExtraAttendee = {
      ...occurrence!,
      attendees: [...occurrence!.attendees, { email: "new-guest@example.com" }],
    };
    expect(await eventBaselineHash(occurrence!)).not.toBe(await eventBaselineHash(withExtraAttendee));
  });

  test("is insensitive to attendee ordering (sorted before hashing)", async () => {
    const occurrence = await normalizeOccurrence(TIMED_EVENT, listResponse([TIMED_EVENT]));
    const reversed = { ...occurrence!, attendees: [...occurrence!.attendees].reverse() };
    expect(await eventBaselineHash(occurrence!)).toBe(await eventBaselineHash(reversed));
  });
});

describe("personBaselineHash", () => {
  test("changes when displayName changes but not when it's just re-hashed", async () => {
    const a = await personBaselineHash("Guest Person", "guest@example.com");
    const b = await personBaselineHash("Guest Person", "guest@example.com");
    const c = await personBaselineHash("Guest P. Renamed", "guest@example.com");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("attendee Person-page derivation matches graph-core's real digest output", () => {
  test("derivePersonPageId(email) is exactly what materialization would key a Person page under", async () => {
    const expected = await derivePersonPageId("Guest@Example.com");
    const actual = await derivePersonPageId("  guest@example.com  ");
    expect(actual).toBe(expected);
    expect(actual).toMatch(/^person_[0-9a-f]{40}$/);
  });
});
