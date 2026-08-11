// CanvasEditorViewModel.swift
// EnchiridionCanvas
//
// The canvas editor's gesture-driven capture logic, deliberately kept
// framework-agnostic (no `import SwiftUI`/`Canvas`/`Path` here) so it's
// directly unit-testable without a simulator/host app — same split this
// codebase already established for `PageEditorController`
// (EnchiridionUI) vs. `PageEditorView`: the *logic* of "what does a
// drag do to the document" lives here; `CanvasEditorView.swift` is the
// thin SwiftUI layer translating real `DragGesture`/`MagnificationGesture`
// callbacks into calls on this type.
//
// GESTURE MODEL (task brief: "think through both platforms' real input
// models ... before committing to an architecture"):
//   - `beginStroke`/`updateStroke`/`endStroke` are driven by a single
//     `DragGesture` per tool-draw gesture. `DragGesture` is the right
//     primitive on BOTH platforms for this, not a touch-only compromise:
//     on iOS it fires for a finger OR Apple Pencil drag identically (no
//     PencilKit needed — SwiftUI's `DragGesture` already unifies touch
//     and pencil input at this level); on macOS it fires for a
//     mouse-button-down-drag. Neither platform's `DragGesture` behavior
//     needed conditional code.
//   - Pan/zoom (`CanvasEditorView`'s `MagnificationGesture` +
//     `.pan`-tool `DragGesture`) is a SEPARATE gesture from element
//     drawing, not layered ambiguity: a two-finger trackpad pinch (macOS)
//     or two-finger pinch (iPad) drives `MagnificationGesture`
//     independently of whichever single-touch/mouse `DragGesture` is
//     active, and panning while drawing is a tool switch (`.pan`), not a
//     simultaneous gesture — see `CanvasEditorView.swift`'s header for
//     why an explicit pan tool (matching Excalidraw/Freeform's own
//     convention) was chosen over trying to disambiguate "one-finger drag
//     to pan" from "one-finger drag to draw" implicitly.

import Foundation
import Observation

/// The active drawing/interaction mode. `.select` exists as a placeholder
/// for a future "move an existing element" interaction — NOT implemented
/// in this pass (see this module's README "What's deferred" section):
/// v1's explicit feature list (plan: "freehand strokes + basic shapes
/// ... + text labels + pan/zoom + undo/redo") never asked for
/// select-and-move/resize of already-committed elements, only for
/// creating new ones and undoing mistakes, so `.select` currently has no
/// wired behavior — choosing it just means no tool draws anything, same
/// as `.pan`.
public enum CanvasTool: String, CaseIterable, Sendable, Identifiable {
  case select
  case pan
  case pen
  case rectangle
  case ellipse
  case line
  case arrow
  case text

  public var id: String { rawValue }

  /// Display name for a tool picker.
  public var displayName: String {
    switch self {
    case .select: "Select"
    case .pan: "Pan"
    case .pen: "Pen"
    case .rectangle: "Rectangle"
    case .ellipse: "Ellipse"
    case .line: "Line"
    case .arrow: "Arrow"
    case .text: "Text"
    }
  }
}

/// The canvas editor's mutable session state: undo/redo history, the
/// active tool/style, and whatever element is mid-drag (`draftElement`).
///
/// `@MainActor` + `@Observable` (the `Observation` framework — NOT
/// SwiftUI; a plain, host-app-independent module usable from any test
/// target) reference type: `CanvasEditorView` drives this directly from
/// gesture callbacks, which always run on the main actor, and observes
/// its property changes to redraw. Making this a class (not a `View`'s
/// `@State` struct) is what lets `Tests/EnchiridionCanvasTests/
/// CanvasEditorViewModelTests.swift` drive the exact same
/// gesture-callback sequence a real drag would, without any SwiftUI
/// machinery — `@Observable` doesn't change that; it's inert outside a
/// SwiftUI view body.
@MainActor
@Observable
public final class CanvasEditorViewModel {
  public var canvasSize: CanvasSize
  public private(set) var history: CanvasHistory
  public var activeTool: CanvasTool
  public var style: CanvasStrokeStyle

  /// The element currently being drawn (a drag in progress) — not yet in
  /// `history.current`. `CanvasEditorView` renders this as a live preview
  /// layered on top of the committed elements.
  public private(set) var draftElement: CanvasElement?
  private var dragStart: CanvasPoint?

  public init(
    canvasSize: CanvasSize = .defaultSize,
    elements: [CanvasElement] = [],
    activeTool: CanvasTool = .pen,
    style: CanvasStrokeStyle = .default
  ) {
    self.canvasSize = canvasSize
    self.history = CanvasHistory(elements: elements)
    self.activeTool = activeTool
    self.style = style
  }

  public var elements: [CanvasElement] { history.current }
  public var canUndo: Bool { history.canUndo }
  public var canRedo: Bool { history.canRedo }

