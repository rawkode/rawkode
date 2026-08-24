import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { EntityId, IanaTimeZone } from "@athenaeum/domain"
import { formatTodayBriefError, todayBriefLoadErrorMessage } from "./today-brief-errors.js"
import { todayBriefRequest } from "./today-brief-request.js"

describe("todayBriefRequest", () => {
  it("uses the browser-local date and an explicit IANA zone", () => {
    const request = todayBriefRequest(Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000001"), new Date(2026, 0, 5), Schema.decodeUnknownSync(IanaTimeZone)("Europe/London"))
    expect(request.localDate).toBe("2026-01-05")
    expect(request.timeZone).toBe("Europe/London")
  })

  it("rejects an invalid explicit time zone", () => {
    expect(() => todayBriefRequest(Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000001"), new Date(), "Not/AZone" as never)).toThrow()
  })

  it("does not expose private values from malformed RPC output", () => {
    const privateValue = "alice@example.test/provider-private-id"
    const malformedOutputError = new Error(`Invalid Today Brief output: ${privateValue}`)

    const renderedMessage = formatTodayBriefError(malformedOutputError)

    expect(renderedMessage).toBe(todayBriefLoadErrorMessage)
    expect(renderedMessage).not.toContain(privateValue)
  })
})
