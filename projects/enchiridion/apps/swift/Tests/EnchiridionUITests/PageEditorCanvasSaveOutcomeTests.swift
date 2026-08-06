// PageEditorCanvasSaveOutcomeTests.swift
// EnchiridionUITests
//
// Task #92 (adversarial-review finding, HIGH), closed: before this fix,
// `PageEditorView.handleCanvasSaved` had no way to observe whether
// `PageEditorController.updateAttachment` actually re-marked the existing
// attachment or silently no-opped (a stale `AttachmentRun` — e.g. the page
// shifted under the open canvas sheet from a local edit or a CRDT merge
// landing mid-draw). It unconditionally dismissed the sheet either way, so
// a genuinely-uploaded canvas blob could end up referenced by nothing while
// the UI told the user their edit had saved.
//
// `PageEditorAttachmentTests.testUpdateAttachmentIsANoOpWhenTheSuppliedRunNoLongerMatches`
// already covers (and must keep covering) that the CONTROLLER-level no-op
// itself is intentional and unchanged. This file covers the other half:
// that the UI LAYER now actually reacts to that outcome.
//
// A NOTE ON WHAT'S TESTED HERE VS. NOT, AND WHY (please read before
// "fixing" this by trying to assert on `canvasSheetContext` directly):
// `handleCanvasSaved` decides between two things — (1) a plain `Bool`
// RETURN VALUE, and (2) a `@State` WRITE (`canvasSheetContext = nil`) on
// success only. (1) is exactly what `PageAttachmentCanvasSheet.onSave`
// (the real caller) uses to decide whether to show its own error — real,
// caller-visible behavior, and reliably testable: it's a plain computed
// result, not persistent state. (2) was tried directly first (constructing
// a `PageEditorView`, writing `.canvasSheetContext`, calling
// `handleCanvasSaved`, then reading `.canvasSheetContext` back) and — this
// was verified empirically before writing it off, not assumed — a bare
// `@State` write-then-read on a `PageEditorView` instance constructed
// outside a live SwiftUI host does not round-trip AT ALL in this
// environment (fails even with no `handleCanvasSaved` call in between at
// all: write `.new(position: 0)`, read back `nil`). That's a property of
// this test environment's `@State` (no host/graph to install the write
// into), not of this fix, and matches this package's existing "gesture/
// View-hosting wiring is exercised by compilation only" convention (see
// `CanvasEditorView.swift`'s header) — so this file tests (1) directly,
// tests `CanvasSaveOutcome.from(didPersist:)` — the pure decision
// `handleCanvasSaved` delegates (2) to, factored out of that method's
// `@State` write specifically so it's independently unit-testable — and
// leaves the actual `canvasSheetContext = nil` assignment itself
// unverified-by-necessity, same as `CanvasEditorView`'s gesture wiring.

import EnchiridionBlobs
import EnchiridionCanvas
import EnchiridionCore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionUI

@MainActor
final class PageEditorCanvasSaveOutcomeTests: XCTestCase {
  private func makeController(title: String = "") throws -> PageEditorController {
    try PageEditorController.create(id: .free(), kind: .free, title: title)
  }

  private func makeView(controller: PageEditorController) -> PageEditorView {
    PageEditorView(controller: controller, onNavigateToReference: { _ in })
  }

  private func makeReference(blobID: String) -> BlobReference {
    BlobReference(
      id: BlobID(rawValue: blobID),
      metadata: BlobMetadata(mimeType: CanvasBlobStore.mimeType, byteCount: 0))
  }

  // MARK: - CanvasSaveOutcome (the pure decision)

  func testCanvasSaveOutcomeDismissesOnSuccess() {
    XCTAssertEqual(CanvasSaveOutcome.from(didPersist: true), .dismissSheet)
  }

  func testCanvasSaveOutcomeKeepsTheSheetOpenWithAMessageOnFailure() {
    guard case .keepSheetOpen(let message) = CanvasSaveOutcome.from(didPersist: false) else {
      return XCTFail("a failed persist must map to .keepSheetOpen, not .dismissSheet")
    }
    XCTAssertFalse(message.isEmpty, "the user must be told something, not shown a blank sheet")
  }

