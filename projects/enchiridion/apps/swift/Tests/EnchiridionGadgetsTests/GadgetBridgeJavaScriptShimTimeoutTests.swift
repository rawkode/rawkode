// GadgetBridgeJavaScriptShimTimeoutTests.swift
// EnchiridionGadgetsTests
//
// Exercises the actual injected JS from GadgetBridgeJavaScriptShim.swift
// (not just the Swift string constant's contents) via JavaScriptCore, the
// same JS engine WebKit itself is built on. `setTimeout`/`clearTimeout`
// are stubbed with a Swift-side implementation that records scheduled
// callbacks instead of really waiting, so the test can fire (or withhold)
// the timeout deterministically — no real wall-clock sleeping, no
// flakiness from CI being slow.
//
// This is the fix-2 regression test: without the client-side timeout, a
// request whose response never arrives (e.g. because
// `GadgetBridgeMessageHandler.deliver(_:)` silently dropped it) leaves the
// gadget's `Promise` hanging forever — these tests prove `request()`'s
// `Promise` rejects on its own once the (stubbed, manually-fired) timeout
// elapses, and that a normal in-time response is unaffected by the
// timeout machinery being present at all.

import Foundation
import XCTest

@testable import EnchiridionGadgets

#if canImport(JavaScriptCore)
import JavaScriptCore

final class GadgetBridgeJavaScriptShimTimeoutTests: XCTestCase {
  /// One scheduled `setTimeout` callback, captured by the test's stub
  /// implementation instead of a real timer.
  private final class ScheduledTimeout {
    let id: Int
    let callback: JSValue
    let delayMilliseconds: Double
    var cleared = false

    init(id: Int, callback: JSValue, delayMilliseconds: Double) {
      self.id = id
      self.callback = callback
      self.delayMilliseconds = delayMilliseconds
    }
  }

  /// Reference-type box so the `setTimeout`/`clearTimeout` closures below
  /// (which must be `@convention(block)` and outlive `makeContext()`) can
  /// share mutable state with the test method that calls them.
  private final class TimeoutStore {
    var scheduled: [ScheduledTimeout] = []
  }

  /// Builds a fresh `JSContext` with the shim's `window`/`webkit`
  /// scaffolding and a controllable `setTimeout`/`clearTimeout` stub
  /// installed, then evaluates the real
  /// `GadgetBridgeJavaScriptShim.source`. Returns the context plus the
  /// store of scheduled timeouts the test can inspect/fire.
  private func makeContext() -> (context: JSContext, store: TimeoutStore) {
    let context = JSContext()!
    context.exceptionHandler = { _, exception in
      XCTFail("JS exception: \(exception?.toString() ?? "<nil>")")
    }

    let store = TimeoutStore()
    var nextID = 0

    let setTimeoutBlock: @convention(block) (JSValue, JSValue) -> Int = { callback, delay in
      nextID += 1
      store.scheduled.append(ScheduledTimeout(id: nextID, callback: callback, delayMilliseconds: delay.toDouble()))
      return nextID
    }
    context.setObject(setTimeoutBlock, forKeyedSubscript: "setTimeout" as NSString)

    let clearTimeoutBlock: @convention(block) (Int) -> Void = { id in
      if let match = store.scheduled.first(where: { $0.id == id }) {
        match.cleared = true
      }
    }
    context.setObject(clearTimeoutBlock, forKeyedSubscript: "clearTimeout" as NSString)

    // Minimal `window.webkit.messageHandlers.<name>.postMessage` stub — a
    // no-op that never calls back into `__resolve`, matching the "response
    // silently dropped" scenario this fix defends against. Real
    // request/response shape correctness is already covered by
    // GadgetBridgeRequestParsingTests.swift / GadgetBridgeResponseEncodingTests.swift;
    // this file only needs postMessage to not throw and to record what it
    // was sent so a test can address a `__resolve` call back at the right
    // request id.
    context.evaluateScript(
      """
      var window = this;
      var __postMessageCalls = [];
      window.webkit = {
        messageHandlers: {
          '\(GadgetBridgeJavaScriptShim.messageHandlerName)': {
            postMessage: function (message) { __postMessageCalls.push(message); }
          }
        }
      };
      """)

    context.evaluateScript(GadgetBridgeJavaScriptShim.source)

    return (context, store)
  }

  private func fireAllUnclearedTimeouts(_ store: TimeoutStore) {
    for entry in store.scheduled where !entry.cleared {
      entry.callback.call(withArguments: [])
    }
  }

  func testRequestRejectsOnceTheStubbedTimeoutFires() {
    let (context, store) = makeContext()

    context.evaluateScript(
      """
      var settled = null;
      var errorMessage = null;
      window.enchiridionGadget.graphQuery('nodesByTag', {}).then(
        function (value) { settled = 'resolved'; },
        function (err) { settled = 'rejected'; errorMessage = err.message; }
      );
      """)

    // No response ever arrives — simulate the timeout elapsing by firing
    // the one scheduled callback ourselves (the stub never runs on a real
    // timer).
    XCTAssertEqual(store.scheduled.count, 1, "request() should have scheduled exactly one timeout")
    fireAllUnclearedTimeouts(store)

    // Force a microtask checkpoint so the .then callbacks above have run.
    context.evaluateScript(";")

    let settled = context.evaluateScript("settled")?.toString()
    let errorMessage = context.evaluateScript("errorMessage")?.toString()
    XCTAssertEqual(settled, "rejected", "the promise must reject once the timeout fires with no response")
    XCTAssertTrue(
      errorMessage?.contains("timed out") ?? false,
      "rejection error should mention the timeout, got \(errorMessage ?? "<nil>")"
    )
  }

  func testRequestScheduledTimeoutUsesTheDocumentedDuration() {
    let (context, store) = makeContext()
    context.evaluateScript("window.enchiridionGadget.graphQuery('nodesByTag', {});")

    guard let entry = store.scheduled.first else {
      return XCTFail("expected exactly one scheduled timeout")
    }
    XCTAssertEqual(entry.delayMilliseconds, Double(GadgetBridgeJavaScriptShim.requestTimeoutMilliseconds))
  }

  func testRequestResolvesNormallyAndTimeoutFiringAfterwardIsHarmless() {
    let (context, store) = makeContext()

    context.evaluateScript(
      """
      var settled = null;
      var resolvedValue = null;
      window.enchiridionGadget.graphQuery('nodesByTag', {}).then(
        function (value) { settled = 'resolved'; resolvedValue = value; },
        function (err) { settled = 'rejected'; }
      );
      """)

    // Deliver a real response the way GadgetBridgeMessageHandler would,
    // before the timeout ever fires — recover the id postMessage actually
    // sent so __resolve can target it.
    let requestID = context.evaluateScript("__postMessageCalls[0].id")?.toString()
    XCTAssertNotNil(requestID)
    context.evaluateScript(
      "window.enchiridionGadget.__resolve({ id: '\(requestID ?? "")', ok: true, result: 'ok-value' });"
    )
    context.evaluateScript(";")

    XCTAssertEqual(context.evaluateScript("settled")?.toString(), "resolved")
    XCTAssertEqual(context.evaluateScript("resolvedValue")?.toString(), "ok-value")

    // The resolve path must have cleared the timeout — firing it now
    // should be a harmless no-op (pending[id] already deleted), not a
    // second, contradictory rejection.
    fireAllUnclearedTimeouts(store)
    context.evaluateScript(";")
    XCTAssertEqual(
      context.evaluateScript("settled")?.toString(), "resolved",
      "a late timeout fire must not flip an already-resolved promise")
  }
}
#endif
