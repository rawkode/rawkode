// Proves `RealtimeVoiceClientOpenAI`'s client-event construction and server-event parsing is
// genuinely correct, by mocking *only* the transport layer (`WebSocketTransport`) — same
// discipline as `model-client-anthropic.test.ts`/`cloud-transcription-client-openai.test.ts`: real
// Effect programs run through the real `makeRealtimeVoiceClientOpenAILive` implementation
// end-to-end (session-open, `session.update`, audio append/commit, tool-result submission, event
// decoding including the two-event function-call join); only the socket itself is a fake whose
// `send`/`addEventListener` are test-controlled, simulating server frames without any real
// network connection. **No real OpenAI API key is used or required — a real live-API integration
// test is explicitly not possible in this environment (see the implementation's own header
// comment).**

import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import {
  RealtimeVoiceClient,
  RealtimeVoiceSessionConfig,
  ToolSpec,
  VoiceAssistantAudioDelta,
  VoiceAssistantTextDelta,
  VoiceToolCallRequested,
  VoiceTurnCompleted,
  VoiceUserTranscriptCompleted,
  VoiceUserTranscriptDelta
} from "@athenaeum/domain"
import { type WebSocketLike, WebSocketTransport } from "../src/websocket-transport.js"
import { makeRealtimeVoiceClientOpenAILive } from "../src/realtime-voice-client-openai.js"
import type { AiGatewayRoute } from "../src/ai-gateway-route.js"

/** A fully test-controlled fake socket: `send` records every client frame, and the test drives
 *  `emitMessage`/`emitError` directly to simulate server frames — no real network involved. */
class FakeSocket implements WebSocketLike {
  readonly sent: Array<unknown> = []
  closed = false
  private messageListeners: Array<(event: { readonly data?: unknown }) => void> = []
  private errorListeners: Array<(event: { readonly data?: unknown }) => void> = []

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed = true
  }
  addEventListener(type: "message" | "close" | "error", listener: (event: { readonly data?: unknown }) => void): void {
    if (type === "message") this.messageListeners.push(listener)
    if (type === "error") this.errorListeners.push(listener)
  }
  emitMessage(payload: unknown): void {
    for (const listener of this.messageListeners) listener({ data: JSON.stringify(payload) })
  }
  emitRawMessage(data: string): void {
    for (const listener of this.messageListeners) listener({ data })
  }
}

const mockTransport = (
  socket: FakeSocket
): { readonly layer: Layer.Layer<WebSocketTransport>; readonly connectCalls: Array<{ url: string; headers: Record<string, string> }> } => {
  const connectCalls: Array<{ url: string; headers: Record<string, string> }> = []
  const layer = Layer.succeed(WebSocketTransport, {
    connect: (url, headers) => Effect.sync(() => (connectCalls.push({ url, headers }), socket))
  })
  return { layer, connectCalls }
}

const basicConfig = (tools: ReadonlyArray<ToolSpec> = []) =>
  new RealtimeVoiceSessionConfig({ systemPrompt: "You are a helpful voice assistant.", tools, inputAudioSampleRateHz: 24_000 })

describe("RealtimeVoiceClientOpenAI: unconfigured (no API key)", () => {
  it("fails with RealtimeVoiceUnavailable without ever connecting", async () => {
    const socket = new FakeSocket()
    const mock = mockTransport(socket)
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RealtimeVoiceClient
          return yield* client.openSession(basicConfig())
        })
      ).pipe(Effect.provide(makeRealtimeVoiceClientOpenAILive({ apiKey: undefined }).pipe(Layer.provide(mock.layer))))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("RealtimeVoiceUnavailable")
    }
    expect(mock.connectCalls).toHaveLength(0)
  })
})

