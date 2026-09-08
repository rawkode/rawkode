import * as Schema from "effect/Schema"
import { canonicalWorkforcePreimageV1, digestWorkforcePreimageV1, type CanonicalWorkforceValue } from "./workforce.js"
import { EntityId, IsoDateTimeString } from "./node.js"

/** Public read contract and inert identity primitives for the future standup publisher. */
export const STANDUP_PUBLICATION_PROTOCOL_VERSION = "athenaeum.standup-publication.v1" as const
export const STANDUP_PUBLICATION_SLOT_IDENTITY_VERSION = "athenaeum.standup-publication-slot.v1" as const
export const STANDUP_PUBLICATION_REQUEST_ID_VERSION = "athenaeum.standup-publication-request.v1" as const
export const STANDUP_PUBLICATION_CHILD_NODE_ID_VERSION = "athenaeum.standup-publication-child-node.v1" as const
export const STANDUP_PUBLICATION_FINGERPRINT_VERSION = "athenaeum.standup-publication-fingerprint.v1" as const
export const STANDUP_PUBLICATION_MAX_TEXT_BYTES = 32 * 1024

export type StandupPublicationDefinitionKind = "microEmployee" | "job" | "workflow" | "schedule" | "council"
export type StandupPublicationDefinitionRef<K extends StandupPublicationDefinitionKind = StandupPublicationDefinitionKind> = {
  readonly kind: K
  readonly id: string
  readonly version: string
}
export type StandupPublicationSlotIdentity = {
  readonly version: typeof STANDUP_PUBLICATION_SLOT_IDENTITY_VERSION
  readonly workspaceId: string
  readonly dailyNoteId: string
  readonly runIdentityVersion: string
  readonly microEmployee: StandupPublicationDefinitionRef<"microEmployee">
  readonly job: StandupPublicationDefinitionRef<"job">
  readonly workflow: StandupPublicationDefinitionRef<"workflow">
  readonly schedule: StandupPublicationDefinitionRef<"schedule">
  readonly runId: string
  readonly occurrenceId: string
  readonly civilDate: string
  readonly councilRefs: readonly StandupPublicationDefinitionRef<"council">[]
}
export type CanonicalStandupPublicationSlot = Readonly<StandupPublicationSlotIdentity>
export type CanonicalStandupPublicationText = { readonly bytes: Uint8Array; readonly sha256: string; readonly byteLength: number }
export type StandupPublicationFingerprintInput = {
  readonly slot: StandupPublicationSlotIdentity
  readonly text: string
  readonly authority: { readonly subject: string; readonly generation: string }
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0
const isWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (!Number.isInteger(low) || low < 0xdc00 || low > 0xdfff) return false
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}
const utf8 = (value: string): Uint8Array => {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) { const low = value.charCodeAt(++index); code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00 }
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }
  return new Uint8Array(bytes)
}
const compareUtf16 = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
const ref = <K extends StandupPublicationDefinitionKind>(value: unknown, kind: K): value is StandupPublicationDefinitionRef<K> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === 3 && (value as { kind?: unknown }).kind === kind &&
  isNonEmptyString((value as { id?: unknown }).id) && isNonEmptyString((value as { version?: unknown }).version)
const assertId: (value: unknown, name: string) => asserts value is string = (value, name) => { if (!isNonEmptyString(value)) throw new TypeError(`${name} must be a non-empty string`) }
const refKey = (value: StandupPublicationDefinitionRef): readonly [string, string, string] => [value.kind, value.id, value.version]
const compareRef = (left: StandupPublicationDefinitionRef, right: StandupPublicationDefinitionRef): number => {
  const a = refKey(left), b = refKey(right)
  for (let index = 0; index < a.length; index++) { const result = compareUtf16(a[index]!, b[index]!); if (result !== 0) return result }
  return 0
}

/** Canonicalizes only the authority slot. It rejects duplicate councils and never changes report text. */
export const canonicalStandupPublicationSlot = (value: StandupPublicationSlotIdentity): CanonicalStandupPublicationSlot => {
  if (value === null || typeof value !== "object" || value.version !== STANDUP_PUBLICATION_SLOT_IDENTITY_VERSION) throw new TypeError("unsupported standup publication slot version")
  for (const key of ["workspaceId", "dailyNoteId", "runIdentityVersion", "runId", "occurrenceId", "civilDate"] as const) assertId(value[key], key)
  if (!ref(value.microEmployee, "microEmployee") || !ref(value.job, "job") || !ref(value.workflow, "workflow") || !ref(value.schedule, "schedule") || !Array.isArray(value.councilRefs) || !value.councilRefs.every((entry) => ref(entry, "council"))) throw new TypeError("invalid standup publication definition reference")
  const councilRefs = [...value.councilRefs].sort(compareRef)
  if (councilRefs.some((entry, index) => index > 0 && compareRef(entry, councilRefs[index - 1]!) === 0)) throw new TypeError("duplicate standup publication council reference")
  return { ...value, councilRefs }
}

