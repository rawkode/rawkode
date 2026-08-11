// CanvasPageAttachmentTests.swift
// EnchiridionCanvasTests
//
// Task brief: "Embed-in-page attachment reference resolves correctly
// (create a page with a canvas attachment, reload, confirm the reference
// still resolves to the right blob)."
//
// "Reload" here is simulated the way it always is for a snapshot-in/
// snapshot-out CRDT type (`PageDocument`'s own documented shape — see
// PageDocument.swift's header): take the `Data` bytes a mutation returned,
// and re-derive a projection from THOSE BYTES via a fresh call, exactly
// what re-opening the app and loading the page from disk/sync does. No
// mocking — every call below is the real `PageDocument`/`CanvasEmbed`
// production code path.

import EnchiridionBlobs
import EnchiridionCore
import EnchiridionSchema
import EnchiridionSync
import XCTest

@testable import EnchiridionCanvas

final class CanvasPageAttachmentTests: XCTestCase {
  private func makeBlobReference(content: String, mimeType: String = CanvasBlobStore.mimeType) -> BlobReference {
    let data = Data(content.utf8)
    return BlobReference(
      id: BlobID(contentsOf: data),
      metadata: BlobMetadata(mimeType: mimeType, byteCount: data.count))
  }

  // MARK: - Standalone canvas page

  func testEmbedNewCanvasPageResolvesAfterReload() throws {
    let pageID = PageID(rawValue: "page_canvas1")
    let reference = makeBlobReference(content: "canvas-content-1")
    let canvasSize = CanvasSize(width: 800, height: 600)

    let created = try CanvasEmbed.embedNewCanvasPage(
      id: pageID, title: "My Sketch", blobReference: reference, canvasSize: canvasSize)

    // "Reload": re-derive the projection from the raw bytes, a second,
    // independent call — nothing about this reuses in-memory state from
    // `embedNewCanvasPage` above.
    let reloaded = try PageDocument.projection(of: created.document)

    XCTAssertEqual(reloaded.title, "My Sketch")
    XCTAssertTrue(
      reloaded.objectMetadata.supertagIDs.contains(CanvasCanvaspageFieldIDs.supertagID),
      "the page must be tagged canvasPage")

    let attachments = try CanvasEmbed.canvasAttachments(in: reloaded)
    XCTAssertEqual(attachments.count, 1)
    let attachment = try XCTUnwrap(attachments.first)
    XCTAssertEqual(attachment.blobID, reference.id, "must resolve to the exact same BlobID that was embedded")
    XCTAssertEqual(attachment.sourcePageID, pageID)
    XCTAssertEqual(attachment.canvasSize, canvasSize)
    XCTAssertEqual(attachment.range, 0..<1, "the placeholder character occupies exactly one scalar")

    // The width/height hint fields (supertags/canvas) round-trip too.
    let widthValues = reloaded.objectMetadata.properties[
      SupertagPropertyKey(supertagID: CanvasCanvaspageFieldIDs.supertagID, fieldID: CanvasCanvaspageFieldIDs.width)]
    XCTAssertEqual(widthValues, [.number(800)])
  }

  func testEmbeddedPlaceholderCharacterIsTheObjectReplacementCharacter() throws {
    let reference = makeBlobReference(content: "x")
    let created = try CanvasEmbed.embedNewCanvasPage(
      id: PageID(rawValue: "page_canvas2"), title: "T", blobReference: reference,
      canvasSize: .defaultSize)
    let reloaded = try PageDocument.projection(of: created.document)
    XCTAssertEqual(reloaded.plainText, CanvasEmbed.placeholder)
  }

  // MARK: - Canvas embedded partway through another page's body

  func testEmbedInsideExistingBodyTextResolvesAtTheCorrectPosition() throws {
    let pageID = PageID(rawValue: "page_notes1")
    let created = try PageDocument.create(id: pageID, kind: .free, title: "Notes")
    let withPrefix = try PageDocument.insertText(.body, at: 0, text: "See sketch: ", in: created.document)

    let reference = makeBlobReference(content: "embedded-canvas")
    let position = UInt32("See sketch: ".unicodeScalars.count)
    let embedded = try CanvasEmbed.embed(
      reference, canvasSize: CanvasSize(width: 300, height: 200), at: position, snapshot: withPrefix.document)
    let withSuffix = try PageDocument.insertText(
      .body, at: position + 1, text: " (draft)", in: embedded.document)

    // Reload.
    let reloaded = try PageDocument.projection(of: withSuffix.document)

    XCTAssertEqual(reloaded.plainText, "See sketch: \(CanvasEmbed.placeholder) (draft)")

    let attachments = try CanvasEmbed.canvasAttachments(in: reloaded)
    XCTAssertEqual(attachments.count, 1)
    let attachment = try XCTUnwrap(attachments.first)
    XCTAssertEqual(attachment.blobID, reference.id)
    XCTAssertEqual(attachment.range, Int(position)..<Int(position) + 1)
    XCTAssertEqual(attachment.canvasSize, CanvasSize(width: 300, height: 200))
  }

