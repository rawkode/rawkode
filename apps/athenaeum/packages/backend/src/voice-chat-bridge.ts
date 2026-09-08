// `runVoiceChatTurns` — Phase 6 spike's answer to the plan's "Design how voice-driven agent turns
// reuse Phase 3's AgentEditService/ModelClient unchanged (voice transcription becomes a
// ChatMessage's content, tool-calling proceeds identically) — don't invent a parallel mechanism."
//
// The composition is deliberately almost nothing: a realtime-voice session's completed
// user-transcript text (`VoiceUserTranscriptCompleted.text`) IS `AgentEditService.
// sendChatMessage`'s `text` argument, byte-for-byte — no new `ChatMessage` variant, no new
// `AgentEditService` method, no parallel tool-calling loop. `sendChatMessage` itself (Phase 3,
// unchanged by this file) is what turns that text into a `ChatMessage`, calls the real
// `ModelClient` (Anthropic), and runs its existing tool-calling loop against
// `createNodeTool`/`addFactTool`/etc. — exactly as it already does for a typed chat message.
//
// **Deliberately does NOT use `RealtimeVoiceSession`'s own `VoiceToolCallRequested`/
// `submitToolResult` protocol for tool execution**, even though `realtime-voice-client-openai.ts`
// implements that protocol faithfully (proven by that file's own two-event-join test) — routing
// tool execution through OpenAI's realtime model instead of the existing Anthropic-backed
// `AgentEditService`/`ModelClient` loop would be exactly the "parallel agent mechanism" this task's
// hard constraint forbids. `VoiceToolCallRequested`/`submitToolResult` are kept in the domain
// interface anyway because they are real, verified parts of OpenAI's actual wire protocol (a
// future stage MAY have a real reason to use them — e.g. a low-latency in-band acknowledgment
// while the real Anthropic turn is still running) — this file simply never calls them.
//
// This module answers only the INPUT half explicitly asked for ("voice transcription becomes a
// ChatMessage's content"); speaking the resulting `AgentTurnResult` back out loud is an OUTPUT
// concern this stage deliberately leaves open (see docs/meetings-voice-decisions.md §3's "what
// this does not decide" — OpenAI's Realtime conversation graph is not a verified fit for "speak
// this exact string verbatim," a separate TTS endpoint is the more likely real answer, and closing
// that loop needs its own live-key-verified spike).

import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import {
  type DomainError,
  type EntityId,
  RealtimeVoiceClient,
  type RealtimeVoiceError,
  type RealtimeVoiceSessionConfig
} from "@athenaeum/domain"
import { AgentEditService, type AgentTurnResult } from "./agent-edit-service-live.js"

/**
 * Opens one realtime-voice session scoped to the caller's lifetime, and for every completed user
 * utterance it produces, calls `AgentEditService.sendChatMessage(chatId, text)` — collecting each
 * turn's `AgentTurnResult` in arrival order and returning them once the session's `events` stream
 * ends (the real client's stream ends when the underlying WebSocket closes; the scripted client's
 * ends when its script is exhausted). A real caller (a future native/web voice UI) would instead
 * race this against a "hang up" signal — this spike keeps that policy out of scope, matching
 * `RealtimeVoiceClient.openSession`'s own `Scope`-based "caller controls the lifetime" design.
 */
export const runVoiceChatTurns = (
  chatId: EntityId,
  sessionConfig: RealtimeVoiceSessionConfig
): Effect.Effect<ReadonlyArray<AgentTurnResult>, DomainError | RealtimeVoiceError, RealtimeVoiceClient | AgentEditService> =>
  Effect.scoped(
    Effect.gen(function* () {
      const voice = yield* RealtimeVoiceClient
      const agentEdit = yield* AgentEditService
      const session = yield* voice.openSession(sessionConfig)

      const results: Array<AgentTurnResult> = []
      yield* session.events.pipe(
        Stream.mapEffect((event) =>
          event.kind === "user_transcript_completed"
            ? agentEdit.sendChatMessage(chatId, event.text).pipe(Effect.tap((result) => Effect.sync(() => results.push(result))))
            : Effect.void
        ),
        Stream.runDrain
      )
      return results
    })
  )
