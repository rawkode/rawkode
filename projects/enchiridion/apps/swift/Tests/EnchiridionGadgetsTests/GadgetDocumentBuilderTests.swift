// GadgetDocumentBuilderTests.swift
// EnchiridionGadgetsTests
//
// Locks the security-relevant contract of the document every gadget loads
// into: the CSP meta tag is always present and always denies `connect-src`
// (network access) and `default-src` (everything else, by fallback),
// regardless of what a gadget's own `bodyHTML` contains — this is the
// host-owned policy GadgetDocumentBuilder.swift's header describes as "no
// opt-out". Not a WebKit test (no WKWebView involved) — plain string
// assertions on the document `GadgetWebViewHost` would hand to
// `loadHTMLString`.

import Foundation
import XCTest

@testable import EnchiridionGadgets

final class GadgetDocumentBuilderTests: XCTestCase {
  func testDocumentAlwaysIncludesConnectSrcNoneAndDefaultSrcNone() {
    let document = GadgetDocumentBuilder.document(bodyHTML: "<p>hello</p>")
    XCTAssertTrue(document.contains("connect-src 'none'"), "CSP must deny network access from gadget JS")
    XCTAssertTrue(document.contains("default-src 'none'"), "CSP must deny everything not explicitly re-allowed")
    XCTAssertTrue(document.contains("Content-Security-Policy"))
  }

  func testDocumentEmbedsTheGivenBodyHTMLVerbatim() {
    let bodyHTML = "<ul id=\"tasks\"></ul><script>console.log('hi');</script>"
    let document = GadgetDocumentBuilder.document(bodyHTML: bodyHTML)
    XCTAssertTrue(document.contains(bodyHTML))
  }

  func testDocumentUsesNativeStyleCSSVariables() {
    let style = NativeGadgetStyle(
      textColorCSS: "#111111",
      secondaryTextColorCSS: "#666666",
      separatorColorCSS: "#dddddd",
      accentColorCSS: "#0a84ff",
      fontFamilyCSS: "-apple-system"
    )
    let document = GadgetDocumentBuilder.document(bodyHTML: "", nativeStyle: style)
    XCTAssertTrue(document.contains("--enchiridion-text-color: #111111"))
    XCTAssertTrue(document.contains("--enchiridion-secondary-text-color: #666666"))
    XCTAssertTrue(document.contains("--enchiridion-separator-color: #dddddd"))
    XCTAssertTrue(document.contains("--enchiridion-accent-color: #0a84ff"))
  }

  func testDocumentDefaultsToSystemDefaultStyleWhenUnspecified() {
    let document = GadgetDocumentBuilder.document(bodyHTML: "")
    XCTAssertTrue(document.contains(NativeGadgetStyle.systemDefault.textColorCSS))
  }

  func testDocumentDoesNotAllowRemoteImageOrScriptSources() {
    // img-src only lists `data:` — no `https:`/`http:` origin is ever
    // permitted, regardless of what a gadget's bodyHTML tries to
    // reference.
    let document = GadgetDocumentBuilder.document(bodyHTML: "<img src=\"https://evil.example/track.png\">")
    XCTAssertTrue(document.contains("img-src data:"))
    XCTAssertFalse(document.contains("img-src data: https:"))
  }
}
