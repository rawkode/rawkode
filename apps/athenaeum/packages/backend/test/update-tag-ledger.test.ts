import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  BaseTagIds,
  CreateTagInput,
  CreateTagOutput,
  GetTagInput,
  GetTagOutput,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListRecentLedgerActivityOutput,
  SyncFeedInput,
  SyncFeedOutput,
  Tag,
  TagRead,
  UpdateTagInput,
  UpdateTagLedgerCommand,
  UpdateTagOutput,
  type EntityId
} from "@athenaeum/domain"
import { ledgerExecuteTestHook } from "../src/ledger-service.js"
import {
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

const attribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface: "web-supertags-manager"
})

const createInput = (workspaceId: EntityId, name: string, requestId: string, parentIds: ReadonlyArray<EntityId> = []) =>
  Schema.encodeSync(CreateTagInput)(new CreateTagInput({
    workspaceId,
    name,
    parentIds,
    requestId,
    commitMessage: "Create the schema fixture for this update test.",
    attribution: attribution()
  }))

const updateInput = (args: {
  readonly workspaceId: EntityId
  readonly tagId: EntityId
  readonly expectedRevision: string
  readonly name: string
  readonly parentIds: ReadonlyArray<EntityId>
  readonly requestId: string
  readonly commitMessage?: string
}) => Schema.encodeSync(UpdateTagInput)(new UpdateTagInput({
  workspaceId: args.workspaceId,
  tagId: args.tagId,
  expectedRevision: args.expectedRevision,
  name: args.name,
  parentIds: args.parentIds,
  requestId: args.requestId,
  commitMessage: args.commitMessage ?? "Keep this Supertag schema current.",
  attribution: attribution()
}))

const getTag = async (stub: Awaited<ReturnType<typeof connectToWorkspaceWithSocketAs>>["stub"], workspaceId: EntityId, tagId: EntityId) =>
  Schema.decodeUnknownSync(GetTagOutput)(await stub.getTag(Schema.encodeSync(GetTagInput)(new GetTagInput({ workspaceId, tagId })))).tag

const syncEntries = async (stub: Awaited<ReturnType<typeof connectToWorkspaceWithSocketAs>>["stub"], workspaceId: EntityId) =>
  Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 200 })))).entries

