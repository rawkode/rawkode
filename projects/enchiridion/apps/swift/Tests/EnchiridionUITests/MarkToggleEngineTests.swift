// MarkToggleEngineTests.swift
// EnchiridionUITests

import XCTest

@testable import EnchiridionCore
@testable import EnchiridionSync
@testable import EnchiridionUI

final class MarkToggleEngineTests: XCTestCase {
  // "hello world" (11 scalars), "hello" (0..<5) bold.
  private let boldHello: [MarkRun] = [
    MarkRun(range: 0..<5, styles: [.bold]),
    MarkRun(range: 5..<11, styles: []),
  ]

  func testStateOnWhenFullyCovered() {
    XCTAssertEqual(MarkToggleEngine.state(of: .bold, in: 0..<5, runs: boldHello), .on)
  }

  func testStateOffWhenNotCovered() {
    XCTAssertEqual(MarkToggleEngine.state(of: .bold, in: 6..<11, runs: boldHello), .off)
  }

  func testStateMixedWhenPartiallyCovered() {
    XCTAssertEqual(MarkToggleEngine.state(of: .bold, in: 3..<8, runs: boldHello), .mixed)
  }

  func testShouldEnableTogglesOffWhenFullyOn() {
    XCTAssertFalse(MarkToggleEngine.shouldEnable(.bold, in: 0..<5, runs: boldHello))
  }

  func testShouldEnableTogglesOnWhenOffOrMixed() {
    XCTAssertTrue(MarkToggleEngine.shouldEnable(.bold, in: 6..<11, runs: boldHello))
    XCTAssertTrue(MarkToggleEngine.shouldEnable(.bold, in: 3..<8, runs: boldHello))
  }

  func testCaretStateReflectsPrecedingRun() {
    XCTAssertEqual(MarkToggleEngine.state(of: .bold, in: 5..<5, runs: boldHello), .on)
    XCTAssertEqual(MarkToggleEngine.state(of: .bold, in: 0..<0, runs: boldHello), .off)
  }

  func testApplyingEnableOverPartialRangeSplitsRuns() {
    let result = MarkToggleEngine.applying(.bold, enable: true, over: 3..<8, to: boldHello)
    // 0..<3 bold (unchanged), 3..<8 bold (newly enabled, merges with the
    // first since same style set), 8..<11 unmarked.
    XCTAssertEqual(result, [
      MarkRun(range: 0..<8, styles: [.bold]),
      MarkRun(range: 8..<11, styles: []),
    ])
  }

  func testApplyingDisableOverFullRangeRemovesStyle() {
    let result = MarkToggleEngine.applying(.bold, enable: false, over: 0..<5, to: boldHello)
    XCTAssertEqual(result, [MarkRun(range: 0..<11, styles: [])])
  }

  func testApplyingIsNoOpForEmptyRange() {
    let result = MarkToggleEngine.applying(.bold, enable: true, over: 5..<5, to: boldHello)
    XCTAssertEqual(result, boldHello)
  }

  /// Nested/overlapping marks: bold "hello" plus italic over "llo wor"
  /// (overlapping, not nested-clean) must coexist as a style *set* per
  /// scalar, not clobber each other.
  func testOverlappingMarksCoexistAsStyleSets() {
    var runs = boldHello
    runs = MarkToggleEngine.applying(.italic, enable: true, over: 3..<10, to: runs)
    XCTAssertEqual(runs, [
      MarkRun(range: 0..<3, styles: [.bold]),
      MarkRun(range: 3..<5, styles: [.bold, .italic]),
      MarkRun(range: 5..<10, styles: [.italic]),
      MarkRun(range: 10..<11, styles: []),
    ])
    // Bold state over the overlap region is still fully "on" even though
    // italic is mixed there.
    XCTAssertEqual(MarkToggleEngine.state(of: .bold, in: 3..<5, runs: runs), .on)
    XCTAssertEqual(MarkToggleEngine.state(of: .italic, in: 0..<5, runs: runs), .mixed)
  }

  /// Toggling italic fully off inside the overlap must leave bold intact —
  /// this is the "nested marks toggle independently" requirement.
  func testTogglingOneStyleOffLeavesOthersIntact() {
    var runs = MarkToggleEngine.applying(.italic, enable: true, over: 3..<10, to: boldHello)
    runs = MarkToggleEngine.applying(.italic, enable: false, over: 3..<10, to: runs)
    XCTAssertEqual(runs, boldHello)
  }
}
