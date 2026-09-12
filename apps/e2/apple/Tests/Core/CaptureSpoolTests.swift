import Foundation
import XCTest
@testable import ApsidesCore

final class CaptureSpoolTests: XCTestCase {
    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }

    func testRetryRetainsOneImmutableCaptureAndAcknowledgementIsIdempotent() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let spool = CaptureSpool(directory: directory)
        let capture = Capture(text: "A thought", source: .shortcut)
        try spool.save(capture)
        try spool.save(capture)
        XCTAssertEqual(try spool.pending(), [capture])
        var conflict = capture; conflict.text = "Changed"
        XCTAssertThrowsError(try spool.save(conflict))
        XCTAssertEqual(try spool.pending(), [capture])
        try spool.acknowledge(capture.id)
        try spool.acknowledge(capture.id)
        XCTAssertTrue(try spool.pending().isEmpty)
    }

    func testCorruptionIsReportedAndNeverDeleted() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let spool = CaptureSpool(directory: directory)
        let capture = Capture(text: "Healthy", source: .shortcut)
        try spool.save(capture)
        let broken = directory.appendingPathComponent("\(UUID().uuidString).json")
        try Data("broken".utf8).write(to: broken)
        XCTAssertThrowsError(try spool.pending())
        XCTAssertEqual(try String(contentsOf: broken, encoding: .utf8), "broken")
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("\(capture.id.uuidString).json").path))
    }

    func testConcurrentWritersAndRetriesPublishCompleteFiles() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let spool = CaptureSpool(directory: directory)
        let captures = (0..<40).map { Capture(text: "Thought \($0)", source: .shortcut) }
        try await withThrowingTaskGroup(of: Void.self) { group in
            for capture in captures {
                for _ in 0..<3 { group.addTask { try spool.save(capture) } }
            }
            try await group.waitForAll()
        }
        XCTAssertEqual(Set(try spool.pending().map(\.id)), Set(captures.map(\.id)))
    }

    func testInvalidInputNeverCreatesPendingCapture() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let spool = CaptureSpool(directory: directory)
        XCTAssertThrowsError(try spool.save(Capture(text: " \n", source: .shortcut)))
        XCTAssertThrowsError(try spool.save(Capture(text: String(repeating: "x", count: 100_001), source: .shortcut)))
        XCTAssertEqual(try spool.pending(), [])
    }

    func testUnacknowledgedCaptureSurvivesConsumerCrashAndReplay() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let spool = CaptureSpool(directory: directory)
        let capture = Capture(text: "Keep me", source: .shortcut)
        try spool.save(capture)
        let committed = try CaptureLedger.inserting(capture, into: Vault())
        // A crash between the app commit and acknowledgement safely replays the same ID.
        let replayed = try CaptureSpool(directory: directory).pending().reduce(committed) {
            try CaptureLedger.inserting($1, into: $0)
        }
        XCTAssertEqual(replayed, committed)
        try spool.acknowledge(capture.id)
        XCTAssertTrue(try spool.pending().isEmpty)
        XCTAssertEqual(replayed.captures, [capture])
    }
}
