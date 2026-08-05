import XCTest
@testable import EnchiridionCore

final class MeetingSpeakerClusteringTests: XCTestCase {
  func testAssignmentsAreDeterministicChannelAwareAndPreserveFrozenChoice() {
    let regions = [
      region("a", frequency: 120, at: 0), region("b", frequency: 124, at: 1),
      region("c", frequency: 220, at: 2), region("d", frequency: 224, at: 3),
    ]
    let clusterer = MeetingSpeakerClusterer()
    XCTAssertEqual(clusterer.assign(regions), clusterer.assign(regions))
    let frozen = clusterer.assign(regions, frozenAssignments: ["a": "person-alice"])
    XCTAssertEqual(frozen.first?.clusterID, "person-alice")
    XCTAssertTrue(frozen.first!.isFrozen)
  }

  func testOverlapAndInsufficientSignalFailClosedToUnknown() {
    let clusterer = MeetingSpeakerClusterer()
    let overlap = MeetingSpeechRegion(id: "overlap", channel: .microphone, startTime: 0, endTime: 1, sampleRate: 16_000, samples: Array(repeating: 0.2, count: 512), overlapsOtherSpeech: true)
    let short = MeetingSpeechRegion(id: "short", channel: .microphone, startTime: 1, endTime: 2, sampleRate: 16_000, samples: [0.2], overlapsOtherSpeech: false)
    XCTAssertEqual(clusterer.assign([overlap, short]).map(\.clusterID), ["speaker-unknown", "speaker-unknown"])
  }

  private func region(_ id: String, frequency: Double, at time: TimeInterval) -> MeetingSpeechRegion {
    let rate = 16_000.0
    let samples = (0..<4_000).map { Float(sin(2 * .pi * frequency * Double($0) / rate) * 0.25) }
    return .init(id: id, channel: .microphone, startTime: time, endTime: time + 0.25, sampleRate: rate, samples: samples)
  }
}
