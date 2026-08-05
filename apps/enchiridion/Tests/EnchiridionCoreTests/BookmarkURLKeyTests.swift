import XCTest
@testable import EnchiridionCore

final class BookmarkURLKeyTests: XCTestCase {
  func testV1CanonicalizesSchemeHostDefaultPortAndEmptyPath() {
    let key = BookmarkURLKey(submittedURL: "HTTP://Example.COM:80")
    XCTAssertEqual(key?.canonicalURL, "http://example.com/")
    XCTAssertEqual(key?.digest, BookmarkURLKey(submittedURL: "http://example.com/")?.digest)
  }

  func testV1PreservesQueryOrderValuesAndFragment() {
    let first = BookmarkURLKey(submittedURL: "https://example.com/a?x=1&x=2#one")
    let second = BookmarkURLKey(submittedURL: "https://example.com/a?x=2&x=1#one")
    XCTAssertNotEqual(first?.digest, second?.digest)
    XCTAssertEqual(first?.canonicalURL, "https://example.com/a?x=1&x=2#one")
  }

  func testV1NormalizesUnreservedPercentEscapesButNotReservedEscapes() {
    XCTAssertEqual(BookmarkURLKey(submittedURL: "https://example.com/%7eA/%2f")?.canonicalURL, "https://example.com/~A/%2F")
  }

  func testV1RejectsOpaqueAndCredentialedSchemes() {
    for value in ["file:///tmp/x", "data:text/plain,hello", "javascript:alert(1)", "https://u:p@example.com/", "mailto:a@example.com", "https:/missing-host"] {
      XCTAssertNil(BookmarkURLKey(submittedURL: value), value)
    }
  }
}
