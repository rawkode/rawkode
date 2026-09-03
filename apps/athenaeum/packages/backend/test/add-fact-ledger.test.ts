import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  AddFactInput,
  AddFactOutput,
  CreateNodeInput,
  CreateNodeOutput,
  EntityId,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListRecentLedgerActivityOutput,
  RunViewInput,
  RunViewOutput,
  SyncFeedInput,
  SyncFeedOutput,
  ViewSpec
} from "@athenaeum/domain"
import { ledgerExecuteTestHook } from "../src/ledger-service.js"
import {
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

const webFieldAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface: "web-supertag-field-editor"
})

const addFactInput = (workspaceId: string, nodeId: string, requestId: string, value: string, id?: string) =>
  Schema.encodeSync(AddFactInput)(new AddFactInput({
    workspaceId,
    nodeId,
    predicateId: "status",
    value,
    ...(id === undefined ? {} : { id: EntityId.make(id) }),
    requestId,
    commitMessage: "Record the current status.",
    attribution: webFieldAttribution()
  }))

const factRows = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: string) =>
  Schema.decodeUnknownSync(RunViewOutput)(await stub.runView(Schema.encodeSync(RunViewInput)(new RunViewInput({
    workspaceId,
    viewName: "graph_facts",
    viewSpec: new ViewSpec({ view: "table", visibleColumns: ["id", "nodeId", "predicateId", "value"], rowLimit: 50 })
  })))).rows

describe.sequential("addFact ledger authority slice", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
  })

  it("records private provenance, replays the exact output, and emits safe public activity", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential, email } = await devSignIn(`add-fact-ledger-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const stub = connection.stub
      const node = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Ledger fact" }))
      )).node
      const factId = crypto.randomUUID()
      const input = addFactInput(workspaceId, node.id, "add-fact-ledger-1", "done", factId)

      const first = Schema.decodeUnknownSync(AddFactOutput)(await stub.addFact(input))
      const replay = Schema.decodeUnknownSync(AddFactOutput)(await stub.addFact(input))
      expect(replay).toEqual(first)
      expect(first.fact.id).toBe(factId)

      const native = workspaceDurableObjectStub(workspaceId)
      const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand("add-fact:add-fact-ledger-1"))
      expect(command).toMatchObject({
        type: "addFact",
        principal: email,
        message: "Updated a workspace fact.",
        payload: {
          nodeId: node.id,
          predicateId: "status",
          factId,
          commitMessage: "Record the current status.",
          attribution: { kind: "humanUi", surface: "web-supertag-field-editor" }
        }
      })
      const receipt = await native.debugGetLedgerReceipt("add-fact:add-fact-ledger-1")
      expect(receipt).toMatchObject({ output: { version: "athenaeum.workspace-ledger-receipt.v2", type: "addFact" } })
      expect(await native.debugGetLedgerEvent("add-fact:add-fact-ledger-1")).toMatchObject({
        kind: "add-fact",
        payload: { factId }
      })
      expect(await native.debugGetLedgerOutboxIntent("add-fact:add-fact-ledger-1")).toMatchObject({
        kind: "add-fact",
        payload: { factId }
      })

      const feed = Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 50 }))
      ))
      expect(feed.entries.filter((entry) => entry.entityKind === "fact" && entry.entityId === factId)).toHaveLength(1)
      expect(await factRows(stub, workspaceId)).toEqual([expect.objectContaining({ id: factId, value: "\"done\"" })])

      const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await stub.listRecentLedgerActivity({ workspaceId, limit: 10 }))
      expect(activity.entries[0]).toEqual({
        occurredAt: expect.any(String),
        type: "addFact",
        actor: "you",
        message: "Updated a workspace fact."
      })
      expect(Object.keys(activity.entries[0] ?? {})).toEqual(["occurredAt", "type", "actor", "message"])
      const publicJson = JSON.stringify(activity.entries[0])
      expect(publicJson).not.toContain("add-fact-ledger-1")
      expect(publicJson).not.toContain("Record the current status")
      expect(publicJson).not.toContain("web-supertag-field-editor")
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rejects a changed payload on a reused request id without a second graph or feed write", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`add-fact-conflict-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const stub = connection.stub
      const node = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Conflict" }))
      )).node
      await stub.addFact(addFactInput(workspaceId, node.id, "add-fact-conflict-1", "first"))
      const error = await rejectionToDomainError(stub.addFact(addFactInput(workspaceId, node.id, "add-fact-conflict-1", "second")))
      expect(error._tag).toBe("ValidationError")
      expect((await factRows(stub, workspaceId)).filter((row) => (row as { nodeId?: string }).nodeId === node.id)).toHaveLength(1)
      const feed = Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 50 }))
      ))
      expect(feed.entries.filter((entry) => entry.entityKind === "fact")).toHaveLength(1)
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rolls back graph, feed, command, receipt, event, and outbox after a post-mutation failure", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`add-fact-rollback-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const stub = connection.stub
      const node = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Rollback" }))
      )).node
      const before = Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 50 }))
      )).entries
      ledgerExecuteTestHook.afterMutation = () => { throw new Error("addFact ledger failpoint") }
      const error = await rejectionToDomainError(stub.addFact(addFactInput(workspaceId, node.id, "add-fact-rollback-1", "done")))
      expect(error._tag).toBe("UnexpectedError")
      ledgerExecuteTestHook.afterMutation = undefined

      expect(await factRows(stub, workspaceId)).toEqual([])
      expect(Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 50 }))
      )).entries).toEqual(before)
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("add-fact:add-fact-rollback-1")).toBeNull()
      expect(await native.debugGetLedgerReceipt("add-fact:add-fact-rollback-1")).toBeNull()
      expect(await native.debugGetLedgerEvent("add-fact:add-fact-rollback-1")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("add-fact:add-fact-rollback-1")).toBeNull()
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
      connection.stub[Symbol.dispose]()
    }
  })

  it("fails closed for anonymous callers and does not create a ledger record", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const node = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Anonymous guard" }))
      )).node
      const error = await rejectionToDomainError(stub.addFact(addFactInput(workspaceId, node.id, "add-fact-anonymous-1", "done")))
      expect(error._tag).toBe("Unauthorized")
      expect(await factRows(stub, workspaceId)).toEqual([])
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("add-fact:add-fact-anonymous-1")).toBeNull()
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("requires non-blank commit rationale before opening the transaction", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`add-fact-message-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const stub = connection.stub
      const node = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Message guard" }))
      )).node
      const input = Schema.encodeSync(AddFactInput)(new AddFactInput({
        workspaceId,
        nodeId: node.id,
        predicateId: "status",
        value: "done",
        requestId: "add-fact-message-1",
        commitMessage: "   ",
        attribution: webFieldAttribution()
      }))
      const error = await rejectionToDomainError(stub.addFact(input))
      expect(error._tag).toBe("ValidationError")
      expect(await factRows(stub, workspaceId)).toEqual([])
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("add-fact:add-fact-message-1")).toBeNull()
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })
})
