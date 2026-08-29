import { describe, expect, it } from "vitest"
import { ActorContexts, MUTATION_REQUEST_V2_VERSION, commandFingerprintMaterialV2, createPreAuthorizationIdentityV2, decodeActorContext, decodeDeliveryRecordV2, decodeMutationRequestV2, decodeOutboxDeliveryV2, decodeResolvedMutationIntentV2, decidePreAuthorizationReplayV2, decideWorkspaceReplayV2, digestCanonicalV2, resolvedActorCustodyDigestV2, normalizeMutationText } from "./ledger-v2.js"
describe("MutationRequestV2", () => {
  const valid = { version: MUTATION_REQUEST_V2_VERSION, kind: "createNode", requestId: "r1", rationale: "Why this belongs here", payload: { nodeId: "n1", title: "Title" }, surface: "web", evidence: { kind: "web", sourceId: "ui-1", declaredSurface: "web" } }
  it("exact-decodes the registered payload and normalizes rationale", () => expect(decodeMutationRequestV2({ ...valid, rationale: "  cafe\u0301  " }).rationale).toBe("café"))
  it("rejects authority claims, unknown keys, bad payloads, and invisible rationale", () => {
    expect(() => decodeMutationRequestV2({ ...valid, authority: "admin" })).toThrow()
    expect(() => decodeMutationRequestV2({ ...valid, payload: { nodeId: "n1", title: "x", capability: "all" } })).toThrow()
    expect(() => normalizeMutationText("\u200b")).toThrow()
  })
  it("requires an immutable tool chain and stages replay before authorization", () => {
    expect(() => decodeActorContext({ authority: "verified-human", workspaceId: "w", principalId: "p", policy: "x", capability: "write" }, true)).toThrow(/tool/)
    expect(decideWorkspaceReplayV2({ fingerprint: "same", receipt: { id: "receipt" } }, "same")).toEqual({ kind: "replay", receipt: { id: "receipt" } })
    expect(decideWorkspaceReplayV2({ fingerprint: "old", receipt: {} }, "new")).toEqual({ kind: "conflict" })
    expect(commandFingerprintMaterialV2({ requestDigest: "r", evidenceDigest: "e", custodyDigest: "c", workspaceId: "w", workspaceEpoch: 1, correlationId: "co", causationId: "ca" })).not.toContain("createdAt")
  })
  it("keeps mutable delivery state out of immutable causal records", () => {
    expect(() => decodeOutboxDeliveryV2({ consumer: "c", idempotencyKey: "i", state: "pending", attempts: 0, eventId: "forbidden" })).toThrow()
  })
  it("enforces delivery state transitions and surface evidence agreement", () => {
    expect(() => decodeMutationRequestV2({ ...valid, surface: "rpc" })).toThrow(/agree/)
    expect(() => decodeOutboxDeliveryV2({ consumer: "c", idempotencyKey: "i", state: "pending", attempts: -1 })).toThrow()
    expect(() => decodeOutboxDeliveryV2({ consumer: "c", idempotencyKey: "i", state: "leased", attempts: 1 })).toThrow()
    expect(() => decodeDeliveryRecordV2({ consumer: "c", idempotencyKey: "i", state: "delivered", attempts: 1, terminalAt: "now", terminalReason: "ok" })).toThrow(/outbox/)
  })
  it("verifies every resolved digest and stages replay before custody", async () => {
    const request = decodeMutationRequestV2(valid); const actor = ActorContexts.verifiedHuman("workspace-1", "human-1", "write", "policy-v1")
    const pre = await createPreAuthorizationIdentityV2(actor.workspaceId, request); const custodyDigest = await resolvedActorCustodyDigestV2(actor)
    const commandFingerprint = await digestCanonicalV2(commandFingerprintMaterialV2({ requestDigest: pre.requestDigest, evidenceDigest: pre.evidenceDigest, custodyDigest, workspaceId: actor.workspaceId, workspaceEpoch: 3, correlationId: "correlation-1", causationId: "cause-1" }))
    const resolved = { request, actor, requestDigest: pre.requestDigest, evidenceDigest: pre.evidenceDigest, custodyDigest, commandFingerprint, workspaceEpoch: 3, correlationId: "correlation-1", causationId: "cause-1" }
    await expect(decodeResolvedMutationIntentV2(resolved)).resolves.toEqual(expect.objectContaining({ commandFingerprint, workspaceEpoch: 3, correlationId: "correlation-1", causationId: "cause-1" }))
    for (const field of ["requestDigest", "evidenceDigest", "custodyDigest", "commandFingerprint"] as const) await expect(decodeResolvedMutationIntentV2({ ...resolved, [field]: "0".repeat(64) })).rejects.toThrow(/digest mismatch/)
    expect(decidePreAuthorizationReplayV2({ fingerprint: pre.fingerprint, receipt: "stored" }, pre.fingerprint)).toEqual({ kind: "replay", receipt: "stored" })
    expect(decideWorkspaceReplayV2({ fingerprint: commandFingerprint, receipt: "final" }, commandFingerprint)).toEqual({ kind: "replay", receipt: "final" })
  })
})
