import Foundation
import AthenaeumRPC

// Phase 6 native stage ("Wire transcript segments to the backend's appendTranscriptSegment RPC
// via the established AthenaeumRPC client pattern"). This is the one new file that actually
// closes the loop the Decisions stage's own README named but did not build: "synthetic audio file
// -> real capture-abstraction interface -> real on-device ASR -> real RPC call landing a real
// TranscriptSegment on a live local backend." Every piece it composes already existed
// (`AudioCaptureSource`/`AudioChunker`/`OnDeviceTranscriber` here, `WorkspaceRPCClient
// .appendTranscriptSegment` in `AthenaeumRPC`) — this file is pure composition, no new capture or
// ASR logic.
//
// **Deliberately decoupled from `WorkspaceRPCClient` by protocol (`TranscriptSegmentSink`), not a
// concrete dependency** — so this pipeline's chunking/transcription/offset-accounting logic is
// unit-testable (`MeetingTranscriptionPipelineTests`) with a fake sink and a fake transcriber,
// with no live backend and no TCC-gated `SFSpeechRecognizer` involved at all. `WorkspaceRPCClient`
// conforms for free (see the `extension` at the bottom) since its real method signature already
// matches — real production callers (`Phase6ExitCriterionCLI`) pass a real `WorkspaceRPCClient`
// straight in.

/// The minimal capability this pipeline needs from an RPC client — exactly
/// `WorkspaceRPCClient.appendTranscriptSegment`'s signature (`WorkspaceRPCClient+Meetings.swift`).
/// Abstracted as a protocol purely for testability (see this file's header comment); the real
/// implementation IS `WorkspaceRPCClient`, not a parallel client.
public protocol TranscriptSegmentSink: Sendable {
    func appendTranscriptSegment(
        meetingId: String,
        speakerId: String?,
        text: String,
        startOffsetMs: Int,
        endOffsetMs: Int,
        source: String
    ) async throws -> RPCTranscriptSegmentRecord
}

extension WorkspaceRPCClient: TranscriptSegmentSink {}

/// Real chunking + on-device-ASR + RPC-append pipeline over a batch of already-captured
/// `AudioSampleBlock`s. Takes a plain `[AudioSampleBlock]` (not a live `AudioCaptureSource`
/// directly) so both a `SyntheticAudioSource`'s `allBlocks` (the file-backed test/verification
/// path this stage's hard constraint asks for) and a real live source's buffered output (a future
/// caller collecting blocks off `ScreenCaptureKitAudioSource`/`AVAudioEngineMicrophoneSource`'s
/// `start(onBlock:)` callback) can drive the exact same downstream logic — one code path, not two.
public struct MeetingTranscriptionPipeline: Sendable {
    private let transcriber: OnDeviceTranscriber

    public init(transcriber: OnDeviceTranscriber) {
        self.transcriber = transcriber
    }

    /// Runs `blocks` through a fresh `AudioChunker`, transcribes each completed (non-silent,
    /// unless `skipSilentChunks` is false) chunk via `transcriber`, and appends one
    /// `TranscriptSegmentRecord` per non-empty transcript to `meetingId` via `sink
    /// .appendTranscriptSegment`, tagged `source: "on-device"` (this pipeline only drives
    /// `OnDeviceTranscriber` — a `CloudTranscriptionClient`-backed fallback path is backend-side,
    /// per docs/meetings-voice-decisions.md §2, not this pipeline's job). `startOffsetMs` lets a
    /// caller continue a running meeting clock across multiple `transcribeAndAppend` calls (e.g.
    /// one call per capture source) rather than always starting at 0.
    ///
    /// Returns every appended segment, in chunk order, alongside each chunk's own on-device
    /// `TranscriptionResult` (confidence included) — a caller wanting `CloudFallbackPolicy`
    /// (`OnDeviceTranscriber.swift`) applied per chunk reads `results` and re-transcribes/
    /// re-appends via a `CloudTranscriptionClient`-backed path itself; this pipeline does not
    /// silently swap sources mid-stream.
    @discardableResult
    public func transcribeAndAppend(
        blocks: [AudioSampleBlock],
        chunkerConfig: AudioChunkerConfig = AudioChunkerConfig(),
        sink: TranscriptSegmentSink,
        meetingId: String,
        startOffsetMs: Int = 0,
        skipSilentChunks: Bool = true
    ) async throws -> [(segment: RPCTranscriptSegmentRecord, result: TranscriptionResult)] {
        let chunker = AudioChunker(config: chunkerConfig)
        var chunks: [AudioChunk] = []
        for block in blocks {
            chunks.append(contentsOf: chunker.ingest(block))
        }
        if let final = chunker.flush() {
            chunks.append(final)
        }

        var appended: [(segment: RPCTranscriptSegmentRecord, result: TranscriptionResult)] = []
        var cursorMs = startOffsetMs
        for chunk in chunks {
            let durationMs = Int((Double(chunk.samples.count) / max(chunk.sampleRate, 1)) * 1000)
            let chunkStart = cursorMs
            let chunkEnd = cursorMs + durationMs
            cursorMs = chunkEnd

            if chunk.isSilent && skipSilentChunks { continue }

            let result = try await transcriber.transcribe(chunk)
            let trimmed = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }

            let segment = try await sink.appendTranscriptSegment(
                meetingId: meetingId,
                speakerId: nil,
                text: result.text,
                startOffsetMs: chunkStart,
                endOffsetMs: chunkEnd,
                source: "on-device"
            )
            appended.append((segment: segment, result: result))
        }
        return appended
    }
}
