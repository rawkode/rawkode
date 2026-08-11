// ShareCaptureBody.swift
// EnchiridionShareKit
//
// Pure, no-I/O derivation of a captured page's title/body text from a
// `ShareCaptureInput` — split out from `ShareCapture.swift` specifically so
// it's trivially unit-testable without a `LocalGraphStore` at all, and so
// the per-platform extension UIs (`Sources/iOSShareExtension`,
// `Sources/macOSShareExtension`) can reuse it to render a live preview of
// what will be captured before the user confirms — no second copy of this
// logic in either UI shell.
//
// DELIBERATELY NOT SUPERTAG-AWARE: this produces a plain title + body
// string for a `.free` page, never a supertag/field guess (e.g. no
// "this looks like a URL, so tag it `bookmark`" heuristic) — matching
// PRODUCT.md's "literal capture first, interpretation later" and this
// package's existing precedent (`PageDocument.swift`'s header: "bookmark
// capture events ... deliberately out of scope for this port").

import Foundation

public enum ShareCaptureBody {
  /// Character (`String.count`, i.e. grapheme-cluster) cap on a derived
  /// title before it's truncated with a trailing "…". Generous enough to
  /// keep most single-sentence shares
  /// intact while bounding what could otherwise be an entire shared
  /// article's first "line" (some apps share a whole paragraph as one
  /// line with no newlines).
  public static let maximumTitleLength = 120

  /// Shown when there is truly nothing to title a page with — reachable
  /// only from a direct call to this function with an input that
  /// `ShareCapture.capture(_:into:...)` itself would already have rejected
  /// via `ShareCaptureInput.isEmpty` (see that type). Kept here anyway so
  /// this function is total or every input, including ones a preview UI
  /// might transiently show before the user has typed/pasted anything.
  public static let defaultTitle = "Shared Page"

  /// Priority: an explicit `pageTitle` (most trustworthy — it came from
  /// the source app, not a guess) > the first line of shared `text`,
  /// truncated > the shared `url` itself > `defaultTitle`.
  public static func title(for input: ShareCaptureInput) -> String {
    if let pageTitle = trimmedNonEmpty(input.pageTitle) {
      return pageTitle
    }
    if let text = trimmedNonEmpty(input.text) {
      let firstLine = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
      return truncated(firstLine, maximumLength: maximumTitleLength)
    }
    if let url = input.url {
      return url.absoluteString
    }
    return defaultTitle
  }

  /// The literal captured content. Text and URL are both kept (not one
  /// dropped in favor of the other) when both are present — e.g. sharing a
  /// text selection alongside the page it came from — separated by a
  /// blank line so the URL reads as a distinct trailing reference, not
  /// run into the prose.
  public static func body(for input: ShareCaptureInput) -> String {
    let text = trimmedNonEmpty(input.text)
    switch (text, input.url) {
    case (let text?, let url?):
      return "\(text)\n\n\(url.absoluteString)"
    case (let text?, nil):
      return text
    case (nil, let url?):
      return url.absoluteString
    case (nil, nil):
      return ""
    }
  }

  private static func trimmedNonEmpty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty
    else { return nil }
    return trimmed
  }

  private static func truncated(_ value: String, maximumLength: Int) -> String {
    guard value.count > maximumLength else { return value }
    return "\(value.prefix(maximumLength))…"
  }
}
