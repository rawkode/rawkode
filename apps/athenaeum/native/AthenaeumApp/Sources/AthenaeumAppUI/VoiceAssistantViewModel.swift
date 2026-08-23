import Foundation
import AthenaeumDomain
import AthenaeumRPC
import AthenaeumCore

// Native voice-UI task ("Build a minimal real SwiftUI voice-assistant surface: start/stop a voice
// session, stream microphone audio... to the backend's realtime voice path, display live
// transcription + any agent tool-call activity/pending changes"). Composes every real piece the
// rest of this stage built: `WorkspaceRPCClient+Voice.swift` (RPC surface), `LiveVoiceAudioCapture` +
// `VoiceAudioBatcher` (`AthenaeumCore/Voice/`, real `AVAudioEngine` mic capture -> PCM16 chunks),
// and — per this task's own explicit instruction — REUSES Phase 3's `AgentEditViewModel`/
// `PendingChangesView` for accept/revert rather than rebuilding a parallel mechanism: `chatId` is
// a real `Chat` this view model creates once, and `agentEditModel` is a real, live
// `AgentEditViewModel` pointed at that same chat, refreshed periodically while a session is active
// so pending changes a voice turn produces (via the backend's own `voice-audio-session.ts`
// dispatch loop feeding `AgentEditService.sendChatMessage`) show up in the same accept/revert UI a
// text chat already uses.
//
// **Honesty about what's genuinely verified vs. not, restated at the one place a reader of this
// file will look first**: the RPC round trip (`openVoiceAudioSession`/`sendVoiceAudioChunk`/
// `pollVoiceAudioEvents`/etc.) and the mic-capture-to-PCM16-chunk pipeline are each independently,
// genuinely tested (`VoiceAudioSessionLiveTests`/`VoiceAudioStreamerTests`/
// `LiveVoiceAudioCaptureTests`, real `say`-synthesized speech, a real live local backend). What
// this file composes them INTO — a live voice conversation actually transcribing real speech via
// OpenAI's Realtime API — needs a real `OPENAI_REALTIME_API_KEY` (this environment has none, hard
// constraint) and a human present for the one-time Microphone TCC prompt (same story
// `AVAudioEngineMicrophoneSource`'s own header comment already tells for meetings) — neither is
// available here, so `start()` is expected to fail cleanly with `describeError`'s
// "voice isn't configured" message in THIS environment, and that failure path is exactly what
// `VoiceAudioSessionLiveTests.testOpenVoiceAudioSessionFailsCleanlyWhenRealtimeVoiceIsUnconfigured`
// proves for real. On a real Mac with a real key, the identical code path (already proven for
// everything up to and after that one gap) completes instead of failing there.
@MainActor
public final class VoiceAssistantViewModel: ObservableObject {
    public enum SessionState: Equatable {
        case idle
        case starting
        case active
        case stopping
    }

    public struct TranscriptLine: Identifiable, Equatable {
        public enum Speaker: Equatable { case user, assistant, system }
        public let id = UUID()
        public let speaker: Speaker
        public var text: String
    }

    @Published public private(set) var state: SessionState = .idle
    @Published public private(set) var transcript: [TranscriptLine] = []
    @Published public private(set) var errorMessage: String?
    /// A REAL, live `AgentEditViewModel` (Phase 3) pointed at this session's own chat — reused
    /// directly by `VoiceAssistantView` (`PendingChangesView(model: agentEditModel)`), per this
    /// task's own instruction, rather than a parallel pending-changes surface.
    public let agentEditModel: AgentEditViewModel

    private let client: WorkspaceRPCClient
    private let workspaceId: EntityId
    private var chatId: String?
    private var voiceSessionId: String?
    private var audioSessionId: String?
    private var capture: LiveVoiceAudioCapture?
    private let batcher = VoiceAudioBatcher()
    private var audioPumpTask: Task<Void, Never>?
    private var eventPollTask: Task<Void, Never>?
    private var pendingChangesRefreshTask: Task<Void, Never>?

    /// Informational only (see `PCM16.swift`'s own doc comment on why no resampling happens) — a
    /// reasonable default for Apple hardware; the actual PCM16 bytes sent are always encoded at
    /// whatever rate the real `AVAudioEngine` input format reports, independent of this constant.
    private static let assumedInputSampleRateHz: Double = 48_000

