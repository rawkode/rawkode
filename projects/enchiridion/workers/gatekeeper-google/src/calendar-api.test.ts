import { describe, expect, test } from "bun:test";
import { CalendarApiError, CalendarSyncTokenExpiredError, listEventsPage } from "./calendar-api";
import type { GoogleCalendarEventsListResponse } from "./calendar-api";

function fakeFetch(handler: (url: URL, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string, init?: RequestInit) => handler(new URL(input), init)) as unknown as typeof fetch;
}

const SAMPLE_RESPONSE: GoogleCalendarEventsListResponse = {
  kind: "calendar#events",
  etag: '"p32etag"',
  summary: "david@rawkode.academy",
  updated: "2026-08-06T09:00:00.000Z",
  timeZone: "Europe/London",
  accessRole: "owner",
  nextSyncToken: "CPDAsMLXsIwDEAUYASD",
  items: [
    {
      kind: "calendar#event",
      etag: '"3123456789000000"',
      id: "abc123",
      status: "confirmed",
      summary: "Standup",
      iCalUID: "abc123@google.com",
      start: { dateTime: "2026-08-10T09:00:00+01:00", timeZone: "Europe/London" },
      end: { dateTime: "2026-08-10T09:15:00+01:00", timeZone: "Europe/London" },
    },
  ],
};

describe("listEventsPage", () => {
  test("incremental sync request carries syncToken, singleEvents=true, and no orderBy", async () => {
    let seenUrl: URL | undefined;
    const fetchImpl = fakeFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 });
    });
    const result = await listEventsPage({ accessToken: "tok", syncToken: "stored-token-123", fetchImpl });
    expect(result.items).toHaveLength(1);
    expect(result.nextSyncToken).toBe("CPDAsMLXsIwDEAUYASD");
    expect(seenUrl?.searchParams.get("syncToken")).toBe("stored-token-123");
    expect(seenUrl?.searchParams.get("singleEvents")).toBe("true");
    expect(seenUrl?.searchParams.has("orderBy")).toBe(false);
    expect(seenUrl?.pathname).toBe("/calendar/v3/calendars/primary/events");
  });

  test("full (time-windowed) sync request carries timeMin/timeMax/orderBy and no syncToken", async () => {
    let seenUrl: URL | undefined;
    const fetchImpl = fakeFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ ...SAMPLE_RESPONSE, nextSyncToken: undefined }), { status: 200 });
    });
    await listEventsPage({
      accessToken: "tok",
      timeMin: "2026-07-01T00:00:00.000Z",
      timeMax: "2027-01-01T00:00:00.000Z",
      fetchImpl,
    });
    expect(seenUrl?.searchParams.get("orderBy")).toBe("startTime");
    expect(seenUrl?.searchParams.get("timeMin")).toBe("2026-07-01T00:00:00.000Z");
    expect(seenUrl?.searchParams.get("timeMax")).toBe("2027-01-01T00:00:00.000Z");
    expect(seenUrl?.searchParams.has("syncToken")).toBe(false);
  });

  test("forwards pageToken for pagination", async () => {
    let seenUrl: URL | undefined;
    const fetchImpl = fakeFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 });
    });
    await listEventsPage({ accessToken: "tok", syncToken: "st", pageToken: "next-page-abc", fetchImpl });
    expect(seenUrl?.searchParams.get("pageToken")).toBe("next-page-abc");
  });

  test("410 Gone throws CalendarSyncTokenExpiredError", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ error: { message: "Sync token is no longer valid" } }), { status: 410 }));
    await expect(listEventsPage({ accessToken: "tok", syncToken: "expired", fetchImpl })).rejects.toBeInstanceOf(CalendarSyncTokenExpiredError);
  });

  test("a non-410 error response throws CalendarApiError with the status + Google's message", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), { status: 401 }));
    try {
      await listEventsPage({ accessToken: "bad-token", fetchImpl });
      throw new Error("expected listEventsPage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CalendarApiError);
      expect((error as CalendarApiError).status).toBe(401);
      expect((error as CalendarApiError).message).toContain("Invalid Credentials");
    }
  });

  test("sends the access token as a Bearer authorization header", async () => {
    let seenAuth: string | null | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenAuth = (init?.headers as Record<string, string>)?.authorization;
      return new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 });
    });
    await listEventsPage({ accessToken: "secret-token", syncToken: "st", fetchImpl });
    expect(seenAuth).toBe("Bearer secret-token");
  });
});
