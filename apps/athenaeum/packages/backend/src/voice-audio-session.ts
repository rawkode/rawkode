// The live half of `voice-audio-rpc.ts`'s five methods — see that file's header comment for the
// full transport-shape rationale (polling, not a `subscribeToNodes`-style push `RpcTarget`, since
// native's Cap'n Web client is deliberately HTTP-batch-only, per `native/docs/decisions.md`).
//
// One `LiveVoiceAudioSessionHandle` per open `audioSessionId`, held in a `Map` on the owning
// `WorkspaceDurableObject` INSTANCE (`workspace-durable-object.ts`'s `#liveVoiceAudioSessions`) — not on
// `WorkspaceRpcApi`, which is reconstructed fresh on every single HTTP-batch request
// (`fetch()`'s `new WorkspaceRpcApi(...)` call sites) and would lose the handle between "open" and the
// next "send"/"poll" call. The DO instance itself persists across separate requests for as long as
// it isn't evicted — the same lifetime `#collections`/`#runtime` already rely on.
//
// Reuses `voice-chat-bridge.ts#runVoiceChatTurns`'s exact composition (a completed user-transcript
// event's text becomes `AgentEditService.sendChatMessage`'s `text` argument, unchanged — the
// plan's hard constraint) but as a live background dispatch loop instead of a run-to-completion
// collector: every event is ALSO pushed to a poll queue (so a client watching this session's
// transcript/tool-call activity sees it), and `user_transcript_completed` additionally triggers a
// real agent turn in the background, exactly like `runVoiceChatTurns` does. A turn's own failure
// (e.g. `ModelUnavailable` — no `ANTHROPIC_API_KEY` in this environment) is swallowed here rather
// than killing the dispatch loop: one failed turn shouldn't end the whole voice session, and the
// client already has its own path to that same "model not configured" message
// (`AgentEditViewModel.describeSendError`) via the ordinary chat surface if it also sends a text
// message — this session's own job is only to keep transcription/event flow alive.

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import {
  RealtimeVoiceClient,
  UnexpectedError,
  type EntityId,
  type RealtimeVoiceError,
  type RealtimeVoiceEvent,
  type RealtimeVoiceSession,
  type RealtimeVoiceSessionConfig,
  type DomainError
} from "@athenaeum/domain"
import { AgentEditService } from "./agent-edit-service-live.js"

/** The live, in-memory handle one open `audioSessionId` maps to. Deliberately plain data (no
 *  `RpcTarget` — see this file's header comment): `session` for the imperative
 *  send/commit/close calls, `queue` for `pollVoiceAudioEvents` to drain, `scope` to release on
 *  close (which interrupts the background dispatch fiber forked into it, per `Effect.forkIn`'s
 *  own documented behavior: "the fiber will be interrupted when the scope is closed"). */
export interface LiveVoiceAudioSessionHandle {
  readonly session: RealtimeVoiceSession
  readonly queue: Queue.Queue<RealtimeVoiceEvent>
  readonly scope: Scope.CloseableScope
}

/** Maps the closed `RealtimeVoiceError` channel onto the open `DomainError` channel every RPC
 *  method's `rpc-boundary.ts` throw-boundary expects — same mapping
 *  `WorkspaceDurableObject#debugRunVoiceChatTurns` already established (duplicated, not shared, to
 *  avoid coupling this new file to that debug-only method's own signature). */
export const realtimeVoiceErrorToDomainError = (error: RealtimeVoiceError): DomainError =>
  new UnexpectedError({ message: `${error._tag}: ${error.message}` })

/**
 * Opens a live realtime-voice session scoped to its own `Scope` (returned as part of the handle,
 * NOT the caller's ambient scope — this session must outlive the single RPC call that opens it),
 * and forks the background dispatch loop described in this file's header comment into that same
 * scope. Returns once the session is open and the loop is forked — does not wait for any event.
 */
export const openLiveVoiceAudioSession = (
  chatId: EntityId,
  config: RealtimeVoiceSessionConfig
): Effect.Effect<LiveVoiceAudioSessionHandle, RealtimeVoiceError, RealtimeVoiceClient | AgentEditService> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const voice = yield* RealtimeVoiceClient
    const agentEdit = yield* AgentEditService
    const session = yield* voice.openSession(config).pipe(Scope.extend(scope))
    const queue = yield* Queue.unbounded<RealtimeVoiceEvent>()

    const dispatchLoop = session.events.pipe(
      Stream.mapEffect((event) =>
        Queue.offer(queue, event).pipe(
          Effect.zipRight(
            event.kind === "user_transcript_completed"
              ? agentEdit.sendChatMessage(chatId, event.text).pipe(
                  Effect.catchAll(() => Effect.void),
                  Effect.asVoid
                )
              : Effect.void
          )
        )
      ),
      Stream.runDrain,
      Effect.catchAll(() => Effect.void)
    )
    yield* Effect.forkIn(dispatchLoop, scope)

    return { session, queue, scope }
  })

export const sendVoiceAudioChunk = (
  handle: LiveVoiceAudioSessionHandle,
  pcm16: Uint8Array
): Effect.Effect<void, RealtimeVoiceError> => handle.session.sendAudioChunk(pcm16)

export const commitVoiceAudioAndRespond = (
  handle: LiveVoiceAudioSessionHandle
): Effect.Effect<void, RealtimeVoiceError> => handle.session.commitAudioAndRespond()

/** Non-blocking drain — `Queue.takeAll` resolves immediately with whatever is currently buffered
 *  (empty if nothing), never suspends waiting for the next event. This is the specific Effect
 *  primitive that makes polling from an HTTP-batch-only client correct: a blocking `Queue.take`
 *  here would hang the RPC call (and the native client's synchronous batch round trip) until the
 *  next event arrives, which could be never. */
export const pollVoiceAudioEvents = (
  handle: LiveVoiceAudioSessionHandle
): Effect.Effect<ReadonlyArray<RealtimeVoiceEvent>> => Queue.takeAll(handle.queue).pipe(Effect.map((chunk) => Array.from(chunk)))

/** Closes the live session explicitly (`session.close()` — not every `RealtimeVoiceClient`
 *  implementation ties protocol-level teardown to `Scope` release; the scripted double
 *  (`realtime-voice-client-scripted.ts`) deliberately doesn't, so this must be called directly
 *  rather than assumed), THEN closes the session's own `Scope` (interrupting the background
 *  dispatch fiber and releasing whatever resources `openSession` itself registered — the real
 *  OpenAI client's WebSocket/queue, per its own `Effect.acquireRelease` calls) and shuts down the
 *  poll queue. Never fails — mirrors `RealtimeVoiceSession.close`'s own `Effect<void>` (no error
 *  channel) shape, per `voice-audio-rpc.ts`'s `CloseVoiceAudioSessionInput` doc comment
 *  ("idempotent... a client racing its own cleanup... shouldn't have to distinguish"). */
export const closeLiveVoiceAudioSession = (handle: LiveVoiceAudioSessionHandle): Effect.Effect<void> =>
  handle.session
    .close()
    .pipe(
      Effect.zipRight(Scope.close(handle.scope, Exit.void)),
      Effect.zipRight(Queue.shutdown(handle.queue))
    )

/** Base64 → bytes, the inverse of `realtime-voice-client-openai.ts#base64FromBytes` — same `atob`
 *  + per-character `charCodeAt` approach `dev-auth.ts`/`calendar-oauth-state.ts` already use
 *  elsewhere in this package for the same reason (no `Buffer` dependency, standard Web API only,
 *  works identically in `workerd` and in Vitest's Node test runner). */
export const bytesFromBase64 = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
