// MarkToggleEngine.swift
// EnchiridionUI
//
// Pure "is this formatting on, off, or mixed over this selection, and what
// should pressing the button do" logic — ported concept from the old app's
// `NativeRichPageEditorState.toggle(_:)`/`formattingState(for:)`
// (EntryEditorView.swift): "enable unless the whole selection is already
// on" is the same UX rule (a mixed/partial selection turns the whole thing
// on, matching most rich text editors, not "turn off since something is
// already on"). Operates on `[MarkRun]`/`Range<Int>` (Unicode Scalar
// offsets, see UnicodeScalarOffsets.swift) so it's testable without
// `AttributedString` or a live document.

import EnchiridionSync

public enum MarkFormattingState: Equatable, Sendable {
  case on
  case off
  case mixed
}

public enum MarkToggleEngine {
  /// The aggregate state of `style` across `range`.
  ///
  /// For a non-empty `range`: `.on` if every scalar in `range` carries
  /// `style`, `.off` if none do, `.mixed` otherwise.
  ///
  /// For an empty (caret) `range`: there is no "selection" to measure, so
  /// this reports whether the *next character typed* would be absorbed
  /// into a styled run — the same `MarkRunAlgebra.absorbsInsert(at:run:)`
  /// predicate `PageEditorBody.applyingInsert` itself uses, so a
  /// formatting button's highlighted state never disagrees with what
  /// typing right now would actually produce. In practice this means: the
  /// run ending exactly at the caret (typing continues its style), or
  /// `.off` at the very start of a run/the document (position 0 always
  /// reports `.off` — nothing precedes it to continue).
  public static func state(
    of style: LoroEngine.MarkStyle,
    in range: Range<Int>,
    runs: [MarkRun]
  ) -> MarkFormattingState {
    guard !range.isEmpty else {
      let styles = runs.first(where: { MarkRunAlgebra.absorbsInsert(at: range.lowerBound, run: $0) })?.styles ?? []
      return styles.contains(style) ? .on : .off
    }

    var covered = 0
    for run in runs where run.styles.contains(style) {
      let lower = max(run.range.lowerBound, range.lowerBound)
      let upper = min(run.range.upperBound, range.upperBound)
      if lower < upper { covered += upper - lower }
    }
    if covered == 0 { return .off }
    if covered == range.count { return .on }
    return .mixed
  }

  /// The toggle decision for pressing `style`'s formatting control right
  /// now: enable unless the selection is uniformly already on.
  public static func shouldEnable(
    _ style: LoroEngine.MarkStyle,
    in range: Range<Int>,
    runs: [MarkRun]
  ) -> Bool {
    state(of: style, in: range, runs: runs) != .on
  }

  /// Applies (`enable: true`) or removes (`enable: false`) `style`
  /// uniformly across `range`, splitting/merging runs as needed. A no-op
  /// (returns `runs` unchanged) for an empty `range` — there is nothing to
  /// mark, matching `PageDocument.mark`'s own behaviour of operating over a
  /// span, not a caret.
  public static func applying(
    _ style: LoroEngine.MarkStyle,
    enable: Bool,
    over range: Range<Int>,
    to runs: [MarkRun]
  ) -> [MarkRun] {
    guard !range.isEmpty else { return runs }
    var result: [MarkRun] = []
    for run in runs {
      let lower = max(run.range.lowerBound, range.lowerBound)
      let upper = min(run.range.upperBound, range.upperBound)
      guard lower < upper else {
        result.append(run)
        continue
      }
      if run.range.lowerBound < lower {
        result.append(MarkRun(range: run.range.lowerBound..<lower, styles: run.styles))
      }
      var styles = run.styles
      if enable {
        styles.insert(style)
      } else {
        styles.remove(style)
      }
      result.append(MarkRun(range: lower..<upper, styles: styles))
      if upper < run.range.upperBound {
        result.append(MarkRun(range: upper..<run.range.upperBound, styles: run.styles))
      }
    }
    return MarkRunAlgebra.normalize(result)
  }
}
