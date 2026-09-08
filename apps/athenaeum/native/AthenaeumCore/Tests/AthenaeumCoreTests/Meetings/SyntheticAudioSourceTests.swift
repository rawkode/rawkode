import XCTest
@testable import AthenaeumCore

/// Proves `SyntheticAudioSource` genuinely decodes real audio files (not synthesizing PCM out of
/// nothing) — the foundation every other Meetings test in this directory builds on.
final class SyntheticAudioSourceTests: XCTestCase {
    private func fixtureURL(_ name: String) throws -> URL {
        guard let url = Bundle.module.url(forResource: name, withExtension: "aiff", subdirectory: "Fixtures") else {
            XCTFail("missing fixture \(name).aiff")
            throw AudioCaptureError.startFailed("missing fixture")
        }
        return url
    }

    func testDecodesARealSayGeneratedFileIntoNonSilentSamples() throws {
        let source = try SyntheticAudioSource(fileURL: try fixtureURL("samantha_1"), origin: .systemAudio)
        let all = source.allBlocks.flatMap { $0.samples }
        XCTAssertGreaterThan(all.count, 1000, "expected several seconds of real decoded audio")
        // A genuine spoken sentence is not silent — sanity check the decode actually pulled real
        // signal out of the file, not a zeroed buffer.
        XCTAssertGreaterThan(rms(all), 0.01)
    }

    func testEmitsBlocksThroughTheAudioCaptureSourceProtocol() async throws {
        let source = try SyntheticAudioSource(fileURL: try fixtureURL("samantha_1"), origin: .microphone)
        var received: [AudioSampleBlock] = []
        try await source.start { received.append($0) }
        XCTAssertFalse(received.isEmpty)
        XCTAssertTrue(received.allSatisfy { $0.origin == .microphone })
    }

    func testSilenceFixtureDecodesToLowEnergy() throws {
        let source = try SyntheticAudioSource(fileURL: try fixtureURL("silence"), origin: .systemAudio)
        let all = source.allBlocks.flatMap { $0.samples }
        XCTAssertLessThan(rms(all), 0.01, "the near-silent fixture should decode to low RMS energy")
    }
}
