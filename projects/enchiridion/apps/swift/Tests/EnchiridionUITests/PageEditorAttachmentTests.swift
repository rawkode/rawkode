// PageEditorAttachmentTests.swift
// EnchiridionUITests
//
// Task #85 (P7 integration wave). Real, non-hollow coverage for the canvas
// attachment wiring added to `PageEditorBody`/`PageEditorController`:
//   - `PageEditorController.insertAttachment(...)` queues a real
//     `PendingBodyOp.attachment` op that survives `flush()` and round-trips
//     through `PageDocumentProjection.attachments` (via the REAL
//     `PageDocument.addAttachmentMark` — no mocking, matching this file's
//     sibling `PageEditorControllerTests.swift`'s existing convention).
//   - `PageEditorController.updateAttachment(...)` re-marks an EXISTING
//     attachment's range in place.
//   - `PageEditorBody.from(projection:)` reconstructs `attachmentRuns`
//     EXACTLY (unlike `referenceRuns`'s fallback-label re-matching) after a
//     full snapshot round-trip (simulating a relaunch — a fresh
//     `PageEditorController` opened against the flushed `durableDocument`).
//   - Editing around an attachment (insert before/after, delete through it)
//     shifts/breaks its `AttachmentRun` correctly, mirroring
//     `PageEditorBodyTests.swift`'s existing reference-run coverage for the
//     identical class of edit.
//
// Uses the REAL `EnchiridionCanvas.CanvasEmbed.placeholder`/
// `CanvasAttachmentKind.canvas` constants (not ad hoc string literals) —
// this target now depends on `EnchiridionCanvas` (Package.swift, task #85)
// specifically so these tests exercise the exact same vocabulary
// `PageEditorView`'s real "Insert Canvas" action uses, not a parallel
// stand-in that could silently drift from it.

import EnchiridionCanvas
import EnchiridionCore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionUI

@MainActor
final class PageEditorAttachmentTests: XCTestCase {
  private func makeController(title: String = "") throws -> PageEditorController {
    try PageEditorController.create(id: .free(), kind: .free, title: title)
  }

  // MARK: - Insert

  func testInsertAttachmentQueuesAPlaceholderAndAttachmentMarkThatSurviveFlush() async throws {
    let controller = try makeController()
    controller.insertText("Notes: ", at: 0)

    controller.insertAttachment(
      placeholder: CanvasEmbed.placeholder, kind: CanvasAttachmentKind.canvas, blobID: "blob_abc123",
      width: 200, height: 150, mimeType: CanvasBlobStore.mimeType, at: controller.body.length)

    XCTAssertTrue(controller.isDirty)
    // Local preview already reflects the placeholder + attachment run
    // before any flush — matches every other local-edit method's
    // "cheap, synchronous, in-memory" contract (this file's own header).
    XCTAssertEqual(controller.body.text, "Notes: \u{FFFC}")
    XCTAssertEqual(controller.body.attachmentRuns.count, 1)
    let localRun = try XCTUnwrap(controller.body.attachmentRuns.first)
    XCTAssertEqual(localRun.range, 7..<8)
    XCTAssertEqual(localRun.kind, "canvas")
    XCTAssertEqual(localRun.blobID, "blob_abc123")
    XCTAssertEqual(localRun.width, 200)
    XCTAssertEqual(localRun.height, 150)

    let flushed = await controller.flush()
    XCTAssertTrue(flushed)
    XCTAssertNil(controller.lastFlushError)

    XCTAssertEqual(controller.projection.attachments.count, 1)
    let attachment = try XCTUnwrap(controller.projection.attachments.first)
    XCTAssertEqual(attachment.kind, "canvas")
    XCTAssertEqual(attachment.blobID, "blob_abc123")
    XCTAssertEqual(attachment.range, 7..<8)
    XCTAssertEqual(attachment.width, 200)
    XCTAssertEqual(attachment.height, 150)
    XCTAssertEqual(attachment.mimeType, CanvasBlobStore.mimeType)
  }