  func testTwoDistinctCanvasEmbedsInOnePageBothResolveToTheirOwnBlob() throws {
    let created = try PageDocument.create(id: PageID(rawValue: "page_two"), kind: .free, title: "Two canvases")
    let firstReference = makeBlobReference(content: "first-canvas")
    let secondReference = makeBlobReference(content: "second-canvas")

    // Embed the first canvas at position 0, then the second immediately
    // after it (back-to-back placeholder characters, no plain text
    // between them) — the adversarial case for the mark-value-aware run
    // tracking in `PageDocument.plainTextAndReferences`: without value
    // comparison, two adjacent-but-distinct attachment marks could
    // wrongly merge into one reported span.
    let firstEmbed = try CanvasEmbed.embed(
      firstReference, canvasSize: CanvasSize(width: 100, height: 100), at: 0, snapshot: created.document)
    let secondEmbed = try CanvasEmbed.embed(
      secondReference, canvasSize: CanvasSize(width: 200, height: 200), at: 1, snapshot: firstEmbed.document)

    let reloaded = try PageDocument.projection(of: secondEmbed.document)
    let attachments = try CanvasEmbed.canvasAttachments(in: reloaded)

    XCTAssertEqual(attachments.count, 2, "two distinct embeds must be reported as two separate attachments")
    let sorted = attachments.sorted { $0.range.lowerBound < $1.range.lowerBound }
    XCTAssertEqual(sorted[0].blobID, firstReference.id)
    XCTAssertEqual(sorted[0].range, 0..<1)
    XCTAssertEqual(sorted[0].canvasSize, CanvasSize(width: 100, height: 100))
    XCTAssertEqual(sorted[1].blobID, secondReference.id)
    XCTAssertEqual(sorted[1].range, 1..<2)
    XCTAssertEqual(sorted[1].canvasSize, CanvasSize(width: 200, height: 200))
  }

  func testCanvasAttachmentsFiltersOutNonCanvasKindAttachments() throws {
    let created = try PageDocument.create(id: PageID(rawValue: "page_mixed"), kind: .free, title: "Mixed")
    let withImagePlaceholder = try PageDocument.insertText(
      .body, at: 0, text: CanvasEmbed.placeholder, in: created.document)
    // A hypothetical future image attachment, written directly via the
    // general mechanism this task built (not through `CanvasEmbed`, which
    // only ever writes `kind: "canvas"`) — proves `canvasAttachments`
    // really filters by kind rather than assuming every attachment on a
    // page is a canvas.
    let withImageMark = try PageDocument.addAttachmentMark(
      kind: "image", blobID: "blob_someimage", range: 0..<1, snapshot: withImagePlaceholder.document)

    let reloaded = try PageDocument.projection(of: withImageMark.document)
    XCTAssertEqual(reloaded.attachments.count, 1, "the general projection must still report the image attachment")
    XCTAssertEqual(reloaded.attachments[0].kind, "image")

    let canvasOnly = try CanvasEmbed.canvasAttachments(in: reloaded)
    XCTAssertEqual(canvasOnly.count, 0, "an image-kind attachment must not be reported as a canvas attachment")
  }

  func testAttachmentSurvivesRepeatedIndependentReloads() throws {
    // A stronger "reload" story than a single re-parse: derive the
    // projection from the same durable bytes THREE separate times, each
    // call constructing a brand-new `LoroDoc` from scratch
    // (`PageDocument.projection(of:)` -> `loadedDocument(from:)` never
    // reuses a previous call's in-memory document — see that function's
    // header), simulating relaunching the app multiple times against the
    // same persisted snapshot.
    let reference = makeBlobReference(content: "relaunch-canvas")
    let created = try CanvasEmbed.embedNewCanvasPage(
      id: PageID(rawValue: "page_relaunch"), title: "Relaunch", blobReference: reference,
      canvasSize: .defaultSize)

    for attempt in 1...3 {
      let reloaded = try PageDocument.projection(of: created.document)
      let attachments = try CanvasEmbed.canvasAttachments(in: reloaded)
      XCTAssertEqual(attachments.count, 1, "reload #\(attempt)")
      XCTAssertEqual(attachments.first?.blobID, reference.id, "reload #\(attempt)")
    }
  }
}
