// DecodedOldPage.swift
// EnchiridionImporter
//
// The neutral, engine-agnostic shape `OldPageDocumentDecoder` decodes an old
// (Automerge) page document INTO, and `PageReencoder` re-encodes FROM into a
// new (Loro) `EnchiridionSync.PageDocument`. Keeping this as a plain value
// type — not a live Automerge `Document` handle — means the decode and
// re-encode steps are independently testable and the re-encode step never
// needs to know anything about Automerge.

import CryptoKit
import EnchiridionCore
import EnchiridionSync
import Foundation

/// One rich-text formatting span decoded from the old page's body text.
/// Ported concept from the old app's `PageRichTextMark`, reduced to exactly
/// what `PageReencoder` needs to replay against the new `PageDocument` API.
public struct DecodedMark: Hashable, Sendable {
  public enum Kind: Hashable, Sendable {
    /// A plain on/off style span (old mark names "strong"/"em"/"strike"/
    /// "code"), mapped to its `LoroEngine.MarkStyle` equivalent — see
    /// `OldPageDocumentDecoder.markStyle(forOldName:)`.
    case style(LoroEngine.MarkStyle)
    /// A page-reference span (old mark name
    /// `"__ext__dev.rawkode.enchiridion.page-reference"`), decoded payload.
    case pageReference(pageID: PageID, label: String)
    /// An old mark name this importer doesn't have a re-encode target for
    /// (e.g. the meeting-transcript semantic-provenance mark) — carried
    /// through decode so it's visible/countable, but `PageReencoder`
    /// deliberately drops it. See the importer README's "Known
    /// limitations" section.
    case unsupported(name: String)
  }

  public var kind: Kind
  /// Unicode Scalar offset range into the old page's body text — same
  /// convention both the old (`Automerge.Mark.start`/`.end`) and new
  /// (`PageDocument.mark`'s `range: Range<UInt32>`) sides already use.
  public var range: Range<UInt32>

  public init(kind: Kind, range: Range<UInt32>) {
    self.kind = kind
    self.range = range
  }
}

/// Everything `PageReencoder` needs from one decoded old-app page.
public struct DecodedOldPage: Sendable {
  /// The OLD page's own stored id, exactly as read from Automerge's
  /// `pageID` root field (equivalently, the old SQLite `pages.id` column).
  /// `PageReencoder.rederivedPageID(for:)` decides whether this is reused
  /// verbatim (random `.free` pages — there is nothing to re-derive) or
  /// recomputed from decoded content (deterministic kinds).
  public var originalPageID: PageID
  public var kind: PageKind
  public var title: String
  public var body: String
  public var marks: [DecodedMark]
  public var createdAt: Date
  public var deletedAt: Date?
  public var isPinned: Bool
  public var supertagIDs: [SupertagID]
  /// Scalar/select/... field values AND entityReference field values
  /// folded back in from decoded edges (the old app's own
  /// `metadataProjection` does the identical fold — see
  /// `OldPageDocumentDecoder`'s header) — matches what `PageReencoder`
  /// feeds straight into `PageDocument.setProperty`, letting the new
  /// engine regenerate its own edges from the `.page(...)` values exactly
  /// as `PageDocument.setProperty`'s doc comment describes.
  public var properties: [SupertagPropertyKey: [SupertagValue]]

  public init(
    originalPageID: PageID,
    kind: PageKind,
    title: String,
    body: String,
    marks: [DecodedMark],
    createdAt: Date,
    deletedAt: Date?,
    isPinned: Bool,
    supertagIDs: [SupertagID],
    properties: [SupertagPropertyKey: [SupertagValue]]
  ) {
    self.originalPageID = originalPageID
    self.kind = kind
    self.title = title
    self.body = body
    self.marks = marks
    self.createdAt = createdAt
    self.deletedAt = deletedAt
    self.isPinned = isPinned
    self.supertagIDs = supertagIDs
    self.properties = properties
  }

  /// A stable digest of everything this type carries — used by
  /// `VaultImportLedger` to decide "has this page's content changed since
  /// the last successful import?" without needing byte-identical re-
  /// exported Loro snapshots (which loro-swift's current snapshot-in/
  /// snapshot-out design, with no persisted per-device peer id, cannot
  /// guarantee across two separate importer runs — see `VaultImporter.swift`'s
  /// header for the full explanation and why this digest-based ledger is
  /// the idempotency mechanism instead). Two `DecodedOldPage`s with the
  /// same digest are treated as "nothing to re-push."
  public func contentDigest() throws -> String {
    struct CanonicalMark: Codable {
      var start: UInt32
      var end: UInt32
      var kind: String
      var pageID: String?
      var label: String?
    }
    struct CanonicalPayload: Codable {
      var pageID: String
      var kind: PageKind
      var title: String
      var body: String
      var isPinned: Bool
      var deletedAt: Date?
      var supertagIDs: [String]
      var properties: [String: [SupertagValue]]
      var marks: [CanonicalMark]
    }

    let canonicalMarks: [CanonicalMark] = marks.map { mark in
      switch mark.kind {
      case .style(let style):
        return CanonicalMark(
          start: mark.range.lowerBound, end: mark.range.upperBound,
          kind: "style:\(style.rawValue)", pageID: nil, label: nil
        )
      case .pageReference(let pageID, let label):
        return CanonicalMark(
          start: mark.range.lowerBound, end: mark.range.upperBound,
          kind: "pageReference", pageID: pageID.rawValue, label: label
        )
      case .unsupported(let name):
        return CanonicalMark(
          start: mark.range.lowerBound, end: mark.range.upperBound,
          kind: "unsupported:\(name)", pageID: nil, label: nil
        )
      }
    }.sorted { ($0.start, $0.end, $0.kind) < ($1.start, $1.end, $1.kind) }

    let payload = CanonicalPayload(
      pageID: originalPageID.rawValue,
      kind: kind,
      title: title,
      body: body,
      isPinned: isPinned,
      deletedAt: deletedAt,
      supertagIDs: supertagIDs.map(\.rawValue).sorted(),
      properties: Dictionary(uniqueKeysWithValues: properties.map { ($0.key.storageKey, $0.value) }),
      marks: canonicalMarks
    )
    let data = try JSONEncoder.enchiridion.encode(payload)
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
