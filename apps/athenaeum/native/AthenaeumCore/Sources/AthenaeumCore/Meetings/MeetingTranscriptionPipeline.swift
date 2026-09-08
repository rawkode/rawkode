import Foundation
import AthenaeumDomain
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
public struct TranscriptSegmentAppendIntent: Sendable, Equatable {
    public let requestId: String
    public let meetingId: String
    public let speakerId: String?
    public let text: String
    public let startOffsetMs: Int
    public let endOffsetMs: Int
    public let source: String
    public let commitMessage: String
    public let attribution: MutationAttribution

    public init(
        requestId: String,
        meetingId: String,
        speakerId: String?,
        text: String,
        startOffsetMs: Int,
        endOffsetMs: Int,
        source: String,
        commitMessage: String,
        attribution: MutationAttribution
    ) {
        self.requestId = requestId
        self.meetingId = meetingId
        self.speakerId = speakerId
        self.text = text
        self.startOffsetMs = startOffsetMs
        self.endOffsetMs = endOffsetMs
        self.source = source
        self.commitMessage = commitMessage
        self.attribution = attribution
    }
}

/// Returned after bounded retries are exhausted. The immutable intent is retained so an outer
/// caller can persist/replay it later with the same request identity instead of re-minting a
/// segment and risking a duplicate after an uncertain transport failure.
public struct TranscriptSegmentAppendFailure: Error, Sendable, Equatable, CustomStringConvertible {
    public let intent: TranscriptSegmentAppendIntent
    public let attempts: Int
    public let underlyingDescription: String

    public var description: String {
        "appendTranscriptSegment failed after \(attempts) attempt(s) for request \(intent.requestId): \(underlyingDescription)"
    }
}

public enum MeetingTranscriptionPipelineError: Error, Sendable, Equatable, CustomStringConvertible {
    case invalidCaptureId
    case invalidRetryPolicy

    public var description: String {
        switch self {
        case .invalidCaptureId: return "captureId must contain 1...128 ASCII characters"
        case .invalidRetryPolicy: return "maxAppendAttempts must be between 1 and 5"
        }
    }
}

public protocol TranscriptSegmentSink: Sendable {
    func appendTranscriptSegment(
        intent: TranscriptSegmentAppendIntent
    ) async throws -> RPCTranscriptSegmentRecord
}

extension WorkspaceRPCClient: TranscriptSegmentSink {
    public func appendTranscriptSegment(
        intent: TranscriptSegmentAppendIntent
    ) async throws -> RPCTranscriptSegmentRecord {
        try await appendTranscriptSegment(
            meetingId: intent.meetingId,
            speakerId: intent.speakerId,
            text: intent.text,
            startOffsetMs: intent.startOffsetMs,
            endOffsetMs: intent.endOffsetMs,
            source: intent.source,
            requestId: intent.requestId,
            commitMessage: intent.commitMessage,
            attribution: intent.attribution
        )
    }
}

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

    private func appendWithRetry(
        _ intent: TranscriptSegmentAppendIntent,
        sink: TranscriptSegmentSink,
        maxAttempts: Int
    ) async throws -> RPCTranscriptSegmentRecord {
        func attempt(_ remaining: Int, attemptNumber: Int) async throws -> RPCTranscriptSegmentRecord {
            do {
                return try await sink.appendTranscriptSegment(intent: intent)
            } catch {
                if remaining == 1 {
                    throw TranscriptSegmentAppendFailure(
                        intent: intent,
                        attempts: attemptNumber,
                        underlyingDescription: String(describing: error)
                    )
                }
                return try await attempt(remaining - 1, attemptNumber: attemptNumber + 1)
            }
        }
        return try await attempt(maxAttempts, attemptNumber: 1)
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
        skipSilentChunks: Bool = true,
        /** Stable identity for this audio/configuration run. Reusing it with changed input is
         * intentionally a ledger conflict, not a new append. */
        captureId: String = UUID().uuidString,
        commitMessage: String = "Capture transcript segment from on-device transcription.",
        attribution: MutationAttribution = MutationAttribution(kind: "humanUi", surface: "macos"),
        maxAppendAttempts: Int = 2
    ) async throws -> [(segment: RPCTranscriptSegmentRecord, result: TranscriptionResult)] {
        // The backend bounds MutationRequestId as a JavaScript string. Restricting this caller-
        // owned component to printable ASCII keeps Swift grapheme counts from underestimating
        // encoded request length (for example, emoji-heavy ids) and leaves room for the prefix and
        // chunk index in the 200-character server contract.
        guard (1...128).contains(captureId.utf8.count),
              captureId.unicodeScalars.allSatisfy({ scalar in
                  (48...57).contains(scalar.value) || (65...90).contains(scalar.value) ||
                  (97...122).contains(scalar.value) || scalar.value == 45 || scalar.value == 46 || scalar.value == 95
              }) else {
            throw MeetingTranscriptionPipelineError.invalidCaptureId
        }
        guard (1...5).contains(maxAppendAttempts) else {
            throw MeetingTranscriptionPipelineError.invalidRetryPolicy
        }
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
        for (chunkIndex, chunk) in chunks.enumerated() {
            let durationMs = Int((Double(chunk.samples.count) / max(chunk.sampleRate, 1)) * 1000)
            let chunkStart = cursorMs
            let chunkEnd = cursorMs + durationMs
            cursorMs = chunkEnd

            if chunk.isSilent && skipSilentChunks { continue }

            let result = try await transcriber.transcribe(chunk)
            let trimmed = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }

            // The intent is immutable for this semantic chunk. Retries reuse every field,
            // especially requestId; later chunks are not transcribed/appended until this one is
            // resolved, so an applied-but-lost response cannot be overtaken by another append.
            let requestId = "transcript-segment:\(captureId):\(chunkIndex)"
            guard requestId.utf8.count <= 200 else {
                throw MeetingTranscriptionPipelineError.invalidCaptureId
            }
            let intent = TranscriptSegmentAppendIntent(
                requestId: requestId,
                meetingId: meetingId,
                speakerId: nil,
                text: result.text,
                startOffsetMs: chunkStart,
                endOffsetMs: chunkEnd,
                source: "on-device",
                commitMessage: commitMessage,
                attribution: attribution
            )
            let segment = try await appendWithRetry(intent, sink: sink, maxAttempts: maxAppendAttempts)
            appended.append((segment: segment, result: result))
        }
        return appended
    }
}