describe("RealtimeVoiceClientOpenAI: session open + client-event construction", () => {
  it("connects to the correct URL with the Authorization header, and sends session.update with instructions+tools", async () => {
    const socket = new FakeSocket()
    const mock = mockTransport(socket)
    const tools = [new ToolSpec({ name: "createNode", description: "Create a node", inputSchema: { type: "object" } })]

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RealtimeVoiceClient
          yield* client.openSession(basicConfig(tools))
        })
      ).pipe(Effect.provide(makeRealtimeVoiceClientOpenAILive({ apiKey: "sk-test" }).pipe(Layer.provide(mock.layer))))
    )

    expect(mock.connectCalls).toHaveLength(1)
    expect(mock.connectCalls[0]!.url).toBe("https://api.openai.com/v1/realtime?model=gpt-realtime-2.1")
    expect(mock.connectCalls[0]!.headers["Authorization"]).toBe("Bearer sk-test")

    expect(socket.sent).toHaveLength(1)
    expect(socket.sent[0]).toEqual({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: "You are a helpful voice assistant.",
        tools: [{ type: "function", name: "createNode", description: "Create a node", parameters: { type: "object" } }]
      }
    })
  })

  it("closes the underlying socket when the scope closes (resource lifecycle)", async () => {
    const socket = new FakeSocket()
    const mock = mockTransport(socket)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RealtimeVoiceClient
          yield* client.openSession(basicConfig())
        })
      ).pipe(Effect.provide(makeRealtimeVoiceClientOpenAILive({ apiKey: "sk-test" }).pipe(Layer.provide(mock.layer))))
    )
    expect(socket.closed).toBe(true)
  })

  it("sendAudioChunk sends input_audio_buffer.append with base64-encoded PCM", async () => {
    const socket = new FakeSocket()
    const mock = mockTransport(socket)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RealtimeVoiceClient
          const session = yield* client.openSession(basicConfig())
          yield* session.sendAudioChunk(new Uint8Array([1, 2, 3]))
        })
      ).pipe(Effect.provide(makeRealtimeVoiceClientOpenAILive({ apiKey: "sk-test" }).pipe(Layer.provide(mock.layer))))
    )
    const appendFrame = socket.sent[1] as { type: string; audio: string }
    expect(appendFrame.type).toBe("input_audio_buffer.append")
    expect(Buffer.from(appendFrame.audio, "base64")).toEqual(Buffer.from([1, 2, 3]))
  })

  it("commitAudioAndRespond sends commit then response.create", async () => {
    const socket = new FakeSocket()
    const mock = mockTransport(socket)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RealtimeVoiceClient
          const session = yield* client.openSession(basicConfig())
          yield* session.commitAudioAndRespond()
        })
      ).pipe(Effect.provide(makeRealtimeVoiceClientOpenAILive({ apiKey: "sk-test" }).pipe(Layer.provide(mock.layer))))
    )
    expect(socket.sent.slice(1)).toEqual([{ type: "input_audio_buffer.commit" }, { type: "response.create" }])
  })

  it("submitToolResult sends conversation.item.create with function_call_output then response.create", async () => {
    const socket = new FakeSocket()
    const mock = mockTransport(socket)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RealtimeVoiceClient
          const session = yield* client.openSession(basicConfig())
          yield* session.submitToolResult("call-1", "created node abc")
        })
      ).pipe(Effect.provide(makeRealtimeVoiceClientOpenAILive({ apiKey: "sk-test" }).pipe(Layer.provide(mock.layer))))
    )
    expect(socket.sent.slice(1)).toEqual([
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "call-1", output: "created node abc" } },
      { type: "response.create" }
    ])
  })
})

describe("RealtimeVoiceClientOpenAI: AI Gateway routing", () => {
  it("DIRECT mode (gateway undefined) is unchanged — connects to api.openai.com directly", async () => {
    const socket = new FakeSocket()
    const mock = mockTransport(socket)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RealtimeVoiceClient
          yield* client.openSession(basicConfig())
        })
      ).pipe(Effect.provide(makeRealtimeVoiceClientOpenAILive({ apiKey: "sk-test" }).pipe(Layer.provide(mock.layer))))
    )
    expect(mock.connectCalls[0]!.url).toBe("https://api.openai.com/v1/realtime?model=gpt-realtime-2.1")
    expect(mock.connectCalls[0]!.headers["cf-aig-authorization"]).toBeUndefined()
  })

  it("GATEWAY mode connects through the Realtime WebSockets relay, Authorization unchanged", async () => {
    const socket = new FakeSocket()
    const mock = mockTransport(socket)
    const gateway: AiGatewayRoute = { accountId: "acct-123", gatewayName: "my-gateway" }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RealtimeVoiceClient
          yield* client.openSession(basicConfig())
        })
      ).pipe(
        Effect.provide(
          makeRealtimeVoiceClientOpenAILive({ apiKey: "sk-test", gateway }).pipe(Layer.provide(mock.layer))
        )
      )
    )
    expect(mock.connectCalls[0]!.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-123/my-gateway/openai?model=gpt-realtime-2.1"
    )
    expect(mock.connectCalls[0]!.headers["Authorization"]).toBe("Bearer sk-test")
    expect(mock.connectCalls[0]!.headers["cf-aig-authorization"]).toBeUndefined()
  })

  it("GATEWAY mode adds cf-aig-authorization only when an Authenticated Gateway token is configured", async () => {
    const socket = new FakeSocket()
    const mock = mockTransport(socket)
    const gateway: AiGatewayRoute = { accountId: "acct-123", gatewayName: "my-gateway", authToken: "run-token-xyz" }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RealtimeVoiceClient
          yield* client.openSession(basicConfig())
        })
      ).pipe(
        Effect.provide(
          makeRealtimeVoiceClientOpenAILive({ apiKey: "sk-test", gateway }).pipe(Layer.provide(mock.layer))
        )
      )
    )
    expect(mock.connectCalls[0]!.headers["cf-aig-authorization"]).toBe("Bearer run-token-xyz")
  })
})

