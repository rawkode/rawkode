// GadgetWebViewHost.swift
// EnchiridionGadgets
//
// The SwiftUI-facing gadget card: native title-bar chrome (a plain title
// using system text styles — no custom-drawn chrome, per PRODUCT.md's
// "Decorative glass, generic card grids, heavy gradients, and custom
// controls that fight standard Apple interaction patterns" anti-reference)
// wrapping a `WKWebView` that renders exactly one gadget's `GadgetContent`.
//
// WHAT ACTUALLY ISOLATES THE WEBVIEW'S NETWORK ACCESS (task brief: "the
// WebView's own JS context must have NO other network access ... the
// bridge is the ONLY channel in or out") — three independent layers, all
// needed, documented here so the full boundary is visible from one place
// rather than scattered:
//   1. CSP (`GadgetDocumentBuilder`'s `connect-src 'none'`/`default-src
//      'none'`) — enforced by WebKit itself inside the page, blocks
//      fetch/XHR/WebSocket/EventSource/images-over-https/etc. from the
//      gadget's own script, regardless of what that script tries.
//   2. `WKNavigationDelegate` below — blocks the WebView's OWN frame from
//      navigating anywhere except the one `loadHTMLString` call this host
//      makes. CSP governs sub-resource loads; this governs full-page
//      navigation (a link click, `window.location = ...`, a form submit
//      that somehow survived `form-action 'none'`) — a different escape
//      class CSP alone doesn't close.
//   3. `configuration.websiteDataStore = .nonPersistent()` — an ephemeral,
//      in-memory-only data store, so even if something did leak through
//      (a bug in either layer above), there's no persistent cookie jar/
//      cache/local-storage surviving across gadget loads for it to
//      exfiltrate into or read back from later.
// `WKUIDelegate.createWebViewWith` returning `nil` closes the fourth
// classic escape (`window.open`/`target="_blank"` spawning a second,
// unmanaged WebView with none of the above applied).
//
// This file is genuinely unverified beyond compiling — no simulator/device
// run happened in this sandbox (task brief: "focus tests on the underlying
// logic ... clearly note ... what remains visually/interactively
// unverified"). See this task's report for the full list.

import Foundation
import SwiftUI

#if canImport(WebKit)
import WebKit

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// One gadget rendered as a native card: a plain title-bar header (system
/// `.headline` text, no icon/glyph invented for this task — a gadget
/// registry entry could add one later) over the sandboxed `WKWebView`.
/// Uses `.regularMaterial`/`.separator` — the same system-provided
/// materials/colors the rest of this app's chrome uses, not a bespoke
/// "card" look.
public struct GadgetWebViewHost: View {
  public let gadgetName: String
  public let content: GadgetContent
  public let bridge: GadgetBridge
  public let nativeStyle: NativeGadgetStyle

  public init(
    gadgetName: String,
    content: GadgetContent,
    bridge: GadgetBridge,
    nativeStyle: NativeGadgetStyle = .systemDefault
  ) {
    self.gadgetName = gadgetName
    self.content = content
    self.bridge = bridge
    self.nativeStyle = nativeStyle
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(gadgetName)
        .font(.headline)
        .foregroundStyle(.primary)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)

      Divider()

      GadgetWebViewRepresentable(content: content, bridge: bridge, nativeStyle: nativeStyle)
    }
    .background(.regularMaterial)
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .strokeBorder(Color(white: 0.5).opacity(0.25), lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
  }
}

#if os(macOS)
struct GadgetWebViewRepresentable: NSViewRepresentable {
  let content: GadgetContent
  let bridge: GadgetBridge
  let nativeStyle: NativeGadgetStyle

  func makeCoordinator() -> GadgetWebViewCoordinator {
    GadgetWebViewCoordinator(bridge: bridge)
  }

  func makeNSView(context: Context) -> WKWebView {
    let webView = context.coordinator.makeWebView()
    context.coordinator.load(content, nativeStyle: nativeStyle, into: webView)
    return webView
  }

  func updateNSView(_ webView: WKWebView, context: Context) {}
}
#else
struct GadgetWebViewRepresentable: UIViewRepresentable {
  let content: GadgetContent
  let bridge: GadgetBridge
  let nativeStyle: NativeGadgetStyle

  func makeCoordinator() -> GadgetWebViewCoordinator {
    GadgetWebViewCoordinator(bridge: bridge)
  }

  func makeUIView(context: Context) -> WKWebView {
    let webView = context.coordinator.makeWebView()
    context.coordinator.load(content, nativeStyle: nativeStyle, into: webView)
    return webView
  }

  func updateUIView(_ webView: WKWebView, context: Context) {}
}
#endif

/// Owns the `WKWebView`'s configuration, the message-handler lifecycle,
/// and the navigation/UI-delegate policy that closes the "own frame
/// navigates elsewhere" and "spawns a second WebView" escapes — see this
/// file's header for the full three(+one)-layer picture this is one part
/// of.
@MainActor
final class GadgetWebViewCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
  private let messageHandler: GadgetBridgeMessageHandler

  init(bridge: GadgetBridge) {
    self.messageHandler = GadgetBridgeMessageHandler(bridge: bridge)
    super.init()
  }

  func makeWebView() -> WKWebView {
    let userContentController = WKUserContentController()
    userContentController.add(messageHandler, name: GadgetBridgeMessageHandler.messageHandlerName)
    userContentController.addUserScript(
      WKUserScript(
        source: GadgetBridgeJavaScriptShim.source,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
      )
    )

    let configuration = WKWebViewConfiguration()
    configuration.userContentController = userContentController
    // Ephemeral store — see this file's header, layer 3.
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    #if os(macOS)
    webView.setValue(false, forKey: "drawsBackground")
    #else
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.scrollView.backgroundColor = .clear
    #endif
    messageHandler.attach(to: webView)
    return webView
  }

  func load(_ content: GadgetContent, nativeStyle: NativeGadgetStyle, into webView: WKWebView) {
    webView.loadHTMLString(
      GadgetDocumentBuilder.document(bodyHTML: content.bodyHTML, nativeStyle: nativeStyle),
      baseURL: nil
    )
  }

  // MARK: - WKNavigationDelegate (layer 2 — see this file's header)

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
  ) {
    // The ONLY navigation this coordinator ever allows is the initial
    // `loadHTMLString(_:baseURL: nil)` call above, which WebKit surfaces
    // as an `.other`-type navigation to `about:blank`. Anything else —
    // link clicks (`.linkActivated`), form submits (`.formSubmitted`),
    // reloads/back-forward, or a script-initiated `location` assignment
    // (also `.other`, but never to exactly `about:blank`) — is denied.
    if navigationAction.navigationType == .other, navigationAction.request.url?.absoluteString == "about:blank" {
      decisionHandler(.allow)
    } else {
      decisionHandler(.cancel)
    }
  }

  // MARK: - WKUIDelegate (the "+1" escape — window.open/target=_blank)

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    nil
  }
}
#endif
