// TodayTasksGadgetTests.swift
// EnchiridionGadgetsTests
//
// Source-level sanity check on the proof-of-concept gadget: it must call
// the bridge's real `graphQuery` API with the real server-side view name
// (`nodesByTag` — `workers/gadget-host/src/graph-query-views.ts`), and it
// must not attempt any network API directly (that would be a gadget author
// mistake CSP/the shim already prevent at runtime — this test catches it
// at the source level too, cheaply).

import Foundation
import XCTest

@testable import EnchiridionGadgets

final class TodayTasksGadgetTests: XCTestCase {
  func testCallsGraphQueryWithTheRealNodesByTagView() {
    XCTAssertTrue(TodayTasksGadget.content.bodyHTML.contains("enchiridionGadget.graphQuery('nodesByTag'"))
    XCTAssertTrue(TodayTasksGadget.content.bodyHTML.contains("tagID: 'task'"))
  }

  func testDoesNotReferenceRawNetworkAPIsDirectly() {
    let html = TodayTasksGadget.content.bodyHTML
    XCTAssertFalse(html.contains("fetch("))
    XCTAssertFalse(html.contains("XMLHttpRequest"))
    XCTAssertFalse(html.contains("WebSocket"))
  }

  func testNameIsNonEmpty() {
    XCTAssertFalse(TodayTasksGadget.name.isEmpty)
  }
}
