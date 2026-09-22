import Foundation
import XCTest
@testable import EnchiridionCore

final class MeetingArchiveTests: XCTestCase {
    func testRecognitionCanResegmentProvisionalTextWithoutLosingSavedFinals() throws {
        let stream = UUID()
        var meeting = MeetingTranscript()
        try meeting.start(participantsInformed: true)
        try meeting.reconcileRecognition(.init(id: .init(stream: stream, item: "0"), revision: 1,
                                               start: 0, end: 8, text: "Send the draft tomorrow", isFinal: false))
        var archive = try MeetingArchive().saving(meeting, ownerID: "a")
        try meeting.reconcileRecognition(.init(id: .init(stream: stream, item: "1"), revision: 2,
                                               start: 1, end: 4, text: "Send the draft.", isFinal: true))
        archive = try archive.saving(meeting, ownerID: "a")
        try meeting.reconcileRecognition(.init(id: .init(stream: stream, item: "4"), revision: 3,
                                               start: 4, end: 8, text: "Tomorrow", isFinal: false))
        archive = try archive.saving(meeting, ownerID: "a")
        XCTAssertEqual(archive.transcripts(ownerID: "a").first?.segments.map(\.text), ["Send the draft.", "Tomorrow"])
        XCTAssertEqual(archive.restored().transcripts(ownerID: "a").first?.recordingState, .interrupted)
    }

    func testRestartPreservesPartialTranscriptAndInterruptsRecording() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let disk = MeetingArchivePersistence(url: directory.appendingPathComponent("meetings.json"))
        var meeting = MeetingTranscript()
        try meeting.start(participantsInformed: true)
        meeting.note = "Follow up with Ada"
        try meeting.receive(.init(id: .init(stream: UUID(), item: "partial"), revision: 1,
                                  start: 0, end: 3, text: "The next release", isFinal: false))
        try disk.save(MeetingArchive().saving(meeting, ownerID: "owner-a"))
        let loaded = try XCTUnwrap(disk.load().transcripts(ownerID: "owner-a").first)
        XCTAssertEqual(loaded.recordingState, .interrupted)
        XCTAssertEqual(loaded.note, meeting.note)
        XCTAssertEqual(loaded.segments, meeting.segments)
    }

    func testAccountAndDeviceNotebooksAreIsolatedAndCannotReattributeMeeting() throws {
        let first = MeetingTranscript(), second = MeetingTranscript(), local = MeetingTranscript()
        let archive = try MeetingArchive().saving(first, ownerID: "a")
            .saving(second, ownerID: "b").saving(local, ownerID: nil)
        XCTAssertEqual(archive.transcripts(ownerID: "a").map(\.id), [first.id])
        XCTAssertEqual(archive.transcripts(ownerID: "b").map(\.id), [second.id])
        XCTAssertEqual(archive.transcripts(ownerID: nil).map(\.id), [local.id])
        XCTAssertThrowsError(try archive.saving(first, ownerID: "b"))
        XCTAssertThrowsError(try archive.saving(first, ownerID: nil))
    }

    func testDelayedSnapshotCannotEraseFinalTranscriptOrReopenStoppedRecording() throws {
        var meeting = MeetingTranscript()
        try meeting.start(participantsInformed: true)
        let stale = meeting
        try meeting.receive(.init(id: .init(stream: UUID(), item: "final"), revision: 2,
                                  start: 0, end: 3, text: "Ship tomorrow", isFinal: true))
        let recording = meeting
        try meeting.stop()
        let archive = try MeetingArchive().saving(meeting, ownerID: "a")
        XCTAssertThrowsError(try archive.saving(stale, ownerID: "a"))
        XCTAssertThrowsError(try archive.saving(recording, ownerID: "a"))
        meeting.note = "My editable notes"
        XCTAssertEqual(try archive.saving(meeting, ownerID: "a").transcripts(ownerID: "a").first?.note, meeting.note)
    }

    func testCorruptAndFutureArchivesFailWithoutModifyingOriginal() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let disk = MeetingArchivePersistence(url: directory.appendingPathComponent("meetings.json"))
        for source in ["not json", "{\"version\":2,\"entries\":[]}"] {
            let bytes = Data(source.utf8)
            try bytes.write(to: disk.url)
            XCTAssertThrowsError(try disk.load())
            XCTAssertEqual(try Data(contentsOf: disk.url), bytes)
        }
    }
}
