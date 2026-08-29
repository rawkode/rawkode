import {
  STANDUP_PRIVATE_GRANT_VERSION,
  canonicalDailyNoteIdForCivilDate,
  resolveStandupRunGrant,
  standupPublicationGrantRecordDigestV1
} from "./standup-publication-private-contract.js"
import {
  STANDUP_RUN_GRANT_ATTESTATION_VERSION,
  STANDUP_RUN_GRANT_ISSUER_VERSION,
  STANDUP_RUN_GRANT_MAX_TTL_MS,
  type AttestedStandupRunMaterialV1,
  type PreparedStandupRunGrantDraftV1,
  type StandupRunGrantIssuerDependencies,
  type StandupRunGrantIssuerIdentityV1,
  type TrustedStandupRunAttestation
} from "./standup-run-grant-issuer-private-contract.js"

const fail = (message: string): never => {
  throw new TypeError(`invalid private standup run-grant issuer: ${message}`)
}

const isPlainRecord = (value: unknown): value is object => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const exactDataKeys = (value: unknown, keys: readonly string[]): value is object => {
  if (!isPlainRecord(value)) return false
  let actual: readonly PropertyKey[]
  try {
    actual = Reflect.ownKeys(value)
  } catch {
    return false
  }
  if (actual.some((key) => typeof key !== "string") || actual.length !== keys.length) return false
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      return false
    }
    if (descriptor === undefined || !("value" in descriptor)) return false
  }
  return actual.every((key) => typeof key === "string" && keys.includes(key))
}

const dataValue = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) throw new TypeError(`invalid private standup run-grant issuer: ${key} must be a data property`)
  if (!("value" in descriptor)) throw new TypeError(`invalid private standup run-grant issuer: ${key} must be a data property`)
  return descriptor.value
}

