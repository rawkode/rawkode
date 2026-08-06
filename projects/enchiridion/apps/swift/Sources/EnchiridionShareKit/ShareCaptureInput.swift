// ShareCaptureInput.swift
// EnchiridionShareKit
//
// P6 "Share extensions" task (plan §Platform parity: "capture from other
// apps into a new page ... writes go through the same local-write path
// P1's page editor already uses"). See this target's README.md for the
// full task rationale, and `ShareCapture.swift` for what actually
// consumes this type.
//
// `ShareCaptureInput` is the untyped, literal-capture payload a share
// sheet hands over — deliberately just `text`/`url`/`pageTitle`, matching
// PRODUCT.md's "literal capture first, interpretation later" principle
// this whole rebuild already honors (see the plan's "Swift learns the
// schema at runtime" section: "untyped pages always work"). No image/blob
// field here — see this target's README.md "Explicit non-goals" for why
// image sharing is out of scope for this task, not silently dropped.

import Foundation

/// What was shared, before any title/body derivation. Constructed two ways
/// in production: `ShareExtensionContextParsing.input(from:)` (parses the
/// host app's real `NSItemProvider`s) or directly, in tests.
public struct ShareCaptureInput: Equatable, Sendable {
  /// Plain text the source app shared — a text selection, a note, or (for
  /// `SLComposeServiceViewController`-style flows this codebase doesn't
  /// use, see the per-platform extension UIs) user-typed commentary.
  public var text: String?
  /// A shared URL (`public.url` / `UTType.url`) — e.g. Safari's "Share…"
  /// on a web page.
  public var url: URL?
  /// An explicit title supplied by the host app or the extension's own UI
  /// (e.g. a web page's `<title>`, when the share sheet provides one)
  /// distinct from anything `ShareCaptureBody.title(for:)` would have to
  /// derive from `text`/`url` alone. Takes priority when present and
  /// non-empty — see `ShareCaptureBody.title(for:)`.
  public var pageTitle: String?

  public init(text: String? = nil, url: URL? = nil, pageTitle: String? = nil) {
    self.text = text
    self.url = url
    self.pageTitle = pageTitle
  }

  /// `true` when there is nothing here worth turning into a page —
  /// `ShareCapture.capture(_:into:...)` rejects this case outright (see
  /// `ShareCaptureError.emptyContent`) rather than writing a blank page. A
  /// non-empty `pageTitle` alone does NOT count as content: it is metadata
  /// about a share, not the shared thing itself.
  public var isEmpty: Bool {
    let trimmedText = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmedText.isEmpty && url == nil
  }
}

/// Failure modes specific to the capture step itself — parsing/store
/// failures surface as whatever `PageDocument`/`LocalGraphStore` already
/// throw; this only adds what's genuinely new here.
public enum ShareCaptureError: Error, LocalizedError, Equatable, Sendable {
  case emptyContent

  public var errorDescription: String? {
    switch self {
    case .emptyContent:
      "There’s nothing to capture — no text or link was shared."
    }
  }
}
