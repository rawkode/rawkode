// MarkRunAlgebra.swift
// EnchiridionUI
//
// Pure range algebra shared by `PageEditorBody` (text edits reshaping
// existing runs) and `MarkToggleEngine` (a toggle reshaping runs by style).
// `MarkRun.range` values always partition `[0, text.scalarCount)` with no
// gaps and no overlaps — every character has an explicit (possibly empty)
// style set — which is what makes both callers' logic a simple range-split,
// not a sparse-interval merge.

import EnchiridionSync

/// A contiguous span of body text sharing one formatting-mark set. Does NOT
/// include `.pageReference` — that's `ReferenceRun`'s job (PageEditorBody.swift),
/// kept separate because references carry a payload (destination page +
/// label), not just an on/off style bit, and because an edit invalidates a
/// reference outright rather than reshaping it (see PageEditorBody.swift).
public struct MarkRun: Hashable, Sendable {
  public var range: Range<Int>
  public var styles: Set<LoroEngine.MarkStyle>

  public init(range: Range<Int>, styles: Set<LoroEngine.MarkStyle>) {
    self.range = range
    self.styles = styles
  }
}

enum MarkRunAlgebra {
  /// Sorts and merges adjacent runs that ended up with identical style
  /// sets (e.g. after a toggle exactly re-creates the neighbour's set, or
  /// after a delete stitches two runs back together) and drops any
  /// now-empty range. Every mutating operation in this file ends by calling
  /// this so `PageEditorBody.markRuns` never accumulates redundant runs.
  static func normalize(_ runs: [MarkRun]) -> [MarkRun] {
    let sorted = runs.filter { !$0.range.isEmpty }.sorted { $0.range.lowerBound < $1.range.lowerBound }
    var merged: [MarkRun] = []
    for run in sorted {
      if var last = merged.last, last.styles == run.styles, last.range.upperBound == run.range.lowerBound {
        last.range = last.range.lowerBound..<run.range.upperBound
        merged[merged.count - 1] = last
      } else {
        merged.append(run)
      }
    }
    return merged
  }

  /// Whether an insert at `position` should be absorbed into `run` (grow it
  /// to cover the new text) rather than land in an unstyled gap: `position`
  /// is inside `run`, including its *right* edge — `run.lowerBound <
  /// position <= run.upperBound`. Typing right after a bold run therefore
  /// continues bold (the common "keep typing" case); typing right before a
  /// run does not retroactively pull in the new text. `MarkToggleEngine`'s
  /// caret-state check (MarkToggleEngine.swift) uses this exact predicate
  /// too, so "what the formatting button shows as active" and "what
  /// inserting a character right here would do" never disagree.
  ///
  /// This is a deliberate simplification of Loro's real per-style `expand`
  /// policy (`.after` for bold/italic/underline/strikethrough vs. `.none`
  /// for code/pageReference — see `LoroEngine.MarkStyle.expand`, `internal`
  /// to EnchiridionSync and so unavailable here): every style behaves like
  /// `.after` in this local preview, including `code`, which really expands
  /// `.none`. The CRDT document itself still applies the real per-style
  /// policy once a mutation is flushed (`PageDocument.mark`/`insertText`),
  /// so the only user-visible effect is that typing immediately after an
  /// inline-code run may render as still-code locally until the next
  /// flush's projection corrects it — never a data-loss or
  /// wrong-document-content bug, purely a local-preview staleness window.
  /// Documented here and in the P1 report rather than duplicating
  /// `LoroEngine`'s private policy table for one edge case.
  static func absorbsInsert(at position: Int, run: MarkRun) -> Bool {
    run.range.lowerBound < position && position <= run.range.upperBound
  }

