import {
  STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION,
  assertSynchronousResult,
  type PublishStandupPublicationOutputV1,
  type ResolvedStandupRunGrantV1,
  type StandupPublicationPrivateIntentV1
} from "./standup-publication-private-contract.js"
import { canonicalStandupPublicationText } from "@athenaeum/domain"

export const STANDUP_PUBLICATION_COMPANION_FORMAT = "loro-v1" as const
export const STANDUP_PUBLICATION_EVENT_TYPE = "workspace.standup-publication.created.v1" as const
export const STANDUP_PUBLICATION_OUTBOX_CONSUMER = "workspace-standup-projection.v1" as const

/** The sole durable receipt authority for this dormant publisher. */
export type StandupPublicationReceiptV1 = Readonly<{
  readonly version: typeof STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION
  readonly requestIdentity: string
  readonly custodyFingerprint: string
  readonly output: PublishStandupPublicationOutputV1
  readonly committedAt: string
}>

export type StandupPublicationAuthorityRequestV1 = Readonly<{
  readonly version: typeof STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION
  readonly slotDigest: string
  readonly requestIdentity: string
  readonly custodyFingerprint: string
  readonly grantRecordDigest: string
  readonly grantId: string
  readonly replayAudience: string
  readonly subject: string
  readonly receipt: StandupPublicationReceiptV1
}>

/** Private durable source of truth. The public DTO is intentionally not stored as the receipt. */
export type StandupPublicationRecordV1 = Readonly<{
  readonly version: typeof STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION
  readonly publicationId: string
  readonly childNodeId: string
  readonly workspaceId: string
  readonly dailyNoteId: string
  readonly civilDate: string
  readonly slotDigest: string
  readonly originalText: string
  readonly originalTextDigest: string
  readonly originalTextByteLength: number
  readonly microEmployee: ResolvedStandupRunGrantV1["microEmployee"]
  readonly job: ResolvedStandupRunGrantV1["job"]
  readonly workflow: ResolvedStandupRunGrantV1["workflow"]
  readonly schedule: ResolvedStandupRunGrantV1["schedule"]
  readonly councilRefs: ResolvedStandupRunGrantV1["councilRefs"]
  readonly microEmployeeLabel: string
  readonly jobLabel: string
  readonly workflowLabel: string
  readonly scheduleLabel: string
  readonly actorKind: "system"
  readonly subject: string
  readonly messageVersion: string
  readonly message: string
  readonly publishedAt: string
}>

/** The child page is always prepared as Loro v1 and linked to its immutable source publication. */
export type StandupPublicationCompanionLinkV1 = Readonly<{
  readonly version: typeof STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION
  readonly publicationId: string
  readonly workspaceId: string
  readonly dailyNoteId: string
  readonly civilDate: string
  readonly childNodeId: string
  readonly format: typeof STANDUP_PUBLICATION_COMPANION_FORMAT
  readonly originalTextDigest: string
  readonly contentDigest: string
  readonly contentByteLength: number
  readonly preparedDescriptor: string
}>

/**
 * The transaction-owned Loro-v1 companion payload. `contentUtf8` contains exact serialized page
 * content, while its digest and byte count make later replay/restore validation deterministic.
 * It is private durable content; grants, bearer tokens, labels, and subjects are absent.
 */
export type StandupPublicationCompanionPageV1 = Readonly<{
  readonly version: typeof STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION
  readonly publicationId: string
  readonly workspaceId: string
  readonly dailyNoteId: string
  readonly civilDate: string
  readonly childNodeId: string
  readonly format: typeof STANDUP_PUBLICATION_COMPANION_FORMAT
  readonly originalTextDigest: string
  readonly contentUtf8: string
  readonly contentDigest: string
  readonly contentByteLength: number
  readonly preparedDescriptor: string
}>

/** Adapter-private material that may contain serialized page content but never a grant bearer. */
export type PreparedStandupCompanionPage = Readonly<{
  readonly format: typeof STANDUP_PUBLICATION_COMPANION_FORMAT
  readonly childNodeId: string
  readonly originalTextDigest: string
  readonly preparedDescriptor: string
  readonly contentUtf8: string
  readonly contentDigest: string
  readonly contentByteLength: number
}>

