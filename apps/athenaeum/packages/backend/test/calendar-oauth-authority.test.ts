import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { Email, EntityId } from "@athenaeum/domain"
import {
  activateCalendarOAuthAuthorityAttempt,
  allocateCalendarOAuthAuthorityAttempt,
  calendarOAuthCompletionView,
  claimCalendarOAuthCallback,
  expireCalendarOAuthAuthorityAttempt,
  failCalendarOAuthAuthorityAttempt,
  issueCalendarOAuthLaunch,
  markCalendarOAuthWorkspaceCommitted,
  recordCalendarOAuthProviderCompletion,
  redeemCalendarOAuthLaunch,
  resolveCalendarOAuthCompletion
} from "../src/calendar-oauth-authority.js"

const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const otherWorkspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const principal = Schema.decodeUnknownSync(Email)("owner@example.test")
const otherPrincipal = Schema.decodeUnknownSync(Email)("other@example.test")
const now = "2026-08-31T09:00:00.000Z"
const expiresAt = "2026-08-31T09:10:00.000Z"
const nonceDigest = "a".repeat(64)
const providerReceiptDigest = "b".repeat(64)
const completionFactDigest = "c".repeat(64)
const workspaceCommitWitnessDigest = "d".repeat(64)

const allocateAndActivate = () => {
  const allocation = allocateCalendarOAuthAuthorityAttempt({ workspaceId, principal, now, expiresAt, authorityAttemptId: "coa_test", clientHandle: "oca_client" })
  const activated = activateCalendarOAuthAuthorityAttempt({ attempt: allocation.attempt, workspaceId, principal, allocationWitnessDigest: allocation.attempt.allocationWitnessDigest, stateNonceDigest: nonceDigest, now })
  return { allocation, activated }
}

const consumeLaunch = (attempt: ReturnType<typeof allocateAndActivate>["activated"], capability = "ocl_first") => {
  const launched = issueCalendarOAuthLaunch({ attempt, workspaceId, principal, now, launchCapability: capability })
  return redeemCalendarOAuthLaunch({ attempt: launched.attempt, launchCapability: capability, expectedLaunchGeneration: launched.attempt.launchGeneration, now })
}

