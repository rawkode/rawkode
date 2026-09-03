import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { ledgerExecuteTestHook } from "../src/ledger-service.js"
import {
  CreateNodeInput,
  CreateNodeWithIntentInput,
  CreateNodeOutput,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListNodesInput,
  ListNodesOutput,
  ListRecentLedgerActivityOutput,
  SyncFeedInput,
  SyncFeedOutput
} from "@athenaeum/domain"
import {
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshNodeId,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

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

    const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await stub.listRecentLedgerActivity({ workspaceId, limit: 10 }))
    expect(activity.entries).toEqual([expect.objectContaining({
      type: "createNode",
      actor: "anonymous",
      message: "Create node to record Ledger node."
    })])
    expect(Object.keys(activity.entries[0] ?? {})).toEqual(["occurredAt", "type", "actor", "message"])
    expect(activity.entries[0]?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const occurredAt = activity.entries[0]!.occurredAt
    const activityEnd = new Date(Date.parse(occurredAt) + 1).toISOString()
    const bounded = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(
      await stub.listRecentLedgerActivity({ workspaceId, limit: 10, from: occurredAt, to: activityEnd })
    )
    expect(bounded.entries).toHaveLength(1)

    const futureFrom = activityEnd
    const futureTo = new Date(Date.parse(futureFrom) + 1_000).toISOString()
    const future = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(
      await stub.listRecentLedgerActivity({ workspaceId, limit: 10, from: futureFrom, to: futureTo })
    )
    expect(future.entries).toEqual([])
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

describe("createNodeWithIntent strict workspace ledger", () => {
  let stub: Awaited<ReturnType<typeof connectToWorkspaceWithSocketAs>>["stub"] | undefined

  afterEach(() => { stub?.[Symbol.dispose](); stub = undefined })

  const connectAsUser = async (workspaceId: ReturnType<typeof freshWorkspaceId>) => {
    const identity = `strict-node-${crypto.randomUUID()}@example.com`
    const { credential, email } = await devSignIn(identity)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    stub = connection.stub
    return { email }
  }

  const inputFor = (workspaceId: ReturnType<typeof freshWorkspaceId>, requestId: string, title: string, id?: ReturnType<typeof freshNodeId>) =>
    Schema.encodeSync(CreateNodeWithIntentInput)(new CreateNodeWithIntentInput({
      workspaceId,
      ...(id === undefined ? {} : { id }),
      title,
      requestId,
      commitMessage: "Record the new entity for the workspace.",
      attribution: new HumanUiMutationAttribution({
        version: "athenaeum.mutation-attribution.v1",
        kind: "humanUi",
        surface: "macos"
      })
    }))

  it("requires authentication and records caller rationale and attribution", async () => {
    const workspaceId = freshWorkspaceId()
    const anonymous = await connectToWorkspace(workspaceId)
    const anonymousError = await rejectionToDomainError(
      anonymous.createNodeWithIntent(inputFor(workspaceId, "anonymous-create", "No anonymous writes"))
    )
    anonymous[Symbol.dispose]()
    expect(anonymousError._tag).toBe("Unauthorized")

    const { email } = await connectAsUser(workspaceId)
    const requestId = "  strict-create-1  "
    const nodeId = freshNodeId()
    const first = Schema.decodeUnknownSync(CreateNodeOutput)(
      await stub!.createNodeWithIntent(inputFor(workspaceId, requestId, "  Strict   node  ", nodeId))
    )
    const replay = Schema.decodeUnknownSync(CreateNodeOutput)(
      await stub!.createNodeWithIntent(inputFor(workspaceId, requestId, "  Strict   node  ", nodeId))
    )
    expect(replay).toEqual(first)
    expect(first.node.title).toBe("Strict node")

    const native = workspaceDurableObjectStub(workspaceId)
    const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand("create-node-with-intent:strict-create-1"))
    expect(command).toMatchObject({
      type: "createNodeWithIntent",
      principal: email,
      message: "Record the new entity for the workspace.",
      payload: { nodeId, title: "Strict node" }
    })
    const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(
      await stub!.listRecentLedgerActivity({ workspaceId, limit: 10 })
    )
    expect(activity.entries[0]).toMatchObject({
      type: "createNodeWithIntent",
      actor: "you",
      message: "Record the new entity for the workspace."
    })
  })

  it("never overwrites an explicit identity and rolls back all artifacts on failure", async () => {
    const workspaceId = freshWorkspaceId()
    await connectAsUser(workspaceId)
    const nodeId = freshNodeId()
    await stub!.createNodeWithIntent(inputFor(workspaceId, "strict-create-collision-1", "Original", nodeId))

    const collision = await rejectionToDomainError(
      stub!.createNodeWithIntent(inputFor(workspaceId, "strict-create-collision-2", "Replacement", nodeId))
    )
    expect(collision).toMatchObject({ _tag: "NodeAlreadyExists", nodeId })

    const rollbackId = freshNodeId()
    const native = workspaceDurableObjectStub(workspaceId)
    ledgerExecuteTestHook.afterMutation = () => { throw new Error("strict create rollback") }
    try {
      const failure = await rejectionToDomainError(
        stub!.createNodeWithIntent(inputFor(workspaceId, "strict-create-rollback", "Rolled back", rollbackId))
      )
      expect(failure._tag).toBe("UnexpectedError")
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
    }

    expect(await native.debugGetLedgerCommand("create-node-with-intent:strict-create-rollback")).toBeNull()
    expect(await native.debugGetLedgerReceipt("create-node-with-intent:strict-create-rollback")).toBeNull()
    expect(await rejectionToDomainError(stub!.getNode({ workspaceId, nodeId: rollbackId }))).toMatchObject({
      _tag: "NodeNotFound",
      nodeId: rollbackId
    })
  })
})