/** Immutable causal record; no delivery status, attempts, token, text, labels, or subject. */
export type StandupPublicationEventV1 = Readonly<{
  readonly version: typeof STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION
  readonly eventType: typeof STANDUP_PUBLICATION_EVENT_TYPE
  readonly eventId: string
  readonly requestIdentity: string
  readonly publicationId: string
  readonly childNodeId: string
  readonly dailyNoteId: string
  readonly slotDigest: string
  readonly occurredAt: string
}>

/** Delivery state deliberately lives outside this immutable intent in later integration work. */
export type StandupPublicationOutboxIntentV1 = Readonly<{
  readonly version: typeof STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION
  readonly consumer: typeof STANDUP_PUBLICATION_OUTBOX_CONSUMER
  readonly outboxId: string
  readonly eventId: string
  readonly requestIdentity: string
  readonly publicationId: string
  readonly childNodeId: string
  readonly dailyNoteId: string
  readonly slotDigest: string
  readonly occurredAt: string
}>

export type StandupPublicationGrantConsumptionV1 = Readonly<{
  readonly grantId: string
  readonly grantRecordDigest: string
  readonly consumedAt: string
}>

export interface StandupPublicationCompanionAdapter {
  readonly prepare: (input: Readonly<{
    readonly childNodeId: string
    readonly originalText: string
    readonly originalTextDigest: string
  }>) => PreparedStandupCompanionPage
  readonly restore: (input: Readonly<{
    readonly publication: StandupPublicationRecordV1
    readonly link: StandupPublicationCompanionLinkV1
    readonly page: StandupPublicationCompanionPageV1
  }>) => PreparedStandupCompanionPage
  /** Must be synchronous. It is invoked only after the authority transaction commits. */
  readonly publishAfterCommit: (prepared: PreparedStandupCompanionPage) => void
}

export interface StandupPublicationAuthorityTransaction {
  readonly committedRequestFor: (slotDigest: string) => StandupPublicationAuthorityRequestV1 | undefined
  readonly publicationFor: (publicationId: string) => StandupPublicationRecordV1 | undefined
  readonly companionFor: (publicationId: string) => StandupPublicationCompanionLinkV1 | undefined
  readonly companionPageFor: (publicationId: string) => StandupPublicationCompanionPageV1 | undefined
  readonly grantConsumed: (grantId: string) => boolean
  readonly stageGrantConsumption: (value: StandupPublicationGrantConsumptionV1) => void
  readonly stagePublication: (value: StandupPublicationRecordV1) => void
  readonly stageCompanionPage: (value: StandupPublicationCompanionPageV1) => void
  readonly stageCompanion: (value: StandupPublicationCompanionLinkV1) => void
  readonly stageAuthorityRequest: (value: StandupPublicationAuthorityRequestV1) => void
  readonly stageEvent: (value: StandupPublicationEventV1) => void
  readonly stageOutboxIntent: (value: StandupPublicationOutboxIntentV1) => void
}

export interface StandupPublicationAuthorityStore {
  readonly transactionSync: <T>(callback: (transaction: StandupPublicationAuthorityTransaction) => T) => T
}

/** A read-only projection of the private authority records used by workspace clients. */
export type StandupPublicationAuthorityRead = Readonly<{
  readonly publication: StandupPublicationRecordV1
  readonly companion: StandupPublicationCompanionLinkV1
  readonly companionPage: StandupPublicationCompanionPageV1
}>

export interface StandupPublicationAuthorityReader {
  readonly listPublicationsByDailyNote: (
    workspaceId: string,
    dailyNoteId: string
  ) => ReadonlyArray<StandupPublicationAuthorityRead>
}

type StoreState = {
  readonly requestsBySlot: Record<string, StandupPublicationAuthorityRequestV1>
  readonly publicationsById: Record<string, StandupPublicationRecordV1>
  readonly companionsByPublication: Record<string, StandupPublicationCompanionLinkV1>
  readonly companionPagesByPublication: Record<string, StandupPublicationCompanionPageV1>
  readonly eventsById: Record<string, StandupPublicationEventV1>
  readonly outboxById: Record<string, StandupPublicationOutboxIntentV1>
  readonly grantConsumptionsById: Record<string, StandupPublicationGrantConsumptionV1>
}

