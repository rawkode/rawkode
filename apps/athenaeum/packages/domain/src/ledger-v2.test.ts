import { describe, expect, it } from "vitest"
import { ActorContexts, MUTATION_REQUEST_V2_VERSION, canonicalDigestPreimageV2, commandFingerprintMaterialV2, createPreAuthorizationIdentityV2, decodeActorContext, decodeDeliveryRecordV2, decodeLedgerEventV2, decodeMutationRequestV2, decodeOutboxDeliveryV2, decodeResolvedMutationIntentV2, decidePreAuthorizationReplayV2, decideWorkspaceReplayV2, digestCanonicalV2, resolvedActorCustodyDigestV2, normalizeMutationText } from "./ledger-v2.js"
describe("MutationRequestV2", () => {
  const valid = { version: MUTATION_REQUEST_V2_VERSION, kind: "createNode", requestId: "r1", rationale: "Why this belongs here", payload: { title: "Title", requestedNodeId: "n1" }, surface: "web", evidence: { kind: "web", sourceId: "ui-1", declaredSurface: "web" } }
  it("exact-decodes the registered payload and normalizes rationale", () => expect(decodeMutationRequestV2({ ...valid, rationale: "  cafe\u0301  " }).rationale).toBe("café"))
  it("rejects authority claims, unknown keys, bad payloads, and invisible rationale", () => {
    expect(() => decodeMutationRequestV2({ ...valid, authority: "admin" })).toThrow()
    expect(() => decodeMutationRequestV2({ ...valid, payload: { nodeId: "n1", title: "x" } })).toThrow()
    expect(() => normalizeMutationText("\u200b")).toThrow()
  })
  it("requires an immutable tool chain and stages replay before authorization", () => {
    expect(() => decodeActorContext({ authority: "verified-human", workspaceId: "w", principalId: "p", policy: "x", capability: "write" }, true)).toThrow(/tool/)
    expect(decideWorkspaceReplayV2({ fingerprint: "same", receipt: { id: "receipt" } }, "same")).toEqual({ kind: "replay", receipt: { id: "receipt" } })
    expect(decideWorkspaceReplayV2({ fingerprint: "old", receipt: {} }, "new")).toEqual({ kind: "conflict" })
    expect(commandFingerprintMaterialV2({ requestDigest: "r", evidenceDigest: "e", custodyDigest: "c", workspaceId: "w", workspaceEpoch: 1, correlationId: "co", causationId: "ca" })).not.toContain("createdAt")
  })
  it("keeps mutable delivery state out of immutable causal records", () => {
    expect(() => decodeOutboxDeliveryV2({ consumerId: "c", idempotencyKey: "i", state: "pending", attempts: 0, eventId: "forbidden" })).toThrow()
  })
  it("enforces delivery state transitions and surface evidence agreement", () => {
    expect(() => decodeMutationRequestV2({ ...valid, surface: "rpc" })).toThrow(/agree/)
    expect(() => decodeOutboxDeliveryV2({ consumerId: "c", idempotencyKey: "i", state: "pending", attempts: -1 })).toThrow()
    expect(() => decodeOutboxDeliveryV2({ consumerId: "c", idempotencyKey: "i", state: "leased", attempts: 1 })).toThrow()
    expect(() => decodeDeliveryRecordV2({ consumerId: "c", idempotencyKey: "i", state: "delivered", attempts: 1, terminalAt: "now", terminalReason: "ok" })).toThrow(/outbox/)
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
  it("keeps generated create values out of public digest material and pins canonical digest vectors", async () => {
    const callerRequest = decodeMutationRequestV2({ ...valid, payload: { title: "Title" } })
    expect(callerRequest.payload).toEqual({ title: "Title" })
    expect(() => decodeMutationRequestV2({ ...valid, payload: { title: "Title", generatedAt: "2026-08-29T00:00:00.000Z" } })).toThrow()
    expect(canonicalDigestPreimageV2({ z: 1, a: "x" })).toBe('{"a":"x","z":1}')
    await expect(digestCanonicalV2({ z: 1, a: "x" })).resolves.toBe("8d6a75ac86d8b51bb56acfbb96108ed81474aa3504c317f77c0c576bde387cd3")
    const command = commandFingerprintMaterialV2({ requestDigest: "r", evidenceDigest: "e", custodyDigest: "c", workspaceId: "w", workspaceEpoch: 1, correlationId: "co", causationId: "ca" })
    expect(canonicalDigestPreimageV2(command)).toBe('{"causationId":"ca","correlationId":"co","custodyDigest":"c","evidenceDigest":"e","requestDigest":"r","version":"athenaeum.command-fingerprint.v2","workspaceEpoch":1,"workspaceId":"w"}')
    await expect(digestCanonicalV2(command)).resolves.toBe("8196420ffef086cacb2c7c2ec8a984ca3e7b296cfa0adcfb84a66d192419f5fc")
  })
  it("requires a typed event name in every immutable V2 event", () => {
    const event = { eventId: "event-1", eventType: "athenaeum.workspace-mutation.v2", workspaceId: "w", workspaceEpoch: 1, sequence: 1, commandFingerprint: "f", requestId: "r", causationId: "ca", correlationId: "co", recipient: "workspace-ledger", payload: {}, createdAt: "now" }
    expect(decodeLedgerEventV2(event)).toEqual(event)
    const { eventType: _eventType, ...withoutType } = event
    expect(() => decodeLedgerEventV2(withoutType)).toThrow()
    expect(() => decodeLedgerEventV2({ ...event, eventType: "" })).toThrow(/event type/)
  })
})
