import XCTest
@testable import AthenaeumCore

/// Pure, deterministic tests for `VoiceAudioBatcher` — synthetic sample arrays, no capture source
/// or RPC involved, exact frame-count/byte-count assertions.
final class VoiceAudioBatcherTests: XCTestCase {
    func testNoChunkEmittedBeforeTargetDurationIsReached() {
        let batcher = VoiceAudioBatcher(targetChunkDurationSeconds: 0.1) // 1600 frames @ 16kHz
        let block = AudioSampleBlock(samples: Array(repeating: Float(0.1), count: 800), sampleRate: 16_000, origin: .microphone)
        XCTAssertEqual(batcher.ingest(block), [])
    }

    func testChunkEmittedExactlyAtTargetDuration() {
        let batcher = VoiceAudioBatcher(targetChunkDurationSeconds: 0.1) // 1600 frames @ 16kHz
        let block = AudioSampleBlock(samples: Array(repeating: Float(0.1), count: 1_600), sampleRate: 16_000, origin: .microphone)
        let chunks = batcher.ingest(block)
        XCTAssertEqual(chunks.count, 1)
        XCTAssertEqual(chunks[0].count, 1_600 * 2, "PCM16 = 2 bytes/frame")
    }

    func testMultipleChunksEmittedFromOneLargeBlock() {
        let batcher = VoiceAudioBatcher(targetChunkDurationSeconds: 0.1) // 1600 frames @ 16kHz
        let block = AudioSampleBlock(samples: Array(repeating: Float(0.1), count: 5_000), sampleRate: 16_000, origin: .microphone)
        let chunks = batcher.ingest(block)
        XCTAssertEqual(chunks.count, 3, "5000 / 1600 = 3 whole chunks, 200 frames left buffered")
        for chunk in chunks { XCTAssertEqual(chunk.count, 1_600 * 2) }
    }

    func testChunksAccumulateAcrossMultipleSmallBlocks() {
        let batcher = VoiceAudioBatcher(targetChunkDurationSeconds: 0.1) // 1600 frames @ 16kHz
        let smallBlock = AudioSampleBlock(samples: Array(repeating: Float(0.1), count: 600), sampleRate: 16_000, origin: .microphone)
        XCTAssertEqual(batcher.ingest(smallBlock), [], "600 frames buffered, below target")
        XCTAssertEqual(batcher.ingest(smallBlock), [], "1200 frames buffered, still below target")
        let chunks = batcher.ingest(smallBlock)
        XCTAssertEqual(chunks.count, 1, "1800 frames crosses the 1600-frame target — one chunk, 200 frames left buffered")
    }

    func testFlushReturnsNilWhenBufferIsEmpty() {
        let batcher = VoiceAudioBatcher(targetChunkDurationSeconds: 0.1)
        XCTAssertNil(batcher.flush())
    }

    func testFlushReturnsRemainingSubTargetAudio() {
        let batcher = VoiceAudioBatcher(targetChunkDurationSeconds: 0.1) // 1600 frames @ 16kHz
        let block = AudioSampleBlock(samples: Array(repeating: Float(0.1), count: 400), sampleRate: 16_000, origin: .microphone)
        XCTAssertEqual(batcher.ingest(block), [])
        let flushed = try? XCTUnwrap(batcher.flush())
        XCTAssertEqual(flushed?.count, 400 * 2)
        XCTAssertNil(batcher.flush(), "a second flush with nothing buffered returns nil")
    }
}
