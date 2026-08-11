// ShareCaptureBodyTests.swift
// EnchiridionShareKitTests
//
// Pure derivation tests — no store, no I/O. See `ShareCaptureBody.swift`'s
// header for why this logic is split out and independently testable.

import Foundation
import XCTest

@testable import EnchiridionShareKit

final class ShareCaptureBodyTests: XCTestCase {
  // MARK: - Title

  func testTitlePrefersAnExplicitPageTitleOverText() {
    let input = ShareCaptureInput(text: "Body text", url: nil, pageTitle: "Explicit Title")
    XCTAssertEqual(ShareCaptureBody.title(for: input), "Explicit Title")
  }

  func testTitleFallsBackToTheFirstLineOfText() {
    let input = ShareCaptureInput(text: "First line\nSecond line")
    XCTAssertEqual(ShareCaptureBody.title(for: input), "First line")
  }

  func testTitleFallsBackToTheURLWhenThereIsNoTextOrPageTitle() {
    let url = URL(string: "https://rawkode.academy/article")!
    let input = ShareCaptureInput(url: url)
    XCTAssertEqual(ShareCaptureBody.title(for: input), url.absoluteString)
  }

  func testTitleFallsBackToTheDefaultWhenInputIsEmpty() {
    XCTAssertEqual(ShareCaptureBody.title(for: ShareCaptureInput()), ShareCaptureBody.defaultTitle)
  }

  func testTitleTruncatesAnOverlyLongFirstLineWithAnEllipsis() {
    let longLine = String(repeating: "a", count: ShareCaptureBody.maximumTitleLength + 80)
    let input = ShareCaptureInput(text: longLine)

    let title = ShareCaptureBody.title(for: input)

    XCTAssertEqual(title.count, ShareCaptureBody.maximumTitleLength + 1)
    XCTAssertTrue(title.hasSuffix("…"))
  }

  func testTitleIgnoresAnExplicitPageTitleThatIsOnlyWhitespace() {
    let input = ShareCaptureInput(text: "Real content", pageTitle: "   ")
    XCTAssertEqual(ShareCaptureBody.title(for: input), "Real content")
  }

  // MARK: - Body

  func testBodyCombinesTextAndURLWithABlankLineBetween() {
    let url = URL(string: "https://example.com")!
    let input = ShareCaptureInput(text: "Worth reading", url: url)
    XCTAssertEqual(ShareCaptureBody.body(for: input), "Worth reading\n\nhttps://example.com")
  }

  func testBodyIsJustTheTextWhenThereIsNoURL() {
    let input = ShareCaptureInput(text: "Just a note")
    XCTAssertEqual(ShareCaptureBody.body(for: input), "Just a note")
  }

  func testBodyIsJustTheURLWhenThereIsNoText() {
    let url = URL(string: "https://example.com/page")!
    let input = ShareCaptureInput(url: url)
    XCTAssertEqual(ShareCaptureBody.body(for: input), url.absoluteString)
  }

  func testBodyIsEmptyWhenInputIsEmpty() {
    XCTAssertEqual(ShareCaptureBody.body(for: ShareCaptureInput()), "")
  }

  func testBodyTreatsWhitespaceOnlyTextAsAbsent() {
    let url = URL(string: "https://example.com")!
    let input = ShareCaptureInput(text: "   \n  ", url: url)
    XCTAssertEqual(ShareCaptureBody.body(for: input), url.absoluteString)
  }
}
