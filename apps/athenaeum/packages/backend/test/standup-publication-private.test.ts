import { describe, expect, it } from "vitest"
import {
  STANDUP_PRIVATE_GRANT_VERSION,
  STANDUP_PRIVATE_REQUEST_VERSION,
  assertStrictGregorianCivilDate,
  canonicalDailyNoteIdForCivilDate,
  resolvePrivatePublicationIntent,
  standupPublicationCustodyFingerprintV1,
  type OpaqueStandupRunGrantToken,
  type ResolvedStandupRunGrantV1,
  type StandupRunGrantResolver
} from "../src/standup-publication-private-contract.js"
import { canonicalStandupPublicationText } from "@athenaeum/domain"
import {
  InMemoryStandupPublicationAuthorityStore,
  type PreparedStandupCompanionPage,
  type StandupPublicationCompanionAdapter
} from "../src/standup-publication-collections.js"
import {
  StandupPublicationConflictError,
  StandupPublicationGrantDeniedError,
  StandupPublicationPostCommitError,
  StandupPublicationService,
  type StandupPublicationPrivateStage
} from "../src/standup-publication-service-live.js"

const civilDate = "2026-08-29"
const dailyNoteId = canonicalDailyNoteIdForCivilDate(civilDate)

const grant = (overrides: Record<string, unknown> = {}) => ({
  version: STANDUP_PRIVATE_GRANT_VERSION,
  issuerId: "deployment-workforce-v1",
  grantId: "grant-1",
  grantRecordVersion: "1",
  workspaceId: "workspace-1",
  civilDate,
  dailyNoteId,
  runIdentityVersion: "workforce-run-v1",
  microEmployee: { kind: "microEmployee", id: "executive", version: "v1" },
  job: { kind: "job", id: "daily-standup", version: "v1" },
  workflow: { kind: "workflow", id: "standup", version: "v1" },
  schedule: { kind: "schedule", id: "weekdays", version: "v1" },
  councilRefs: [{ kind: "council", id: "ops", version: "v1" }],
  runId: "run-1",
  occurrenceId: "morning-1",
  microEmployeeLabel: "Executive",
  jobLabel: "Daily standup",
  workflowLabel: "Morning review",
  scheduleLabel: "Weekdays",
  subject: "system:workforce-scheduler",
  replayAudience: "system:workforce-scheduler:workspace-1",
  actorKind: "system" as const,
  authorityGeneration: "generation-7",
  revocationId: "revocation-set-3",
  revocationGeneration: "13",
  policyVersion: "workforce-policy-v1",
  issuedAt: "2026-08-29T08:00:00.000Z",
  expiresAt: "2026-08-29T09:00:00.000Z",
  oneUseBudget: 1 as const,
  ...overrides
})

const request = (originalText = "Reviewed daily priorities.") => ({
  version: STANDUP_PRIVATE_REQUEST_VERSION,
  originalText
})

const token = (): OpaqueStandupRunGrantToken => ({ bearer: "never-persist-me" } as unknown as OpaqueStandupRunGrantToken)

const adapter = (options: {
  readonly throwAfterCommit?: boolean
  readonly thenablePrepare?: boolean
  readonly substitutePreparedContent?: string
} = {}) => {
  const published: PreparedStandupCompanionPage[] = []
  let failuresLeft = options.throwAfterCommit ? 1 : 0
  const value: StandupPublicationCompanionAdapter = {
    prepare: ({ childNodeId, originalText, originalTextDigest }) => {
      if (options.thenablePrepare) return Promise.resolve({}) as unknown as PreparedStandupCompanionPage
      const contentUtf8 = options.substitutePreparedContent ?? originalText
      const content = canonicalStandupPublicationText(contentUtf8)
      return {
        format: "loro-v1",
        childNodeId,
        originalTextDigest,
        preparedDescriptor: `loro:${originalTextDigest}`,
        contentUtf8,
        contentDigest: content.sha256,
        contentByteLength: content.byteLength
      }
    },
    restore: ({ publication, link, page }) => {
      expect(page.publicationId).toBe(publication.publicationId)
      expect(page.contentUtf8).toBe(publication.originalText)
      return {
        format: "loro-v1",
        childNodeId: link.childNodeId,
        originalTextDigest: link.originalTextDigest,
        preparedDescriptor: link.preparedDescriptor,
        contentUtf8: page.contentUtf8,
        contentDigest: page.contentDigest,
        contentByteLength: page.contentByteLength
      }
    },
    publishAfterCommit: (prepared) => {
      if (failuresLeft > 0) {
        failuresLeft--
        throw new Error("cache unavailable")
      }
      published.push(prepared)
    }
  }
  return { value, published }
}

