/**
 * NLE-00 is deliberately a contract, not an execution path.  Nothing in this module authorizes
 * a caller: the Workspace DO must resolve this request into ActorContext before it can mutate.
 */
export const MUTATION_REQUEST_V2_VERSION = "athenaeum.mutation-request.v2" as const
export const UNICODE_VALIDATION_TABLE_VERSION = "unicode-15.1-nfc-control-default-ignorable.v1" as const
export const MUTATION_TEXT_MAX_SCALARS = 500
export const MUTATION_TEXT_MAX_UTF8_BYTES = 4096

export type MutationKindV2 = "createNode" | "applySupertag" | "agentChangeDecision"
export type IngressEvidenceV2 =
  | { kind: "web"; sourceId: string; declaredSurface: "web" }
  | { kind: "rpc"; sourceId: string; declaredSurface: "rpc" }
  | { kind: "tool"; sourceId: string; declaredToolId: string; declaredToolVersion: string }
  | { kind: "system"; sourceId: string; declaredSource: string }

export type MutationPayloadV2 =
  | { nodeId: string; title: string }
  | { nodeId: string; tagId: string; fieldValues: readonly { fieldId: string; value: unknown }[] }
  | { proposalId: string; decision: "accept" | "reject" }

export type MutationRequestV2 = {
  version: typeof MUTATION_REQUEST_V2_VERSION
  kind: MutationKindV2
  requestId: string
  rationale: string
  payload: MutationPayloadV2
  surface: "web" | "rpc" | "tool" | "system"
  evidence: IngressEvidenceV2
}

export type ActorContext = Readonly<{
  authority: "verified-human" | "agent-job-run" | "named-system"
  workspaceId: string
  principalId: string
  policy: string
  capability: string
  sponsorHumanId?: string
  initiatorHumanId?: string
  jobId?: string
  runId?: string
  grantId?: string
  expiresAt?: string
  revocationId?: string
  toolExecution?: Readonly<{ toolId: string; immutableVersion: string; invocationId: string; grantId: string; workspaceId: string; expiresAt: string; revocationId: string; effectiveCapability: string; policy: string }>
}>
export type ResolvedMutationIntentV2 = Readonly<{ request: MutationRequestV2; actor: ActorContext; requestDigest: string; evidenceDigest: string; custodyDigest: string; commandFingerprint: string; workspaceEpoch: number; correlationId: string; causationId: string }>

export type LedgerEventV2 = Readonly<{ eventId: string; workspaceId: string; workspaceEpoch: number; sequence: number; commandFingerprint: string; requestId: string; causationId: string; correlationId: string; recipient: string; payload: unknown; createdAt: string }>
export type OutboxIntentV2 = Readonly<{ outboxId: string; eventId: string; workspaceId: string; workspaceEpoch: number; sequence: number; commandFingerprint: string; requestId: string; causationId: string; correlationId: string; recipient: string; payload: unknown; createdAt: string }>
export type OutboxDeliveryV2 = { consumer: string; idempotencyKey: string; state: "pending" | "leased" | "delivered" | "failed"; attempts: number; leaseOwner?: string; leaseToken?: string; leaseExpiresAt?: string; nextAttemptAt?: string; diagnostics?: readonly string[]; terminalAt?: string; terminalReason?: string }
export type DeliveryRecordV2 = OutboxDeliveryV2 & { outboxId: string }

