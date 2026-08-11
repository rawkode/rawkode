// CanvasEditorViewModelTests.swift
// EnchiridionCanvasTests
//
// Exercises `CanvasEditorViewModel`'s gesture-driven capture logic
// directly — no SwiftUI, no simulator, just calling the same
// begin/update/end methods `CanvasEditorView`'s real `DragGesture`
// callbacks would call. See that view model's header for why it's kept
// SwiftUI-free specifically so this is possible.

import XCTest

@testable import EnchiridionCanvas

@MainActor
final class CanvasEditorViewModelTests: XCTestCase {
  func testPenToolCommitsAStrokeOnDragEnd() {
    let viewModel = CanvasEditorViewModel(activeTool: .pen)
    XCTAssertNil(viewModel.draftElement)
    XCTAssertEqual(viewModel.elements.count, 0)

    viewModel.beginStroke(at: CanvasPoint(x: 0, y: 0))
    XCTAssertNotNil(viewModel.draftElement, "a draft should exist mid-drag")
    XCTAssertEqual(viewModel.elements.count, 0, "nothing committed to history until the drag ends")

    viewModel.updateStroke(to: CanvasPoint(x: 10, y: 0))
    viewModel.updateStroke(to: CanvasPoint(x: 10, y: 10))
    viewModel.endStroke()

    XCTAssertNil(viewModel.draftElement, "the draft is cleared once committed")
    XCTAssertEqual(viewModel.elements.count, 1)
    guard case .stroke(let stroke) = viewModel.elements[0] else {
      return XCTFail("expected a stroke element")
    }
    XCTAssertEqual(
      stroke.points,
      [CanvasPoint(x: 0, y: 0), CanvasPoint(x: 10, y: 0), CanvasPoint(x: 10, y: 10)])
  }

  func testDegenerateStrokeSinglePointIsNotCommitted() {
    let viewModel = CanvasEditorViewModel(activeTool: .pen)
    viewModel.beginStroke(at: CanvasPoint(x: 5, y: 5))
    viewModel.endStroke()  // no updateStroke call — a tap, not a drag

    XCTAssertEqual(viewModel.elements.count, 0, "a single-point stroke must not be committed")
    XCTAssertNil(viewModel.draftElement)
  }

  func testRectangleToolNormalizesFrameRegardlessOfDragDirection() {
    let viewModel = CanvasEditorViewModel(activeTool: .rectangle)
    // Drag from bottom-right to top-left — origin/size must still come
    // out as a normalized (non-negative-size) frame.
    viewModel.beginStroke(at: CanvasPoint(x: 50, y: 50))
    viewModel.updateStroke(to: CanvasPoint(x: 10, y: 20))
    viewModel.endStroke()

    XCTAssertEqual(viewModel.elements.count, 1)
    guard case .rectangle(let rectangle) = viewModel.elements[0] else {
      return XCTFail("expected a rectangle element")
    }
    XCTAssertEqual(rectangle.origin, CanvasPoint(x: 10, y: 20))
    XCTAssertEqual(rectangle.size, CanvasSize(width: 40, height: 30))
  }

  func testDegenerateRectangleZeroSizeIsNotCommitted() {
    let viewModel = CanvasEditorViewModel(activeTool: .rectangle)
    viewModel.beginStroke(at: CanvasPoint(x: 5, y: 5))
    viewModel.endStroke()  // never moved -> zero-size frame

    XCTAssertEqual(viewModel.elements.count, 0)
  }

  func testEllipseToolCommitsANormalizedFrame() {
    let viewModel = CanvasEditorViewModel(activeTool: .ellipse)
    viewModel.beginStroke(at: CanvasPoint(x: 0, y: 0))
    viewModel.updateStroke(to: CanvasPoint(x: 20, y: 20))
    viewModel.endStroke()

    guard case .ellipse(let ellipse) = viewModel.elements[0] else {
      return XCTFail("expected an ellipse element")
    }
    XCTAssertEqual(ellipse.origin, CanvasPoint(x: 0, y: 0))
    XCTAssertEqual(ellipse.size, CanvasSize(width: 20, height: 20))
  }

