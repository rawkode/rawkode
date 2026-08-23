import XCTest
@testable import AthenaeumCore

// `LiveVoiceAudioCapture`'s own buffering/draining logic, tested against the real
// `AudioCaptureSource` protocol via `SyntheticAudioSource` — genuinely exercises the
// `start(onBlock:)` -> actor-hop -> buffer -> drain path this stage's live-mic glue uses, with no
// TCC/hardware involved. What remains genuinely untestable here is exactly what
// `AVAudioEngineMicrophoneSource`'s own header comment already states: live hardware capture needs
// a human present for the one-time Microphone TCC prompt.
//
// `SyntheticAudioSource.start(onBlock:)` invokes its closure synchronously in a loop, but the
// consumer that moves blocks onto the actor's buffer runs on its own `Task` (real capture sources
// call back from arbitrary threads, so this can't assume synchronous delivery into the actor) —
// so `testStartBuffersEveryBlockTheSourceProducesAndDrainClearsIt` polls with a bounded retry loop
// rather than asserting immediately after `start()` returns, the same discipline this stage's
// backend polling tests already use for the mirror-image (server-side) non-blocking-drain shape.
// An earlier version of `LiveVoiceAudioCapture.start()` spawned one unstructured `Task` per block,
// which this suite caught reordering blocks under concurrent scheduling (two `Task`s created in
// quick succession are not guaranteed to reach the actor in creation order) — fixed by routing
// blocks through a single-consumer `AsyncStream` instead (see that method's own doc comment).
final class LiveVoiceAudioCaptureTests: XCTestCase {
    private func loadSamanthaBlocks() throws -> [AudioSampleBlock] {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "samantha_1", withExtension: "aiff", subdirectory: "Fixtures")
        )
        return try SyntheticAudioSource(fileURL: url, origin: .microphone).allBlocks
    }

    func testStartBuffersEveryBlockTheSourceProducesAndDrainClearsIt() async throws {
        let expectedBlocks = try loadSamanthaBlocks()
        let source = try SyntheticAudioSource(fileURL: XCTUnwrap(
            Bundle.module.url(forResource: "samantha_1", withExtension: "aiff", subdirectory: "Fixtures")
        ), origin: .microphone)
        let capture = LiveVoiceAudioCapture(source: source)

        try await capture.start()

        var drained: [AudioSampleBlock] = []
        for _ in 0..<200 where drained.count < expectedBlocks.count {
            drained.append(contentsOf: await capture.drainPendingBlocks())
            if drained.count < expectedBlocks.count {
                try await Task.sleep(nanoseconds: 5_000_000)
            }
        }

        XCTAssertEqual(drained.count, expectedBlocks.count)
        XCTAssertEqual(drained.map(\.samples.count), expectedBlocks.map(\.samples.count))

        // Draining again immediately returns nothing new.
        let secondDrain = await capture.drainPendingBlocks()
        XCTAssertTrue(secondDrain.isEmpty)

        _ = await capture.stop()
    }

    func testStopReturnsAnyBlocksBufferedSinceTheLastDrain() async throws {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "samantha_1", withExtension: "aiff", subdirectory: "Fixtures")
        )
        let source = try SyntheticAudioSource(fileURL: url, origin: .microphone)
        let expectedBlockCount = source.allBlocks.count
        let capture = LiveVoiceAudioCapture(source: source)

        try await capture.start()
        // `stop()` itself guarantees every block yielded before `source.stop()` returns has been
        // consumed onto the buffer (its own doc comment) — no manual wait-for-quiescence needed,
        // unlike `drainPendingBlocks()` polled mid-capture in the previous test.
        let stopped = await capture.stop()
        XCTAssertEqual(stopped.count, expectedBlockCount)
    }

    func testStartingTwiceThrowsAlreadyRunning() async throws {
        let blocks = try loadSamanthaBlocks()
        XCTAssertFalse(blocks.isEmpty)
        let source = try SyntheticAudioSource(fileURL: XCTUnwrap(
            Bundle.module.url(forResource: "samantha_1", withExtension: "aiff", subdirectory: "Fixtures")
        ), origin: .microphone)
        let capture = LiveVoiceAudioCapture(source: source)

        try await capture.start()
        do {
            try await capture.start()
            XCTFail("expected AudioCaptureError.alreadyRunning")
        } catch AudioCaptureError.alreadyRunning {
            // expected
        }
        _ = await capture.stop()
    }
}