const resolverFor = (grantValue: unknown, tokenValue: OpaqueStandupRunGrantToken, state: { admitted?: boolean; rechecks?: number } = {}): StandupRunGrantResolver => ({
  resolve: (candidate) => candidate === tokenValue ? grantValue : undefined,
  recheckFresh: () => {
    state.rechecks = (state.rechecks ?? 0) + 1
    return { status: state.admitted === false ? "denied" : "admitted" }
  }
})

const serviceFor = (options: {
  readonly grantValue?: unknown
  readonly grantToken?: OpaqueStandupRunGrantToken
  readonly store?: InMemoryStandupPublicationAuthorityStore
  readonly adapterValue?: StandupPublicationCompanionAdapter
  readonly now?: string
  readonly state?: { admitted?: boolean; rechecks?: number }
  readonly failpoint?: (stage: StandupPublicationPrivateStage) => void
} = {}) => {
  const grantToken = options.grantToken ?? token()
  const store = options.store ?? new InMemoryStandupPublicationAuthorityStore()
  const adapterValue = options.adapterValue ?? adapter().value
  const state = options.state ?? {}
  const service = new StandupPublicationService({
    resolver: resolverFor(options.grantValue ?? grant(), grantToken, state),
    store,
    companion: adapterValue,
    clock: { now: () => options.now ?? "2026-08-29T08:30:00.000Z" },
    failpoint: options.failpoint
  })
  return { service, grantToken, store, state }
}

const rowCount = (store: InMemoryStandupPublicationAuthorityStore) => {
  const state = store.snapshot()
  return Object.values(state.requestsBySlot).length + Object.values(state.publicationsById).length +
    Object.values(state.companionsByPublication).length + Object.values(state.companionPagesByPublication).length + Object.values(state.eventsById).length +
    Object.values(state.outboxById).length + Object.values(state.grantConsumptionsById).length
}

