import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { Email, EntityId, IsoDateTimeString } from "@athenaeum/domain"
import { CalendarOAuthAttemptRecord } from "../src/calendar-connection-identity.js"
import { canFinalizeCalendarOAuthAttempt } from "../src/calendar-service-live.js"

const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const bindingId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const principal = Schema.decodeUnknownSync(Email)("owner@example.test")
const connectionId = "gpc_3fa85f64-5717-4562-b3fc-2c963f66afa9"
const digest = "a".repeat(64)
const at = (milliseconds: number) => Schema.decodeUnknownSync(IsoDateTimeString)(new Date(milliseconds).toISOString())

const attempt = (overrides: Partial<ConstructorParameters<typeof CalendarOAuthAttemptRecord>[0]> = {}) =>
  new CalendarOAuthAttemptRecord({
    attemptId: "coa_3fa85f64-5717-4562-b3fc-2c963f66afa8",
    stateNonceDigest: digest,
    workspaceId,
    principal,
    providerConnectionId: connectionId,
    bindingId,
    calendarId: "primary",
    mode: "selected",
    lifecycle: "exchanging",
    issuedAt: at(0),
    expiresAt: at(10_000),
    fence: 2,
    revision: 2,
    rowHash: digest,
    leaseToken: "lease-b",
    leaseExpiresAt: at(5_000),
    ...overrides
  })

const input = (row: CalendarOAuthAttemptRecord, nowMs: number, leaseToken = "lease-b", fence = 2) => ({
  attempt: row,
  workspaceId,
  principal,
  providerConnectionId: connectionId,
  bindingId,
  leaseToken,
  fence,
  nowMs
})

describe("calendar OAuth callback finalization fence", () => {
  it("does not activate after the claimed lease expires", () => {
    expect(canFinalizeCalendarOAuthAttempt(input(attempt(), 5_000))).toBe(false)
  })

  it("rejects attempt expiry between provider receipt and local finalization", () => {
    expect(canFinalizeCalendarOAuthAttempt(input(attempt(), 10_000))).toBe(false)
  })

  it("rejects stale claimant A after lease reclaim and permits only B", () => {
    const reclaimed = attempt({ leaseToken: "lease-b", fence: 3, leaseExpiresAt: at(8_000), revision: 3 })
    expect(canFinalizeCalendarOAuthAttempt(input(reclaimed, 6_000, "lease-a", 2))).toBe(false)
    expect(canFinalizeCalendarOAuthAttempt(input(reclaimed, 6_000, "lease-b", 3))).toBe(true)
  })
})
