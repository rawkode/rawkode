import { evictDurableObject } from "cloudflare:test"
import * as Schema from "effect/Schema"
import { LoroDoc, LoroList, LoroMap, LoroText, VersionVector } from "loro-crdt/bundler"
import { afterEach, describe, expect, it } from "vitest"
import {
  CommitLoroPageContentInput,
  CommitLoroPageContentOutput,
  ListNodesInput,
  ListNodesOutput,
  ListStandupPublicationsInput,
  ListStandupPublicationsOutput,
  GetPageDocumentDescriptorInput,
  GetPageDocumentDescriptorOutput,
  HumanUiMutationAttribution,
  LoroMutationIntentV1,
  StartLoroPageSyncInput,
  StartLoroPageSyncOutput,
  WORKFORCE_SCHEMA_VERSION,
  type EntityId
} from "@athenaeum/domain"
import {
  decodeWorkforceRunAdmission,
  grantForWorkforceAdmission,
  type AdmitWorkforceRunInput
} from "../src/workforce-run-authority.js"
import { resolvePrivatePublicationIntent, STANDUP_PRIVATE_REQUEST_VERSION } from "../src/standup-publication-private-contract.js"
import { ledgerExecuteTestHook } from "../src/ledger-service.js"
import { loroPageServicePostCommitTestHook } from "../src/loro-page-service-live.js"
import { connectToWorkspaceAsTestUser, freshWorkspaceId, rejectionToDomainError, workspaceDurableObjectStub } from "./support.js"

const ref = (kind: string, id: string, version = "v1") => ({ kind, id, version })

const workforceInput = (
  workspaceId: string,
  reportText = "Profile enriched",
  resultKind: "completed" | "blocked" | "failed" | "skipped" = "completed"
) => {
  const microEmployee = ref("microEmployee", "assistant")
  const job = ref("job", "enrich")
  const workflow = ref("workflow", "daily")
  const schedule = ref("schedule", "daily")
  const council = ref("council", "review")
  const run = { microEmployee, job, workflow, runId: "run-1" }
  const occurrence = { schedule, occurrenceId: "morning", civilDate: "2026-08-29" }
  const result = { kind: resultKind, summary: reportText }
  return {
    workspaceId,
    reportText,
    bundle: {
      microEmployees: { state: "known", values: [{ schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "microEmployee", id: "assistant", version: "v1", label: "Executive assistant", role: "assistant", jobRefs: [job] }] },
      jobs: { state: "known", values: [{ schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "job", id: "enrich", version: "v1", label: "Enrich people", workflowRef: workflow }] },
      workflows: { state: "known", values: [{ schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "workflow", id: "daily", version: "v1", label: "Daily enrichment", scheduleRef: schedule, councilRefs: [council] }] },
      schedules: { state: "known", values: [{ schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "schedule", id: "daily", version: "v1", label: "Daily", civilTimeZone: "Europe/London", occurrenceIds: ["morning"] }] },
      councils: { state: "known", values: [{ schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "council", id: "review", version: "v1", label: "Review council", memberRefs: [microEmployee] }] },
      events: { state: "known", values: [
        { schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "runObserved", eventId: "event-run", sequence: 0, run, occurrence },
        { schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "resultObserved", eventId: "event-result", sequence: 1, run, occurrence, result, causedByEventId: "event-run" }
      ] },
      runFacts: { state: "known", values: [{ schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "runFactObserved", factId: "fact-result", sequence: 2, run, occurrence, causedByEventId: "event-result", observation: { kind: "result", result } }] },
      civilScope: occurrence
    }
  }
}

