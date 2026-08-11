import { describe, expect, test } from "bun:test";
import { CalendarApiError } from "./calendar-api";
import { createCalendarEvent, rsvpToCalendarEvent } from "./calendar-write-model";
import type { GoogleCalendarEvent } from "./calendar-api";

function fakeFetch(handler: (url: URL, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string, init?: RequestInit) => handler(new URL(input), init)) as unknown as typeof fetch;
}

const CREATED_EVENT: GoogleCalendarEvent = {
  kind: "calendar#event",
  etag: '"e1"',
  id: "new-event-id",
  status: "confirmed",
  summary: "New meeting",
  iCalUID: "new-event-id@google.com",
  start: { dateTime: "2026-08-15T10:00:00+01:00" },
  end: { dateTime: "2026-08-15T10:30:00+01:00" },
};

describe("createCalendarEvent", () => {
  test("POSTs to events.insert with the expected body and auth header", async () => {
    let seenUrl: URL | undefined;
    let seenInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify(CREATED_EVENT), { status: 200 });
    });

    const result = await createCalendarEvent(
      "access-token-1",
      {
        summary: "New meeting",
        start: { dateTime: "2026-08-15T10:00:00+01:00" },
        end: { dateTime: "2026-08-15T10:30:00+01:00" },
        attendeeEmails: ["guest@example.com"],
      },
      fetchImpl,
    );

    expect(result.id).toBe("new-event-id");
    expect(seenUrl?.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(seenInit?.method).toBe("POST");
    expect((seenInit?.headers as Record<string, string>)?.authorization).toBe("Bearer access-token-1");
    const body = JSON.parse(seenInit!.body as string);
    expect(body.summary).toBe("New meeting");
    expect(body.attendees).toEqual([{ email: "guest@example.com" }]);
  });

  test("uses a non-default calendarId when given", async () => {
    let seenUrl: URL | undefined;
    const fetchImpl = fakeFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify(CREATED_EVENT), { status: 200 });
    });
    await createCalendarEvent(
      "tok",
      { calendarId: "team@rawkode.academy", summary: "x", start: {}, end: {} },
      fetchImpl,
    );
    expect(seenUrl?.pathname).toBe("/calendar/v3/calendars/team%40rawkode.academy/events");
  });

  test("a non-2xx response throws CalendarApiError", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ error: { message: "Forbidden" } }), { status: 403 }));
    await expect(
      createCalendarEvent("tok", { summary: "x", start: {}, end: {} }, fetchImpl),
    ).rejects.toBeInstanceOf(CalendarApiError);
  });
});

