import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { CalendarEvent, CalendarEventAttendee, EntityId } from "@athenaeum/domain"
import { projectTodayBriefEvents, resolveTodayBriefWindow } from "../src/calendar-service-live.js"

const id = (value: string) => Schema.decodeUnknownSync(EntityId)(value)
const workspaceId = id("00000000-0000-4000-8000-000000000001")

const event = (overrides: Partial<ConstructorParameters<typeof CalendarEvent>[0]> = {}) =>
  new CalendarEvent({
    id: id("00000000-0000-4000-8000-000000000002"),
    workspaceId,
    providerEventId: "event-1",
    title: "Planning",
    start: { kind: "dateTime", dateTime: "2026-11-01T13:00:00.000Z" },
    end: { kind: "dateTime", dateTime: "2026-11-01T13:30:00.000Z" },
    attendees: [
      new CalendarEventAttendee({ email: "owner@example.test" as never, displayName: "Owner" }),
      new CalendarEventAttendee({ email: "alice@example.test" as never, displayName: " Alice " }),
      new CalendarEventAttendee({ email: "alice@example.test" as never, displayName: "Alice duplicate" })
    ],
    status: "confirmed",
    syncedAt: "2026-10-30T12:00:00.000Z",
    ...overrides
  })

describe("Today Brief server projection", () => {
  it("resolves DST local-day bounds on the server for London and New York", () => {
    const london = resolveTodayBriefWindow("2026-03-29", "Europe/London")
    expect(london).toMatchObject({ timeZone: "Europe/London", from: "2026-03-29T00:00:00.000Z", to: "2026-03-29T23:00:00.000Z" })

    const newYork = resolveTodayBriefWindow("2026-11-01", "America/New_York")
    expect(newYork).toMatchObject({ timeZone: "America/New_York", from: "2026-11-01T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z" })
  })

  it("rejects local dates whose midnight cannot be represented in the requested zone", () => {
    expect(() => resolveTodayBriefWindow("2011-12-30", "Pacific/Apia")).toThrow(/Local midnight does not exist/)
  })

  it("returns only active occurrences in [from, to), deduplicated and without email addresses", () => {
    const window = resolveTodayBriefWindow("2026-11-01", "America/New_York")
    const duplicate = event({ id: id("00000000-0000-4000-8000-000000000003"), syncedAt: "2026-10-31T12:00:00.000Z" })
    const master = event({ id: id("00000000-0000-4000-8000-000000000004"), providerEventId: "series", seriesId: "series" })
    const cancelled = event({ id: id("00000000-0000-4000-8000-000000000005"), providerEventId: "series_occurrence", seriesId: "series", occurrenceId: "2026-11-01T13:00:00.000Z", masterRecordId: id("00000000-0000-4000-8000-000000000004"), status: "cancelled" })
    const result = projectTodayBriefEvents([duplicate, master, cancelled, event()], window.from, window.to, "America/New_York", "OWNER@EXAMPLE.TEST")

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ title: "Planning", people: [{ displayName: "Alice" }] })
    expect(JSON.stringify(result)).not.toContain("@example.test")
  })

  it("excludes events ending at the lower bound and sorts retained rows by start then title", () => {
    const window = resolveTodayBriefWindow("2026-11-01", "UTC")
    const endingAtStart = event({ start: { kind: "dateTime", dateTime: "2026-10-31T23:00:00.000Z" }, end: { kind: "dateTime", dateTime: "2026-11-01T00:00:00.000Z" } })
    const later = event({ id: id("00000000-0000-4000-8000-000000000006"), providerEventId: "later", title: "Zebra", start: { kind: "dateTime", dateTime: "2026-11-01T14:00:00.000Z" }, end: { kind: "dateTime", dateTime: "2026-11-01T14:30:00.000Z" } })
    const earlier = event({ id: id("00000000-0000-4000-8000-000000000007"), providerEventId: "earlier", title: "Alpha", start: { kind: "dateTime", dateTime: "2026-11-01T09:00:00.000Z" }, end: { kind: "dateTime", dateTime: "2026-11-01T09:30:00.000Z" } })
    expect(projectTodayBriefEvents([later, endingAtStart, earlier], window.from, window.to, "UTC", undefined).map((row) => row.title)).toEqual(["Alpha", "Zebra"])
  })

  it("uses the newest occurrence row before excluding a cancellation tombstone, independent of input order", () => {
    const window = resolveTodayBriefWindow("2026-11-01", "UTC")
    const confirmed = event({
      id: id("00000000-0000-4000-8000-000000000008"),
      providerEventId: "series_occurrence",
      seriesId: "series",
      occurrenceId: "2026-11-01T13:00:00.000Z",
      syncedAt: "2026-10-30T12:00:00.000Z"
    })
    const cancelled = event({
      id: id("00000000-0000-4000-8000-000000000009"),
      providerEventId: "series_occurrence",
      seriesId: "series",
      occurrenceId: "2026-11-01T13:00:00.000Z",
      status: "cancelled",
      syncedAt: "2026-10-31T12:00:00.000Z"
    })

    expect(projectTodayBriefEvents([confirmed, cancelled], window.from, window.to, "UTC", undefined)).toEqual([])
    expect(projectTodayBriefEvents([cancelled, confirmed], window.from, window.to, "UTC", undefined)).toEqual([])
  })

  it("lets an equal-sync cancellation tombstone win regardless of input order", () => {
    const window = resolveTodayBriefWindow("2026-11-01", "UTC")
    const confirmed = event({
      id: id("00000000-0000-4000-8000-000000000012"),
      providerEventId: "equal-sync-cancellation"
    })
    const cancelled = event({
      id: id("00000000-0000-4000-8000-000000000013"),
      providerEventId: "equal-sync-cancellation",
      status: "cancelled"
    })

    expect(projectTodayBriefEvents([confirmed, cancelled], window.from, window.to, "UTC", undefined)).toEqual([])
    expect(projectTodayBriefEvents([cancelled, confirmed], window.from, window.to, "UTC", undefined)).toEqual([])
  })

  it("uses documented status then row-id ties when duplicate sync instants differ", () => {
    const window = resolveTodayBriefWindow("2026-11-01", "UTC")
    const tentative = event({
      id: id("00000000-0000-4000-8000-000000000010"),
      providerEventId: "equal-sync-status",
      title: "Tentative copy",
      status: "tentative"
    })
    const confirmed = event({
      id: id("00000000-0000-4000-8000-000000000011"),
      providerEventId: "equal-sync-status",
      title: "Confirmed copy",
      status: "confirmed"
    })

    for (const rows of [
      [tentative, confirmed],
      [confirmed, tentative]
    ]) {
      expect(projectTodayBriefEvents(rows, window.from, window.to, "UTC", undefined)).toMatchObject([{ id: confirmed.id, title: "Confirmed copy" }])
    }
  })
})
