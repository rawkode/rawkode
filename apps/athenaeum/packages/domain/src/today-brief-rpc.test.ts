import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { GetTodayBriefInput, IanaTimeZone, LocalDate } from "./today-brief-rpc.js"

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
})
