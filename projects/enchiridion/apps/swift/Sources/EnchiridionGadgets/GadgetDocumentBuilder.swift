// GadgetDocumentBuilder.swift
// EnchiridionGadgets
//
// Wraps a gadget's own `bodyHTML` fragment into a complete HTML document
// carrying the ONE piece of policy that actually enforces "the WebView's
// own JS context must have NO other network access" (task brief): a
// Content-Security-Policy meta tag with `connect-src 'none'`. This is
// deliberately assembled by the HOST (this type), not left for each
// gadget's own HTML to include — a gadget author forgetting/omitting a CSP
// meta tag in their own markup must never be the thing standing between
// untrusted gadget JS and the network; the host owns the policy
// unconditionally, for every gadget, with no opt-out.
//
// `default-src 'none'` denies every resource type not explicitly
// re-allowed below (images, fonts, media, frames, workers, ...) —
// `connect-src 'none'` alone would still leave `default-src`'s fallback
// permissive if `default-src` weren't also locked down; `img-src data:`
// is the one deliberate carve-out (a gadget rendering an inline `data:`
// image, e.g. a small icon, needs no network fetch to do so — a real
// `https://` image URL is still denied by `img-src` not listing `https:`).
// `frame-src 'none'`/`object-src 'none'`/`base-uri 'none'`/
// `form-action 'none'` close the other classic "technically not
// XHR/fetch, still reaches the network or navigates the page" escapes
// (an `<iframe src="https://...">`, a `<base href>` retargeting relative
// URLs, a `<form action="https://...">` submit). `script-src 'unsafe-
// inline'` is required because gadget script is inline `<script>` content
// with no per-gadget nonce infrastructure (task brief: "plain HTML/JS
// ...  keep it minimal") — this does NOT re-open network access on its
// own; `connect-src`/`default-src` still deny it regardless of where the
// script came from.
//
// SECOND LAYER, NOT THE ONLY ONE: `GadgetWebViewHost`'s
// `WKNavigationDelegate` (GadgetWebViewHost.swift) independently blocks
// any navigation away from the initial `loadHTMLString` load (link
// clicks, `window.location` assignment, form submits that survive CSP for
// any reason) — CSP governs sub-resource loads from the page's own
// scripts; the navigation delegate governs the WebView's frame navigating
// somewhere else entirely. Both are needed; neither alone closes every
// path out.

import Foundation

/// A gadget's own UI content — deliberately just an HTML fragment
/// (`bodyHTML`), not a full document: `GadgetWebViewHost` always builds
/// the enclosing `<head>`/CSP/native-style wrapper itself (this file), so
/// a gadget can never omit or weaken it by writing its own `<head>`.
public struct GadgetContent: Sendable, Equatable {
  public let bodyHTML: String

  public init(bodyHTML: String) {
    self.bodyHTML = bodyHTML
  }
}

public enum GadgetDocumentBuilder {
  /// See this file's header for what each CSP directive below closes.
  static let contentSecurityPolicy =
    "default-src 'none'; "
    + "script-src 'unsafe-inline'; "
    + "style-src 'unsafe-inline'; "
    + "img-src data:; "
    + "connect-src 'none'; "
    + "frame-src 'none'; "
    + "object-src 'none'; "
    + "base-uri 'none'; "
    + "form-action 'none'"

  /// Builds the complete document `GadgetWebViewHost` loads via
  /// `WKWebView.loadHTMLString(_:baseURL:)`. `baseURL: nil` at the load
  /// site (not here — see GadgetWebViewHost.swift) means the document has
  /// no origin to resolve a relative `https://`/`file://` request against
  /// even if CSP somehow didn't block it first — belt and suspenders, not
  /// the primary mechanism.
  ///
  /// The injected `:root` CSS custom properties (`--enchiridion-*`) are
  /// the "injected system CSS vars so gadget UI matches native look"
  /// this module's README describes — `nativeStyle` supplies the actual
  /// color/font values from the app's current appearance;
  /// `NativeGadgetStyle.systemDefault` is a reasonable fallback for a
  /// caller that hasn't wired real system-color introspection yet.
  public static func document(bodyHTML: String, nativeStyle: NativeGadgetStyle = .systemDefault) -> String {
    """
    <!doctype html>
    <html>
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="\(contentSecurityPolicy)">
    <style>
      :root {
        color-scheme: light dark;
        --enchiridion-text-color: \(nativeStyle.textColorCSS);
        --enchiridion-secondary-text-color: \(nativeStyle.secondaryTextColorCSS);
        --enchiridion-separator-color: \(nativeStyle.separatorColorCSS);
        --enchiridion-accent-color: \(nativeStyle.accentColorCSS);
        --enchiridion-font: \(nativeStyle.fontFamilyCSS);
      }
      html, body {
        margin: 0;
        padding: 0;
        background: transparent;
      }
      body {
        padding: 12px;
        font-family: var(--enchiridion-font);
        color: var(--enchiridion-text-color);
      }
    </style>
    </head>
    <body>
    \(bodyHTML)
    </body>
    </html>
    """
  }
}

/// The native color/font values `GadgetDocumentBuilder` injects as CSS
/// custom properties — see that type's doc comment. Plain CSS-color-string
/// fields (not `UIColor`/`NSColor`) so this module stays platform-neutral
/// at the type-checking level; a future `GadgetWebViewHost` call site can
/// derive `.systemDefault`'s replacement from `UIColor.label`/
/// `NSColor.labelColor` (etc.) resolved against the current trait
/// collection/appearance and hand the resulting CSS strings in here,
/// without this type needing `#if os(...)` branches of its own.
public struct NativeGadgetStyle: Sendable, Equatable {
  public let textColorCSS: String
  public let secondaryTextColorCSS: String
  public let separatorColorCSS: String
  public let accentColorCSS: String
  public let fontFamilyCSS: String

  public init(
    textColorCSS: String,
    secondaryTextColorCSS: String,
    separatorColorCSS: String,
    accentColorCSS: String,
    fontFamilyCSS: String
  ) {
    self.textColorCSS = textColorCSS
    self.secondaryTextColorCSS = secondaryTextColorCSS
    self.separatorColorCSS = separatorColorCSS
    self.accentColorCSS = accentColorCSS
    self.fontFamilyCSS = fontFamilyCSS
  }

  /// CSS system keywords (`CanvasText`, `GrayText`, `AccentColor`, ...)
  /// and `-apple-system` — these already track light/dark and the user's
  /// accent-color preference without any native-color lookup at all,
  /// which is why this is a reasonable default rather than a placeholder
  /// that visibly looks wrong: it reads correctly today, real
  /// `UIColor`/`NSColor` resolution is only needed for values CSS has no
  /// system keyword for.
  public static let systemDefault = NativeGadgetStyle(
    textColorCSS: "CanvasText",
    secondaryTextColorCSS: "GrayText",
    separatorColorCSS: "color-mix(in srgb, CanvasText 20%, transparent)",
    accentColorCSS: "AccentColor",
    fontFamilyCSS: "-apple-system, system-ui, sans-serif"
  )
}
