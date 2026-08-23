import XCTest
@testable import AthenaeumCore
import AthenaeumRPC

// Phase 6 native stage ("Wire transcript segments to the backend's appendTranscriptSegment RPC
// via the established AthenaeumRPC client pattern"). Proves `MeetingTranscriptionPipeline`'s own
// composition logic (chunk -> transcribe -> append, offset accounting, silent/empty-transcript
// skipping) for real, with NO live backend and NO TCC-gated `SFSpeechRecognizer` involved —
// exactly the "mechanical wiring, independently testable" split
// `MeetingTranscriptionPipeline.swift`'s own header comment describes. The genuinely-live,
// real-`SFSpeechRecognizer`, real-backend end-to-end proof lives in `Phase6ExitCriterionCLI`
// (external-orchestrator-driven, per this repo's `phase2..5-driver` precedent), not here — see
// this stage's report for exactly what that CLI proved live vs. couldn't.

/// A deterministic fake `OnDeviceTranscriber` — returns a fixed transcript for every non-silent
/// chunk it's asked to transcribe, tracking call order for assertions.
private final class FakeTranscriber: OnDeviceTranscriber, @unchecked Sendable {
    private let lock = NSLock()
    private var _callCount = 0
    var callCount: Int { lock.withLock { _callCount } }

    func transcribe(_ chunk: AudioChunk) async throws -> TranscriptionResult {
        lock.withLock { _callCount += 1 }
        return TranscriptionResult(text: "chunk \(chunk.samples.count) samples", confidence: 0.9)
    }
}

/// A fake `OnDeviceTranscriber` that always returns an empty transcript — proves the pipeline
/// skips appending a segment for a chunk with nothing worth transcribing.
private final class EmptyTranscriber: OnDeviceTranscriber, @unchecked Sendable {
    func transcribe(_ chunk: AudioChunk) async throws -> TranscriptionResult {
        TranscriptionResult(text: "   ", confidence: 0.9)
    }
}

/// Records every call made to it — the fake `TranscriptSegmentSink`
/// (`MeetingTranscriptionPipeline.swift`) this test suite uses instead of a real `WorkspaceRPCClient`/
/// live backend.
private final class RecordingSink: TranscriptSegmentSink, @unchecked Sendable {
    struct Call: Equatable {
        let meetingId: String
        let speakerId: String?
        let text: String
        let startOffsetMs: Int
        let endOffsetMs: Int
        let source: String
    }

    private let lock = NSLock()
    private var _calls: [Call] = []
    var calls: [Call] { lock.withLock { _calls } }

    func appendTranscriptSegment(
        meetingId: String,
        speakerId: String?,
        text: String,
        startOffsetMs: Int,
        endOffsetMs: Int,
        source: String
    ) async throws -> RPCTranscriptSegmentRecord {
        let call = Call(
            meetingId: meetingId, speakerId: speakerId, text: text,
            startOffsetMs: startOffsetMs, endOffsetMs: endOffsetMs, source: source
        )
        lock.withLock { _calls.append(call) }
        return RPCTranscriptSegmentRecord(
            id: "seg-\(lock.withLock { _calls.count })",
            meetingId: meetingId,
            speakerId: speakerId,
            text: text,
            startOffsetMs: startOffsetMs,
            endOffsetMs: endOffsetMs,
            source: source
        )
    }
}

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock(); defer { unlock() }
        return body()
    }
}

