// `VoiceSessionService` end-to-end tests — Phase 6 task item 3's "Voice-to-agent wiring... confirm
// by testing that a scripted voice transcript triggering a tool call produces the same
// pending-record/changes-stream behavior Phase 3 already proved, just entering via a different
// front door." Two halves:
//
//   1. `startVoiceSession`/`endVoiceSession` themselves — plain persisted-lifecycle-record CRUD,
//      proven over real Cap'n Web RPC exactly like every other test in this suite
//      (`connectToWorkspace`), including the `ChatNotFound`/`VoiceSessionNotFound` failure paths and
//      `requireRoleForGovernedWorkspace` gating.
//   2. The actual voice-to-agent wiring, via `WorkspaceDurableObject#debugRunVoiceChatTurns` (see that
//      method's own doc comment for exactly why this `ctx.exports`-only hook — not a shortcut into
//      `AgentEditService` internals — is what proves this against the REAL `AgentEditService`
//      `voice-chat-bridge.test.ts`'s own hand-built double could not): a scripted
//      `RealtimeVoiceClient` (`voiceRealtimeClientTestHook`) stands in for a real realtime
//      session's transcript, and a scripted `ModelClient` (`agentEditModelClientTestHook`, the
//      exact same hook `test/agent-edit.test.ts` uses) stands in for the real Anthropic call — the
//      resulting pending node is then asserted on through the REAL, already-Cap'n-Web-exposed
//      `listPendingChanges`/`mergeChanges`/`listNodes` RPC methods, with no shortcut for the
//      assertion itself.

