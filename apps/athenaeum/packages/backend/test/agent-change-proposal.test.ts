import { afterEach, describe, expect, it } from "vitest"
import { evictDurableObject } from "cloudflare:test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  AgentChangeProposal,
  CreateChatInput,
  CreateChatOutput,
  ListChatChangesInput,
  ListChatChangesOutput,
  ListPendingChangesInput,
  ListPendingChangesOutput,
  MergeChangesInput,
  ModelClient,
  ModelTurnFinalText,
  ModelTurnToolCalls,
  SendChatMessageInput,
  ToolCallRequest,
  type EntityId
} from "@athenaeum/domain"
import { agentChangeCaptureTestHooks } from "../src/agent-edit-service-live.js"
import { agentEditModelClientTestHook } from "../src/workspace-durable-object.js"
import { makeModelClientScripted } from "../src/model-client-scripted.js"
import { connectToWorkspace, freshWorkspaceId, workspaceDurableObjectStub } from "./support.js"

const installCreateNodeScript = () => {
  const scripted = makeModelClientScripted([
    new ModelTurnToolCalls({ kind: "tool_calls", calls: [
      new ToolCallRequest({ id: "capture-node", name: "createNode", input: { title: "Reserved node", binding: "RESERVED" } })
    ] }),
    new ModelTurnFinalText({ kind: "final_text", text: "Created the pending node." })
  ])
  agentEditModelClientTestHook.converse = Effect.runSync(ModelClient.pipe(Effect.provide(scripted.layer))).converse
}

const installScript = (calls: ReadonlyArray<ToolCallRequest>) => {
  const scripted = makeModelClientScripted([
    new ModelTurnToolCalls({ kind: "tool_calls", calls }),
    new ModelTurnFinalText({ kind: "final_text", text: "done" })
  ])
  agentEditModelClientTestHook.converse = Effect.runSync(ModelClient.pipe(Effect.provide(scripted.layer))).converse
}

const captureInput = (chatId: EntityId, requestId: string) => ({
  chatId, operation: "merge" as const, rangeBoundary: 0, requestId,
  actor: "test-agent", provenance: "agent-edit-capture-test"
})

