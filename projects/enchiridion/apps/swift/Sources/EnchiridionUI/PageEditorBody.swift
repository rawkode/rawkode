// PageEditorBody.swift
// EnchiridionUI
//
// The editor's in-memory rich-text model — plain text plus positioned
// formatting-mark runs and page-reference runs — kept entirely separate
// from `AttributedString`/SwiftUI (see PageEditorAttributes.swift for the
// bridge to that) so it's trivially testable and so the "lighter-weight
// custom representation" design point (task) has one obvious home.
//
// WHY A CUSTOM MODEL, NOT `PageDocument.projection(of:)`'s OWN SHAPE:
// `PageDocumentProjection` (EnchiridionSync/PageDocument.swift) exposes
// `plainText`, `references: [PageReference]`, and `formattingMarks:
// [FormattingMarkRun]` — but `PageReference` has no *position*, so
// reference spans still have to be best-effort re-hydrated on load (see
// `from(projection:)` below). `formattingMarks` DOES carry positions
// (Unicode Scalar ranges into `plainText`), one single-style run per
// styled span — `MarkRunAlgebra.markRuns(from:textLength:)` converts that
// sparse, possibly-overlapping shape into this file's `MarkRun`
// partition-of-the-whole-text representation.
import EnchiridionCore
import EnchiridionSync
import Foundation

/// A positioned inline page-reference span. Unlike `MarkRun`, reference
/// runs are sparse (not a partition of the text) and carry a payload — the
/// destination page and the label text was captured with — rather than a
/// simple on/off bit.
public struct ReferenceRun: Hashable, Sendable {
  public var range: Range<Int>
  public var destination: PageReferenceDestination

  public init(range: Range<Int>, destination: PageReferenceDestination) {
    self.range = range
    self.destination = destination
  }
}

/// Task #85 (P7 integration wave) addition — a positioned inline
/// attachment span, reconstructed from `PageDocumentProjection.attachments`
/// (`EnchiridionCore.PageAttachment` — see that type's doc comment for the
/// general, kind-free-form attachment-mark mechanism `EnchiridionCanvas`'s
/// P7 task built). Unlike `ReferenceRun` (whose source, `PageReference`,
/// has no position and must be approximately re-matched against
/// `plainText` — see `from(projection:)`'s doc comment below),
/// `PageAttachment` already carries its own exact Unicode Scalar `range`
/// (that type's own doc comment: "there is no reason to drop it and force
/// a later consumer to re-approximate it"), so `AttachmentRun`
/// reconstruction from a projection is EXACT, never approximate.
///
/// Deliberately mirrors `PageAttachment`'s own fields (not a wrapper
/// around that type) so `PageEditorBody`/`PageEditorAttributes.swift`
/// don't need to import `EnchiridionSync` beyond what they already do —
/// `PageAttachment` itself lives in `EnchiridionCore`, already imported
/// here, so this could have wrapped it directly, but a dedicated `*Run`
/// type keeps this file's existing `ReferenceRun`/`MarkRun` shape
/// consistent (every positioned span in this file is its own small
/// `Hashable`/`Sendable` struct) rather than mixing two conventions.
public struct AttachmentRun: Hashable, Sendable {
  public var range: Range<Int>
  /// What the attachment IS — e.g. `"canvas"`. See `PageAttachment.kind`'s
  /// doc comment for why this stays a free-form string here too, not a
  /// closed enum: `PageEditorBody` (`EnchiridionUI`) has no reason to know
  /// about every attachment kind any consuming module ever defines.
  public var kind: String
  public var blobID: String
  public var width: Double?
  public var height: Double?
  public var mimeType: String?

  public init(
    range: Range<Int>, kind: String, blobID: String, width: Double? = nil, height: Double? = nil,
    mimeType: String? = nil
  ) {
    self.range = range
    self.kind = kind
    self.blobID = blobID
    self.width = width
    self.height = height
    self.mimeType = mimeType
  }
}

/// The result of applying a local text edit: the reshaped body, plus any
/// reference runs the edit broke (see `applyingInsert`/`applyingDelete`).
/// `PageEditorController` uses `brokenReferences` to decide whether an
/// explicit CRDT unmark is needed (see that file's header).
public struct PageEditorBodyEditOutcome: Sendable {
  public var body: PageEditorBody
  public var brokenReferences: [ReferenceRun]
}

