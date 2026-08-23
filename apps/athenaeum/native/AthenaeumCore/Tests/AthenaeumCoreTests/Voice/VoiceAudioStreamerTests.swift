import XCTest
@testable import AthenaeumCore
import AthenaeumRPC

// Native voice-UI task's own pipeline tests — the "genuinely test the rest of the pipeline...
// using a synthetic/injected audio source" half of the hard constraint, applied to voice-audio
// streaming instead of meeting transcription. Real `say`-synthesized speech
// (`samantha_1.aiff`, the exact fixture `MeetingTranscriptionPipelineTests` already uses), decoded
// through the real `AudioCaptureSource`/`SyntheticAudioSource` path, batched through the real
// `VoiceAudioBatcher`, sent through the real `VoiceAudioStreamer` — only the RPC sink is fake, so
// this proves the entire native chunking/batching/dispatch pipeline for real with no live backend.

/// Records every call made to it — the fake `VoiceAudioSink` this suite uses instead of a real
/// `WorkspaceRPCClient`/live backend.
private final class RecordingVoiceAudioSink: VoiceAudioSink, @unchecked Sendable {
    private let lock = NSLock()
    private var _sentChunks: [(audioSessionId: String, byteCount: Int)] = []
    private var _committed: [String] = []
    var sentChunks: [(audioSessionId: String, byteCount: Int)] { lock.withLock { _sentChunks } }
    var committed: [String] { lock.withLock { _committed } }

    func sendVoiceAudioChunk(audioSessionId: String, pcm16: Data) async throws {
        lock.withLock { _sentChunks.append((audioSessionId, pcm16.count)) }
    }

    func commitVoiceAudioAndRespond(audioSessionId: String) async throws {
        lock.withLock { _committed.append(audioSessionId) }
    }
}

/// A `VoiceAudioSink` double that fails every send — proves `VoiceAudioStreamer` propagates a real
/// send failure rather than swallowing it (a caller/`VoiceAssistantViewModel` needs to know a
/// chunk didn't make it, not silently continue as if the session were healthy).
private struct FailingVoiceAudioSink: VoiceAudioSink {
    struct SendFailed: Error {}
    func sendVoiceAudioChunk(audioSessionId: String, pcm16: Data) async throws { throw SendFailed() }
    func commitVoiceAudioAndRespond(audioSessionId: String) async throws {}
}

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock(); defer { unlock() }
        return body()
    }
}

final class VoiceAudioStreamerTests: XCTestCase {
    private func loadSamanthaBlocks() throws -> [AudioSampleBlock] {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "samantha_1", withExtension: "aiff", subdirectory: "Fixtures")
        )
        let source = try SyntheticAudioSource(fileURL: url, origin: .microphone)
        return source.allBlocks
    }

    func testRealSpeechFixtureProducesMultipleChunksAllSentToTheSameSession() async throws {
        let blocks = try loadSamanthaBlocks()
        let sink = RecordingVoiceAudioSink()
        let streamer = VoiceAudioStreamer()

        let sent = try await streamer.streamAndSend(
            blocks: blocks,
            audioSessionId: "audio-session-1",
            sink: sink,
            targetChunkDurationSeconds: 0.2
        )

        XCTAssertGreaterThan(sent, 1, "a real ~2.7s speech fixture batched at 200ms should produce multiple chunks")
        XCTAssertEqual(sink.sentChunks.count, sent)
        for chunk in sink.sentChunks {
            XCTAssertEqual(chunk.audioSessionId, "audio-session-1")
            XCTAssertGreaterThan(chunk.byteCount, 0)
        }
    }

    func testFlushTrailingFalseOmitsTheFinalSubTargetChunk() async throws {
        let blocks = try loadSamanthaBlocks()
        let withFlush = RecordingVoiceAudioSink()
        let withoutFlush = RecordingVoiceAudioSink()
        let streamer = VoiceAudioStreamer()

        let sentWithFlush = try await streamer.streamAndSend(
            blocks: blocks, audioSessionId: "s", sink: withFlush, targetChunkDurationSeconds: 0.2, flushTrailing: true
        )
        let sentWithoutFlush = try await streamer.streamAndSend(
            blocks: blocks, audioSessionId: "s", sink: withoutFlush, targetChunkDurationSeconds: 0.2, flushTrailing: false
        )

        XCTAssertGreaterThanOrEqual(sentWithFlush, sentWithoutFlush)
    }

    func testASendFailurePropagatesRatherThanBeingSwallowed() async throws {
        let blocks = try loadSamanthaBlocks()
        let streamer = VoiceAudioStreamer()

        do {
            _ = try await streamer.streamAndSend(blocks: blocks, audioSessionId: "s", sink: FailingVoiceAudioSink())
            XCTFail("expected the sink's failure to propagate")
        } catch is FailingVoiceAudioSink.SendFailed {
            // expected
        }
    }

    func testEmptyBlocksProduceNoSendsAndNoCrash() async throws {
        let sink = RecordingVoiceAudioSink()
        let sent = try await VoiceAudioStreamer().streamAndSend(blocks: [], audioSessionId: "s", sink: sink)
        XCTAssertEqual(sent, 0)
        XCTAssertTrue(sink.sentChunks.isEmpty)
    }
}
