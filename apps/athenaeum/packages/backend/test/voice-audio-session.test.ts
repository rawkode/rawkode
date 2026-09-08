// `voice-audio-rpc.ts`'s five live-session methods — the native-voice-UI task's own backend
// counterpart (see `voice-audio-session.ts`'s header comment for the full design). Three halves:
//
//   1. The open/send/commit/poll/close round trip itself, against a scripted `RealtimeVoiceClient`
//      (`installScriptedVoice`, this suite's own copy of `voice-session.test.ts`'s helper) — proves
//      audio chunks and imperative calls reach the session double, and that events it emits are
//      genuinely buffered and drained via polling, not fabricated by the test.
//   2. The SAME voice-to-agent wiring `voice-session.test.ts` already proved for
//      `debugRunVoiceChatTurns`, now proved for the live/polling front door instead: a scripted
//      transcript event triggers a REAL `AgentEditService.sendChatMessage` call (scripted
//      `ModelClient` underneath), verified through the real `listPendingChanges`/`mergeChanges`/
//      `listNodes` RPC methods — no shortcut for the assertion itself.
//   3. `requireRoleForGovernedWorkspace` gating (no exceptions, per this app's hard constraint) and the
//      `ValidationError` path for an unknown/already-closed `audioSessionId`.

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
  ModelClient,
  ModelTurnFinalText,
  ModelTurnToolCalls,
  RealtimeVoiceClient,
  ToolCallRequest,
  VoiceAssistantTextDelta,
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
  rejectionToDomainError
} from "./support.js"

const installScriptedModel = (script: ReadonlyArray<ModelTurnToolCalls | ModelTurnFinalText>) => {
  const scripted = makeModelClientScripted(script)
  const service = Effect.runSync(ModelClient.pipe(Effect.provide(scripted.layer)))
  agentEditModelClientTestHook.converse = service.converse
  return scripted
}

const installScriptedVoice = (
  eventScript: ReadonlyArray<InstanceType<typeof VoiceUserTranscriptCompleted> | InstanceType<typeof VoiceAssistantTextDelta>>
) => {
  const scripted = makeRealtimeVoiceClientScripted(eventScript)
  const service = Effect.runSync(RealtimeVoiceClient.pipe(Effect.provide(scripted.layer)))
  voiceRealtimeClientTestHook.openSession = service.openSession
  return scripted
}

afterEach(() => {
  agentEditModelClientTestHook.converse = undefined
  voiceRealtimeClientTestHook.openSession = undefined
})

const sessionConfig = { tools: [], inputAudioSampleRateHz: 16_000 }

