import { describe, expect, it } from "vitest"
import { WORKFORCE_RUNTIME_VERSION, nextWorkforceCadenceAt, validateWorkforceSchedule, workforceOccurrenceIdentity, workforceRetryDelayMs, workforceScheduledOccurrenceId, type WorkforceScheduleDefinition } from "./workforce-runtime.js"

const cadence = (overrides: Partial<WorkforceScheduleDefinition> = {}): WorkforceScheduleDefinition => ({
  version: WORKFORCE_RUNTIME_VERSION, workflowId: "concierge", scheduleVersion: "v1", enabled: true,
  trigger: { kind: "cadence", everyMinutes: 30, civilTimeZone: "Europe/London", misfirePolicy: "catch-up-once" }, ...overrides
})

describe("workforce runtime contracts", () => {
  it("binds an occurrence to schedule version and UTC instant, including DST fold instants", () => {
    const schedule = cadence()
    const first = workforceScheduledOccurrenceId(schedule, new Date("2026-10-25T00:30:00.000Z"))
    const folded = workforceScheduledOccurrenceId(schedule, new Date("2026-10-25T01:30:00.000Z"))
    expect(first).not.toBe(folded)
    expect(workforceScheduledOccurrenceId(cadence({ scheduleVersion: "v2" }), new Date("2026-10-25T00:30:00.000Z"))).not.toBe(first)
  })
  it("handles DST gaps as UTC instants and validates an IANA civil timezone", () => {
    const next = nextWorkforceCadenceAt(cadence(), new Date("2026-03-29T00:59:59.000Z"))
    expect(next?.toISOString()).toBe("2026-03-29T01:00:00.000Z")
    expect(() => validateWorkforceSchedule(cadence({ trigger: { kind: "cadence", everyMinutes: 30, civilTimeZone: "not/a-zone", misfirePolicy: "skip" } }))).toThrow(/IANA/)
  })
  it("evaluates explicit daily slots in civil time and picks the first fold instant", () => {
    const daily = cadence({ trigger: { kind: "cadence", everyMinutes: 1440, civilTimeZone: "Europe/London", misfirePolicy: "skip", atLocalTime: "01:30" } })
    // The autumn fold has two local 01:30s; deterministic first occurrence is 00:30Z.
    expect(nextWorkforceCadenceAt(daily, new Date("2026-10-24T23:00:00.000Z"))?.toISOString()).toBe("2026-10-25T00:30:00.000Z")
    // 01:30 does not exist in the spring gap, so skip selects the following civil day.
    expect(nextWorkforceCadenceAt(daily, new Date("2026-03-28T23:00:00.000Z"))?.toISOString()).toBe("2026-03-30T00:30:00.000Z")
  })
  it("does not schedule disabled/event definitions and has deterministic bounded backoff", () => {
    expect(nextWorkforceCadenceAt(cadence({ enabled: false }), new Date())).toBeUndefined()
    expect(nextWorkforceCadenceAt({ ...cadence(), trigger: { kind: "event", eventType: "calendar.attendee-observed.v1" } }, new Date())).toBeUndefined()
    expect(workforceRetryDelayMs(1)).toBe(1000)
    expect(workforceRetryDelayMs(2)).toBe(2000)
    expect(workforceRetryDelayMs(99)).toBe(3600000)
    expect(workforceOccurrenceIdentity("a", "v1", "event")).toBe("a:v1:event")
  })
})
