import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"
import { RealtimeVoiceEvent, RealtimeVoiceSessionConfig } from "./realtime-voice.js"

// Native-voice-UI task ("Build a minimal real SwiftUI voice-assistant surface... stream
// microphone audio... to the backend's realtime voice path"). `voice-session-rpc.ts` only
// brackets a `VoiceSession`'s PERSISTED lifecycle row (its own header comment: "a voice session's
// own audio/event stream is not itself an RPC method — it rides RealtimeVoiceClient.openSession's
// live Scope'd duplex stream, backend-side"); this file is that missing live-stream RPC surface,
// deliberately never built until now because no client needed it yet.
//
// **Transport shape, a deliberate choice, not the only possible one**: `RealtimeVoiceSession`
// (realtime-voice.ts) is a live duplex handle — exactly the kind of thing `nodes-subscription.ts`
// already solved once for `subscribeToNodes`, by returning a Cap'n Web `RpcTarget` the client
// holds across further calls. That shape needs a persistent Cap'n Web session (WebSocket), which
// `native/docs/decisions.md` (Phase 2) explicitly named as future work: "If a later phase (e.g.
// native voice, Phase 6) needs native push, extend this client with newWebSocketRpcSession's wire
// shape... don't re-derive the protocol from scratch." Building a full WebSocket-mode Cap'n Web
// client in Swift from scratch is a substantial undertaking on its own and out of proportion to
// this task's own scope (a minimal voice UI, not a native transport rewrite) — so this file
// instead threads the SAME live session through five plain HTTP-batch-compatible request/response
// methods, keyed by a server-issued `audioSessionId`, with `pollVoiceAudioEvents` as an explicit
// non-blocking drain-and-return-what's-buffered call the client repeats on a short interval
// (~200ms in `VoiceSessionViewModel`). This is honestly a deliberate simplification versus true
// server push, documented here rather than silently substituted — see
// `docs/meetings-voice-decisions.md` §4 for the full tradeoff writeup. The live session itself
// (`RealtimeVoiceClient.openSession`, the real OpenAI-backed implementation, or the scripted
// double in tests) is completely unaffected by this choice; only how a client observes its
// `events` stream differs from `subscribeToNodes`'s push shape.
//
// Every method is workspace-scoped and, per this app's now twice-broken-and-fixed rule (Phase 4's
// `requireRoleForGovernedWorkspace` gap, Phase 5's caller-auth gap), calls
// `requireRoleForGovernedWorkspace` — mutations (`open`/`send`/`commit`/`close`) gate on `"build"`
// (same classification `startVoiceSession`/`endVoiceSession` already use), `poll` gates on
// `"use"` (a read of already-buffered events, not a new mutation).

/** Opens a live realtime-voice duplex session against an already-existing `Chat` (same
 *  chatId-not-a-new-chat convention `startVoiceSession` established) and returns an opaque
 *  `audioSessionId` the caller uses for every subsequent call on this file's other four methods.
 *  Fails with `ChatNotFound` if `chatId` doesn't reference a real chat in this workspace (same check
 *  `startVoiceSession` performs, duplicated here rather than shared — see
 *  `voice-audio-session.ts`'s own header comment for why), or with the real
 *  `RealtimeVoiceUnavailable`/`RealtimeVoiceConnectionFailed` (mapped to `UnexpectedError`, same
 *  convention `debugRunVoiceChatTurns` already established) if opening the underlying session
 *  itself fails — in this environment (no `OPENAI_REALTIME_API_KEY`), it always will, honestly,
 *  before any network I/O. */
export class OpenVoiceAudioSessionInput extends Schema.Class<OpenVoiceAudioSessionInput>(
  "OpenVoiceAudioSessionInput"
)({
  workspaceId: EntityId,
  chatId: EntityId,
  sessionConfig: RealtimeVoiceSessionConfig
}) {}

export class OpenVoiceAudioSessionOutput extends Schema.Class<OpenVoiceAudioSessionOutput>(
  "OpenVoiceAudioSessionOutput"
)({
  audioSessionId: Schema.String
}) {}