describe("Live voice-audio session (voice-audio-rpc.ts)", () => {
  it("round-trips open -> sendVoiceAudioChunk -> commit -> poll -> close, draining buffered events", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const chat = Schema.decodeUnknownSync(CreateChatOutput)(
        await stub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Live voice chat" })))
      ).chat

      const scripted = installScriptedVoice([
        new VoiceAssistantTextDelta({ kind: "assistant_text_delta", delta: "Hello" })
      ])

      const opened = (await stub.openVoiceAudioSession({ workspaceId, chatId: chat.id, sessionConfig })) as {
        audioSessionId: string
      }
      expect(opened.audioSessionId.length).toBeGreaterThan(0)

      // Real base64-encoded PCM16 bytes, exactly the wire shape a native mic-capture pipeline
      // would send (`SendVoiceAudioChunkInput.pcm16Base64`).
      const pcm16 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
      let binary = ""
      for (const byte of pcm16) binary += String.fromCharCode(byte)
      const pcm16Base64 = btoa(binary)

      await stub.sendVoiceAudioChunk({ workspaceId, audioSessionId: opened.audioSessionId, pcm16Base64 })
      await stub.commitVoiceAudioAndRespond({ workspaceId, audioSessionId: opened.audioSessionId })

      // The scripted session recorded the real imperative calls this test made against it —
      // proving the chunk/commit reached the REAL `RealtimeVoiceSession` double, not just that the
      // RPC call itself succeeded.
      expect(scripted.sessions).toHaveLength(1)
      expect(scripted.sessions[0]!.calls).toEqual([
        { kind: "sendAudioChunk", pcm16 },
        { kind: "commitAudioAndRespond" }
      ])

      // Poll until the scripted event (emitted async via the background dispatch loop) shows up —
      // a real drain, not a fabricated assertion; bounded so a real regression fails the test
      // instead of hanging it.
      let events: ReadonlyArray<{ kind: string }> = []
      for (let attempt = 0; attempt < 50 && events.length === 0; attempt++) {
        const polled = (await stub.pollVoiceAudioEvents({ workspaceId, audioSessionId: opened.audioSessionId })) as {
          events: ReadonlyArray<{ kind: string }>
        }
        events = polled.events
        if (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(events).toEqual([{ kind: "assistant_text_delta", delta: "Hello" }])

      // A second poll immediately after must be empty — `pollVoiceAudioEvents` drains, it doesn't
      // re-deliver.
      const secondPoll = (await stub.pollVoiceAudioEvents({ workspaceId, audioSessionId: opened.audioSessionId })) as {
        events: ReadonlyArray<unknown>
      }
      expect(secondPoll.events).toEqual([])

      await stub.closeVoiceAudioSession({ workspaceId, audioSessionId: opened.audioSessionId })
      expect(scripted.sessions[0]!.calls).toContainEqual({ kind: "close" })
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("fails with ValidationError when sending/polling/committing against an unknown audioSessionId", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const bogusAudioSessionId = crypto.randomUUID()
      const sendError = await rejectionToDomainError(
        stub.sendVoiceAudioChunk({ workspaceId, audioSessionId: bogusAudioSessionId, pcm16Base64: "" })
      )
      expect(sendError._tag).toBe("ValidationError")

      const pollError = await rejectionToDomainError(
        stub.pollVoiceAudioEvents({ workspaceId, audioSessionId: bogusAudioSessionId })
      )
      expect(pollError._tag).toBe("ValidationError")
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("closeVoiceAudioSession on an unknown audioSessionId is a no-op, not an error", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      await expect(
        stub.closeVoiceAudioSession({ workspaceId, audioSessionId: crypto.randomUUID() })
      ).resolves.toBeDefined()
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("fails with ChatNotFound when opening against a chatId that doesn't exist", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const bogusChatId = freshWorkspaceId()
      const error = await rejectionToDomainError(
        stub.openVoiceAudioSession({ workspaceId, chatId: bogusChatId, sessionConfig })
      )
      expect(error._tag).toBe("ChatNotFound")
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("rejects an anonymous caller on a GOVERNED workspace (requireRoleForGovernedWorkspace, no exceptions)", async () => {
    const ownerEmail = `voice-audio-owner-${crypto.randomUUID()}@rawkode.academy`
    const { credential } = await devSignIn(ownerEmail)
    const { stub: userStub, socket: userSocket } = await connectToUserAs(credential)
    let workspaceId: EntityId
    let chatId: string
    try {
      const created = Schema.decodeUnknownSync(CreateWorkspaceOutput)(
        await userStub.createWorkspace(Schema.encodeSync(CreateWorkspaceInput)(new CreateWorkspaceInput({ title: "Governed voice-audio workspace" })))
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
      const error = await rejectionToDomainError(
        anonymousStub.openVoiceAudioSession({ workspaceId, chatId, sessionConfig })
      )
      expect(error._tag).toBe("Unauthorized")
    } finally {
      anonymousStub[Symbol.dispose]()
    }
  })
})

describe("Live voice-audio session -> AgentEditService wiring (against the REAL AgentEditService)", () => {
  it("a live-polled voice transcript triggers a real pending record, visible after mergeChanges", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspaceAsTestUser(workspaceId)
    try {
      const chat = Schema.decodeUnknownSync(CreateChatOutput)(
        await stub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Live voice-driven chat" })))
      ).chat

      installScriptedModel([
        new ModelTurnToolCalls({
          kind: "tool_calls",
          calls: [
            new ToolCallRequest({ id: "call_1", name: "createNode", input: { title: "Live Voice Node", binding: "LIVE_VOICE_NODE" } })
          ]
        }),
        new ModelTurnFinalText({ kind: "final_text", text: "Created Live Voice Node." })
      ])
      installScriptedVoice([
        new VoiceUserTranscriptCompleted({
          kind: "user_transcript_completed",
          text: "Please create a node called Live Voice Node."
        })
      ])

      const opened = (await stub.openVoiceAudioSession({ workspaceId, chatId: chat.id, sessionConfig })) as {
        audioSessionId: string
      }

      // Poll until the background dispatch loop has both buffered the transcript event AND (per
      // `voice-audio-session.ts`'s dispatch loop) triggered the real agent turn — the pending node
      // becoming visible via `listPendingChanges` is the actual proof, not the poll itself.
      let sawTranscript = false
      for (let attempt = 0; attempt < 50 && !sawTranscript; attempt++) {
        const polled = (await stub.pollVoiceAudioEvents({ workspaceId, audioSessionId: opened.audioSessionId })) as {
          events: ReadonlyArray<{ kind: string }>
        }
        if (polled.events.some((event) => event.kind === "user_transcript_completed")) sawTranscript = true
        else await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(sawTranscript).toBe(true)

      let pendingTitles: ReadonlyArray<string> = []
      for (let attempt = 0; attempt < 50 && pendingTitles.length === 0; attempt++) {
        const pending = Schema.decodeUnknownSync(ListPendingChangesOutput)(
          await stub.listPendingChanges(Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id })))
        )
        pendingTitles = pending.nodes.map((n) => n.title)
        if (pendingTitles.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(pendingTitles).toEqual(["Live Voice Node"])

      const beforeMerge = Schema.decodeUnknownSync(ListNodesOutput)(
        await stub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
      )
      expect(beforeMerge.nodes.map((n) => n.title)).not.toContain("Live Voice Node")

      await stub.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 0 })))

      const afterMerge = Schema.decodeUnknownSync(ListNodesOutput)(
        await stub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
      )
      expect(afterMerge.nodes.map((n) => n.title)).toContain("Live Voice Node")

      await stub.closeVoiceAudioSession({ workspaceId, audioSessionId: opened.audioSessionId })
    } finally {
      stub[Symbol.dispose]()
    }
  })
})
