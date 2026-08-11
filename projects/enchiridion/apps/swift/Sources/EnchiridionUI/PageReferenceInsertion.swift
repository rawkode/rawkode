// PageReferenceInsertion.swift
// EnchiridionUI
//
// Two independent, pure pieces of the inline "[[" page-reference flow
// (task point 2): detecting that the user has typed an open `[[query`
// trigger worth showing a picker for, and planning what a chosen page
// should replace it with. Neither touches `PageDocument` or the
// controller's pending-op queue — `PageEditorController.insertPageReference`
// (PageEditorController.swift) is what actually executes a plan.
//
// PRODUCT.md ("capture immediate, interpretation deliberate"): `match(...)`
// only ever *offers* a picker — the `[[query` text the user typed is real,
// already-committed literal text the whole time (it goes through the same
// `insertText` path as any other keystroke); nothing about detecting a
// trigger ever withholds, rewrites, or delays what was actually typed. The
// interpretation (turning it into a reference) only happens if the user
// explicitly picks a page — see `PageEditorController.insertPageReference`.

import EnchiridionCore

/// An open, not-yet-closed `[[query` trigger ending exactly at the cursor.
public struct PageReferenceTriggerMatch: Hashable, Sendable {
  /// The full `[[query` span (including the two opening brackets), in the
  /// text's Unicode Scalar offsets — what a chosen page's label should
  /// replace.
  public var range: Range<Int>
  public var query: String

  public init(range: Range<Int>, query: String) {
    self.range = range
    self.query = query
  }
}

/// Finished plan for turning some span of already-typed text into a page
/// reference: `PageEditorController.insertPageReference` deletes
/// `replacedRange`, inserts `label`, and marks the inserted label as a
/// reference to `pageID`.
public struct PageReferenceInsertionPlan: Hashable, Sendable {
  public var replacedRange: Range<Int>
  public var label: String
  public var pageID: PageID

  public init(replacedRange: Range<Int>, label: String, pageID: PageID) {
    self.replacedRange = replacedRange
    self.label = label
    self.pageID = pageID
  }
}

public enum PageReferenceTrigger {
  /// Finds the nearest unmatched `[[` before `cursor` such that nothing
  /// between it and `cursor` closes it (`]]`), starts a new one (`[[`), or
  /// crosses a line break — an open trigger can't span paragraphs. Returns
  /// `nil` once none of those hold, which naturally covers "the user closed
  /// the brackets", "the user backspaced past the `[[`", and "the cursor
  /// moved to an unrelated part of the document".
  public static func match(in text: String, cursor: Int) -> PageReferenceTriggerMatch? {
    guard cursor >= 0, cursor <= text.scalarCount else { return nil }
    let upToCursor = String(text.unicodeScalars.prefix(cursor))
    guard let openRange = upToCursor.range(of: "[[", options: .backwards) else { return nil }
    let tail = upToCursor[openRange.upperBound...]
    guard !tail.contains("]]"), !tail.contains("[["), !tail.contains("\n") else { return nil }
    let start = upToCursor.scalarOffset(of: openRange.lowerBound)
    return PageReferenceTriggerMatch(range: start..<cursor, query: String(tail))
  }
}

public enum PageReferenceInsertion {
  /// Builds the plan to replace `range` (typically an active trigger match,
  /// or an empty caret/selection range when invoked from the toolbar
  /// instead of a `[[` trigger) with `label`, marked as a reference to
  /// `pageID`.
  public static func plan(replacing range: Range<Int>, with label: String, pageID: PageID) -> PageReferenceInsertionPlan {
    PageReferenceInsertionPlan(replacedRange: range, label: label, pageID: pageID)
  }
}
