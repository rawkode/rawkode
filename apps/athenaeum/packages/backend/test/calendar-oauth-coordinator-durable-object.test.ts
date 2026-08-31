import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { CalendarOAuthAdmissionReceipt, CalendarOAuthProviderCompletionWitness, Email, EntityId } from "@athenaeum/domain"
import { CalendarOAuthCoordinator, CalendarOAuthCoordinatorError } from "../src/calendar-oauth-coordinator-durable-object.js"
import { CalendarOAuthWorkspaceAdmissions } from "../src/calendar-oauth-workspace-admission.js"

const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const principal = Schema.decodeUnknownSync(Email)("owner@example.test")
const secret = "workspace-admission-secret"
const now = "2026-08-31T10:00:00.000Z"
const digest = "a".repeat(64)

const setup = () => {
  const workspace = new CalendarOAuthWorkspaceAdmissions()
  const admission = workspace.begin({ workspaceId, principal, requestId: "connect-1", commitMessage: "Connect my calendar.", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-calendar" }, handleSecret: secret, now })
  const coordinator = new CalendarOAuthCoordinator(secret)
  coordinator.allocateActivate({ admission: admission.receipt, now })
  return { admission, coordinator }
}

const completionFor = (admission: ReturnType<typeof setup>["admission"]) => Schema.decodeUnknownSync(CalendarOAuthProviderCompletionWitness)({
  version: "athenaeum.calendar-oauth-provider-completion.v1",
  providerConnectionId: "gpc_3fa85f64-5717-4562-b3fc-2c963f66afa6",
  gatekeeperAttemptId: "gka_3fa85f64-5717-4562-b3fc-2c963f66afa5",
  bindingId: EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa4"),
  providerReceiptDigest: digest, completionFactDigest: digest,
  admissionWitnessDigest: admission.receipt.admissionWitnessDigest
})

describe("Calendar OAuth coordinator authority", () => {
  it("requires a Workspace-authentic admission receipt and persists only its digest registry", () => {
    const { admission, coordinator } = setup()
    expect(coordinator.allocateActivate({ admission: admission.receipt, now })).toBeDefined()
    const forged = Schema.decodeUnknownSync(CalendarOAuthAdmissionReceipt)({ ...admission.receipt, admissionWitnessDigest: "b".repeat(64) })
    expect(() => coordinator.allocateActivate({ admission: forged, now })).toThrow(CalendarOAuthCoordinatorError)
  })

  it("creates state only at POST redemption and fences stale callback generations after a fresh launch", () => {
    const { admission, coordinator } = setup()
    const first = coordinator.issueLaunch({ authorityAttemptId: admission.receipt.authorityAttemptId, workspaceId, principal, now, launchCapability: "ocl_first" })
    const redeemed = coordinator.redeemLaunch({ authorityAttemptId: admission.receipt.authorityAttemptId, launchCapability: first.launchCapability, expectedLaunchGeneration: first.launchGeneration, stateNonce: "old-state", now })
    const second = coordinator.issueLaunch({ authorityAttemptId: admission.receipt.authorityAttemptId, workspaceId, principal, now: "2026-08-31T10:01:00.000Z", launchCapability: "ocl_second" })
    const fresh = coordinator.redeemLaunch({ authorityAttemptId: admission.receipt.authorityAttemptId, launchCapability: second.launchCapability, expectedLaunchGeneration: second.launchGeneration, stateNonce: "new-state", now: "2026-08-31T10:01:00.000Z" })
    expect(fresh.stateGeneration).toBeGreaterThan(redeemed.stateGeneration)
    expect(() => coordinator.claimCallback({ authorityAttemptId: admission.receipt.authorityAttemptId, stateNonce: "old-state", stateGeneration: redeemed.stateGeneration, now: "2026-08-31T10:01:00.000Z", leaseExpiresAt: "2026-08-31T10:02:00.000Z" })).toThrow(CalendarOAuthCoordinatorError)
  })

  it("keeps exact provider completion recoverable after TTL and accepts only an exact Workspace acknowledgement", () => {
    const { admission, coordinator } = setup()
    const launch = coordinator.issueLaunch({ authorityAttemptId: admission.receipt.authorityAttemptId, workspaceId, principal, now, launchCapability: "ocl_first" })
    const redeemed = coordinator.redeemLaunch({ authorityAttemptId: admission.receipt.authorityAttemptId, launchCapability: launch.launchCapability, expectedLaunchGeneration: launch.launchGeneration, stateNonce: "state", now })
    const claim = coordinator.claimCallback({ authorityAttemptId: admission.receipt.authorityAttemptId, stateNonce: redeemed.stateNonce, stateGeneration: redeemed.stateGeneration, now, leaseExpiresAt: "2026-08-31T10:01:00.000Z", callbackLease: "oclse_lease" })
    const completion = completionFor(admission)
    // Transport may contain accidental provider fields; coordinator copies only the witness schema.
    const completionWithRawTransportFields = { ...completion, authorizationCode: "provider-code-must-not-persist", state: "state-must-not-persist" } as CalendarOAuthProviderCompletionWitness
    const recorded = coordinator.recordCompletion({ authorityAttemptId: admission.receipt.authorityAttemptId, callbackLease: claim.callbackLease, callbackFence: claim.callbackFence, completion: completionWithRawTransportFields, now })
    expect(JSON.stringify(recorded)).not.toContain("provider-code-must-not-persist")
    expect(JSON.stringify(recorded)).not.toContain("state-must-not-persist")
    expect(JSON.stringify(recorded)).not.toContain("ocl_first")
    expect(coordinator.recordCompletion({ authorityAttemptId: admission.receipt.authorityAttemptId, callbackLease: "lost-response", callbackFence: claim.callbackFence, completion, now: "2026-08-31T10:20:00.000Z" })).toBeDefined()
    expect(() => coordinator.reconcileWorkspaceCommit({ authorityAttemptId: admission.receipt.authorityAttemptId, workspaceId, principal, completion: Schema.decodeUnknownSync(CalendarOAuthProviderCompletionWitness)({ ...completion, completionFactDigest: "b".repeat(64) }), workspaceCommitWitnessDigest: digest, now: "2026-08-31T10:20:00.000Z" })).toThrow(CalendarOAuthCoordinatorError)
    coordinator.reconcileWorkspaceCommit({ authorityAttemptId: admission.receipt.authorityAttemptId, workspaceId, principal, completion, workspaceCommitWitnessDigest: digest, now: "2026-08-31T10:20:00.000Z" })
    expect(coordinator.completionView({ authorityAttemptId: admission.receipt.authorityAttemptId, workspaceId, principal, attemptHandle: admission.attemptHandle, now: "2026-08-31T10:20:00.000Z" })).toEqual({ status: "connected" })
  })
})
