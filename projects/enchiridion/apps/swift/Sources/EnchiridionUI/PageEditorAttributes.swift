// PageEditorAttributes.swift
// EnchiridionUI
//
// The `AttributedString` bridge for `PageEditorBody` (PageEditorBody.swift)
// — used only by the SwiftUI `TextEditor(text:selection:)` binding in
// PageEditorView.swift. Kept in its own file, isolated from the pure model,
// because `AttributedString`'s custom-scope machinery is Foundation/SwiftUI
// display plumbing, not editor logic: `PageEditorBody`, `MarkToggleEngine`,
// and `PageEditorController` never import or construct an `AttributedString`
// themselves, so all of that stays testable without a UI runtime.
//
// A custom `AttributeScope` is used instead of standard Markdown-ish
// attributes (`InlinePresentationIntent`) because the task requires the
// toolbar to match `LoroEngine.MarkStyle`'s vocabulary exactly — bold,
// italic, underline, strikethrough, code — and `InlinePresentationIntent`
// has no underline case (Markdown doesn't have underline). `markStyle`
// below is the semantic source of truth (what a run's `PageDocument.mark`
// call site would spell out); ordinary SwiftUI display attributes
// (`inlinePresentationIntent`, `underlineStyle`, `strikethroughStyle`) are
// derived from it purely for rendering.
import EnchiridionCore
import EnchiridionSync
import Foundation
import SwiftUI

public struct PageEditorMarkStylesAttribute: AttributedStringKey {
  public typealias Value = Set<LoroEngine.MarkStyle>
  public static let name = "dev.rawkode.enchiridion.markStyle"
}

public struct PageEditorReferenceAttribute: AttributedStringKey {
  public typealias Value = PageReferenceDestination
  public static let name = "dev.rawkode.enchiridion.pageReference"
}

/// Task #85 (P7 integration wave) addition — the semantic counterpart of
/// `PageEditorReferenceAttribute` for `AttachmentRun` (PageEditorBody.swift).
/// Carries the same fields `AttachmentRun` does; kept as its own small
/// `Hashable` value (not `AttachmentRun` itself) purely to avoid coupling
/// this file's `AttributedString` bridge to `PageEditorBody`'s stored-run
/// shape — the two are free to evolve independently, matching
/// `PageEditorReferenceAttribute`'s existing precedent of wrapping
/// `PageReferenceDestination` rather than `ReferenceRun`.
public struct PageEditorAttachmentInfo: Hashable, Sendable {
  public var kind: String
  public var blobID: String
  public var width: Double?
  public var height: Double?
  public var mimeType: String?

  public init(kind: String, blobID: String, width: Double? = nil, height: Double? = nil, mimeType: String? = nil) {
    self.kind = kind
    self.blobID = blobID
    self.width = width
    self.height = height
    self.mimeType = mimeType
  }
}

public struct PageEditorAttachmentAttribute: AttributedStringKey {
  public typealias Value = PageEditorAttachmentInfo
  public static let name = "dev.rawkode.enchiridion.attachment"
}

public struct PageEditorAttributeScope: AttributeScope {
  public let markStyle: PageEditorMarkStylesAttribute
  public let pageReference: PageEditorReferenceAttribute
  public let attachment: PageEditorAttachmentAttribute
  public let foundation: AttributeScopes.FoundationAttributes
  public let swiftUI: AttributeScopes.SwiftUIAttributes
}

extension AttributeDynamicLookup {
  public subscript<T: AttributedStringKey>(dynamicMember keyPath: KeyPath<PageEditorAttributeScope, T>) -> T {
    self[T.self]
  }
}

// MARK: - AttributedString.Index <-> Unicode Scalar offset

extension AttributedString {
  var plainTextRepresentation: String { String(characters) }

  /// The Unicode Scalar offset (UnicodeScalarOffsets.swift) of `index`,
  /// measured against this attributed string's plain-text representation —
  /// the same unit `PageEditorBody`/`PageDocument` positions use.
  func scalarOffset(of index: AttributedString.Index) -> Int {
    String(characters[startIndex..<index]).scalarCount
  }