describe("RealtimeVoiceClientOpenAI: server-event parsing", () => {
  const openSessionAndCollect = (socket: FakeSocket, drive: (socket: FakeSocket) => void, takeCount: number) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RealtimeVoiceClient
          const session = yield* client.openSession(basicConfig())
          const fiber = yield* Effect.fork(Stream.runCollect(session.events.pipe(Stream.take(takeCount))))
          yield* Effect.sync(() => drive(socket))
          return yield* Effect.flatten(fiber.await)
        })
      ).pipe(
        Effect.provide(
          makeRealtimeVoiceClientOpenAILive({ apiKey: "sk-test" }).pipe(Layer.provide(mockTransport(socket).layer))
        )
      )
    )

  it("decodes a user-transcript delta then completion", async () => {
    const socket = new FakeSocket()
    const events = await openSessionAndCollect(
      socket,
      (s) => {
        s.emitMessage({ type: "conversation.item.input_audio_transcription.delta", delta: "he" })
        s.emitMessage({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello" })
      },
      2
    )
    expect(Array.from(events)).toEqual([
      new VoiceUserTranscriptDelta({ kind: "user_transcript_delta", delta: "he" }),
      new VoiceUserTranscriptCompleted({ kind: "user_transcript_completed", text: "hello" })
    ])
  })

  it("decodes assistant audio-transcript deltas as assistant_text_delta events", async () => {
    const socket = new FakeSocket()
    const events = await openSessionAndCollect(
      socket,
      (s) => s.emitMessage({ type: "response.output_audio_transcript.delta", delta: "Sure" }),
      1
    )
    expect(Array.from(events)).toEqual([new VoiceAssistantTextDelta({ kind: "assistant_text_delta", delta: "Sure" })])
  })

  it("decodes assistant audio deltas", async () => {
    const socket = new FakeSocket()
    const events = await openSessionAndCollect(
      socket,
      (s) => s.emitMessage({ type: "response.output_audio.delta", delta: "AAA=" }),
      1
    )
    expect(Array.from(events)).toEqual([new VoiceAssistantAudioDelta({ kind: "assistant_audio_delta", audioBase64: "AAA=" })])
  })

  it("joins response.output_item.added (name) with response.function_call_arguments.done (arguments) into one tool call", async () => {
    const socket = new FakeSocket()
    const events = await openSessionAndCollect(
      socket,
      (s) => {
        s.emitMessage({ type: "response.output_item.added", item: { type: "function_call", call_id: "call-1", name: "createNode" } })
        s.emitMessage({ type: "response.function_call_arguments.done", call_id: "call-1", arguments: JSON.stringify({ title: "New note" }) })
      },
      1
    )
    expect(Array.from(events)).toEqual([
      new VoiceToolCallRequested({ kind: "tool_call_requested", callId: "call-1", name: "createNode", input: { title: "New note" } })
    ])
  })

  it("decodes response.done as turn_completed", async () => {
    const socket = new FakeSocket()
    const events = await openSessionAndCollect(socket, (s) => s.emitMessage({ type: "response.done" }), 1)
    expect(Array.from(events)).toEqual([new VoiceTurnCompleted({ kind: "turn_completed" })])
  })

  it("ignores unrecognized event types without failing the stream", async () => {
    const socket = new FakeSocket()
    const events = await openSessionAndCollect(
      socket,
      (s) => {
        s.emitMessage({ type: "session.updated" })
        s.emitMessage({ type: "response.done" })
      },
      1
    )
    expect(Array.from(events)).toEqual([new VoiceTurnCompleted({ kind: "turn_completed" })])
  })

  it("fails the events stream with RealtimeVoiceProtocolError on a function_call_arguments.done with unknown call_id", async () => {
    const socket = new FakeSocket()
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RealtimeVoiceClient
          const session = yield* client.openSession(basicConfig())
          const fiber = yield* Effect.fork(Stream.runCollect(session.events.pipe(Stream.take(1))))
          yield* Effect.sync(() =>
            socket.emitMessage({ type: "response.function_call_arguments.done", call_id: "ghost", arguments: "{}" })
          )
          return yield* Effect.flatten(fiber.await)
        })
      ).pipe(
        Effect.provide(
          makeRealtimeVoiceClientOpenAILive({ apiKey: "sk-test" }).pipe(Layer.provide(mockTransport(socket).layer))
        )
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("RealtimeVoiceProtocolError")
    }
  })

  it("fails the events stream with RealtimeVoiceProtocolError on a malformed (non-JSON) frame", async () => {
    const socket = new FakeSocket()
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RealtimeVoiceClient
          const session = yield* client.openSession(basicConfig())
          const fiber = yield* Effect.fork(Stream.runCollect(session.events.pipe(Stream.take(1))))
          yield* Effect.sync(() => socket.emitRawMessage("not json{{{"))
          return yield* Effect.flatten(fiber.await)
        })
      ).pipe(
        Effect.provide(
          makeRealtimeVoiceClientOpenAILive({ apiKey: "sk-test" }).pipe(Layer.provide(mockTransport(socket).layer))
        )
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
