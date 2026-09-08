import Foundation

// Native voice-UI task ("Build a minimal real SwiftUI voice-assistant surface... stream
// microphone audio... to the backend's realtime voice path"). The native client for
// `packages/domain/src/voice-session-rpc.ts`'s two persisted-lifecycle methods AND
// `packages/domain/src/voice-audio-rpc.ts`'s five live-session methods — this file's own new
// backend RPC surface, added alongside this native work because no client needed it until now
// (see `voice-audio-rpc.ts`'s header comment for the full design, especially why this is a
// POLLING transport, not a `subscribeToNodes`-style push `RpcTarget`: this HTTP-batch-only client
// deliberately doesn't implement Cap'n Web's WebSocket mode — `native/docs/decisions.md`'s own
// "extend this client with newWebSocketRpcSession... if a later phase needs native push" note is
// the future work this file's polling design deliberately avoids taking on this stage).
//
// Same ad-hoc "RPC*"-prefixed decode-struct convention as every other `WorkspaceRPCClient+*.swift`
// extension file. All seven methods below are `requireRoleForGovernedWorkspace`-gated server-side
// (`startVoiceSession`/`endVoiceSession`/`openVoiceAudioSession`/`sendVoiceAudioChunk`/
// `commitVoiceAudioAndRespond`/`closeVoiceAudioSession` -> `"build"`, `pollVoiceAudioEvents` ->
// `"use"`) — confirmed by reading `workspace-durable-object.ts`'s own new section, not assumed.

/// Mirrors `packages/domain/src/voice-session.ts`'s `VoiceSession` — the persisted lifecycle row.
public struct RPCVoiceSession: Sendable, Equatable {
    public let id: String
    public let workspaceId: String
    public let chatId: String
    public let startedAt: String
    public let endedAt: String?
    public let status: String

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let chatId = try value.field("chatId").stringValue,
              let startedAt = try value.field("startedAt").stringValue,
              let status = try value.field("status").stringValue
        else { throw CapnWebError.malformedMessage("malformed VoiceSession: \(value)") }
        self.id = id
        self.workspaceId = workspaceId
        self.chatId = chatId
        self.startedAt = startedAt
        self.status = status
        self.endedAt = try value.field("endedAt").stringValue
    }
}

/// Mirrors `packages/domain/src/realtime-voice.ts`'s `RealtimeVoiceEvent` union — `kind`
/// discriminated, one native `enum` case per TS `Schema.Class` variant. `toolCall`'s `input` is
/// kept as the raw JSON-stringified payload (not decoded further) — no client on this surface
/// executes realtime-protocol tool calls itself (per `voice-chat-bridge.ts`'s own deliberate
/// choice: tool calls are handled by the REAL `AgentEditService`/`ModelClient` loop server-side,
/// not this protocol's own `submitToolResult` path), so there is nothing here that needs its
/// structured shape, only enough to display "the model tried to call `name`" if a UI ever wants to.
public enum RPCVoiceEvent: Sendable, Equatable {
    case userTranscriptDelta(delta: String)
    case userTranscriptCompleted(text: String)
    case assistantTextDelta(delta: String)
    case assistantAudioDelta(audioBase64: String)
    case toolCallRequested(callId: String, name: String, inputJSON: String)
    case turnCompleted

    init(_ value: CapnWebValue) throws {
        guard let kind = try value.field("kind").stringValue else {
            throw CapnWebError.malformedMessage("malformed RealtimeVoiceEvent (missing kind): \(value)")
        }
        switch kind {
        case "user_transcript_delta":
            self = .userTranscriptDelta(delta: try value.field("delta").stringValue ?? "")
        case "user_transcript_completed":
            self = .userTranscriptCompleted(text: try value.field("text").stringValue ?? "")
        case "assistant_text_delta":
            self = .assistantTextDelta(delta: try value.field("delta").stringValue ?? "")
        case "assistant_audio_delta":
            self = .assistantAudioDelta(audioBase64: try value.field("audioBase64").stringValue ?? "")
        case "tool_call_requested":
            self = .toolCallRequested(
                callId: try value.field("callId").stringValue ?? "",
                name: try value.field("name").stringValue ?? "",
                inputJSON: String(describing: try value.field("input"))
            )
        case "turn_completed":
            self = .turnCompleted
        default:
            throw CapnWebError.malformedMessage("unknown RealtimeVoiceEvent kind: \(kind)")
        }
    }
}

