import XCTest
@testable import EnchiridionCore

final class VoiceCaptionsTests: XCTestCase {
    private func event(_ id: String, _ text: String, _ start: Double, _ end: Double, assistant: Bool = false) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["type": assistant ? "session.output_transcript.delta" : "session.input_transcript.delta", "event_id": id, "delta": text, "start_ms": start, "end_ms": end])
    }
    func testOverlapLateFragmentsPreserveSpeakerRowsAndExactText() throws {
        var captions = VoiceCaptions()
        captions.receive(try event("u1", "What is", 1000, 1200))
        captions.receive(try event("a1", "Let me", 1100, 1500, assistant: true))
        captions.receive(try event("u3", " today?", 1500, 1800))
        captions.receive(try event("u2", " next", 1200, 1500))
        captions.receive(try event("u2", " next", 1200, 1500))
        XCTAssertEqual(captions.rows.map(\.id), ["u1", "a1"])
        XCTAssertEqual(captions.rows.map(\.text), ["What is next today?", "Let me"])
        XCTAssertEqual(captions.rows[0].fragments.count, 3)
        captions.receive(try event("a2", "Another thought", 7000, 8000, assistant: true))
        XCTAssertEqual(captions.rows.map(\.id), ["u1", "a1", "a2"])
    }
    func testTypingAndResumedVoiceKeepSeparateChronologicalRows() throws {
        var captions = VoiceCaptions()
        captions.receive(try event("spoken", "Create a tag", 1000, 2000))
        captions.appendMessage("You pick the fields", speaker: .user)
        captions.appendMessage("Created Web links", speaker: .assistant)
        captions.beginSegment()
        captions.receive(try event("resumed", "Add a URL", 0, 500))
        XCTAssertEqual(captions.rows.map(\.text), ["Create a tag", "You pick the fields", "Created Web links", "Add a URL"])
        XCTAssertGreaterThan(captions.rows[3].fragments[0].startMilliseconds, captions.rows[2].fragments[0].endMilliseconds)
    }

    func testMalformedAndBoundedCaptionInput() throws {
        var captions = VoiceCaptions()
        captions.receive(try event("bad", "wrong", 2, 1))
        XCTAssertTrue(captions.rows.isEmpty)
        for index in 0..<110 {
            captions.receive(try event("e\(index)", "caption", Double(index * 4000), Double(index * 4000 + 100)))
        }
        XCTAssertEqual(captions.rows.count, 100)
        XCTAssertTrue(captions.earlierCaptionsOmitted)
    }
}