const emptyState = (): StoreState => ({
  requestsBySlot: Object.create(null) as Record<string, StandupPublicationAuthorityRequestV1>,
  publicationsById: Object.create(null) as Record<string, StandupPublicationRecordV1>,
  companionsByPublication: Object.create(null) as Record<string, StandupPublicationCompanionLinkV1>,
  companionPagesByPublication: Object.create(null) as Record<string, StandupPublicationCompanionPageV1>,
  eventsById: Object.create(null) as Record<string, StandupPublicationEventV1>,
  outboxById: Object.create(null) as Record<string, StandupPublicationOutboxIntentV1>,
  grantConsumptionsById: Object.create(null) as Record<string, StandupPublicationGrantConsumptionV1>
})

const copyState = (state: StoreState): StoreState => ({
  requestsBySlot: { ...state.requestsBySlot },
  publicationsById: { ...state.publicationsById },
  companionsByPublication: { ...state.companionsByPublication },
  companionPagesByPublication: { ...state.companionPagesByPublication },
  eventsById: { ...state.eventsById },
  outboxById: { ...state.outboxById },
  grantConsumptionsById: { ...state.grantConsumptionsById }
})

const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze({ ...value })

const assertReceipt = (value: StandupPublicationAuthorityRequestV1): StandupPublicationAuthorityRequestV1 => {
  if (
    value.version !== STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION ||
    value.receipt.version !== STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION ||
    value.receipt.requestIdentity !== value.requestIdentity ||
    value.receipt.custodyFingerprint !== value.custodyFingerprint
  ) throw new Error("corrupt standup publication authority receipt")
  return value
}

class MemoryAuthorityTransaction implements StandupPublicationAuthorityTransaction {
  constructor(private readonly state: StoreState) {}

  committedRequestFor(slotDigest: string): StandupPublicationAuthorityRequestV1 | undefined {
    const value = this.state.requestsBySlot[slotDigest]
    return value === undefined ? undefined : assertReceipt(value)
  }

  publicationFor(publicationId: string): StandupPublicationRecordV1 | undefined {
    return this.state.publicationsById[publicationId]
  }

  companionFor(publicationId: string): StandupPublicationCompanionLinkV1 | undefined {
    return this.state.companionsByPublication[publicationId]
  }

  companionPageFor(publicationId: string): StandupPublicationCompanionPageV1 | undefined {
    return this.state.companionPagesByPublication[publicationId]
  }

  grantConsumed(grantId: string): boolean {
    return this.state.grantConsumptionsById[grantId] !== undefined
  }

  stageGrantConsumption(value: StandupPublicationGrantConsumptionV1): void {
    if (this.grantConsumed(value.grantId)) throw new Error("standup run grant was already consumed")
    this.state.grantConsumptionsById[value.grantId] = freeze(value)
  }

  stagePublication(value: StandupPublicationRecordV1): void {
    if (this.state.publicationsById[value.publicationId] !== undefined) throw new Error("standup publication already exists")
    this.state.publicationsById[value.publicationId] = freeze(value)
  }

  stageCompanionPage(value: StandupPublicationCompanionPageV1): void {
    if (this.state.companionPagesByPublication[value.publicationId] !== undefined) throw new Error("standup publication companion page already exists")
    this.state.companionPagesByPublication[value.publicationId] = freeze(value)
  }

  stageCompanion(value: StandupPublicationCompanionLinkV1): void {
    if (this.state.companionsByPublication[value.publicationId] !== undefined) throw new Error("standup publication companion already exists")
    this.state.companionsByPublication[value.publicationId] = freeze(value)
  }

  stageAuthorityRequest(value: StandupPublicationAuthorityRequestV1): void {
    if (this.state.requestsBySlot[value.slotDigest] !== undefined) throw new Error("standup publication authority request already exists")
    this.state.requestsBySlot[value.slotDigest] = freeze(value)
  }

  stageEvent(value: StandupPublicationEventV1): void {
    if (this.state.eventsById[value.eventId] !== undefined) throw new Error("standup publication event already exists")
    this.state.eventsById[value.eventId] = freeze(value)
  }

  stageOutboxIntent(value: StandupPublicationOutboxIntentV1): void {
    if (this.state.outboxById[value.outboxId] !== undefined) throw new Error("standup publication outbox intent already exists")
    this.state.outboxById[value.outboxId] = freeze(value)
  }
}