final class MeetingTranscriptionPipelineTests: XCTestCase {
    /// A real `say`-synthesized speech fixture (see `SpeakerClustererTests`'s identical fixture
    /// usage), decoded via the real `SyntheticAudioSource(fileURL:)` path — the same "real capture
    /// abstraction, real file decode, no fabricated PCM" discipline every Meetings test in this
    /// package uses. Forces a small `maxChunkDurationSeconds` so a short clip still produces more
    /// than one chunk, exercising the offset-accumulation logic for real.
    private func loadSamanthaBlocks() throws -> [AudioSampleBlock] {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "samantha_1", withExtension: "aiff", subdirectory: "Fixtures")
        )
        let source = try SyntheticAudioSource(fileURL: url, origin: .microphone)
        return source.allBlocks
    }

    func testTranscribeAndAppendCallsSinkOncePerChunkWithAccumulatingOffsets() async throws {
        let blocks = try loadSamanthaBlocks()
        let transcriber = FakeTranscriber()
        let sink = RecordingSink()
        let pipeline = MeetingTranscriptionPipeline(transcriber: transcriber)

        let appended = try await pipeline.transcribeAndAppend(
            blocks: blocks,
            chunkerConfig: AudioChunkerConfig(minChunkDurationSeconds: 0.5, maxChunkDurationSeconds: 1),
            sink: sink,
            meetingId: "meeting-1",
            skipSilentChunks: false
        )

        XCTAssertFalse(appended.isEmpty, "a real ~2.7s speech fixture chunked at 1s max should produce multiple chunks")
        XCTAssertEqual(sink.calls.count, appended.count)
        XCTAssertEqual(transcriber.callCount, appended.count)

        // Every call targets the right meeting, is tagged on-device, and offsets are
        // monotonically non-decreasing with endOffsetMs > startOffsetMs.
        for call in sink.calls {
            XCTAssertEqual(call.meetingId, "meeting-1")
            XCTAssertEqual(call.source, "on-device")
            XCTAssertNil(call.speakerId)
            XCTAssertGreaterThan(call.endOffsetMs, call.startOffsetMs)
        }
        for i in 1..<sink.calls.count {
            XCTAssertGreaterThanOrEqual(sink.calls[i].startOffsetMs, sink.calls[i - 1].endOffsetMs)
        }
    }

    func testStartOffsetMsIsRespectedAsTheInitialCursor() async throws {
        let blocks = try loadSamanthaBlocks()
        let transcriber = FakeTranscriber()
        let sink = RecordingSink()
        let pipeline = MeetingTranscriptionPipeline(transcriber: transcriber)

        _ = try await pipeline.transcribeAndAppend(
            blocks: blocks,
            chunkerConfig: AudioChunkerConfig(minChunkDurationSeconds: 5, maxChunkDurationSeconds: 30),
            sink: sink,
            meetingId: "meeting-1",
            startOffsetMs: 60_000,
            skipSilentChunks: false
        )

        XCTAssertEqual(sink.calls.count, 1)
        XCTAssertEqual(sink.calls[0].startOffsetMs, 60_000)
    }

    func testEmptyTranscriptsAreNotAppended() async throws {
        let blocks = try loadSamanthaBlocks()
        let sink = RecordingSink()
        let pipeline = MeetingTranscriptionPipeline(transcriber: EmptyTranscriber())

        let appended = try await pipeline.transcribeAndAppend(
            blocks: blocks,
            sink: sink,
            meetingId: "meeting-1",
            skipSilentChunks: false
        )

        XCTAssertTrue(appended.isEmpty)
        XCTAssertTrue(sink.calls.isEmpty)
    }

    func testSilentFixtureProducesNoAppendedSegmentsWhenSkipSilentChunksIsTrue() async throws {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "silence", withExtension: "aiff", subdirectory: "Fixtures")
        )
        let source = try SyntheticAudioSource(fileURL: url, origin: .microphone)
        let sink = RecordingSink()
        let pipeline = MeetingTranscriptionPipeline(transcriber: FakeTranscriber())

        let appended = try await pipeline.transcribeAndAppend(
            blocks: source.allBlocks,
            chunkerConfig: AudioChunkerConfig(minChunkDurationSeconds: 0.5, maxChunkDurationSeconds: 1),
            sink: sink,
            meetingId: "meeting-1",
            skipSilentChunks: true
        )

        XCTAssertTrue(appended.isEmpty, "a near-silent fixture should never reach the transcriber/sink when skipSilentChunks is true")
    }
}
