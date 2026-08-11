import { describe, expect, mock, test } from "bun:test";
import { CALENDAR_SCOPE_NOT_GRANTED_MESSAGE } from "@enchiridion/gadget-gatekeeper-google-rpc-contract";
import type { CalendarReadRpcStub } from "./calendar-read-model";
import { listUpcomingEvents } from "./calendar-read-model";

function fakeStub(overrides: Partial<CalendarReadRpcStub> = {}): CalendarReadRpcStub {
  return {
    hasScope: mock(async () => true),
    getValidAccessToken: mock(async () => "token-1"),
    ...overrides,
  };
}

describe("listUpcomingEvents", () => {
  test("throws the shared scope-not-granted message when calendar.events isn't granted", async () => {
    const stub = fakeStub({ hasScope: mock(async () => false) });
    await expect(listUpcomingEvents(stub)).rejects.toThrow(CALENDAR_SCOPE_NOT_GRANTED_MESSAGE);
  });

  test("fetches a time-windowed page (no syncToken) and summarizes events, respecting maxResults", async () => {
    let seenUrl: URL | undefined;
    const fetchImpl = (async (input: string) => {
      seenUrl = new URL(input);
      return new Response(
        JSON.stringify({
          kind: "calendar#events",
          etag: "e",
          summary: "primary",
          updated: "2026-08-01T00:00:00Z",
          timeZone: "UTC",
          items: [
            {
              kind: "calendar#event",
              etag: "e1",
              id: "evt-1",
              status: "confirmed",
              summary: "Standup",
              iCalUID: "evt-1@google.com",
              start: { dateTime: "2026-08-07T09:00:00Z" },
              end: { dateTime: "2026-08-07T09:15:00Z" },
            },
            {
              kind: "calendar#event",
              etag: "e2",
              id: "evt-2",
              status: "tentative",
              summary: "Offsite",
              iCalUID: "evt-2@google.com",
              start: { date: "2026-08-08" },
              end: { date: "2026-08-09" },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const stub = fakeStub();
    const events = await listUpcomingEvents(stub, 1, 7, new Date("2026-08-07T00:00:00Z"), fetchImpl);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "evt-1", title: "Standup", isAllDay: false, status: "confirmed" });
    expect(seenUrl?.searchParams.has("syncToken")).toBe(false);
    expect(seenUrl?.searchParams.has("timeMin")).toBe(true);
    expect(seenUrl?.searchParams.has("timeMax")).toBe(true);
  });
});