/**
 * Testable dormant-store adapter. No production runtime root constructs this class; eventual DO
 * integration must replace it with one synchronous same-storage transaction implementation.
 */
export class InMemoryStandupPublicationAuthorityStore implements StandupPublicationAuthorityStore {
  #state: StoreState

  constructor(initial?: Partial<StoreState>) {
    this.#state = {
      ...emptyState(),
      ...initial,
      requestsBySlot: { ...(initial?.requestsBySlot ?? {}) },
      publicationsById: { ...(initial?.publicationsById ?? {}) },
      companionsByPublication: { ...(initial?.companionsByPublication ?? {}) },
      companionPagesByPublication: { ...(initial?.companionPagesByPublication ?? {}) },
      eventsById: { ...(initial?.eventsById ?? {}) },
      outboxById: { ...(initial?.outboxById ?? {}) },
      grantConsumptionsById: { ...(initial?.grantConsumptionsById ?? {}) }
    }
  }

  transactionSync<T>(callback: (transaction: StandupPublicationAuthorityTransaction) => T): T {
    const staged = copyState(this.#state)
    const result = assertSynchronousResult(callback(new MemoryAuthorityTransaction(staged)), "standup publication authority transaction")
    this.#state = staged
    return result
  }

  snapshot(): Readonly<StoreState> {
    return Object.freeze(copyState(this.#state))
  }

  listPublicationsByDailyNote(workspaceId: string, dailyNoteId: string): ReadonlyArray<StandupPublicationAuthorityRead> {
    return Object.values(this.#state.publicationsById)
      .filter((publication) => publication.workspaceId === workspaceId && publication.dailyNoteId === dailyNoteId)
      .sort((left, right) => left.publishedAt.localeCompare(right.publishedAt) || left.publicationId.localeCompare(right.publicationId))
      .map((publication) => {
        const companion = this.#state.companionsByPublication[publication.publicationId]
        const companionPage = this.#state.companionPagesByPublication[publication.publicationId]
        if (companion === undefined || companionPage === undefined) throw new Error("corrupt committed private standup publication")
        return { publication, companion, companionPage }
      })
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const parseStored = <T>(value: string, label: string): T => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`corrupt stored ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)) throw new Error(`corrupt stored ${label}`)
  return parsed as T
}

const nonBlankStored = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`corrupt stored standup publication: ${field}`)
  return value
}

const nonEmptyStored = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`corrupt stored standup publication: ${field}`)
  return value
}

const storedField = (value: object, field: string): unknown => (value as Record<string, unknown>)[field]

const exactReference = (value: unknown, kind: string, field: string): void => {
  if (!isRecord(value) || value.kind !== kind) throw new Error(`corrupt stored standup publication: ${field}`)
  nonBlankStored(value.id, `${field}.id`)
  nonBlankStored(value.version, `${field}.version`)
}

const assertStoredPublication = (value: StandupPublicationRecordV1): StandupPublicationRecordV1 => {
  if (!isRecord(value) || value.version !== STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION || value.actorKind !== "system") {
    throw new Error("corrupt stored standup publication")
  }
  for (const field of [
    "publicationId", "childNodeId", "workspaceId", "dailyNoteId", "civilDate", "slotDigest",
    "originalTextDigest", "microEmployeeLabel", "jobLabel", "workflowLabel", "scheduleLabel", "subject",
    "messageVersion", "publishedAt"
  ]) nonBlankStored(storedField(value, field), field)
  nonEmptyStored(value.originalText, "originalText")
  nonEmptyStored(value.message, "message")
  if (!Number.isSafeInteger(value.originalTextByteLength) || value.originalTextByteLength < 0) throw new Error("corrupt stored standup publication: originalTextByteLength")
  exactReference(value.microEmployee, "microEmployee", "microEmployee")
  exactReference(value.job, "job", "job")
  exactReference(value.workflow, "workflow", "workflow")
  exactReference(value.schedule, "schedule", "schedule")
  if (!Array.isArray(value.councilRefs)) throw new Error("corrupt stored standup publication: councilRefs")
  value.councilRefs.forEach((entry, index) => exactReference(entry, "council", `councilRefs[${index}]`))
  return value
}

const assertStoredCompanion = (
  value: StandupPublicationCompanionLinkV1,
  label: string
): StandupPublicationCompanionLinkV1 => {
  if (!isRecord(value) || value.version !== STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION || value.format !== STANDUP_PUBLICATION_COMPANION_FORMAT) {
    throw new Error(`corrupt stored standup publication ${label}`)
  }
  for (const field of [
    "publicationId", "workspaceId", "dailyNoteId", "civilDate", "childNodeId", "originalTextDigest",
    "contentDigest", "preparedDescriptor"
  ]) nonBlankStored(storedField(value, field), `${label}.${field}`)
  if (!Number.isSafeInteger(value.contentByteLength) || value.contentByteLength < 0) throw new Error(`corrupt stored standup publication ${label}: contentByteLength`)
  return value
}

const assertStoredCompanionPage = (
  value: StandupPublicationCompanionPageV1,
  label: string
): StandupPublicationCompanionPageV1 => {
  if (!isRecord(value) || value.version !== STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION || value.format !== STANDUP_PUBLICATION_COMPANION_FORMAT) {
    throw new Error(`corrupt stored standup publication ${label}`)
  }
  for (const field of [
    "publicationId", "workspaceId", "dailyNoteId", "civilDate", "childNodeId", "originalTextDigest",
    "contentDigest", "preparedDescriptor"
  ]) nonBlankStored(storedField(value, field), `${label}.${field}`)
  nonEmptyStored(value.contentUtf8, `${label}.contentUtf8`)
  if (!Number.isSafeInteger(value.contentByteLength) || value.contentByteLength < 0) throw new Error(`corrupt stored standup publication ${label}: contentByteLength`)
  return value
}

const assertStoredRequest = (value: StandupPublicationAuthorityRequestV1): StandupPublicationAuthorityRequestV1 => {
  if (!isRecord(value) || value.version !== STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION) throw new Error("corrupt stored standup publication authority request")
  for (const field of ["slotDigest", "requestIdentity", "custodyFingerprint", "grantRecordDigest", "grantId", "replayAudience", "subject"]) nonBlankStored(storedField(value, field), field)
  return assertReceipt(value)
}

const assertStoredGrantConsumption = (value: StandupPublicationGrantConsumptionV1): StandupPublicationGrantConsumptionV1 => {
  for (const field of ["grantId", "grantRecordDigest", "consumedAt"]) nonBlankStored(storedField(value, field), field)
  return value
}

const assertStoredEvent = (value: StandupPublicationEventV1): StandupPublicationEventV1 => {
  if (!isRecord(value) || value.version !== STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION || value.eventType !== STANDUP_PUBLICATION_EVENT_TYPE) throw new Error("corrupt stored standup publication event")
  for (const field of ["eventId", "requestIdentity", "publicationId", "childNodeId", "dailyNoteId", "slotDigest", "occurredAt"]) nonBlankStored(storedField(value, field), field)
  return value
}

const assertStoredOutbox = (value: StandupPublicationOutboxIntentV1): StandupPublicationOutboxIntentV1 => {
  if (!isRecord(value) || value.version !== STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION || value.consumer !== STANDUP_PUBLICATION_OUTBOX_CONSUMER) throw new Error("corrupt stored standup publication outbox intent")
  for (const field of ["outboxId", "eventId", "requestIdentity", "publicationId", "childNodeId", "dailyNoteId", "slotDigest", "occurredAt"]) nonBlankStored(storedField(value, field), field)
  return value
}

/**
 * Durable authority adapter for the Workspace Durable Object. Every stage writes through the
 * same synchronous DO transaction as the caller; the SQL primary/unique keys are the authority
 * for replay and one-use constraints, rather than a read-then-write convention.
 */
export class DurableStandupPublicationAuthorityStore implements StandupPublicationAuthorityStore, StandupPublicationAuthorityReader {
  constructor(private readonly storage: DurableObjectStorage, private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS standup_publication_requests (
      slotDigest TEXT PRIMARY KEY, requestIdentity TEXT NOT NULL UNIQUE, publicationId TEXT NOT NULL UNIQUE,
      grantId TEXT NOT NULL UNIQUE, value TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS standup_publications (
      publicationId TEXT PRIMARY KEY, workspaceId TEXT NOT NULL, dailyNoteId TEXT NOT NULL,
      publishedAt TEXT NOT NULL, slotDigest TEXT NOT NULL UNIQUE, value TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS standup_publication_companions (
      publicationId TEXT PRIMARY KEY, value TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS standup_publication_companion_pages (
      publicationId TEXT PRIMARY KEY, value TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS standup_publication_grants (
      grantId TEXT PRIMARY KEY, value TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS standup_publication_events (
      eventId TEXT PRIMARY KEY, requestIdentity TEXT NOT NULL UNIQUE, value TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS standup_publication_outbox (
      outboxId TEXT PRIMARY KEY, eventId TEXT NOT NULL UNIQUE, value TEXT NOT NULL
    )`)
    sql.exec(`CREATE INDEX IF NOT EXISTS standup_publications_daily_note
      ON standup_publications (workspaceId, dailyNoteId, publishedAt, publicationId)`)
  }

  transactionSync<T>(callback: (transaction: StandupPublicationAuthorityTransaction) => T): T {
    return this.storage.transactionSync(() => callback(new DurableAuthorityTransaction(this.sql)))
  }

  listPublicationsByDailyNote(workspaceId: string, dailyNoteId: string): ReadonlyArray<StandupPublicationAuthorityRead> {
    const rows = this.sql.exec<{
      publicationValue: string
      publicationRowId: string
      publicationWorkspaceId: string
      publicationDailyNoteId: string
      publicationPublishedAt: string
      publicationSlotDigest: string
      companionRowId: string | null
      companionValue: string | null
      companionPageRowId: string | null
      companionPageValue: string | null
      requestRowId: string | null
      requestSlotDigest: string | null
      requestValue: string | null
    }>(
      `SELECT p.value AS publicationValue, p.publicationId AS publicationRowId,
              p.workspaceId AS publicationWorkspaceId,
              p.dailyNoteId AS publicationDailyNoteId, p.publishedAt AS publicationPublishedAt,
              p.slotDigest AS publicationSlotDigest, c.publicationId AS companionRowId,
              c.value AS companionValue, cp.publicationId AS companionPageRowId,
              cp.value AS companionPageValue, r.publicationId AS requestRowId,
              r.slotDigest AS requestSlotDigest, r.value AS requestValue
       FROM standup_publications p
       LEFT JOIN standup_publication_companions c ON c.publicationId = p.publicationId
       LEFT JOIN standup_publication_companion_pages cp ON cp.publicationId = p.publicationId
       LEFT JOIN standup_publication_requests r ON r.publicationId = p.publicationId
       WHERE p.workspaceId = ? AND p.dailyNoteId = ?
       ORDER BY p.publishedAt ASC, p.publicationId ASC`,
      workspaceId,
      dailyNoteId
    ).toArray()
    return rows.map((row) => {
      const publication = assertStoredPublication(parseStored<StandupPublicationRecordV1>(row.publicationValue, "standup publication"))
      if (
        row.publicationRowId !== publication.publicationId ||
        row.publicationWorkspaceId !== publication.workspaceId ||
        row.publicationDailyNoteId !== publication.dailyNoteId ||
        row.publicationPublishedAt !== publication.publishedAt ||
        row.publicationSlotDigest !== publication.slotDigest ||
        row.companionRowId === null || row.companionPageRowId === null ||
        row.companionValue === null || row.companionPageValue === null ||
        row.requestRowId === null || row.requestSlotDigest === null || row.requestValue === null ||
        row.companionRowId !== publication.publicationId || row.companionPageRowId !== publication.publicationId
      ) throw new Error("corrupt committed private standup publication")
      const request = assertStoredRequest(parseStored<StandupPublicationAuthorityRequestV1>(row.requestValue, "standup publication authority request"))
      if (
        row.requestRowId !== publication.publicationId ||
        row.requestSlotDigest !== publication.slotDigest ||
        request.slotDigest !== publication.slotDigest ||
        request.receipt.output.publicationId !== publication.publicationId ||
        request.receipt.output.dailyNoteId !== publication.dailyNoteId ||
        request.receipt.output.civilDate !== publication.civilDate ||
        request.receipt.output.childNodeId !== publication.childNodeId ||
        request.receipt.output.companionFormat !== STANDUP_PUBLICATION_COMPANION_FORMAT ||
        request.receipt.committedAt !== publication.publishedAt
      ) throw new Error("corrupt committed private standup publication receipt")
      const companion = assertStoredCompanion(parseStored<StandupPublicationCompanionLinkV1>(row.companionValue, "standup publication companion"), "companion")
      const companionPage = assertStoredCompanionPage(parseStored<StandupPublicationCompanionPageV1>(row.companionPageValue, "standup publication companion page"), "companion page")
      if (
        companion.publicationId !== publication.publicationId || companionPage.publicationId !== publication.publicationId ||
        companion.workspaceId !== publication.workspaceId || companionPage.workspaceId !== publication.workspaceId ||
        companion.dailyNoteId !== publication.dailyNoteId || companionPage.dailyNoteId !== publication.dailyNoteId ||
        companion.civilDate !== publication.civilDate || companionPage.civilDate !== publication.civilDate ||
        companion.childNodeId !== publication.childNodeId || companionPage.childNodeId !== publication.childNodeId ||
        companion.originalTextDigest !== publication.originalTextDigest || companionPage.originalTextDigest !== publication.originalTextDigest ||
        companion.contentDigest !== companionPage.contentDigest || companion.contentByteLength !== companionPage.contentByteLength ||
        companion.preparedDescriptor !== companionPage.preparedDescriptor ||
        companionPage.contentUtf8 !== publication.originalText || companionPage.contentDigest !== publication.originalTextDigest ||
        companionPage.contentByteLength !== publication.originalTextByteLength ||
        (() => {
          try {
            const canonical = canonicalStandupPublicationText(companionPage.contentUtf8)
            return canonical.sha256 !== companionPage.contentDigest || canonical.byteLength !== companionPage.contentByteLength
          } catch {
            return true
          }
        })()
      ) throw new Error("corrupt committed private standup publication")
      return { publication, companion, companionPage }
    })
  }
}

class DurableAuthorityTransaction implements StandupPublicationAuthorityTransaction {
  constructor(private readonly sql: SqlStorage) {}

  committedRequestFor(slotDigest: string): StandupPublicationAuthorityRequestV1 | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM standup_publication_requests WHERE slotDigest = ?", slotDigest).toArray()[0]
    return row === undefined ? undefined : assertStoredRequest(parseStored<StandupPublicationAuthorityRequestV1>(row.value, "standup publication authority request"))
  }

  publicationFor(publicationId: string): StandupPublicationRecordV1 | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM standup_publications WHERE publicationId = ?", publicationId).toArray()[0]
    return row === undefined ? undefined : assertStoredPublication(parseStored<StandupPublicationRecordV1>(row.value, "standup publication"))
  }

  companionFor(publicationId: string): StandupPublicationCompanionLinkV1 | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM standup_publication_companions WHERE publicationId = ?", publicationId).toArray()[0]
    return row === undefined ? undefined : assertStoredCompanion(parseStored<StandupPublicationCompanionLinkV1>(row.value, "standup publication companion"), "companion")
  }

  companionPageFor(publicationId: string): StandupPublicationCompanionPageV1 | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM standup_publication_companion_pages WHERE publicationId = ?", publicationId).toArray()[0]
    return row === undefined ? undefined : assertStoredCompanionPage(parseStored<StandupPublicationCompanionPageV1>(row.value, "standup publication companion page"), "companion page")
  }

  grantConsumed(grantId: string): boolean {
    return this.sql.exec("SELECT grantId FROM standup_publication_grants WHERE grantId = ?", grantId).toArray().length > 0
  }

  stageGrantConsumption(value: StandupPublicationGrantConsumptionV1): void {
    assertStoredGrantConsumption(value)
    this.sql.exec("INSERT INTO standup_publication_grants (grantId, value) VALUES (?, ?)", value.grantId, JSON.stringify(value))
  }

  stagePublication(value: StandupPublicationRecordV1): void {
    assertStoredPublication(value)
    this.sql.exec("INSERT INTO standup_publications (publicationId, workspaceId, dailyNoteId, publishedAt, slotDigest, value) VALUES (?, ?, ?, ?, ?, ?)", value.publicationId, value.workspaceId, value.dailyNoteId, value.publishedAt, value.slotDigest, JSON.stringify(value))
  }

  stageCompanionPage(value: StandupPublicationCompanionPageV1): void {
    assertStoredCompanionPage(value, "companion page")
    this.sql.exec("INSERT INTO standup_publication_companion_pages (publicationId, value) VALUES (?, ?)", value.publicationId, JSON.stringify(value))
  }

  stageCompanion(value: StandupPublicationCompanionLinkV1): void {
    assertStoredCompanion(value, "companion")
    this.sql.exec("INSERT INTO standup_publication_companions (publicationId, value) VALUES (?, ?)", value.publicationId, JSON.stringify(value))
  }

  stageAuthorityRequest(value: StandupPublicationAuthorityRequestV1): void {
    assertStoredRequest(value)
    this.sql.exec("INSERT INTO standup_publication_requests (slotDigest, requestIdentity, publicationId, grantId, value) VALUES (?, ?, ?, ?, ?)", value.slotDigest, value.requestIdentity, value.receipt.output.publicationId, value.grantId, JSON.stringify(value))
  }

  stageEvent(value: StandupPublicationEventV1): void {
    assertStoredEvent(value)
    this.sql.exec("INSERT INTO standup_publication_events (eventId, requestIdentity, value) VALUES (?, ?, ?)", value.eventId, value.requestIdentity, JSON.stringify(value))
  }

  stageOutboxIntent(value: StandupPublicationOutboxIntentV1): void {
    assertStoredOutbox(value)
    this.sql.exec("INSERT INTO standup_publication_outbox (outboxId, eventId, value) VALUES (?, ?, ?)", value.outboxId, value.eventId, JSON.stringify(value))
  }
}

