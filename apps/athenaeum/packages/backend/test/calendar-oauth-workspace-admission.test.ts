import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { CalendarOAuthProviderCompletionWitness, Email, EntityId } from "@athenaeum/domain"
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
    expect(first.receipt.handleDerivationVersion).toBe("hmac-sha256.workspace-principal-request-fingerprint.v1")
    expect(JSON.stringify(first.receipt)).not.toContain(first.attemptHandle)
    expect(() => begin(store, "Connect another calendar.")).toThrow(CalendarOAuthWorkspaceAdmissionError)
  })

  it("requires the authentic admission witness and exact completion facts for idempotent finalization", () => {
    const store = new CalendarOAuthWorkspaceAdmissions()
    const admission = begin(store)
    const completion = {
      version: "athenaeum.calendar-oauth-provider-completion.v1" as const,
      providerConnectionId: "gpc_3fa85f64-5717-4562-b3fc-2c963f66afa6",
      gatekeeperAttemptId: "gka_3fa85f64-5717-4562-b3fc-2c963f66afa5",
      bindingId: EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa4"),
      providerReceiptDigest: digest,
      completionFactDigest: digest,
      admissionWitnessDigest: admission.receipt.admissionWitnessDigest
    }
    const first = store.finalize({ admission: admission.receipt, completion: Schema.decodeUnknownSync(CalendarOAuthProviderCompletionWitness)(completion), workspaceCommitWitnessDigest: digest, now })
    expect(store.finalize({ admission: admission.receipt, completion: Schema.decodeUnknownSync(CalendarOAuthProviderCompletionWitness)(completion), workspaceCommitWitnessDigest: digest, now })).toEqual(first)
    expect(() => store.finalize({ admission: admission.receipt, completion: Schema.decodeUnknownSync(CalendarOAuthProviderCompletionWitness)({ ...completion, admissionWitnessDigest: "b".repeat(64) }), workspaceCommitWitnessDigest: digest, now })).toThrow(CalendarOAuthWorkspaceAdmissionError)
  })
})