  /// The `AttributedString.Index` at Unicode Scalar `offset`, or `nil` if
  /// `offset` is out of bounds.
  func index(atScalarOffset offset: Int) -> AttributedString.Index? {
    let plain = plainTextRepresentation
    guard offset >= 0, offset <= plain.scalarCount else { return nil }
    return AttributedString.Index(plain.index(atScalarOffset: offset), within: self)
  }

  func range(forScalarRange scalarRange: Range<Int>) -> Range<AttributedString.Index>? {
    guard let lower = index(atScalarOffset: scalarRange.lowerBound),
      let upper = index(atScalarOffset: scalarRange.upperBound)
    else { return nil }
    return lower..<upper
  }
}

// MARK: - PageEditorBody -> AttributedString

extension PageEditorBody {
  /// Renders this body for display/editing. Every character's semantic
  /// `markStyle`/`pageReference` attribute is set (even empty-style runs,
  /// via `PageEditorMarkStylesAttribute`'s absence), and display attributes
  /// are derived from `markStyle` right alongside it — see this file's
  /// header for why derivation happens here rather than via a semantic
  /// attribute the OS renders for us.
  public var attributedString: AttributedString {
    var result = AttributedString(text)
    for run in markRuns where !run.styles.isEmpty {
      guard let range = result.range(forScalarRange: run.range) else { continue }
      result[range].markStyle = run.styles
      Self.applyDisplayAttributes(run.styles, in: &result, range: range)
    }
    for run in referenceRuns {
      guard let range = result.range(forScalarRange: run.range) else { continue }
      result[range].pageReference = run.destination
      result[range].foregroundColor = .accentColor
    }
    // Task #85 addition — visually distinguishes a `"canvas"`-kind (or any
    // future kind) attachment's OBJECT REPLACEMENT CHARACTER placeholder
    // (`CanvasEmbed.placeholder`) from ordinary body text: a tinted
    // background so the otherwise-invisible/tofu-rendered U+FFFC glyph
    // reads as "there's embedded content here." This is the in-text half
    // of the "at minimum: a tappable placeholder" requirement — see
    // `PageEditorView.swift`'s `attachmentThumbnailStrip` for the actual
    // tap-to-open affordance, kept as a SEPARATE control below the text
    // editor rather than a real in-text tap target: SwiftUI's `TextEditor`
    // has no supported per-character tap-interception hook to attach a
    // real gesture to one attributed span while the view stays editable
    // (confirmed against this file's own established precedent —
    // `pageReference`'s tap/click navigation is the identical, already
    // acknowledged gap, per `PageEditorView.swift`'s header: "stubbed via
    // onNavigateToReference ... real routing is a separate future task").
    // Building a custom `NSTextView`/`UITextView` representable to get real
    // inline tap targets is exactly the "full inline live-rendering" work
    // this task's brief calls a nice-to-have, not required.
    for run in attachmentRuns {
      guard let range = result.range(forScalarRange: run.range) else { continue }
      result[range].attachment = PageEditorAttachmentInfo(
        kind: run.kind, blobID: run.blobID, width: run.width, height: run.height, mimeType: run.mimeType)
      result[range].backgroundColor = Color.accentColor.opacity(0.18)
    }
    return result
  }

  private static func applyDisplayAttributes(
    _ styles: Set<LoroEngine.MarkStyle>,
    in attributed: inout AttributedString,
    range: Range<AttributedString.Index>
  ) {
    var intent: InlinePresentationIntent = attributed[range].inlinePresentationIntent ?? []
    if styles.contains(.bold) { intent.insert(.stronglyEmphasized) }
    if styles.contains(.italic) { intent.insert(.emphasized) }
    if styles.contains(.code) { intent.insert(.code) }
    if !intent.isEmpty { attributed[range].inlinePresentationIntent = intent }
    if styles.contains(.strikethrough) { attributed[range].strikethroughStyle = .single }
    if styles.contains(.underline) { attributed[range].underlineStyle = .single }
  }
}
