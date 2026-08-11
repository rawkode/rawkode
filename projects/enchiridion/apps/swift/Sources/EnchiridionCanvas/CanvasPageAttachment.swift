// CanvasPageAttachment.swift
// EnchiridionCanvas
//
// The embed/attachment mechanism connecting a canvas to a page's body
// text — P7 "native drawing canvas" task's item 5. Read this file's
// header in full before assuming a precedent exists to "reuse": as of
// this task, NO image-attachment mechanism exists anywhere in this
// package yet (confirmed by direct search across `EnchiridionSync`/
// `EnchiridionUI` — `EnchiridionShareKit/README.md`'s "Explicit non-goals"
// section independently confirms the same thing: "Image/attachment
// sharing is deliberately out of scope for v1, not half-implemented").
// So rather than reusing an existing images mechanism, this task BUILDS
// the general one — `LoroEngine.MarkStyle.attachment` / `PageDocument
// .addAttachmentMark` (EnchiridionSync/LoroEngine.swift,
// EnchiridionSync/PageDocument.swift) / `PageAttachment`
// (EnchiridionCore/PageModels.swift) — generalized over a free-form
// `kind` string specifically so a future image attachment is "add a
// second `kind` constant and a thin wrapper like this file", not a
// second parallel mark mechanism. This file is the canvas-specific
// wrapper around that general mechanism; `CanvasAttachmentKind.canvas`
// is this module's contribution to that `kind` vocabulary.
//
// TWO USAGE SHAPES, ONE MECHANISM:
//   1. A canvas embedded PARTWAY THROUGH another page's body text —
//      `CanvasEmbed.embed(...)` at an arbitrary text position.
//   2. A page that IS a canvas (tagged `dev.rawkode.enchiridion.canvas
//      .canvasPage` — `CanvasCanvaspageFieldIDs.supertagID`,
//      EnchiridionSchema's generated accessor for `supertags/canvas`) —
//      `CanvasEmbed.embedNewCanvasPage(...)` below, which is really just
//      (1) applied to a brand new page's otherwise-empty body at position
//      0, plus the supertag + width/height hint fields
//      (`supertags/canvas/src/index.ts`'s header explains why those
//      fields exist and what they're for). No second storage mechanism
//      for "the standalone case" — this is deliberate, not an
//      afterthought reuse.

import EnchiridionCore
import EnchiridionBlobs
import EnchiridionSchema
import EnchiridionSync
import Foundation

/// The `kind` string this module's attachment marks use —
/// `PageAttachment.kind`'s doc comment (EnchiridionCore/PageModels.swift)
/// explains why `kind` is free-form rather than a closed enum owned by
/// `EnchiridionCore`.
public enum CanvasAttachmentKind {
  public static let canvas = "canvas"
}

/// A canvas-specific, typed view over a `PageAttachment` whose `kind ==
/// CanvasAttachmentKind.canvas` — `CanvasEmbed.canvasAttachments(in:)`
/// produces these from a page's real `PageDocumentProjection.attachments`.
public struct CanvasPageAttachment: Hashable, Sendable {
  public var sourcePageID: PageID
  public var blobID: BlobID
  /// Unicode Scalar offset range into the source page's body `plainText`
  /// — see `PageAttachment.range`'s doc comment for the exact convention.
  public var range: Range<Int>
  /// The `width`/`height` layout hint carried on the attachment mark
  /// itself (set at embed time from `CanvasDocument.canvasSize` — see
  /// `CanvasEmbed.embed`), NOT re-derived from the blob (which may not
  /// have downloaded yet). Same "hint, not authoritative" caveat as
  /// `supertags/canvas`'s own `width`/`height` fields — prefer the real
  /// `CanvasDocument.canvasSize` once the blob has loaded.
  public var canvasSize: CanvasSize?

  public init(sourcePageID: PageID, blobID: BlobID, range: Range<Int>, canvasSize: CanvasSize?) {
    self.sourcePageID = sourcePageID
    self.blobID = blobID
    self.range = range
    self.canvasSize = canvasSize
  }
}

public enum CanvasEmbedError: Error, Sendable, Equatable, LocalizedError {
  /// `PageDocumentProjection.attachments` reported a `canvas`-kind
  /// attachment whose `blobID` isn't a well-formed `BlobID` — practically
  /// unreachable (this module is the only writer of `kind == "canvas"`
  /// marks, and it always writes a real `BlobID.rawValue`), but surfaced
  /// as a typed error rather than silently dropped, matching this
  /// codebase's general preference for "fail loudly on a genuine
  /// authoring/corruption bug" over swallowing it.
  case malformedAttachment(String)

  public var errorDescription: String? {
    switch self {
    case .malformedAttachment(let detail): "Malformed canvas attachment: \(detail)"
    }
  }
}

