/**
 * Internal authority implementation. This module is deliberately not a production ingress: the
 * only source-side import is the static-registry wrapper in workspace-mutation-authority.ts. The
 * test harness imports it from `test/` to exercise alternate immutable registries without adding
 * a mutable production hook.
 */
import { digestCanonicalV2, normalizeMutationText } from "@athenaeum/domain"
import { createLocalMutationCapability, freezeLocalMutationInput, type StagedMutationIntent } from "./workspace-local-mutation-capability.js"
import type { AuthorityLocalCommandRegistry } from "./authority-local-command-registry.js"
import {
  AUTHORITY_VERSION, PUBLIC_REQUEST_VERSION, RECEIPT_VERSION, actorCustodyMaterial, authorityFingerprint, deliveryIdempotencyKey, maybeThenable, nonBlank,
  requireJsonValue, safeReplay, syncDigest, validatePreparedAction,
  type AuthorityAdmissionPort, type AuthorityInput, type AuthorityOutcome,
  type AuthorityReceipt, type AuthorityStore, type Digest, type KernelIdentityPort, type PreparedAction, type PreparedPublicRequest,
  type ReplayAdmission
} from "./workspace-mutation-authority.js"

/** Execute a prepared command with the supplied immutable registry. */
export const executeMutationAuthorityWithRegistry = async <Output = unknown>(
  store: AuthorityStore<AuthorityReceipt<Output>>,
  admission: AuthorityAdmissionPort,
  input: AuthorityInput,
  identity: KernelIdentityPort,
  handlerAttempts: number,
  commandRegistry: AuthorityLocalCommandRegistry
): Promise<AuthorityOutcome<Output>> => {
  if (!nonBlank(input.kind) || !nonBlank(input.workspaceId) || !nonBlank(input.requestId)) throw new Error("authority input identity is incomplete")
  const commitMessage = normalizeMutationText(input.commitMessage)
  requireJsonValue(input.request, "request"); requireJsonValue(input.evidence, "evidence"); requireJsonValue(input.payload, "payload")
  const frozenRequest = freezeLocalMutationInput(input.request)
  const frozenEvidence = freezeLocalMutationInput(input.evidence)
  const frozenPayload = freezeLocalMutationInput(input.payload)
  const replayAdmissionValue: unknown = freezeLocalMutationInput(await admission.admitReplay({ workspaceId: input.workspaceId, transport: input.transport, evidence: frozenEvidence }))
  if (replayAdmissionValue === null || typeof replayAdmissionValue !== "object" || Array.isArray(replayAdmissionValue)) return { kind: "denied" }
  const replayAdmission = replayAdmissionValue as ReplayAdmission
  if (replayAdmission.workspaceId !== input.workspaceId || !replayAdmission.admitted) return { kind: "denied" }
  if (!nonBlank(replayAdmission.audienceId) || !nonBlank(replayAdmission.admissionFence.membershipVersion)) return { kind: "denied" }
  const preparedPublic: PreparedPublicRequest = Object.freeze({ workspaceId: input.workspaceId, requestId: input.requestId, kind: input.kind, commitMessage, request: frozenRequest, evidence: frozenEvidence, payload: frozenPayload, requestDigest: (await digestCanonicalV2({ version: PUBLIC_REQUEST_VERSION, kind: input.kind, requestId: input.requestId, commitMessage, request: frozenRequest, payload: frozenPayload })) as Digest, evidenceDigest: (await digestCanonicalV2(frozenEvidence)) as Digest, replayAdmission })

  const inspect = store.transactionSync((transaction): AuthorityOutcome<Output> | Readonly<{ kind: "absent" }> => {
    if (transaction.recheckReplayAdmission(replayAdmission) === "denied") return { kind: "denied" }
    const replay = safeReplay<Output>(preparedPublic, transaction.getCommittedRequest(input.workspaceId, input.requestId))
    return replay ?? { kind: "absent" }
  })
  if (inspect.kind !== "absent") return inspect

  for (let attempt = 0; attempt < Math.max(1, Math.trunc(handlerAttempts)); attempt++) {
    const resolved = await admission.resolveFreshAction(preparedPublic)
    const prepared: PreparedAction = Object.freeze({ ...preparedPublic, actor: freezeLocalMutationInput(resolved.actor), actionFence: freezeLocalMutationInput(resolved.actionFence), expectedEpoch: resolved.expectedEpoch, correlationId: resolved.correlationId ?? `correlation:${input.workspaceId}:${input.requestId}`, causationId: resolved.causationId ?? `causation:${input.requestId}` })
    try { validatePreparedAction(prepared) } catch { return { kind: "denied" } }
    const result = store.transactionSync((transaction): AuthorityOutcome<Output> | Readonly<{ kind: "retry" }> => {
      if (transaction.recheckReplayAdmission(replayAdmission) === "denied") return { kind: "denied" }
      const replay = safeReplay<Output>(prepared, transaction.getCommittedRequest(input.workspaceId, input.requestId))
      if (replay !== undefined) return replay
      if (prepared.actor.toolExecution !== undefined && identity.nowEpochMs() >= Date.parse(prepared.actor.toolExecution.expiresAt)) return { kind: "denied" }
      if (transaction.recheckActionFence({ workspaceId: prepared.workspaceId, actor: prepared.actor, fence: prepared.actionFence, expectedEpoch: prepared.expectedEpoch, nowEpochMs: identity.nowEpochMs() }) === "retry") return { kind: "retry" }
      const epoch = transaction.currentEpoch()
      if (epoch !== prepared.expectedEpoch) return { kind: "retry" }
      const sequence = transaction.allocateNextSequence(); transaction.hitFailpoint("after-sequence")
      const eventId = identity.nextEventId(); const staged: StagedMutationIntent[] = []
      const base = transaction.localMutation()
      const capability = createLocalMutationCapability(base.readLocal, base.writeLocal, base.deleteLocal, (intent) => { if (!nonBlank(intent.recipient)) throw new Error("staged intent recipient must be non-empty"); staged.push(freezeLocalMutationInput({ recipient: intent.recipient, payload: intent.payload })) })
      const handler = commandRegistry.get(input.kind); if (handler === undefined) throw new Error(`unregistered local command: ${input.kind}`)
      const output = handler(capability, prepared.payload) as Output
      transaction.hitFailpoint("after-local-write")
      if (maybeThenable(output)) throw new Error("local mutation handler must be synchronous")
      const commandFingerprint = authorityFingerprint(prepared, epoch)
      const createdAt = identity.nowIso(); const eventPayload = freezeLocalMutationInput(staged)
      const custodyDigest = syncDigest(actorCustodyMaterial(prepared.actor)) as Digest
      transaction.insertCommandProvenance(Object.freeze({ version: "athenaeum.authority-command.v1", workspaceId: prepared.workspaceId, requestId: prepared.requestId, kind: prepared.kind, epoch, sequence, commitMessage: prepared.commitMessage, actorAuthority: prepared.actor.authority, principalId: prepared.actor.principalId, effectiveCapability: prepared.actor.effectiveCapability, policy: prepared.actor.policy, employeeId: prepared.actor.employeeId, sponsorHumanId: prepared.actor.sponsorHumanId, jobId: prepared.actor.jobId, runId: prepared.actor.runId, grantId: prepared.actor.grantId, toolExecution: prepared.actor.toolExecution, requestDigest: prepared.requestDigest, evidenceDigest: prepared.evidenceDigest, custodyDigest, commandFingerprint, causationId: prepared.causationId, correlationId: prepared.correlationId, createdAt }))
      const event = Object.freeze({ eventId, eventType: input.kind, workspaceId: prepared.workspaceId, workspaceEpoch: epoch, sequence, commandFingerprint, digest: syncDigest({ version: AUTHORITY_VERSION, eventId, eventType: input.kind, workspaceId: prepared.workspaceId, workspaceEpoch: epoch, sequence, commandFingerprint, requestId: prepared.requestId, causationId: prepared.causationId, correlationId: prepared.correlationId, recipient: "workspace-ledger", createdAt, payload: eventPayload }), requestId: prepared.requestId, causationId: prepared.causationId, correlationId: prepared.correlationId, recipient: "workspace-ledger", createdAt, payload: eventPayload })
      const receipt: AuthorityReceipt<Output> = Object.freeze({ version: RECEIPT_VERSION, workspaceId: prepared.workspaceId, requestId: prepared.requestId, commandFingerprint, workspaceEpoch: epoch, sequence, output: freezeLocalMutationInput(output), stagedIntentCount: staged.length })
      transaction.insertCommittedRequest({ workspaceId: prepared.workspaceId, requestId: prepared.requestId, requestDigest: prepared.requestDigest, evidenceDigest: prepared.evidenceDigest, replayAudienceId: prepared.replayAdmission.audienceId, commandFingerprint, receipt }); transaction.hitFailpoint("after-request")
      transaction.insertEvent(event); transaction.hitFailpoint("after-event")
      for (const intent of staged) { const outboxId = identity.nextOutboxId(); const outbox = Object.freeze({ outboxId, eventId, workspaceId: prepared.workspaceId, workspaceEpoch: epoch, sequence, commandFingerprint, digest: syncDigest({ version: AUTHORITY_VERSION, outboxId, eventId, workspaceId: prepared.workspaceId, workspaceEpoch: epoch, sequence, commandFingerprint, requestId: prepared.requestId, causationId: prepared.causationId, correlationId: prepared.correlationId, recipient: intent.recipient, payload: intent.payload, createdAt }), requestId: prepared.requestId, causationId: prepared.causationId, correlationId: prepared.correlationId, recipient: intent.recipient, payload: intent.payload, createdAt }); transaction.insertOutboxIntent(outbox); transaction.hitFailpoint("after-outbox"); transaction.insertDeliverySeed({ outboxId, consumerId: intent.recipient, idempotencyKey: deliveryIdempotencyKey(outboxId, intent.recipient), state: "pending", attempts: 0 }); transaction.hitFailpoint("after-delivery") }
      transaction.insertReceipt(receipt); transaction.hitFailpoint("after-receipt")
      return { kind: "committed", receipt, replay: false }
    })
    if (result.kind === "retry") continue
    return result
  }
  return { kind: "denied" }
}