  /// The relaunch case: a fresh `PageEditorController` opened against the
  /// flushed `durableDocument` bytes must reconstruct the identical
  /// `AttachmentRun` via `PageEditorBody.from(projection:)` — EXACT
  /// reconstruction, since `PageAttachment.range` is a real stored range
  /// (unlike `ReferenceRun`'s label-based approximation).
  func testAttachmentSurvivesADocumentSnapshotRoundTrip() async throws {
    let controller = try makeController()
    controller.insertAttachment(
      placeholder: CanvasEmbed.placeholder, kind: CanvasAttachmentKind.canvas, blobID: "blob_roundtrip",
      width: 1024, height: 768, mimeType: CanvasBlobStore.mimeType, at: 0)
    _ = await controller.flush()

    let reopened = try PageEditorController(pageID: controller.pageID, document: controller.durableDocument)

    XCTAssertEqual(reopened.body.attachmentRuns.count, 1)
    let run = try XCTUnwrap(reopened.body.attachmentRuns.first)
    XCTAssertEqual(run.range, 0..<1)
    XCTAssertEqual(run.kind, "canvas")
    XCTAssertEqual(run.blobID, "blob_roundtrip")
    XCTAssertEqual(run.width, 1024)
    XCTAssertEqual(run.height, 768)
  }

  // MARK: - Update

  func testUpdateAttachmentReMarksTheExistingRangeWithNewContent() async throws {
    let controller = try makeController()
    controller.insertAttachment(
      placeholder: CanvasEmbed.placeholder, kind: CanvasAttachmentKind.canvas, blobID: "blob_v1", width: 100,
      height: 100, mimeType: CanvasBlobStore.mimeType, at: 0)
    _ = await controller.flush()
    let original = try XCTUnwrap(controller.body.attachmentRuns.first)

    controller.updateAttachment(original, blobID: "blob_v2", width: 300, height: 250, mimeType: CanvasBlobStore.mimeType)
    let flushed = await controller.flush()

    XCTAssertTrue(flushed)
    XCTAssertEqual(controller.projection.attachments.count, 1, "updating must re-mark the SAME range, not add a second attachment")
    let attachment = try XCTUnwrap(controller.projection.attachments.first)
    XCTAssertEqual(attachment.range, 0..<1)
    XCTAssertEqual(attachment.blobID, "blob_v2")
    XCTAssertEqual(attachment.width, 300)
    XCTAssertEqual(attachment.height, 250)
  }

  func testUpdateAttachmentIsANoOpWhenTheSuppliedRunNoLongerMatches() async throws {
    let controller = try makeController()
    controller.insertAttachment(
      placeholder: CanvasEmbed.placeholder, kind: CanvasAttachmentKind.canvas, blobID: "blob_v1", width: 100,
      height: 100, mimeType: nil, at: 0)
    _ = await controller.flush()

    let stale = AttachmentRun(range: 0..<1, kind: "canvas", blobID: "blob_does_not_match", width: nil, height: nil)
    controller.updateAttachment(stale, blobID: "blob_v2", width: nil, height: nil, mimeType: nil)

    XCTAssertFalse(controller.isDirty, "a stale/mismatched attachment reference must not queue a write")
  }

  /// Adversarial-review coverage gap, closed: insert THEN update the SAME
  /// not-yet-flushed attachment, then flush ONCE — proves two `.attachment`
  /// `PendingBodyOp`s targeting the identical range (queued back to back,
  /// never separately flushed) replay correctly through
  /// `PageDocument.addAttachmentMark`'s "just as valid re-applied over an
  /// already-marked range as over a freshly inserted one" claim — not just
  /// across two independent flushes (`testUpdateAttachmentReMarksTheExistingRangeWithNewContent`
  /// above only proves that weaker case).
  func testInsertThenUpdateBeforeAnyFlushStillPersistsOnlyTheFinalContent() async throws {
    let controller = try makeController()
    controller.insertAttachment(
      placeholder: CanvasEmbed.placeholder, kind: CanvasAttachmentKind.canvas, blobID: "blob_v1", width: 10,
      height: 10, mimeType: nil, at: 0)
    let insertedRun = try XCTUnwrap(controller.body.attachmentRuns.first)
    XCTAssertEqual(insertedRun.blobID, "blob_v1", "the local preview must already reflect the insert before any flush")

    controller.updateAttachment(insertedRun, blobID: "blob_v2", width: 999, height: 999, mimeType: nil)
    XCTAssertEqual(controller.body.attachmentRuns.first?.blobID, "blob_v2")

    let flushed = await controller.flush()

    XCTAssertTrue(flushed)
    XCTAssertNil(controller.lastFlushError)
    XCTAssertEqual(
      controller.projection.attachments.count, 1,
      "two `.attachment` ops over the same range in one flush must not produce two attachments")
    let attachment = try XCTUnwrap(controller.projection.attachments.first)
    XCTAssertEqual(attachment.blobID, "blob_v2", "the LATER mark must win, matching this file's own real edit order")
    XCTAssertEqual(attachment.width, 999)
  }