describe("rsvpToCalendarEvent", () => {
  const EVENT_WITH_SELF: GoogleCalendarEvent = {
    kind: "calendar#event",
    etag: '"e2"',
    id: "existing-event",
    iCalUID: "existing-event@google.com",
    start: { dateTime: "2026-08-15T10:00:00+01:00" },
    end: { dateTime: "2026-08-15T10:30:00+01:00" },
    attendees: [
      { email: "organizer@example.com", organizer: true, responseStatus: "accepted" },
      { email: "david@rawkode.academy", self: true, responseStatus: "needsAction" },
    ],
  };

  test("GETs the event, updates only the self attendee's responseStatus, then PATCHes it back", async () => {
    const calls: { method: string; url: URL; body?: string; headers?: Record<string, string> }[] = [];
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body as string | undefined,
        headers: init?.headers as Record<string, string> | undefined,
      });
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify(EVENT_WITH_SELF), { status: 200 });
      }
      const patched = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ...EVENT_WITH_SELF, attendees: patched.attendees }), { status: 200 });
    });

    const result = await rsvpToCalendarEvent("tok", { eventPageID: "event-page-1", eventId: "existing-event", calendarId: "primary", responseStatus: "accepted" }, fetchImpl);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("PATCH");

    const patchedAttendees = JSON.parse(calls[1]!.body!).attendees;
    expect(patchedAttendees).toEqual([
      { email: "organizer@example.com", organizer: true, responseStatus: "accepted" },
      { email: "david@rawkode.academy", self: true, responseStatus: "accepted" },
    ]);
    expect(result.attendees?.find((a) => a.self)?.responseStatus).toBe("accepted");
  });

  test("sends the GET response's etag as If-Match on the PATCH (Fix 4: concurrency guard)", async () => {
    const calls: { method: string; headers?: Record<string, string> }[] = [];
    const fetchImpl = fakeFetch((_url, init) => {
      calls.push({ method: init?.method ?? "GET", headers: init?.headers as Record<string, string> | undefined });
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify(EVENT_WITH_SELF), { status: 200 });
      }
      return new Response(JSON.stringify(EVENT_WITH_SELF), { status: 200 });
    });

    await rsvpToCalendarEvent("tok", { eventPageID: "event-page-1", eventId: "existing-event", calendarId: "primary", responseStatus: "accepted" }, fetchImpl);

    expect(calls[1]?.headers?.["If-Match"]).toBe(EVENT_WITH_SELF.etag);
  });

  test("a 412 Precondition Failed on the PATCH (concurrent modification) throws CalendarApiError(412), not a crash", async () => {
    const fetchImpl = fakeFetch((_url, init) => {
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify(EVENT_WITH_SELF), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: "Precondition Failed" } }), { status: 412 });
    });

    const rejection = rsvpToCalendarEvent("tok", { eventPageID: "event-page-1", eventId: "existing-event", calendarId: "primary", responseStatus: "accepted" }, fetchImpl);
    await expect(rejection).rejects.toBeInstanceOf(CalendarApiError);
    await expect(rejection).rejects.toThrow(/concurrent modification/i);
    try {
      await rejection;
    } catch (error) {
      expect((error as CalendarApiError).status).toBe(412);
    }
  });

  test("throws if the authenticated account is not among the event's attendees", async () => {
    const notInvited: GoogleCalendarEvent = { ...EVENT_WITH_SELF, attendees: [{ email: "someone-else@example.com" }] };
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify(notInvited), { status: 200 }));
    await expect(rsvpToCalendarEvent("tok", { eventPageID: "event-page-1", eventId: "existing-event", calendarId: "primary", responseStatus: "declined" }, fetchImpl)).rejects.toThrow(
      /not among its attendees/,
    );
  });

  test("a failed GET throws CalendarApiError without attempting the PATCH", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ error: { message: "Not Found" } }), { status: 404 }));
    await expect(rsvpToCalendarEvent("tok", { eventPageID: "event-page-1", eventId: "missing", calendarId: "primary", responseStatus: "accepted" }, fetchImpl)).rejects.toBeInstanceOf(
      CalendarApiError,
    );
  });

  test("a missing resolved eventId throws (defense-in-depth — this file must never trust an unresolved payload; the real 'unresolvable eventPageID' rejection happens earlier, at propose time, in write-model.ts)", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify(EVENT_WITH_SELF), { status: 200 }));
    await expect(rsvpToCalendarEvent("tok", { eventPageID: "event-page-1", responseStatus: "accepted" }, fetchImpl)).rejects.toThrow(
      /missing resolved Google Calendar eventId/,
    );
  });

  test("a missing resolved calendarId throws too (defense-in-depth is NOT one-sided) — a payload that resolved eventId but somehow dropped calendarId must fail loudly, not silently fall back to 'primary' the way an unrelated genuinely-optional calendarId (e.g. createCalendarEvent's) would", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify(EVENT_WITH_SELF), { status: 200 }));
    await expect(
      rsvpToCalendarEvent("tok", { eventPageID: "event-page-1", eventId: "existing-event", responseStatus: "accepted" }, fetchImpl),
    ).rejects.toThrow(/missing resolved Google Calendar calendarId/);
  });
});
