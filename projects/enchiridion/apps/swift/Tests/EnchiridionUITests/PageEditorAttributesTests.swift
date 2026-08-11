// PageEditorAttributesTests.swift
// EnchiridionUITests
//
// The `PageEditorBody <-> AttributedString` bridge (PageEditorAttributes.swift)
// is plain Foundation/SwiftUI value-type conversion — no live UI runtime
// needed — so it's covered here even though it exists to serve the View.

import SwiftUI
import XCTest

@testable import EnchiridionCore
@testable import EnchiridionSync
@testable import EnchiridionUI

final class PageEditorAttributesTests: XCTestCase {
  func testPlainTextRoundTripsThroughAttributedString() {
    let body = PageEditorBody(text: "hello world")
    let attributed = body.attributedString
    XCTAssertEqual(attributed.plainTextRepresentation, "hello world")
  }

  func testMarkStyleAttributeIsSetOverTheExactRunRange() {
    let body = PageEditorBody(
      text: "hello world",
      markRuns: [MarkRun(range: 0..<5, styles: [.bold]), MarkRun(range: 5..<11, styles: [])])
    let attributed = body.attributedString

    let boldRange = try! XCTUnwrap(attributed.range(forScalarRange: 0..<5))
    XCTAssertEqual(attributed[boldRange].markStyle, [.bold])
    XCTAssertEqual(attributed[boldRange].inlinePresentationIntent, .stronglyEmphasized)

    let plainRange = try! XCTUnwrap(attributed.range(forScalarRange: 5..<11))
    XCTAssertNil(attributed[plainRange].markStyle)
  }

  func testUnderlineAndStrikethroughGetTheirOwnDisplayAttributes() {
    let body = PageEditorBody(
      text: "abc",
      markRuns: [MarkRun(range: 0..<3, styles: [.underline, .strikethrough])])
    let attributed = body.attributedString
    let range = try! XCTUnwrap(attributed.range(forScalarRange: 0..<3))
    XCTAssertEqual(attributed[range].underlineStyle, .single)
    XCTAssertEqual(attributed[range].strikethroughStyle, .single)
  }

  func testReferenceRunGetsThePageReferenceAttribute() {
    let target = PageID.free()
    let destination = PageReferenceDestination(pageID: target, label: "Alice")
    let body = PageEditorBody(text: "Hi Alice", referenceRuns: [ReferenceRun(range: 3..<8, destination: destination)])
    let attributed = body.attributedString
    let range = try! XCTUnwrap(attributed.range(forScalarRange: 3..<8))
    XCTAssertEqual(attributed[range].pageReference, destination)
  }

  func testScalarOffsetRoundTripsThroughAttributedStringIndex() {
    let body = PageEditorBody(text: "hello world")
    let attributed = body.attributedString
    for offset in 0...attributed.plainTextRepresentation.scalarCount {
      let index = try! XCTUnwrap(attributed.index(atScalarOffset: offset))
      XCTAssertEqual(attributed.scalarOffset(of: index), offset)
    }
  }
}
