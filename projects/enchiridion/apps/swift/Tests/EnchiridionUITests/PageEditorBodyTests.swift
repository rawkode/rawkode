// PageEditorBodyTests.swift
// EnchiridionUITests

import XCTest

@testable import EnchiridionCore
@testable import EnchiridionSync
@testable import EnchiridionUI

final class PageEditorBodyTests: XCTestCase {
  /// Typing right after the end of a styled run continues that style — the
  /// "keep typing" case (`MarkRunAlgebra.absorbsInsert`'s right-edge rule).
  func testInsertRightAfterAStyledRunContinuesIt() {
    let body = PageEditorBody(text: "hello", markRuns: [MarkRun(range: 0..<5, styles: [.bold])])
    let outcome = body.applyingInsert(text: "!", at: 5)
    XCTAssertEqual(outcome.body.text, "hello!")
    XCTAssertEqual(outcome.body.markRuns, [MarkRun(range: 0..<6, styles: [.bold])])
    XCTAssertTrue(outcome.brokenReferences.isEmpty)
  }

  /// Typing right *before* the start of a styled run does NOT retroactively
  /// join it — only the right edge continues a style.
  func testInsertRightBeforeAStyledRunStaysUnstyled() {
    let body = PageEditorBody(
      text: "hello world",
      markRuns: [MarkRun(range: 0..<5, styles: []), MarkRun(range: 5..<11, styles: [.bold])])
    let outcome = body.applyingInsert(text: "!", at: 5)
    XCTAssertEqual(outcome.body.text, "hello! world")
    XCTAssertEqual(
      outcome.body.markRuns,
      [MarkRun(range: 0..<6, styles: []), MarkRun(range: 6..<12, styles: [.bold])])
  }

  func testInsertStrictlyInsideARunExtendsIt() {
    let body = PageEditorBody(text: "hello", markRuns: [MarkRun(range: 0..<5, styles: [.bold])])
    let outcome = body.applyingInsert(text: "XX", at: 2)
    XCTAssertEqual(outcome.body.text, "heXXllo")
    XCTAssertEqual(outcome.body.markRuns, [MarkRun(range: 0..<7, styles: [.bold])])
  }

  func testDeleteCollapsesFullyDeletedRun() {
    let body = PageEditorBody(
      text: "hello world",
      markRuns: [MarkRun(range: 0..<5, styles: [.bold]), MarkRun(range: 5..<11, styles: [])])
    let outcome = body.applyingDelete(range: 0..<5)
    XCTAssertEqual(outcome.body.text, " world")
    XCTAssertEqual(outcome.body.markRuns, [MarkRun(range: 0..<6, styles: [])])
  }

  func testDeletePartiallyOverlappingRunShrinksIt() {
    let body = PageEditorBody(
      text: "hello world",
      markRuns: [MarkRun(range: 0..<5, styles: [.bold]), MarkRun(range: 5..<11, styles: [])])
    let outcome = body.applyingDelete(range: 3..<7)
    XCTAssertEqual(outcome.body.text, "helorld")
    XCTAssertEqual(
      outcome.body.markRuns,
      [MarkRun(range: 0..<3, styles: [.bold]), MarkRun(range: 3..<7, styles: [])])
  }

  func testInsertAtReferenceEdgeDoesNotExtendReference() throws {
    let target = PageID.free()
    let destination = PageReferenceDestination(pageID: target, label: "Project")
    let body = PageEditorBody(text: "See Project now", referenceRuns: [ReferenceRun(range: 4..<11, destination: destination)])

    let before = body.applyingInsert(text: "X", at: 4)
    XCTAssertTrue(before.brokenReferences.isEmpty)
    XCTAssertEqual(before.body.referenceRuns, [ReferenceRun(range: 5..<12, destination: destination)])

    let after = before.body.applyingInsert(text: "Y", at: 12)
    XCTAssertTrue(after.brokenReferences.isEmpty)
    XCTAssertEqual(after.body.referenceRuns, [ReferenceRun(range: 5..<12, destination: destination)])
  }

  func testInsertInsideReferenceInteriorBreaksIt() {
    let target = PageID.free()
    let destination = PageReferenceDestination(pageID: target, label: "Project")
    let body = PageEditorBody(text: "See Project now", referenceRuns: [ReferenceRun(range: 4..<11, destination: destination)])

    let outcome = body.applyingInsert(text: "X", at: 7)
    XCTAssertEqual(outcome.brokenReferences, [ReferenceRun(range: 4..<11, destination: destination)])
    XCTAssertTrue(outcome.body.referenceRuns.isEmpty)
    XCTAssertEqual(outcome.body.text, "See ProXject now")
  }

  func testDeleteOverlappingReferenceBreaksIt() {
    let target = PageID.free()
    let destination = PageReferenceDestination(pageID: target, label: "Project")
    let body = PageEditorBody(text: "See Project now", referenceRuns: [ReferenceRun(range: 4..<11, destination: destination)])

    let outcome = body.applyingDelete(range: 9..<13)
    XCTAssertEqual(outcome.brokenReferences, [ReferenceRun(range: 4..<11, destination: destination)])
    XCTAssertTrue(outcome.body.referenceRuns.isEmpty)
  }