public struct PageEditorBody: Hashable, Sendable {
  public var text: String
  /// Always a complete partition of `[0, text.scalarCount)` — see
  /// MarkRunAlgebra.swift's header. Empty only when `text` is empty.
  public var markRuns: [MarkRun]
  /// Sparse, sorted, non-overlapping.
  public var referenceRuns: [ReferenceRun]
  /// Sparse, sorted, non-overlapping — task #85 addition, see
  /// `AttachmentRun`'s doc comment.
  public var attachmentRuns: [AttachmentRun]

  public init(
    text: String, markRuns: [MarkRun] = [], referenceRuns: [ReferenceRun] = [],
    attachmentRuns: [AttachmentRun] = []
  ) {
    self.text = text
    if markRuns.isEmpty, !text.isEmpty {
      self.markRuns = [MarkRun(range: 0..<text.scalarCount, styles: [])]
    } else {
      self.markRuns = markRuns
    }
    self.referenceRuns = referenceRuns
    self.attachmentRuns = attachmentRuns
  }

  public var length: Int { text.scalarCount }

  public static let empty = PageEditorBody(text: "")

  /// Reconstruction from a durable `PageDocumentProjection`.
  ///
  /// Formatting marks ARE exactly reconstructed: `projection.formattingMarks`
  /// carries positioned, single-style spans (Unicode Scalar offsets into
  /// `plainText`, the same convention `UnicodeScalarOffsets.swift` uses —
  /// see `FormattingMarkRun`'s doc comment), so
  /// `MarkRunAlgebra.markRuns(from:textLength:)` deterministically converts
  /// them into this type's `MarkRun` partition — no fallback matching
  /// needed, unlike references below.
  ///
  /// Reference spans ARE only approximately re-hydrated, because
  /// `PageReference` has no position: `PageDocumentProjection.references`
  /// preserves body-text insertion order (see `PageDocument`'s
  /// `plainTextAndReferences`), so this greedily matches each
  /// `PageReference.fallbackLabel` against the next unclaimed occurrence
  /// of that exact substring in `plainText`. This is an approximation, not
  /// an exact position recovery: if the label text also appears earlier in
  /// the page as ordinary prose, or two references share an identical
  /// label, the match can land on the wrong occurrence. It never fabricates
  /// a reference that doesn't exist, and a label that can't be found is
  /// simply dropped from the rendered runs (the reference still exists in
  /// the real document — see `PageDocumentProjection.references` — this
  /// only affects this session's local *rendering* until a positioned-
  /// reference projection follow-up lands).
  public static func from(projection: PageDocumentProjection) -> PageEditorBody {
    let text = projection.plainText
    var searchFrom = text.startIndex
    var runs: [ReferenceRun] = []
    for reference in projection.references {
      guard !reference.fallbackLabel.isEmpty,
        let found = text.range(of: reference.fallbackLabel, range: searchFrom..<text.endIndex)
      else { continue }
      let lower = text.scalarOffset(of: found.lowerBound)
      let upper = text.scalarOffset(of: found.upperBound)
      runs.append(
        ReferenceRun(
          range: lower..<upper,
          destination: PageReferenceDestination(pageID: reference.targetPageID, label: reference.fallbackLabel)))
      searchFrom = found.upperBound
    }
    let markRuns = MarkRunAlgebra.markRuns(from: projection.formattingMarks, textLength: text.scalarCount)
    // Task #85 addition — EXACT reconstruction (unlike `referenceRuns`
    // above): `PageAttachment.range` is already a real Unicode Scalar
    // range, no fallback-label re-matching needed. Sorted to match this
    // file's "sparse, sorted, non-overlapping" convention for reference
    // runs — `projection.attachments` is already sorted by
    // `PageDocument.plainTextAndReferences` (that file: "attachments.sort {
    // $0.range.lowerBound < $1.range.lowerBound }"), but re-sorting here
    // costs nothing and doesn't assume that upstream ordering forever.
    let attachmentRuns = projection.attachments
      .map {
        AttachmentRun(
          range: $0.range, kind: $0.kind, blobID: $0.blobID, width: $0.width, height: $0.height,
          mimeType: $0.mimeType)
      }
      .sorted { $0.range.lowerBound < $1.range.lowerBound }
    return PageEditorBody(text: text, markRuns: markRuns, referenceRuns: runs, attachmentRuns: attachmentRuns)
  }

