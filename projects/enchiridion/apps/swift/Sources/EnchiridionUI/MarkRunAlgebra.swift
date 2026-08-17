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

  /// The styles an insert at `position` inherits from `run`. An insertion in
  /// the middle of a run retains every style; at the trailing edge it retains
  /// only marks whose CRDT expand policy continues there. This keeps the
  /// immediate native preview and the eventually flushed Loro document in
  /// lockstep, including the important case that inline code does not swallow
  /// ordinary prose typed immediately after it.
  static func stylesForInsert(at position: Int, in run: MarkRun) -> Set<LoroEngine.MarkStyle> {
    guard run.range.lowerBound < position, position <= run.range.upperBound else { return [] }
    guard position == run.range.upperBound else { return run.styles }
    return Set(run.styles.filter(\.continuesAtTrailingBoundary))
  }

  /// Reshapes `runs` for `length` scalars inserted at `position`, preserving
  /// the per-style boundary policy from `stylesForInsert(at:in:)`.
  static func shiftedForInsert(_ runs: [MarkRun], at position: Int, length: Int) -> [MarkRun] {
    guard length > 0 else { return runs }
    var result: [MarkRun] = []
    var inserted = false
    for run in runs {
      if !inserted, position < run.range.lowerBound {
        result.append(MarkRun(range: position..<(position + length), styles: []))
        inserted = true
      }

      if !inserted, run.range.lowerBound < position, position < run.range.upperBound {
        result.append(MarkRun(range: run.range.lowerBound..<position, styles: run.styles))
        result.append(MarkRun(range: position..<(position + length), styles: run.styles))
        result.append(MarkRun(range: (position + length)..<(run.range.upperBound + length), styles: run.styles))
        inserted = true
        continue
      }

      let shiftedLower = run.range.lowerBound >= position ? run.range.lowerBound + length : run.range.lowerBound
      // A run ending exactly at the insertion point stays ended there; the
      // inserted span is represented separately below with the appropriate
      // trailing-boundary styles. Shifting `>=` here would extend the old
      // run *and* add the inserted run, producing overlapping ranges.
      let shiftedUpper = run.range.upperBound > position ? run.range.upperBound + length : run.range.upperBound
      result.append(MarkRun(range: shiftedLower..<shiftedUpper, styles: run.styles))

      if !inserted, position == run.range.upperBound {
        result.append(MarkRun(
          range: position..<(position + length), styles: stylesForInsert(at: position, in: run)))
        inserted = true
      }
    }
    if !inserted {
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
