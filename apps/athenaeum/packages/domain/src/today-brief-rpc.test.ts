import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  GetTodayBriefInput,
  IanaTimeZone,
  LocalDate,
  PrepareMeetingInDailyNoteInput,
  TodayBriefEvent,
  TodayBriefPerson
} from "./today-brief-rpc.js"
import { LoroMutationIntentV1 } from "./page-document-rpc.js"

const workspaceId = "00000000-0000-4000-8000-000000000001"

describe("Today Brief RPC contract", () => {
  it("accepts strict local dates and valid IANA time zones", () => {
    expect(Schema.decodeUnknownSync(LocalDate)("2026-02-28")).toBe("2026-02-28")
    expect(Schema.decodeUnknownSync(IanaTimeZone)("Europe/London")).toBe("Europe/London")
    expect(Schema.decodeUnknownSync(GetTodayBriefInput)({ workspaceId, localDate: "2026-11-01", timeZone: "America/New_York" }).localDate).toBe("2026-11-01")
  })

  it("rejects impossible dates and unknown time zones before the backend", () => {
    expect(Schema.decodeUnknownEither(LocalDate)("2026-02-29")._tag).toBe("Left")
    expect(Schema.decodeUnknownEither(LocalDate)("2026-2-1")._tag).toBe("Left")
    expect(Schema.decodeUnknownEither(IanaTimeZone)("Not/AZone")._tag).toBe("Left")
  })

  it("accepts an omitted person display name but rejects null and empty values", () => {
    expect(Schema.decodeUnknownSync(TodayBriefPerson)({}).displayName).toBeUndefined()
    expect(Schema.decodeUnknownEither(TodayBriefPerson)({ displayName: null })._tag).toBe("Left")
    expect(Schema.decodeUnknownEither(TodayBriefPerson)({ displayName: "" })._tag).toBe("Left")
  })

  it("keeps meeting preparation keyed by an opaque occurrence and a typed intent", () => {
    const occurrenceKey = "a".repeat(64)
    const event = Schema.decodeUnknownSync(TodayBriefEvent)({
      id: "00000000-0000-4000-8000-000000000002",
      occurrenceKey,
      title: "Planning",
      start: "2026-02-28T09:00:00.000Z",
      end: "2026-02-28T09:30:00.000Z",
      people: [{ displayName: "Alice", personNodeId: "00000000-0000-4000-8000-000000000003" }]
    })
    const input = Schema.decodeUnknownSync(PrepareMeetingInDailyNoteInput)({
      workspaceId,
      dailyNoteId: "00000000-0000-4000-8000-000000000004",
      localDate: "2026-02-28",
      timeZone: "Europe/London",
      occurrenceKey,
      intent: {
        requestId: "meeting-preparation-contract",
        commitMessage: "Prepare the meeting in the daily note.",
        attribution: {
          version: "athenaeum.mutation-attribution.v1",
          kind: "humanUi",
          surface: "rich-text-editor"
        }
      }
    })
    expect(event.occurrenceKey).toBe(occurrenceKey)
    expect(event.people[0]?.personNodeId).toBe("00000000-0000-4000-8000-000000000003")
    expect(input.occurrenceKey).toBe(occurrenceKey)
    expect(input.intent).toBeInstanceOf(LoroMutationIntentV1)
  })
})
