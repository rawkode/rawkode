/**
 * Pure contracts shared by the public authority wrapper and its unwired local executor.
 *
 * This module deliberately depends on neither ingress nor execution modules. Keeping the
 * definitions here prevents a wrapper/core runtime cycle while preserving the wrapper's public
 * named exports through re-export.
 */
import { sha256HexSync, type DeliverySeedV2, type LedgerEventV2, type LedgerReceiptV2, type OutboxIntentV2, type SameAdmittedAudienceChangedMaterialConflictV2 } from "@athenaeum/domain"

type Brand<T, Name extends string> = T & { readonly __brand: Name }
export type WorkspaceId = Brand<string, "WorkspaceId">
export type RequestId = Brand<string, "RequestId">
export type Digest = Brand<string, "Sha256Digest">
export type ReplayAudienceId = Brand<string, "ReplayAudienceId">
export type AuthorityEpoch = Brand<number, "AuthorityEpoch">
export type LedgerSequence = Brand<number, "LedgerSequence">
export type EventId = Brand<string, "EventId">
export type OutboxId = Brand<string, "OutboxId">

export type ReplayAudience = Readonly<
  | { kind: "human"; tenantId: string; subjectId: string }
  | { kind: "agent"; tenantId: string; employeeId: string; jobId: string; sponsorHumanId: string }
  | { kind: "system"; tenantId: string; principalId: string }
>

export type ReplayAdmission = Readonly<{
  workspaceId: WorkspaceId
  admitted: boolean
  audienceId: ReplayAudienceId
  admissionFence: Readonly<{
    membershipVersion: string
    executorRegistrationVersion?: string
    jobSponsorVersion?: string
    systemPrincipalVersion?: string
  }>
}>

export type ActionFence = Readonly<{
  membershipVersion: string
  policyVersion: string
  grantVersion?: string
  revocationVersion?: string
  toolRegistrationVersion?: string
  agentJobVersion?: string
  sponsorMembershipVersion?: string
  systemPrincipalVersion?: string
  expiresAt: number
}>

export type ResolvedActorContext = Readonly<{
  authority: "verified-human" | "agent-job-run" | "named-system"
  workspaceId: WorkspaceId
  principalId: string
  employeeId?: string
  effectiveCapability: string
  policy: string
  custodyMaterial: Readonly<Record<string, string>>
  sponsorHumanId?: string
  jobId?: string
  runId?: string
  grantId?: string
  toolExecution?: Readonly<{
    registrationId: string
    immutableToolVersion: string
    invocationId: string
    grantId: string
    workspaceId: WorkspaceId
    expiresAt: string
    revocationId: string
    effectiveCapability: string
    policy: string
  }>
}>

export type PreparedPublicRequest = Readonly<{
  workspaceId: WorkspaceId
  requestId: RequestId
  request: unknown
  evidence: unknown
  payload: unknown
  kind: string
  commitMessage: string
  requestDigest: Digest
  evidenceDigest: Digest
  replayAdmission: ReplayAdmission
}>

export type PreparedAction = PreparedPublicRequest & Readonly<{
  actor: ResolvedActorContext
  actionFence: ActionFence
  expectedEpoch: AuthorityEpoch
  correlationId: string
  causationId: string
}>

export type CommittedRequestRecord<Receipt> = Readonly<{
  workspaceId: WorkspaceId
  requestId: RequestId
  requestDigest: Digest
  evidenceDigest: Digest
  replayAudienceId: ReplayAudienceId
  commandFingerprint: Digest
  receipt: Receipt
}>
/** Immutable audit record persisted with receipt/event/outbox in the same transaction. */
export type ImmutableCommandProvenance = Readonly<{
  version: "athenaeum.authority-command.v1"; workspaceId: WorkspaceId; requestId: RequestId; kind: string; epoch: AuthorityEpoch; sequence: LedgerSequence
  commitMessage: string; actorAuthority: ResolvedActorContext["authority"]; principalId: string
  effectiveCapability: string; policy: string
  employeeId?: string; sponsorHumanId?: string; jobId?: string; runId?: string; grantId?: string
  toolExecution?: ResolvedActorContext["toolExecution"]
  requestDigest: Digest; evidenceDigest: Digest; custodyDigest: Digest; commandFingerprint: Digest
  causationId: string; correlationId: string; createdAt: string
}>