const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const nonBlank = (value: unknown): value is string => typeof value === "string" && value.length > 0
const utf8Length = (value: string) => {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index += 1 }
    else bytes += 3
  }
  return bytes
}
export function normalizeMutationText(value: unknown): string {
  if (typeof value !== "string") throw new Error("mutation text must be a string")
  const normalized = value.normalize("NFC").trim()
  if (!normalized || [...normalized].length > MUTATION_TEXT_MAX_SCALARS || utf8Length(normalized) > MUTATION_TEXT_MAX_UTF8_BYTES || /[\p{Cc}\p{Cf}]/u.test(normalized)) throw new Error(`invalid mutation text (${UNICODE_VALIDATION_TABLE_VERSION})`)
  return normalized
}
function decodeEvidence(value: unknown): IngressEvidenceV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid ingress evidence")
  const evidence = value as Record<string, unknown>
  if (evidence.kind === "web" && exactKeys(evidence, ["kind", "sourceId", "declaredSurface"]) && nonBlank(evidence.sourceId) && evidence.declaredSurface === "web") return evidence as IngressEvidenceV2
  if (evidence.kind === "rpc" && exactKeys(evidence, ["kind", "sourceId", "declaredSurface"]) && nonBlank(evidence.sourceId) && evidence.declaredSurface === "rpc") return evidence as IngressEvidenceV2
  if (evidence.kind === "tool" && exactKeys(evidence, ["kind", "sourceId", "declaredToolId", "declaredToolVersion"]) && nonBlank(evidence.sourceId) && nonBlank(evidence.declaredToolId) && nonBlank(evidence.declaredToolVersion)) return evidence as IngressEvidenceV2
  if (evidence.kind === "system" && exactKeys(evidence, ["kind", "sourceId", "declaredSource"]) && nonBlank(evidence.sourceId) && nonBlank(evidence.declaredSource)) return evidence as IngressEvidenceV2
  throw new Error("invalid ingress evidence")
}
function decodePayload(kind: MutationKindV2, value: unknown): MutationPayloadV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid mutation payload")
  const payload = value as Record<string, unknown>
  if (kind === "createNode" && exactKeys(payload, ["nodeId", "title"]) && nonBlank(payload.nodeId) && nonBlank(payload.title)) return payload as MutationPayloadV2
  if (kind === "applySupertag" && exactKeys(payload, ["nodeId", "tagId", "fieldValues"]) && nonBlank(payload.nodeId) && nonBlank(payload.tagId) && Array.isArray(payload.fieldValues) && payload.fieldValues.every((field) => exactKeys(field, ["fieldId", "value"]) && nonBlank(field.fieldId))) return payload as MutationPayloadV2
  if (kind === "agentChangeDecision" && exactKeys(payload, ["proposalId", "decision"]) && nonBlank(payload.proposalId) && (payload.decision === "accept" || payload.decision === "reject")) return payload as MutationPayloadV2
  throw new Error(`invalid ${kind} payload`)
}
export function decodeMutationRequestV2(value: unknown): MutationRequestV2 {
  if (!exactKeys(value, ["version", "kind", "requestId", "rationale", "payload", "surface", "evidence"])) throw new Error("MutationRequestV2 must have exact top-level keys")
  const request = value as Record<string, unknown>
  if (request.version !== MUTATION_REQUEST_V2_VERSION || !["createNode", "applySupertag", "agentChangeDecision"].includes(request.kind as string) || !nonBlank(request.requestId) || !["web", "rpc", "tool", "system"].includes(request.surface as string)) throw new Error("unsupported MutationRequestV2 version, kind, id, or surface")
  const evidence = decodeEvidence(request.evidence); const surface = request.surface as MutationRequestV2["surface"]
  if (surface !== evidence.kind) throw new Error("surface and ingress evidence kind must agree")
  return { version: MUTATION_REQUEST_V2_VERSION, kind: request.kind as MutationKindV2, requestId: request.requestId, rationale: normalizeMutationText(request.rationale), payload: decodePayload(request.kind as MutationKindV2, request.payload), surface, evidence }
}

/** Trusted factories are the only public construction route for server authority. */
export const ActorContexts = {
  verifiedHuman: (workspaceId: string, principalId: string, capability: string, policy: string): ActorContext => ({ authority: "verified-human", workspaceId, principalId, capability, policy }),
  agentJobRun: (base: Omit<ActorContext, "authority"> & Required<Pick<ActorContext, "sponsorHumanId" | "initiatorHumanId" | "jobId" | "runId" | "grantId" | "expiresAt" | "revocationId">>): ActorContext => ({ ...base, authority: "agent-job-run" }),
  namedSystem: (workspaceId: string, principalId: string, capability: string, policy: string): ActorContext => ({ authority: "named-system", workspaceId, principalId, capability, policy })
} as const