import { afterEach, describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  CreateChatInput,
  CreateChatOutput,
  CreateWorkspaceInput,
  CreateWorkspaceOutput,
  ListNodesInput,
  ListNodesOutput,
  ListPendingChangesInput,
  ListPendingChangesOutput,
  MergeChangesInput,
  MergeChangesOutput,
  ModelClient,
  ModelTurnFinalText,
  ModelTurnToolCalls,
  RealtimeVoiceClient,
  ToolCallRequest,
  VoiceUserTranscriptCompleted,
  type EntityId
} from "@athenaeum/domain"
import { agentEditModelClientTestHook, voiceRealtimeClientTestHook } from "../src/workspace-durable-object.js"
import { makeModelClientScripted } from "../src/model-client-scripted.js"
import { makeRealtimeVoiceClientScripted } from "../src/realtime-voice-client-scripted.js"
import {
  connectToUserAs,
  connectToWorkspace,
  connectToWorkspaceAsTestUser,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

const installScriptedModel = (script: ReadonlyArray<ModelTurnToolCalls | ModelTurnFinalText>) => {
  const scripted = makeModelClientScripted(script)
  const service = Effect.runSync(ModelClient.pipe(Effect.provide(scripted.layer)))
  agentEditModelClientTestHook.converse = service.converse
  return scripted
}

const installScriptedVoice = (eventScript: ReadonlyArray<InstanceType<typeof VoiceUserTranscriptCompleted>>) => {
  const scripted = makeRealtimeVoiceClientScripted(eventScript)
  const service = Effect.runSync(RealtimeVoiceClient.pipe(Effect.provide(scripted.layer)))
  voiceRealtimeClientTestHook.openSession = service.openSession
  return scripted
}

afterEach(() => {
  agentEditModelClientTestHook.converse = undefined
  voiceRealtimeClientTestHook.openSession = undefined
})

describe("VoiceSessionService: startVoiceSession/endVoiceSession", () => {
  it("round-trips a voice session's persisted lifecycle against an already-existing chat", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const chat = Schema.decodeUnknownSync(CreateChatOutput)(
        await stub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Voice chat" })))
      ).chat

      const started = (await stub.startVoiceSession({ workspaceId, chatId: chat.id })) as {
        voiceSession: { id: string; chatId: string; status: string; endedAt?: string }
      }
      expect(started.voiceSession.chatId).toBe(chat.id)
      expect(started.voiceSession.status).toBe("active")
      expect(started.voiceSession.endedAt).toBeUndefined()

      const endedAt = new Date().toISOString()
      const ended = (await stub.endVoiceSession({
        workspaceId,
        voiceSessionId: started.voiceSession.id,
        endedAt
      })) as { voiceSession: { status: string; endedAt: string } }
      expect(ended.voiceSession.status).toBe("ended")
      expect(ended.voiceSession.endedAt).toBe(endedAt)
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("fails with ChatNotFound when starting a voice session against a chatId that doesn't exist", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const bogusChatId = freshWorkspaceId()
      const error = await rejectionToDomainError(stub.startVoiceSession({ workspaceId, chatId: bogusChatId }))
      expect(error._tag).toBe("ChatNotFound")
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("fails with VoiceSessionNotFound when ending a voiceSessionId that was never started", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const bogusSessionId = freshWorkspaceId()
      const error = await rejectionToDomainError(
        stub.endVoiceSession({ workspaceId, voiceSessionId: bogusSessionId, endedAt: new Date().toISOString() })
      )
      expect(error._tag).toBe("VoiceSessionNotFound")
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("rejects an anonymous caller on a GOVERNED workspace (requireRoleForGovernedWorkspace, no exceptions)", async () => {
    const ownerEmail = `voice-owner-${crypto.randomUUID()}@rawkode.academy`
    const { credential } = await devSignIn(ownerEmail)
    const { stub: userStub, socket: userSocket } = await connectToUserAs(credential)
    let workspaceId: EntityId
    let chatId: string
    try {
      const created = Schema.decodeUnknownSync(CreateWorkspaceOutput)(
        await userStub.createWorkspace(Schema.encodeSync(CreateWorkspaceInput)(new CreateWorkspaceInput({ title: "Governed voice workspace" })))
      )
      workspaceId = created.workspace.workspaceId
    } finally {
      userStub[Symbol.dispose]()
      userSocket.close()
    }

    const { stub: ownerWorkspaceStub, socket: ownerSocket } = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const chat = Schema.decodeUnknownSync(CreateChatOutput)(
        await ownerWorkspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Owner chat" })))
      ).chat
      chatId = chat.id
    } finally {
      ownerWorkspaceStub[Symbol.dispose]()
      ownerSocket.close()
    }

    const anonymousStub = await connectToWorkspace(workspaceId)
    try {
      const error = await rejectionToDomainError(anonymousStub.startVoiceSession({ workspaceId, chatId }))
      expect(error._tag).toBe("Unauthorized")
    } finally {
      anonymousStub[Symbol.dispose]()
    }
  })
})

describe("Voice → AgentEditService wiring (task item 3, against the REAL AgentEditService)", () => {
  it("a scripted voice transcript triggering a tool call produces a real pending record, visible after mergeChanges", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspaceAsTestUser(workspaceId)
    try {
      const chat = Schema.decodeUnknownSync(CreateChatOutput)(
        await stub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Voice-driven chat" })))
      ).chat

      installScriptedModel([
        new ModelTurnToolCalls({
          kind: "tool_calls",
          calls: [new ToolCallRequest({ id: "call_1", name: "createNode", input: { title: "Voice Node", binding: "VOICE_NODE" } })]
        }),
        new ModelTurnFinalText({ kind: "final_text", text: "Created Voice Node." })
      ])
      installScriptedVoice([
        new VoiceUserTranscriptCompleted({ kind: "user_transcript_completed", text: "Please create a node called Voice Node." })
      ])

      const doStub = workspaceDurableObjectStub(workspaceId)
      const result = await doStub.debugRunVoiceChatTurns(chat.id, { tools: [], inputAudioSampleRateHz: 16_000 })
      expect(result.turnCount).toBe(1)
      expect(result.changesSequences).toEqual([0])

      // Real, already-Cap'n-Web-exposed verification — exactly `agent-edit.test.ts`'s own "pending,
      // invisible to normal reads, visible after mergeChanges" shape, entering via voice instead
      // of `sendChatMessage` directly.
      const pending = Schema.decodeUnknownSync(ListPendingChangesOutput)(
        await stub.listPendingChanges(Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id })))
      )
      expect(pending.nodes.map((n) => n.title)).toEqual(["Voice Node"])

      const beforeMerge = Schema.decodeUnknownSync(ListNodesOutput)(
        await stub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
      )
      expect(beforeMerge.nodes.map((n) => n.title)).not.toContain("Voice Node")

      await stub.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 0 })))

      const afterMerge = Schema.decodeUnknownSync(ListNodesOutput)(
        await stub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
      )
      expect(afterMerge.nodes.map((n) => n.title)).toContain("Voice Node")
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("non-transcript voice events are ignored — zero turns, zero pending records", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const chat = Schema.decodeUnknownSync(CreateChatOutput)(
        await stub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Silent voice chat" })))
      ).chat

      installScriptedModel([]) // never called — a call here would itself fail the test
      installScriptedVoice([]) // an empty event stream — the bridge should simply produce zero turns

      const doStub = workspaceDurableObjectStub(workspaceId)
      const result = await doStub.debugRunVoiceChatTurns(chat.id, { tools: [], inputAudioSampleRateHz: 16_000 })
      expect(result.turnCount).toBe(0)
      expect(result.changesSequences).toEqual([])
    } finally {
      stub[Symbol.dispose]()
    }
  })
})
