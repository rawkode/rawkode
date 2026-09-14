import Foundation
import XCTest
@testable import ApsidesCore

final class ConnectedContextMergeTests: XCTestCase {
    func testPartialCalendarStaysUnpublishableToWatchAfterPersistence() throws {
        var fields = empty
        fields["googleEventsPartial"] = true
        let partial = try ConnectedContext.decode(envelope(fields), day: day)
        let restored = try JSONDecoder().decode(ConnectedContext.self, from: JSONEncoder().encode(partial))
        XCTAssertFalse(restored.canPublishCalendar)
        fields["googleEventsPartial"] = false
        fields["githubActivityPartial"] = true
        XCTAssertTrue(try ConnectedContext.decode(envelope(fields), day: day).canPublishCalendar)
    }

    private let day = "2026-09-13"
    private let oldTime = Date(timeIntervalSince1970: 100)
    private let newTime = Date(timeIntervalSince1970: 200)

    private func envelope(_ fields: [String: Any], errors: [[String: Any]] = []) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["data": ["me": ["today": fields]], "errors": errors])
    }
    private var empty: [String: Any] {
        ["googleEvents": [], "googleEventsPartial": false, "googlePeople": [], "githubActivity": [], "githubActivityPartial": false]
    }
    private func cached() -> ConnectedContext {
        ConnectedContext(snapshot: .init(day: day, fetchedAt: oldTime, events: [.init(id: "calendar", title: "Saved meeting")]),
            people: [.init(id: "person", name: "Ada", emails: [])],
            activity: [.init(id: "github", repository: "owner/repo", title: "Saved pull request", kind: "pullRequest", actor: "ada", action: "opened", date: oldTime, url: nil)], partial: false)
    }
    private func merge(_ fields: [String: Any], errors: [[String: Any]] = [], previous: ConnectedContext? = nil, previousOwner: String = "owner") throws -> ConnectedContext {
        try ConnectedContext.decode(envelope(fields, errors: errors), day: day, now: newTime,
            ownerID: "owner", previousOwnerID: previousOwner, previous: previous ?? cached())
    }

    func testCalendarFailureRetainsEventsAndAttendeesWhileSuccessfulGithubClears() throws {
        var fields = empty
        fields["googleEventsPartial"] = true
        let result = try merge(fields)
        XCTAssertEqual(result.snapshot.events, cached().snapshot.events)
        XCTAssertEqual(result.people, cached().people)
        XCTAssertEqual(result.activity, [])
        XCTAssertEqual(result.snapshot.fetchedAt, oldTime)
        XCTAssertEqual(result.freshness?.calendar.lastAttemptAt, newTime)
        XCTAssertEqual(result.freshness?.calendar.lastSuccessAt, oldTime)
        XCTAssertEqual(result.freshness?.github.lastSuccessAt, newTime)
        XCTAssertTrue(result.partial)
    }

    func testGithubErrorPreservesItemsAndSuccessfulEmptyCalendarClears() throws {
        var fields = empty
        fields["githubActivity"] = NSNull()
        let result = try merge(fields, errors: [["path": ["me", "today", "githubActivity"], "message": "private provider error"]])
        XCTAssertEqual(result.activity, cached().activity)
        XCTAssertTrue(result.snapshot.events.isEmpty)
        XCTAssertTrue(result.people.isEmpty)
        XCTAssertEqual(result.freshness?.github.lastSuccessAt, oldTime)
        XCTAssertEqual(result.freshness?.github.error, "GitHub could not fully refresh.")
        XCTAssertEqual(result.snapshot.fetchedAt, newTime)
    }

    func testExplicitSuccessfulEmptyClearsAllCachedSections() throws {
        let result = try merge(empty)
        XCTAssertTrue(result.snapshot.events.isEmpty)
        XCTAssertTrue(result.people.isEmpty)
        XCTAssertTrue(result.activity.isEmpty)
        XCTAssertFalse(result.partial)
        XCTAssertEqual(result.freshness?.github.retainedCache, false)
    }

    func testUnknownLegacyGithubCompletenessDoesNotEraseCache() throws {
        var fields = empty
        fields.removeValue(forKey: "githubActivityPartial")
        let result = try merge(fields)
        XCTAssertEqual(result.activity, cached().activity)
        XCTAssertEqual(result.freshness?.github.isPartial, true)
    }

    func testPartialRowsUpdateKnownItemsAndKeepMissingItems() throws {
        var fields = empty
        fields["githubActivityPartial"] = true
        fields["githubActivity"] = [["id": "new", "connectionId": "connection", "title": "New activity", "createdAt": "2026-09-13T10:00:00Z"]]
        let result = try merge(fields)
        XCTAssertEqual(result.activity.count, 2)
        XCTAssertEqual(result.activity.first?.title, "New activity")
        XCTAssertEqual(result.freshness?.github.lastSuccessAt, oldTime)
    }

    func testDayOrOwnerMismatchCannotFillFailedSections() throws {
        var fields = empty
        fields["googleEventsPartial"] = true
        fields["githubActivityPartial"] = true
        var yesterday = cached()
        yesterday.snapshot.day = "2026-09-12"
        for result in [try merge(fields, previous: yesterday), try merge(fields, previousOwner: "different-owner")] {
            XCTAssertTrue(result.snapshot.events.isEmpty)
            XCTAssertTrue(result.people.isEmpty)
            XCTAssertTrue(result.activity.isEmpty)
            XCTAssertNil(result.freshness?.calendar.lastSuccessAt)
            XCTAssertEqual(result.freshness?.github.retainedCache, false)
        }
    }

    func testRepeatedFailureDoesNotTurnUnknownFreshnessIntoSuccess() throws {
        var fields = empty
        fields["githubActivityPartial"] = true
        let first = try ConnectedContext.decode(envelope(fields), day: day, now: oldTime)
        let second = try merge(fields, previous: first)
        XCTAssertNil(first.freshness?.github.lastSuccessAt)
        XCTAssertNil(second.freshness?.github.lastSuccessAt)
        XCTAssertEqual(second.freshness?.github.lastAttemptAt, newTime)
    }
}
