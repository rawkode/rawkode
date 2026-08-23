import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { CreateNodeInput, CreateNodeOutput, LedgerCommand, ListNodesInput, ListNodesOutput, SyncFeedInput, SyncFeedOutput } from "@athenaeum/domain"
import { connectToWorkspace, freshNodeId, freshWorkspaceId, rejectionToDomainError, workspaceDurableObjectStub } from "./support.js"

describe("createNode transitional workspace ledger", () => {
  let stub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => { stub?.[Symbol.dispose](); stub = undefined })

  it("atomically records an immutable command/receipt while retaining the exact public createNode output", async () => {
    const workspaceId = freshWorkspaceId()
    const nodeId = freshNodeId()
    stub = await connectToWorkspace(workspaceId)
    const input = Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, id: nodeId, title: "  Ledger   node  " }))

    const first = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(input))
    const replay = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(input))
    expect(replay).toEqual(first)

    const receipt = await workspaceDurableObjectStub(workspaceId).debugGetLedgerReceipt(`node:${nodeId}`)
    expect(receipt).toMatchObject({ output: Schema.encodeSync(CreateNodeOutput)(first) })
    const storedCommand = await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand(`node:${nodeId}`)
    const command = Schema.decodeUnknownSync(LedgerCommand)(storedCommand)
    expect(command).toMatchObject({
      principal: "anonymous", capability: "build", policy: "ungoverned-open-v1", message: "Create node to record Ledger node."
    })

    const nodes = Schema.decodeUnknownSync(ListNodesOutput)(
      await stub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    )
    expect(nodes.nodes).toEqual([first.node])
    const feed = Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed({ workspaceId, limit: 10 }))
    expect(feed.entries.filter((entry) => entry.entityId === nodeId)).toHaveLength(1)
  })

  it("rejects a reused explicit node identity when its canonical command fingerprint differs", async () => {
    const workspaceId = freshWorkspaceId()
    const nodeId = freshNodeId()
    stub = await connectToWorkspace(workspaceId)
    await stub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, id: nodeId, title: "first" })))
    const error = await rejectionToDomainError(
      stub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, id: nodeId, title: "second" })))
    )
    expect(error._tag).toBe("ValidationError")
  })
})
