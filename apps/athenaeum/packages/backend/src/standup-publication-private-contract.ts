import {
  STANDUP_PUBLICATION_SLOT_IDENTITY_VERSION,
  canonicalStandupPublicationSlot,
  canonicalStandupPublicationText,
  canonicalWorkforcePreimageV1,
  digestWorkforcePreimageV1,
  standupPublicationChildNodeId,
  standupPublicationRequestIdentity,
  standupPublicationSlotDigest,
  type CanonicalWorkforceValue,
  type StandupPublicationDefinitionKind,
  type StandupPublicationSlotIdentity
} from "@athenaeum/domain"

/**
 * This contract is deliberately private and dormant.  It represents a result after a future
 * trusted workforce scheduler has admitted it; it is neither a browser DTO nor a token issuer.
 */
export const STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION = "athenaeum.standup-publication-private.v1" as const
export const STANDUP_PRIVATE_GRANT_VERSION = "athenaeum.standup-run-grant.v1" as const
export const STANDUP_PRIVATE_REQUEST_VERSION = "athenaeum.publish-standup-request.v1" as const
export const STANDUP_PRIVATE_MESSAGE_VERSION = "athenaeum.standup-publication-message.v1" as const
export const STANDUP_PRIVATE_CUSTODY_FINGERPRINT_VERSION = "athenaeum.standup-publication-custody-fingerprint.v1" as const
/** Maximum lifetime for a trusted run grant; shared by admission and the future issuer. */
export const STANDUP_RUN_GRANT_MAX_TTL_MS = 15 * 60 * 1000

declare const opaqueStandupRunGrantToken: unique symbol

/** An issuer-owned bearer. It has no constructor in production source and must never be stored. */
export type OpaqueStandupRunGrantToken = {
  readonly [opaqueStandupRunGrantToken]: "athenaeum.standup-run-grant-token"
}

export type PrivateDefinitionReference<K extends StandupPublicationDefinitionKind = StandupPublicationDefinitionKind> = Readonly<{
  readonly kind: K
  readonly id: string
  readonly version: string
}>

/**
 * The resolver supplies this durable immutable record; callers can only provide its opaque token.
 * Every field that can affect admission, output, actor custody, or message derivation is explicit
 * and participates in the custody fingerprint below.
 */
export type ResolvedStandupRunGrantV1 = Readonly<{
  readonly version: typeof STANDUP_PRIVATE_GRANT_VERSION
  readonly issuerId: string
  readonly grantId: string
  readonly grantRecordVersion: string
  readonly workspaceId: string
  readonly civilDate: string
  readonly dailyNoteId: string
  readonly runIdentityVersion: string
  readonly microEmployee: PrivateDefinitionReference<"microEmployee">
  readonly job: PrivateDefinitionReference<"job">
  readonly workflow: PrivateDefinitionReference<"workflow">
  readonly schedule: PrivateDefinitionReference<"schedule">
  readonly councilRefs: readonly PrivateDefinitionReference<"council">[]
  readonly runId: string
  readonly occurrenceId: string
  readonly microEmployeeLabel: string
  readonly jobLabel: string
  readonly workflowLabel: string
  readonly scheduleLabel: string
  readonly subject: string
  readonly replayAudience: string
  readonly actorKind: "system"
  readonly authorityGeneration: string
  readonly revocationId: string
  readonly revocationGeneration: string
  readonly policyVersion: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly oneUseBudget: 1
}>

/** No slot, actor, provenance, message, or request identity is accepted from a caller. */
export type PublishStandupPublicationRequestV1 = Readonly<{
  readonly version: typeof STANDUP_PRIVATE_REQUEST_VERSION
  readonly originalText: string
}>

export type StandupGrantFreshAdmission =
  | Readonly<{ readonly status: "admitted" }>
  | Readonly<{ readonly status: "denied" }>

/**
 * Private injection point for the future issuer. It resolves an opaque bearer but cannot mint one.
 * `recheckFresh` is called inside the authority transaction only after a receipt miss.
 */
export interface StandupRunGrantResolver {
  readonly resolve: (token: OpaqueStandupRunGrantToken) => unknown
  readonly recheckFresh: (grant: ResolvedStandupRunGrantV1, context: Readonly<{
    readonly now: string
    readonly slotDigest: string
    readonly grantAlreadyConsumed: boolean
  }>) => StandupGrantFreshAdmission
}