export const privatePublicationRecord = (intent: StandupPublicationPrivateIntentV1, publishedAt: string): StandupPublicationRecordV1 => freeze({
  version: STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION,
  publicationId: intent.publicationId,
  childNodeId: intent.childNodeId,
  workspaceId: intent.grant.workspaceId,
  dailyNoteId: intent.grant.dailyNoteId,
  civilDate: intent.grant.civilDate,
  slotDigest: intent.slotDigest,
  originalText: intent.originalText,
  originalTextDigest: intent.originalTextDigest,
  originalTextByteLength: intent.originalTextByteLength,
  microEmployee: intent.grant.microEmployee,
  job: intent.grant.job,
  workflow: intent.grant.workflow,
  schedule: intent.grant.schedule,
  councilRefs: intent.grant.councilRefs,
  microEmployeeLabel: intent.grant.microEmployeeLabel,
  jobLabel: intent.grant.jobLabel,
  workflowLabel: intent.grant.workflowLabel,
  scheduleLabel: intent.grant.scheduleLabel,
  actorKind: intent.grant.actorKind,
  subject: intent.grant.subject,
  messageVersion: intent.messageVersion,
  message: intent.message,
  publishedAt
})

export const privateCompanionPage = (intent: StandupPublicationPrivateIntentV1, prepared: PreparedStandupCompanionPage): StandupPublicationCompanionPageV1 => freeze({
  version: STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION,
  publicationId: intent.publicationId,
  workspaceId: intent.grant.workspaceId,
  dailyNoteId: intent.grant.dailyNoteId,
  civilDate: intent.grant.civilDate,
  childNodeId: intent.childNodeId,
  format: STANDUP_PUBLICATION_COMPANION_FORMAT,
  originalTextDigest: intent.originalTextDigest,
  contentUtf8: prepared.contentUtf8,
  contentDigest: prepared.contentDigest,
  contentByteLength: prepared.contentByteLength,
  preparedDescriptor: prepared.preparedDescriptor
})

export const privateCompanionLink = (intent: StandupPublicationPrivateIntentV1, page: StandupPublicationCompanionPageV1): StandupPublicationCompanionLinkV1 => freeze({
  version: STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION,
  publicationId: intent.publicationId,
  workspaceId: intent.grant.workspaceId,
  dailyNoteId: intent.grant.dailyNoteId,
  civilDate: intent.grant.civilDate,
  childNodeId: intent.childNodeId,
  format: STANDUP_PUBLICATION_COMPANION_FORMAT,
  originalTextDigest: intent.originalTextDigest,
  contentDigest: page.contentDigest,
  contentByteLength: page.contentByteLength,
  preparedDescriptor: page.preparedDescriptor
})