const isDataDescriptor = (descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor & Readonly<{ readonly value: unknown }> =>
  descriptor !== undefined && "value" in descriptor

const nonBlank = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must be a nonblank string`)
  return value as string
}

type DefinitionKind = "microEmployee" | "job" | "workflow" | "schedule" | "council"
type DefinitionReference<K extends DefinitionKind> = Readonly<{ readonly kind: K; readonly id: string; readonly version: string }>
const MAX_COUNCIL_REFS = 32

const copyReference = <K extends DefinitionKind>(value: unknown, kind: K, field: string): DefinitionReference<K> => {
  if (!exactDataKeys(value, ["kind", "id", "version"])) fail(`${field} must be an exact ${kind} reference`)
  const record = value as object
  if (dataValue(record, "kind") !== kind) fail(`${field} must be an exact ${kind} reference`)
  return Object.freeze({
    kind,
    id: nonBlank(dataValue(record, "id"), `${field}.id`),
    version: nonBlank(dataValue(record, "version"), `${field}.version`)
  })
}

/**
 * Decode an actual, dense Array through own descriptors only.  Attester values are untrusted:
 * calling `map`, iterating the value, reading `.length`, or indexing it could execute a hostile
 * own accessor.  The fresh result array is safe to freeze after every source element has been
 * checked as a data descriptor.
 */
const copyCouncilReferences = (value: unknown): readonly DefinitionReference<"council">[] => {
  let isArray = false
  try {
    isArray = Array.isArray(value)
  } catch {
    fail("councilRefs must be an exact dense data array")
  }
  if (!isArray) fail("councilRefs must be an exact dense data array")
  const source = value as unknown[]
  let prototype: object | null | undefined
  let keys: readonly PropertyKey[] | undefined
  let lengthDescriptor: PropertyDescriptor | undefined
  try {
    prototype = Object.getPrototypeOf(source)
    keys = Reflect.ownKeys(source)
    lengthDescriptor = Object.getOwnPropertyDescriptor(source, "length")
  } catch {
    fail("councilRefs must be an exact dense data array")
  }
  if (prototype !== Array.prototype) fail("councilRefs must be an exact dense data array")
  const exactKeys: readonly PropertyKey[] = keys === undefined
    ? fail("councilRefs must be an exact dense data array")
    : keys
  const exactLengthDescriptor: PropertyDescriptor & Readonly<{ readonly value: unknown }> = isDataDescriptor(lengthDescriptor)
    ? lengthDescriptor
    : fail("councilRefs must be an exact dense data array")
  const length = exactLengthDescriptor.value
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_COUNCIL_REFS) {
    fail(`councilRefs must contain no more than ${MAX_COUNCIL_REFS} entries`)
  }
  if (exactKeys.length !== length + 1) fail("councilRefs must be an exact dense data array")

  let sawLength = false
  const presentIndexes = new Set<number>()
  for (let offset = 0; offset < exactKeys.length; offset += 1) {
    const key = exactKeys[offset]
    if (typeof key !== "string") fail("councilRefs must be an exact dense data array")
    if (key === "length") {
      sawLength = true
      continue
    }
    const index = Number(key)
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || `${index}` !== key) {
      fail("councilRefs must be an exact dense data array")
    }
    presentIndexes.add(index)
  }
  if (!sawLength || presentIndexes.size !== length) fail("councilRefs must be an exact dense data array")

  const copied = new Array<DefinitionReference<"council">>(length)
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, `${index}`)
    } catch {
      fail("councilRefs must be an exact dense data array")
    }
    const dataDescriptor: PropertyDescriptor & Readonly<{ readonly value: unknown }> = isDataDescriptor(descriptor)
      ? descriptor
      : fail("councilRefs must be an exact dense data array")
    copied[index] = copyReference(dataDescriptor.value, "council", `councilRefs[${index}]`)
  }
  return Object.freeze(copied)
}

const attestationKeys = [
  "version", "workspaceId", "civilDate", "runIdentityVersion", "microEmployee", "job", "workflow", "schedule", "councilRefs",
  "runId", "occurrenceId", "microEmployeeLabel", "jobLabel", "workflowLabel", "scheduleLabel"
] as const

/** Exact-decode, copy, and freeze only run-owned facts from an attester result. */
const resolveAttestedMaterial = (value: unknown): AttestedStandupRunMaterialV1 => {
  if (!exactDataKeys(value, attestationKeys)) fail("attestation has unknown, missing, or accessor fields")
  const record = value as object
  if (dataValue(record, "version") !== STANDUP_RUN_GRANT_ATTESTATION_VERSION) fail("unsupported attestation version")
  const councilRefs = copyCouncilReferences(dataValue(record, "councilRefs"))
  return Object.freeze({
    version: STANDUP_RUN_GRANT_ATTESTATION_VERSION,
    workspaceId: nonBlank(dataValue(record, "workspaceId"), "workspaceId"),
    civilDate: nonBlank(dataValue(record, "civilDate"), "civilDate"),
    runIdentityVersion: nonBlank(dataValue(record, "runIdentityVersion"), "runIdentityVersion"),
    microEmployee: copyReference(dataValue(record, "microEmployee"), "microEmployee", "microEmployee"),
    job: copyReference(dataValue(record, "job"), "job", "job"),
    workflow: copyReference(dataValue(record, "workflow"), "workflow", "workflow"),
    schedule: copyReference(dataValue(record, "schedule"), "schedule", "schedule"),
    councilRefs,
    runId: nonBlank(dataValue(record, "runId"), "runId"),
    occurrenceId: nonBlank(dataValue(record, "occurrenceId"), "occurrenceId"),
    microEmployeeLabel: nonBlank(dataValue(record, "microEmployeeLabel"), "microEmployeeLabel"),
    jobLabel: nonBlank(dataValue(record, "jobLabel"), "jobLabel"),
    workflowLabel: nonBlank(dataValue(record, "workflowLabel"), "workflowLabel"),
    scheduleLabel: nonBlank(dataValue(record, "scheduleLabel"), "scheduleLabel")
  })
}

const issuerIdentityKeys = [
  "issuerId", "grantRecordVersion", "subject", "replayAudience", "authorityGeneration", "revocationId", "revocationGeneration", "policyVersion"
] as const

const resolveIssuerIdentity = (value: unknown): StandupRunGrantIssuerIdentityV1 => {
  if (!exactDataKeys(value, issuerIdentityKeys)) fail("issuer identity has unknown, missing, or accessor fields")
  const record = value as object
  return Object.freeze({
    issuerId: nonBlank(dataValue(record, "issuerId"), "issuerId"),
    grantRecordVersion: nonBlank(dataValue(record, "grantRecordVersion"), "grantRecordVersion"),
    subject: nonBlank(dataValue(record, "subject"), "subject"),
    replayAudience: nonBlank(dataValue(record, "replayAudience"), "replayAudience"),
    authorityGeneration: nonBlank(dataValue(record, "authorityGeneration"), "authorityGeneration"),
    revocationId: nonBlank(dataValue(record, "revocationId"), "revocationId"),
    revocationGeneration: nonBlank(dataValue(record, "revocationGeneration"), "revocationGeneration"),
    policyVersion: nonBlank(dataValue(record, "policyVersion"), "policyVersion")
  })
}

const canonicalInstant = (value: unknown, field: string): Readonly<{ readonly value: string; readonly epochMs: number }> => {
  if (typeof value !== "string") fail(`${field} must be a canonical UTC ISO instant`)
  const instant = value as string
  const epochMs = Date.parse(instant)
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== instant) fail(`${field} must be a canonical UTC ISO instant`)
  return Object.freeze({ value: instant, epochMs })
}

const checkedTtl = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > STANDUP_RUN_GRANT_MAX_TTL_MS) {
    fail(`ttlMs must be a positive integer no greater than ${STANDUP_RUN_GRANT_MAX_TTL_MS}`)
  }
  return value
}

/**
 * The attester result is untrusted data.  Do not use the shared generic thenable helper here:
 * it reads `.then`, which would execute an accessor before the exact data decoder can reject it.
 * A result must be a plain record, and an own `then` property is inspected as a descriptor only.
 */
const assertSynchronousAttesterResult = (value: unknown): object => {
  if (!isPlainRecord(value)) fail("attester must return an exact plain data record synchronously")
  const record = value as object
  let then: PropertyDescriptor | undefined
  try {
    then = Object.getOwnPropertyDescriptor(record, "then")
  } catch {
    fail("attester must return an exact plain data record synchronously")
  }
  if (then !== undefined && (!('value' in then) || typeof then.value === "function")) {
    fail("attester must be synchronous and may not return a thenable")
  }
  return record
}

/**
 * A private, ephemeral draft preparer. It deliberately has no bearer lifecycle, storage, retry,
 * receipt, event, outbox, publication, companion page, or public ingress dependency.
 */
export class StandupRunGrantDraftPreparer {
  constructor(private readonly dependencies: StandupRunGrantIssuerDependencies) {}

  prepare(attestation: TrustedStandupRunAttestation): PreparedStandupRunGrantDraftV1 {
    const rawAttestation = assertSynchronousAttesterResult(this.dependencies.attester.resolve(attestation))
    const material = resolveAttestedMaterial(rawAttestation)
    // These exact/type decoders deliberately do not read `.then`: port data may contain hostile
    // accessors, and only the expected own data properties may ever be inspected.
    const identity = resolveIssuerIdentity(this.dependencies.identity.identity())
    const issued = canonicalInstant(this.dependencies.clock.now(), "issuedAt")
    const ttlMs = checkedTtl(this.dependencies.ttlMs)
    const expiresEpochMs = issued.epochMs + ttlMs
    if (!Number.isSafeInteger(expiresEpochMs) || !Number.isFinite(expiresEpochMs)) fail("grant expiry is outside the supported instant range")
    const expiresAt = new Date(expiresEpochMs)
    if (Number.isNaN(expiresAt.valueOf()) || expiresEpochMs <= issued.epochMs) fail("grant expiry must be later than issuance")
    // Attestation data cannot override issuer-owned custody because its exact decoder rejects all
    // unrecognized fields before server identity, clock, and grant-id sources are assembled here.
    // Validate every non-ID grant invariant before allocating an irreversible server identifier.
    // In particular, this rejects impossible civil dates and duplicate council definitions before
    // `nextGrantId` can consume an ID.
    const validatedGrant = resolveStandupRunGrant({
      version: STANDUP_PRIVATE_GRANT_VERSION,
      issuerId: identity.issuerId,
      grantId: "standup-run-grant-validation-only",
      grantRecordVersion: identity.grantRecordVersion,
      workspaceId: material.workspaceId,
      civilDate: material.civilDate,
      dailyNoteId: canonicalDailyNoteIdForCivilDate(material.civilDate),
      runIdentityVersion: material.runIdentityVersion,
      microEmployee: material.microEmployee,
      job: material.job,
      workflow: material.workflow,
      schedule: material.schedule,
      councilRefs: material.councilRefs,
      runId: material.runId,
      occurrenceId: material.occurrenceId,
      microEmployeeLabel: material.microEmployeeLabel,
      jobLabel: material.jobLabel,
      workflowLabel: material.workflowLabel,
      scheduleLabel: material.scheduleLabel,
      subject: identity.subject,
      replayAudience: identity.replayAudience,
      actorKind: "system",
      authorityGeneration: identity.authorityGeneration,
      revocationId: identity.revocationId,
      revocationGeneration: identity.revocationGeneration,
      policyVersion: identity.policyVersion,
      issuedAt: issued.value,
      expiresAt: expiresAt.toISOString(),
      oneUseBudget: 1
    })
    const grantId = nonBlank(this.dependencies.identity.nextGrantId(), "grantId")
    const grant = resolveStandupRunGrant({ ...validatedGrant, grantId })

    // The caller receives only immutable grant material. Bearer issuance and persistence remain
    // intentionally deferred to the separately-gated private Workspace DO adapter.
    return Object.freeze({
      version: STANDUP_RUN_GRANT_ISSUER_VERSION,
      grant,
      grantRecordDigest: standupPublicationGrantRecordDigestV1(grant)
    })
  }
}