  /// Adversarial-review coverage gap, closed: insert an attachment, then —
  /// before any flush — delete the range it occupies, then flush once.
  /// Proves the delete-before-first-flush case (not just the already-tested
  /// pure-`PageEditorBody`-level `applyingDelete` math) actually round-trips
  /// through a real `PageDocument` snapshot: no orphaned attachment, no
  /// crash from marking a range that a later-queued-but-earlier-replayed op
  /// already removed.
  func testInsertThenDeleteBeforeAnyFlushLeavesNoAttachment() async throws {
    let controller = try makeController()
    controller.insertAttachment(
      placeholder: CanvasEmbed.placeholder, kind: CanvasAttachmentKind.canvas, blobID: "blob_v1", width: 10,
      height: 10, mimeType: nil, at: 0)
    XCTAssertEqual(controller.body.attachmentRuns.count, 1)

    controller.deleteText(range: 0..<1)
    XCTAssertTrue(
      controller.body.attachmentRuns.isEmpty, "the local preview must already drop the run before any flush")

    let flushed = await controller.flush()

    XCTAssertTrue(flushed)
    XCTAssertNil(controller.lastFlushError)
    XCTAssertTrue(controller.projection.attachments.isEmpty)
    XCTAssertEqual(controller.body.text, "")
  }

  // MARK: - Editing around an attachment (mirrors PageEditorBodyTests' reference-run coverage)

  func testInsertBeforeAnAttachmentShiftsItsRange() {
    let body = PageEditorBody(
      text: "\u{FFFC}", attachmentRuns: [AttachmentRun(range: 0..<1, kind: "canvas", blobID: "b1")])
    let outcome = body.applyingInsert(text: "Hi ", at: 0)
    XCTAssertEqual(outcome.body.text, "Hi \u{FFFC}")
    XCTAssertEqual(outcome.body.attachmentRuns, [AttachmentRun(range: 3..<4, kind: "canvas", blobID: "b1")])
  }

  func testInsertAfterAnAttachmentDoesNotShiftIt() {
    let body = PageEditorBody(
      text: "\u{FFFC}", attachmentRuns: [AttachmentRun(range: 0..<1, kind: "canvas", blobID: "b1")])
    let outcome = body.applyingInsert(text: " world", at: 1)
    XCTAssertEqual(outcome.body.text, "\u{FFFC} world")
    XCTAssertEqual(outcome.body.attachmentRuns, [AttachmentRun(range: 0..<1, kind: "canvas", blobID: "b1")])
  }

  func testDeletingThroughAnAttachmentRemovesItsRun() {
    let body = PageEditorBody(
      text: "a\u{FFFC}b", attachmentRuns: [AttachmentRun(range: 1..<2, kind: "canvas", blobID: "b1")])
    let outcome = body.applyingDelete(range: 0..<2)
    XCTAssertEqual(outcome.body.text, "b")
    XCTAssertTrue(outcome.body.attachmentRuns.isEmpty)
  }

  func testDeletingBeforeAnAttachmentShiftsItWithoutRemovingIt() {
    let body = PageEditorBody(
      text: "ab\u{FFFC}", attachmentRuns: [AttachmentRun(range: 2..<3, kind: "canvas", blobID: "b1")])
    let outcome = body.applyingDelete(range: 0..<1)
    XCTAssertEqual(outcome.body.text, "b\u{FFFC}")
    XCTAssertEqual(outcome.body.attachmentRuns, [AttachmentRun(range: 1..<2, kind: "canvas", blobID: "b1")])
  }

  // MARK: - Reconstruction from a projection (PageEditorBody.from(projection:))

  func testFromProjectionReconstructsAttachmentRunsExactly() {
    let pageID = PageID.free()
    let projection = PageDocumentProjection(
      title: "Sketch", plainText: "See \u{FFFC} above", deletedAt: nil, isPinned: false, references: [],
      attachments: [
        PageAttachment(
          sourcePageID: pageID, kind: "canvas", blobID: "blob_x", range: 4..<5, width: 640, height: 480,
          mimeType: "application/vnd.enchiridion.canvas+json")
      ],
      graphEdges: [], objectMetadata: .init(supertagIDs: []))
    let body = PageEditorBody.from(projection: projection)
    XCTAssertEqual(body.attachmentRuns.count, 1)
    let run = try? XCTUnwrap(body.attachmentRuns.first)
    XCTAssertEqual(run?.range, 4..<5)
    XCTAssertEqual(run?.blobID, "blob_x")
    XCTAssertEqual(run?.width, 640)
    XCTAssertEqual(run?.height, 480)
  }
}
