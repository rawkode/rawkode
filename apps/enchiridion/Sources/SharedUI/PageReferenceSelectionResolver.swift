import EnchiridionCore
import SwiftUI

/// Resolves the single, unambiguous page reference represented by an editor
/// selection. This deliberately knows nothing about editor focus, navigation,
/// or persistence so callers cannot accidentally make a text gesture follow a
/// reference.
@available(iOS 26.0, macOS 26.0, *)
struct PageReferenceSelectionResolver {
  enum Selection {
    case caret(AttributedString.Index)
    case range(Range<AttributedString.Index>)
    case rangeSet(RangeSet<AttributedString.Index>)
  }
  struct LiveDestination: Hashable, Sendable {
    let vaultID: VaultID
    let pageID: PageID
    let isDeleted: Bool

    init(vaultID: VaultID, pageID: PageID, isDeleted: Bool = false) {
      self.vaultID = vaultID
      self.pageID = pageID
      self.isDeleted = isDeleted
    }
  }

  struct ResolvedReference: Hashable, Sendable {
    let sourceVaultID: VaultID
    let sourcePageID: PageID
    let destination: LiveDestination
    let label: String
  }

  static func resolve(
    in body: AttributedString,
    selection: AttributedTextSelection,
    sourceVaultID: VaultID,
    sourcePageID: PageID,
    liveDestination: (PageID) -> LiveDestination?
  ) -> ResolvedReference? {
    guard let selection = Self.selection(from: selection, in: body) else { return nil }
    return resolve(
      in: body,
      selection: selection,
      sourceVaultID: sourceVaultID,
      sourcePageID: sourcePageID,
      liveDestination: liveDestination
    )
  }

  static func resolve(
    in body: AttributedString,
    selection: Selection,
    sourceVaultID: VaultID,
    sourcePageID: PageID,
    liveDestination: (PageID) -> LiveDestination?
  ) -> ResolvedReference? {
    guard let reference = selectedReference(in: body, selection: selection),
      let destination = liveDestination(reference.pageID),
      destination.vaultID == sourceVaultID,
      destination.pageID == reference.pageID,
      !destination.isDeleted,
      destination.pageID != sourcePageID
    else { return nil }

    return ResolvedReference(
      sourceVaultID: sourceVaultID,
      sourcePageID: sourcePageID,
      destination: destination,
      label: reference.label
    )
  }

  /// A caret belongs to a reference only in its half-open mark range. A text
  /// selection must be nonempty, contiguous, and wholly within one reference.
  private static func selectedReference(
    in body: AttributedString,
    selection: Selection
  ) -> PageReferenceDestination? {
    return referenceRuns(in: body).first { run in
      switch selection {
      case .caret(let index): run.range.contains(index)
      case .range(let range):
        range.lowerBound >= run.range.lowerBound && range.upperBound <= run.range.upperBound
      case .rangeSet: false
      }
    }?.destination
  }

  private static func selection(
    from selection: AttributedTextSelection,
    in body: AttributedString
  ) -> Selection? {
    switch selection.indices(in: body) {
    case .insertionPoint(let index): return .caret(index)
    case .ranges(let ranges):
      guard ranges.ranges.count == 1, let range = ranges.ranges.first, !range.isEmpty else { return nil }
      return .range(range)
    @unknown default: return nil
    }
  }

  /// Coalesce adjacent Automerge runs with equal semantic marks, so a
  /// formatting boundary cannot change the meaning of a page reference.
  private static func referenceRuns(in body: AttributedString) -> [ReferenceRun] {
    var result: [ReferenceRun] = []
    for (marks, range) in body.runs[PageRichTextAttributes.AutomergeMarks.self] {
      guard let destination = destination(from: marks) else {
        continue
      }
      if var previous = result.last,
        previous.destination == destination,
        previous.range.upperBound == range.lowerBound
      {
        previous.range = previous.range.lowerBound..<range.upperBound
        result[result.count - 1] = previous
      } else {
        result.append(.init(range: range, destination: destination))
      }
    }
    return result
  }

  /// A reference mark is fail-closed: every page-reference mark in the run
  /// must decode, and all decoded values must agree. Other Automerge marks may
  /// coexist without changing the page-reference semantics.
  private static func destination(
    from marks: [PageRichTextMark]?
  ) -> PageReferenceDestination? {
    guard let marks else { return nil }
    let referenceMarks = marks.filter { $0.name == PageDocument.pageReferenceMark }
    guard !referenceMarks.isEmpty else { return nil }
    let destinations = referenceMarks.compactMap(PageDocument.pageReferenceDestination(from:))
    guard destinations.count == referenceMarks.count,
      let destination = destinations.first,
      destinations.allSatisfy({ $0 == destination })
    else { return nil }
    return destination
  }

  private struct ReferenceRun {
    var range: Range<AttributedString.Index>
    let destination: PageReferenceDestination
  }

}
