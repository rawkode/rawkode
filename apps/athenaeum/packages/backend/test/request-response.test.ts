// Phase 0 Verify-stage exit criterion #1 (plan §"Verification"): "A real browser session creates
// a node via the web app, round-tripping through Effect → Cap'n Web → WorkspaceDurableObject →
// typed-storage-effect → DO SQLite and back, with Schema.decodeUnknown validation and a
// Data.TaggedError surfaced correctly through the Cap'n Web throw boundary."
//
// This suite exercises the same round trip a browser session would, minus the browser: a real
// Cap'n Web WebSocket session against the real `WorkspaceDurableObject`, reached through the real
// Worker `fetch` handler — see `test/support.ts` for why WebSocket transport is used even for
// plain request/response calls.

import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  CreateNodeInput,
  CreateNodeOutput,
  GetNodeInput,
  GetNodeOutput,
  ListNodesInput,
  ListNodesOutput,
  ListStandupPublicationsInput,
  ListStandupPublicationsOutput
} from "@athenaeum/domain"
import { connectToWorkspace, freshNodeId, freshWorkspaceId, rejectionToDomainError } from "./support.js"

describe("createNode / listNodes round trip", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("creates a node and lists it back, id/timestamp branding intact", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const createInput = new CreateNodeInput({ workspaceId, title: "My first note" })
    const createRaw = await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(createInput))
    const created = Schema.decodeUnknownSync(CreateNodeOutput)(createRaw)

    expect(created.node.title).toBe("My first note")
    expect(created.node.workspaceId).toBe(workspaceId)
    // EntityId's own schema (ULID-or-UUID) validated this by decoding successfully above; assert
    // it's specifically the UUID `crypto.randomUUID()` produces server-side (`workspace-durable-
    // object.ts`'s `createNode`), not merely well-formed.
    expect(created.node.id).toMatch(
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
    )
    expect(() => new Date(created.node.createdAt).toISOString()).not.toThrow()

    const listInput = new ListNodesInput({ workspaceId })
    const listRaw = await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(listInput))
    const listed = Schema.decodeUnknownSync(ListNodesOutput)(listRaw)

    expect(listed.nodes).toHaveLength(1)
    expect(listed.nodes[0]).toEqual(created.node)
  })

  it("accumulates multiple nodes and only lists the requesting workspace's own", async () => {
    const workspaceA = freshWorkspaceId()
    const workspaceB = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceA)
    const stubB = await connectToWorkspace(workspaceB)

    try {
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId: workspaceA, title: "A1" })))
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId: workspaceA, title: "A2" })))
      await stubB.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId: workspaceB, title: "B1" })))

      const listedA = Schema.decodeUnknownSync(ListNodesOutput)(
        await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId: workspaceA })))
      )
      const listedB = Schema.decodeUnknownSync(ListNodesOutput)(
        await stubB.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId: workspaceB })))
      )

      expect(listedA.nodes.map((n) => n.title).sort()).toEqual(["A1", "A2"])
      expect(listedB.nodes.map((n) => n.title)).toEqual(["B1"])
    } finally {
      stubB[Symbol.dispose]()
    }
  })

  it("getNode fetches the node that was just created", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const created = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Fetch me" })))
    )

    const fetched = Schema.decodeUnknownSync(GetNodeOutput)(
      await workspaceStub.getNode(
        Schema.encodeSync(GetNodeInput)(new GetNodeInput({ workspaceId, nodeId: created.node.id }))
      )
    )
    expect(fetched.node).toEqual(created.node)
  })
})

describe("standup publication projection", () => {
  it("returns an honest empty projection for a note with no workforce writer yet", async () => {
    const workspaceId = freshWorkspaceId()
    const dailyNoteId = freshNodeId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const result = Schema.decodeUnknownSync(ListStandupPublicationsOutput)(
        await stub.listStandupPublications(
          Schema.encodeSync(ListStandupPublicationsInput)(new ListStandupPublicationsInput({ workspaceId, dailyNoteId }))
        )
      )
      expect(result.publications).toEqual([])
    } finally {
      stub[Symbol.dispose]()
    }
  })
})

describe("error boundary: typed errors surface correctly, not as opaque failures", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("a Schema.decodeUnknown failure (empty title) surfaces as a typed ValidationError", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    // Bypasses the client-side `Schema.encodeSync(CreateNodeInput)` a well-behaved caller would
    // run first — sends a wire payload that fails `CreateNodeInput`'s own `Schema.decodeUnknown`
    // server-side (empty title violates `Schema.minLength(1)`), exactly the case the exit
    // criterion names.
    const error = await rejectionToDomainError(workspaceStub.createNode({ workspaceId, title: "" }))

    expect(error._tag).toBe("ValidationError")
    if (error._tag === "ValidationError") {
      expect(error.message.length).toBeGreaterThan(0)
    }
  })

  it("a malformed workspaceId (not a ULID/UUID) surfaces as a typed ValidationError", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const error = await rejectionToDomainError(
      workspaceStub.listNodes({ workspaceId: "not-a-valid-entity-id" })
    )
    expect(error._tag).toBe("ValidationError")
  })

  it("requesting a nonexistent node surfaces as a typed NodeNotFound, not an opaque error", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)
    const missingNodeId = freshNodeId()

    const error = await rejectionToDomainError(
      workspaceStub.getNode(Schema.encodeSync(GetNodeInput)(new GetNodeInput({ workspaceId, nodeId: missingNodeId })))
    )

    expect(error._tag).toBe("NodeNotFound")
    if (error._tag === "NodeNotFound") {
      expect(error.nodeId).toBe(missingNodeId)
    }
  })

  it("a cross-workspace RPC (workspaceId not matching this connection's workspace) fails closed as ValidationError", async () => {
    const ownWorkspaceId = freshWorkspaceId()
    const otherWorkspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(ownWorkspaceId)

    const error = await rejectionToDomainError(
      workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId: otherWorkspaceId, title: "nope" })))
    )
    expect(error._tag).toBe("ValidationError")
  })
})