/** Authority brands refine the canonical V2 event contract without changing its fields. */
export type ImmutableEvent = LedgerEventV2 & Readonly<{
  eventId: EventId; workspaceId: WorkspaceId; workspaceEpoch: AuthorityEpoch; sequence: LedgerSequence; commandFingerprint: Digest
  digest: Digest
}>

/** Authority brands refine the canonical V2 outbox contract without changing its fields. */
export type ImmutableOutboxIntent = OutboxIntentV2 & Readonly<{
  outboxId: OutboxId; eventId: EventId; workspaceId: WorkspaceId; workspaceEpoch: AuthorityEpoch; sequence: LedgerSequence; commandFingerprint: Digest
  digest: Digest
}>

export type DeliverySeed = DeliverySeedV2 & Readonly<{ outboxId: OutboxId; idempotencyKey: Digest }>
export type AuthorityFailpoint = "after-sequence" | "after-local-write" | "after-request" | "after-event" | "after-outbox" | "after-delivery" | "after-receipt"

/** Kernel-only same-transaction storage; never exposed to a local command handler. */
export type LocalMutationStoragePort = Readonly<{
  readLocal: (key: string) => unknown
  writeLocal: (key: string, value: unknown) => void
  deleteLocal: (key: string) => void
  stageIntent: (recipient: string, payload: unknown) => void
}>
export type AuthorityTransaction<Receipt> = Readonly<{
  /** This must be the first transaction operation. It performs only current admission checks. */
  recheckReplayAdmission: (snapshot: ReplayAdmission) => "admitted" | "denied"
  getCommittedRequest: (workspaceId: WorkspaceId, requestId: RequestId) => CommittedRequestRecord<Receipt> | undefined
  /** Called only after the request key was absent. */
  recheckActionFence: (input: { workspaceId: WorkspaceId; actor: ResolvedActorContext; fence: ActionFence; expectedEpoch: AuthorityEpoch; nowEpochMs: number }) => "current" | "retry"
  currentEpoch: () => AuthorityEpoch
  allocateNextSequence: () => LedgerSequence
  localMutation: () => LocalMutationStoragePort
  insertCommittedRequest: (record: CommittedRequestRecord<Receipt>) => void
  insertCommandProvenance: (record: ImmutableCommandProvenance) => void
  insertEvent: (event: ImmutableEvent) => void
  insertOutboxIntent: (intent: ImmutableOutboxIntent) => void
  insertDeliverySeed: (delivery: DeliverySeed) => void
  insertReceipt: (receipt: unknown) => void
  hitFailpoint: (point: AuthorityFailpoint) => void
}>

export type AuthorityStore<Receipt = unknown> = Readonly<{
  transactionSync: <T>(run: (transaction: AuthorityTransaction<Receipt>) => T) => T
  readEpochSnapshot: (workspaceId: WorkspaceId) => AuthorityEpoch
}>

export type KernelIdentityPort = Readonly<{
  nextEventId: () => EventId
  nextOutboxId: () => OutboxId
  nowIso: () => string
  nowEpochMs: () => number
}>

export type AuthorityAdmissionPort = Readonly<{
  admitReplay: (input: { workspaceId: WorkspaceId; transport: unknown; evidence: unknown }) => Promise<ReplayAdmission>
  resolveFreshAction: (input: PreparedPublicRequest) => Promise<{ actor: ResolvedActorContext; actionFence: ActionFence; expectedEpoch: AuthorityEpoch; correlationId?: string; causationId?: string }>
}>

export type AuthorityReceipt<Output = unknown> = LedgerReceiptV2<Output> & Readonly<{ workspaceId: WorkspaceId; requestId: RequestId; commandFingerprint: Digest; workspaceEpoch: AuthorityEpoch; sequence: LedgerSequence }>

export type AuthorityOutcome<Output = unknown> =
  | Readonly<{ kind: "committed"; receipt: AuthorityReceipt<Output>; replay: boolean }>
  | Readonly<{ kind: "conflict"; conflict: SameAdmittedAudienceChangedMaterialConflict }>
  | Readonly<{ kind: "denied" }>

/** Safe to map to a public conflict later; this is emitted only for the same admitted audience. */
export type SameAdmittedAudienceChangedMaterialConflict = SameAdmittedAudienceChangedMaterialConflictV2 & Readonly<{ workspaceId: WorkspaceId; requestId: RequestId }>

