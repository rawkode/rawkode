import XCTest
@testable import EnchiridionCore

final class MeetingPCMFrameMixerTests: XCTestCase {
  private let configuration = MeetingPCMFrameMixer.Configuration(
    outputSampleRate: 10, skewTolerance: 0.04, maximumLatency: 0.05, maximumPendingBlocks: 2
  )

  func testAlignedSourcesProduceOneAveragedMonoTimeline() {
    var mixer = MeetingPCMFrameMixer(configuration: configuration)
    XCTAssertTrue(mixer.ingest(frame(.microphone, at: 0, samples: [1, 1])).isEmpty)
    let output = mixer.ingest(frame(.systemAudio, at: 0, samples: [-0.5, 0.5]))
    XCTAssertEqual(output.count, 1)
    XCTAssertEqual(output[0].channel, .mixed)
    XCTAssertEqual(output[0].samples, [0.25, 0.75])
  }

  func testSkewWithinToleranceAlignsUsingPresentationTime() {
    var mixer = MeetingPCMFrameMixer(configuration: configuration)
    _ = mixer.ingest(frame(.microphone, at: 1.02, samples: [1, 1]))
    let output = mixer.ingest(frame(.systemAudio, at: 1, samples: [1, 1]))
    XCTAssertEqual(output.count, 1)
    XCTAssertEqual(output[0].timestamp, 1, accuracy: 0.000_1)
    XCTAssertEqual(output[0].channelCount, 1)
  }

  func testMissingSourceFlushesWithSilenceAndPreservesAmplitude() {
    var mixer = MeetingPCMFrameMixer(configuration: configuration)
    _ = mixer.ingest(frame(.microphone, at: 0, samples: [0.75]))
    let output = mixer.ingest(frame(.microphone, at: 0.2, samples: [0.5]))
    XCTAssertEqual(output.first?.samples, [0.75])
    XCTAssertEqual(mixer.finish().first?.samples, [0.5])
  }

  func testLateBlocksCannotMoveTimelineBackwards() {
    var mixer = MeetingPCMFrameMixer(configuration: configuration)
    _ = mixer.ingest(frame(.microphone, at: 1, samples: [1]))
    let first = mixer.ingest(frame(.systemAudio, at: 1, samples: [1]))
    XCTAssertEqual(first.first?.timestamp, 1)
    XCTAssertTrue(mixer.ingest(frame(.microphone, at: 0, samples: [1])).isEmpty)
    XCTAssertTrue(mixer.ingest(frame(.systemAudio, at: 0, samples: [1])).isEmpty)
  }

  func testGenerationChangeDropsUnmatchedPriorGeneration() {
    var mixer = MeetingPCMFrameMixer(configuration: configuration)
    _ = mixer.ingest(frame(.microphone, at: 0, generation: 1, samples: [1]))
    _ = mixer.ingest(frame(.systemAudio, at: 0, generation: 2, samples: [0.25]))
    let output = mixer.finish()
    XCTAssertEqual(output.count, 1)
    XCTAssertEqual(output[0].generation, 2)
    XCTAssertEqual(output[0].samples, [0.25])
  }

  func testPendingStorageRemainsBounded() {
    var mixer = MeetingPCMFrameMixer(configuration: configuration)
    for index in 0..<20 { _ = mixer.ingest(frame(.microphone, at: Double(index) * 0.01, samples: [0.1])) }
    XCTAssertLessThanOrEqual(mixer.pendingBlockCount, configuration.maximumPendingBlocks)
  }

  private func frame(
    _ channel: MeetingAudioChannel,
    at timestamp: TimeInterval,
    generation: UInt64 = 1,
    samples: [Float]
  ) -> MeetingPCMFrame {
    .init(generation: generation, channel: channel, timestamp: timestamp, sampleRate: 10, channelCount: 1, samples: samples)
  }
}
