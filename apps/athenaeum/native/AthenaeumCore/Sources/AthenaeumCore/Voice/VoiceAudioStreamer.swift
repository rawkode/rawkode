import Foundation
import AthenaeumRPC

// Piece 3 of 3 (see `PCM16.swift`'s header comment) — the native voice-UI task's own composition
// point, the same role `MeetingTranscriptionPipeline.swift` plays for meetings: wires the real
// `AudioCaptureSource` abstraction to the real `WorkspaceRPCClient` voice-audio RPC surface
// (`WorkspaceRPCClient+Voice.swift`), decoupled by protocol for the same testability reason that
// file's own header comment states (`TranscriptSegmentSink`'s rationale, restated here for
// `VoiceAudioSink`) — no live backend, no TCC-gated capture needed to test the chunking/batching
// logic itself.
//
// Two types, deliberately split by testability the same way Meetings' own pipeline is split from
// its live capture sources:
//
//   - `VoiceAudioStreamer` — pure, deterministic, batch-oriented (`streamAndSend(blocks:...)`,
//     mirroring `MeetingTranscriptionPipeline.transcribeAndAppend(blocks:...)`'s exact shape).
//     Fully tested against `SyntheticAudioSource.allBlocks` (real `say`-synthesized speech) and a
//     fake `VoiceAudioSink` — see `VoiceAudioStreamerTests.swift`.
//   - `LiveVoiceAudioCapture` — the live glue: wires a REAL `AudioCaptureSource.start(onBlock:)`
//     callback (arbitrary-thread, per that protocol's own doc comment) into an actor-isolated
//     buffer a caller drains on a timer, feeding the drained blocks through the same
//     `VoiceAudioStreamer.streamAndSend` every other path already uses — one code path for
//     "batch" and "live," not two. Its own buffering logic (not real capture hardware) IS tested
//     here too, against `SyntheticAudioSource` driven through the real `AudioCaptureSource`
//     protocol; what remains genuinely untestable in this environment is exactly what Meetings'
//     own header comments already establish: `ScreenCaptureKitAudioSource`/
//     `AVAudioEngineMicrophoneSource` actually receiving live hardware audio needs a human present
//     for the one-time TCC prompt (docs/meetings-voice-decisions.md §1).

/// The minimal capability this pipeline needs from an RPC client — exactly
/// `WorkspaceRPCClient.sendVoiceAudioChunk`/`.commitVoiceAudioAndRespond`'s signatures
/// (`WorkspaceRPCClient+Voice.swift`). Abstracted as a protocol purely for testability, same rationale
/// as `TranscriptSegmentSink`; the real implementation IS `WorkspaceRPCClient`, not a parallel client.
public protocol VoiceAudioSink: Sendable {
    func sendVoiceAudioChunk(audioSessionId: String, pcm16: Data) async throws
    func commitVoiceAudioAndRespond(audioSessionId: String) async throws
}

extension WorkspaceRPCClient: VoiceAudioSink {}

/// Real batching + RPC-send pipeline over a batch of already-captured `AudioSampleBlock`s — see
/// this file's header comment for why "batch, not a live callback directly" is the tested shape
/// (matching `MeetingTranscriptionPipeline`'s own precedent exactly).
public struct VoiceAudioStreamer: Sendable {
    public init() {}

    /// Runs `blocks` through a fresh `VoiceAudioBatcher` and sends each completed PCM16 chunk via
    /// `sink.sendVoiceAudioChunk`, in order; if `flushTrailing`, also sends whatever sub-chunk
    /// audio remains buffered at the end (the same "don't silently drop trailing audio" discipline
    /// `AudioChunker.flush()` documents for meetings). Returns the number of chunks sent.
    @discardableResult
    public func streamAndSend(
        blocks: [AudioSampleBlock],
        audioSessionId: String,
        sink: VoiceAudioSink,
        targetChunkDurationSeconds: Double = 0.2,
        flushTrailing: Bool = true
    ) async throws -> Int {
        let batcher = VoiceAudioBatcher(targetChunkDurationSeconds: targetChunkDurationSeconds)
        var sent = 0
        for block in blocks {
            for chunk in batcher.ingest(block) {
                try await sink.sendVoiceAudioChunk(audioSessionId: audioSessionId, pcm16: chunk)
                sent += 1
            }
        }
        if flushTrailing, let trailing = batcher.flush() {
            try await sink.sendVoiceAudioChunk(audioSessionId: audioSessionId, pcm16: trailing)
            sent += 1
        }
        return sent
    }
}