describe("agent change proposal capture and reservations", () => {
  let workspace: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    workspace?.[Symbol.dispose]()
    workspace = undefined
    agentEditModelClientTestHook.converse = undefined
    agentChangeCaptureTestHooks.afterReservationInsert = undefined
    agentChangeCaptureTestHooks.unstampCapturedNode = undefined
  })

  const pendingChat = async () => {
    const workspaceId = freshWorkspaceId()
    workspace = await connectToWorkspace(workspaceId)
    installCreateNodeScript()
    const chat = Schema.decodeUnknownSync(CreateChatOutput)(await workspace.createChat(
      Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Capture proposal" }))
    )).chat
    await workspace.sendChatMessage(Schema.encodeSync(SendChatMessageInput)(
      new SendChatMessageInput({ chatId: chat.id, text: "Create a pending node." })
    ))
    return { workspaceId, chat }
  }

  it("captures immutable evidence and exact-replays one durable request identity after reconnect", async () => {
    const { workspaceId, chat } = await pendingChat()
    const native = workspaceDurableObjectStub(workspaceId)
    const first = Schema.decodeUnknownSync(AgentChangeProposal)(await native.debugCaptureAgentChangeProposal(captureInput(chat.id, "capture-request-1")))
    const replay = Schema.decodeUnknownSync(AgentChangeProposal)(await native.debugCaptureAgentChangeProposal(captureInput(chat.id, "capture-request-1")))

    expect(first.proposalId).toBe(replay.proposalId)
    expect(first.snapshot).toHaveLength(1)
    expect(first.snapshot[0]).toMatchObject({ kind: "node", pendingChatId: chat.id, pendingSequence: 0, selectionPosition: 0 })
    expect(first).not.toHaveProperty("state")

    workspace?.[Symbol.dispose]()
    workspace = undefined
    await evictDurableObject(workspaceDurableObjectStub(workspaceId))
    const afterReconnect = Schema.decodeUnknownSync(AgentChangeProposal)(
      await workspaceDurableObjectStub(workspaceId).debugGetAgentChangeProposal("capture-request-1")
    )
    expect(afterReconnect.proposalId).toBe(first.proposalId)
  })

  it("uses storage constraints for request conflicts and target reservation collisions", async () => {
    const { workspaceId, chat } = await pendingChat()
    const native = workspaceDurableObjectStub(workspaceId)
    const raced = await Promise.allSettled([
      native.debugCaptureAgentChangeProposal(captureInput(chat.id, "capture-request-2")),
      workspaceDurableObjectStub(workspaceId).debugCaptureAgentChangeProposal(captureInput(chat.id, "capture-request-3"))
    ])
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1)

    const winner = raced[0]!.status === "fulfilled" ? "capture-request-2" : "capture-request-3"
    const loser = winner === "capture-request-2" ? "capture-request-3" : "capture-request-2"
    await expect(native.debugCaptureAgentChangeProposal({ ...captureInput(chat.id, winner), rangeBoundary: 1 })).rejects.toThrow()
    expect(await native.debugGetAgentChangeProposal(loser)).toBeNull()
  })

  it("derives replay identity from semantic command fields, not a caller fingerprint", async () => {
    const { workspaceId, chat } = await pendingChat()
    const native = workspaceDurableObjectStub(workspaceId)
    const first = Schema.decodeUnknownSync(AgentChangeProposal)(
      await native.debugCaptureAgentChangeProposal({ ...captureInput(chat.id, "capture-semantic-id"), requestFingerprint: "untrusted-a" })
    )
    const replay = Schema.decodeUnknownSync(AgentChangeProposal)(
      await native.debugCaptureAgentChangeProposal({ ...captureInput(chat.id, "capture-semantic-id"), requestFingerprint: "untrusted-b" })
    )
    expect(replay.proposalId).toBe(first.proposalId)
    await expect(native.debugCaptureAgentChangeProposal({
      ...captureInput(chat.id, "capture-semantic-id"), actor: "different-actor"
    })).rejects.toThrow("request id was already used for a different proposal capture")
  })

  it("snapshots a pending App and exactly its ahead-of-pointer code versions across reconnect", async () => {
    const workspaceId = freshWorkspaceId()
    workspace = await connectToWorkspace(workspaceId)
    const chat = Schema.decodeUnknownSync(CreateChatOutput)(await workspace.createChat(
      Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "App proposal snapshot" }))
    )).chat
    installScript([
      new ToolCallRequest({ id: "create", name: "createApp", input: { title: "Snapshot App", icon: "🧪", binding: "SNAP" } }),
      new ToolCallRequest({ id: "server-v1", name: "updateAppCode", input: { binding: "SNAP", kind: "server", code: "export default { fetch() { return new Response('v1') } }" } }),
      new ToolCallRequest({ id: "client-v1", name: "updateAppCode", input: { binding: "SNAP", kind: "client", code: "export default 'v1'" } })
    ])
    await workspace.sendChatMessage(Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create app" })))
    await workspace.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 2 })))

    installScript([
      new ToolCallRequest({ id: "server-v2", name: "updateAppCode", input: { binding: "SNAP", kind: "server", code: "export default { fetch() { return new Response('v2') } }" } }),
      new ToolCallRequest({ id: "client-v2", name: "updateAppCode", input: { binding: "SNAP", kind: "client", code: "export default 'v2'" } }),
      // Same-chat but outside the capture range: it must not leak into this App proposal.
      new ToolCallRequest({ id: "out-of-range", name: "createNode", input: { title: "Unrelated later row", binding: "LATER" } })
    ])
    await workspace.sendChatMessage(Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Update both code kinds" })))
    const changes = Schema.decodeUnknownSync(ListChatChangesOutput)(await workspace.listChatChanges(
      Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id }))
    )).changes
    const boundary = changes[changes.length - 2]!.sequence
    const native = workspaceDurableObjectStub(workspaceId)
    const captured = Schema.decodeUnknownSync(AgentChangeProposal)(
      await native.debugCaptureAgentChangeProposal({ ...captureInput(chat.id, "capture-pending-app"), rangeBoundary: boundary })
    )
    expect(captured.snapshot.map((entry) => [entry.kind, entry.expectedDurableVersion])).toEqual([
      ["app", expect.any(String)], ["appCodeVersion", "2"], ["appCodeVersion", "2"]
    ])
    expect(new TextDecoder().decode(captured.snapshot[0]!.canonicalRowBytes)).toContain('"clientCodeVersion":1')
    expect(new TextDecoder().decode(captured.snapshot[0]!.canonicalRowBytes)).toContain('"serverCodeVersion":1')
    expect(captured.snapshot.filter((entry) => entry.kind === "appCodeVersion").map((entry) => new TextDecoder().decode(entry.canonicalRowBytes)))
      .toEqual(expect.arrayContaining([expect.stringContaining("v2")]))
    expect(captured.snapshot.filter((entry) => entry.kind === "appCodeVersion").map((entry) => new TextDecoder().decode(entry.canonicalRowBytes)).join(""))
      .not.toContain("'v1'")

    workspace?.[Symbol.dispose](); workspace = undefined
    await evictDurableObject(workspaceDurableObjectStub(workspaceId))
    const restored = Schema.decodeUnknownSync(AgentChangeProposal)(
      await workspaceDurableObjectStub(workspaceId).debugGetAgentChangeProposal("capture-pending-app")
    )
    expect(restored.snapshot).toEqual(captured.snapshot)
  })

  it("rolls back evidence, request identity, and reservations together when capture crashes", async () => {
    const { workspaceId, chat } = await pendingChat()
    const native = workspaceDurableObjectStub(workspaceId)
    agentChangeCaptureTestHooks.afterReservationInsert = () => { throw new Error("simulate capture crash") }
    await expect(native.debugCaptureAgentChangeProposal(captureInput(chat.id, "capture-request-rollback"))).rejects.toThrow("simulate capture crash")
    agentChangeCaptureTestHooks.afterReservationInsert = undefined

    expect(await native.debugGetAgentChangeProposal("capture-request-rollback")).toBeNull()
    const retried = Schema.decodeUnknownSync(AgentChangeProposal)(
      await native.debugCaptureAgentChangeProposal(captureInput(chat.id, "capture-request-rollback"))
    )
    expect(retried.snapshot).toHaveLength(1)
  })

  it("reconciliation reads authoritative reservation rows and preserves a crash-window target", async () => {
    const { workspaceId, chat } = await pendingChat()
    const native = workspaceDurableObjectStub(workspaceId)
    agentChangeCaptureTestHooks.unstampCapturedNode = true
    await native.debugCaptureAgentChangeProposal(captureInput(chat.id, "capture-request-reconcile"))
    agentChangeCaptureTestHooks.unstampCapturedNode = undefined

    await expect(native.debugReconcileAgentChanges(chat.id)).resolves.toEqual({ reAdopted: 0, reaped: 0 })
    const pending = Schema.decodeUnknownSync(ListPendingChangesOutput)(await workspace!.listPendingChanges(
      Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id }))
    ))
    expect(pending.nodes).toHaveLength(1)
    expect(pending.nodes[0]!.pending?.sequence).toBeUndefined()
  })
})
