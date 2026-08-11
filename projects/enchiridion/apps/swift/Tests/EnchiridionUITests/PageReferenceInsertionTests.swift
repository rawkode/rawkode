// PageReferenceInsertionTests.swift
// EnchiridionUITests

import XCTest

@testable import EnchiridionCore
@testable import EnchiridionUI

final class PageReferenceInsertionTests: XCTestCase {
  // MARK: - Trigger detection

  func testDetectsOpenTriggerRightAfterBrackets() {
    let match = PageReferenceTrigger.match(in: "Talk to [[", cursor: 10)
    XCTAssertEqual(match, PageReferenceTriggerMatch(range: 8..<10, query: ""))
  }

  func testDetectsOpenTriggerWithPartialQuery() {
    let text = "Talk to [[Ali"
    let match = PageReferenceTrigger.match(in: text, cursor: text.scalarCount)
    XCTAssertEqual(match?.query, "Ali")
    XCTAssertEqual(match?.range, 8..<13)
  }

  func testNoMatchWithoutAnOpenBracket() {
    XCTAssertNil(PageReferenceTrigger.match(in: "Talk to Alice", cursor: 13))
  }

  func testClosedTriggerNoLongerMatches() {
    XCTAssertNil(PageReferenceTrigger.match(in: "Talk to [[Alice]] now", cursor: 21))
  }

  func testTriggerDoesNotSpanANewline() {
    let text = "[[foo\nbar"
    XCTAssertNil(PageReferenceTrigger.match(in: text, cursor: text.scalarCount))
  }

  func testSecondOpenBracketSupersedesTheFirst() {
    let text = "[[foo [[bar"
    let match = PageReferenceTrigger.match(in: text, cursor: text.scalarCount)
    XCTAssertEqual(match?.range, 6..<11)
    XCTAssertEqual(match?.query, "bar")
  }

  func testCursorOutOfBoundsReturnsNil() {
    XCTAssertNil(PageReferenceTrigger.match(in: "hi", cursor: 99))
    XCTAssertNil(PageReferenceTrigger.match(in: "hi", cursor: -1))
  }

  // MARK: - Insertion planning

  func testPlanCapturesExactReplacementParameters() {
    let target = PageID.free()
    let plan = PageReferenceInsertion.plan(replacing: 8..<13, with: "Alice Chen", pageID: target)
    XCTAssertEqual(plan.replacedRange, 8..<13)
    XCTAssertEqual(plan.label, "Alice Chen")
    XCTAssertEqual(plan.pageID, target)
  }

  /// End-to-end: a detected trigger's range feeds directly into a plan
  /// without any hidden re-derivation.
  func testTriggerRangeFeedsDirectlyIntoAPlan() {
    let text = "Talk to [[Ali"
    let match = PageReferenceTrigger.match(in: text, cursor: text.scalarCount)!
    let target = PageID.free()
    let plan = PageReferenceInsertion.plan(replacing: match.range, with: "Alice Chen", pageID: target)
    XCTAssertEqual(plan.replacedRange, match.range)
  }
}
