// GadgetBridgeRequestParsingTests.swift
// EnchiridionGadgetsTests
//
// `GadgetBridgeRequest.parse(messageBody:)` is the boundary between
// untrusted gadget JS and everything else — it must NEVER trap, and every
// malformed shape must produce a specific, testable
// `GadgetBridgeMalformedRequest` (task brief: "malformed/unexpected
// message shapes from the WebView are rejected safely, not crashing the
// bridge").

import Foundation
import XCTest

@testable import EnchiridionGadgets

final class GadgetBridgeRequestParsingTests: XCTestCase {
  func testParsesWellFormedGraphQueryRequest() {
    let body: [String: Any] = [
      "id": "req-1",
      "type": "graph.query",
      "view": "nodesByTag",
      "params": ["tagID": "task"],
    ]
    switch GadgetBridgeRequest.parse(messageBody: body) {
    case .success(let request):
      XCTAssertEqual(request.id, "req-1")
      XCTAssertEqual(request.capabilityType, .graphQuery)
      XCTAssertEqual(request.view, "nodesByTag")
      XCTAssertEqual(request.params, .object(["tagID": .string("task")]))
    case .failure(let malformed):
      XCTFail("expected success, got \(malformed)")
    }
  }

  func testParsesRequestWithNoParamsAndNoView() {
    let body: [String: Any] = [
      "id": "req-2",
      "type": "gatekeeper.google.calendar.read",
    ]
    switch GadgetBridgeRequest.parse(messageBody: body) {
    case .success(let request):
      XCTAssertEqual(request.capabilityType, .gatekeeperGoogleCalendarRead)
      XCTAssertNil(request.view)
      XCTAssertNil(request.params)
    case .failure(let malformed):
      XCTFail("expected success, got \(malformed)")
    }
  }

  // MARK: - Malformed shapes — must fail safely, not crash

  func testRejectsNonDictionaryBody() {
    for body: Any in ["just a string", 42, NSNull(), ["array", "not", "object"]] {
      switch GadgetBridgeRequest.parse(messageBody: body) {
      case .success:
        XCTFail("expected failure for non-dictionary body: \(body)")
      case .failure(let malformed):
        XCTAssertEqual(malformed.error, .notAnObject)
        XCTAssertNil(malformed.id, "no id is recoverable from a non-object body")
      }
    }
  }

  func testRejectsMissingID() {
    let body: [String: Any] = ["type": "graph.query", "view": "nodesByTag"]
    switch GadgetBridgeRequest.parse(messageBody: body) {
    case .success:
      XCTFail("expected failure")
    case .failure(let malformed):
      XCTAssertEqual(malformed.error, .missingID)
      XCTAssertNil(malformed.id)
    }
  }

  func testRejectsEmptyStringID() {
    let body: [String: Any] = ["id": "", "type": "graph.query"]
    switch GadgetBridgeRequest.parse(messageBody: body) {
    case .success:
      XCTFail("expected failure")
    case .failure(let malformed):
      XCTAssertEqual(malformed.error, .missingID)
    }
  }

  func testRejectsMissingTypeButPreservesID() {
    let body: [String: Any] = ["id": "req-3"]
    switch GadgetBridgeRequest.parse(messageBody: body) {
    case .success:
      XCTFail("expected failure")
    case .failure(let malformed):
      XCTAssertEqual(malformed.error, .missingType)
      // The id IS recoverable here, unlike the missing-id case — this is
      // what lets GadgetBridgeMessageHandler still deliver a keyed error
      // response instead of dropping it.
      XCTAssertEqual(malformed.id, "req-3")
    }
  }

  func testRejectsUnknownTypeButPreservesID() {
    let body: [String: Any] = ["id": "req-4", "type": "graph.deleteEverything"]
    switch GadgetBridgeRequest.parse(messageBody: body) {
    case .success:
      XCTFail("expected failure")
    case .failure(let malformed):
      XCTAssertEqual(malformed.error, .unknownType("graph.deleteEverything"))
      XCTAssertEqual(malformed.id, "req-4")
    }
  }

  func testRejectsInvalidParamsButPreservesID() {
    struct NotJSON {}
    let body: [String: Any] = ["id": "req-5", "type": "graph.query", "params": NotJSON()]
    switch GadgetBridgeRequest.parse(messageBody: body) {
    case .success:
      XCTFail("expected failure")
    case .failure(let malformed):
      XCTAssertEqual(malformed.error, .invalidParams)
      XCTAssertEqual(malformed.id, "req-5")
    }
  }

  func testRejectsNonStringTypeField() {
    let body: [String: Any] = ["id": "req-6", "type": 12345]
    switch GadgetBridgeRequest.parse(messageBody: body) {
    case .success:
      XCTFail("expected failure")
    case .failure(let malformed):
      XCTAssertEqual(malformed.error, .missingType)
      XCTAssertEqual(malformed.id, "req-6")
    }
  }

  func testRejectsNonStringIDField() {
    let body: [String: Any] = ["id": 12345, "type": "graph.query"]
    switch GadgetBridgeRequest.parse(messageBody: body) {
    case .success:
      XCTFail("expected failure")
    case .failure(let malformed):
      XCTAssertEqual(malformed.error, .missingID)
    }
  }
}
