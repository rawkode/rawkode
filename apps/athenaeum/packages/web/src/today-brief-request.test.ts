import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { EntityId, IanaTimeZone } from "@athenaeum/domain"
import { formatTodayBriefError, todayBriefFailurePresentation, todayBriefLoadErrorMessage } from "./today-brief-errors.js"
import { todayBriefRequest } from "./today-brief-request.js"

describe("todayBriefRequest", () => {
  it("keeps failure copy safe and contextual for current and historical briefs", () => {
    const privateWireValue = "backend=https://internal.example/api?credential=private-token"
    const today = todayBriefFailurePresentation(true)
    expect(today).toEqual({
      title: "Today’s brief is unavailable",
      message: "We couldn’t resolve today’s calendar context. Retry to load it safely.",
      retryLabel: "Retry today’s brief",
      retryingLabel: "Retrying today’s brief…",
      retryHint: "Retries loading today’s calendar context."
    })
    const historical = todayBriefFailurePresentation(false)
    expect(historical.title).toBe("Daily brief is unavailable")
    expect(historical.retryLabel).toBe("Retry daily brief")
    expect(JSON.stringify({ today, historical })).not.toContain(privateWireValue)
  })

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
