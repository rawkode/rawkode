// `RealtimeVoiceClientOpenAI` — a real WebSocket client against OpenAI's actual Realtime API.
// Event shapes verified this stage against OpenAI's own current documentation (WebFetch against
// `developers.openai.com/api/docs/guides/realtime{,-websocket,-conversations}` — the GA
// `gpt-realtime` event naming, not the older 2024 beta naming): endpoint, auth header, the
// `session.update`/`input_audio_buffer.append`/`.commit`/`response.create` client events, and the
// `response.output_audio.delta` / `response.output_audio_transcript.delta` /
// `response.function_call_arguments.{delta,done}` / `response.done` /
// `conversation.item.input_audio_transcription.{delta,completed}` server events — see each
// function's own comment for exactly what was confirmed vs. a documented, flagged simplification.
//
// **No real realtime-voice API key exists in this environment** (hard constraint) — same
// "genuinely unreachable without configuration" discipline as every other real client in this
// package: `makeRealtimeVoiceClientOpenAILive({apiKey: undefined})` fails `openSession` with
// `RealtimeVoiceUnavailable` before attempting any connection. It IS exercised against a mocked
// `WebSocketTransport` layer (`test/realtime-voice-client-openai.test.ts`) — a fake socket object
// whose `send`/`addEventListener` are test-controlled, simulating server frames without any real
// network socket — proving request-building (the client events sent) and response-parsing (the
// server events decoded) independently of network access. **A real live-API integration test is
// explicitly not possible in this environment.**
//
// **Known, documented simplification**: `session.update`'s GA body only sends `type`/
// `instructions`/`tools` — the GA docs (confirmed this stage) restructured audio-format
// configuration under a new `session.audio.{input,output}` namespace, but this stage did not
// independently verify that sub-shape field-by-field (WebFetch against the guide page returned
// only the *fact* that the restructuring happened, not the full schema). Sending no explicit
// `session.audio` block relies on the provider's documented defaults for input/output audio
// encoding rather than asserting a possibly-wrong shape — flagged here as exactly the kind of gap
// that needs a live key to close, same spirit as `model-client-anthropic.ts`'s own "untestable
// without a live key" callouts.
//
// What David would need to make this real: an OpenAI API key with Realtime API access, as
// `OPENAI_REALTIME_API_KEY` (a separate secret from `OPENAI_TRANSCRIPTION_API_KEY` — independent
// rotation/scope, same reasoning as that file's own header comment), via `wrangler secret put
// OPENAI_REALTIME_API_KEY`.

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import {
  RealtimeVoiceClient,
  RealtimeVoiceConnectionFailed,
  RealtimeVoiceProtocolError,
  RealtimeVoiceUnavailable,
  type RealtimeVoiceError,
  type RealtimeVoiceEvent,
  type RealtimeVoiceSession,
  type RealtimeVoiceSessionConfig,
  ToolSpec,
  VoiceAssistantAudioDelta,
  VoiceAssistantTextDelta,
  VoiceToolCallRequested,
  VoiceTurnCompleted,
  VoiceUserTranscriptCompleted,
  VoiceUserTranscriptDelta
} from "@athenaeum/domain"
import { type WebSocketLike, WebSocketTransport } from "./websocket-transport.js"
import { type AiGatewayRoute, gatewayAuthHeader, gatewayRealtimeWsUrl } from "./ai-gateway-route.js"

// https://developers.openai.com/api/docs/guides/realtime-websocket (verified this stage): the
// real endpoint host/path/query-param shape. Note the `https://` scheme on the `fetch()` call
// itself, not `wss://` — see `websocket-transport.ts`'s own header comment for why: `workerd`'s
// outbound-WebSocket mechanism is `fetch()` a same-host `https://` URL with an `Upgrade` header,
// not a `new WebSocket("wss://...")` constructor call. OpenAI's own docs describe the endpoint as
// `wss://api.openai.com/v1/realtime?model=...`; this is the identical host+path+query, expressed
// through the scheme `workerd`'s `fetch`-based upgrade mechanism actually requires.
const REALTIME_URL_BASE = "https://api.openai.com/v1/realtime"
const DEFAULT_MODEL = "gpt-realtime-2.1"