  /// Reshapes `runs` for `length` scalars inserted at `position` — see
  /// `absorbsInsert(at:run:)` for which run (if any) grows to cover the new
  /// text vs. it landing in a fresh unstyled gap.
  static func shiftedForInsert(_ runs: [MarkRun], at position: Int, length: Int) -> [MarkRun] {
    guard length > 0 else { return runs }
    var result: [MarkRun] = []
    var absorbed = false
    for run in runs {
      let willAbsorb = absorbsInsert(at: position, run: run)
      let newLower = run.range.lowerBound >= position ? run.range.lowerBound + length : run.range.lowerBound
      let newUpper = run.range.upperBound >= position ? run.range.upperBound + length : run.range.upperBound
      result.append(MarkRun(range: newLower..<newUpper, styles: run.styles))
      if willAbsorb { absorbed = true }
    }
    if !absorbed {
      result.append(MarkRun(range: position..<(position + length), styles: []))
    }
    return normalize(result)
  }

  /// Reshapes `runs` for `deleted` scalars removed. Characters inside
  /// `deleted` simply vanish along with whatever style they carried — text
  /// CRDT marks are attached to characters, so deleting the characters
  /// deletes the mark with them; no separate "unmark" step is needed here
  /// (contrast `ReferenceRun`, where an interior *edit* — not just a
  /// deletion touching the reference — deliberately breaks the reference,
  /// see PageEditorBody.swift).
  static func shiftedForDelete(_ runs: [MarkRun], deleting deleted: Range<Int>) -> [MarkRun] {
    guard !deleted.isEmpty else { return runs }
    func map(_ x: Int) -> Int {
      if x <= deleted.lowerBound { return x }
      if x >= deleted.upperBound { return x - deleted.count }
      return deleted.lowerBound
    }
    let mapped = runs.compactMap { run -> MarkRun? in
      let lower = map(run.range.lowerBound)
      let upper = map(run.range.upperBound)
      guard lower < upper else { return nil }
      return MarkRun(range: lower..<upper, styles: run.styles)
    }
    return normalize(mapped)
  }

  /// Converts `PageDocumentProjection.formattingMarks` — sparse, single-
  /// style, possibly-overlapping `FormattingMarkRun`s (one run per style per
  /// styled span; bold+italic over the same span is two runs, not one) —
  /// into this file's `MarkRun` representation, which instead partitions
  /// `[0, textLength)` completely with each run carrying its full style
  /// set (this type's header). Used by `PageEditorBody.from(projection:)`
  /// so a freshly loaded page's styling is represented exactly like
  /// locally-applied marks, and so composes correctly with
  /// `shiftedForInsert`/`shiftedForDelete` for subsequent local edits.
  ///
  /// Algorithm: collect every run's start/end as a breakpoint (plus `0` and
  /// `textLength`), sort them, and for each consecutive pair of breakpoints
  /// compute the set of styles whose range fully covers that sub-span. Two
  /// breakpoints are never bridged by a partial style overlap — every
  /// `FormattingMarkRun.range` boundary is itself a breakpoint, so a
  /// sub-span between two consecutive breakpoints is always either fully
  /// inside or fully outside any given mark's range. Ranges with no active
  /// style still produce a `MarkRun` with an empty style set, matching the
  /// "every character has an explicit (possibly empty) style set"
  /// invariant.
  static func markRuns(from formattingMarks: [FormattingMarkRun], textLength: Int) -> [MarkRun] {
    guard textLength > 0 else { return [] }
    var breakpoints: Set<Int> = [0, textLength]
    for mark in formattingMarks {
      let lower = max(0, min(mark.range.lowerBound, textLength))
      let upper = max(0, min(mark.range.upperBound, textLength))
      guard lower < upper else { continue }
      breakpoints.insert(lower)
      breakpoints.insert(upper)
    }
    let sorted = breakpoints.sorted()
    var runs: [MarkRun] = []
    for index in 0..<(sorted.count - 1) {
      let lower = sorted[index]
      let upper = sorted[index + 1]
      let styles = Set(
        formattingMarks
          .filter { $0.range.lowerBound <= lower && $0.range.upperBound >= upper }
          .map(\.style))
      runs.append(MarkRun(range: lower..<upper, styles: styles))
    }
    return normalize(runs)
  }
}