  @discardableResult
  public func undo() -> Bool { history.undo() }

  @discardableResult
  public func redo() -> Bool { history.redo() }

  // MARK: - Drag-driven capture (pen/rectangle/ellipse/line/arrow)

  /// A drag gesture began at `point` (canvas-space, already un-transformed
  /// from the view's pan/zoom — see `CanvasEditorView`'s coordinate
  /// conversion). Starts a fresh draft appropriate to `activeTool`.
  /// No-op for `.select`/`.pan`/`.text` — none of those create a draft
  /// from a drag start (`.text` commits via `commitText(_:at:)` from a
  /// tap, not a drag).
  public func beginStroke(at point: CanvasPoint) {
    dragStart = point
    switch activeTool {
    case .pen:
      draftElement = .stroke(CanvasStroke(points: [point], style: style))
    case .rectangle:
      draftElement = .rectangle(CanvasShape(origin: point, size: CanvasSize(width: 0, height: 0), style: style))
    case .ellipse:
      draftElement = .ellipse(CanvasShape(origin: point, size: CanvasSize(width: 0, height: 0), style: style))
    case .line:
      draftElement = .line(CanvasLineSegment(start: point, end: point, style: style))
    case .arrow:
      draftElement = .arrow(CanvasLineSegment(start: point, end: point, style: style))
    case .text, .select, .pan:
      draftElement = nil
    }
  }

  /// The drag continued to `point`. Reshapes the in-progress draft.
  /// No-op if `beginStroke` wasn't called first (or the tool doesn't
  /// draft).
  public func updateStroke(to point: CanvasPoint) {
    guard let draft = draftElement else { return }
    switch draft {
    case .stroke(var stroke):
      stroke.points.append(point)
      draftElement = .stroke(stroke)
    case .rectangle(var shape):
      guard let start = dragStart else { return }
      let frame = Self.normalizedFrame(from: start, to: point)
      shape.origin = frame.origin
      shape.size = frame.size
      draftElement = .rectangle(shape)
    case .ellipse(var shape):
      guard let start = dragStart else { return }
      let frame = Self.normalizedFrame(from: start, to: point)
      shape.origin = frame.origin
      shape.size = frame.size
      draftElement = .ellipse(shape)
    case .line(var segment):
      segment.end = point
      draftElement = .line(segment)
    case .arrow(var segment):
      segment.end = point
      draftElement = .arrow(segment)
    case .text:
      break
    }
  }

  /// The drag ended. Commits the draft to `history` as one undoable
  /// action, unless it's degenerate (see `isDegenerate`) — an accidental
  /// tap/click shouldn't leave an invisible element in the document or a
  /// no-op undo step.
  public func endStroke() {
    defer {
      draftElement = nil
      dragStart = nil
    }
    guard let draft = draftElement, !Self.isDegenerate(draft) else { return }
    history.addElement(draft)
  }

  /// Discards the in-progress draft without committing it (e.g. the
  /// platform reports the gesture was cancelled).
  public func cancelStroke() {
    draftElement = nil
    dragStart = nil
  }

  private static func isDegenerate(_ element: CanvasElement) -> Bool {
    switch element {
    case .stroke(let value): value.points.count < 2
    case .rectangle(let value), .ellipse(let value): value.size.width == 0 || value.size.height == 0
    case .line(let value), .arrow(let value): value.start == value.end
    case .text: false
    }
  }

  private static func normalizedFrame(
    from a: CanvasPoint, to b: CanvasPoint
  ) -> (origin: CanvasPoint, size: CanvasSize) {
    let origin = CanvasPoint(x: min(a.x, b.x), y: min(a.y, b.y))
    let size = CanvasSize(width: abs(a.x - b.x), height: abs(a.y - b.y))
    return (origin, size)
  }

  // MARK: - Text tool

  /// Commits a text element at `point` with `content` as one undoable
  /// action. Driven by a tap-to-place-then-type interaction
  /// (`CanvasEditorView`'s inline text-entry overlay), not a drag, so it
  /// doesn't go through `beginStroke`/`updateStroke`/`endStroke`.
  public func commitText(_ content: String, at point: CanvasPoint) {
    guard !content.isEmpty else { return }
    history.addElement(
      .text(CanvasText(position: point, content: content, fontSize: 17, color: style.strokeColor)))
  }

  /// Replaces the entire element list in one non-undoable step — for
  /// loading a downloaded `CanvasDocument` into a fresh editor session
  /// (there is nothing meaningful to "undo" back to before content
  /// loaded).
  public func loadDocument(_ document: CanvasDocument) {
    canvasSize = document.canvasSize
    history = CanvasHistory(elements: document.elements)
    draftElement = nil
    dragStart = nil
  }

  /// The current session state as a `CanvasDocument`, ready for
  /// `CanvasBlobStore.upload`.
  public var document: CanvasDocument {
    CanvasDocument(canvasSize: canvasSize, elements: elements)
  }
}
