import * as Context from "effect/Context"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as Schema from "effect/Schema"
import { JsonValue } from "./json-value.js"
import { ToolSpec } from "./model-client.js"

// Phase 6 spike (plan §"Meetings & voice", task item 2: "Design pluggable ... RealtimeVoiceClient
// Effect Context.Tags (backend-side) mirroring the ModelClient/GoogleCalendarClient pattern
// exactly ... Investigate real current API shapes for a realtime voice API (WebSocket-based,
// streaming audio in, transcription+tool-calling events out)"). Interface only, same split as
// `cloud-transcription.ts`/`model-client.ts`. Two real `Layer` implementations live in
// `packages/backend`: `RealtimeVoiceClientScripted` and `RealtimeVoiceClientOpenAI` (a real
// WebSocket client against OpenAI's Realtime API — see that file's header comment for the exact
// event shapes verified this stage, current as of the GA `gpt-realtime` event naming). Full
// design, including the deliberate backend-hosted-not-device-direct tradeoff this Context.Tag
// placement makes: docs/meetings-voice-decisions.md §2.

/** A live realtime-voice session is a duplex stream, not a request/response call — this is the
 *  one place in this domain package that reaches for `effect/Stream` rather than a single
 *  `Effect`, because "streaming audio in, transcription+tool-calling events out" (the plan's own
 *  phrasing) is structurally a stream, and forcing it into a single `Effect<Result, Error>` the
 *  way `ModelClient.converse` does would hide that shape rather than model it. */
export class RealtimeVoiceSessionConfig extends Schema.Class<RealtimeVoiceSessionConfig>("RealtimeVoiceSessionConfig")({
  systemPrompt: Schema.optional(Schema.String),
  /** Matches `ModelClient.converse`'s tool-calling contract deliberately (see
   *  docs/meetings-voice-decisions.md §3): a realtime session's tool calls are handed back to the
   *  SAME `AgentEditService` tool-execution machinery a text chat turn already uses, so the tool
   *  set offered here is the identical `ToolSpec[]` a `ChatThread`-based turn would offer. */
  tools: Schema.Array(ToolSpec),
  inputAudioSampleRateHz: Schema.Number
}) {}

// --- Server → caller events ---------------------------------------------------------------------
//
// `kind` (not `_tag`) as the discriminant, same convention/reasoning as `ModelTurnResult` in
// model-client.ts (crosses no Cause/TaggedError machinery). Six variants, each a direct
// generalization of one real OpenAI Realtime server event this stage verified (WebFetch against
// OpenAI's own current docs — see realtime-voice-client-openai.ts's header comment for the exact
// `type` string each variant decodes): input-transcription streaming/completion, assistant
// text/audio streaming, a tool-call request, and turn completion.

export class VoiceUserTranscriptDelta extends Schema.Class<VoiceUserTranscriptDelta>("VoiceUserTranscriptDelta")({
  kind: Schema.Literal("user_transcript_delta"),
  delta: Schema.String
}) {}

export class VoiceUserTranscriptCompleted
  extends Schema.Class<VoiceUserTranscriptCompleted>("VoiceUserTranscriptCompleted")({
    kind: Schema.Literal("user_transcript_completed"),
    text: Schema.String
  })
{}

export class VoiceAssistantTextDelta extends Schema.Class<VoiceAssistantTextDelta>("VoiceAssistantTextDelta")({
  kind: Schema.Literal("assistant_text_delta"),
  delta: Schema.String
}) {}

export class VoiceAssistantAudioDelta extends Schema.Class<VoiceAssistantAudioDelta>("VoiceAssistantAudioDelta")({
  kind: Schema.Literal("assistant_audio_delta"),
  /** Base64, matching the wire encoding OpenAI's own `response.output_audio.delta` event carries
   *  (verified this stage) — re-encoding to bytes here would just make the real client re-encode
   *  it right back for the caller with no benefit, since the caller's job (play it) wants a
   *  byte string either way and every consumer on this path is JS. */
  audioBase64: Schema.String
}) {}