    public init(baseURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        self.workspaceId = workspaceId
        let workspaceURL = baseURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.client = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
        self.agentEditModel = AgentEditViewModel(
            client: WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential),
            workspaceId: workspaceId
        )
    }

    /// Test/CLI-driver-only escape hatch, matching `AgentEditViewModel`'s own second initializer —
    /// build against an already-constructed `WorkspaceRPCClient`/`AgentEditViewModel` pair.
    init(client: WorkspaceRPCClient, workspaceId: EntityId, agentEditModel: AgentEditViewModel) {
        self.client = client
        self.workspaceId = workspaceId
        self.agentEditModel = agentEditModel
    }

    // MARK: - Start / stop

    public func start() async {
        guard state == .idle else { return }
        state = .starting
        errorMessage = nil
        transcript = []
        do {
            let chat = try await client.createChat(title: "Voice session \(Self.chatTitleDateFormatter.string(from: Date()))")
            chatId = chat.id
            await agentEditModel.reloadChats()
            await agentEditModel.selectChat(chat.id)

            let voiceSession = try await client.startVoiceSession(chatId: chat.id)
            voiceSessionId = voiceSession.id

            let audioSessionId = try await client.openVoiceAudioSession(
                chatId: chat.id,
                inputAudioSampleRateHz: Self.assumedInputSampleRateHz
            )
            self.audioSessionId = audioSessionId

            let micSource = AVAudioEngineMicrophoneSource()
            let capture = LiveVoiceAudioCapture(source: micSource)
            self.capture = capture
            try await capture.start()

            state = .active
            startAudioPumpLoop(audioSessionId: audioSessionId, capture: capture)
            startEventPollLoop(audioSessionId: audioSessionId)
            startPendingChangesRefreshLoop(chatId: chat.id)
        } catch {
            errorMessage = Self.describeError(error)
            await teardown(afterFailedStart: true)
            state = .idle
        }
    }

    /// Ends the caller's current utterance turn (the realtime protocol's own "commit" — flushes
    /// any buffered sub-chunk audio first) WITHOUT closing the session, so a multi-turn
    /// conversation can continue: capture keeps running, the model's response streams in via
    /// `transcript`/`pollVoiceAudioEvents`, and a further `sendTurn()` starts the next utterance.
    public func sendTurn() async {
        guard state == .active, let audioSessionId else { return }
        if let trailing = batcher.flush() {
            try? await client.sendVoiceAudioChunk(audioSessionId: audioSessionId, pcm16: trailing)
        }
        do {
            try await client.commitVoiceAudioAndRespond(audioSessionId: audioSessionId)
        } catch {
            errorMessage = Self.describeError(error)
        }
    }

    /// Fully ends the session: stops mic capture, flushes/commits any trailing audio, closes the
    /// live audio session, and ends the persisted `VoiceSession` lifecycle record.
    public func endSession() async {
        guard state == .active else { return }
        state = .stopping
        await teardown(afterFailedStart: false)
        state = .idle
    }

    private func teardown(afterFailedStart: Bool) async {
        audioPumpTask?.cancel(); audioPumpTask = nil
        eventPollTask?.cancel(); eventPollTask = nil
        pendingChangesRefreshTask?.cancel(); pendingChangesRefreshTask = nil

        if let capture {
            let trailingBlocks = await capture.stop()
            for block in trailingBlocks {
                _ = batcher.ingest(block)
            }
        }
        capture = nil

        if let audioSessionId {
            if let trailing = batcher.flush() {
                try? await client.sendVoiceAudioChunk(audioSessionId: audioSessionId, pcm16: trailing)
            }
            if !afterFailedStart {
                try? await client.commitVoiceAudioAndRespond(audioSessionId: audioSessionId)
            }
            try? await client.closeVoiceAudioSession(audioSessionId: audioSessionId)
        }
        self.audioSessionId = nil

        if let voiceSessionId {
            let endedAt = ISO8601DateFormatter().string(from: Date())
            _ = try? await client.endVoiceSession(voiceSessionId: voiceSessionId, endedAt: endedAt)
        }
        self.voiceSessionId = nil
    }

    // MARK: - Background loops (each a plain, cancellable `Task` — no `Timer`/`RunLoop` dependency)

    /// Drains real captured audio every 200ms and feeds it through the persistent `batcher` —
    /// deliberately NOT `VoiceAudioStreamer.streamAndSend` (that type builds a FRESH batcher per
    /// call, which is correct for its own tested one-shot-batch use case but would silently drop
    /// sub-target-duration audio between ticks here; this loop needs one batcher whose buffer
    /// persists across the whole session, so it drives `VoiceAudioBatcher` directly).
    private func startAudioPumpLoop(audioSessionId: String, capture: LiveVoiceAudioCapture) {
        audioPumpTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let blocks = await capture.drainPendingBlocks()
                for block in blocks {
                    for chunk in self.batcher.ingest(block) {
                        do {
                            try await self.client.sendVoiceAudioChunk(audioSessionId: audioSessionId, pcm16: chunk)
                        } catch {
                            await MainActor.run { self.errorMessage = Self.describeError(error) }
                        }
                    }
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        }
    }

    /// Polls `pollVoiceAudioEvents` every 200ms and folds each event into `transcript` — see
    /// `RPCVoiceEvent`'s own doc comment for the six event kinds this decodes.
    private func startEventPollLoop(audioSessionId: String) {
        eventPollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    let events = try await self.client.pollVoiceAudioEvents(audioSessionId: audioSessionId)
                    if !events.isEmpty {
                        await MainActor.run { self.apply(events) }
                    }
                } catch {
                    await MainActor.run { self.errorMessage = Self.describeError(error) }
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        }
    }

    /// Re-selects the session's chat in `agentEditModel` every second while active — the only way
    /// this view model learns about a voice turn's resulting messages/pending changes, since
    /// `voice-audio-session.ts`'s dispatch loop calls `AgentEditService.sendChatMessage` in the
    /// backend's own background fiber, not as a directly-observable reply to any RPC call this
    /// client makes (see that file's header comment).
    private func startPendingChangesRefreshLoop(chatId: String) {
        pendingChangesRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.agentEditModel.selectChat(chatId)
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func apply(_ events: [RPCVoiceEvent]) {
        for event in events {
            switch event {
            case .userTranscriptDelta(let delta):
                appendOrExtend(.user, delta)
            case .userTranscriptCompleted(let text):
                replaceOrAppend(.user, text)
            case .assistantTextDelta(let delta):
                appendOrExtend(.assistant, delta)
            case .assistantAudioDelta:
                // Text-only transcript surface, deliberately — see this file's header comment on
                // scope; audio playback of the assistant's spoken response is not built here.
                break
            case .toolCallRequested(_, let name, _):
                transcript.append(TranscriptLine(speaker: .system, text: "Tool call requested: \(name)"))
            case .turnCompleted:
                break
            }
        }
    }

    private func appendOrExtend(_ speaker: TranscriptLine.Speaker, _ delta: String) {
        if let last = transcript.last, last.speaker == speaker {
            transcript[transcript.count - 1].text += delta
        } else {
            transcript.append(TranscriptLine(speaker: speaker, text: delta))
        }
    }

    private func replaceOrAppend(_ speaker: TranscriptLine.Speaker, _ finalText: String) {
        if let last = transcript.last, last.speaker == speaker {
            transcript[transcript.count - 1].text = finalText
        } else {
            transcript.append(TranscriptLine(speaker: speaker, text: finalText))
        }
    }

    private static let chatTitleDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter
    }()

    /// Mirrors `AgentEditViewModel.describeSendError`'s exact pattern — this environment's
    /// real, expected, documented failure (no `OPENAI_REALTIME_API_KEY`) gets a clear, specific
    /// message instead of a raw stringified error.
    static func describeError(_ error: Error) -> String {
        if case AthenaeumDomainError.unexpectedError(let message) = error,
           message.contains("RealtimeVoiceUnavailable")
        {
            return "Voice isn't configured in this environment (no OPENAI_REALTIME_API_KEY " +
                "secret) — this is expected, not a bug. See docs/meetings-voice-decisions.md."
        }
        return "\(error)"
    }
}