describe.sequential("updateTag ledger authority slice", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
  })

  it("uses a server revision, records custody, updates the closure, and replays exactly", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential, email } = await devSignIn(`update-tag-ledger-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const created = Schema.decodeUnknownSync(CreateTagOutput)(await connection.stub.createTag(
        createInput(workspaceId, "Project Alpha", "update-tag-create", [BaseTagIds.Person])
      ))
      const before = await getTag(connection.stub, workspaceId, created.tag.id)
      const input = updateInput({
        workspaceId,
        tagId: created.tag.id,
        expectedRevision: before.revision,
        name: "  Project   Alpha Renamed\n",
        parentIds: [BaseTagIds.Project],
        requestId: "update-tag-ledger-1",
        commitMessage: "Align this project schema with delivery reporting."
      })
      const first = Schema.decodeUnknownSync(UpdateTagOutput)(await connection.stub.updateTag(input))
      const replay = Schema.decodeUnknownSync(UpdateTagOutput)(await connection.stub.updateTag(input))
      expect(replay).toEqual(first)
      expect(first.tag.tag).toMatchObject({ id: created.tag.id, name: "Project Alpha Renamed", parentIds: [BaseTagIds.Project], builtin: false })
      expect(first.tag.revision).not.toBe(before.revision)
      expect(await getTag(connection.stub, workspaceId, created.tag.id)).toEqual(first.tag)

      const native = workspaceDurableObjectStub(workspaceId)
      const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand("update-tag:update-tag-ledger-1"))
      expect(command).toMatchObject({
        type: "updateTag",
        principal: email,
        message: "Updated a Supertag definition.",
        payload: {
          tagId: created.tag.id,
          expectedRevision: before.revision,
          name: "Project Alpha Renamed",
          parentIds: [BaseTagIds.Project],
          commitMessage: "Align this project schema with delivery reporting.",
          attribution: { kind: "humanUi", surface: "web-supertags-manager" }
        }
      })
      expect((command as UpdateTagLedgerCommand).message).not.toContain("delivery reporting")
      expect(await native.debugGetLedgerCustody("update-tag:update-tag-ledger-1")).toMatchObject({
        type: "updateTag",
        actorKind: "user",
        actorLabel: "You",
        targetKind: "tag",
        targetId: created.tag.id
      })
      expect(await native.debugGetLedgerEvent("update-tag:update-tag-ledger-1")).toEqual({
        kind: "update-tag",
        payload: { tagId: created.tag.id, revision: first.tag.revision }
      })
      expect(await native.debugGetLedgerOutboxIntent("update-tag:update-tag-ledger-1")).toEqual({
        kind: "update-tag",
        payload: { tagId: created.tag.id, revision: first.tag.revision }
      })

      const tagFeed = (await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "tag" && entry.entityId === created.tag.id)
      expect(tagFeed).toHaveLength(2)
      const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await connection.stub.listRecentLedgerActivity({ workspaceId, limit: 20 }))
      expect(activity.entries.find((entry) => entry.type === "updateTag")).toMatchObject({
        type: "updateTag",
        actor: "you",
        message: "Updated a Supertag definition.",
        target: { kind: "tag", id: created.tag.id }
      })
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rejects stale, duplicate-name, and cyclic edits without changing the tag", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`update-tag-validation-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const first = Schema.decodeUnknownSync(CreateTagOutput)(await connection.stub.createTag(createInput(workspaceId, "First Tag", "update-tag-first")))
      const second = Schema.decodeUnknownSync(CreateTagOutput)(await connection.stub.createTag(createInput(workspaceId, "Second Tag", "update-tag-second")))
      const before = await getTag(connection.stub, workspaceId, first.tag.id)

      const stale = await rejectionToDomainError(connection.stub.updateTag(updateInput({
        workspaceId, tagId: first.tag.id, expectedRevision: "0".repeat(64), name: "Changed Tag", parentIds: [], requestId: "update-tag-stale"
      })))
      expect(stale._tag).toBe("ValidationError")
      expect(stale.message).toContain("changed elsewhere")

      const duplicate = await rejectionToDomainError(connection.stub.updateTag(updateInput({
        workspaceId, tagId: first.tag.id, expectedRevision: before.revision, name: second.tag.name, parentIds: [], requestId: "update-tag-duplicate"
      })))
      expect(duplicate._tag).toBe("ValidationError")
      expect(duplicate.message).toContain("already exists")

      const child = Schema.decodeUnknownSync(CreateTagOutput)(await connection.stub.createTag(createInput(workspaceId, "Child Tag", "update-tag-child", [first.tag.id])))
      const cycle = await rejectionToDomainError(connection.stub.updateTag(updateInput({
        workspaceId, tagId: first.tag.id, expectedRevision: before.revision, name: first.tag.name, parentIds: [child.tag.id], requestId: "update-tag-cycle"
      })))
      expect(cycle._tag).toBe("ValidationError")
      expect(cycle.message).toContain("DAG")
      expect(await getTag(connection.stub, workspaceId, first.tag.id)).toEqual(before)
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rolls back the projection and all ledger artifacts after a post-mutation failure", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`update-tag-rollback-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const created = Schema.decodeUnknownSync(CreateTagOutput)(await connection.stub.createTag(createInput(workspaceId, "Rollback Tag", "update-tag-rollback-create")))
      const before = await getTag(connection.stub, workspaceId, created.tag.id)
      const beforeFeed = await syncEntries(connection.stub, workspaceId)
      const requestId = "update-tag-rollback"
      ledgerExecuteTestHook.afterMutation = () => { throw new Error("updateTag ledger failpoint") }
      const failure = await rejectionToDomainError(connection.stub.updateTag(updateInput({
        workspaceId, tagId: created.tag.id, expectedRevision: before.revision, name: "Rolled Back Tag", parentIds: [BaseTagIds.Task], requestId
      })))
      expect(failure._tag).toBe("UnexpectedError")
      ledgerExecuteTestHook.afterMutation = undefined

      expect(await getTag(connection.stub, workspaceId, created.tag.id)).toEqual(before)
      expect(await syncEntries(connection.stub, workspaceId)).toEqual(beforeFeed)
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand(`update-tag:${requestId}`)).toBeNull()
      expect(await native.debugGetLedgerReceipt(`update-tag:${requestId}`)).toBeNull()
      expect(await native.debugGetLedgerEvent(`update-tag:${requestId}`)).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent(`update-tag:${requestId}`)).toBeNull()
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
      connection.stub[Symbol.dispose]()
    }
  })
})

describe("updateTag ledger revision contract", () => {
  it("round-trips the output schema with the server-issued revision", () => {
    const tag = new TagRead({
      tag: new Tag({ id: BaseTagIds.Project, name: "Project", parentIds: [], builtin: true }),
      revision: "a".repeat(64)
    })
    expect(Schema.decodeUnknownSync(UpdateTagOutput)(Schema.encodeSync(UpdateTagOutput)(new UpdateTagOutput({ tag })))).toEqual(new UpdateTagOutput({ tag }))
  })
})
