import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  CreateEdgeInput,
  CreateEdgeOutput,
  CreateNodeInput,
  CreateNodeOutput,
  CreateRelationDefinitionInput,
  CreateRelationDefinitionOutput,
  CreateEdgeLedgerCommand,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListRecentLedgerActivityOutput,
  RunViewInput,
  RunViewOutput,
  SyncFeedInput,
  SyncFeedOutput,
  BaseTagIds,
  type EntityId,
  ViewSpec
} from "@athenaeum/domain"
import { createEdgeLedgerFingerprint, ledgerExecuteTestHook } from "../src/ledger-service.js"
import {
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

const edgeAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface: "web-backlinks"
})

const edgeInput = (args: {
  readonly workspaceId: EntityId
  readonly relationDefinitionId: EntityId
  readonly sourceNodeId: EntityId
  readonly targetNodeId: EntityId
  readonly requestId: string
  readonly commitMessage?: string
  readonly attribution?: HumanUiMutationAttribution
}) => new CreateEdgeInput({
  workspaceId: args.workspaceId,
  relationDefinitionId: args.relationDefinitionId,
  sourceNodeId: args.sourceNodeId,
  targetNodeId: args.targetNodeId,
  requestId: args.requestId,
  commitMessage: args.commitMessage ?? "Link the related workspace nodes.",
  attribution: args.attribution ?? edgeAttribution()
})

const graphEdges = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(RunViewOutput)(await stub.runView(Schema.encodeSync(RunViewInput)(new RunViewInput({
    workspaceId,
    viewName: "graph_edges",
    viewSpec: new ViewSpec({
      view: "table",
      visibleColumns: ["id", "relationDefinitionId", "sourceNodeId", "targetNodeId"],
      rowLimit: 50
    })
  })))).rows

const syncEntries = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(
    Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
  )).entries

const setupEdge = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) => {
  const relationDefinition = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(await stub.createRelationDefinition(
    Schema.encodeSync(CreateRelationDefinitionInput)(new CreateRelationDefinitionInput({
      workspaceId,
      forwardName: "relates to",
      inverseName: "related from",
      sourceTagId: BaseTagIds.Person,
      targetTagId: BaseTagIds.Person,
      cardinality: "many-to-many",
      requestId: `create-edge-setup-${crypto.randomUUID()}`,
      commitMessage: "Define the relationship used by this edge test.",
      attribution: new HumanUiMutationAttribution({
        version: "athenaeum.mutation-attribution.v1",
        kind: "humanUi",
        surface: "web-graph-view"
      })
    }))
  )).relationDefinition
  const source = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
    Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Source node" }))
  )).node
  const target = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
    Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Target node" }))
  )).node
  const secondTarget = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
    Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Second target" }))
  )).node
  return { relationDefinition, source, target, secondTarget }
}

