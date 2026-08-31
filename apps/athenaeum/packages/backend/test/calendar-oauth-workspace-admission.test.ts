import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { CalendarOAuthAdmissionReceiptV1, CalendarOAuthClientAttemptHandle, CalendarOAuthProviderCompletionWitness, Email, EntityId } from "@athenaeum/domain"
import { CalendarOAuthWorkspaceAdmissionError, CalendarOAuthWorkspaceAdmissions } from "../src/calendar-oauth-workspace-admission.js"

const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const principal = Schema.decodeUnknownSync(Email)("owner@example.test")
const digest = "a".repeat(64)
const secret = "workspace-handle-secret"
const now = "2026-08-31T10:00:00.000Z"
const begin = (store: CalendarOAuthWorkspaceAdmissions, commitMessage = "Connect my calendar.") => store.begin({ workspaceId, principal, requestId: "connect-1", commitMessage, attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-calendar" }, handleSecret: secret, now })

describe("Workspace calendar OAuth admission", () => {
  it("replays an exact Begin with a stable versioned handle and rejects changed intent", () => {
    const store = new CalendarOAuthWorkspaceAdmissions()
    const first = begin(store)
    const replay = begin(store)
    expect(replay).toEqual(first)
    expect(Schema.decodeUnknownSync(CalendarOAuthClientAttemptHandle)(first.attemptHandle)).toBe(first.attemptHandle)
    expect(first.receipt.handleDerivationVersion).toBe("hmac-sha256.workspace-principal-request-fingerprint.v1")
    expect(JSON.stringify(first.receipt)).not.toContain(first.attemptHandle)
    expect(() => begin(store, "Connect another calendar.")).toThrow(CalendarOAuthWorkspaceAdmissionError)
  })

  it("replays a receipt after HMAC key rotation only when the old key is retained", () => {
    const store = new CalendarOAuthWorkspaceAdmissions()
    const first = begin(store)
    expect(() => store.begin({ workspaceId, principal, requestId: "connect-1", commitMessage: "Connect my calendar.", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-calendar" }, handleSecret: "new-secret", now })).toThrow(CalendarOAuthWorkspaceAdmissionError)
    const replay = store.begin({ workspaceId, principal, requestId: "connect-1", commitMessage: "Connect my calendar.", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-calendar" }, handleSecret: "new-secret", retainedHandleSecrets: [secret], now })
    expect(replay).toEqual(first)
  })

  it("restores receipt-only admission state and re-derives its stable handle", () => {
    const store = new CalendarOAuthWorkspaceAdmissions()
    const first = begin(store)
    const snapshot = store.snapshot()
    expect(JSON.stringify(snapshot)).not.toContain(first.attemptHandle)
    const restored = new CalendarOAuthWorkspaceAdmissions(snapshot)
    expect(begin(restored)).toEqual(first)
    expect(restored.resolveHandle({ workspaceId, principal, attemptHandle: first.attemptHandle })).toEqual(first.receipt)
  })

  it("requires the authentic admission witness and exact completion facts for idempotent finalization", () => {
    const store = new CalendarOAuthWorkspaceAdmissions()
    const admission = begin(store)
    const completion = {
      version: "athenaeum.calendar-oauth-provider-completion.v1" as const,
      providerConnectionId: admission.receipt.providerConnectionId,
      gatekeeperAttemptId: admission.receipt.gatekeeperAttemptId,
      bindingId: admission.receipt.bindingId,
      providerReceiptDigest: digest,
      completionFactDigest: digest,
      admissionWitnessDigest: admission.receipt.admissionWitnessDigest
    }
    const first = store.finalize({ admission: admission.receipt, completion: Schema.decodeUnknownSync(CalendarOAuthProviderCompletionWitness)(completion), workspaceCommitWitnessDigest: digest, now })
    expect(store.finalize({ admission: admission.receipt, completion: Schema.decodeUnknownSync(CalendarOAuthProviderCompletionWitness)(completion), workspaceCommitWitnessDigest: digest, now })).toEqual(first)
    expect(() => store.finalize({ admission: admission.receipt, completion: Schema.decodeUnknownSync(CalendarOAuthProviderCompletionWitness)({ ...completion, admissionWitnessDigest: "b".repeat(64) }), workspaceCommitWitnessDigest: digest, now })).toThrow(CalendarOAuthWorkspaceAdmissionError)
    expect(() => store.finalize({ admission: admission.receipt, completion: Schema.decodeUnknownSync(CalendarOAuthProviderCompletionWitness)({ ...completion, providerConnectionId: "gpc_3fa85f64-5717-4562-b3fc-2c963f66afa6" }), workspaceCommitWitnessDigest: digest, now })).toThrow(CalendarOAuthWorkspaceAdmissionError)
    expect(() => store.finalize({ admission: admission.receipt, completion: Schema.decodeUnknownSync(CalendarOAuthProviderCompletionWitness)({ ...completion, gatekeeperAttemptId: "coa_3fa85f64-5717-4562-b3fc-2c963f66afa5" }), workspaceCommitWitnessDigest: digest, now })).toThrow(CalendarOAuthWorkspaceAdmissionError)
    expect(() => store.finalize({ admission: admission.receipt, completion: Schema.decodeUnknownSync(CalendarOAuthProviderCompletionWitness)({ ...completion, bindingId: EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa4") }), workspaceCommitWitnessDigest: digest, now })).toThrow(CalendarOAuthWorkspaceAdmissionError)
  })

  it("fails closed when a historical v1 receipt is restored after the pre-bound identity migration", () => {
    const store = new CalendarOAuthWorkspaceAdmissions()
    const admission = begin(store)
    const legacy = new CalendarOAuthAdmissionReceiptV1({
      version: "athenaeum.calendar-oauth-admission.v1",
      workspaceId: admission.receipt.workspaceId,
      principal: admission.receipt.principal,
      requestId: admission.receipt.requestId,
      requestFingerprint: admission.receipt.requestFingerprint,
      handleDerivationVersion: admission.receipt.handleDerivationVersion,
      attemptHandleDigest: admission.receipt.attemptHandleDigest,
      calendarConnectionId: admission.receipt.calendarConnectionId,
      authorityAttemptId: admission.receipt.authorityAttemptId,
      admissionWitnessDigest: admission.receipt.admissionWitnessDigest,
      admittedAt: admission.receipt.admittedAt
    })
    const restored = new CalendarOAuthWorkspaceAdmissions({ admissions: [legacy], commits: [] })
    expect(() => begin(restored)).toThrow("must be restarted after migration")
  })
})