export type StandupPublicationPrivateIntentV1 = Readonly<{
  readonly protocolVersion: typeof STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION
  readonly grant: ResolvedStandupRunGrantV1
  readonly slot: Readonly<StandupPublicationSlotIdentity>
  readonly slotDigest: string
  readonly requestIdentity: string
  readonly publicationId: string
  readonly childNodeId: string
  readonly originalText: string
  readonly originalTextDigest: string
  readonly originalTextByteLength: number
  readonly grantRecordDigest: string
  readonly custodyFingerprint: string
  readonly messageVersion: typeof STANDUP_PRIVATE_MESSAGE_VERSION
  readonly message: string
}>

export type PublishStandupPublicationOutputV1 = Readonly<{
  readonly version: typeof STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION
  readonly publicationId: string
  readonly dailyNoteId: string
  readonly civilDate: string
  readonly childNodeId: string
  readonly companionFormat: "loro-v1"
}>

const grantKeys = [
  "version", "issuerId", "grantId", "grantRecordVersion", "workspaceId", "civilDate", "dailyNoteId",
  "runIdentityVersion", "microEmployee", "job", "workflow", "schedule", "councilRefs", "runId", "occurrenceId",
  "microEmployeeLabel", "jobLabel", "workflowLabel", "scheduleLabel", "subject", "replayAudience", "actorKind",
  "authorityGeneration", "revocationId", "revocationGeneration", "policyVersion", "issuedAt", "expiresAt", "oneUseBudget"
] as const

const requestKeys = ["version", "originalText"] as const