export interface RealtimeVoiceClientOpenAIConfig {
  readonly apiKey: string | undefined
  readonly model?: string
  /** `undefined` (the default) => DIRECT mode, connecting straight to `api.openai.com` exactly as
   *  before this config field existed. When set, the session connects through Cloudflare AI
   *  Gateway's Realtime WebSockets relay instead (docs/ai-gateway-decisions.md §2 — empirically
   *  confirmed supported; a transparent proxy with no documented frame-level schema awareness).
   *  Headers are still built from OpenAI's current GA set below (`Authorization` only) — this
   *  client deliberately does NOT send `OpenAI-Beta: realtime=v1` or target a preview model the
   *  way Cloudflare's own worked example does, since that example targets the pre-GA beta
   *  protocol and the GA endpoint this client already targets (`gpt-realtime-2.1`) is reported to
   *  reject that header. See this file's header comment and docs/ai-gateway-decisions.md §2 for
   *  the full finding. */
  readonly gateway?: AiGatewayRoute
}

// --- Client → server event construction -----------------------------------------------------
//
// https://developers.openai.com/api/docs/guides/realtime-conversations (verified this stage) for
// the exact `type` strings and field names below.

/** Historically-stable Realtime-API tool shape: flat (`{type, name, description, parameters}`),
 *  NOT nested under a `function` key the way Chat Completions' `tools[].function.{name,...}`
 *  is — the Realtime API's tool-definition shape has used the flat form since its introduction
 *  and the GA migration notes reviewed this stage call out other breaking changes (audio-config
 *  namespacing, output_modalities) without mentioning a tool-shape change, so the flat form is
 *  treated as still current. */
const toRealtimeTool = (tool: ToolSpec): unknown => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.inputSchema
})

const base64FromBytes = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

// --- Server → client event parsing ------------------------------------------------------------

/** One accumulated function-call-in-progress, keyed by the `call_id` the server assigns —
 *  populated on `response.output_item.added` (the only event carrying both `call_id` AND `name`
 *  together; `response.function_call_arguments.done` carries `call_id` + the finished `arguments`
 *  string but NOT `name` — confirmed this stage), consumed on
 *  `response.function_call_arguments.done` to emit one complete `VoiceToolCallRequested`. This
 *  two-event join is real, load-bearing state, not a stub — a tool call cannot be represented as a
 *  single domain event without it, because the two pieces of information it needs arrive on two
 *  different wire events. */
interface PendingToolCall {
  readonly name: string
}

const RealtimeServerEventEnvelope = Schema.Struct({
  type: Schema.String
})

/** Decodes one server WebSocket frame into zero-or-one domain events, given the mutable
 *  `pendingToolCalls` map this session's whole lifetime shares (see `PendingToolCall`'s own doc
 *  comment). Returns `undefined` for every server event type this client doesn't act on (session
 *  lifecycle acks, rate-limit notices, `response.output_text.delta` when a session runs
 *  text-only, etc.) — same "tolerate, don't fail decode on, an unrecognized-but-harmless shape"
 *  discipline as `model-client-anthropic.ts`'s `parseResponseBody`. */