  func testLineToolTracksStartAndEnd() {
    let viewModel = CanvasEditorViewModel(activeTool: .line)
    viewModel.beginStroke(at: CanvasPoint(x: 1, y: 2))
    viewModel.updateStroke(to: CanvasPoint(x: 3, y: 4))
    viewModel.updateStroke(to: CanvasPoint(x: 5, y: 6))
    viewModel.endStroke()

    guard case .line(let line) = viewModel.elements[0] else {
      return XCTFail("expected a line element")
    }
    XCTAssertEqual(line.start, CanvasPoint(x: 1, y: 2), "start must stay fixed at the drag's origin")
    XCTAssertEqual(line.end, CanvasPoint(x: 5, y: 6), "end must track the latest drag point")
  }

  func testArrowToolCommitsAnArrowNotALine() {
    let viewModel = CanvasEditorViewModel(activeTool: .arrow)
    viewModel.beginStroke(at: CanvasPoint(x: 0, y: 0))
    viewModel.updateStroke(to: CanvasPoint(x: 10, y: 0))
    viewModel.endStroke()

    guard case .arrow = viewModel.elements[0] else {
      return XCTFail("expected an arrow element, not a line")
    }
  }

  func testDegenerateLineZeroLengthIsNotCommitted() {
    let viewModel = CanvasEditorViewModel(activeTool: .line)
    viewModel.beginStroke(at: CanvasPoint(x: 5, y: 5))
    viewModel.updateStroke(to: CanvasPoint(x: 5, y: 5))
    viewModel.endStroke()

    XCTAssertEqual(viewModel.elements.count, 0)
  }

  func testPanAndSelectToolsNeverCreateADraft() {
    for tool: CanvasTool in [.pan, .select] {
      let viewModel = CanvasEditorViewModel(activeTool: tool)
      viewModel.beginStroke(at: CanvasPoint(x: 0, y: 0))
      XCTAssertNil(viewModel.draftElement, "\(tool) must not start a draft")
      viewModel.updateStroke(to: CanvasPoint(x: 10, y: 10))
      viewModel.endStroke()
      XCTAssertEqual(viewModel.elements.count, 0, "\(tool) must never commit an element")
    }
  }

  func testCancelStrokeDiscardsTheDraftWithoutCommitting() {
    let viewModel = CanvasEditorViewModel(activeTool: .pen)
    viewModel.beginStroke(at: CanvasPoint(x: 0, y: 0))
    viewModel.updateStroke(to: CanvasPoint(x: 10, y: 10))
    viewModel.cancelStroke()

    XCTAssertNil(viewModel.draftElement)
    XCTAssertEqual(viewModel.elements.count, 0)
  }

  func testCommitTextAddsATextElementAndIgnoresEmptyContent() {
    let viewModel = CanvasEditorViewModel(activeTool: .text)
    viewModel.commitText("", at: CanvasPoint(x: 1, y: 1))
    XCTAssertEqual(viewModel.elements.count, 0, "empty text must not be committed")

    viewModel.commitText("hello", at: CanvasPoint(x: 3, y: 4))
    XCTAssertEqual(viewModel.elements.count, 1)
    guard case .text(let text) = viewModel.elements[0] else {
      return XCTFail("expected a text element")
    }
    XCTAssertEqual(text.content, "hello")
    XCTAssertEqual(text.position, CanvasPoint(x: 3, y: 4))
  }

  func testUndoRedoDelegatesToHistory() {
    let viewModel = CanvasEditorViewModel(activeTool: .pen)
    viewModel.beginStroke(at: CanvasPoint(x: 0, y: 0))
    viewModel.updateStroke(to: CanvasPoint(x: 1, y: 1))
    viewModel.endStroke()
    XCTAssertEqual(viewModel.elements.count, 1)
    XCTAssertTrue(viewModel.canUndo)

    XCTAssertTrue(viewModel.undo())
    XCTAssertEqual(viewModel.elements.count, 0)
    XCTAssertTrue(viewModel.canRedo)

    XCTAssertTrue(viewModel.redo())
    XCTAssertEqual(viewModel.elements.count, 1)
  }