  func testDeleteBeforeReferenceOnlyShiftsIt() {
    let target = PageID.free()
    let destination = PageReferenceDestination(pageID: target, label: "Project")
    let body = PageEditorBody(text: "See Project now", referenceRuns: [ReferenceRun(range: 4..<11, destination: destination)])

    let outcome = body.applyingDelete(range: 0..<4)
    XCTAssertTrue(outcome.brokenReferences.isEmpty)
    XCTAssertEqual(outcome.body.referenceRuns, [ReferenceRun(range: 0..<7, destination: destination)])
    XCTAssertEqual(outcome.body.text, "Project now")
  }

  func testFromProjectionReconstructsPlainTextAndBestEffortReferenceRuns() throws {
    let target = PageID.free()
    let projection = PageDocumentProjection(
      title: "Notes",
      plainText: "Talk to Alice about the roadmap",
      deletedAt: nil,
      isPinned: false,
      references: [PageReference(sourcePageID: .free(), targetPageID: target, fallbackLabel: "Alice")],
      graphEdges: [],
      objectMetadata: PageObjectMetadata()
    )
    let body = PageEditorBody.from(projection: projection)
    XCTAssertEqual(body.text, projection.plainText)
    XCTAssertEqual(body.referenceRuns.count, 1)
    let run = try XCTUnwrap(body.referenceRuns.first)
    XCTAssertEqual(run.destination.pageID, target)
    XCTAssertEqual(String(body.text[body.text.stringRange(run.range)]), "Alice")
    // No positioned mark data is recoverable from a projection — see this
    // file's / PageEditorBody.swift's header.
    XCTAssertEqual(body.markRuns, [MarkRun(range: 0..<body.length, styles: [])])
  }

  /// `formattingMarks` carries overlapping single-style spans (bold on
  /// `[0,6)`, italic on `[3,9)`, over "abcdefghij") — `from(projection:)`
  /// must turn that into an exact `MarkRun` partition, not the pre-fix
  /// empty-formatting placeholder.
  func testFromProjectionReconstructsOverlappingFormattingMarks() {
    let projection = PageDocumentProjection(
      title: "",
      plainText: "abcdefghij",
      deletedAt: nil,
      isPinned: false,
      references: [],
      formattingMarks: [
        FormattingMarkRun(style: .bold, range: 0..<6),
        FormattingMarkRun(style: .italic, range: 3..<9),
      ],
      graphEdges: [],
      objectMetadata: PageObjectMetadata()
    )
    let body = PageEditorBody.from(projection: projection)
    XCTAssertEqual(body.text, "abcdefghij")
    XCTAssertEqual(
      body.markRuns,
      [
        MarkRun(range: 0..<3, styles: [.bold]),
        MarkRun(range: 3..<6, styles: [.bold, .italic]),
        MarkRun(range: 6..<9, styles: [.italic]),
        MarkRun(range: 9..<10, styles: []),
      ])
  }

  /// Once loaded, the reconstructed mark runs must compose correctly with
  /// further *local* edits — here, toggling bold off over `[4,8)`, which
  /// cuts through both the bold+italic overlap and the italic-only tail.
  func testLoadedFormattingMarksComposeWithASubsequentLocalToggle() {
    let projection = PageDocumentProjection(
      title: "",
      plainText: "abcdefghij",
      deletedAt: nil,
      isPinned: false,
      references: [],
      formattingMarks: [
        FormattingMarkRun(style: .bold, range: 0..<6),
        FormattingMarkRun(style: .italic, range: 3..<9),
      ],
      graphEdges: [],
      objectMetadata: PageObjectMetadata()
    )
    let body = PageEditorBody.from(projection: projection)

    let toggled = MarkToggleEngine.applying(.bold, enable: false, over: 4..<8, to: body.markRuns)

    XCTAssertEqual(
      toggled,
      [
        MarkRun(range: 0..<3, styles: [.bold]),
        MarkRun(range: 3..<4, styles: [.bold, .italic]),
        MarkRun(range: 4..<9, styles: [.italic]),
        MarkRun(range: 9..<10, styles: []),
      ])
  }

  /// A loaded formatting mark must also reshape correctly under a plain
  /// text insert — the same `MarkRunAlgebra.shiftedForInsert` path a
  /// locally-created run already goes through — confirming the loaded
  /// state isn't a second-class representation.
  func testLoadedFormattingMarksReshapeUnderALocalInsert() {
    let projection = PageDocumentProjection(
      title: "",
      plainText: "abcdefghij",
      deletedAt: nil,
      isPinned: false,
      references: [],
      formattingMarks: [FormattingMarkRun(style: .bold, range: 0..<6)],
      graphEdges: [],
      objectMetadata: PageObjectMetadata()
    )
    let body = PageEditorBody.from(projection: projection)

    let outcome = body.applyingInsert(text: "X", at: 6)

    XCTAssertEqual(outcome.body.text, "abcdefXghij")
    XCTAssertEqual(
      outcome.body.markRuns,
      [
        MarkRun(range: 0..<7, styles: [.bold]),
        MarkRun(range: 7..<11, styles: []),
      ])
  }

  func testFromProjectionSkipsUnmatchableLabelsWithoutFabricatingAReference() {
    let target = PageID.free()
    let projection = PageDocumentProjection(
      title: "",
      plainText: "No matching text here",
      deletedAt: nil,
      isPinned: false,
      references: [PageReference(sourcePageID: .free(), targetPageID: target, fallbackLabel: "Not Present")],
      graphEdges: [],
      objectMetadata: PageObjectMetadata()
    )
    let body = PageEditorBody.from(projection: projection)
    XCTAssertTrue(body.referenceRuns.isEmpty)
  }
}
