import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Email } from "./auth.js"
import {
  CalendarEvent,
  CalendarEventAttendee,
  CalendarEventStatus,
  CalendarEventTime
} from "./calendar-event.js"
import { EntityId, IsoDateTimeString } from "./node.js"

const id = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const masterId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa8")
const nodeId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa9")
const email = (value: string) => Schema.decodeUnknownSync(Email)(value)
const syncedAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date(0).toISOString())

const dateTime = (value: string) =>
  Schema.decodeUnknownSync(CalendarEventTime)({ kind: "dateTime", dateTime: value })

describe("CalendarEventTime", () => {
  it("round-trips an all-day date", () => {
    const decoded = Schema.decodeUnknownSync(CalendarEventTime)({ kind: "date", date: "2026-06-09" })
    expect(Schema.decodeUnknownSync(CalendarEventTime)(Schema.encodeSync(CalendarEventTime)(decoded))).toEqual(
      decoded
    )
  })

  it("round-trips a timed dateTime with a timeZone", () => {
    const decoded = Schema.decodeUnknownSync(CalendarEventTime)({
      kind: "dateTime",
      dateTime: "2026-06-09T10:00:00Z",
      timeZone: "America/Los_Angeles"
    })
    expect(Schema.decodeUnknownSync(CalendarEventTime)(Schema.encodeSync(CalendarEventTime)(decoded))).toEqual(
      decoded
    )
  })
})

describe("CalendarEventStatus", () => {
  it("accepts every documented Google Calendar status", () => {
    for (const status of ["confirmed", "tentative", "cancelled"]) {
      expect(Schema.decodeUnknownSync(CalendarEventStatus)(status)).toBe(status)
    }
  })

  it("rejects an undocumented status", () => {
    const result = Schema.decodeUnknownEither(CalendarEventStatus)("deleted")
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("CalendarEventAttendee", () => {
  it("round-trips with and without displayName", () => {
    const withName = new CalendarEventAttendee({ email: email("bob@example.com"), displayName: "Bob" })
    const withoutName = new CalendarEventAttendee({ email: email("carol@example.com") })
    for (const attendee of [withName, withoutName]) {
      expect(
        Schema.decodeUnknownSync(CalendarEventAttendee)(Schema.encodeSync(CalendarEventAttendee)(attendee))
      ).toEqual(attendee)
    }
    expect("displayName" in Schema.encodeSync(CalendarEventAttendee)(withoutName)).toBe(false)
  })
})

describe("CalendarEvent", () => {
  it("round-trips a standalone event: no seriesId/occurrenceId/masterRecordId", () => {
    const event = new CalendarEvent({
      id,
      workspaceId,
      providerEventId: "google-event-1",
      title: "1:1 with Bob",
      start: dateTime("2026-06-09T10:00:00Z"),
      end: dateTime("2026-06-09T10:30:00Z"),
      attendees: [new CalendarEventAttendee({ email: email("bob@example.com"), displayName: "Bob" })],
      status: "confirmed",
      syncedAt
    })
    const encoded = Schema.encodeSync(CalendarEvent)(event)
    expect(Schema.decodeUnknownSync(CalendarEvent)(encoded)).toEqual(event)
    expect("seriesId" in encoded).toBe(false)
    expect("occurrenceId" in encoded).toBe(false)
    expect("masterRecordId" in encoded).toBe(false)
    expect("linkedNodeId" in encoded).toBe(false)
  })

  it("round-trips a series-master record: seriesId set, occurrenceId/masterRecordId absent", () => {
    const master = new CalendarEvent({
      id: masterId,
      workspaceId,
      providerEventId: "google-series-master",
      seriesId: "google-series-master",
      title: "Weekly standup",
      start: dateTime("2026-06-08T09:00:00Z"),
      end: dateTime("2026-06-08T09:15:00Z"),
      attendees: [],
      status: "confirmed",
      syncedAt
    })
    const encoded = Schema.encodeSync(CalendarEvent)(master)
    expect(Schema.decodeUnknownSync(CalendarEvent)(encoded)).toEqual(master)
    expect(encoded.seriesId).toBe("google-series-master")
    expect("occurrenceId" in encoded).toBe(false)
    expect("masterRecordId" in encoded).toBe(false)
  })

  it("round-trips an occurrence record: seriesId, occurrenceId, and masterRecordId all set", () => {
    const occurrence = new CalendarEvent({
      id,
      workspaceId,
      providerEventId: "google-series-master_20260608T090000Z",
      seriesId: "google-series-master",
      occurrenceId: "2026-06-08T09:00:00Z",
      masterRecordId: masterId,
      title: "Weekly standup",
      start: dateTime("2026-06-08T09:00:00Z"),
      end: dateTime("2026-06-08T09:15:00Z"),
      attendees: [],
      status: "confirmed",
      syncedAt
    })
    const encoded = Schema.encodeSync(CalendarEvent)(occurrence)
    expect(Schema.decodeUnknownSync(CalendarEvent)(encoded)).toEqual(occurrence)
    expect(encoded.masterRecordId).toBe(masterId)
  })

  it("round-trips a cancelled occurrence with a companion linkedNodeId", () => {
    const cancelled = new CalendarEvent({
      id,
      workspaceId,
      providerEventId: "google-series-master_20260615T090000Z",
      seriesId: "google-series-master",
      occurrenceId: "2026-06-15T09:00:00Z",
      masterRecordId: masterId,
      title: "Weekly standup",
      start: dateTime("2026-06-15T09:00:00Z"),
      end: dateTime("2026-06-15T09:15:00Z"),
      attendees: [],
      status: "cancelled",
      linkedNodeId: nodeId,
      syncedAt
    })
    const encoded = Schema.encodeSync(CalendarEvent)(cancelled)
    expect(Schema.decodeUnknownSync(CalendarEvent)(encoded)).toEqual(cancelled)
    expect(encoded.linkedNodeId).toBe(nodeId)
  })

  it("rejects an empty providerEventId", () => {
    const result = Schema.decodeUnknownEither(CalendarEvent)({
      id,
      workspaceId,
      providerEventId: "",
      title: "x",
      start: { kind: "date", date: "2026-06-09" },
      end: { kind: "date", date: "2026-06-10" },
      attendees: [],
      status: "confirmed",
      syncedAt
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})