  func testLoadDocumentReplacesStateAndClearsHistory() {
    let viewModel = CanvasEditorViewModel(activeTool: .pen)
    viewModel.beginStroke(at: CanvasPoint(x: 0, y: 0))
    viewModel.updateStroke(to: CanvasPoint(x: 1, y: 1))
    viewModel.endStroke()
    XCTAssertTrue(viewModel.canUndo)

    let loaded = CanvasDocument(
      canvasSize: CanvasSize(width: 500, height: 400),
      elements: [.text(CanvasText(position: CanvasPoint(x: 0, y: 0), content: "loaded"))]
    )
    viewModel.loadDocument(loaded)

    XCTAssertEqual(viewModel.canvasSize, CanvasSize(width: 500, height: 400))
    XCTAssertEqual(viewModel.elements.count, 1)
    XCTAssertFalse(viewModel.canUndo, "loading a document starts a fresh history")
    XCTAssertFalse(viewModel.canRedo)
  }

  // MARK: - Pan math (task #92, adversarial-review finding, MEDIUM)

  /// `CanvasEditorView.panGesture`'s gesture WIRING has no simulator/host
  /// app in this environment to drive it (see `CanvasEditorView.swift`'s
  /// header — the same constraint that keeps this whole test file
  /// SwiftUI-free), so a live `DragGesture` value genuinely can't be
  /// constructed here. What CAN be tested directly is the pure coordinate
  /// conversion the fix hinges on: `CanvasEditorView.panOffsetDelta`,
  /// factored out of the gesture closures specifically so this is
  /// possible — see that function's doc comment for the full
  /// scale-vs-offset-space reasoning.
  func testPanOffsetDeltaMatchesTranslationAtUnitZoom() {
    let delta = CanvasEditorView.panOffsetDelta(translation: CGSize(width: 40, height: -15), scale: 1)
    XCTAssertEqual(delta, CGSize(width: 40, height: -15), "at 1.0 zoom, screen-space offset must equal the raw translation")
  }

  /// Zoomed in: `translation` arrives inverse-scaled (SwiftUI reports a
  /// smaller value inside a magnified subtree for the same physical
  /// drag), so recovering the correct screen-space `offset` delta means
  /// scaling back UP by the current zoom factor.
  func testPanOffsetDeltaScalesUpWhenZoomedIn() {
    let delta = CanvasEditorView.panOffsetDelta(translation: CGSize(width: 25, height: 10), scale: 2)
    XCTAssertEqual(delta, CGSize(width: 50, height: 20), "a 2x zoom must double the inverse-scaled translation back to screen space")
  }

  /// Zoomed out: the inverse relationship in the other direction — a
  /// smaller scale must shrink the delta, not leave it as an overshoot.
  func testPanOffsetDeltaScalesDownWhenZoomedOut() {
    let delta = CanvasEditorView.panOffsetDelta(translation: CGSize(width: 100, height: -40), scale: 0.5)
    XCTAssertEqual(delta, CGSize(width: 50, height: -20), "a 0.5x zoom must halve the translation, not apply it 1:1")
  }

  /// Repeated pans at different zoom levels must each convert
  /// independently and simply add — proving the fix doesn't merely patch
  /// a single call but keeps behaving correctly as `offset` accumulates
  /// across multiple drags (the "compounds across repeated pans" failure
  /// mode the finding called out).
  func testPanOffsetDeltaAccumulatesCorrectlyAcrossZoomChanges() {
    var offset = CGSize.zero
    let firstDelta = CanvasEditorView.panOffsetDelta(translation: CGSize(width: 10, height: 0), scale: 2)
    offset.width += firstDelta.width
    offset.height += firstDelta.height

    let secondDelta = CanvasEditorView.panOffsetDelta(translation: CGSize(width: 10, height: 0), scale: 0.5)
    offset.width += secondDelta.width
    offset.height += secondDelta.height

    XCTAssertEqual(offset, CGSize(width: 25, height: 0), "20 (2x) + 5 (0.5x) must combine to a consistent screen-space total")
  }

  func testDocumentPropertyReflectsCurrentSessionState() {
    let viewModel = CanvasEditorViewModel(canvasSize: CanvasSize(width: 200, height: 100), activeTool: .pen)
    viewModel.beginStroke(at: CanvasPoint(x: 0, y: 0))
    viewModel.updateStroke(to: CanvasPoint(x: 1, y: 1))
    viewModel.endStroke()

    let document = viewModel.document
    XCTAssertEqual(document.canvasSize, CanvasSize(width: 200, height: 100))
    XCTAssertEqual(document.elements.count, 1)
  }
}
