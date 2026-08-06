// CanvasHistory.swift
// EnchiridionCanvas
//
// Undo/redo over a canvas's element list — P7 "native drawing canvas"
// task's "undo/redo" requirement (plan §Core Product UI (P7), track 5:
// "v1 is explicitly scoped to freehand strokes + basic shapes ... undo").
//
// DESIGN: whole-array snapshots on the undo/redo stacks, not per-operation
// commands with inverses. For the element counts a hand-drawn v1 canvas
// realistically has (tens to low hundreds — this is a page-embedded sketch
// tool, not a CAD program), the memory/CPU cost of copying the elements
// array per action is negligible, and it buys a correctness property a
// command/inverse-command design has to work much harder for: "undo N
// times then redo M times lands on exactly the state before/after the
// Nth/Mth action" is true by construction for snapshot-based history (each
// stack entry literally IS that state), whereas a command-based design has
// an entire extra class of bug (an incorrectly-invertible command) this
// sidesteps outright. `Tests/EnchiridionCanvasTests/CanvasHistoryTests
// .swift` proves the exact-state-at-each-step property the task brief asks
// for directly against this design.

import Foundation

/// Snapshot-based undo/redo over a `CanvasElement` array. A plain struct
/// (value semantics), not a class/`ObservableObject` — `CanvasEditorView`
/// wraps one in `@State` and republishes on mutation the normal SwiftUI
/// way; keeping this type UI-framework-agnostic is what makes it directly
/// unit-testable without SwiftUI at all (see this file's header).
public struct CanvasHistory: Hashable, Sendable {
  /// The current, live element list — what `CanvasEditorView` renders.
  public private(set) var current: [CanvasElement]
  private var undoStack: [[CanvasElement]]
  private var redoStack: [[CanvasElement]]

  public init(elements: [CanvasElement] = []) {
    self.current = elements
    self.undoStack = []
    self.redoStack = []
  }

  public var canUndo: Bool { !undoStack.isEmpty }
  public var canRedo: Bool { !redoStack.isEmpty }

  /// Records the CURRENT state onto the undo stack, clears the redo stack
  /// (a fresh action invalidates any previously-undone future — standard
  /// undo-manager semantics, same rule `NSUndoManager`/every rich editor
  /// follows), then replaces `current` with `newElements`.
  ///
  /// This is the one primitive every mutation below funnels through, so
  /// "does a new edit clear redo history" only has one place to be
  /// correct.
  public mutating func perform(_ newElements: [CanvasElement]) {
    undoStack.append(current)
    redoStack.removeAll()
    current = newElements
  }

  /// Reverts to the state before the most recent `perform`. Returns
  /// `false` (no-op) if there is nothing to undo.
  @discardableResult
  public mutating func undo() -> Bool {
    guard let previous = undoStack.popLast() else { return false }
    redoStack.append(current)
    current = previous
    return true
  }

  /// Re-applies the most recently undone state. Returns `false` (no-op)
  /// if there is nothing to redo.
  @discardableResult
  public mutating func redo() -> Bool {
    guard let next = redoStack.popLast() else { return false }
    undoStack.append(current)
    current = next
    return true
  }
}

// MARK: - Convenience element mutations

extension CanvasHistory {
  /// Appends `element` to the end of `current` (drawn on top — see
  /// `CanvasDocument`'s header on `elements` order being z-order) as one
  /// undoable action.
  public mutating func addElement(_ element: CanvasElement) {
    perform(current + [element])
  }

  /// Removes the element with `id`, if present, as one undoable action.
  /// A no-op `perform` (recording an unchanged array) is still pushed even
  /// when `id` isn't found — deliberately simple/predictable over
  /// "smart": a caller that only calls this when it already knows the id
  /// exists (the expected usage) never observes the difference, and a
  /// caller that doesn't is a bug better surfaced by an unexpectedly
  /// undoable no-op than silently swallowed.
  public mutating func removeElement(id: CanvasElementID) {
    perform(current.filter { $0.id != id })
  }

  /// Replaces the element with `id` (if present) with `transform`'s
  /// result, as one undoable action.
  public mutating func updateElement(id: CanvasElementID, _ transform: (CanvasElement) -> CanvasElement) {
    perform(current.map { $0.id == id ? transform($0) : $0 })
  }

  /// Removes every element, as one undoable action.
  public mutating func clear() {
    perform([])
  }
}