describe("workforce run authority", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
    loroPageServicePostCommitTestHook.beforePublish = undefined
  })

  it("admits one complete causally-linked bundle and derives a stable message", () => {
    const input = workforceInput("00000000-0000-4000-8000-000000000001") as AdmitWorkforceRunInput
    const admission = decodeWorkforceRunAdmission(input)
    expect(admission.requestIdentity).toMatch(/^([0-9a-f]{64})$/)
    expect(admission.commitMessage).toBe("Workforce Enrich people run completed: Profile enriched")
    expect(admission.dailyNoteId).toBe("00000000-0000-4000-8000-000020260829")
    const grant = grantForWorkforceAdmission(admission, "2026-08-29T09:00:00.000Z", "grant-1")
    expect(grant.actorKind).toBe("system")
    expect(grant.subject).toBe("workforce:employee:assistant")
    expect(grant.dailyNoteId).toBe(admission.dailyNoteId)
  })

  it("rejects a terminal result whose report is not the admitted text", () => {
    const input = workforceInput("00000000-0000-4000-8000-000000000002") as AdmitWorkforceRunInput & { reportText: string }
    input.reportText = "different"
    expect(() => decodeWorkforceRunAdmission(input)).toThrow(/reportText must be the terminal result summary/)
  })

  it("commits a real node and Loro companion, replays without writes, and survives eviction", async () => {
    const workspaceId = freshWorkspaceId()
    const native = workspaceDurableObjectStub(workspaceId) as unknown as {
      admitWorkforceRun(input: unknown): Promise<Record<string, unknown>>
      debugGetLedgerArtifactCounts(): Promise<Record<string, number>>
      debugGetLedgerCustody(requestIdentity: string): Promise<Record<string, unknown> | null>
    }
    const input = workforceInput(workspaceId)
    const first = await native.admitWorkforceRun(input)
    expect(first).toMatchObject({ replayed: false, resultKind: "completed", commitMessage: expect.stringContaining("Enrich people") })
    expect(first.publicationId).toBe(first.childNodeId)
    const admission = decodeWorkforceRunAdmission(input)
    expect(await native.debugGetLedgerCustody(`workforce-loro:${admission.requestIdentity}`)).toMatchObject({
      type: "ensureLoroPage",
      workspaceId,
      actorKind: "employee",
      actorLabel: "Executive assistant · Enrich people",
      employeeId: "assistant",
      jobId: "enrich",
      runId: "run-1",
      grantId: expect.any(String),
      targetKind: "node",
      targetId: first.childNodeId
    })

    const workspace = await connectToWorkspaceAsTestUser(workspaceId)
    const nodes = Schema.decodeUnknownSync(ListNodesOutput)(await workspace.listNodes(
      Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId }))
    ))
    expect(nodes.nodes).toHaveLength(1)
    expect(nodes.nodes[0]).toMatchObject({ id: first.childNodeId, workspaceId })
    const started = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(await workspace.startLoroPageSync(
      Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: first.childNodeId as EntityId, sessionId: "workforce-read" }))
    ))
    const pageDoc = new LoroDoc()
    pageDoc.import(started.message)
    const rootChildren = pageDoc.getMap("athenaeum-prosemirror-v1").get("children")
    if (!(rootChildren instanceof LoroList)) throw new Error("workforce page has no root children")
    const paragraph = rootChildren.get(0)
    if (!(paragraph instanceof LoroMap)) throw new Error("workforce page has no paragraph")
    const paragraphChildren = paragraph.get("children")
    if (!(paragraphChildren instanceof LoroList)) throw new Error("workforce page has no paragraph children")
    const leaf = paragraphChildren.get(0)
    if (!(leaf instanceof LoroText)) throw new Error("workforce page has no text leaf")
    expect(leaf.toString()).toBe("Profile enriched")

    const descriptor = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(await workspace.getPageDocumentDescriptor(
      Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: first.childNodeId as EntityId }))
    )).descriptor
    if (descriptor.activeFormat !== "loro-v1" || descriptor.loro === undefined) throw new Error("workforce page has no Loro descriptor")
    const edited = new LoroDoc()
    edited.import(started.message)
    const editedRootChildren = edited.getMap("athenaeum-prosemirror-v1").get("children")
    if (!(editedRootChildren instanceof LoroList)) throw new Error("workforce page has no editable root")
    const editedParagraph = editedRootChildren.get(0)
    if (!(editedParagraph instanceof LoroMap)) throw new Error("workforce page has no editable paragraph")
    const editedChildren = editedParagraph.get("children")
    if (!(editedChildren instanceof LoroList)) throw new Error("workforce page has no editable paragraph children")
    const editedLeaf = editedChildren.get(0)
    if (!(editedLeaf instanceof LoroText)) throw new Error("workforce page has no editable leaf")
    editedLeaf.insert(editedLeaf.length, " — reviewed")
    edited.commit()
    const contentCommit = Schema.decodeUnknownSync(CommitLoroPageContentOutput)(await workspace.commitLoroPageContent(
      Schema.encodeSync(CommitLoroPageContentInput)(new CommitLoroPageContentInput({
        workspaceId,
        nodeId: first.childNodeId as EntityId,
        intent: new LoroMutationIntentV1({
          requestId: "workforce-review-edit",
          commitMessage: "Review workforce standup companion",
          attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" })
        }),
        expectedStorageVersion: descriptor.storageVersion,
        expectedSnapshotSha256: descriptor.loro.snapshotSha256,
        expectedVersionVector: started.serverVersion,
        update: edited.export({ mode: "update", from: VersionVector.decode(started.serverVersion) })
      }))
    ))
    expect(contentCommit.storageVersion).toBeGreaterThan(descriptor.storageVersion)
    const publications = Schema.decodeUnknownSync(ListStandupPublicationsOutput)(await workspace.listStandupPublications(
      Schema.encodeSync(ListStandupPublicationsInput)(new ListStandupPublicationsInput({ workspaceId, dailyNoteId: first.dailyNoteId as EntityId }))
    ))
    expect(publications.publications).toHaveLength(1)
    expect(publications.publications[0]?.companionStatus).toBe("modified")
    expect(publications.publications[0]?.resultKind).toBe("completed")

    const beforeReplay = await native.debugGetLedgerArtifactCounts()
    const replay = await native.admitWorkforceRun(input)
    expect(replay).toMatchObject({ replayed: true, publicationId: first.publicationId, childNodeId: first.childNodeId })
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(beforeReplay)

    workspace[Symbol.dispose]()
    await evictDurableObject(workspaceDurableObjectStub(workspaceId))
    const replayAfterEviction = await native.admitWorkforceRun(input)
    expect(replayAfterEviction).toMatchObject({ replayed: true, publicationId: first.publicationId })

    const conflictInput = workforceInput(workspaceId, "A changed report")
    const conflict = await rejectionToDomainError(native.admitWorkforceRun(conflictInput))
    expect(conflict.message).toMatch(/workforce run conflict|request identity|different immutable/i)
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(beforeReplay)
  })

  it.each(["completed", "blocked", "failed", "skipped"] as const)(
    "projects the immutable %s terminal outcome and keeps it stable on replay",
    async (resultKind) => {
      const workspaceId = freshWorkspaceId()
      const native = workspaceDurableObjectStub(workspaceId) as unknown as {
        admitWorkforceRun(input: unknown): Promise<Record<string, unknown>>
      }
      const input = workforceInput(workspaceId, `Outcome: ${resultKind}`, resultKind)
      const first = await native.admitWorkforceRun(input)
      expect(first).toMatchObject({ replayed: false, resultKind })

      const workspace = await connectToWorkspaceAsTestUser(workspaceId)
      try {
        const publications = Schema.decodeUnknownSync(ListStandupPublicationsOutput)(await workspace.listStandupPublications(
          Schema.encodeSync(ListStandupPublicationsInput)(new ListStandupPublicationsInput({ workspaceId, dailyNoteId: first.dailyNoteId as EntityId }))
        ))
        expect(publications.publications).toHaveLength(1)
        expect(publications.publications[0]).toMatchObject({
          id: first.publicationId,
          originalText: `Outcome: ${resultKind}`,
          resultKind
        })

        const replay = await native.admitWorkforceRun(input)
        expect(replay).toMatchObject({ replayed: true, publicationId: first.publicationId, resultKind })
        const replayedProjection = Schema.decodeUnknownSync(ListStandupPublicationsOutput)(await workspace.listStandupPublications(
          Schema.encodeSync(ListStandupPublicationsInput)(new ListStandupPublicationsInput({ workspaceId, dailyNoteId: first.dailyNoteId as EntityId }))
        ))
        expect(replayedProjection.publications[0]?.resultKind).toBe(resultKind)
      } finally {
        workspace[Symbol.dispose]()
      }
    }
  )

  it.each(["resultKind", "workspaceRow"] as const)(
    "fails closed when the workforce receipt %s binding is tampered",
    async (corruption) => {
      const workspaceId = freshWorkspaceId()
      const native = workspaceDurableObjectStub(workspaceId) as unknown as {
        admitWorkforceRun(input: unknown): Promise<Record<string, unknown>>
        debugCorruptWorkforceRunReceipt(publicationId: string, corruption: "resultKind" | "workspaceRow"): Promise<void>
      }
      const first = await native.admitWorkforceRun(workforceInput(workspaceId))
      await native.debugCorruptWorkforceRunReceipt(first.publicationId as string, corruption)
      const workspace = await connectToWorkspaceAsTestUser(workspaceId)
      try {
        const failure = await rejectionToDomainError(workspace.listStandupPublications(
          Schema.encodeSync(ListStandupPublicationsInput)(new ListStandupPublicationsInput({ workspaceId, dailyNoteId: first.dailyNoteId as EntityId }))
        ))
        expect(failure._tag).toBe("UnexpectedError")
        expect(failure.message).toBe("standup publication workforce receipt failure")
      } finally {
        workspace[Symbol.dispose]()
      }
    }
  )

  it("rejects a cross-workspace admission before any durable write", async () => {
    const workspaceId = freshWorkspaceId()
    const foreignWorkspaceId = freshWorkspaceId()
    const native = workspaceDurableObjectStub(workspaceId) as unknown as {
      admitWorkforceRun(input: unknown): Promise<Record<string, unknown>>
      debugGetWorkforceStorageCounts(): Promise<Record<string, number>>
    }
    const before = await native.debugGetWorkforceStorageCounts()
    const error = await rejectionToDomainError(native.admitWorkforceRun(workforceInput(foreignWorkspaceId)))
    expect(error._tag).toBe("ValidationError")
    expect(await native.debugGetWorkforceStorageCounts()).toEqual(before)
  })

  it("refuses deterministic child-node takeover without touching the authority", async () => {
    const workspaceId = freshWorkspaceId()
    const input = workforceInput(workspaceId) as AdmitWorkforceRunInput
    const admission = decodeWorkforceRunAdmission(input)
    const grant = grantForWorkforceAdmission(admission, "2026-08-29T09:00:00.000Z", "collision-grant")
    const intent = resolvePrivatePublicationIntent(grant, {
      version: STANDUP_PRIVATE_REQUEST_VERSION,
      originalText: input.reportText
    })
    const workspace = await connectToWorkspaceAsTestUser(workspaceId)
    await workspace.createNode({ workspaceId, id: intent.childNodeId, title: "Unrelated existing node" })
    const native = workspaceDurableObjectStub(workspaceId) as unknown as {
      admitWorkforceRun(input: unknown): Promise<Record<string, unknown>>
      debugGetWorkforceStorageCounts(): Promise<Record<string, number>>
    }
    const before = await native.debugGetWorkforceStorageCounts()
    const error = await rejectionToDomainError(native.admitWorkforceRun(input))
    expect(error.message).toMatch(/deterministic workforce child node already exists|takeover|already exists/i)
    expect(await native.debugGetWorkforceStorageCounts()).toEqual(before)
    workspace[Symbol.dispose]()
  })

  it("rolls back node, Loro, index, feed, authority, and receipt rows on a ledger failure", async () => {
    const workspaceId = freshWorkspaceId()
    const input = workforceInput(workspaceId)
    const native = workspaceDurableObjectStub(workspaceId) as unknown as {
      admitWorkforceRun(input: unknown): Promise<Record<string, unknown>>
      debugGetWorkforceStorageCounts(): Promise<Record<string, number>>
    }
    const before = await native.debugGetWorkforceStorageCounts()
    ledgerExecuteTestHook.afterMutation = () => { throw new Error("workforce ledger failpoint") }
    const error = await rejectionToDomainError(native.admitWorkforceRun(input))
    expect(error.message).toMatch(/workforce transaction failed|ledger failpoint|UnexpectedError/i)
    expect(await native.debugGetWorkforceStorageCounts()).toEqual(before)
  })

  it("returns an immutable receipt and missing projection after the child node is deleted", async () => {
    const workspaceId = freshWorkspaceId()
    const input = workforceInput(workspaceId)
    const native = workspaceDurableObjectStub(workspaceId) as unknown as {
      admitWorkforceRun(input: unknown): Promise<Record<string, unknown>>
      debugDeleteWorkforceChild(nodeId: string): Promise<void>
      debugGetWorkforceStorageCounts(): Promise<Record<string, number>>
    }
    const first = await native.admitWorkforceRun(input)
    await native.debugDeleteWorkforceChild(first.childNodeId as string)
    const workspace = await connectToWorkspaceAsTestUser(workspaceId)
    const beforeReplay = await native.debugGetWorkforceStorageCounts()
    const replay = await native.admitWorkforceRun(input)
    expect(replay).toMatchObject({ replayed: true, publicationId: first.publicationId, childNodeId: first.childNodeId })
    expect(await native.debugGetWorkforceStorageCounts()).toEqual(beforeReplay)
    const publications = Schema.decodeUnknownSync(ListStandupPublicationsOutput)(await workspace.listStandupPublications(
      Schema.encodeSync(ListStandupPublicationsInput)(new ListStandupPublicationsInput({ workspaceId, dailyNoteId: first.dailyNoteId as EntityId }))
    ))
    expect(publications.publications[0]?.companionStatus).toBe("missing")
    const nodes = Schema.decodeUnknownSync(ListNodesOutput)(await workspace.listNodes(
      Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId }))
    ))
    expect(nodes.nodes).toHaveLength(0)
    workspace[Symbol.dispose]()
  })

  it("repairs the Loro cache by replaying after a post-commit publication failure", async () => {
    const workspaceId = freshWorkspaceId()
    const input = workforceInput(workspaceId)
    const native = workspaceDurableObjectStub(workspaceId) as unknown as {
      admitWorkforceRun(input: unknown): Promise<Record<string, unknown>>
      debugGetWorkforceStorageCounts(): Promise<Record<string, number>>
    }
    const before = await native.debugGetWorkforceStorageCounts()
    loroPageServicePostCommitTestHook.beforePublish = () => { throw new Error("workforce cache publication failpoint") }
    const error = await rejectionToDomainError(native.admitWorkforceRun(input))
    expect(error.message).toMatch(/cache publication failpoint|workforce run/i)
    loroPageServicePostCommitTestHook.beforePublish = undefined
    const committed = await native.debugGetWorkforceStorageCounts()
    expect(committed.workforceRuns).toBe(before.workforceRuns + 1)
    const replay = await native.admitWorkforceRun(input)
    expect(replay.replayed).toBe(true)
    expect(await native.debugGetWorkforceStorageCounts()).toEqual(committed)
    const workspace = await connectToWorkspaceAsTestUser(workspaceId)
    const publications = Schema.decodeUnknownSync(ListStandupPublicationsOutput)(await workspace.listStandupPublications(
      Schema.encodeSync(ListStandupPublicationsInput)(new ListStandupPublicationsInput({ workspaceId, dailyNoteId: replay.dailyNoteId as EntityId }))
    ))
    expect(publications.publications[0]?.companionStatus).toBe("verified-original")
    workspace[Symbol.dispose]()
  })
})