/** Empty reports are rejected; whitespace-only reports are valid and preserved byte-for-byte. */
export const canonicalStandupPublicationText = (text: string): CanonicalStandupPublicationText => {
  if (typeof text !== "string" || text.length === 0) throw new TypeError("standup publication text must be non-empty")
  if (!isWellFormedUnicode(text)) throw new TypeError("standup publication text must be well-formed Unicode")
  const bytes = utf8(text)
  if (bytes.length > STANDUP_PUBLICATION_MAX_TEXT_BYTES) throw new RangeError("standup publication text exceeds byte limit")
  return { bytes, sha256: digestWorkforcePreimageV1(bytes), byteLength: bytes.length }
}
const slotPreimage = (slot: StandupPublicationSlotIdentity): CanonicalWorkforceValue => {
  const canonical = canonicalStandupPublicationSlot(slot)
  return { version: canonical.version, workspaceId: canonical.workspaceId, dailyNoteId: canonical.dailyNoteId, runIdentityVersion: canonical.runIdentityVersion, microEmployee: canonical.microEmployee as CanonicalWorkforceValue, job: canonical.job as CanonicalWorkforceValue, workflow: canonical.workflow as CanonicalWorkforceValue, schedule: canonical.schedule as CanonicalWorkforceValue, runId: canonical.runId, occurrenceId: canonical.occurrenceId, civilDate: canonical.civilDate, councilRefs: canonical.councilRefs as CanonicalWorkforceValue }
}
const domainDigest = (domain: string, value: CanonicalWorkforceValue): string => digestWorkforcePreimageV1(canonicalWorkforcePreimageV1({ domain, value }))
export const standupPublicationSlotDigest = (slot: StandupPublicationSlotIdentity): string => domainDigest(STANDUP_PUBLICATION_PROTOCOL_VERSION, slotPreimage(slot))
/** Stable idempotency identity for a slot; intentionally independent of report text. */
export const standupPublicationRequestIdentity = (slot: StandupPublicationSlotIdentity): string => domainDigest(STANDUP_PUBLICATION_REQUEST_ID_VERSION, slotPreimage(slot))
const hexBytes = (hex: string): Uint8Array => Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16))
const rfcUuidV8 = (hash: string): string => { const bytes = hexBytes(hash); bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80; const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` }
/** RFC 9562 UUIDv8 derived from SHA-256 of a separately domain-separated slot preimage. */
export const standupPublicationChildNodeId = (slot: StandupPublicationSlotIdentity): string => rfcUuidV8(domainDigest(STANDUP_PUBLICATION_CHILD_NODE_ID_VERSION, slotPreimage(slot)))
/** Private replay fingerprint helper; callers must not place its authority data in public DTOs. */
export const standupPublicationFingerprint = (input: StandupPublicationFingerprintInput): string => {
  assertId(input.authority.subject, "authority.subject"); assertId(input.authority.generation, "authority.generation")
  const text = canonicalStandupPublicationText(input.text), slot = canonicalStandupPublicationSlot(input.slot)
  return domainDigest(STANDUP_PUBLICATION_FINGERPRINT_VERSION, { slot: slotPreimage(slot), text: { sha256: text.sha256, byteLength: text.byteLength }, authority: input.authority, agentJob: { jobId: slot.job.id, runId: slot.runId } })
}

export const StandupPublicationReference = Schema.Struct({ kind: Schema.Literal("microEmployee", "job", "workflow", "schedule", "council"), id: Schema.String.pipe(Schema.minLength(1)), version: Schema.String.pipe(Schema.minLength(1)) })
export type StandupPublicationReference = typeof StandupPublicationReference.Type
export const StandupPublicationCompanionStatus = Schema.Literal("verified-original", "modified", "missing", "unavailable")
export type StandupPublicationCompanionStatus = typeof StandupPublicationCompanionStatus.Type
/** The terminal workforce outcome, when this publication has a matching durable run receipt.
 *
 * It is deliberately optional: pre-workforce publications are still valid public history and
 * must not be made unreadable merely because they have no companion receipt row. */
export const StandupPublicationResultKind = Schema.Literal("completed", "blocked", "failed", "skipped")
export type StandupPublicationResultKind = typeof StandupPublicationResultKind.Type
export const STANDUP_RECORDED_WORK_VERSION = "athenaeum.standup-recorded-work.v1" as const
const isWellFormedPublicUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (low < 0xdc00 || low > 0xdfff) return false
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}
const utf8Bytes = (value: string): number => {
  let length = 0
  for (const character of value) {
    const point = character.codePointAt(0)!
    length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return length
}
const boundedPublicRecordedWorkText = (maximumScalars: number, maximumBytes: number) =>
  Schema.String.pipe(
    Schema.minLength(1),
    Schema.filter((value) =>
      isWellFormedPublicUnicode(value) &&
      Array.from(value).length <= maximumScalars &&
      utf8Bytes(value) <= maximumBytes,
      { message: () => `text exceeds ${maximumScalars} Unicode scalars or ${maximumBytes} UTF-8 bytes` }
    )
  )
const publicRecordedWorkText = boundedPublicRecordedWorkText(500, 2_000)
const publicRecordedWorkTargetText = boundedPublicRecordedWorkText(200, 800)
export const StandupRecordedWorkOperation = Schema.Literal(
  "createdNode", "recordedFact", "assignedSupertag", "updatedSupertag",
  "createdDocument", "updatedDocument", "preparedMeeting"
)
export type StandupRecordedWorkOperation = typeof StandupRecordedWorkOperation.Type
export class StandupRecordedWorkTarget extends Schema.Class<StandupRecordedWorkTarget>("StandupRecordedWorkTarget")({
  kind: Schema.Literal("note", "supertag"), label: publicRecordedWorkTargetText
}) {}
export class StandupRecordedWorkItem extends Schema.Class<StandupRecordedWorkItem>("StandupRecordedWorkItem")({
  operation: StandupRecordedWorkOperation, commitMessage: publicRecordedWorkText,
  target: Schema.optional(StandupRecordedWorkTarget)
}) {}
export class StandupRecordedWorkAvailable extends Schema.Class<StandupRecordedWorkAvailable>("StandupRecordedWorkAvailable")({
  version: Schema.Literal(STANDUP_RECORDED_WORK_VERSION), state: Schema.Literal("available"),
  items: Schema.Array(StandupRecordedWorkItem).pipe(Schema.maxItems(8)),
  remainingCount: Schema.Number.pipe(Schema.int(), Schema.between(0, 9_999))
}) {}
export class StandupRecordedWorkUnavailable extends Schema.Class<StandupRecordedWorkUnavailable>("StandupRecordedWorkUnavailable")({
  version: Schema.Literal(STANDUP_RECORDED_WORK_VERSION), state: Schema.Literal("unavailable")
}) {}
export const StandupRecordedWork = Schema.Union(StandupRecordedWorkAvailable, StandupRecordedWorkUnavailable)
export type StandupRecordedWork = typeof StandupRecordedWork.Type
/** Workspace-readable publication projection. It intentionally excludes provenance, authority, commands, receipts, and diagnostics. */
export class StandupPublication extends Schema.Class<StandupPublication>("StandupPublication")({
  id: EntityId, civilDate: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)),
  microEmployeeLabel: Schema.String.pipe(Schema.minLength(1)), jobLabel: Schema.String.pipe(Schema.minLength(1)), workflowLabel: Schema.String.pipe(Schema.minLength(1)), scheduleLabel: Schema.String.pipe(Schema.minLength(1)),
  microEmployee: StandupPublicationReference, job: StandupPublicationReference, workflow: StandupPublicationReference, schedule: StandupPublicationReference, councilRefs: Schema.Array(StandupPublicationReference),
  originalText: Schema.String.pipe(Schema.minLength(1)), publishedAt: IsoDateTimeString, childNodeId: EntityId, companionStatus: StandupPublicationCompanionStatus,
  resultKind: Schema.optional(StandupPublicationResultKind),
  /** Omitted for legacy server projections. V1 never exposes raw provenance identifiers. */
  recordedWork: Schema.optional(StandupRecordedWork)
}) {}
export class ListStandupPublicationsInput extends Schema.Class<ListStandupPublicationsInput>("ListStandupPublicationsInput")({ workspaceId: EntityId, dailyNoteId: EntityId }) {}
export class ListStandupPublicationsOutput extends Schema.Class<ListStandupPublicationsOutput>("ListStandupPublicationsOutput")({ publications: Schema.Array(StandupPublication) }) {}
