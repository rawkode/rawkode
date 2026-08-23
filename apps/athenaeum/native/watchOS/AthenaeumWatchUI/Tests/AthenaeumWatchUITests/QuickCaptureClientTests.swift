import XCTest
@testable import AthenaeumWatchUI

/// Offline unit tests — no network, safe for CI. `truncatedTitle` is the one piece of pure logic
/// in `QuickCaptureClient` worth testing without a live backend.
final class QuickCaptureClientTests: XCTestCase {
    func testTruncatedTitleLeavesShortTextUnchanged() {
        XCTAssertEqual(QuickCaptureClient.truncatedTitle("Buy milk"), "Buy milk")
    }

    func testTruncatedTitleTruncatesLongTextWithEllipsis() {
        let long = String(repeating: "a", count: 200)
        let truncated = QuickCaptureClient.truncatedTitle(long)
        XCTAssertEqual(truncated.count, QuickCaptureClient.titleCharacterLimit + 1) // +1 for "…"
        XCTAssertTrue(truncated.hasSuffix("…"))
    }

    func testTruncatedTitleExactLimitUnchanged() {
        let exact = String(repeating: "b", count: QuickCaptureClient.titleCharacterLimit)
        XCTAssertEqual(QuickCaptureClient.truncatedTitle(exact), exact)
    }
}
