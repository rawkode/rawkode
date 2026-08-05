import XCTest

@testable import EnchiridionCore

final class MeetingTranscriptPersistenceTests: XCTestCase {
  func testRoundTripAndDeterministicResourceKey() throws {
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000001")!)
    let base = try PageDocument.create(id: pageID, kind: .free, title: "Meeting", createdAt: .distantPast)
    let resource = transcript(pageID, segments: [segment("a", 0, 2)])
    let saved = try PageDocument.upsertMeetingTranscript(resource, in: base.document)
    XCTAssertEqual(try PageDocument.meetingTranscript(resourceKey: resource.id, in: saved.document), resource)
    XCTAssertEqual(resource.id, MeetingTranscriptResource.resourceKey(for: pageID))
  }

  func testDuplicateUpsertIsIdempotentAndManualAssignmentWins() throws {
    let pageID = PageID.free()
    let base = try PageDocument.create(id: pageID, kind: .free, title: "Meeting", createdAt: .distantPast)
    var first = transcript(pageID, segments: [segment("a", 0, 2)])
    first.segments[0].speakerPageID = PageID.free()
    let once = try PageDocument.upsertMeetingTranscript(first, in: base.document)
    var conflicting = transcript(pageID, segments: [segment("a", 0, 2)])
    conflicting.segments[0].speakerPageID = PageID.free()
    let twice = try PageDocument.upsertMeetingTranscript(conflicting, in: once.document)
    XCTAssertEqual(try PageDocument.meetingTranscript(resourceKey: first.id, in: twice.document)?.segments[0].speakerPageID, conflicting.segments[0].speakerPageID)
    XCTAssertFalse(try PageDocument.upsertMeetingTranscript(first, in: once.document).changed)
  }

  func testIndependentSegmentChangesMerge() throws {
    let pageID = PageID.free()
    let base = try PageDocument.create(id: pageID, kind: .free, title: "Meeting", createdAt: .distantPast)
    let local = try PageDocument.upsertMeetingTranscript(transcript(pageID, segments: [segment("local", 0, 1)]), in: base.document)
    let remote = try PageDocument.upsertMeetingTranscript(transcript(pageID, segments: [segment("remote", 2, 3)]), in: base.document)
    let merged = try PageDocument.merge(local: local.document, remote: remote.document, pageID: pageID)
    let resource = try XCTUnwrap(PageDocument.meetingTranscript(resourceKey: MeetingTranscriptResource.resourceKey(for: pageID), in: merged.document))
    XCTAssertEqual(resource.segments.map(\.id), ["local", "remote"])
  }

  func testExplicitSpeakerClearWinsOverStaleDiarizationAndKeepsTranscriptHashStable() throws {
    let pageID = PageID.free()
    let personID = PageID.free()
    let base = try PageDocument.create(id: pageID, kind: .free, title: "Meeting", createdAt: .distantPast)
    var assigned = transcript(pageID, segments: [segment("a", 0, 2)])
    assigned.segments[0].speakerPageID = personID
    assigned.segments[0].speakerAssignmentRevision = 1
    assigned.segments[0].speakerAssignmentOperationID = "assign"
    let transcriptHash = MeetingTranscriptHash.value(for: assigned.segments)
    let once = try PageDocument.upsertMeetingTranscript(assigned, in: base.document)

    var cleared = assigned
    cleared.segments[0].speakerPageID = nil
    cleared.segments[0].speakerAssignmentRevision = 2
    cleared.segments[0].speakerAssignmentOperationID = "clear"
    XCTAssertEqual(MeetingTranscriptHash.value(for: cleared.segments), transcriptHash)
    let twice = try PageDocument.upsertMeetingTranscript(cleared, in: once.document)

    let stale = transcript(pageID, segments: [segment("a", 0, 2)])
    let threeTimes = try PageDocument.upsertMeetingTranscript(stale, in: twice.document)
    let persisted = try XCTUnwrap(
      PageDocument.meetingTranscript(resourceKey: assigned.id, in: threeTimes.document)?.segments.first
    )
    XCTAssertNil(persisted.speakerPageID)
    XCTAssertEqual(persisted.speakerAssignmentRevision, 2)
    XCTAssertEqual(persisted.speakerAssignmentOperationID, "clear")
  }

  func testStatesNeverRegressAndSizeGuardsApply() throws {
    let pageID = PageID.free()
    let base = try PageDocument.create(id: pageID, kind: .free, title: "Meeting", createdAt: .distantPast)
    var complete = transcript(pageID); complete.transcriptState = .complete
    let saved = try PageDocument.upsertMeetingTranscript(complete, in: base.document)
    var stale = transcript(pageID); stale.transcriptState = .inProgress
    let merged = try PageDocument.upsertMeetingTranscript(stale, in: saved.document)
    XCTAssertEqual(try PageDocument.meetingTranscript(resourceKey: complete.id, in: merged.document)?.transcriptState, .complete)
    var tooLong = transcript(pageID, segments: [segment("late", 0, MeetingTranscriptResource.maximumDurationSeconds + 1)])
    XCTAssertThrowsError(try PageDocument.upsertMeetingTranscript(tooLong, in: base.document))
    tooLong = transcript(pageID, segments: [segment("large", 0, 1, text: String(repeating: "x", count: PageDocument.maximumMeetingTranscriptChangeBytes))])
    XCTAssertThrowsError(try PageDocument.upsertMeetingTranscript(tooLong, in: base.document))
  }

  func testNoAudioPathOrURLFieldsExistInCanonicalPayload() throws {
    let resource = transcript(PageID.free(), segments: [segment("a", 0, 1)])
    let json = String(decoding: try JSONEncoder.enchiridion.encode(resource), as: UTF8.self).lowercased()
    XCTAssertFalse(json.contains("audio")); XCTAssertFalse(json.contains("path")); XCTAssertFalse(json.contains("url"))
  }

  private func transcript(_ pageID: PageID, segments: [MeetingTranscriptSegment] = []) -> MeetingTranscriptResource {
    .init(eventPageID: pageID, provenance: .init(captureAlgorithm: "system", captureAlgorithmVersion: "1", transcriptionAlgorithm: "on-device", transcriptionAlgorithmVersion: "1"), segments: segments)
  }

  private func segment(_ id: String, _ start: TimeInterval, _ end: TimeInterval, text: String = "Hello") -> MeetingTranscriptSegment {
    .init(id: id, startTime: start, endTime: end, text: text, speakerClusterID: "speaker-1")
  }
}
