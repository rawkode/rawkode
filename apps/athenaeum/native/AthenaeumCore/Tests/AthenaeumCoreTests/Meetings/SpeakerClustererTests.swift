import XCTest
@testable import AthenaeumCore

/// Proves `SpeakerClusterer` genuinely distinguishes different speakers, against REAL synthesized
/// speech — five fixtures produced this stage via macOS's `say` command, not synthetic tones or a
/// stubbed answer (hard constraint: "confirm it actually distinguishes them"):
///   - `samantha_1.aiff` = `say -v Samantha -o samantha_1.aiff "the quick brown fox jumps over the lazy dog"`
///   - `samantha_2.aiff` = `say -v Samantha -o samantha_2.aiff "please schedule the follow up for next tuesday afternoon"`
///   - `alex_1.aiff`     = `say -v Alex -o alex_1.aiff "hello world, this is a test of speaker clustering"`
///   - `alex_2.aiff`     = `say -v Alex -o alex_2.aiff "let's push the deadline back by one full week"`
///   - `silence.aiff`    = `say -v Samantha -o silence.aiff "   "` (near-silent control fixture)
/// `Samantha` (US English female) and `Alex` (US English male) are macOS's two most acoustically
/// distinct built-in voices — genuinely different pitch ranges, not hand-picked to be
/// artificially easy beyond "pick two voices that actually sound like different people," which is
/// exactly the real-world case this spike's algorithm needs to handle. Measured F0 values from
/// this stage's own test run are recorded in docs/meetings-voice-decisions.md §1.
final class SpeakerClustererTests: XCTestCase {
    private func chunk(_ fixtureName: String, origin: AudioSampleOrigin = .systemAudio) throws -> AudioChunk {
        guard let url = Bundle.module.url(forResource: fixtureName, withExtension: "aiff", subdirectory: "Fixtures") else {
            XCTFail("missing fixture \(fixtureName).aiff")
            throw AudioCaptureError.startFailed("missing fixture")
        }
        let source = try SyntheticAudioSource(fileURL: url, origin: origin)
        let chunker = AudioChunker(config: AudioChunkerConfig(minChunkDurationSeconds: 100, maxChunkDurationSeconds: 100))
        for block in source.allBlocks { _ = chunker.ingest(block) }
        guard let flushed = chunker.flush() else {
            XCTFail("fixture \(fixtureName) produced no audio")
            throw AudioCaptureError.startFailed("empty fixture")
        }
        return flushed
    }

    func testExtractsAPlausibleVoicedF0FromRealSpeech() throws {
        let samantha = try chunk("samantha_1")
        let alex = try chunk("alex_1")
        let samanthaFeature = SpeakerClusterer.extractFeature(samantha)
        let alexFeature = SpeakerClusterer.extractFeature(alex)

        let samanthaF0 = try XCTUnwrap(samanthaFeature.medianVoicedF0Hz, "Samantha clip should have voiced frames")
        let alexF0 = try XCTUnwrap(alexFeature.medianVoicedF0Hz, "Alex clip should have voiced frames")

        // Sanity range for human speech F0 (typical adult range ~75-400Hz, this algorithm's own
        // configured search band) — not asserting exact values (that would be over-fitting to one
        // TTS engine's output), just that real, plausible pitch values came out.
        XCTAssertTrue((75...400).contains(samanthaF0), "Samantha F0 \(samanthaF0) out of plausible human range")
        XCTAssertTrue((75...400).contains(alexF0), "Alex F0 \(alexF0) out of plausible human range")
    }

    func testTwoDifferentVoicesClusterIntoTwoDifferentGroups() throws {
        let chunks = [try chunk("samantha_1"), try chunk("samantha_2"), try chunk("alex_1"), try chunk("alex_2")]
        let labels = SpeakerClusterer.cluster(chunks, expectedSpeakerCount: 2)

        XCTAssertEqual(labels.count, 4)
        XCTAssertTrue(labels.allSatisfy { $0 == 0 || $0 == 1 }, "expected only cluster 0/1, got \(labels)")

        // The real assertion: same-voice clips land in the SAME cluster, different-voice clips
        // land in DIFFERENT clusters. Indices: 0,1 = Samantha; 2,3 = Alex.
        XCTAssertEqual(labels[0], labels[1], "both Samantha clips should cluster together")
        XCTAssertEqual(labels[2], labels[3], "both Alex clips should cluster together")
        XCTAssertNotEqual(labels[0], labels[2], "Samantha and Alex should NOT cluster together")
    }

    func testUnvoicedSilenceChunkGetsNoSpeakerLabel() throws {
        let chunks = [try chunk("samantha_1"), try chunk("alex_1"), try chunk("silence")]
        let labels = SpeakerClusterer.cluster(chunks, expectedSpeakerCount: 2)
        XCTAssertEqual(labels.count, 3)
        XCTAssertEqual(labels[2], -1, "a silent chunk has no voiced frames to assign a speaker from")
    }

    func testEmptyInputReturnsEmptyOutput() {
        XCTAssertEqual(SpeakerClusterer.cluster([], expectedSpeakerCount: 2), [])
    }

    func testFewerVoicedSegmentsThanExpectedSpeakersDoesNotFabricateClusters() throws {
        // Only one real voiced segment, but asking for 2 speakers — must not invent a second
        // cluster from nothing.
        let chunks = [try chunk("samantha_1")]
        let labels = SpeakerClusterer.cluster(chunks, expectedSpeakerCount: 2)
        XCTAssertEqual(labels, [0])
    }
}