export const AUTHORITY_VERSION = "athenaeum.authority.v1" as const
export const RECEIPT_VERSION = "athenaeum.ledger-receipt.v2" as const
export const PUBLIC_REQUEST_VERSION = "athenaeum.public-request.v1" as const
export const nonBlank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
export const isJsonValue = (value: unknown, active = new Set<object>()): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || active.has(value)) return false
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  active.add(value)
  const ok = Array.isArray(value) ? value.every((item) => isJsonValue(item, active)) : Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, active))
  active.delete(value)
  return ok
}
export const requireJsonValue = (value: unknown, label: string): void => { if (!isJsonValue(value)) throw new Error(`${label} must be a finite, acyclic JSON value`) }

/** V2's sync serializer must remain byte-for-byte aligned with ledger-v2's async serializer. */
const canonicalV2 = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalV2).join(",")}]`
  if (value !== null && typeof value === "object") return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalV2((value as Record<string, unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}
const utf8V2 = (text: string): Uint8Array => {
  const encoded: number[] = []
  for (let index = 0; index < text.length; index++) {
    let code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00; index++ }
    }
    if (code < 0x80) encoded.push(code)
    else if (code < 0x800) encoded.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) encoded.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else encoded.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }
  return new Uint8Array(encoded)
}
const canonicalV2JsonBytes = (value: unknown): Uint8Array => utf8V2(canonicalV2(value))

export const syncDigest = (value: unknown): Digest => {
  requireJsonValue(value, "digest input")
  return sha256HexSync(canonicalV2JsonBytes(value)) as Digest
}

/** Stable audience identity deliberately excludes policy, grant versions, expiry, and revocation. */
export const stableReplayAudienceId = (audience: ReplayAudience): ReplayAudienceId => {
  if (!audience || !["human", "agent", "system"].includes(audience.kind) || !nonBlank((audience as { tenantId?: unknown }).tenantId)) throw new Error("invalid replay audience")
  const required = audience.kind === "human" ? [audience.subjectId] : audience.kind === "agent" ? [audience.employeeId, audience.jobId, audience.sponsorHumanId] : [audience.principalId]
  if (required.some((value) => !nonBlank(value))) throw new Error("invalid replay audience")
  const material = audience.kind === "human"
    ? { kind: audience.kind, tenantId: audience.tenantId, subjectId: audience.subjectId }
    : audience.kind === "agent"
      ? { kind: audience.kind, tenantId: audience.tenantId, employeeId: audience.employeeId, jobId: audience.jobId, sponsorHumanId: audience.sponsorHumanId }
      : { kind: audience.kind, tenantId: audience.tenantId, principalId: audience.principalId }
  return syncDigest({ version: "athenaeum.replay-audience.v1", audience: material }) as unknown as ReplayAudienceId
}

export const actorCustodyMaterial = (actor: ResolvedActorContext): Record<string, unknown> => {
  const material: Record<string, unknown> = {
    authority: actor.authority,
    workspaceId: actor.workspaceId,
    principalId: actor.principalId,
    effectiveCapability: actor.effectiveCapability,
    policy: actor.policy
  }
  if (actor.employeeId !== undefined) material.employeeId = actor.employeeId
  if (actor.sponsorHumanId !== undefined) material.sponsorHumanId = actor.sponsorHumanId
  if (actor.jobId !== undefined) material.jobId = actor.jobId
  if (actor.runId !== undefined) material.runId = actor.runId
  if (actor.grantId !== undefined) material.grantId = actor.grantId
  if (actor.toolExecution !== undefined) material.toolExecution = {
    registrationId: actor.toolExecution.registrationId,
    immutableToolVersion: actor.toolExecution.immutableToolVersion,
    invocationId: actor.toolExecution.invocationId,
    grantId: actor.toolExecution.grantId,
    workspaceId: actor.toolExecution.workspaceId,
    expiresAt: actor.toolExecution.expiresAt,
    revocationId: actor.toolExecution.revocationId,
    effectiveCapability: actor.toolExecution.effectiveCapability,
    policy: actor.toolExecution.policy
  }
  return material
}
export const authorityFingerprint = (prepared: PreparedAction, epoch: AuthorityEpoch): Digest => syncDigest({ version: AUTHORITY_VERSION, requestDigest: prepared.requestDigest, evidenceDigest: prepared.evidenceDigest, custody: actorCustodyMaterial(prepared.actor), workspaceId: prepared.workspaceId, authorityEpoch: epoch, correlationId: prepared.correlationId, causationId: prepared.causationId })
export const safeReplay = <Output>(prepared: PreparedPublicRequest, prior: CommittedRequestRecord<AuthorityReceipt<Output>> | undefined): AuthorityOutcome<Output> | undefined => {
  if (prior === undefined) return undefined
  if (prior.workspaceId === prepared.workspaceId && prior.requestId === prepared.requestId && prior.requestDigest === prepared.requestDigest && prior.evidenceDigest === prepared.evidenceDigest && prior.replayAudienceId === prepared.replayAdmission.audienceId) return { kind: "committed", receipt: prior.receipt, replay: true }
  if (prior.workspaceId === prepared.workspaceId && prior.requestId === prepared.requestId && prior.replayAudienceId === prepared.replayAdmission.audienceId) return { kind: "conflict", conflict: { kind: "same-admitted-audience-changed-material", workspaceId: prepared.workspaceId, requestId: prepared.requestId } }
  return { kind: "denied" }
}

/** A delivery key is stable for an immutable outbox row and independent of mutable delivery state. */
export const deliveryIdempotencyKey = (outboxId: OutboxId, consumerId: string): Digest => syncDigest({ version: "athenaeum.delivery-idempotency.v2", outboxId, consumerId })
export const maybeThenable = (value: unknown): boolean => {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false
  return typeof Reflect.get(value as object, "then") === "function"
}
export const validatePreparedAction = (prepared: PreparedAction): void => {
  if (prepared.actor.workspaceId !== prepared.workspaceId) throw new Error("resolved actor workspace mismatch")
  if (!["verified-human", "agent-job-run", "named-system"].includes(prepared.actor.authority)) throw new Error("unknown actor authority")
  if (!nonBlank(prepared.actor.principalId) || !nonBlank(prepared.actor.effectiveCapability) || !nonBlank(prepared.actor.policy)) throw new Error("resolved actor is incomplete")
  requireJsonValue(prepared.actor.custodyMaterial, "custody material")
  if (Object.keys(prepared.actor.custodyMaterial).length === 0 || Object.entries(prepared.actor.custodyMaterial).some(([key, value]) => !nonBlank(key) || !nonBlank(value))) throw new Error("resolved custody material is incomplete")
  if (prepared.actor.authority === "agent-job-run" && (!nonBlank(prepared.actor.employeeId) || !nonBlank(prepared.actor.sponsorHumanId) || !nonBlank(prepared.actor.jobId) || !nonBlank(prepared.actor.runId) || !nonBlank(prepared.actor.grantId))) throw new Error("agent authority custody is incomplete")
  if (prepared.evidence && typeof prepared.evidence === "object" && (prepared.evidence as { kind?: unknown }).kind === "tool" && prepared.actor.toolExecution === undefined) throw new Error("tool-mediated action requires tool execution custody")
  if (prepared.actor.toolExecution !== undefined) {
    if (prepared.actor.toolExecution.workspaceId !== prepared.workspaceId) throw new Error("tool execution workspace mismatch")
    if (Object.values(prepared.actor.toolExecution).some((value) => !nonBlank(value)) || !Number.isFinite(Date.parse(prepared.actor.toolExecution.expiresAt))) throw new Error("tool execution custody is incomplete")
  }
  if (!nonBlank(prepared.actionFence.membershipVersion) || !nonBlank(prepared.actionFence.policyVersion) || Object.entries(prepared.actionFence).some(([key, value]) => key !== "expiresAt" && value !== undefined && !nonBlank(value)) || !Number.isSafeInteger(prepared.actionFence.expiresAt) || !Number.isSafeInteger(prepared.expectedEpoch) || prepared.expectedEpoch < 0 || !nonBlank(prepared.correlationId) || !nonBlank(prepared.causationId)) throw new Error("invalid action fence")
}

export type AuthorityInput = Readonly<{ workspaceId: WorkspaceId; requestId: RequestId; kind: string; request: unknown; evidence: unknown; payload: unknown; commitMessage: string; transport?: unknown }>
