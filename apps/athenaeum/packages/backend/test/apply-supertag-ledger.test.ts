import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  ApplySupertagFieldValue,
  ApplySupertagInput,
  ApplySupertagOutput,
  BaseTagFieldIds,
  BaseTagIds,
  CreateNodeInput,
  CreateNodeOutput,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListRecentLedgerActivityOutput,
  RunViewInput,
  RunViewOutput,
  SyncFeedOutput,
  SyncFeedInput,
  ViewSpec
} from "@athenaeum/domain"
import { ledgerExecuteTestHook } from "../src/ledger-service.js"
import {
  connectToWorkspace,
  freshNodeId,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

const humanAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface: "rich-text-editor"
})

const applyInput = (workspaceId: string, nodeId: string, requestId: string, fieldValues: ReadonlyArray<ApplySupertagFieldValue> = []) =>
  Schema.encodeSync(ApplySupertagInput)(new ApplySupertagInput({
    workspaceId,
    nodeId,
    tagId: BaseTagIds.Person,
    requestId,
    commitMessage: "Record the person context from the note.",
    attribution: humanAttribution(),
    fieldValues
  }))

const hasTagRows = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: string) =>
  Schema.decodeUnknownSync(RunViewOutput)(await stub.runView(Schema.encodeSync(RunViewInput)(new RunViewInput({
    workspaceId,
    viewName: "graph_nodes",
    viewSpec: new ViewSpec({
      filter: { op: "hasTag", tagId: BaseTagIds.Person },
      view: "table",
      visibleColumns: ["id"],
      rowLimit: 50
    })
  })))).rows

describe.sequential("applySupertag ledger authority slice", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
  })

  it("records a private attributed command, v2 replay receipt, safe side effects, and public activity", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const node = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Ada Lovelace" }))
      )).node
      const input = applyInput(workspaceId, node.id, "person-ledger-1", [
        new ApplySupertagFieldValue({ fieldId: BaseTagFieldIds.PersonRole, value: "Mathematician" })
      ])

      const first = Schema.decodeUnknownSync(ApplySupertagOutput)(await stub.applySupertag(input))
      const replay = Schema.decodeUnknownSync(ApplySupertagOutput)(await stub.applySupertag(input))
      expect(replay).toEqual(first)

      const native = workspaceDurableObjectStub(workspaceId)
      const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand("apply-supertag:person-ledger-1"))
      expect(command).toMatchObject({
        type: "applySupertag",
        message: "Applied Supertag to a workspace node.",
        payload: {
          nodeId: node.id,
          tagId: BaseTagIds.Person,
          commitMessage: "Record the person context from the note.",
          attribution: { kind: "humanUi", surface: "rich-text-editor" }
        }
      })
      const receipt = await native.debugGetLedgerReceipt("apply-supertag:person-ledger-1")
      expect(receipt).toMatchObject({ output: { version: "athenaeum.workspace-ledger-receipt.v2", type: "applySupertag" } })
      expect(Schema.decodeUnknownSync(ApplySupertagOutput)((receipt as { output: { output: unknown } }).output.output)).toEqual(first)
      expect(await native.debugGetLedgerEvent("apply-supertag:person-ledger-1")).toMatchObject({
        kind: "apply-supertag",
        payload: { nodeId: node.id, tagId: BaseTagIds.Person, factIds: [first.facts[0]?.id] }
      })
      expect(await native.debugGetLedgerOutboxIntent("apply-supertag:person-ledger-1")).toMatchObject({
        kind: "apply-supertag",
        payload: { nodeId: node.id, tagId: BaseTagIds.Person }
      })

      const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await stub.listRecentLedgerActivity({ workspaceId, limit: 10 }))
      expect(activity.entries[0]).toEqual(expect.objectContaining({
        type: "applySupertag",
        actor: "anonymous",
        message: "Applied Supertag to a workspace node."
      }))
      expect(Object.keys(activity.entries[0] ?? {})).toEqual(["occurredAt", "type", "actor", "message"])
      expect(JSON.stringify(activity.entries[0])).not.toContain("person-ledger-1")
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("rejects duplicate field ids before any graph or ledger write", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const node = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Duplicate guard" }))
      )).node
      const duplicate = new ApplySupertagFieldValue({ fieldId: BaseTagFieldIds.PersonRole, value: "first" })
      const duplicateAgain = new ApplySupertagFieldValue({ fieldId: BaseTagFieldIds.PersonRole, value: "second" })
      const error = await rejectionToDomainError(stub.applySupertag(applyInput(workspaceId, node.id, "duplicate-fields-1", [duplicate, duplicateAgain])))
      expect(error._tag).toBe("ValidationError")
      expect(await hasTagRows(stub, workspaceId)).toEqual([])
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("apply-supertag:duplicate-fields-1")).toBeNull()
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("rolls back graph, feed, command, receipt, event, and outbox when execution fails after mutation", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const node = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Rollback guard" }))
      )).node
      const before = Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 50 }))
      )).entries
      ledgerExecuteTestHook.afterMutation = () => { throw new Error("ledger failpoint") }
      const error = await rejectionToDomainError(stub.applySupertag(applyInput(workspaceId, node.id, "rollback-1")))
      expect(error._tag).toBe("UnexpectedError")
      ledgerExecuteTestHook.afterMutation = undefined

      expect(await hasTagRows(stub, workspaceId)).toEqual([])
      const after = Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 50 }))
      )).entries
      expect(after).toEqual(before)
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("apply-supertag:rollback-1")).toBeNull()
      expect(await native.debugGetLedgerReceipt("apply-supertag:rollback-1")).toBeNull()
      expect(await native.debugGetLedgerEvent("apply-supertag:rollback-1")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("apply-supertag:rollback-1")).toBeNull()
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
      stub[Symbol.dispose]()
    }
  })

  it("treats a changed payload on a reused request id as a conflict without a second write", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const node = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Conflict guard" }))
      )).node
      const first = applyInput(workspaceId, node.id, "conflict-1")
      await stub.applySupertag(first)
      const changed = Schema.encodeSync(ApplySupertagInput)(new ApplySupertagInput({
        workspaceId,
        nodeId: node.id,
        tagId: BaseTagIds.Person,
        requestId: "conflict-1",
        commitMessage: "A different reason.",
        attribution: humanAttribution(),
        fieldValues: []
      }))
      const error = await rejectionToDomainError(stub.applySupertag(changed))
      expect(error._tag).toBe("ValidationError")
      expect((await hasTagRows(stub, workspaceId)).filter((row) => (row as { id?: string }).id === node.id)).toHaveLength(1)
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("preserves typed graph failures through the ledger transaction boundary", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const missingNodeError = await rejectionToDomainError(stub.applySupertag(applyInput(workspaceId, freshNodeId(), "missing-node-1")))
      expect(missingNodeError._tag).toBe("NodeNotFound")

      const node = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Missing tag guard" }))
      )).node
      const missingTagError = await rejectionToDomainError(stub.applySupertag(Schema.encodeSync(ApplySupertagInput)(new ApplySupertagInput({
        workspaceId,
        nodeId: node.id,
        tagId: freshNodeId(),
        requestId: "missing-tag-1",
        commitMessage: "Attempt a missing tag.",
        attribution: humanAttribution(),
        fieldValues: []
      }))))
      expect(missingTagError._tag).toBe("TagNotFound")
    } finally {
      stub[Symbol.dispose]()
    }
  })
})