const decodeServerEvent = (
  raw: unknown,
  pendingToolCalls: Map<string, PendingToolCall>
): RealtimeVoiceEvent | RealtimeVoiceProtocolError | undefined => {
  const envelopeResult = Schema.decodeUnknownEither(RealtimeServerEventEnvelope)(raw)
  if (envelopeResult._tag === "Left") {
    return new RealtimeVoiceProtocolError({
      message: `realtime server frame did not have a recognizable {type: string, ...} envelope: ${envelopeResult.left.message}`
    })
  }
  // Validated only that `type` is a string above (`Schema.Struct` ignores excess keys rather than
  // rejecting them) — every other field is read from the raw parsed object below, per-event-type,
  // since each server event type has its own independent field set this client cares about.
  const event = raw as Record<string, unknown>

  switch (event["type"]) {
    case "error": {
      const message = typeof event["error"] === "object" && event["error"] !== null
        ? JSON.stringify(event["error"])
        : "realtime server sent an error event"
      return new RealtimeVoiceProtocolError({ message: `realtime server error event: ${message}` })
    }
    case "conversation.item.input_audio_transcription.delta":
      return typeof event["delta"] === "string"
        ? new VoiceUserTranscriptDelta({ kind: "user_transcript_delta", delta: event["delta"] })
        : undefined
    case "conversation.item.input_audio_transcription.completed":
      return new VoiceUserTranscriptCompleted({
        kind: "user_transcript_completed",
        text: typeof event["transcript"] === "string" ? event["transcript"] : ""
      })
    // Both the audio-transcript delta (what's being spoken) and the text-modality delta (when a
    // session runs text-only) map onto the same domain event — `RealtimeVoiceEvent` deliberately
    // has one "the assistant said/is-saying X" variant, not two, since every caller of this
    // interface (a future `VoiceTurnService`) wants "the assistant's words" regardless of which
    // modality produced them.
    case "response.output_audio_transcript.delta":
    case "response.output_text.delta":
      return typeof event["delta"] === "string"
        ? new VoiceAssistantTextDelta({ kind: "assistant_text_delta", delta: event["delta"] })
        : undefined
    case "response.output_audio.delta":
      return typeof event["delta"] === "string"
        ? new VoiceAssistantAudioDelta({ kind: "assistant_audio_delta", audioBase64: event["delta"] })
        : undefined
    case "response.output_item.added": {
      const item = event["item"] as Record<string, unknown> | undefined
      if (item?.["type"] === "function_call" && typeof item["call_id"] === "string" && typeof item["name"] === "string") {
        pendingToolCalls.set(item["call_id"], { name: item["name"] })
      }
      return undefined
    }
    case "response.function_call_arguments.done": {
      const callId = event["call_id"]
      const argumentsJson = event["arguments"]
      if (typeof callId !== "string" || typeof argumentsJson !== "string") return undefined
      const pending = pendingToolCalls.get(callId)
      if (pending === undefined) {
        return new RealtimeVoiceProtocolError({
          message: `response.function_call_arguments.done referenced unknown call_id ${callId} ` +
            "(no matching response.output_item.added seen this session)"
        })
      }
      pendingToolCalls.delete(callId)
      let input: unknown
      try {
        input = JSON.parse(argumentsJson)
      } catch (cause) {
        return new RealtimeVoiceProtocolError({
          message: `response.function_call_arguments.done had non-JSON arguments: ${cause instanceof Error ? cause.message : String(cause)}`
        })
      }
      return new VoiceToolCallRequested({
        kind: "tool_call_requested",
        callId,
        name: pending.name,
        input: input as never
      })
    }
    case "response.done":
      return new VoiceTurnCompleted({ kind: "turn_completed" })
    default:
      return undefined
  }
}

// --- The Layer -----------------------------------------------------------------------------

type QueueItem = { readonly _tag: "event"; readonly event: RealtimeVoiceEvent } | {
  readonly _tag: "error"
  readonly error: RealtimeVoiceProtocolError
}