extension WorkspaceRPCClient {
    // MARK: - Voice session (persisted lifecycle — voice-session-rpc.ts)

    /// `role` gate: `"build"`. Creates a `VoiceSession` row against an already-existing `chatId`
    /// (same convention `startMeeting`-adjacent methods use — a voice conversation's turns land in
    /// this real `Chat`'s own message log, unchanged, per the plan's hard constraint).
    public func startVoiceSession(chatId: String) async throws -> RPCVoiceSession {
        let result = try await rpc("startVoiceSession", ["chatId": .string(chatId)])
        return try RPCVoiceSession(result.field("voiceSession"))
    }

    /// `role` gate: `"build"`. `endedAt` is an ISO-8601 string, same convention `endMeeting` uses.
    public func endVoiceSession(voiceSessionId: String, endedAt: String) async throws -> RPCVoiceSession {
        let result = try await rpc("endVoiceSession", [
            "voiceSessionId": .string(voiceSessionId),
            "endedAt": .string(endedAt)
        ])
        return try RPCVoiceSession(result.field("voiceSession"))
    }

    // MARK: - Live voice-audio session (voice-audio-rpc.ts)

    /// `role` gate: `"build"`. Opens the live realtime-voice duplex session and returns the opaque
    /// `audioSessionId` every other method in this section keys off. `tools: []` always — the
    /// realtime session's own native tool-calling is deliberately unused (this file's own header
    /// comment); the real tool set lives server-side in `AgentEditService`'s ordinary chat loop.
    public func openVoiceAudioSession(chatId: String, inputAudioSampleRateHz: Double) async throws -> String {
        let sessionConfig = CapnWebValue.object([
            "tools": .array([]),
            "inputAudioSampleRateHz": .number(inputAudioSampleRateHz)
        ])
        let result = try await rpc("openVoiceAudioSession", [
            "chatId": .string(chatId),
            "sessionConfig": sessionConfig
        ])
        guard let audioSessionId = try result.field("audioSessionId").stringValue else {
            throw CapnWebError.malformedMessage("openVoiceAudioSession: missing audioSessionId: \(result)")
        }
        return audioSessionId
    }

    /// `role` gate: `"build"`. Pushes one chunk of PCM16 mono audio, base64-encoded (matching
    /// `voice-audio-rpc.ts`'s `SendVoiceAudioChunkInput.pcm16Base64` wire convention).
    public func sendVoiceAudioChunk(audioSessionId: String, pcm16: Data) async throws {
        _ = try await rpc("sendVoiceAudioChunk", [
            "audioSessionId": .string(audioSessionId),
            "pcm16Base64": .string(pcm16.base64EncodedString())
        ])
    }

    /// `role` gate: `"build"`. The realtime-protocol "end of my turn, please respond" signal.
    public func commitVoiceAudioAndRespond(audioSessionId: String) async throws {
        _ = try await rpc("commitVoiceAudioAndRespond", ["audioSessionId": .string(audioSessionId)])
    }

    /// `role` gate: `"use"`. Drains and returns every `RealtimeVoiceEvent` buffered server-side
    /// since the last poll — never blocks, may return an empty array. Callers poll this
    /// repeatedly on a short interval for the duration the session is open (`VoiceAssistantViewModel`
    /// uses 200ms) — see `voice-audio-rpc.ts`'s header comment for why polling, not push.
    public func pollVoiceAudioEvents(audioSessionId: String) async throws -> [RPCVoiceEvent] {
        let result = try await rpc("pollVoiceAudioEvents", ["audioSessionId": .string(audioSessionId)])
        return try (result.field("events").arrayValue ?? []).map(RPCVoiceEvent.init)
    }

    /// `role` gate: `"build"`. Idempotent — closing an unknown/already-closed `audioSessionId` is
    /// a no-op server-side, matching `voice-audio-rpc.ts`'s own doc comment.
    public func closeVoiceAudioSession(audioSessionId: String) async throws {
        _ = try await rpc("closeVoiceAudioSession", ["audioSessionId": .string(audioSessionId)])
    }
}