describe("dormant private workforce standup publication", () => {
  it("requires a strict Gregorian date and the server-derived deterministic daily-note mapping", () => {
    expect(assertStrictGregorianCivilDate("2024-02-29")).toBe("2024-02-29")
    for (const invalid of ["2025-02-29", "2026-13-01", "2026-01-00", " 2026-08-29", "٢٠٢٦-٠٨-٢٩", "2026-08-29T00:00:00Z"]) {
      expect(() => assertStrictGregorianCivilDate(invalid)).toThrow()
    }
    expect(() => resolvePrivatePublicationIntent(grant({ dailyNoteId: "00000000-0000-4000-8000-999999999999" }), request())).toThrow(/dailyNoteId/)
    expect(() => resolvePrivatePublicationIntent(grant(), { ...request(), dailyNoteId })).toThrow(/unknown/)
  })

  it("covers all output- and authority-affecting grant custody fields in the private fingerprint", () => {
    const baseline = resolvePrivatePublicationIntent(grant(), request())
    const altered = [
      { grantId: "grant-2" },
      { revocationId: "revocation-set-4" },
      { revocationGeneration: "14" },
      { authorityGeneration: "generation-8" },
      { subject: "system:other" },
      { replayAudience: "system:other:workspace-1" },
      { microEmployeeLabel: "Operations" },
      { jobLabel: "Different job" },
      { workflowLabel: "Different workflow" },
      { scheduleLabel: "Different schedule" },
      { policyVersion: "workforce-policy-v2" },
      { expiresAt: "2026-08-29T08:59:00.000Z" },
      { job: { kind: "job", id: "other-job", version: "v2" } }
    ]
    for (const patch of altered) {
      const next = resolvePrivatePublicationIntent(grant(patch), request())
      expect(next.custodyFingerprint).not.toBe(baseline.custodyFingerprint)
    }
    expect(standupPublicationCustodyFingerprintV1({
      grant: baseline.grant,
      slot: baseline.slot,
      originalTextDigest: baseline.originalTextDigest,
      originalTextByteLength: baseline.originalTextByteLength,
      message: baseline.message
    })).toBe(baseline.custodyFingerprint)
  })

  it("commits one private request and exact-replays it after expiry/revocation without a fresh admission", () => {
    const rawGrant = grant()
    const grantToken = token()
    const store = new InMemoryStandupPublicationAuthorityStore()
    const companion = adapter()
    const firstState: { admitted?: boolean; rechecks?: number } = {}
    const first = serviceFor({ grantValue: rawGrant, grantToken, store, adapterValue: companion.value, state: firstState }).service.publish(grantToken, request())
    expect(firstState.rechecks).toBe(1)
    expect(Object.values(store.snapshot().requestsBySlot)).toHaveLength(1)
    expect(Object.values(store.snapshot().eventsById)).toHaveLength(1)
    expect(Object.values(store.snapshot().outboxById)).toHaveLength(1)

    const replayState: { admitted?: boolean; rechecks?: number } = { admitted: false }
    const replay = serviceFor({
      grantValue: rawGrant,
      grantToken,
      store,
      adapterValue: companion.value,
      now: "2026-08-29T10:00:00.000Z",
      state: replayState
    }).service.publish(grantToken, request())
    expect(replay).toEqual(first)
    expect(replayState.rechecks ?? 0).toBe(0)
    expect(companion.published).toHaveLength(2)
    const durablePage = Object.values(store.snapshot().companionPagesByPublication)[0]!
    expect(durablePage.contentUtf8).toBe("Reviewed daily priorities.")
    expect(companion.published[1]?.contentUtf8).toBe(durablePage.contentUtf8)
    expect(rowCount(store)).toBe(7)
  })

  it("denies a fresh grant exactly at its expiry boundary before any durable write or admission recheck", () => {
    const state: { admitted?: boolean; rechecks?: number } = {}
    const { service, grantToken, store } = serviceFor({ now: "2026-08-29T09:00:00.000Z", state })
    expect(() => service.publish(grantToken, request())).toThrow(StandupPublicationGrantDeniedError)
    expect(state.rechecks ?? 0).toBe(0)
    expect(rowCount(store)).toBe(0)
  })

  it("conflicts changed slot material and denies a foreign replay audience without exposing the receipt", () => {
    const grantToken = token()
    const store = new InMemoryStandupPublicationAuthorityStore()
    const companion = adapter()
    serviceFor({ grantToken, store, adapterValue: companion.value }).service.publish(grantToken, request())

    expect(() => serviceFor({ grantToken, store, adapterValue: companion.value }).service.publish(grantToken, request("Changed report."))).toThrow(StandupPublicationConflictError)
    expect(() => serviceFor({
      grantToken,
      store,
      adapterValue: companion.value,
      grantValue: grant({ subject: "system:foreign", replayAudience: "system:foreign:workspace-1" })
    }).service.publish(grantToken, request())).toThrow(StandupPublicationGrantDeniedError)
    expect(rowCount(store)).toBe(7)
  })

  it("rolls back every durable record and grant consumption at each transaction failpoint", () => {
    const stages: StandupPublicationPrivateStage[] = [
      "after-grant-consumption", "after-publication", "after-companion-page", "after-companion", "after-receipt", "after-event", "after-outbox"
    ]
    for (const stage of stages) {
      const companion = adapter()
      const { service, grantToken, store } = serviceFor({
        adapterValue: companion.value,
        failpoint: (observed) => { if (observed === stage) throw new Error(stage) }
      })
      expect(() => service.publish(grantToken, request())).toThrow(stage)
      expect(rowCount(store)).toBe(0)
      expect(Object.values(store.snapshot().companionPagesByPublication)).toHaveLength(0)
      expect(companion.published).toHaveLength(0)
    }
  })

  it("rejects an asynchronous companion adapter and leaves the transaction empty", () => {
    const companion = adapter({ thenablePrepare: true })
    const { service, grantToken, store } = serviceFor({ adapterValue: companion.value })
    expect(() => service.publish(grantToken, request())).toThrow(/thenable|synchronous/)
    expect(rowCount(store)).toBe(0)
  })

  it("rejects a fresh companion payload that substitutes content despite coherent self-digest metadata", () => {
    const companion = adapter({ substitutePreparedContent: "Substituted report content." })
    const { service, grantToken, store } = serviceFor({ adapterValue: companion.value })
    expect(() => service.publish(grantToken, request())).toThrow(/invalid prepared|digest|byte length/)
    expect(rowCount(store)).toBe(0)
    expect(companion.published).toHaveLength(0)
  })

  it("keeps the durable receipt after a post-commit cache crash and restores the prepared page on exact replay", () => {
    const companion = adapter({ throwAfterCommit: true })
    const { service, grantToken, store } = serviceFor({ adapterValue: companion.value })
    expect(() => service.publish(grantToken, request())).toThrow(StandupPublicationPostCommitError)
    expect(rowCount(store)).toBe(7)
    const replay = service.publish(grantToken, request())
    expect(replay.dailyNoteId).toBe(dailyNoteId)
    expect(companion.published).toHaveLength(1)
    const durablePage = Object.values(store.snapshot().companionPagesByPublication)[0]!
    expect(companion.published[0]?.contentUtf8).toBe(durablePage.contentUtf8)
    expect(rowCount(store)).toBe(7)
  })

  it("fails closed before cache publication for a coherently substituted durable bundle or receipt redirect", () => {
    const seedStore = new InMemoryStandupPublicationAuthorityStore()
    const seedCompanion = adapter()
    const seed = serviceFor({ store: seedStore, adapterValue: seedCompanion.value })
    seed.service.publish(seed.grantToken, request())
    const state = seedStore.snapshot()
    const requestRow = Object.values(state.requestsBySlot)[0]!
    const publication = Object.values(state.publicationsById)[0]!
    const link = Object.values(state.companionsByPublication)[0]!
    const page = Object.values(state.companionPagesByPublication)[0]!

    const substitutedText = "Coherently substituted report."
    const substituted = canonicalStandupPublicationText(substitutedText)
    const substitutedStore = new InMemoryStandupPublicationAuthorityStore({
      ...state,
      publicationsById: {
        ...state.publicationsById,
        [publication.publicationId]: {
          ...publication,
          originalText: substitutedText,
          originalTextDigest: substituted.sha256,
          originalTextByteLength: substituted.byteLength
        }
      },
      companionsByPublication: {
        ...state.companionsByPublication,
        [link.publicationId]: {
          ...link,
          originalTextDigest: substituted.sha256,
          contentDigest: substituted.sha256,
          contentByteLength: substituted.byteLength,
          preparedDescriptor: `loro:${substituted.sha256}`
        }
      },
      companionPagesByPublication: {
        ...state.companionPagesByPublication,
        [page.publicationId]: {
          ...page,
          originalTextDigest: substituted.sha256,
          contentUtf8: substitutedText,
          contentDigest: substituted.sha256,
          contentByteLength: substituted.byteLength,
          preparedDescriptor: `loro:${substituted.sha256}`
        }
      }
    } as never)
    const substitutedCompanion = adapter()
    const substitutedReplay = serviceFor({
      store: substitutedStore,
      grantToken: seed.grantToken,
      adapterValue: substitutedCompanion.value
    })
    expect(() => substitutedReplay.service.publish(seed.grantToken, request())).toThrow(/corrupt/)
    expect(substitutedCompanion.published).toHaveLength(0)

    const redirectedId = "redirected-child-page"
    const redirectedPublication = { ...publication, publicationId: redirectedId, childNodeId: redirectedId }
    const redirectedLink = { ...link, publicationId: redirectedId, childNodeId: redirectedId }
    const redirectedPage = { ...page, publicationId: redirectedId, childNodeId: redirectedId }
    const redirectedStore = new InMemoryStandupPublicationAuthorityStore({
      ...state,
      requestsBySlot: {
        [requestRow.slotDigest]: {
          ...requestRow,
          receipt: {
            ...requestRow.receipt,
            output: {
              ...requestRow.receipt.output,
              publicationId: redirectedId,
              childNodeId: redirectedId
            }
          }
        }
      },
      publicationsById: { [redirectedId]: redirectedPublication },
      companionsByPublication: { [redirectedId]: redirectedLink },
      companionPagesByPublication: { [redirectedId]: redirectedPage }
    } as never)
    const redirectedCompanion = adapter()
    const redirectedReplay = serviceFor({
      store: redirectedStore,
      grantToken: seed.grantToken,
      adapterValue: redirectedCompanion.value
    })
    expect(() => redirectedReplay.service.publish(seed.grantToken, request())).toThrow(/corrupt/)
    expect(redirectedCompanion.published).toHaveLength(0)
  })

  it("persists label snapshots while keeping the bearer and event/outbox payloads redacted", () => {
    const rawGrant = grant()
    const grantToken = token()
    const store = new InMemoryStandupPublicationAuthorityStore()
    serviceFor({ grantValue: rawGrant, grantToken, store }).service.publish(grantToken, request("Private report body."))
    rawGrant.jobLabel = "Mutated later"
    const state = store.snapshot()
    const publication = Object.values(state.publicationsById)[0]!
    const page = Object.values(state.companionPagesByPublication)[0]!
    const event = Object.values(state.eventsById)[0]!
    const outbox = Object.values(state.outboxById)[0]!
    expect(publication.jobLabel).toBe("Daily standup")
    expect(page.contentUtf8).toBe("Private report body.")
    expect(JSON.stringify(state)).not.toContain("never-persist-me")
    expect(JSON.stringify(event)).not.toContain("Private report body.")
    expect(JSON.stringify(outbox)).not.toContain("Private report body.")
    expect(Object.keys(event).sort()).toEqual(["childNodeId", "dailyNoteId", "eventId", "eventType", "occurredAt", "publicationId", "requestIdentity", "slotDigest", "version"])
    expect(Object.keys(outbox).sort()).toEqual(["childNodeId", "consumer", "dailyNoteId", "eventId", "occurredAt", "outboxId", "publicationId", "requestIdentity", "slotDigest", "version"])
  })

  it("fails closed when a stored request has a mismatched receipt", () => {
    const corrupt = new InMemoryStandupPublicationAuthorityStore({
      requestsBySlot: {
        corrupt: {
          version: STANDUP_PRIVATE_GRANT_VERSION as never,
          slotDigest: "corrupt",
          requestIdentity: "request",
          custodyFingerprint: "fingerprint",
          grantRecordDigest: "grant",
          grantId: "grant",
          replayAudience: "audience",
          subject: "subject",
          receipt: {
            version: STANDUP_PRIVATE_GRANT_VERSION as never,
            requestIdentity: "different",
            custodyFingerprint: "fingerprint",
            output: {} as never,
            committedAt: "2026-08-29T08:30:00.000Z"
          }
        }
      }
    } as never)
    expect(() => corrupt.transactionSync((transaction) => transaction.committedRequestFor("corrupt"))).toThrow(/corrupt/)
  })
})