/// The live glue between a real `AudioCaptureSource` and `VoiceAudioStreamer` (see this file's
/// header comment). An actor so the buffer is safe against `AudioCaptureSource`'s own documented
/// "`onBlock` may be called from any thread" contract without a caller needing its own locking.
public actor LiveVoiceAudioCapture {
    private let source: AudioCaptureSource
    private var pendingBlocks: [AudioSampleBlock] = []
    private var isRunning = false
    private var consumerTask: Task<Void, Never>?
    private var continuation: AsyncStream<AudioSampleBlock>.Continuation?

    public init(source: AudioCaptureSource) {
        self.source = source
    }

    /// Starts real capture. `onBlock` itself is a synchronous, non-isolated closure
    /// (`AudioCaptureSource`'s own signature) that may be called from any thread — rather than
    /// hopping onto this actor with one unstructured `Task` per block (found, empirically, in this
    /// stage's own test run, to reorder blocks under concurrent scheduling: two `Task`s created in
    /// quick succession from different threads are not guaranteed to reach the actor in creation
    /// order), `onBlock` synchronously yields into an `AsyncStream`, and a single consumer `Task`
    /// drains that stream — in order, by construction — onto the actor-isolated buffer. A caller
    /// then drains + sends on its own short timer (`VoiceAssistantViewModel` uses 200ms) via
    /// `drainPendingBlocks()` + `VoiceAudioStreamer.streamAndSend`, keeping network calls off
    /// whatever thread the capture source calls back on.
    public func start() async throws {
        guard !isRunning else { throw AudioCaptureError.alreadyRunning }
        isRunning = true

        let (stream, localContinuation) = AsyncStream<AudioSampleBlock>.makeStream()
        self.continuation = localContinuation
        consumerTask = Task { [weak self] in
            for await block in stream {
                await self?.enqueue(block)
            }
        }

        do {
            try await source.start { block in localContinuation.yield(block) }
        } catch {
            localContinuation.finish()
            consumerTask?.cancel()
            consumerTask = nil
            continuation = nil
            isRunning = false
            throw error
        }
    }

    /// **Deliberately unconditional** — a real bug found by this stage's own test run: an earlier
    /// version guarded this on `isRunning`, but `stop()` sets `isRunning = false` BEFORE draining
    /// the stream (see `stop()`'s own doc comment on why it must finish the continuation and await
    /// the consumer, not just flip a flag), so that guard silently dropped every block still
    /// in-flight through the stream at the moment `stop()` began — reproduced concretely as
    /// `LiveVoiceAudioCaptureTests` losing 8 of 15 real blocks. Every call to this method already
    /// only happens for a block the stream legitimately yielded before `finish()`, so there is
    /// nothing left for a liveness guard to protect against.
    private func enqueue(_ block: AudioSampleBlock) {
        pendingBlocks.append(block)
    }

    /// Drains and returns every block buffered since the last call, oldest first — never blocks,
    /// may return an empty array (the same "non-blocking drain" shape
    /// `voice-audio-session.ts#pollVoiceAudioEvents` uses server-side for the mirror-image
    /// direction, events-out instead of audio-in).
    public func drainPendingBlocks() -> [AudioSampleBlock] {
        defer { pendingBlocks.removeAll() }
        return pendingBlocks
    }

    /// Stops capture and returns whatever was buffered but not yet drained, so a caller's final
    /// flush doesn't silently lose trailing audio. Finishes the internal stream and awaits the
    /// consumer task's completion (rather than cancelling it outright) so any block already
    /// yielded but not yet consumed — a real possibility right up to the moment `source.stop()`
    /// returns — is guaranteed to land in `pendingBlocks` before this method returns, not dropped.
    @discardableResult
    public func stop() async -> [AudioSampleBlock] {
        guard isRunning else { return [] }
        isRunning = false
        await source.stop()
        continuation?.finish()
        continuation = nil
        await consumerTask?.value
        consumerTask = nil
        return drainPendingBlocks()
    }
}
