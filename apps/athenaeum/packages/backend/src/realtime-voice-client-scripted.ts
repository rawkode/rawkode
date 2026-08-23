// `RealtimeVoiceClientScripted` — the deterministic test double half of the plan's "two real
// Layer implementations" for `RealtimeVoiceClient`. Same FIFO-queue-per-call-log discipline as
// `model-client-scripted.ts`/`cloud-transcription-client-scripted.ts`, generalized to a session:
// `openSession` hands back a `RealtimeVoiceSession` whose `events` stream replays a pre-programmed
// script and whose imperative methods (`sendAudioChunk`/`commitAudioAndRespond`/
// `submitToolResult`) just record what they were called with, exactly mirroring
// `ScriptedConverseCall`'s "record calls so a test can assert what the caller sent, not just what
// it got back" role.

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import {
  RealtimeVoiceClient,
  type RealtimeVoiceEvent,
  type RealtimeVoiceSession,
  type RealtimeVoiceSessionConfig
} from "@athenaeum/domain"

export type ScriptedSessionCall =
  | { readonly kind: "sendAudioChunk"; readonly pcm16: Uint8Array }
  | { readonly kind: "commitAudioAndRespond" }
  | { readonly kind: "submitToolResult"; readonly callId: string; readonly output: string }
  | { readonly kind: "close" }

export interface RealtimeVoiceClientScriptedHandle {
  readonly layer: Layer.Layer<RealtimeVoiceClient>
  /** One entry per `openSession` call, each carrying the config it was opened with and every
   *  imperative call made against that session's handle, in order. */
  readonly sessions: Array<{ readonly config: RealtimeVoiceSessionConfig; readonly calls: Array<ScriptedSessionCall> }>
}

/**
 * Builds a fresh scripted handle. Every `openSession` call succeeds (this double has no
 * `RealtimeVoiceUnavailable`/`RealtimeVoiceConnectionFailed` path — a test that needs to exercise
 * `AgentEditService`'s/a future `VoiceTurnService`'s handling of a failed session open should
 * provide its own one-off `Layer.fail(RealtimeVoiceClient, ...)` instead of asking this
 * general-purpose double to grow a failure-injection API it doesn't otherwise need) and replays
 * `eventScript` on its `events` stream, ignoring real-world timing — same "correctness of
 * sequencing over faithfulness to latency" scope line `ModelClientScripted` already draws.
 */
export const makeRealtimeVoiceClientScripted = (
  eventScript: ReadonlyArray<RealtimeVoiceEvent>
): RealtimeVoiceClientScriptedHandle => {
  const sessions: RealtimeVoiceClientScriptedHandle["sessions"] = []

  const layer = Layer.succeed(RealtimeVoiceClient, {
    openSession: (config) =>
      Effect.sync(() => {
        const calls: Array<ScriptedSessionCall> = []
        sessions.push({ config, calls })

        const session: RealtimeVoiceSession = {
          sendAudioChunk: (pcm16) => Effect.sync(() => void calls.push({ kind: "sendAudioChunk", pcm16 })),
          commitAudioAndRespond: () => Effect.sync(() => void calls.push({ kind: "commitAudioAndRespond" })),
          submitToolResult: (callId, output) =>
            Effect.sync(() => void calls.push({ kind: "submitToolResult", callId, output })),
          events: Stream.fromIterable(eventScript),
          close: () => Effect.sync(() => void calls.push({ kind: "close" }))
        }
        return session
      })
  })

  return { layer, sessions }
}