  // MARK: - handleCanvasSaved (the real call site, via its caller-visible return value)

  /// The regression case: `updateAttachment` reports failure (stale run),
  /// so `handleCanvasSaved` — and therefore the real `onSave` closure
  /// `PageAttachmentCanvasSheet.save()` calls — must report failure
  /// instead of silently claiming success.
  func testHandleCanvasSavedReportsFailureWhenTheUnderlyingUpdateFails() async throws {
    let controller = try makeController()
    controller.insertAttachment(
      placeholder: CanvasEmbed.placeholder, kind: CanvasAttachmentKind.canvas, blobID: "blob_v1", width: 100,
      height: 100, mimeType: nil, at: 0)
    _ = await controller.flush()

    // Mirrors `PageEditorAttachmentTests
    // .testUpdateAttachmentIsANoOpWhenTheSuppliedRunNoLongerMatches`'s
    // stale run: same range, wrong blobID, so it no longer exactly
    // matches `body.attachmentRuns`.
    let stale = AttachmentRun(range: 0..<1, kind: "canvas", blobID: "blob_does_not_match", width: nil, height: nil)
    let context = PageCanvasSheetContext.existing(stale)

    let view = makeView(controller: controller)
    let didSave = view.handleCanvasSaved(
      context: context, reference: makeReference(blobID: "blob_v2_newly_uploaded"),
      canvasSize: CanvasSize(width: 10, height: 10))

    XCTAssertFalse(
      didSave,
      "handleCanvasSaved must report failure (not silently succeed) when the controller-level update was a no-op — this is exactly the value PageAttachmentCanvasSheet.save() checks before showing its own error")
    // The controller-level guarantee this file's sibling already covers,
    // reasserted here for the specific instance this test drives: the
    // failed attempt didn't create a second/duplicate attachment or
    // clobber the existing one.
    XCTAssertEqual(controller.projection.attachments.count, 1)
    XCTAssertEqual(controller.projection.attachments.first?.blobID, "blob_v1")
  }

  /// The non-regressed happy path: a run that DOES still match must still
  /// report success, exactly as before this fix.
  func testHandleCanvasSavedReportsSuccessWhenTheUnderlyingUpdateSucceeds() async throws {
    let controller = try makeController()
    controller.insertAttachment(
      placeholder: CanvasEmbed.placeholder, kind: CanvasAttachmentKind.canvas, blobID: "blob_v1", width: 100,
      height: 100, mimeType: nil, at: 0)
    _ = await controller.flush()
    let original = try XCTUnwrap(controller.body.attachmentRuns.first)
    let context = PageCanvasSheetContext.existing(original)

    let view = makeView(controller: controller)
    let didSave = view.handleCanvasSaved(
      context: context, reference: makeReference(blobID: "blob_v2"), canvasSize: CanvasSize(width: 10, height: 10))

    XCTAssertTrue(didSave)
    // `body.attachmentRuns` reflects the local, synchronous edit
    // immediately — matches `PageEditorAttachmentTests`' own convention
    // of asserting local state without needing an extra `flush()`.
    XCTAssertEqual(controller.body.attachmentRuns.first?.blobID, "blob_v2")
  }

  /// The `.new` (insert, not update) path never goes through
  /// `updateAttachment` at all — there is no existing run to go stale —
  /// so it must always report success.
  func testHandleCanvasSavedForANewCanvasAlwaysReportsSuccess() throws {
    let controller = try makeController()
    let context = PageCanvasSheetContext.new(position: 0)

    let view = makeView(controller: controller)
    let didSave = view.handleCanvasSaved(
      context: context, reference: makeReference(blobID: "blob_new"), canvasSize: CanvasSize(width: 10, height: 10))

    XCTAssertTrue(didSave)
    XCTAssertEqual(controller.body.attachmentRuns.first?.blobID, "blob_new")
  }
}