export const makeRealtimeVoiceClientOpenAILive = (
  config: RealtimeVoiceClientOpenAIConfig
): Layer.Layer<RealtimeVoiceClient, never, WebSocketTransport> =>
  Layer.effect(
    RealtimeVoiceClient,
    Effect.gen(function* () {
      const transport = yield* WebSocketTransport
      const model = config.model ?? DEFAULT_MODEL

      const openSession = (
        sessionConfig: RealtimeVoiceSessionConfig
      ): Effect.Effect<RealtimeVoiceSession, RealtimeVoiceError, Scope.Scope> =>
        Effect.gen(function* () {
          const apiKey = config.apiKey
          if (apiKey === undefined || apiKey.length === 0) {
            return yield* Effect.fail(
              new RealtimeVoiceUnavailable({
                message: "RealtimeVoiceClientOpenAI: no API key configured (OPENAI_REALTIME_API_KEY unset)"
              })
            )
          }

          // GATEWAY mode: see this config field's own doc comment above — the GA header set
          // (`Authorization` only) is unchanged either way, `cf-aig-authorization` is just one
          // more entry alongside it when an Authenticated Gateway token is configured.
          const connectUrl = config.gateway === undefined
            ? `${REALTIME_URL_BASE}?model=${encodeURIComponent(model)}`
            : gatewayRealtimeWsUrl(config.gateway, model)

          const ws = yield* Effect.acquireRelease(
            transport.connect(connectUrl, {
              Authorization: `Bearer ${apiKey}`,
              ...gatewayAuthHeader(config.gateway)
            }).pipe(
              Effect.mapError(
                (failure) => new RealtimeVoiceConnectionFailed({ message: failure.message })
              )
            ),
            (socket) => Effect.sync(() => socket.close())
          )

          const queue = yield* Effect.acquireRelease(
            Queue.unbounded<QueueItem>(),
            (q) => Queue.shutdown(q)
          )
          const pendingToolCalls = new Map<string, PendingToolCall>()

          registerListeners(ws, queue, pendingToolCalls)

          // Establish the session's tools/instructions immediately on connect — see this file's
          // header comment on the deliberately-narrowed `session.update` body sent here.
          ws.send(
            JSON.stringify({
              type: "session.update",
              session: {
                type: "realtime",
                ...(sessionConfig.systemPrompt === undefined ? {} : { instructions: sessionConfig.systemPrompt }),
                ...(sessionConfig.tools.length === 0 ? {} : { tools: sessionConfig.tools.map(toRealtimeTool) })
              }
            })
          )

          const session: RealtimeVoiceSession = {
            sendAudioChunk: (pcm16) =>
              Effect.sync(() =>
                ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64FromBytes(pcm16) }))
              ),
            commitAudioAndRespond: () =>
              Effect.sync(() => {
                ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }))
                ws.send(JSON.stringify({ type: "response.create" }))
              }),
            submitToolResult: (callId, output) =>
              Effect.sync(() => {
                ws.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: { type: "function_call_output", call_id: callId, output }
                  })
                )
                ws.send(JSON.stringify({ type: "response.create" }))
              }),
            events: Stream.fromQueue(queue).pipe(
              Stream.flatMap((item) => (item._tag === "event" ? Stream.succeed(item.event) : Stream.fail(item.error)))
            ),
            close: () => Effect.sync(() => ws.close())
          }
          return session
        })

      return { openSession }
    })
  )

/** Bridges the WebSocket's callback-based `addEventListener` API into the Effect `Queue` — real,
 *  necessarily-imperative glue code (an event listener cannot `yield*` an Effect), using
 *  `Queue.unsafeOffer` exactly as that function exists for: a synchronous producer feeding an
 *  Effect-native consumer. */
const registerListeners = (
  ws: WebSocketLike,
  queue: Queue.Queue<QueueItem>,
  pendingToolCalls: Map<string, PendingToolCall>
): void => {
  ws.addEventListener("message", (event) => {
    const raw = event.data
    let parsed: unknown
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    } catch (cause) {
      Queue.unsafeOffer(
        queue,
        {
          _tag: "error",
          error: new RealtimeVoiceProtocolError({
            message: `realtime server sent a non-JSON frame: ${cause instanceof Error ? cause.message : String(cause)}`
          })
        }
      )
      return
    }
    const decoded = decodeServerEvent(parsed, pendingToolCalls)
    if (decoded === undefined) return
    Queue.unsafeOffer(
      queue,
      decoded instanceof RealtimeVoiceProtocolError ? { _tag: "error", error: decoded } : { _tag: "event", event: decoded }
    )
  })
  ws.addEventListener("error", () => {
    Queue.unsafeOffer(queue, {
      _tag: "error",
      error: new RealtimeVoiceProtocolError({ message: "realtime WebSocket transport reported an error" })
    })
  })
}
