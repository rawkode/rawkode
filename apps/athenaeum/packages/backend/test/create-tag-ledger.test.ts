import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  CreateTagInput,
  CreateTagLedgerCommand,
  CreateTagOutput,
  CreateNodeInput,
  CreateNodeOutput,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListRecentLedgerActivityOutput,
  ListTagClosureInput,
  ListTagClosureOutput,
  RunViewInput,
  RunViewOutput,
  SyncFeedInput,
  SyncFeedOutput,
  ViewSpec,
  BaseTagIds,
  type EntityId
} from "@athenaeum/domain"
import { createTagLedgerFingerprint, ledgerExecuteTestHook } from "../src/ledger-service.js"
import {
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

const tagAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface: "web-supertags-manager"
})

const tagInput = (args: {
  readonly workspaceId: EntityId
  readonly name: string
  readonly parentIds?: ReadonlyArray<EntityId>
  readonly requestId: string
  readonly commitMessage?: string
  readonly attribution?: HumanUiMutationAttribution
}) => new CreateTagInput({
  workspaceId: args.workspaceId,
  name: args.name,
  parentIds: args.parentIds ?? [],
  requestId: args.requestId,
  commitMessage: args.commitMessage ?? "Define this Supertag for the daily knowledge graph.",
  attribution: args.attribution ?? tagAttribution()
})

const graphTags = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(RunViewOutput)(await stub.runView(Schema.encodeSync(RunViewInput)(new RunViewInput({
    workspaceId,
    viewName: "graph_tags",
    viewSpec: new ViewSpec({
      view: "table",
      visibleColumns: ["id", "name", "builtin"],
      rowLimit: 100
    })
  })))).rows

const tagClosure = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(ListTagClosureOutput)(await stub.listTagClosure(
    Schema.encodeSync(ListTagClosureInput)(new ListTagClosureInput({ workspaceId }))
  )).entries

const syncEntries = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(
    Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
  )).entries

