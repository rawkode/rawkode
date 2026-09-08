import XCTest
@testable import AthenaeumCore

final class AudioChunkerTests: XCTestCase {
    private let sampleRate: Double = 16_000

    private func tone(seconds: Double, amplitude: Float = 0.5, frequency: Float = 220) -> [Float] {
        let count = Int(seconds * sampleRate)
        return (0..<count).map { i in amplitude * sin(2 * Float.pi * frequency * Float(i) / Float(sampleRate)) }
    }

    private func silence(seconds: Double) -> [Float] {
        [Float](repeating: 0, count: Int(seconds * sampleRate))
    }

    private func block(_ samples: [Float]) -> AudioSampleBlock {
        AudioSampleBlock(samples: samples, sampleRate: sampleRate, origin: .microphone)
    }

    func testDoesNotCutBelowMinimumDuration() {
        let chunker = AudioChunker(config: AudioChunkerConfig(minChunkDurationSeconds: 5, maxChunkDurationSeconds: 30))
        // 1s of tone then 1s of silence — well under the 5s minimum, so no cut yet even though
        // there's a clean silence boundary.
        let completed = chunker.ingest(block(tone(seconds: 1) + silence(seconds: 1)))
        XCTAssertTrue(completed.isEmpty)
    }

    func testCutsAtANaturalSilenceBoundaryOnceMinimumDurationIsReached() {
        let chunker = AudioChunker(
            config: AudioChunkerConfig(
                minChunkDurationSeconds: 2,
                maxChunkDurationSeconds: 30,
                silenceHoldDurationSeconds: 0.5,
                silenceRmsThreshold: 0.01
            )
        )
        // 3s of speech-like tone (above minChunkDuration) then 0.6s of silence (above the hold
        // duration) — should cut right after the silence run completes.
        let completed = chunker.ingest(block(tone(seconds: 3) + silence(seconds: 0.6)))
        XCTAssertEqual(completed.count, 1)
        let chunk = completed[0]
        XCTAssertEqual(chunk.samples.count, Int(3.6 * sampleRate))
        XCTAssertFalse(chunk.isSilent, "chunk contains real tone content, not pure silence")
    }

    func testForceCutsAtMaximumDurationEvenWithoutSilence() {
        let chunker = AudioChunker(config: AudioChunkerConfig(minChunkDurationSeconds: 100, maxChunkDurationSeconds: 2))
        // Continuous tone, well past maxChunkDurationSeconds, with no silence anywhere — must
        // still cut, otherwise a long uninterrupted speaker would never get transcribed
        // incrementally.
        let completed = chunker.ingest(block(tone(seconds: 2.5)))
        XCTAssertEqual(completed.count, 1)
        XCTAssertEqual(completed[0].samples.count, Int(2.5 * sampleRate))
    }

    func testFlushReturnsRemainingBufferedAudio() {
        let chunker = AudioChunker(config: AudioChunkerConfig(minChunkDurationSeconds: 100, maxChunkDurationSeconds: 100))
        let completed = chunker.ingest(block(tone(seconds: 1)))
        XCTAssertTrue(completed.isEmpty, "1s is well under both thresholds — nothing cut yet")
        let flushed = chunker.flush()
        XCTAssertNotNil(flushed)
        XCTAssertEqual(flushed?.samples.count, Int(1 * sampleRate))
        // A second flush with nothing buffered returns nil, not an empty chunk.
        XCTAssertNil(chunker.flush())
    }

    func testMarksAPureSilenceChunkAsSilent() {
        let chunker = AudioChunker(config: AudioChunkerConfig(minChunkDurationSeconds: 100, maxChunkDurationSeconds: 100))
        _ = chunker.ingest(block(silence(seconds: 1)))
        let flushed = chunker.flush()
        XCTAssertEqual(flushed?.isSilent, true)
    }

    func testRealSpeechFixtureFlushesToANonSilentChunk() async throws {
        guard let url = Bundle.module.url(forResource: "samantha_1", withExtension: "aiff", subdirectory: "Fixtures") else {
            XCTFail("missing fixture")
            return
        }
        let source = try SyntheticAudioSource(fileURL: url, origin: .systemAudio, chunkSize: 2048)
        let chunker = AudioChunker(config: AudioChunkerConfig(minChunkDurationSeconds: 100, maxChunkDurationSeconds: 100))
        try await source.start { sampleBlock in
            let completed = chunker.ingest(sampleBlock)
            XCTAssertTrue(completed.isEmpty, "a single ~2.7s clip stays under min/max thresholds")
        }
        let flushed = chunker.flush()
        XCTAssertNotNil(flushed)
        XCTAssertFalse(flushed!.isSilent)
        XCTAssertGreaterThan(flushed!.samples.count, 1000)
    }
}
