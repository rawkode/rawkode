import XCTest
@testable import ApsidesCore

final class GitHubActivityTests: XCTestCase {
    func testActivityDetailsSurviveGraphQLDecoding() throws {
        let data = Data(##"{"data":{"me":{"today":{"githubActivity":[{"id":"event","kind":"pullRequest","title":"Improve daily capture","summary":"Keeps the editor ready between visits.","number":35,"url":"https://github.com/rawkode/rawkode/pull/35","repository":"rawkode/rawkode","actor":"rawkode","action":"opened","createdAt":"2026-09-12T13:16:00Z"}]}}}}"##.utf8)
        let item = try XCTUnwrap(ConnectedContext.decode(data, day: "2026-09-12").activity.first)
        XCTAssertEqual(item.title, "Improve daily capture")
        XCTAssertEqual(item.summary, "Keeps the editor ready between visits.")
        XCTAssertEqual(item.number, 35)
        XCTAssertEqual(item.url?.path, "/rawkode/rawkode/pull/35")
    }
}