describe("calendar OAuth authority state machine", () => {
  it("uses an immutable allocation witness for activation replay after a lost authority response", () => {
    const { allocation, activated } = allocateAndActivate()
    const replay = activateCalendarOAuthAuthorityAttempt({ attempt: activated, workspaceId, principal, allocationWitnessDigest: allocation.attempt.allocationWitnessDigest, stateNonceDigest: nonceDigest, now: "2026-08-31T09:01:00.000Z" })

    expect(replay).toEqual(activated)
    expect(() => activateCalendarOAuthAuthorityAttempt({ attempt: activated, workspaceId, principal, allocationWitnessDigest: "e".repeat(64), stateNonceDigest: nonceDigest, now })).toThrow("Calendar connection is unavailable.")
  })

  it("separates stable handles from rotating launch capabilities and consumes one-time launch capability", () => {
    const { allocation, activated } = allocateAndActivate()
    const first = issueCalendarOAuthLaunch({ attempt: activated, workspaceId, principal, now, launchCapability: "ocl_first" })
    const second = issueCalendarOAuthLaunch({ attempt: first.attempt, workspaceId, principal, now: "2026-08-31T09:01:00.000Z", launchCapability: "ocl_second" })

    expect(second.attempt.clientHandleDigest).toBe(activated.clientHandleDigest)
    expect(second.attempt.launchGeneration).toBe(2)
    expect(() => redeemCalendarOAuthLaunch({ attempt: second.attempt, launchCapability: "ocl_first", expectedLaunchGeneration: first.attempt.launchGeneration, now: "2026-08-31T09:01:00.000Z" })).toThrow("Calendar connection is unavailable.")
    const consumed = redeemCalendarOAuthLaunch({ attempt: second.attempt, launchCapability: "ocl_second", expectedLaunchGeneration: second.attempt.launchGeneration, now: "2026-08-31T09:01:00.000Z" })
    expect(consumed.launchCapabilityDigest).toBeUndefined()
    expect(() => redeemCalendarOAuthLaunch({ attempt: consumed, launchCapability: "ocl_second", expectedLaunchGeneration: second.attempt.launchGeneration, now: "2026-08-31T09:01:00.000Z" })).toThrow("Calendar connection is unavailable.")
    expect(JSON.stringify(consumed)).not.toContain(allocation.clientHandle)
    expect(JSON.stringify(consumed)).not.toContain("ocl_first")
    expect(JSON.stringify(consumed)).not.toContain("ocl_second")
  })

  it("reclaims an expired callback lease and rejects stale provider completion", () => {
    const { activated } = allocateAndActivate()
    const consumed = consumeLaunch(activated)
    const first = claimCalendarOAuthCallback({ attempt: consumed, stateNonceDigest: nonceDigest, now, leaseExpiresAt: "2026-08-31T09:01:00.000Z", callbackLease: "oclse_first" })
    const second = claimCalendarOAuthCallback({ attempt: first.attempt, stateNonceDigest: nonceDigest, now: "2026-08-31T09:02:00.000Z", leaseExpiresAt: "2026-08-31T09:03:00.000Z", callbackLease: "oclse_second" })

    expect(() => recordCalendarOAuthProviderCompletion({ attempt: second.attempt, callbackLease: "oclse_first", callbackFence: first.attempt.callbackFence, providerReceiptDigest, completionFactDigest, now: "2026-08-31T09:02:00.000Z" })).toThrow("Calendar connection is unavailable.")
    const completed = recordCalendarOAuthProviderCompletion({ attempt: second.attempt, callbackLease: "oclse_second", callbackFence: second.attempt.callbackFence, providerReceiptDigest, completionFactDigest, now: "2026-08-31T09:02:00.000Z" })
    expect(calendarOAuthCompletionView(completed, "2026-08-31T09:02:00.000Z")).toEqual({ status: "pending" })
  })

  it("recovers a provider completion after TTL, then commits immutable facts to a connected record", () => {
    const { allocation, activated } = allocateAndActivate()
    const consumed = consumeLaunch(activated)
    const claimed = claimCalendarOAuthCallback({ attempt: consumed, stateNonceDigest: nonceDigest, now, leaseExpiresAt: "2026-08-31T09:01:00.000Z", callbackLease: "oclse_first" })
    const providerCompleted = recordCalendarOAuthProviderCompletion({ attempt: claimed.attempt, callbackLease: "oclse_first", callbackFence: claimed.attempt.callbackFence, providerReceiptDigest, completionFactDigest, now })
    const postTtl = "2026-08-31T10:00:00.000Z"
    expect(recordCalendarOAuthProviderCompletion({ attempt: providerCompleted, callbackLease: "lost-response-is-irrelevant", callbackFence: claimed.attempt.callbackFence, providerReceiptDigest, completionFactDigest, now: postTtl })).toEqual(providerCompleted)
    expect(() => recordCalendarOAuthProviderCompletion({ attempt: providerCompleted, callbackLease: "lost-response-is-irrelevant", callbackFence: claimed.attempt.callbackFence, providerReceiptDigest: "e".repeat(64), completionFactDigest, now: postTtl })).toThrow("Calendar connection is unavailable.")
    expect(calendarOAuthCompletionView(providerCompleted, postTtl)).toEqual({ status: "pending" })
    expect(() => failCalendarOAuthAuthorityAttempt(providerCompleted, postTtl)).toThrow("Calendar connection is unavailable.")
    expect(() => expireCalendarOAuthAuthorityAttempt(providerCompleted, postTtl)).toThrow("Calendar connection is unavailable.")
    const committed = markCalendarOAuthWorkspaceCommitted({ attempt: providerCompleted, workspaceId, principal, providerReceiptDigest, completionFactDigest, workspaceCommitWitnessDigest, now: postTtl })
    const replay = markCalendarOAuthWorkspaceCommitted({ attempt: committed, workspaceId, principal, providerReceiptDigest, completionFactDigest, workspaceCommitWitnessDigest, now: "2026-08-31T10:01:00.000Z" })

    expect(replay).toEqual(committed)
    expect(() => markCalendarOAuthWorkspaceCommitted({ attempt: committed, workspaceId, principal, providerReceiptDigest: "e".repeat(64), completionFactDigest, workspaceCommitWitnessDigest, now: "2026-08-31T10:01:00.000Z" })).toThrow("Calendar connection is unavailable.")
    expect(() => markCalendarOAuthWorkspaceCommitted({ attempt: committed, workspaceId, principal, providerReceiptDigest, completionFactDigest, workspaceCommitWitnessDigest: "e".repeat(64), now: "2026-08-31T10:01:00.000Z" })).toThrow("Calendar connection is unavailable.")
    expect(calendarOAuthCompletionView(committed, "2026-08-31T10:00:00.000Z")).toEqual({ status: "connected" })
    expect(resolveCalendarOAuthCompletion({ attempt: committed, workspaceId, principal, clientHandle: allocation.clientHandle, now: "2026-08-31T10:00:00.000Z" })).toEqual({ status: "connected" })
  })

  it("fences completion reads by workspace, principal, and opaque handle", () => {
    const { allocation, activated } = allocateAndActivate()
    expect(() => issueCalendarOAuthLaunch({ attempt: activated, workspaceId: otherWorkspaceId, principal, now, launchCapability: "ocl_foreign" })).toThrow("Calendar connection is unavailable.")
    expect(() => resolveCalendarOAuthCompletion({ attempt: activated, workspaceId: otherWorkspaceId, principal, clientHandle: allocation.clientHandle, now })).toThrow("Calendar connection is unavailable.")
    expect(() => resolveCalendarOAuthCompletion({ attempt: activated, workspaceId, principal: otherPrincipal, clientHandle: allocation.clientHandle, now })).toThrow("Calendar connection is unavailable.")
    expect(() => resolveCalendarOAuthCompletion({ attempt: activated, workspaceId, principal, clientHandle: "oca_wrong", now })).toThrow("Calendar connection is unavailable.")
  })

  it("rejects invalid timestamps and callback leases", () => {
    expect(() => allocateCalendarOAuthAuthorityAttempt({ workspaceId, principal, now: "not-a-time", expiresAt, clientHandle: "oca_client" })).toThrow("timestamp is invalid")
    const { activated } = allocateAndActivate()
    const consumed = consumeLaunch(activated)
    expect(() => claimCalendarOAuthCallback({ attempt: consumed, stateNonceDigest: nonceDigest, now, leaseExpiresAt: now, callbackLease: "oclse_bad" })).toThrow("lease is invalid")
  })
})
