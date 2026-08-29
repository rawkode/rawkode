import {
  STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION,
  assertSynchronousResult,
  type PublishStandupPublicationOutputV1,
  type ResolvedStandupRunGrantV1,
  type StandupPublicationPrivateIntentV1
} from "./standup-publication-private-contract.js"

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