const fail = (message: string): never => {
  throw new TypeError(`invalid private standup publication contract: ${message}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const exactDataKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!isRecord(value)) return false
  const actual = Reflect.ownKeys(value)
  if (actual.some((key) => typeof key !== "string") || actual.length !== keys.length) return false
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor)) return false
  }
  return actual.every((key) => typeof key === "string" && keys.includes(key))
}

const nonBlank = (value: unknown, field: string): string => {
  if (typeof value !== "string") fail(`${field} must be a nonblank string`)
  const text = value as string
  if (text.trim().length === 0) fail(`${field} must be a nonblank string`)
  return text
}

const isoInstant = (value: unknown, field: string): string => {
  const text = nonBlank(value, field)
  const date = new Date(text)
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== text) fail(`${field} must be a canonical ISO instant`)
  return text
}

const copyReference = <K extends StandupPublicationDefinitionKind>(value: unknown, kind: K, field: string): PrivateDefinitionReference<K> => {
  if (!exactDataKeys(value, ["kind", "id", "version"])) fail(`${field} must be an exact ${kind} definition reference`)
  const reference = value as Record<string, unknown>
  if (reference.kind !== kind) fail(`${field} must be an exact ${kind} definition reference`)
  return Object.freeze({ kind, id: nonBlank(reference.id, `${field}.id`), version: nonBlank(reference.version, `${field}.version`) }) as PrivateDefinitionReference<K>
}

/** Strict ASCII Gregorian calendar day; timestamps, whitespace, and impossible dates are rejected. */
export const assertStrictGregorianCivilDate = (value: unknown): string => {
  if (typeof value !== "string") fail("civilDate must use canonical YYYY-MM-DD")
  const date = value as string
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) fail("civilDate must use canonical YYYY-MM-DD")
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  if (!Number.isInteger(year) || year < 1 || month < 1 || month > 12 || day < 1) fail("civilDate is outside the Gregorian calendar")
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day > days[month - 1]!) fail("civilDate is outside the Gregorian calendar")
  return date
}

/** Mirrors the server's deterministic daily-note family without accepting a caller-selected id. */
export const canonicalDailyNoteIdForCivilDate = (civilDate: string): string => {
  const day = assertStrictGregorianCivilDate(civilDate)
  return `00000000-0000-4000-8000-${day.replaceAll("-", "").padStart(12, "0")}`
}

export const resolveStandupRunGrant = (value: unknown): ResolvedStandupRunGrantV1 => {
  if (!exactDataKeys(value, grantKeys)) fail("grant has unknown, missing, or accessor fields")
  const rawGrant = value as Record<string, unknown>
  if (rawGrant.version !== STANDUP_PRIVATE_GRANT_VERSION) fail("unsupported grant version")
  if (rawGrant.actorKind !== "system") fail("grant actorKind must be system")
  if (rawGrant.oneUseBudget !== 1) fail("grant oneUseBudget must be exactly one")
  const civilDate = assertStrictGregorianCivilDate(rawGrant.civilDate)
  const expectedDailyNoteId = canonicalDailyNoteIdForCivilDate(civilDate)
  const dailyNoteId = nonBlank(rawGrant.dailyNoteId, "dailyNoteId")
  if (dailyNoteId !== expectedDailyNoteId) fail("grant dailyNoteId does not match civilDate")
  const issuedAt = isoInstant(rawGrant.issuedAt, "issuedAt")
  const expiresAt = isoInstant(rawGrant.expiresAt, "expiresAt")
  if (Date.parse(expiresAt) < Date.parse(issuedAt)) fail("grant expires before it is issued")
  if (!Array.isArray(rawGrant.councilRefs)) fail("councilRefs must be an array")
  const councilRefs = Object.freeze((rawGrant.councilRefs as unknown[]).map((entry, index) => copyReference(entry, "council", `councilRefs[${index}]`)))
  const grant: ResolvedStandupRunGrantV1 = Object.freeze({
    version: STANDUP_PRIVATE_GRANT_VERSION,
    issuerId: nonBlank(rawGrant.issuerId, "issuerId"),
    grantId: nonBlank(rawGrant.grantId, "grantId"),
    grantRecordVersion: nonBlank(rawGrant.grantRecordVersion, "grantRecordVersion"),
    workspaceId: nonBlank(rawGrant.workspaceId, "workspaceId"),
    civilDate,
    dailyNoteId,
    runIdentityVersion: nonBlank(rawGrant.runIdentityVersion, "runIdentityVersion"),
    microEmployee: copyReference(rawGrant.microEmployee, "microEmployee", "microEmployee"),
    job: copyReference(rawGrant.job, "job", "job"),
    workflow: copyReference(rawGrant.workflow, "workflow", "workflow"),
    schedule: copyReference(rawGrant.schedule, "schedule", "schedule"),
    councilRefs,
    runId: nonBlank(rawGrant.runId, "runId"),
    occurrenceId: nonBlank(rawGrant.occurrenceId, "occurrenceId"),
    microEmployeeLabel: nonBlank(rawGrant.microEmployeeLabel, "microEmployeeLabel"),
    jobLabel: nonBlank(rawGrant.jobLabel, "jobLabel"),
    workflowLabel: nonBlank(rawGrant.workflowLabel, "workflowLabel"),
    scheduleLabel: nonBlank(rawGrant.scheduleLabel, "scheduleLabel"),
    subject: nonBlank(rawGrant.subject, "subject"),
    replayAudience: nonBlank(rawGrant.replayAudience, "replayAudience"),
    actorKind: "system",
    authorityGeneration: nonBlank(rawGrant.authorityGeneration, "authorityGeneration"),
    revocationId: nonBlank(rawGrant.revocationId, "revocationId"),
    revocationGeneration: nonBlank(rawGrant.revocationGeneration, "revocationGeneration"),
    policyVersion: nonBlank(rawGrant.policyVersion, "policyVersion"),
    issuedAt,
    expiresAt,
    oneUseBudget: 1
  })
  // `canonicalStandupPublicationSlot` also rejects duplicate councils and ensures every ref
  // survives the exact shared public-slot canonicalization.
  canonicalStandupPublicationSlot(slotForGrant(grant))
  return grant
}

export const slotForGrant = (grant: ResolvedStandupRunGrantV1): Readonly<StandupPublicationSlotIdentity> =>
  canonicalStandupPublicationSlot({
    version: STANDUP_PUBLICATION_SLOT_IDENTITY_VERSION,
    workspaceId: grant.workspaceId,
    dailyNoteId: grant.dailyNoteId,
    runIdentityVersion: grant.runIdentityVersion,
    microEmployee: grant.microEmployee,
    job: grant.job,
    workflow: grant.workflow,
    schedule: grant.schedule,
    runId: grant.runId,
    occurrenceId: grant.occurrenceId,
    civilDate: grant.civilDate,
    councilRefs: grant.councilRefs
  })

const digest = (domain: string, value: CanonicalWorkforceValue): string =>
  digestWorkforcePreimageV1(canonicalWorkforcePreimageV1({ domain, value }))

const grantPreimage = (grant: ResolvedStandupRunGrantV1): CanonicalWorkforceValue => ({
  version: grant.version,
  issuerId: grant.issuerId,
  grantId: grant.grantId,
  grantRecordVersion: grant.grantRecordVersion,
  workspaceId: grant.workspaceId,
  civilDate: grant.civilDate,
  dailyNoteId: grant.dailyNoteId,
  runIdentityVersion: grant.runIdentityVersion,
  microEmployee: grant.microEmployee as CanonicalWorkforceValue,
  job: grant.job as CanonicalWorkforceValue,
  workflow: grant.workflow as CanonicalWorkforceValue,
  schedule: grant.schedule as CanonicalWorkforceValue,
  councilRefs: grant.councilRefs as CanonicalWorkforceValue,
  runId: grant.runId,
  occurrenceId: grant.occurrenceId,
  microEmployeeLabel: grant.microEmployeeLabel,
  jobLabel: grant.jobLabel,
  workflowLabel: grant.workflowLabel,
  scheduleLabel: grant.scheduleLabel,
  subject: grant.subject,
  replayAudience: grant.replayAudience,
  actorKind: grant.actorKind,
  authorityGeneration: grant.authorityGeneration,
  revocationId: grant.revocationId,
  revocationGeneration: grant.revocationGeneration,
  policyVersion: grant.policyVersion,
  issuedAt: grant.issuedAt,
  expiresAt: grant.expiresAt,
  oneUseBudget: grant.oneUseBudget
})

export const standupPublicationGrantRecordDigestV1 = (grant: ResolvedStandupRunGrantV1): string =>
  digest("athenaeum.standup-publication-grant-record.v1", grantPreimage(grant))

export const derivedStandupPublicationMessage = (grant: ResolvedStandupRunGrantV1): string =>
  `Published ${grant.jobLabel} standup for ${grant.civilDate}.`

/**
 * Unlike the public helper, this includes all private custody and output-affecting grant fields.
 * It never receives or serializes the opaque bearer token.
 */
export const standupPublicationCustodyFingerprintV1 = (input: Readonly<{
  readonly grant: ResolvedStandupRunGrantV1
  readonly slot: Readonly<StandupPublicationSlotIdentity>
  readonly originalTextDigest: string
  readonly originalTextByteLength: number
  readonly message: string
}>): string => digest(STANDUP_PRIVATE_CUSTODY_FINGERPRINT_VERSION, {
  grant: grantPreimage(input.grant),
  slot: input.slot as CanonicalWorkforceValue,
  originalText: { sha256: input.originalTextDigest, byteLength: input.originalTextByteLength },
  actor: { kind: input.grant.actorKind, subject: input.grant.subject, replayAudience: input.grant.replayAudience },
  message: { version: STANDUP_PRIVATE_MESSAGE_VERSION, value: input.message }
})

export const resolvePrivatePublicationIntent = (rawGrant: unknown, rawRequest: unknown): StandupPublicationPrivateIntentV1 => {
  const grant = resolveStandupRunGrant(rawGrant)
  if (!exactDataKeys(rawRequest, requestKeys)) fail("request has unknown, missing, or unsupported fields")
  const request = rawRequest as Record<string, unknown>
  if (request.version !== STANDUP_PRIVATE_REQUEST_VERSION) fail("request has unknown, missing, or unsupported fields")
  if (typeof request.originalText !== "string") fail("originalText must be a string")
  // Preserve the shared report contract: whitespace-only reports are still meaningful exact bytes.
  const originalText = request.originalText as string
  const text = canonicalStandupPublicationText(originalText)
  const slot = slotForGrant(grant)
  const message = derivedStandupPublicationMessage(grant)
  const slotDigest = standupPublicationSlotDigest(slot)
  const childNodeId = standupPublicationChildNodeId(slot)
  const intent: StandupPublicationPrivateIntentV1 = Object.freeze({
    protocolVersion: STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION,
    grant,
    slot,
    slotDigest,
    requestIdentity: standupPublicationRequestIdentity(slot),
    publicationId: childNodeId,
    childNodeId,
    originalText,
    originalTextDigest: text.sha256,
    originalTextByteLength: text.byteLength,
    grantRecordDigest: standupPublicationGrantRecordDigestV1(grant),
    custodyFingerprint: standupPublicationCustodyFingerprintV1({
      grant,
      slot,
      originalTextDigest: text.sha256,
      originalTextByteLength: text.byteLength,
      message
    }),
    messageVersion: STANDUP_PRIVATE_MESSAGE_VERSION,
    message
  })
  return intent
}

/** Reject accidental Promise/thenable adapters; this private transaction API is synchronously scoped. */
export const assertSynchronousResult = <T>(value: T, operation: string): T => {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    let then: unknown
    try { then = (value as { readonly then?: unknown }).then } catch { throw new TypeError(`${operation} returned an unreadable thenable`) }
    if (typeof then === "function") throw new TypeError(`${operation} must be synchronous and may not return a thenable`)
  }
  return value
}

export const privatePublicationOutput = (intent: StandupPublicationPrivateIntentV1): PublishStandupPublicationOutputV1 => Object.freeze({
  version: STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION,
  publicationId: intent.publicationId,
  dailyNoteId: intent.grant.dailyNoteId,
  civilDate: intent.grant.civilDate,
  childNodeId: intent.childNodeId,
  companionFormat: "loro-v1"
})