/** Pushes one chunk of PCM16 microphone audio into the live session, base64-encoded (same wire
 *  convention `VoiceAssistantAudioDelta` already documents for the opposite direction — one JS
 *  string round-trips cleanly through `Schema.decodeUnknown`/Cap'n Web where a raw byte array
 *  would need its own encoding decision anyway). Fire-and-forget from the caller's perspective —
 *  matches `RealtimeVoiceSession.sendAudioChunk`'s own `Effect<void, RealtimeVoiceError>` shape. */
export class SendVoiceAudioChunkInput extends Schema.Class<SendVoiceAudioChunkInput>(
  "SendVoiceAudioChunkInput"
)({
  workspaceId: EntityId,
  audioSessionId: Schema.String,
  pcm16Base64: Schema.String
}) {}

// `{accepted}` rather than an empty `{}` payload deliberately — an all-empty-fields `Schema.Class`
// encodes as an identity transform (found empirically: `Schema.encodeSync` on a zero-field class
// returns the class instance itself, unchanged, not a plain object), which Cap'n Web's serializer
// then rejects outright ("Cannot serialize value: SendVoiceAudioChunkOutput({  })" — a live class
// instance with methods isn't a value its Devalue-style wire encoding recognizes). Every
// zero-meaningful-content output below carries one real boolean field instead, sidestepping that
// edge case with a marginally more informative wire shape rather than a workaround.
export class SendVoiceAudioChunkOutput extends Schema.Class<SendVoiceAudioChunkOutput>(
  "SendVoiceAudioChunkOutput"
)({ accepted: Schema.Boolean }) {}

/** The realtime-protocol "end of my turn, please respond" signal — mirrors
 *  `RealtimeVoiceSession.commitAudioAndRespond` exactly. */
export class CommitVoiceAudioInput extends Schema.Class<CommitVoiceAudioInput>(
  "CommitVoiceAudioInput"
)({
  workspaceId: EntityId,
  audioSessionId: Schema.String
}) {}

export class CommitVoiceAudioOutput extends Schema.Class<CommitVoiceAudioOutput>(
  "CommitVoiceAudioOutput"
)({ accepted: Schema.Boolean }) {}

/** Drains and returns every `RealtimeVoiceEvent` buffered since the last poll — never blocks, may
 *  return an empty array. The client's job (not this method's) is to call this repeatedly on a
 *  short interval for the duration the session is open, per this file's header comment. */
export class PollVoiceAudioEventsInput extends Schema.Class<PollVoiceAudioEventsInput>(
  "PollVoiceAudioEventsInput"
)({
  workspaceId: EntityId,
  audioSessionId: Schema.String
}) {}

export class PollVoiceAudioEventsOutput extends Schema.Class<PollVoiceAudioEventsOutput>(
  "PollVoiceAudioEventsOutput"
)({
  events: Schema.Array(RealtimeVoiceEvent)
}) {}

/** Closes the live session (releases its `Scope`, per `RealtimeVoiceClient.openSession`'s own
 *  doc comment on resource lifecycle) and forgets `audioSessionId`. Idempotent — closing an
 *  already-closed or unknown `audioSessionId` is a no-op, not an error, matching
 *  `RealtimeVoiceSession.close`'s own `Effect<void>` (no error channel) shape; a client racing its
 *  own cleanup against a session that already ended server-side (e.g. the underlying WebSocket
 *  dropped) shouldn't have to distinguish that from a normal close. */
export class CloseVoiceAudioSessionInput extends Schema.Class<CloseVoiceAudioSessionInput>(
  "CloseVoiceAudioSessionInput"
)({
  workspaceId: EntityId,
  audioSessionId: Schema.String
}) {}

export class CloseVoiceAudioSessionOutput extends Schema.Class<CloseVoiceAudioSessionOutput>(
  "CloseVoiceAudioSessionOutput"
)({ closed: Schema.Boolean }) {}