/// The embed/attachment mechanism itself — see this file's header for the
/// two usage shapes.
public enum CanvasEmbed {
  /// The placeholder character a canvas embed's attachment mark applies
  /// over. `PageDocument.addAttachmentMark`'s doc comment explains why a
  /// mark needs at least one real inserted character to be observable at
  /// all (Loro marks over an empty range have no persisted effect) — this
  /// is the OBJECT REPLACEMENT CHARACTER (U+FFFC), the same placeholder
  /// convention `NSTextAttachment`-based rich text uses for inline
  /// non-text content, chosen so a plain-text rendering of the body
  /// (search, previews, `plainText` itself) shows a single deliberate
  /// glyph at the embed's position rather than nothing or arbitrary text.
  public static let placeholder = "\u{FFFC}"

  /// Embeds `blobReference` (an already-uploaded canvas content blob —
  /// see `CanvasBlobStore.upload`) at unicode scalar `position` in
  /// `container`'s text: inserts the placeholder character, then marks
  /// exactly that one inserted character as a canvas attachment.
  ///
  /// Two `PageDocument` calls under the hood (`insertText` then
  /// `addAttachmentMark`) but one call for this function's caller —
  /// mirrors `PageDocument.addPageReferenceMark`'s "one call" shape for
  /// its own caller, even though `PageDocument` itself has no combined
  /// insert+mark primitive.
  public static func embed(
    _ blobReference: BlobReference,
    canvasSize: CanvasSize,
    at position: UInt32,
    in container: PageTextContainer = .body,
    snapshot: Data
  ) throws -> PageDocument.MutationResult {
    let inserted = try PageDocument.insertText(container, at: position, text: placeholder, in: snapshot)
    return try PageDocument.addAttachmentMark(
      kind: CanvasAttachmentKind.canvas,
      blobID: blobReference.id.rawValue,
      width: canvasSize.width,
      height: canvasSize.height,
      mimeType: blobReference.metadata.mimeType,
      range: position..<(position + 1),
      in: container,
      snapshot: inserted.document
    )
  }

  /// Creates a brand-new page tagged `canvasPage`, sets its `width`/
  /// `height` hint fields, and embeds `blobReference` at the start of its
  /// (otherwise empty) body — the "a page that IS a canvas" usage shape.
  /// Returns the finished document bytes + version, ready to persist
  /// exactly like any other freshly created page.
  public static func embedNewCanvasPage(
    id: PageID,
    title: String,
    blobReference: BlobReference,
    canvasSize: CanvasSize,
    createdAt: Date = Date()
  ) throws -> (document: Data, version: PageDocumentVersion) {
    let created = try PageDocument.create(id: id, kind: .free, title: title, createdAt: createdAt)
    let tagged = try PageDocument.addSupertag(
      CanvasCanvaspageFieldIDs.supertagID, in: created.document)
    let sized = try PageDocument.setProperties(
      [
        SupertagPropertyKey(supertagID: CanvasCanvaspageFieldIDs.supertagID, fieldID: CanvasCanvaspageFieldIDs.width):
          [.number(canvasSize.width)],
        SupertagPropertyKey(supertagID: CanvasCanvaspageFieldIDs.supertagID, fieldID: CanvasCanvaspageFieldIDs.height):
          [.number(canvasSize.height)],
      ],
      ensuring: CanvasCanvaspageFieldIDs.supertagID,
      in: tagged.document
    )
    let embedded = try embed(blobReference, canvasSize: canvasSize, at: 0, snapshot: sized.document)
    return (embedded.document, embedded.version)
  }

  /// Extracts every canvas-kind attachment from a page's real projection —
  /// `PageDocument.projection(of:)`'s `attachments` field, filtered to
  /// `kind == CanvasAttachmentKind.canvas` (skipping any other attachment
  /// kind, e.g. a future image embed — see `PageAttachment.kind`'s doc
  /// comment) and resolved into the typed `CanvasPageAttachment` above.
  public static func canvasAttachments(in projection: PageDocumentProjection) throws -> [CanvasPageAttachment] {
    try projection.attachments
      .filter { $0.kind == CanvasAttachmentKind.canvas }
      .map { attachment in
        guard !attachment.blobID.isEmpty else {
          throw CanvasEmbedError.malformedAttachment("empty blobID on page \(attachment.sourcePageID.rawValue)")
        }
        let canvasSize: CanvasSize? = {
          guard let width = attachment.width, let height = attachment.height else { return nil }
          return CanvasSize(width: width, height: height)
        }()
        return CanvasPageAttachment(
          sourcePageID: attachment.sourcePageID,
          blobID: BlobID(rawValue: attachment.blobID),
          range: attachment.range,
          canvasSize: canvasSize
        )
      }
  }
}
