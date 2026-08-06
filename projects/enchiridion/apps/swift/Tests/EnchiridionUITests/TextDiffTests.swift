// TextDiffTests.swift
// EnchiridionUITests

import XCTest

@testable import EnchiridionUI

final class TextDiffTests: XCTestCase {
  func testIdenticalStringsReturnNil() {
    XCTAssertNil(TextDiff.replacement(from: "hello", to: "hello"))
  }

  func testPureAppend() {
    let diff = TextDiff.replacement(from: "hello", to: "hello world")
    XCTAssertEqual(diff, TextReplacement(range: 5..<5, replacement: " world"))
  }

  func testPurePrepend() {
    let diff = TextDiff.replacement(from: "world", to: "hello world")
    XCTAssertEqual(diff, TextReplacement(range: 0..<0, replacement: "hello "))
  }

  func testPureDeleteAtEnd() {
    let diff = TextDiff.replacement(from: "hello world", to: "hello")
    XCTAssertEqual(diff, TextReplacement(range: 5..<11, replacement: ""))
  }

  func testPureDeleteInMiddle() {
    let diff = TextDiff.replacement(from: "hello brave world", to: "hello world")
    XCTAssertEqual(diff, TextReplacement(range: 6..<12, replacement: ""))
  }

  func testSingleCharacterInsertInMiddle() {
    let diff = TextDiff.replacement(from: "helo", to: "hello")
    XCTAssertEqual(diff, TextReplacement(range: 3..<3, replacement: "l"))
  }

  func testReplaceWholeString() {
    let diff = TextDiff.replacement(from: "abc", to: "xyz")
    XCTAssertEqual(diff, TextReplacement(range: 0..<3, replacement: "xyz"))
  }

  func testEmptyToNonEmpty() {
    let diff = TextDiff.replacement(from: "", to: "hi")
    XCTAssertEqual(diff, TextReplacement(range: 0..<0, replacement: "hi"))
  }

  func testNonEmptyToEmpty() {
    let diff = TextDiff.replacement(from: "hi", to: "")
    XCTAssertEqual(diff, TextReplacement(range: 0..<2, replacement: ""))
  }

  /// Multi-scalar characters (a flag emoji is two Regional Indicator
  /// scalars) must be diffed in Unicode Scalar units, not `Character`
  /// (grapheme) units — matching `PageDocument`'s addressing.
  func testMultiScalarCharacterBoundary() {
    let old = "a🇬🇧b"
    let new = "a🇬🇧🇺🇸b"
    let diff = TextDiff.replacement(from: old, to: new)
    XCTAssertEqual(diff?.replacement, "🇺🇸")
    // "a" (1) + 🇬🇧 (2 scalars) = offset 3, right before "b".
    XCTAssertEqual(diff?.range, 3..<3)
  }
}