const actorKeys = ["authority", "workspaceId", "principalId", "policy", "capability"] as const
const toolKeys = ["toolId", "immutableVersion", "invocationId", "grantId", "workspaceId", "expiresAt", "revocationId", "effectiveCapability", "policy"] as const
/** Exact server-only authority decoder. Tool custody is mandatory for every tool-mediated ingress. */
export function decodeActorContext(value: unknown, toolMediated: boolean): ActorContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid actor context")
  const actor = value as Record<string, unknown>
  if (!actorKeys.every((key) => nonBlank(actor[key]))) throw new Error("invalid actor context")
  if (!["verified-human", "agent-job-run", "named-system"].includes(actor.authority as string)) throw new Error("invalid actor authority")
  const agentFields = ["sponsorHumanId", "initiatorHumanId", "jobId", "runId", "grantId", "expiresAt", "revocationId"]
  const exactActorKeys = actor.authority === "agent-job-run" ? [...actorKeys, ...agentFields, "toolExecution"] : [...actorKeys, "toolExecution"]
  const withoutOptionalTool = exactActorKeys.filter((key) => key !== "toolExecution")
  if (!(exactKeys(actor, exactActorKeys) || exactKeys(actor, withoutOptionalTool))) throw new Error("actor context has unknown or missing authority fields")
  if (actor.authority === "agent-job-run" && !agentFields.every((key) => nonBlank(actor[key]))) throw new Error("agent authority requires sponsor, initiator, grant, expiry, and revocation")
  if (actor.toolExecution !== undefined && (!exactKeys(actor.toolExecution, toolKeys) || !toolKeys.every((key) => nonBlank((actor.toolExecution as Record<string, unknown>)[key])) || (actor.toolExecution as Record<string, unknown>).workspaceId !== actor.workspaceId)) throw new Error("invalid tool execution custody")
  if (toolMediated && actor.toolExecution === undefined) throw new Error("tool-mediated mutations require tool execution custody")
  return actor as ActorContext
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}
export async function digestCanonicalV2(value: unknown): Promise<string> {
  const bytes = Uint8Array.from(unescape(encodeURIComponent(canonical(value))), (char) => char.charCodeAt(0))
  const webCrypto = (globalThis as unknown as { crypto: { subtle: { digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer> } } }).crypto
  const digest = await webCrypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
/** Includes every authority field, including the immutable tool chain when present. */
export const custodyDigestMaterialV2 = (actor: ActorContext) => canonical(actor)
export const resolvedActorCustodyDigestV2 = (actor: ActorContext) => digestCanonicalV2(actor)
/** Generated ids, sequence, and timestamps are deliberately excluded from this material. */
export const commandFingerprintMaterialV2 = (input: { requestDigest: string; evidenceDigest: string; custodyDigest: string; workspaceId: string; workspaceEpoch: number; correlationId: string; causationId: string }) => canonical(input)
export type PreAuthorizationIdentityV2 = Readonly<{ workspaceId: string; requestId: string; requestDigest: string; evidenceDigest: string; fingerprint: string }>
export async function createPreAuthorizationIdentityV2(workspaceId: string, request: MutationRequestV2): Promise<PreAuthorizationIdentityV2> {
  const requestDigest = await digestCanonicalV2({ version: request.version, kind: request.kind, requestId: request.requestId, rationale: request.rationale, payload: request.payload, surface: request.surface })
  const evidenceDigest = await digestCanonicalV2(request.evidence)
  return { workspaceId, requestId: request.requestId, requestDigest, evidenceDigest, fingerprint: await digestCanonicalV2({ workspaceId, requestId: request.requestId, requestDigest, evidenceDigest }) }
}
/** Event and intent records bind the command fingerprint but never mutable delivery state. */
export const eventDigestMaterialV2 = (event: LedgerEventV2 | OutboxIntentV2) => canonical(event)
export type ReplayDecisionV2<T> = { kind: "replay"; receipt: T } | { kind: "conflict" } | { kind: "authorize" }
/** Workspace-owned `(workspaceId, requestId)` staging rule: stored receipts win across epoch/policy changes. */
export function decideWorkspaceReplayV2<T>(stored: { fingerprint: string; receipt: T } | undefined, fingerprint: string): ReplayDecisionV2<T> {
  if (!stored) return { kind: "authorize" }
  return stored.fingerprint === fingerprint ? { kind: "replay", receipt: stored.receipt } : { kind: "conflict" }
}
/** Stage one is intentionally custody-free; authorization occurs only after this decision. */
export const decidePreAuthorizationReplayV2 = decideWorkspaceReplayV2
export async function decodeResolvedMutationIntentV2(value: unknown): Promise<ResolvedMutationIntentV2> {
  if (!exactKeys(value, ["request", "actor", "requestDigest", "evidenceDigest", "custodyDigest", "commandFingerprint", "workspaceEpoch", "correlationId", "causationId"])) throw new Error("invalid resolved mutation intent")
  const intent = value as Record<string, unknown>; const request = decodeMutationRequestV2(intent.request)
  const actor = decodeActorContext(intent.actor, request.surface === "tool" || request.evidence.kind === "tool")
  if (!["requestDigest", "evidenceDigest", "custodyDigest", "commandFingerprint"].every((key) => typeof intent[key] === "string" && /^[a-f0-9]{64}$/.test(intent[key] as string))) throw new Error("invalid resolved intent digest")
  const pre = await createPreAuthorizationIdentityV2(actor.workspaceId, request); const custodyDigest = await resolvedActorCustodyDigestV2(actor)
  const expectedCommand = await digestCanonicalV2(commandFingerprintMaterialV2({ requestDigest: pre.requestDigest, evidenceDigest: pre.evidenceDigest, custodyDigest, workspaceId: actor.workspaceId, workspaceEpoch: intent.workspaceEpoch as number, correlationId: intent.correlationId as string, causationId: intent.causationId as string }))
  if (!Number.isInteger(intent.workspaceEpoch) || !nonBlank(intent.correlationId) || !nonBlank(intent.causationId) || intent.requestDigest !== pre.requestDigest || intent.evidenceDigest !== pre.evidenceDigest || intent.custodyDigest !== custodyDigest || intent.commandFingerprint !== expectedCommand) throw new Error("resolved intent digest mismatch")
  return { request, actor, requestDigest: pre.requestDigest, evidenceDigest: pre.evidenceDigest, custodyDigest, commandFingerprint: intent.commandFingerprint as string, workspaceEpoch: intent.workspaceEpoch as number, correlationId: intent.correlationId as string, causationId: intent.causationId as string }
}
function decodeImmutable(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!exactKeys(value, keys)) throw new Error("immutable ledger/outbox record has unknown or missing keys")
  const record = value as Record<string, unknown>
  if (!["eventId", "outboxId", "workspaceId", "commandFingerprint", "requestId", "causationId", "correlationId", "recipient", "createdAt"].filter((key) => key in record).every((key) => nonBlank(record[key])) || !Number.isInteger(record.workspaceEpoch) || !Number.isInteger(record.sequence)) throw new Error("invalid immutable record")
  return record
}
export function decodeLedgerEventV2(value: unknown): LedgerEventV2 { return decodeImmutable(value, ["eventId", "workspaceId", "workspaceEpoch", "sequence", "commandFingerprint", "requestId", "causationId", "correlationId", "recipient", "payload", "createdAt"]) as LedgerEventV2 }
export function decodeOutboxIntentV2(value: unknown): OutboxIntentV2 { return decodeImmutable(value, ["outboxId", "eventId", "workspaceId", "workspaceEpoch", "sequence", "commandFingerprint", "requestId", "causationId", "correlationId", "recipient", "payload", "createdAt"]) as OutboxIntentV2 }
export function decodeOutboxDeliveryV2(value: unknown): OutboxDeliveryV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid delivery")
  const delivery = value as Record<string, unknown>; const allowed = ["consumer", "idempotencyKey", "state", "attempts", "leaseOwner", "leaseToken", "leaseExpiresAt", "nextAttemptAt", "diagnostics", "terminalAt", "terminalReason"]
  const lease = ["leaseOwner", "leaseToken", "leaseExpiresAt"], terminal = ["terminalAt", "terminalReason"]
  if (Object.keys(delivery).some((key) => !allowed.includes(key)) || !nonBlank(delivery.consumer) || !nonBlank(delivery.idempotencyKey) || !["pending", "leased", "delivered", "failed"].includes(delivery.state as string) || typeof delivery.attempts !== "number" || !Number.isInteger(delivery.attempts) || delivery.attempts < 0 || (delivery.diagnostics !== undefined && (!Array.isArray(delivery.diagnostics) || delivery.diagnostics.length > 8 || delivery.diagnostics.some((message) => !nonBlank(message) || message.length > 512)))) throw new Error("invalid mutable delivery")
  if (delivery.state === "pending" && [...lease, ...terminal].some((key) => key in delivery)) throw new Error("pending delivery cannot include lease or terminal")
  if (delivery.state === "leased" && (!lease.every((key) => nonBlank(delivery[key])) || terminal.some((key) => key in delivery))) throw new Error("leased delivery requires lease only")
  if ((delivery.state === "delivered" || delivery.state === "failed") && (!terminal.every((key) => nonBlank(delivery[key])) || lease.some((key) => key in delivery))) throw new Error("terminal delivery requires terminal metadata")
  return delivery as OutboxDeliveryV2
}
export function decodeDeliveryRecordV2(value: unknown): DeliveryRecordV2 { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid delivery record"); const record = value as Record<string, unknown>; if (!nonBlank(record.outboxId)) throw new Error("delivery record requires outbox id"); const { outboxId, ...delivery } = record; return { ...decodeOutboxDeliveryV2(delivery), outboxId } }
