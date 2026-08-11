// GadgetBridgeResponseEncodingTests.swift
// EnchiridionGadgetsTests
//
// `GadgetBridgeJavaScriptShim.injectionScript(for:)` is the other half of
// the wire format — the response gets embedded as a JSON literal inside a
// JS statement string that's handed to `evaluateJavaScript`. If an `id` or
// error `message` contains a quote/backslash/newline and it isn't escaped
// correctly, the injected script is syntactically broken JS (at best) or a
// script-injection bug (at worst, if a gadget could ever influence a
// response `id` — it can't today, but the encoding needs to be correct
// regardless of that). These tests extract the embedded JSON and re-parse
// it with `JSONSerialization`, proving the injected literal is valid JSON
// with the exact field values intended.

import Foundation
import XCTest

@testable import EnchiridionGadgets

final class GadgetBridgeResponseEncodingTests: XCTestCase {
  /// Pulls the JSON argument out of
  /// `"window.enchiridionGadget && window.enchiridionGadget.__resolve(<json>);"`.
  private func extractJSONObject(from script: String) throws -> [String: Any] {
    let prefix = "window.enchiridionGadget && window.enchiridionGadget.__resolve("
    let suffix = ");"
    XCTAssertTrue(script.hasPrefix(prefix), "unexpected script shape: \(script)")
    XCTAssertTrue(script.hasSuffix(suffix), "unexpected script shape: \(script)")
    let jsonText = String(script.dropFirst(prefix.count).dropLast(suffix.count))
    let object = try JSONSerialization.jsonObject(with: Data(jsonText.utf8), options: [])
    guard let dictionary = object as? [String: Any] else {
      throw XCTSkip("expected a JSON object")
    }
    return dictionary
  }

  func testSuccessResponseEncodesOkTrueAndResult() throws {
    let response = GadgetBridgeResponse(
      id: "req-1",
      outcome: .success(.object(["nodes": .array([.string("task_1")])]))
    )
    let script = try GadgetBridgeJavaScriptShim.injectionScript(for: response)
    let decoded = try extractJSONObject(from: script)

    XCTAssertEqual(decoded["id"] as? String, "req-1")
    XCTAssertEqual(decoded["ok"] as? Bool, true)
    let result = decoded["result"] as? [String: Any]
    XCTAssertEqual((result?["nodes"] as? [String])?.first, "task_1")
  }

  func testFailureResponseEncodesOkFalseAndError() throws {
    let response = GadgetBridgeResponse(
      id: "req-2",
      outcome: .failure(code: "capability_denied", message: "view \"x\" is not in this grant's allowlist")
    )
    let script = try GadgetBridgeJavaScriptShim.injectionScript(for: response)
    let decoded = try extractJSONObject(from: script)

    XCTAssertEqual(decoded["id"] as? String, "req-2")
    XCTAssertEqual(decoded["ok"] as? Bool, false)
    let error = decoded["error"] as? [String: Any]
    XCTAssertEqual(error?["code"] as? String, "capability_denied")
    XCTAssertEqual(error?["message"] as? String, "view \"x\" is not in this grant's allowlist")
  }

  func testEncodingEscapesQuotesBackslashesAndNewlinesInMessage() throws {
    let trickyMessage = "line one\nline \"two\" with \\backslash\\ and 🎉 emoji"
    let response = GadgetBridgeResponse(
      id: "req-\"3\"",
      outcome: .failure(code: "transport_error", message: trickyMessage)
    )
    let script = try GadgetBridgeJavaScriptShim.injectionScript(for: response)
    // The whole point: this must still be extractable/parseable as valid
    // JSON despite the adversarial content.
    let decoded = try extractJSONObject(from: script)
    XCTAssertEqual(decoded["id"] as? String, "req-\"3\"")
    let error = decoded["error"] as? [String: Any]
    XCTAssertEqual(error?["message"] as? String, trickyMessage)
  }

  @MainActor
  func testMessageHandlerNameMatchesBetweenShimAndHandlerConstant() {
    // GadgetBridgeMessageHandler.messageHandlerName is only defined under
    // `#if canImport(WebKit)` (it references WKScriptMessageHandler) — this
    // sandbox builds on macOS where WebKit is available, so this assertion
    // does exercise the real constant, not a stand-in. Kept as a named,
    // explicit test rather than relying on the two literals never drifting
    // by accident. `@MainActor` on the test method itself because
    // `GadgetBridgeMessageHandler` (and its `messageHandlerName`) is
    // `@MainActor`-isolated — see that type's header for why.
    #if canImport(WebKit)
    XCTAssertEqual(GadgetBridgeMessageHandler.messageHandlerName, GadgetBridgeJavaScriptShim.messageHandlerName)
    #endif
    XCTAssertEqual(GadgetBridgeJavaScriptShim.messageHandlerName, "enchiridionGadgetBridge")
  }
}
