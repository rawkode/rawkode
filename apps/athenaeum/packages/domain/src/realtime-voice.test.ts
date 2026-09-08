import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { ToolSpec } from "./model-client.js"
import {
  RealtimeVoiceConnectionFailed,
  RealtimeVoiceEvent,
  RealtimeVoiceProtocolError,
  RealtimeVoiceSessionConfig,
  RealtimeVoiceUnavailable,
  VoiceAssistantAudioDelta,
  VoiceAssistantTextDelta,
  VoiceToolCallRequested,
  VoiceTurnCompleted,
  VoiceUserTranscriptCompleted,
  VoiceUserTranscriptDelta
} from "./realtime-voice.js"

describe("RealtimeVoiceSessionConfig schema", () => {
  it("round-trips systemPrompt, tools, and inputAudioSampleRateHz", () => {
    const config = new RealtimeVoiceSessionConfig({
      systemPrompt: "You are a helpful workspace-editing voice assistant.",
      tools: [new ToolSpec({ name: "createNode", description: "Create a node", inputSchema: { type: "object" } })],
      inputAudioSampleRateHz: 24_000
    })
    const encoded = Schema.encodeSync(RealtimeVoiceSessionConfig)(config)
    expect(Schema.decodeUnknownSync(RealtimeVoiceSessionConfig)(encoded)).toEqual(config)
  })

  it("systemPrompt is optional", () => {
    const config = new RealtimeVoiceSessionConfig({ tools: [], inputAudioSampleRateHz: 24_000 })
    const encoded = Schema.encodeSync(RealtimeVoiceSessionConfig)(config)
    expect(encoded.systemPrompt).toBeUndefined()
  })
})

describe("RealtimeVoiceEvent discriminated union", () => {
  const cases: ReadonlyArray<readonly [string, RealtimeVoiceEvent]> = [
    ["user_transcript_delta", new VoiceUserTranscriptDelta({ kind: "user_transcript_delta", delta: "he" })],
    ["user_transcript_completed", new VoiceUserTranscriptCompleted({ kind: "user_transcript_completed", text: "hello" })],
    ["assistant_text_delta", new VoiceAssistantTextDelta({ kind: "assistant_text_delta", delta: "Su" })],
    ["assistant_audio_delta", new VoiceAssistantAudioDelta({ kind: "assistant_audio_delta", audioBase64: "AAA=" })],
    [
      "tool_call_requested",
      new VoiceToolCallRequested({ kind: "tool_call_requested", callId: "call-1", name: "createNode", input: { title: "X" } })
    ],
    ["turn_completed", new VoiceTurnCompleted({ kind: "turn_completed" })]
  ]

  it.each(cases)("round-trips a %s event", (_label, event) => {
    const encoded = Schema.encodeSync(RealtimeVoiceEvent)(event)
    const decoded = Schema.decodeUnknownSync(RealtimeVoiceEvent)(encoded)
    expect(decoded).toEqual(event)
  })

  it("rejects an unrecognized kind", () => {
    const result = Schema.decodeUnknownEither(RealtimeVoiceEvent)({ kind: "something_else" })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("RealtimeVoiceError variants", () => {
  it("are Data.TaggedError instances with the expected _tag", () => {
    expect(new RealtimeVoiceUnavailable({ message: "no API key" })._tag).toBe("RealtimeVoiceUnavailable")
    expect(new RealtimeVoiceConnectionFailed({ message: "ws refused" })._tag).toBe("RealtimeVoiceConnectionFailed")
    expect(new RealtimeVoiceProtocolError({ message: "bad frame" })._tag).toBe("RealtimeVoiceProtocolError")
  })
})
