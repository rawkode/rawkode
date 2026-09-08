import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  AssignTagInput,
  AssignTagLedgerCommand,
  AssignTagOutput,
  BaseTagIds,
  CreateNodeInput,
  CreateNodeOutput,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListRecentLedgerActivityOutput,
  RunViewInput,
  RunViewOutput,
  SyncFeedInput,
  SyncFeedOutput,
  UnassignTagInput,
  UnassignTagLedgerCommand,
  UnassignTagOutput,
  ViewSpec,
  type EntityId
} from "@athenaeum/domain"
import { assignTagLedgerFingerprint, ledgerExecuteTestHook, unassignTagLedgerFingerprint } from "../src/ledger-service.js"
import {
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

const attribution = (surface: "web-graph-view" | "rich-text-editor" = "web-graph-view") => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface
})

const assignInput = (workspaceId: EntityId, nodeId: EntityId, tagId: EntityId, requestId: string, commitMessage = "Assign this Supertag for the daily graph.") => new AssignTagInput({
  workspaceId, nodeId, tagId, requestId, commitMessage, attribution: attribution()
})

const unassignInput = (workspaceId: EntityId, nodeId: EntityId, tagId: EntityId, requestId: string, commitMessage = "Remove this Supertag from the daily graph.") => new UnassignTagInput({
  workspaceId, nodeId, tagId, requestId, commitMessage, attribution: attribution()
})

const graphNodeTags = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(RunViewOutput)(await stub.runView(Schema.encodeSync(RunViewInput)(new RunViewInput({
    workspaceId,
    viewName: "graph_node_tags",
    viewSpec: new ViewSpec({ view: "table", visibleColumns: ["nodeId", "tagId"], rowLimit: 100 })
  })))).rows

const syncEntries = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(
    Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
  )).entries

const createNode = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId, title: string) =>
  Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
    Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title }))
  )).node

