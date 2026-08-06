// CanvasHistoryTests.swift
// EnchiridionCanvasTests
//
// Undo/redo correctness for `CanvasHistory` (CanvasHistory.swift) — task
// brief: "Undo/redo correctness (a sequence of operations, undo N times,
// redo M times, assert exact expected state at each step)."
//
// Every test below records the exact expected `[CanvasElement]` (by id, to
// keep assertions readable) after EACH step of a sequence of
// perform/undo/redo calls — not just a final-state check, so a bug that
// only shows up mid-sequence (e.g. redo after a fresh action should be a
// no-op) can't hide behind a coincidentally-correct end state.

import XCTest

@testable import EnchiridionCanvas

final class CanvasHistoryTests: XCTestCase {
  private func element(_ label: String) -> CanvasElement {
    .text(CanvasText(id: CanvasElementID(rawValue: label), position: CanvasPoint(x: 0, y: 0), content: label))
  }

  private func ids(_ history: CanvasHistory) -> [String] {
    history.current.map(\.id.rawValue)
  }

  func testAddThreeElementsThenUndoAllThenRedoAll() {
    var history = CanvasHistory()
    XCTAssertEqual(ids(history), [])
    XCTAssertFalse(history.canUndo)
    XCTAssertFalse(history.canRedo)

    history.addElement(element("a"))
    XCTAssertEqual(ids(history), ["a"])

    history.addElement(element("b"))
    XCTAssertEqual(ids(history), ["a", "b"])

    history.addElement(element("c"))
    XCTAssertEqual(ids(history), ["a", "b", "c"])
    XCTAssertTrue(history.canUndo)
    XCTAssertFalse(history.canRedo)

    // Undo three times: c -> b -> a -> empty, exact state asserted at
    // every step.
    XCTAssertTrue(history.undo())
    XCTAssertEqual(ids(history), ["a", "b"])

    XCTAssertTrue(history.undo())
    XCTAssertEqual(ids(history), ["a"])

    XCTAssertTrue(history.undo())
    XCTAssertEqual(ids(history), [])
    XCTAssertFalse(history.canUndo)
    XCTAssertTrue(history.canRedo)

    // A fourth undo is a no-op — nothing left to undo.
    XCTAssertFalse(history.undo())
    XCTAssertEqual(ids(history), [])

    // Redo twice: empty -> a -> a,b. Exact state asserted at every step,
    // and NOT redone all the way (proves redo stops where undo stopped
    // being applied, not "replays everything regardless").
    XCTAssertTrue(history.redo())
    XCTAssertEqual(ids(history), ["a"])

    XCTAssertTrue(history.redo())
    XCTAssertEqual(ids(history), ["a", "b"])
    XCTAssertTrue(history.canRedo)

    XCTAssertTrue(history.redo())
    XCTAssertEqual(ids(history), ["a", "b", "c"])
    XCTAssertFalse(history.canRedo)

    // A fourth redo is a no-op — nothing left to redo.
    XCTAssertFalse(history.redo())
    XCTAssertEqual(ids(history), ["a", "b", "c"])
  }

  func testNewActionAfterUndoClearsRedoHistory() {
    var history = CanvasHistory()
    history.addElement(element("a"))
    history.addElement(element("b"))
    XCTAssertTrue(history.undo())
    XCTAssertEqual(ids(history), ["a"])
    XCTAssertTrue(history.canRedo)

    // A fresh action after an undo must invalidate the redo stack —
    // standard undo-manager semantics.
    history.addElement(element("c"))
    XCTAssertEqual(ids(history), ["a", "c"])
    XCTAssertFalse(history.canRedo, "redo history must be cleared by a new action")
    XCTAssertFalse(history.redo())
    XCTAssertEqual(ids(history), ["a", "c"], "a no-op redo must not alter state")
  }

  func testRemoveElement() {
    var history = CanvasHistory()
    history.addElement(element("a"))
    history.addElement(element("b"))
    history.addElement(element("c"))

    history.removeElement(id: CanvasElementID(rawValue: "b"))
    XCTAssertEqual(ids(history), ["a", "c"])

    XCTAssertTrue(history.undo())
    XCTAssertEqual(ids(history), ["a", "b", "c"], "undoing a removal must restore the removed element")

    XCTAssertTrue(history.redo())
    XCTAssertEqual(ids(history), ["a", "c"])
  }

  func testUpdateElement() {
    var history = CanvasHistory()
    history.addElement(.text(CanvasText(id: CanvasElementID(rawValue: "a"), position: CanvasPoint(x: 0, y: 0), content: "before")))

    history.updateElement(id: CanvasElementID(rawValue: "a")) { existing in
      guard case .text(var text) = existing else { return existing }
      text.content = "after"
      return .text(text)
    }

    guard case .text(let updated) = history.current[0] else {
      return XCTFail("expected a text element")
    }
    XCTAssertEqual(updated.content, "after")

    XCTAssertTrue(history.undo())
    guard case .text(let reverted) = history.current[0] else {
      return XCTFail("expected a text element")
    }
    XCTAssertEqual(reverted.content, "before", "undoing an update must restore the prior content")
  }

  func testClear() {
    var history = CanvasHistory()
    history.addElement(element("a"))
    history.addElement(element("b"))

    history.clear()
    XCTAssertEqual(ids(history), [])

    XCTAssertTrue(history.undo())
    XCTAssertEqual(ids(history), ["a", "b"], "undoing a clear must restore every element")
  }

  func testInterleavedUndoRedoSequenceMatchesExpectedStateAtEveryStep() {
    // A longer, deliberately interleaved sequence: add, add, undo, add
    // (clears redo), undo, undo, redo, redo — walks through every
    // combination the simpler tests above cover individually, once, as a
    // single sequence.
    var history = CanvasHistory()

    history.addElement(element("1"))  // ["1"]
    history.addElement(element("2"))  // ["1", "2"]
    XCTAssertTrue(history.undo())  // ["1"]
    XCTAssertEqual(ids(history), ["1"])

    history.addElement(element("3"))  // ["1", "3"] — redo("2") is now gone
    XCTAssertEqual(ids(history), ["1", "3"])
    XCTAssertFalse(history.canRedo)

    XCTAssertTrue(history.undo())  // ["1"]
    XCTAssertEqual(ids(history), ["1"])
    XCTAssertTrue(history.undo())  // []
    XCTAssertEqual(ids(history), [])
    XCTAssertFalse(history.canUndo)

    XCTAssertTrue(history.redo())  // ["1"]
    XCTAssertEqual(ids(history), ["1"])
    XCTAssertTrue(history.redo())  // ["1", "3"]
    XCTAssertEqual(ids(history), ["1", "3"])
    XCTAssertFalse(history.canRedo)
  }

  func testInitialElementsSeedCurrentStateWithEmptyHistory() {
    let seeded = CanvasHistory(elements: [element("existing")])
    XCTAssertEqual(seeded.current.map(\.id.rawValue), ["existing"])
    XCTAssertFalse(seeded.canUndo, "a seeded initial state is not itself an undoable action")
    XCTAssertFalse(seeded.canRedo)
  }
}
