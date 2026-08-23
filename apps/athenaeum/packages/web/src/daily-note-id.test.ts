import { describe, expect, it } from "vitest"
import {
  dailyNoteIdForDate,
  dateStampFromDailyNoteId,
  localDateStamp,
  parseDateStamp,
  shiftDateStamp
} from "./daily-note-id.js"

// Retrieval pass (design-review 2026-08-22 finding #1): the day-navigation route and the
// `/node/:id` view both depend on these being exact inverses of the deterministic daily-note-id
// scheme — a mismatch would silently open (or create!) the wrong day's note.

describe("parseDateStamp", () => {
  it("parses a real calendar date in local time", () => {
    const date = parseDateStamp("2026-08-22")
    expect(date).toBeDefined()
    expect(localDateStamp(date!)).toBe("2026-08-22")
  })

  it("rejects malformed and impossible dates", () => {
    expect(parseDateStamp("not-a-date")).toBeUndefined()
    expect(parseDateStamp("2026-8-2")).toBeUndefined()
    expect(parseDateStamp("2026-02-31")).toBeUndefined()
    expect(parseDateStamp("2026-13-01")).toBeUndefined()
    expect(parseDateStamp("")).toBeUndefined()
  })
})

describe("dateStampFromDailyNoteId", () => {
  it("round-trips dailyNoteIdForDate for an arbitrary day", () => {
    const date = parseDateStamp("2026-08-22")!
    const id = dailyNoteIdForDate(date)
    expect(id).toBe("00000000-0000-4000-8000-000020260822")
    expect(dateStampFromDailyNoteId(id)).toBe("2026-08-22")
  })

  it("returns undefined for non-daily-note ids", () => {
    expect(dateStampFromDailyNoteId("018f6a5e-0000-7000-8000-000000000000")).toBeUndefined()
    // Base-tag reserved family (all-zero groups) must never read as a daily note.
    expect(dateStampFromDailyNoteId("00000000-0000-0000-0000-000000000001")).toBeUndefined()
    // Reserved-family shape but an impossible embedded date.
    expect(dateStampFromDailyNoteId("00000000-0000-4000-8000-000099999999")).toBeUndefined()
  })
})

describe("shiftDateStamp", () => {
  it("shifts across month and year boundaries", () => {
    expect(shiftDateStamp("2026-08-22", -1)).toBe("2026-08-21")
    expect(shiftDateStamp("2026-08-31", 1)).toBe("2026-09-01")
    expect(shiftDateStamp("2026-01-01", -1)).toBe("2025-12-31")
  })
})
