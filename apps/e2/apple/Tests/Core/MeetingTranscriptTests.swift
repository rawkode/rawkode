import Foundation
import XCTest
@testable import ApsidesCore

final class MeetingTranscriptTests: XCTestCase {
    func segment(_ id: MeetingSegmentID, _ revision: Int, _ text: String, final: Bool = false, start: Double = 0) throws -> MeetingTranscriptSegment {
        try .init(id: id, revision: revision, start: start, end: start + 2, text: text, isFinal: final)
    }

    func testOutOfOrderRevisionsReplayAndReconnectPreserveTranscript() throws {
        let stream = UUID(), first = MeetingSegmentID(stream: UUID(), item: "same-provider-id")
        let reconnected = MeetingSegmentID(stream: stream, item: first.item)
        var meeting = MeetingTranscript()
        try meeting.receive(segment(first, 1, "We should"))
        try meeting.receive(segment(first, 3, "We should ship tomorrow.", final: true))
        try meeting.receive(segment(first, 2, "We should ship"))
        try meeting.receive(segment(first, 3, "We should ship tomorrow.", final: true))
        try meeting.receive(segment(reconnected, 1, "Agreed.", final: true, start: 4))
        XCTAssertEqual(meeting.segments.map(\.text), ["We should ship tomorrow.", "Agreed."])
        XCTAssertThrowsError(try meeting.receive(segment(first, 4, "Different final", final: true)))
    }

    func testInterruptionAndRestartKeepNotesAndFinalsWithoutClaimingRecording() throws {
        var meeting = MeetingTranscript()
        XCTAssertThrowsError(try meeting.start(participantsInformed: false))
        try meeting.start(participantsInformed: true)
        meeting.note = "Ask about the release date."
        try meeting.receive(segment(.init(stream: UUID(), item: "1"), 0, "Tomorrow", final: true))
        let restored = try JSONDecoder().decode(MeetingTranscript.self, from: JSONEncoder().encode(meeting)).restored()
        XCTAssertEqual(restored.recordingState, .interrupted)
        XCTAssertEqual(restored.note, meeting.note)
        XCTAssertEqual(restored.segments, meeting.segments)
        try meeting.interrupt()
        try meeting.start(participantsInformed: true)
        try meeting.stop()
        XCTAssertThrowsError(try meeting.start(participantsInformed: true))
    }

    func testSuggestionsRequireFinalQuotedSourcesAndNeverEditTheNote() throws {
        var meeting = MeetingTranscript()
        let id = MeetingSegmentID(stream: UUID(), item: "1")
        try meeting.receive(segment(id, 0, "Ada will send the draft."))
        let proposal = MeetingSuggestion(kind: .action, text: "Send the draft", sources: [.init(segment: id, quote: "Ada will send the draft.")])
        XCTAssertThrowsError(try meeting.propose(proposal))
        try meeting.receive(segment(id, 1, "Ada will send the draft.", final: true))
        try meeting.propose(proposal)
        try meeting.propose(proposal)
        XCTAssertEqual(meeting.suggestions.count, 1)
        XCTAssertEqual(meeting.note, "")
        XCTAssertThrowsError(try meeting.propose(.init(kind: .summary, text: "Invented deadline", sources: [.init(segment: id, quote: "by Friday")])))
        XCTAssertThrowsError(try meeting.propose(.init(kind: .action, text: "No source", sources: [])))
    }

    func testPersistedSuggestionsAreValidatedWhenDecoded() throws {
        var meeting = MeetingTranscript()
        let id = MeetingSegmentID(stream: UUID(), item: "1")
        try meeting.receive(segment(id, 1, "Confirmed text", final: true))
        try meeting.propose(.init(kind: .summary, text: "Summary", sources: [.init(segment: id, quote: "Confirmed text")]))
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(meeting)) as? [String: Any])
        json["segments"] = []
        XCTAssertThrowsError(try JSONDecoder().decode(MeetingTranscript.self, from: JSONSerialization.data(withJSONObject: json)))
    }

    func testRecognitionReplacesOverlappingVolatileRangesWithoutChangingFinals() throws {
        let stream = UUID()
        var meeting = MeetingTranscript()
        let first = try MeetingTranscriptSegment(id: .init(stream: stream, item: "0"), revision: 1, start: 0, end: 4, text: "Provisional words", isFinal: false)
        try meeting.reconcileRecognition(first)
        let changed = try MeetingTranscriptSegment(id: .init(stream: stream, item: "1"), revision: 2, start: 1, end: 4, text: "Final words", isFinal: true)
        try meeting.reconcileRecognition(changed)
        XCTAssertEqual(meeting.segments, [changed])
        try meeting.reconcileRecognition(changed)
        XCTAssertThrowsError(try meeting.reconcileRecognition(first))
        let correction = try MeetingTranscriptSegment(id: changed.id, revision: 3, start: 1, end: 4, text: "Changed final", isFinal: true)
        XCTAssertThrowsError(try meeting.reconcileRecognition(correction))
        XCTAssertEqual(meeting.segments, [changed])
    }

    func testInvalidOffsetsAndConflictingRevisionAreRejected() throws {
        let id = MeetingSegmentID(stream: UUID(), item: "1")
        XCTAssertThrowsError(try segment(id, 0, "Invalid", start: -1))
        var meeting = MeetingTranscript()
        try meeting.receive(segment(id, 1, "Original"))
        XCTAssertThrowsError(try meeting.receive(segment(id, 1, "Conflicting")))
        XCTAssertEqual(meeting.segments.first?.text, "Original")
    }
}
