import { canonicalStandupPublicationText, canonicalWorkforceValueV1 } from "@athenaeum/domain"
import {
  STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION,
  assertSynchronousResult,
  privatePublicationOutput,
  resolvePrivatePublicationIntent,
  type OpaqueStandupRunGrantToken,
  type PublishStandupPublicationOutputV1,
  type PublishStandupPublicationRequestV1,
  type StandupPublicationPrivateIntentV1,
  type StandupRunGrantResolver
} from "./standup-publication-private-contract.js"
import {
  STANDUP_PUBLICATION_EVENT_TYPE,
  STANDUP_PUBLICATION_OUTBOX_CONSUMER,
  privateCompanionLink,
  privateCompanionPage,
  privatePublicationRecord,
  type PreparedStandupCompanionPage,
  type StandupPublicationAuthorityRequestV1,
  type StandupPublicationAuthorityStore,
  type StandupPublicationAuthorityTransaction,
  type StandupPublicationCompanionAdapter,
  type StandupPublicationCompanionLinkV1,
  type StandupPublicationCompanionPageV1,
  type StandupPublicationEventV1,
  type StandupPublicationOutboxIntentV1,
  type StandupPublicationRecordV1,
  type StandupPublicationReceiptV1
} from "./standup-publication-collections.js"

export type StandupPublicationPrivateStage =
  | "after-grant-consumption"
  | "after-publication"
  | "after-companion-page"
  | "after-companion"
  | "after-receipt"
  | "after-event"
  | "after-outbox"

export class StandupPublicationGrantDeniedError extends Error {
  constructor() { super("private standup run grant was not admitted") }
}

export class StandupPublicationConflictError extends Error {
  constructor() { super("private standup publication request conflicts with an immutable receipt") }
}