describe.sequential("assignTag and unassignTag ledger authority slice", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
  })

  it("records private provenance, exact replay, and one membership transition", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential, email } = await devSignIn(`assign-tag-ledger-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const node = await createNode(connection.stub, workspaceId, "Ledger membership")
      const input = Schema.encodeSync(AssignTagInput)(assignInput(workspaceId, node.id, BaseTagIds.Person, "assign-tag-ledger-1", "Keep this person membership for relationship context."))
      const first = Schema.decodeUnknownSync(AssignTagOutput)(await connection.stub.assignTag(input))
      const replay = Schema.decodeUnknownSync(AssignTagOutput)(await connection.stub.assignTag(input))
      expect(first).toEqual({ nodeId: node.id, tagId: BaseTagIds.Person, changed: true })
      expect(replay).toEqual(first)

      const native = workspaceDurableObjectStub(workspaceId)
      const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand("assign-tag:assign-tag-ledger-1"))
      expect(command).toMatchObject({
        type: "assignTag",
        principal: email,
        message: "Requested a Supertag membership.",
        payload: {
          nodeId: node.id,
          tagId: BaseTagIds.Person,
          commitMessage: "Keep this person membership for relationship context.",
          attribution: { kind: "humanUi", surface: "web-graph-view" }
        }
      })
      expect((command as AssignTagLedgerCommand).message).not.toContain("relationship context")
      expect(await native.debugGetLedgerReceipt("assign-tag:assign-tag-ledger-1")).toMatchObject({
        output: { version: "athenaeum.workspace-ledger-receipt.v2", type: "assignTag", output: { changed: true } }
      })
      const payload = { nodeId: node.id, tagId: BaseTagIds.Person, changed: true }
      expect(await native.debugGetLedgerEvent("assign-tag:assign-tag-ledger-1")).toEqual({ kind: "assign-tag", payload })
      expect(await native.debugGetLedgerOutboxIntent("assign-tag:assign-tag-ledger-1")).toEqual({ kind: "assign-tag", payload })
      expect((await graphNodeTags(connection.stub, workspaceId)).filter((row) => (row as { nodeId?: string }).nodeId === node.id)).toEqual([
        { nodeId: node.id, tagId: BaseTagIds.Person }
      ])
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "nodeTag" && entry.entityId === node.id)).toHaveLength(1)

      const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await connection.stub.listRecentLedgerActivity({ workspaceId, limit: 10 }))
      expect(activity.entries.find((entry) => entry.type === "assignTag")).toEqual({
        occurredAt: expect.any(String), type: "assignTag", actor: "you", message: "Requested a Supertag membership."
      })
      expect(JSON.stringify(activity)).not.toContain("relationship context")
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("records a changed:false assignment without duplicate membership, feed, event, or outbox rows", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`assign-tag-noop-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const node = await createNode(connection.stub, workspaceId, "Already tagged")
      const first = Schema.decodeUnknownSync(AssignTagOutput)(await connection.stub.assignTag(Schema.encodeSync(AssignTagInput)(assignInput(
        workspaceId, node.id, BaseTagIds.Person, "assign-tag-noop-first"
      ))))
      const secondRequest = "assign-tag-noop-second"
      const second = Schema.decodeUnknownSync(AssignTagOutput)(await connection.stub.assignTag(Schema.encodeSync(AssignTagInput)(assignInput(
        workspaceId, node.id, BaseTagIds.Person, secondRequest
      ))))
      expect(first.changed).toBe(true)
      expect(second.changed).toBe(false)
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "nodeTag")).toHaveLength(1)
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand(`assign-tag:${secondRequest}`)).not.toBeNull()
      expect(await native.debugGetLedgerReceipt(`assign-tag:${secondRequest}`)).toMatchObject({ output: { output: { changed: false } } })
      expect(await native.debugGetLedgerEvent(`assign-tag:${secondRequest}`)).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent(`assign-tag:${secondRequest}`)).toBeNull()
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("removes present membership and makes absent removal a truthful auditable no-op", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`unassign-tag-ledger-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const node = await createNode(connection.stub, workspaceId, "Membership removal")
      await connection.stub.assignTag(Schema.encodeSync(AssignTagInput)(assignInput(workspaceId, node.id, BaseTagIds.Person, "unassign-seed")))
      const removeRequest = "unassign-tag-present"
      const removed = Schema.decodeUnknownSync(UnassignTagOutput)(await connection.stub.unassignTag(Schema.encodeSync(UnassignTagInput)(unassignInput(
        workspaceId, node.id, BaseTagIds.Person, removeRequest, "Remove this person membership after the relationship ends."
      ))))
      expect(removed).toEqual({ nodeId: node.id, tagId: BaseTagIds.Person, changed: true })
      expect((await graphNodeTags(connection.stub, workspaceId)).filter((row) => (row as { nodeId?: string }).nodeId === node.id)).toEqual([])

      const absentRequest = "unassign-tag-absent"
      const absent = Schema.decodeUnknownSync(UnassignTagOutput)(await connection.stub.unassignTag(Schema.encodeSync(UnassignTagInput)(unassignInput(
        workspaceId, node.id, BaseTagIds.Person, absentRequest
      ))))
      expect(absent.changed).toBe(false)
      const feed = (await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "nodeTag" && entry.entityId === node.id)
      expect(feed).toHaveLength(2)
      expect(feed.map((entry) => entry.operation)).toEqual(["put", "delete"])

      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerEvent(`unassign-tag:${removeRequest}`)).toEqual({
        kind: "unassign-tag", payload: { nodeId: node.id, tagId: BaseTagIds.Person, changed: true }
      })
      expect(await native.debugGetLedgerOutboxIntent(`unassign-tag:${removeRequest}`)).toEqual({
        kind: "unassign-tag", payload: { nodeId: node.id, tagId: BaseTagIds.Person, changed: true }
      })
      expect(await native.debugGetLedgerCommand(`unassign-tag:${absentRequest}`)).not.toBeNull()
      expect(await native.debugGetLedgerReceipt(`unassign-tag:${absentRequest}`)).toMatchObject({ output: { output: { changed: false } } })
      expect(await native.debugGetLedgerEvent(`unassign-tag:${absentRequest}`)).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent(`unassign-tag:${absentRequest}`)).toBeNull()
      const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand(`unassign-tag:${removeRequest}`))
      expect((command as UnassignTagLedgerCommand).message).toBe("Requested removal of a Supertag membership.")
      expect((command as UnassignTagLedgerCommand).message).not.toContain("relationship ends")
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("replays a changed removal after the membership is gone and serializes distinct assignments", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`assign-tag-concurrency-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const node = await createNode(connection.stub, workspaceId, "Concurrent membership")
      const firstInput = Schema.encodeSync(AssignTagInput)(assignInput(workspaceId, node.id, BaseTagIds.Person, "assign-concurrent-a"))
      const secondInput = Schema.encodeSync(AssignTagInput)(assignInput(workspaceId, node.id, BaseTagIds.Person, "assign-concurrent-b"))
      const [first, second] = await Promise.all([connection.stub.assignTag(firstInput), connection.stub.assignTag(secondInput)])
      const outputs = [Schema.decodeUnknownSync(AssignTagOutput)(first), Schema.decodeUnknownSync(AssignTagOutput)(second)]
      expect(outputs.filter((output) => output.changed)).toHaveLength(1)
      expect(outputs.filter((output) => !output.changed)).toHaveLength(1)
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "nodeTag")).toHaveLength(1)

      const removalInput = Schema.encodeSync(UnassignTagInput)(unassignInput(workspaceId, node.id, BaseTagIds.Person, "unassign-replay"))
      const removed = Schema.decodeUnknownSync(UnassignTagOutput)(await connection.stub.unassignTag(removalInput))
      const replay = Schema.decodeUnknownSync(UnassignTagOutput)(await connection.stub.unassignTag(removalInput))
      expect(removed.changed).toBe(true)
      expect(replay).toEqual(removed)
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "nodeTag")).toHaveLength(2)
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rolls back membership and every ledger row after a post-mutation failure", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`assign-tag-rollback-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const node = await createNode(connection.stub, workspaceId, "Rollback membership")
      const before = await syncEntries(connection.stub, workspaceId)
      ledgerExecuteTestHook.afterMutation = () => { throw new Error("assignTag ledger failpoint") }
      const error = await rejectionToDomainError(connection.stub.assignTag(Schema.encodeSync(AssignTagInput)(assignInput(
        workspaceId, node.id, BaseTagIds.Person, "assign-tag-rollback"
      ))))
      expect(error._tag).toBe("UnexpectedError")
      ledgerExecuteTestHook.afterMutation = undefined
      expect(await graphNodeTags(connection.stub, workspaceId)).toEqual([])
      expect(await syncEntries(connection.stub, workspaceId)).toEqual(before)
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("assign-tag:assign-tag-rollback")).toBeNull()
      expect(await native.debugGetLedgerReceipt("assign-tag:assign-tag-rollback")).toBeNull()
      expect(await native.debugGetLedgerEvent("assign-tag:assign-tag-rollback")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("assign-tag:assign-tag-rollback")).toBeNull()
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
      connection.stub[Symbol.dispose]()
    }
  })

  it("rolls back an unassign and every ledger row after a post-mutation failure", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`unassign-tag-rollback-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const node = await createNode(connection.stub, workspaceId, "Rollback removal")
      await connection.stub.assignTag(Schema.encodeSync(AssignTagInput)(assignInput(
        workspaceId, node.id, BaseTagIds.Person, "unassign-rollback-seed"
      )))
      const before = await syncEntries(connection.stub, workspaceId)
      ledgerExecuteTestHook.afterMutation = () => { throw new Error("unassignTag ledger failpoint") }
      const error = await rejectionToDomainError(connection.stub.unassignTag(Schema.encodeSync(UnassignTagInput)(unassignInput(
        workspaceId, node.id, BaseTagIds.Person, "unassign-tag-rollback"
      ))))
      expect(error._tag).toBe("UnexpectedError")
      ledgerExecuteTestHook.afterMutation = undefined
      expect((await graphNodeTags(connection.stub, workspaceId)).filter((row) => (row as { nodeId?: string }).nodeId === node.id)).toEqual([
        { nodeId: node.id, tagId: BaseTagIds.Person }
      ])
      expect(await syncEntries(connection.stub, workspaceId)).toEqual(before)
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("unassign-tag:unassign-tag-rollback")).toBeNull()
      expect(await native.debugGetLedgerReceipt("unassign-tag:unassign-tag-rollback")).toBeNull()
      expect(await native.debugGetLedgerEvent("unassign-tag:unassign-tag-rollback")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("unassign-tag:unassign-tag-rollback")).toBeNull()
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
      connection.stub[Symbol.dispose]()
    }
  })

  it("fails anonymous and malformed input before graph or ledger mutation", async () => {
    const workspaceId = freshWorkspaceId()
    const anonymous = await connectToWorkspace(workspaceId)
    try {
      const node = await createNode(anonymous, workspaceId, "Anonymous membership")
      const error = await rejectionToDomainError(anonymous.assignTag(Schema.encodeSync(AssignTagInput)(assignInput(
        workspaceId, node.id, BaseTagIds.Person, "assign-tag-anonymous"
      ))))
      expect(error._tag).toBe("Unauthorized")
      expect(await graphNodeTags(anonymous, workspaceId)).toEqual([])
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("assign-tag:assign-tag-anonymous")).toBeNull()
    } finally {
      anonymous[Symbol.dispose]()
    }

    const { credential } = await devSignIn(`assign-tag-guard-${crypto.randomUUID()}@example.com`)
    const guarded = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const node = await createNode(guarded.stub, workspaceId, "Input guard")
      const blank = await rejectionToDomainError(guarded.stub.assignTag(Schema.encodeSync(AssignTagInput)(assignInput(
        workspaceId, node.id, BaseTagIds.Person, "assign-tag-blank", "   "
      ))))
      expect(blank._tag).toBe("ValidationError")
      const malformed = await rejectionToDomainError(guarded.stub.unassignTag({
        workspaceId, nodeId: node.id, tagId: BaseTagIds.Person,
        requestId: "unassign-tag-malformed", commitMessage: "Remove it.",
        attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "unknown" }
      }))
      expect(malformed._tag).toBe("ValidationError")
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("assign-tag:assign-tag-blank")).toBeNull()
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("unassign-tag:unassign-tag-malformed")).toBeNull()
    } finally {
      guarded.stub[Symbol.dispose]()
      guarded.socket.close()
    }
  })
})

describe("assignTag and unassignTag ledger fingerprints", () => {
  it("change for semantic fields while ignoring generated identity and time", () => {
    const base = {
      requestIdentity: "assign-tag:fingerprint",
      requestId: "fingerprint",
      fingerprint: "",
      workspaceId: freshWorkspaceId(),
      principal: "owner@example.com",
      policy: "governed-role-v1",
      nodeId: freshWorkspaceId(),
      tagId: BaseTagIds.Person,
      commitMessage: "Assign this membership.",
      attribution: attribution(),
      createdAt: "2026-01-01T00:00:00.000Z"
    }
    const assign = (change: Record<string, unknown> = {}) => assignTagLedgerFingerprint({ ...base, ...change })
    const unassign = (change: Record<string, unknown> = {}) => unassignTagLedgerFingerprint({ ...base, ...change })
    expect(new Set([
      assign(),
      assign({ requestId: "other" }),
      assign({ workspaceId: freshWorkspaceId() }),
      assign({ principal: "other@example.com" }),
      assign({ policy: "ungoverned-authenticated-v1" }),
      assign({ nodeId: freshWorkspaceId() }),
      assign({ tagId: BaseTagIds.Task }),
      assign({ commitMessage: "Other reason." }),
      assign({ attribution: attribution("rich-text-editor") })
    ]).size).toBe(9)
    expect(assign({ createdAt: "2027-01-01T00:00:00.000Z", requestIdentity: "assign-tag:other" })).toBe(assign())
    expect(unassign()).not.toBe(assign())
  })
})