  /// Reshapes this body for `insertedText` landing at scalar offset
  /// `position`. Mark runs absorb or gap per `MarkRunAlgebra`'s policy.
  /// Reference runs are broken (see `brokenReferences`) if `position` lands
  /// strictly inside one — typing into the interior of a reference is
  /// treated as deliberately editing it back to literal text (PRODUCT.md:
  /// "interpretation ... stays editable"), not silently extending what it
  /// points to. A position exactly at a reference's edge does not extend
  /// it either (matches `pageReferenceMark`'s `.none` expand policy in
  /// `LoroEngine`).
  public func applyingInsert(text insertedText: String, at position: Int) -> PageEditorBodyEditOutcome {
    guard !insertedText.isEmpty else { return PageEditorBodyEditOutcome(body: self, brokenReferences: []) }
    precondition(position >= 0 && position <= length, "insert position out of bounds")

    var newText = text
    newText.insert(contentsOf: insertedText, at: text.index(atScalarOffset: position))

    let insertLength = insertedText.scalarCount
    let newMarkRuns = MarkRunAlgebra.shiftedForInsert(markRuns, at: position, length: insertLength)

    var broken: [ReferenceRun] = []
    var keptReferenceRuns: [ReferenceRun] = []
    for run in referenceRuns {
      if run.range.lowerBound < position && position < run.range.upperBound {
        broken.append(run)
        continue
      }
      let newLower = run.range.lowerBound >= position ? run.range.lowerBound + insertLength : run.range.lowerBound
      let newUpper = run.range.upperBound > position ? run.range.upperBound + insertLength : run.range.upperBound
      keptReferenceRuns.append(ReferenceRun(range: newLower..<newUpper, destination: run.destination))
    }

    // Task #85 addition — same shift-only policy as reference runs above
    // (an attachment run can never be "strictly inside"-broken by an
    // insert: every attachment run is exactly one scalar wide, per
    // `CanvasEmbed.placeholder`'s single-character convention, so no
    // integer position is ever strictly between a 1-length range's bounds).
    let newAttachmentRuns = attachmentRuns.map { run -> AttachmentRun in
      var shifted = run
      shifted.range =
        (run.range.lowerBound >= position ? run.range.lowerBound + insertLength : run.range.lowerBound)
        ..< (run.range.upperBound > position ? run.range.upperBound + insertLength : run.range.upperBound)
      return shifted
    }

    let newBody = PageEditorBody(
      text: newText, markRuns: newMarkRuns, referenceRuns: keptReferenceRuns, attachmentRuns: newAttachmentRuns)
    return PageEditorBodyEditOutcome(body: newBody, brokenReferences: broken)
  }

  /// Reshapes this body for `deleted` scalars removed. A reference run is
  /// broken if `deleted` overlaps it at all (deleting even one character of
  /// a reference invalidates it — there's no partial-reference state); a
  /// deletion that only touches a reference's edge (shares a boundary, no
  /// overlap) just shifts it, matching `Range.overlaps`'s half-open
  /// semantics.
  public func applyingDelete(range deleted: Range<Int>) -> PageEditorBodyEditOutcome {
    guard !deleted.isEmpty else { return PageEditorBodyEditOutcome(body: self, brokenReferences: []) }
    precondition(
      deleted.lowerBound >= 0 && deleted.upperBound <= length, "delete range out of bounds")

    var newText = text
    newText.removeSubrange(text.stringRange(deleted))

    let newMarkRuns = MarkRunAlgebra.shiftedForDelete(markRuns, deleting: deleted)

    func map(_ x: Int) -> Int {
      if x <= deleted.lowerBound { return x }
      if x >= deleted.upperBound { return x - deleted.count }
      return deleted.lowerBound
    }

    var broken: [ReferenceRun] = []
    var keptReferenceRuns: [ReferenceRun] = []
    for run in referenceRuns {
      if run.range.overlaps(deleted) {
        broken.append(run)
        continue
      }
      keptReferenceRuns.append(ReferenceRun(range: map(run.range.lowerBound)..<map(run.range.upperBound), destination: run.destination))
    }

    // Task #85 addition — same overlap-breaks/edge-shifts policy as
    // reference runs above. In practice an attachment run is always
    // exactly one scalar wide, so any deletion that overlaps it at all
    // removes its one placeholder character outright — dropping the run
    // here matches that: there is no remaining character left for a
    // "partial" attachment to survive on.
    var keptAttachmentRuns: [AttachmentRun] = []
    for run in attachmentRuns {
      guard !run.range.overlaps(deleted) else { continue }
      var shifted = run
      shifted.range = map(run.range.lowerBound)..<map(run.range.upperBound)
      keptAttachmentRuns.append(shifted)
    }

    let newBody = PageEditorBody(
      text: newText, markRuns: newMarkRuns, referenceRuns: keptReferenceRuns, attachmentRuns: keptAttachmentRuns)
    return PageEditorBodyEditOutcome(body: newBody, brokenReferences: broken)
  }
}
