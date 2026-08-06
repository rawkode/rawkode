// TextDiff.swift
// EnchiridionUI
//
// Turns "the plain text used to be `old`, now it's `new`" (what a SwiftUI
// `TextEditor` reports after a keystroke, paste, IME composition, or
// autocorrect — SwiftUI never tells us the individual edit) into the single
// contiguous replace that produced it, in Unicode Scalar offsets
// (UnicodeScalarOffsets.swift) — the exact unit `PageDocument.insertText`/
// `deleteText` need. Pure and UI-framework-free by design so it's testable
// without SwiftUI or a live document.

/// A single contiguous replacement: remove `range` from the old text, insert
/// `replacement` at `range.lowerBound`. Degenerate cases fall out naturally:
/// `replacement.isEmpty` is a pure delete, `range.isEmpty` is a pure insert.
public struct TextReplacement: Hashable, Sendable {
  public var range: Range<Int>
  public var replacement: String

  public init(range: Range<Int>, replacement: String) {
    self.range = range
    self.replacement = replacement
  }
}

public enum TextDiff {
  /// The smallest single contiguous edit that turns `old` into `new`:
  /// longest common prefix, then longest common suffix of what remains.
  /// This is the same "one replace" model editors normally reduce a text
  /// delta to — it doesn't try to find minimal/multiple hunks (an editor
  /// change is overwhelmingly one contiguous edit; the rare case of two
  /// simultaneous unrelated edits, e.g. a find-and-replace-all, still
  /// produces a *correct* result here, just as one wider replace spanning
  /// both, not a smaller two-hunk diff).
  ///
  /// Returns `nil` when `old == new` (nothing changed — callers should skip
  /// scheduling a flush).
  public static func replacement(from old: String, to new: String) -> TextReplacement? {
    guard old != new else { return nil }

    let oldScalars = Array(old.unicodeScalars)
    let newScalars = Array(new.unicodeScalars)

    let maxPrefix = min(oldScalars.count, newScalars.count)
    var prefix = 0
    while prefix < maxPrefix, oldScalars[prefix] == newScalars[prefix] {
      prefix += 1
    }

    var oldEnd = oldScalars.count
    var newEnd = newScalars.count
    while oldEnd > prefix, newEnd > prefix, oldScalars[oldEnd - 1] == newScalars[newEnd - 1] {
      oldEnd -= 1
      newEnd -= 1
    }

    let insertedScalars = newScalars[prefix..<newEnd]
    let replacementText = String(String.UnicodeScalarView(insertedScalars))
    return TextReplacement(range: prefix..<oldEnd, replacement: replacementText)
  }
}
