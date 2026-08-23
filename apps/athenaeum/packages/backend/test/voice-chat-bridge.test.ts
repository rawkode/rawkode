// Proves `runVoiceChatTurns`' composition is genuinely correct: a scripted `RealtimeVoiceClient`
// stands in for a real realtime session (same double `realtime-voice-client-openai.test.ts` would
// use in a higher-level test), and a minimal hand-built `AgentEditService` double records exactly
// what `sendChatMessage` was called with — proving voice-transcript text reaches
// `AgentEditService.sendChatMessage` UNCHANGED, non-transcript events are ignored, and results
// come back in arrival order. This is deliberately NOT a full DO-backed integration test (the real
// `AgentEditService`/`ModelClient`/tool-calling loop is already proven correct by
// `test/agent-edit.test.ts` and `test/model-client-anthropic.test.ts` independently) — this test's
// only job is the NEW wiring in `voice-chat-bridge.ts` itself.

import { describe, expect, it } from "vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  ChatMessageRecord,
  EntityId,
  RealtimeVoiceSessionConfig,
  VoiceAssistantTextDelta,
  VoiceUserTranscriptCompleted,
  type RealtimeVoiceEvent
} from "@athenaeum/domain"
import { AgentEditService, type AgentTurnResult } from "../src/agent-edit-service-live.js"
import { makeRealtimeVoiceClientScripted } from "../src/realtime-voice-client-scripted.js"
import { runVoiceChatTurns } from "../src/voice-chat-bridge.js"

interface RecordedSendChatMessageCall {
  readonly chatId: EntityId
  readonly text: string
}

const freshId = (): EntityId => Schema.decodeUnknownSync(EntityId)(crypto.randomUUID())
const chatId = freshId()

const fakeTurnResult = (text: string, sequence: number): AgentTurnResult => ({
  messages: [new ChatMessageRecord({ id: freshId(), chatId, role: "assistant", content: text, sequence })],
  changesSequences: []
})

/** A minimal `AgentEditService` double implementing only `sendChatMessage` — every other method
 *  on the real interface is irrelevant to what this file tests (see this test file's own header
 *  comment). Cast through `unknown` deliberately: `AgentEditService` is a large internal-to-this-
 *  DO interface (chat CRUD, pending-change management, every agent tool), not one designed for
 *  partial test substitution the way `ModelClient`'s single-method interface is — narrowing the
 *  cast to exactly the one method this bridge calls keeps the test double honest about what it
 *  does and doesn't stand in for. */
const makeAgentEditServiceRecorder = (
  responses: ReadonlyArray<AgentTurnResult>
): { readonly layer: Layer.Layer<AgentEditService>; readonly calls: Array<RecordedSendChatMessageCall> } => {
  const queue = [...responses]
  const calls: Array<RecordedSendChatMessageCall> = []
  const partial = {
    sendChatMessage: (chatId: EntityId, text: string) =>
      Effect.sync(() => {
        calls.push({ chatId, text })
        const next = queue.shift()
        if (next === undefined) throw new Error("makeAgentEditServiceRecorder: response script exhausted")
        return next
      })
  }
  return { layer: Layer.succeed(AgentEditService, partial as unknown as Context.Tag.Service<typeof AgentEditService>), calls }
}

const config = new RealtimeVoiceSessionConfig({ tools: [], inputAudioSampleRateHz: 24_000 })

describe("runVoiceChatTurns", () => {
  it("calls AgentEditService.sendChatMessage with the completed transcript text, unchanged", async () => {
    const agentEdit = makeAgentEditServiceRecorder([fakeTurnResult("Created the note.", 0)])
    const eventScript: ReadonlyArray<RealtimeVoiceEvent> = [
      new VoiceUserTranscriptCompleted({ kind: "user_transcript_completed", text: "Create a note about the roadmap meeting" })
    ]
    const voice = makeRealtimeVoiceClientScripted(eventScript)

    const results = await Effect.runPromise(
      runVoiceChatTurns(chatId, config).pipe(Effect.provide(Layer.merge(voice.layer, agentEdit.layer)))
    )

    expect(agentEdit.calls).toEqual([{ chatId, text: "Create a note about the roadmap meeting" }])
    expect(results).toHaveLength(1)
  })

  it("ignores every non-user_transcript_completed event (deltas, audio, tool calls, turn_completed)", async () => {
    const agentEdit = makeAgentEditServiceRecorder([])
    const eventScript: ReadonlyArray<RealtimeVoiceEvent> = [
      new VoiceAssistantTextDelta({ kind: "assistant_text_delta", delta: "thinking..." })
    ]
    const voice = makeRealtimeVoiceClientScripted(eventScript)

    const results = await Effect.runPromise(
      runVoiceChatTurns(chatId, config).pipe(Effect.provide(Layer.merge(voice.layer, agentEdit.layer)))
    )

    expect(agentEdit.calls).toEqual([])
    expect(results).toEqual([])
  })

  it("collects results from multiple completed utterances in arrival order", async () => {
    const agentEdit = makeAgentEditServiceRecorder([fakeTurnResult("first", 0), fakeTurnResult("second", 1)])
    const eventScript: ReadonlyArray<RealtimeVoiceEvent> = [
      new VoiceUserTranscriptCompleted({ kind: "user_transcript_completed", text: "first utterance" }),
      new VoiceUserTranscriptCompleted({ kind: "user_transcript_completed", text: "second utterance" })
    ]
    const voice = makeRealtimeVoiceClientScripted(eventScript)

    const results = await Effect.runPromise(
      runVoiceChatTurns(chatId, config).pipe(Effect.provide(Layer.merge(voice.layer, agentEdit.layer)))
    )

    expect(agentEdit.calls.map((c) => c.text)).toEqual(["first utterance", "second utterance"])
    expect(results.map((r) => r.messages[0]!.content)).toEqual(["first", "second"])
  })

  it("opened the session with the exact config passed in", async () => {
    const agentEdit = makeAgentEditServiceRecorder([])
    const voice = makeRealtimeVoiceClientScripted([])

    await Effect.runPromise(runVoiceChatTurns(chatId, config).pipe(Effect.provide(Layer.merge(voice.layer, agentEdit.layer))))

    expect(voice.sessions).toHaveLength(1)
    expect(voice.sessions[0]!.config).toEqual(config)
  })
})