describe("createEdge ledger authority slice", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
  })

  it("records private provenance, replays the exact output, and emits one canonical graph side effect", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential, email } = await devSignIn(`create-edge-ledger-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const { relationDefinition, source, target } = await setupEdge(connection.stub, workspaceId)
      const input = Schema.encodeSync(CreateEdgeInput)(edgeInput({
        workspaceId,
        relationDefinitionId: relationDefinition.id,
        sourceNodeId: source.id,
        targetNodeId: target.id,
        requestId: "create-edge-ledger-1",
        commitMessage: "Keep this relationship for the daily standup."
      }))

      const first = Schema.decodeUnknownSync(CreateEdgeOutput)(await connection.stub.createEdge(input))
      const replay = Schema.decodeUnknownSync(CreateEdgeOutput)(await connection.stub.createEdge(input))
      expect(replay).toEqual(first)

      const native = workspaceDurableObjectStub(workspaceId)
      const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand("create-edge:create-edge-ledger-1"))
      expect(command).toMatchObject({
        type: "createEdge",
        principal: email,
        message: "Created a relationship between workspace nodes.",
        payload: {
          relationDefinitionId: relationDefinition.id,
          sourceNodeId: source.id,
          targetNodeId: target.id,
          commitMessage: "Keep this relationship for the daily standup.",
          attribution: { kind: "humanUi", surface: "web-backlinks" }
        }
      })
      expect((command as CreateEdgeLedgerCommand).message).not.toContain("daily standup")
      expect(await native.debugGetLedgerReceipt("create-edge:create-edge-ledger-1")).toMatchObject({
        output: { version: "athenaeum.workspace-ledger-receipt.v2", type: "createEdge" }
      })
      expect(await native.debugGetLedgerEvent("create-edge:create-edge-ledger-1")).toEqual({
        kind: "create-edge",
        payload: {
          edgeId: first.edge.id,
          relationDefinitionId: relationDefinition.id,
          sourceNodeId: source.id,
          targetNodeId: target.id
        }
      })
      expect(await native.debugGetLedgerOutboxIntent("create-edge:create-edge-ledger-1")).toEqual({
        kind: "create-edge",
        payload: {
          edgeId: first.edge.id,
          relationDefinitionId: relationDefinition.id,
          sourceNodeId: source.id,
          targetNodeId: target.id
        }
      })

      expect((await graphEdges(connection.stub, workspaceId)).filter((row) => (row as { id?: string }).id === first.edge.id)).toHaveLength(1)
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "edge" && entry.entityId === first.edge.id)).toHaveLength(1)

      const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await connection.stub.listRecentLedgerActivity({ workspaceId, limit: 10 }))
      const edgeActivity = activity.entries.find((entry) => entry.type === "createEdge")
      expect(edgeActivity).toEqual({
        occurredAt: expect.any(String),
        type: "createEdge",
        actor: "you",
        message: "Created a relationship between workspace nodes."
      })
      expect(JSON.stringify(edgeActivity)).not.toContain("daily standup")
      expect(JSON.stringify(edgeActivity)).not.toContain("create-edge-ledger-1")
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("replays same-request concurrent calls without duplicating the edge or feed entry", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`create-edge-replay-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const { relationDefinition, source, target } = await setupEdge(connection.stub, workspaceId)
      const input = Schema.encodeSync(CreateEdgeInput)(edgeInput({
        workspaceId,
        relationDefinitionId: relationDefinition.id,
        sourceNodeId: source.id,
        targetNodeId: target.id,
        requestId: "create-edge-concurrent-replay"
      }))
      const [first, second] = await Promise.all([
        connection.stub.createEdge(input),
        connection.stub.createEdge(input)
      ])
      const firstOutput = Schema.decodeUnknownSync(CreateEdgeOutput)(first)
      expect(Schema.decodeUnknownSync(CreateEdgeOutput)(second)).toEqual(firstOutput)
      expect((await graphEdges(connection.stub, workspaceId)).filter((row) => (row as { id?: string }).id === firstOutput.edge.id)).toHaveLength(1)
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "edge" && entry.entityId === firstOutput.edge.id)).toHaveLength(1)
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rejects a changed request payload without a second edge or ledger side effect", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`create-edge-conflict-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const { relationDefinition, source, target, secondTarget } = await setupEdge(connection.stub, workspaceId)
      const first = edgeInput({
        workspaceId,
        relationDefinitionId: relationDefinition.id,
        sourceNodeId: source.id,
        targetNodeId: target.id,
        requestId: "create-edge-conflict"
      })
      const firstOutput = Schema.decodeUnknownSync(CreateEdgeOutput)(await connection.stub.createEdge(Schema.encodeSync(CreateEdgeInput)(first)))
      const changed = edgeInput({
        workspaceId,
        relationDefinitionId: relationDefinition.id,
        sourceNodeId: source.id,
        targetNodeId: secondTarget.id,
        requestId: "create-edge-conflict"
      })
      const error = await rejectionToDomainError(connection.stub.createEdge(Schema.encodeSync(CreateEdgeInput)(changed)))
      expect(error._tag).toBe("ValidationError")
      expect((await graphEdges(connection.stub, workspaceId)).filter((row) => (row as { id?: string }).id === firstOutput.edge.id)).toHaveLength(1)
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "edge")).toHaveLength(1)
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("create-edge:create-edge-conflict")).not.toBeNull()
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rolls back the edge, feed, command, receipt, event, and outbox after a post-mutation failure", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`create-edge-rollback-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const { relationDefinition, source, target } = await setupEdge(connection.stub, workspaceId)
      const before = await syncEntries(connection.stub, workspaceId)
      ledgerExecuteTestHook.afterMutation = () => { throw new Error("createEdge ledger failpoint") }
      const error = await rejectionToDomainError(connection.stub.createEdge(Schema.encodeSync(CreateEdgeInput)(edgeInput({
        workspaceId,
        relationDefinitionId: relationDefinition.id,
        sourceNodeId: source.id,
        targetNodeId: target.id,
        requestId: "create-edge-rollback"
      }))))
      expect(error._tag).toBe("UnexpectedError")
      ledgerExecuteTestHook.afterMutation = undefined

      expect(await graphEdges(connection.stub, workspaceId)).toEqual([])
      expect(await syncEntries(connection.stub, workspaceId)).toEqual(before)
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("create-edge:create-edge-rollback")).toBeNull()
      expect(await native.debugGetLedgerReceipt("create-edge:create-edge-rollback")).toBeNull()
      expect(await native.debugGetLedgerEvent("create-edge:create-edge-rollback")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("create-edge:create-edge-rollback")).toBeNull()
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
      connection.stub[Symbol.dispose]()
    }
  })

  it("fails closed for anonymous callers before graph or ledger mutation", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    const { credential } = await devSignIn(`create-edge-anonymous-setup-${crypto.randomUUID()}@example.com`)
    const setupConnection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const { relationDefinition, source, target } = await setupEdge(setupConnection.stub, workspaceId)
      const error = await rejectionToDomainError(stub.createEdge(Schema.encodeSync(CreateEdgeInput)(edgeInput({
        workspaceId,
        relationDefinitionId: relationDefinition.id,
        sourceNodeId: source.id,
        targetNodeId: target.id,
        requestId: "create-edge-anonymous"
      }))))
      expect(error._tag).toBe("Unauthorized")
      expect(await graphEdges(stub, workspaceId)).toEqual([])
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("create-edge:create-edge-anonymous")).toBeNull()
    } finally {
      setupConnection.stub[Symbol.dispose]()
      stub[Symbol.dispose]()
    }
  })

  it("rejects blank rationale and malformed attribution before opening the ledger transaction", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`create-edge-input-guard-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const { relationDefinition, source, target } = await setupEdge(connection.stub, workspaceId)
      const blankMessage = await rejectionToDomainError(connection.stub.createEdge(Schema.encodeSync(CreateEdgeInput)(edgeInput({
        workspaceId,
        relationDefinitionId: relationDefinition.id,
        sourceNodeId: source.id,
        targetNodeId: target.id,
        requestId: "create-edge-blank-message",
        commitMessage: "   "
      }))))
      expect(blankMessage._tag).toBe("ValidationError")

      const malformedAttribution = await rejectionToDomainError(connection.stub.createEdge({
        workspaceId,
        relationDefinitionId: relationDefinition.id,
        sourceNodeId: source.id,
        targetNodeId: target.id,
        requestId: "create-edge-malformed-attribution",
        commitMessage: "Link these nodes.",
        attribution: {
          version: "athenaeum.mutation-attribution.v1",
          kind: "humanUi",
          surface: "unknown-surface"
        }
      }))
      expect(malformedAttribution._tag).toBe("ValidationError")
      expect(await graphEdges(connection.stub, workspaceId)).toEqual([])
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("create-edge:create-edge-blank-message")).toBeNull()
      expect(await native.debugGetLedgerCommand("create-edge:create-edge-malformed-attribution")).toBeNull()
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })
})

describe("createEdge ledger fingerprint", () => {
  it("changes for every semantic command field while ignoring generated identity and time", () => {
    const base = {
      requestIdentity: "create-edge:fingerprint",
      requestId: "fingerprint",
      fingerprint: "",
      workspaceId: freshWorkspaceId(),
      principal: "owner@example.com",
      policy: "governed-role-v1",
      relationDefinitionId: freshWorkspaceId(),
      sourceNodeId: freshWorkspaceId(),
      targetNodeId: freshWorkspaceId(),
      commitMessage: "Link these nodes.",
      attribution: edgeAttribution(),
      createdAt: "2026-01-01T00:00:00.000Z"
    }
    const fingerprint = (change: Record<string, unknown> = {}) => createEdgeLedgerFingerprint({ ...base, ...change })
    const expectedDistinct = [
      fingerprint(),
      fingerprint({ requestId: "other-request" }),
      fingerprint({ workspaceId: freshWorkspaceId() }),
      fingerprint({ principal: "other@example.com" }),
      fingerprint({ policy: "ungoverned-authenticated-v1" }),
      fingerprint({ relationDefinitionId: freshWorkspaceId() }),
      fingerprint({ sourceNodeId: freshWorkspaceId() }),
      fingerprint({ targetNodeId: freshWorkspaceId() }),
      fingerprint({ commitMessage: "A different reason." }),
      fingerprint({ attribution: new HumanUiMutationAttribution({
        version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos"
      }) })
    ]
    expect(new Set(expectedDistinct).size).toBe(expectedDistinct.length)
    expect(fingerprint({ createdAt: "2027-01-01T00:00:00.000Z", requestIdentity: "create-edge:other" })).toBe(fingerprint())
  })
})