/** Durable work succeeded; the caller may replay the exact request to retry cache publication. */
export class StandupPublicationPostCommitError extends Error {
  constructor(cause: unknown) {
    super(`standup publication committed but cache publication did not complete: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

export interface StandupPublicationPrivateClock {
  readonly now: () => string
}

export interface StandupPublicationPrivateDependencies {
  readonly resolver: StandupRunGrantResolver
  readonly store: StandupPublicationAuthorityStore
  readonly companion: StandupPublicationCompanionAdapter
  readonly clock: StandupPublicationPrivateClock
  /** Test-only dependency injection; no runtime root passes a failpoint. */
  readonly failpoint?: (stage: StandupPublicationPrivateStage) => void
}

export type CommittedPublication = Readonly<{
  readonly receipt: StandupPublicationReceiptV1
  readonly prepared: PreparedStandupCompanionPage | undefined
}>

const exactPrepared = (value: unknown, expected: Readonly<{
  readonly childNodeId: string
  readonly originalTextDigest: string
  readonly preparedDescriptor?: string
  readonly contentUtf8?: string
  readonly contentDigest?: string
  readonly contentByteLength?: number
}>): PreparedStandupCompanionPage => {
  const prepared = assertSynchronousResult(value, "standup companion adapter")
  if (
    prepared === null || typeof prepared !== "object" || Array.isArray(prepared) ||
    (prepared as PreparedStandupCompanionPage).format !== "loro-v1" ||
    (prepared as PreparedStandupCompanionPage).childNodeId !== expected.childNodeId ||
    (prepared as PreparedStandupCompanionPage).originalTextDigest !== expected.originalTextDigest ||
    typeof (prepared as PreparedStandupCompanionPage).preparedDescriptor !== "string" ||
    typeof (prepared as PreparedStandupCompanionPage).contentUtf8 !== "string" ||
    typeof (prepared as PreparedStandupCompanionPage).contentDigest !== "string" ||
    !Number.isSafeInteger((prepared as PreparedStandupCompanionPage).contentByteLength) ||
    (prepared as PreparedStandupCompanionPage).contentByteLength < 0 ||
    (expected.preparedDescriptor !== undefined && (prepared as PreparedStandupCompanionPage).preparedDescriptor !== expected.preparedDescriptor) ||
    (expected.contentUtf8 !== undefined && (prepared as PreparedStandupCompanionPage).contentUtf8 !== expected.contentUtf8) ||
    (expected.contentDigest !== undefined && (prepared as PreparedStandupCompanionPage).contentDigest !== expected.contentDigest) ||
    (expected.contentByteLength !== undefined && (prepared as PreparedStandupCompanionPage).contentByteLength !== expected.contentByteLength)
  ) throw new TypeError("standup companion adapter returned an invalid prepared Loro v1 page")
  const typed = prepared as PreparedStandupCompanionPage
  const canonical = canonicalStandupPublicationText(typed.contentUtf8)
  if (canonical.sha256 !== typed.contentDigest || canonical.byteLength !== typed.contentByteLength) {
    throw new TypeError("standup companion adapter returned content whose digest or byte length is invalid")
  }
  return typed
}

const sameCanonicalValue = (actual: unknown, expected: unknown): boolean => {
  try {
    return canonicalWorkforceValueV1(actual as never) === canonicalWorkforceValueV1(expected as never)
  } catch {
    return false
  }
}

const outputKeys = ["version", "publicationId", "dailyNoteId", "civilDate", "childNodeId", "companionFormat"] as const

const isExactOutput = (value: unknown, expected: PublishStandupPublicationOutputV1): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const actual = value as Record<string, unknown>
  const keys = Reflect.ownKeys(actual)
  return keys.length === outputKeys.length && outputKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(actual, key)
    return descriptor !== undefined && "value" in descriptor && descriptor.value === expected[key]
  })
}

const assertDurableCompanion = (
  intent: StandupPublicationPrivateIntentV1,
  publication: StandupPublicationRecordV1,
  link: StandupPublicationCompanionLinkV1,
  page: StandupPublicationCompanionPageV1
): void => {
  const expectedPublication = privatePublicationRecord(intent, canonicalNow(publication.publishedAt))
  if (
    !sameCanonicalValue(publication, expectedPublication) ||
    link.version !== STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION ||
    page.version !== STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION ||
    link.publicationId !== intent.publicationId ||
    page.publicationId !== intent.publicationId ||
    link.workspaceId !== intent.grant.workspaceId ||
    page.workspaceId !== intent.grant.workspaceId ||
    link.dailyNoteId !== intent.grant.dailyNoteId ||
    page.dailyNoteId !== intent.grant.dailyNoteId ||
    link.civilDate !== intent.grant.civilDate ||
    page.civilDate !== intent.grant.civilDate ||
    link.childNodeId !== intent.childNodeId ||
    page.childNodeId !== intent.childNodeId ||
    link.format !== "loro-v1" ||
    page.format !== "loro-v1" ||
    link.originalTextDigest !== intent.originalTextDigest ||
    page.originalTextDigest !== intent.originalTextDigest ||
    link.contentDigest !== page.contentDigest ||
    link.contentByteLength !== page.contentByteLength ||
    (() => {
      try {
        const canonical = canonicalStandupPublicationText(page.contentUtf8)
        return canonical.sha256 !== page.contentDigest || canonical.byteLength !== page.contentByteLength
      } catch {
        return true
      }
    })() ||
    link.preparedDescriptor !== page.preparedDescriptor
  ) throw new Error("corrupt durable private standup companion page or link")
}

const canonicalNow = (value: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) throw new TypeError("standup publication clock must return a canonical ISO instant")
  return value
}

const eventFor = (intent: StandupPublicationPrivateIntentV1, occurredAt: string): StandupPublicationEventV1 => Object.freeze({
  version: STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION,
  eventType: STANDUP_PUBLICATION_EVENT_TYPE,
  eventId: `standup-publication-event:${intent.requestIdentity}`,
  requestIdentity: intent.requestIdentity,
  publicationId: intent.publicationId,
  childNodeId: intent.childNodeId,
  dailyNoteId: intent.grant.dailyNoteId,
  slotDigest: intent.slotDigest,
  occurredAt
})

const outboxFor = (intent: StandupPublicationPrivateIntentV1, event: StandupPublicationEventV1): StandupPublicationOutboxIntentV1 => Object.freeze({
  version: STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION,
  consumer: STANDUP_PUBLICATION_OUTBOX_CONSUMER,
  outboxId: `standup-publication-outbox:${intent.requestIdentity}:${STANDUP_PUBLICATION_OUTBOX_CONSUMER}`,
  eventId: event.eventId,
  requestIdentity: intent.requestIdentity,
  publicationId: intent.publicationId,
  childNodeId: intent.childNodeId,
  dailyNoteId: intent.grant.dailyNoteId,
  slotDigest: intent.slotDigest,
  occurredAt: event.occurredAt
})

const receiptFor = (intent: StandupPublicationPrivateIntentV1, committedAt: string): StandupPublicationReceiptV1 => Object.freeze({
  version: STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION,
  requestIdentity: intent.requestIdentity,
  custodyFingerprint: intent.custodyFingerprint,
  output: privatePublicationOutput(intent),
  committedAt
})

const requestFor = (intent: StandupPublicationPrivateIntentV1, receipt: StandupPublicationReceiptV1): StandupPublicationAuthorityRequestV1 => Object.freeze({
  version: STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION,
  slotDigest: intent.slotDigest,
  requestIdentity: intent.requestIdentity,
  custodyFingerprint: intent.custodyFingerprint,
  grantRecordDigest: intent.grantRecordDigest,
  grantId: intent.grant.grantId,
  replayAudience: intent.grant.replayAudience,
  subject: intent.grant.subject,
  receipt
})

/**
 * Dormant private publisher. No Worker, RPC, ctx.exports, or Layer binds this class in production.
 * Its eventual Workspace DO adapter must preserve this single-transaction contract verbatim.
 */
export class StandupPublicationService {
  constructor(private readonly dependencies: StandupPublicationPrivateDependencies) {}

  publish(grantToken: OpaqueStandupRunGrantToken, request: PublishStandupPublicationRequestV1): PublishStandupPublicationOutputV1 {
    const committed = this.dependencies.store.transactionSync((transaction) =>
      this.publishWithinTransaction(grantToken, request, transaction)
    )
    this.publishAfterCommit(committed.prepared)
    return committed.receipt.output
  }

  /** @internal Runs authority stages in a caller-owned transaction; post-commit work remains with `publish`. */
  publishWithinTransaction(
    grantToken: OpaqueStandupRunGrantToken,
    request: PublishStandupPublicationRequestV1,
    transaction: StandupPublicationAuthorityTransaction
  ): CommittedPublication {
    // The opaque token is used exactly once here, to resolve an immutable grant record. It is not
    // retained in an intent, collection, receipt, event, outbox, message, error, or return value.
    const rawGrant = assertSynchronousResult(this.dependencies.resolver.resolve(grantToken), "standup run grant resolver")
    if (rawGrant === undefined) throw new StandupPublicationGrantDeniedError()
    const intent = resolvePrivatePublicationIntent(rawGrant, request)
    const existing = transaction.committedRequestFor(intent.slotDigest)
    if (existing !== undefined) return this.replayExisting(transaction, intent, existing)

    const now = canonicalNow(this.dependencies.clock.now())
    if (Date.parse(intent.grant.expiresAt) <= Date.parse(now) || transaction.grantConsumed(intent.grant.grantId)) {
      throw new StandupPublicationGrantDeniedError()
    }
    const admission = assertSynchronousResult(this.dependencies.resolver.recheckFresh(intent.grant, {
        now,
        slotDigest: intent.slotDigest,
        grantAlreadyConsumed: false
    }), "standup run grant admission")
    if (admission.status !== "admitted") throw new StandupPublicationGrantDeniedError()

    transaction.stageGrantConsumption(Object.freeze({
        grantId: intent.grant.grantId,
        grantRecordDigest: intent.grantRecordDigest,
        consumedAt: now
    }))
    this.fail("after-grant-consumption")

    const prepared = exactPrepared(this.dependencies.companion.prepare({
        childNodeId: intent.childNodeId,
        originalText: intent.originalText,
        originalTextDigest: intent.originalTextDigest
      }), {
        childNodeId: intent.childNodeId,
        originalTextDigest: intent.originalTextDigest,
        contentUtf8: intent.originalText,
        contentDigest: intent.originalTextDigest,
        contentByteLength: intent.originalTextByteLength
    })
    transaction.stagePublication(privatePublicationRecord(intent, now))
    this.fail("after-publication")

    const page = privateCompanionPage(intent, prepared)
    transaction.stageCompanionPage(page)
    this.fail("after-companion-page")

    transaction.stageCompanion(privateCompanionLink(intent, page))
    this.fail("after-companion")

    const receipt = receiptFor(intent, now)
    transaction.stageAuthorityRequest(requestFor(intent, receipt))
    this.fail("after-receipt")

    const event = eventFor(intent, now)
    transaction.stageEvent(event)
    this.fail("after-event")

    transaction.stageOutboxIntent(outboxFor(intent, event))
    this.fail("after-outbox")
    return Object.freeze({ receipt, prepared })
  }

  private replayExisting(
    transaction: StandupPublicationAuthorityTransaction,
    intent: StandupPublicationPrivateIntentV1,
    existing: StandupPublicationAuthorityRequestV1
  ): CommittedPublication {
    if (existing.replayAudience !== intent.grant.replayAudience || existing.subject !== intent.grant.subject) {
      throw new StandupPublicationGrantDeniedError()
    }
    if (
      existing.custodyFingerprint !== intent.custodyFingerprint ||
      existing.grantRecordDigest !== intent.grantRecordDigest ||
      existing.grantId !== intent.grant.grantId
    ) throw new StandupPublicationConflictError()
    const expectedOutput = privatePublicationOutput(intent)
    if (
      existing.version !== STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION ||
      existing.slotDigest !== intent.slotDigest ||
      existing.requestIdentity !== intent.requestIdentity ||
      existing.receipt.version !== STANDUP_PRIVATE_PUBLICATION_PROTOCOL_VERSION ||
      existing.receipt.requestIdentity !== intent.requestIdentity ||
      existing.receipt.custodyFingerprint !== intent.custodyFingerprint ||
      !isExactOutput(existing.receipt.output, expectedOutput)
    ) throw new Error("corrupt committed private standup publication receipt")
    const publication = transaction.publicationFor(intent.publicationId)
    const link = transaction.companionFor(intent.publicationId)
    const page = transaction.companionPageFor(intent.publicationId)
    if (publication === undefined || link === undefined || page === undefined) throw new Error("corrupt committed private standup publication")
    assertDurableCompanion(intent, publication, link, page)
    const restored = this.dependencies.companion.restore({ publication, link, page })
    const prepared = restored === undefined
      ? undefined
      : exactPrepared(restored, {
          childNodeId: intent.childNodeId,
          originalTextDigest: intent.originalTextDigest
        })
    return Object.freeze({ receipt: existing.receipt, prepared })
  }

  private publishAfterCommit(prepared: PreparedStandupCompanionPage | undefined): void {
    if (prepared === undefined) return
    try {
      assertSynchronousResult(this.dependencies.companion.publishAfterCommit(prepared), "standup companion post-commit publication")
    } catch (error) {
      throw new StandupPublicationPostCommitError(error)
    }
  }

  private fail(stage: StandupPublicationPrivateStage): void {
    this.dependencies.failpoint?.(stage)
  }
}