export class VoiceToolCallRequested extends Schema.Class<VoiceToolCallRequested>("VoiceToolCallRequested")({
  kind: Schema.Literal("tool_call_requested"),
  callId: Schema.String.pipe(Schema.minLength(1)),
  name: Schema.String.pipe(Schema.minLength(1)),
  input: JsonValue
}) {}

export class VoiceTurnCompleted extends Schema.Class<VoiceTurnCompleted>("VoiceTurnCompleted")({
  kind: Schema.Literal("turn_completed")
}) {}

export const RealtimeVoiceEvent = Schema.Union(
  VoiceUserTranscriptDelta,
  VoiceUserTranscriptCompleted,
  VoiceAssistantTextDelta,
  VoiceAssistantAudioDelta,
  VoiceToolCallRequested,
  VoiceTurnCompleted
)
export type RealtimeVoiceEvent = typeof RealtimeVoiceEvent.Type

// --- RealtimeVoiceError: the closed failure channel, same 3-variant shape as ModelError ---------

export class RealtimeVoiceUnavailable extends Data.TaggedError("RealtimeVoiceUnavailable")<{
  readonly message: string
}> {}

export class RealtimeVoiceConnectionFailed extends Data.TaggedError("RealtimeVoiceConnectionFailed")<{
  readonly message: string
}> {}

export class RealtimeVoiceProtocolError extends Data.TaggedError("RealtimeVoiceProtocolError")<{
  readonly message: string
}> {}

export type RealtimeVoiceError = RealtimeVoiceUnavailable | RealtimeVoiceConnectionFailed | RealtimeVoiceProtocolError

/**
 * A live, open session's imperative half — the caller-to-server actions a duplex voice
 * conversation needs beyond "push audio," matching what a real tool-calling realtime turn
 * requires (OpenAI's own protocol: audio must be explicitly committed to end a user turn, and a
 * tool result is submitted as its own message before the model can continue — verified this
 * stage). Deliberately plain methods returning `Effect`, not a `Stream` — these ARE
 * request/response-shaped (an audio chunk is fire-and-forget, a commit either succeeds or the
 * connection is dead), unlike `events` below.
 */
export interface RealtimeVoiceSession {
  readonly sendAudioChunk: (pcm16: Uint8Array) => Effect.Effect<void, RealtimeVoiceError>
  /** Ends the caller's current turn and asks the model to respond — the realtime-protocol
   *  equivalent of `ModelClient.converse` being invoked at all (a text-chat turn has no separate
   *  "commit" step because the whole message arrives in one call; a streamed-audio turn does). */
  readonly commitAudioAndRespond: () => Effect.Effect<void, RealtimeVoiceError>
  /** The realtime-protocol equivalent of appending a `ChatToolResultBlock` to a `ChatThread` and
   *  calling `converse` again — same round-trip shape as `ModelClient`'s tool-result contract,
   *  retargeted to this protocol's explicit `callId` framing. */
  readonly submitToolResult: (callId: string, output: string) => Effect.Effect<void, RealtimeVoiceError>
  readonly events: import("effect/Stream").Stream<RealtimeVoiceEvent, RealtimeVoiceError>
  readonly close: () => Effect.Effect<void>
}

/**
 * The pluggable realtime-voice service (plan: "Design pluggable ... RealtimeVoiceClient Effect
 * Context.Tags (backend-side)"). `openSession` returns its handle in `Effect.Effect<..., Scope>`
 * — the session (and, for the real implementation, the underlying WebSocket) is a scoped
 * resource, released automatically when the scope closes, mirroring this plan's own stated
 * discipline around `RpcTarget`/live-subscription resource lifecycle (plan §"Verification",
 * Phase 0 exit criterion) rather than requiring every caller to remember an explicit
 * `session.close()` on every exit path.
 */
export class RealtimeVoiceClient extends Context.Tag("@athenaeum/domain/RealtimeVoiceClient")<
  RealtimeVoiceClient,
  {
    readonly openSession: (
      config: RealtimeVoiceSessionConfig
    ) => Effect.Effect<RealtimeVoiceSession, RealtimeVoiceError, Scope.Scope>
  }
>() {}