describe.sequential("createTag ledger authority slice", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
  })

  it("records private provenance, replays the exact output, and emits one canonical schema side effect", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential, email } = await devSignIn(`create-tag-ledger-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const input = Schema.encodeSync(CreateTagInput)(tagInput({
        workspaceId,
        name: "  Project   Alpha\n",
        parentIds: [BaseTagIds.Person],
        requestId: "create-tag-ledger-1",
        commitMessage: "Keep project profiles strongly typed for the daily standup."
      }))
      const first = Schema.decodeUnknownSync(CreateTagOutput)(await connection.stub.createTag(input))
      const replay = Schema.decodeUnknownSync(CreateTagOutput)(await connection.stub.createTag(input))
      expect(replay).toEqual(first)
      expect(first.tag.name).toBe("Project Alpha")
      expect(first.tag.parentIds).toEqual([BaseTagIds.Person])

      const native = workspaceDurableObjectStub(workspaceId)
      const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand("create-tag:create-tag-ledger-1"))
      expect(command).toMatchObject({
        type: "createTag",
        principal: email,
        message: "Created a Supertag definition.",
        payload: {
          name: "Project Alpha",
          parentIds: [BaseTagIds.Person],
          commitMessage: "Keep project profiles strongly typed for the daily standup.",
          attribution: { kind: "humanUi", surface: "web-supertags-manager" }
        }
      })
      expect((command as CreateTagLedgerCommand).message).not.toContain("strongly typed")
      expect(await native.debugGetLedgerReceipt("create-tag:create-tag-ledger-1")).toMatchObject({
        output: { version: "athenaeum.workspace-ledger-receipt.v2", type: "createTag" }
      })
      const expectedSideEffect = {
        tagId: first.tag.id,
        name: "Project Alpha",
        parentIds: [BaseTagIds.Person]
      }
      expect(await native.debugGetLedgerEvent("create-tag:create-tag-ledger-1")).toEqual({
        kind: "create-tag",
        payload: expectedSideEffect
      })
      expect(await native.debugGetLedgerOutboxIntent("create-tag:create-tag-ledger-1")).toEqual({
        kind: "create-tag",
        payload: expectedSideEffect
      })

      expect((await graphTags(connection.stub, workspaceId)).filter((row) => (row as { id?: string }).id === first.tag.id)).toHaveLength(1)
      expect((await tagClosure(connection.stub, workspaceId)).filter((row) => row.descendantId === first.tag.id)).toEqual([
        { ancestorId: BaseTagIds.Person, descendantId: first.tag.id },
        { ancestorId: first.tag.id, descendantId: first.tag.id }
      ])
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "tag" && entry.entityId === first.tag.id)).toHaveLength(1)

      const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await connection.stub.listRecentLedgerActivity({ workspaceId, limit: 10 }))
      const tagActivity = activity.entries.find((entry) => entry.type === "createTag")
      expect(tagActivity).toEqual({
        occurredAt: expect.any(String),
        type: "createTag",
        actor: "you",
        message: "Created a Supertag definition."
      })
      expect(JSON.stringify(tagActivity)).not.toContain("strongly typed")
      expect(JSON.stringify(tagActivity)).not.toContain("create-tag-ledger-1")
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("replays same-request concurrent calls without duplicating the tag, closure, or feed entry", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`create-tag-replay-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const input = Schema.encodeSync(CreateTagInput)(tagInput({
        workspaceId,
        name: "Concurrent Tag",
        requestId: "create-tag-concurrent-replay"
      }))
      const [first, second] = await Promise.all([connection.stub.createTag(input), connection.stub.createTag(input)])
      const firstOutput = Schema.decodeUnknownSync(CreateTagOutput)(first)
      expect(Schema.decodeUnknownSync(CreateTagOutput)(second)).toEqual(firstOutput)
      expect((await graphTags(connection.stub, workspaceId)).filter((row) => (row as { id?: string }).id === firstOutput.tag.id)).toHaveLength(1)
      expect((await tagClosure(connection.stub, workspaceId)).filter((row) => row.descendantId === firstOutput.tag.id)).toHaveLength(1)
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "tag" && entry.entityId === firstOutput.tag.id)).toHaveLength(1)
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rejects changed semantic input for a request id without a second tag or ledger side effect", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`create-tag-conflict-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const first = Schema.decodeUnknownSync(CreateTagOutput)(await connection.stub.createTag(Schema.encodeSync(CreateTagInput)(tagInput({
        workspaceId,
        name: "Conflict Tag",
        requestId: "create-tag-conflict"
      }))))
      const changed = tagInput({
        workspaceId,
        name: "Different Tag",
        requestId: "create-tag-conflict"
      })
      const error = await rejectionToDomainError(connection.stub.createTag(Schema.encodeSync(CreateTagInput)(changed)))
      expect(error._tag).toBe("ValidationError")
      expect((await graphTags(connection.stub, workspaceId)).filter((row) => (row as { id?: string }).id === first.tag.id)).toHaveLength(1)
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "tag")).toHaveLength(1)
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("create-tag:create-tag-conflict")).not.toBeNull()
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("treats parent order, rationale, and attribution as immutable request semantics", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`create-tag-semantic-conflict-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const cases = [
        {
          requestId: "create-tag-parent-order-conflict",
          initial: { parentIds: [BaseTagIds.Person, BaseTagIds.Company] },
          changed: { parentIds: [BaseTagIds.Company, BaseTagIds.Person] }
        },
        {
          requestId: "create-tag-rationale-conflict",
          initial: { commitMessage: "Keep this schema stable." },
          changed: { commitMessage: "Use a different schema rationale." }
        },
        {
          requestId: "create-tag-attribution-conflict",
          initial: { attribution: tagAttribution() },
          changed: { attribution: new HumanUiMutationAttribution({
            version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos"
          }) }
        }
      ] as const

      for (const [index, testCase] of cases.entries()) {
        const name = `Semantic Conflict ${index}`
        const initial = tagInput({ workspaceId, name, requestId: testCase.requestId, ...testCase.initial })
        await connection.stub.createTag(Schema.encodeSync(CreateTagInput)(initial))
        const changed = tagInput({ workspaceId, name, requestId: testCase.requestId, ...testCase.changed })
        const error = await rejectionToDomainError(connection.stub.createTag(Schema.encodeSync(CreateTagInput)(changed)))
        expect(error._tag).toBe("ValidationError")
      }

      const rows = await graphTags(connection.stub, workspaceId)
      expect(rows.filter((row) => (row as { builtin?: boolean | number }).builtin === false || (row as { builtin?: boolean | number }).builtin === 0)).toHaveLength(cases.length)
      const entries = await syncEntries(connection.stub, workspaceId)
      expect(entries.filter((entry) => entry.entityKind === "tag")).toHaveLength(cases.length)
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rolls back the tag, read model, closure, feed, command, receipt, event, and outbox after a post-mutation failure", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`create-tag-rollback-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const beforeTags = await graphTags(connection.stub, workspaceId)
      const beforeClosure = await tagClosure(connection.stub, workspaceId)
      const beforeFeed = await syncEntries(connection.stub, workspaceId)
      ledgerExecuteTestHook.afterMutation = () => { throw new Error("createTag ledger failpoint") }
      const error = await rejectionToDomainError(connection.stub.createTag(Schema.encodeSync(CreateTagInput)(tagInput({
        workspaceId,
        name: "Rolled Back Tag",
        requestId: "create-tag-rollback"
      }))))
      expect(error._tag).toBe("UnexpectedError")
      ledgerExecuteTestHook.afterMutation = undefined

      expect(await graphTags(connection.stub, workspaceId)).toEqual(beforeTags)
      expect(await tagClosure(connection.stub, workspaceId)).toEqual(beforeClosure)
      expect(await syncEntries(connection.stub, workspaceId)).toEqual(beforeFeed)
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("create-tag:create-tag-rollback")).toBeNull()
      expect(await native.debugGetLedgerReceipt("create-tag:create-tag-rollback")).toBeNull()
      expect(await native.debugGetLedgerEvent("create-tag:create-tag-rollback")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("create-tag:create-tag-rollback")).toBeNull()
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
      connection.stub[Symbol.dispose]()
    }
  })

  it("fails closed for anonymous callers before graph or ledger mutation", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const error = await rejectionToDomainError(stub.createTag(Schema.encodeSync(CreateTagInput)(tagInput({
        workspaceId,
        name: "Anonymous Tag",
        requestId: "create-tag-anonymous"
      }))))
      expect(error._tag).toBe("Unauthorized")
      expect((await graphTags(stub, workspaceId)).filter((row) => (row as { name?: string }).name === "Anonymous Tag")).toHaveLength(0)
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("create-tag:create-tag-anonymous")).toBeNull()
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("rejects blank rationale and malformed attribution before opening the ledger transaction", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`create-tag-input-guard-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const blankMessage = await rejectionToDomainError(connection.stub.createTag(Schema.encodeSync(CreateTagInput)(tagInput({
        workspaceId,
        name: "Blank Rationale",
        requestId: "create-tag-blank-message",
        commitMessage: "   "
      }))))
      expect(blankMessage._tag).toBe("ValidationError")

      const malformedAttribution = await rejectionToDomainError(connection.stub.createTag({
        workspaceId,
        name: "Malformed Attribution",
        parentIds: [],
        requestId: "create-tag-malformed-attribution",
        commitMessage: "Define this tag.",
        attribution: {
          version: "athenaeum.mutation-attribution.v1",
          kind: "humanUi",
          surface: "unknown-surface"
        }
      }))
      expect(malformedAttribution._tag).toBe("ValidationError")
      expect((await graphTags(connection.stub, workspaceId)).filter((row) => (row as { name?: string }).name === "Blank Rationale" || (row as { name?: string }).name === "Malformed Attribution")).toHaveLength(0)
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("create-tag:create-tag-blank-message")).toBeNull()
      expect(await native.debugGetLedgerCommand("create-tag:create-tag-malformed-attribution")).toBeNull()
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })
})

describe("createTag ledger fingerprint", () => {
  it("changes for every semantic field while ignoring generated identity and time", () => {
    const base = {
      requestIdentity: "create-tag:fingerprint",
      requestId: "fingerprint",
      fingerprint: "",
      workspaceId: freshWorkspaceId(),
      principal: "owner@example.com",
      policy: "governed-role-v1",
      name: "Project",
      parentIds: [BaseTagIds.Person],
      commitMessage: "Define the Project Supertag.",
      attribution: tagAttribution(),
      createdAt: "2026-01-01T00:00:00.000Z"
    }
    const fingerprint = (change: Record<string, unknown> = {}) => createTagLedgerFingerprint({ ...base, ...change })
    const expectedDistinct = [
      fingerprint(),
      fingerprint({ requestId: "other-request" }),
      fingerprint({ workspaceId: freshWorkspaceId() }),
      fingerprint({ principal: "other@example.com" }),
      fingerprint({ policy: "ungoverned-authenticated-v1" }),
      fingerprint({ name: "Other Project" }),
      fingerprint({ parentIds: [] }),
      fingerprint({ parentIds: [BaseTagIds.Person, BaseTagIds.Person] }),
      fingerprint({ commitMessage: "A different reason." }),
      fingerprint({ attribution: new HumanUiMutationAttribution({
        version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos"
      }) })
    ]
    expect(new Set(expectedDistinct).size).toBe(expectedDistinct.length)
    expect(fingerprint({ createdAt: "2027-01-01T00:00:00.000Z", requestIdentity: "create-tag:other" })).toBe(fingerprint())
  })
})
