import XCTest
@testable import ApsidesCore

final class VaultTests: XCTestCase {
    func testCaptureRetryIsIdempotentAndRejectsChangedPayload() throws {
        let capture = Capture(text: "Remember this", source: .watch)
        let first = try CaptureLedger.inserting(capture, into: Vault())
        XCTAssertEqual(try CaptureLedger.inserting(capture, into: first), first)
        var changed = capture; changed.text = "Different"
        XCTAssertThrowsError(try CaptureLedger.inserting(changed, into: first))
        var acknowledged = first; acknowledged.phoneReceipts.insert(capture.id)
        XCTAssertTrue(CaptureLedger.pendingPhoneDelivery(in: acknowledged).isEmpty)
        XCTAssertEqual(acknowledged.captures.count, 1)
    }
    func testPersistenceSurvivesRelaunchIncludingUnsubmittedDraft() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let disk = VaultPersistence(url: directory.appendingPathComponent("vault.json"))
        XCTAssertEqual(try disk.load(), Vault())
        var vault = Vault(); vault.captureDraft = "Half a thought"
        vault.drafts = [DayDraft(id: "2026-09-12", text: "Today’s plan")]
        try disk.save(vault)
        XCTAssertEqual(try VaultPersistence(url: disk.url).load(), vault)
    }
    func testCorruptAndFutureFilesAreNotSilentlyReset() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("broken".utf8).write(to: url)
        XCTAssertThrowsError(try VaultPersistence(url: url).load())
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "broken")
        var future = Vault(); future.version = 2
        try JSONEncoder().encode(future).write(to: url)
        XCTAssertThrowsError(try VaultPersistence(url: url).load())
    }
    func testEmptyAndOversizedCapturesRejected() {
        XCTAssertThrowsError(try CaptureLedger.inserting(Capture(text: " \n", source: .phone), into: Vault()))
        XCTAssertThrowsError(try CaptureLedger.inserting(Capture(text: String(repeating: "x", count: 100_001), source: .phone), into: Vault()))
    }
    func testDayBoundsFollowDSTAndNextEventExcludesFinishedAndAllDay() {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "Europe/London")!
        let date = ISO8601DateFormatter().date(from: "2026-03-29T12:00:00Z")!
        let (start, end) = DayIdentity.bounds(date, calendar: calendar)
        XCTAssertEqual(end.timeIntervalSince(start), 23 * 3600)
        XCTAssertEqual(DayIdentity.key(date, calendar: calendar), "2026-03-29")
        let snapshot = ContextSnapshot(day: "2026-03-29", events: [
            AgendaEvent(id: "all", title: "All day", allDay: true),
            AgendaEvent(id: "past", title: "Done", start: date.addingTimeInterval(-100)),
            AgendaEvent(id: "next", title: "Next", start: date.addingTimeInterval(100))
        ])
        XCTAssertEqual(snapshot.nextEvent(at: date)?.id, "next")
    }
    func testPortableTextKeepsBlankLinesAndUnicode() throws {
        let object = try JSONSerialization.jsonObject(with: PortableCapture.data(text: "Hello 👋\n\nLast")) as! [String: Any]
        XCTAssertEqual(object["type"] as? String, "doc")
        let content = object["content"] as! [[String: Any]]
        XCTAssertEqual(content.count, 3)
        XCTAssertNil(content[1]["content"])
    }
}
