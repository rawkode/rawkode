// GadgetBridgeMessageHandler.swift
// EnchiridionGadgets
//
// The `WKScriptMessageHandler` conformance — the actual WebKit-facing edge
// of the bridge. Deliberately thin: everything with real logic (parsing,
// authorization, dispatch) lives in `GadgetBridgeRequest.parse(messageBody:)`
// and `GadgetBridge.handle(request:)`, both plain Swift with no WebKit
// dependency, so they're directly unit-testable
// (GadgetBridgeTests.swift) without a WKWebView/simulator. This class's own
// job is only: receive `WKScriptMessage`, hand its `.body` to the parser,
// hand the parsed request to the bridge, inject the response back. That
// three-step glue is NOT covered by this task's test suite — `WKScriptMessage`
// has no public initializer, so it cannot be constructed in a plain
// `swift test` run; see this task's report for what that leaves
// unverified.
//
// `@MainActor`: `WKScriptMessageHandler.userContentController(_:didReceive:)`
// is always called on the main thread by WebKit (documented WebKit
// behavior), and `evaluateJavaScript` must be called from the main thread —
// isolating this whole type to `@MainActor` matches that and lets
// `deliver(_:)` call `evaluateJavaScript` directly without a further hop.

import Foundation

#if canImport(WebKit)
import WebKit

@MainActor
public final class GadgetBridgeMessageHandler: NSObject, WKScriptMessageHandler {
  /// Matches `GadgetBridgeJavaScriptShim.messageHandlerName` — both sides
  /// reference this one constant so the registered handler name
  /// (`WKUserContentController.add(_:name:)`, set up by
  /// `GadgetWebViewHost`) and the name the injected JS shim posts to can
  /// never drift apart.
  public static let messageHandlerName = GadgetBridgeJavaScriptShim.messageHandlerName

  private let bridge: GadgetBridge
  private weak var webView: WKWebView?

  public init(bridge: GadgetBridge) {
    self.bridge = bridge
  }

  /// Set once, right after the `WKWebView` this handler is registered on
  /// is created (`GadgetWebViewHost`'s coordinator) — `weak` so this
  /// handler never keeps the WebView alive; `WKUserContentController`
  /// already owns this handler strongly (via `add(_:name:)`), and the
  /// WebView owns the content controller, so the strong-reference
  /// direction only ever runs WebView -> controller -> handler, never
  /// back.
  public func attach(to webView: WKWebView) {
    self.webView = webView
  }

  public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == Self.messageHandlerName else { return }
    let body = message.body

    Task { @MainActor [bridge] in
      switch GadgetBridgeRequest.parse(messageBody: body) {
      case .success(let request):
        let response = await bridge.handle(request: request)
        deliver(response)
      case .failure(let malformed):
        // No recoverable `id` means there is no `Promise` on the JS side
        // to correlate a response with — dropped, not delivered, matching
        // this file's header ("malformed/unexpected message shapes ... are
        // rejected safely, not crashing the bridge"): "rejected safely"
        // here means "does not crash and does not deliver a response with
        // a fabricated id", not "always manages to reject the caller's
        // promise" (there may be no promise to reject).
        guard let id = malformed.id else { return }
        deliver(
          GadgetBridgeResponse(
            id: id,
            outcome: .failure(code: "invalid_request", message: "\(malformed.error)")
          )
        )
      }
    }
  }

  private func deliver(_ response: GadgetBridgeResponse) {
    guard let webView else { return }
    guard let script = try? GadgetBridgeJavaScriptShim.injectionScript(for: response) else { return }
    webView.evaluateJavaScript(script)
  }
}
#endif
