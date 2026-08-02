import EnchiridionCore
import SwiftUI
import XCTest

@testable import Enchiridion

@available(iOS 26.0, *)
final class PageReferenceSelectionResolverTests: XCTestCase {
  private let vaultID = VaultID.personal
  private let sourceID = PageID(rawValue: "page_source")
  private let atlasID = PageID(rawValue: "page_atlas")
  private let orionID = PageID(rawValue: "page_orion")

  func testLiveMentionAtStartDerivesFreshQueryAndReplacementRange() throws {
    let body = AttributedString("@back")
    let selection = AttributedTextSelection(insertionPoint: body.endIndex)
    let session = try XCTUnwrap(
      NativeRichEditorLiveMentionSession.begin(in: body, triggerOffset: 0, pageID: sourceID, loadGeneration: 7)
    )

    XCTAssertEqual(
      session.match(in: body, selection: selection, pageID: sourceID, loadGeneration: 7),
      .init(query: "back", replacementRange: 0..<5)
    )
  }

  func testLiveMentionRequiresBoundaryAndStopsAtWhitespaceOrAnotherAtSign() throws {
    let email = AttributedString("hello@back")
    XCTAssertNil(NativeRichEditorLiveMentionSession.begin(in: email, triggerOffset: 5, pageID: sourceID, loadGeneration: 1))

    let delimited = AttributedString("(@back")
    XCTAssertNotNil(NativeRichEditorLiveMentionSession.begin(in: delimited, triggerOffset: 1, pageID: sourceID, loadGeneration: 1))

    let body = AttributedString("@back log")
    let session = try XCTUnwrap(
      NativeRichEditorLiveMentionSession.begin(in: body, triggerOffset: 0, pageID: sourceID, loadGeneration: 1)
    )
    XCTAssertNil(session.match(in: body, selection: .init(insertionPoint: body.endIndex), pageID: sourceID, loadGeneration: 1))

    let doubleAt = AttributedString("@back@up")
    XCTAssertNil(
      session.match(
        in: doubleAt, selection: .init(insertionPoint: doubleAt.endIndex), pageID: sourceID, loadGeneration: 1
      )
    )
  }

  func testLiveMentionDoesNotCrossReferenceMarkAndTapRevalidatesCaret() throws {
    var marked = AttributedString("@Atlas")
    let atlas = try XCTUnwrap(marked.range(of: "Atlas"))
    marked[atlas][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(atlasID, label: "Atlas")]
    let markedSession = try XCTUnwrap(
      NativeRichEditorLiveMentionSession.begin(in: marked, triggerOffset: 0, pageID: sourceID, loadGeneration: 1)
    )
    XCTAssertNil(
      markedSession.match(
        in: marked, selection: .init(insertionPoint: marked.endIndex), pageID: sourceID, loadGeneration: 1
      )
    )

    let body = AttributedString("@back")
    let session = try XCTUnwrap(
      NativeRichEditorLiveMentionSession.begin(in: body, triggerOffset: 0, pageID: sourceID, loadGeneration: 1)
    )
    let atEnd = AttributedTextSelection(insertionPoint: body.endIndex)
    let match = try XCTUnwrap(session.match(in: body, selection: atEnd, pageID: sourceID, loadGeneration: 1))
    let request = NativeRichEditorLiveMentionInsertionRequest(session: session, match: match)
    XCTAssertNil(
      request.replacementSelection(
        in: body, selection: .init(insertionPoint: body.startIndex), pageID: sourceID, loadGeneration: 1
      )
    )
    XCTAssertNotNil(request.replacementSelection(in: body, selection: atEnd, pageID: sourceID, loadGeneration: 1))
  }

  func testLiveMentionReplacementReplacesExactlyTheMentionAndMarksThePage() throws {
    let body = AttributedString("before @ba after")
    let triggerOffset = 7
    let session = try XCTUnwrap(
      NativeRichEditorLiveMentionSession.begin(
        in: body, triggerOffset: triggerOffset, pageID: sourceID, loadGeneration: 3
      )
    )
    let mentionEnd = body.index(body.startIndex, offsetByCharacters: 10)
    let selection = AttributedTextSelection(insertionPoint: mentionEnd)
    let match = try XCTUnwrap(
      session.match(in: body, selection: selection, pageID: sourceID, loadGeneration: 3)
    )
    let result = try XCTUnwrap(
      NativeRichEditorLiveMentionReplacement.apply(
        request: .init(session: session, match: match),
        to: atlasID,
        label: "Atlas",
        in: body,
        selection: selection,
        sourcePageID: sourceID,
        loadGeneration: 3
      )
    )

    XCTAssertEqual(String(result.body.characters), "before Atlas after")
    let atlasRange = try XCTUnwrap(result.body.range(of: "Atlas"))
    let marks = try XCTUnwrap(result.body[atlasRange][PageRichTextAttributes.AutomergeMarks.self])
    XCTAssertEqual(marks.count, 1)
    XCTAssertEqual(
      PageDocument.pageReferenceDestination(from: try XCTUnwrap(marks.first)),
      PageReferenceDestination(pageID: atlasID, label: "Atlas")
    )
    XCTAssertEqual(String(result.body[result.body.startIndex..<atlasRange.lowerBound].characters), "before ")
    XCTAssertEqual(String(result.body[atlasRange.upperBound..<result.body.endIndex].characters), " after")
    guard case .insertionPoint(let caret) = result.selection.indices(in: result.body) else {
      return XCTFail("Expected caret after inserted page reference")
    }
    XCTAssertEqual(caret, atlasRange.upperBound)
  }

  func testReferenceSourcePoliciesKeepDatesAndDoubleBracketTriggerSemantics() {
    XCTAssertFalse(NativeRichEditorReferencePickerPolicy.includesDailyNotes(for: .liveAtMention))
    XCTAssertTrue(NativeRichEditorReferencePickerPolicy.includesDailyNotes(for: .manual))
    XCTAssertTrue(NativeRichEditorReferencePickerPolicy.includesDailyNotes(for: .doubleBracket))

    XCTAssertTrue(NativeRichEditorReferencePickerPolicy.hasCompleteTrigger("[[", source: .doubleBracket))
    XCTAssertFalse(NativeRichEditorReferencePickerPolicy.hasCompleteTrigger("[", source: .doubleBracket))
    XCTAssertTrue(NativeRichEditorReferencePickerPolicy.hasCompleteTrigger("anything", source: .manual))
  }

  func testCaretUsesHalfOpenReferenceRangeAtBothBoundaries() throws {
    var body = AttributedString("Atlas next")
    let range = try XCTUnwrap(body.range(of: "Atlas"))
    body[range][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(atlasID, label: "Atlas")]
    XCTAssertNotNil(body[range][PageRichTextAttributes.AutomergeMarks.self])
    XCTAssertEqual(
      PageDocument.pageReferenceDestination(from: try XCTUnwrap(body[range][PageRichTextAttributes.AutomergeMarks.self]).first!),
      PageReferenceDestination(pageID: atlasID, label: "Atlas")
    )

    XCTAssertNotNil(resolve(body, selection: .caret(range.lowerBound)))
    XCTAssertNil(resolve(body, selection: .caret(range.upperBound)))
  }

  func testWhollyContainedNonemptySelectionResolvesButPartialAndMultipleDoNot() throws {
    var body = AttributedString("Atlas next")
    let referenceRange = try XCTUnwrap(body.range(of: "Atlas"))
    body[referenceRange][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(atlasID, label: "Atlas")]
    let partialUpperBound = body.index(referenceRange.upperBound, offsetByCharacters: 1)
    let partial = referenceRange.lowerBound..<partialUpperBound
    var multi = RangeSet<AttributedString.Index>()
    multi.insert(contentsOf: referenceRange)
    multi.insert(contentsOf: partialUpperBound..<body.endIndex)

    XCTAssertNotNil(resolve(body, selection: .range(referenceRange)))
    XCTAssertNil(resolve(body, selection: .range(partial)))
    XCTAssertNil(resolve(body, selection: .rangeSet(multi)))
  }

  func testCoalescesAdjacentRunsWithTheSameSemanticReference() throws {
    var body = AttributedString("Atlas")
    let atlas = try XCTUnwrap(body.range(of: "Atlas"))
    let split = body.index(atlas.lowerBound, offsetByCharacters: 2)
    body[atlas.lowerBound..<split][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(atlasID, label: "Atlas")]
    body[split..<atlas.upperBound][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(atlasID, label: "Atlas")]
    body[split..<atlas.upperBound].inlinePresentationIntent = [.stronglyEmphasized]

    XCTAssertNotNil(resolve(body, selection: .range(atlas)))
  }

  func testRejectsAdjacentAndCrossReferenceSelections() throws {
    var body = AttributedString("AtlasOrion")
    let atlas = try XCTUnwrap(body.range(of: "Atlas"))
    let orion = try XCTUnwrap(body.range(of: "Orion"))
    body[atlas][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(atlasID, label: "Atlas")]
    body[orion][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(orionID, label: "Orion")]

    XCTAssertNotNil(resolve(body, selection: .caret(atlas.lowerBound)))
    XCTAssertNotNil(resolve(body, selection: .caret(orion.lowerBound)))
    XCTAssertNil(resolve(body, selection: .range(atlas.lowerBound..<orion.upperBound)))
  }

  func testEmojiAndRTLTextUseAttributedStringIndices() throws {
    var body = AttributedString("🪶 אבג Atlas")
    let atlas = try XCTUnwrap(body.range(of: "Atlas"))
    body[atlas][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(atlasID, label: "Atlas")]

    XCTAssertEqual(resolve(body, selection: .range(atlas))?.destination.pageID, atlasID)
  }

  func testRejectsMalformedAndConflictingReferenceMarks() throws {
    var malformed = AttributedString("Atlas")
    let malformedRange = try XCTUnwrap(malformed.range(of: "Atlas"))
    malformed[malformedRange][PageRichTextAttributes.AutomergeMarks.self] = [
      .init(name: PageDocument.pageReferenceMark, value: .string("not json"))
    ]
    var conflicting = malformed
    conflicting[malformedRange][PageRichTextAttributes.AutomergeMarks.self] = [
      referenceMark(atlasID, label: "Atlas"), referenceMark(orionID, label: "Orion")
    ]

    XCTAssertNil(resolve(malformed, selection: .range(malformedRange)))
    XCTAssertNil(resolve(conflicting, selection: .range(malformedRange)))
  }

  func testRejectsSelfDeletedMissingAndCrossVaultTargets() throws {
    var body = AttributedString("Atlas")
    let range = try XCTUnwrap(body.range(of: "Atlas"))
    body[range][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(atlasID, label: "Atlas")]

    XCTAssertNil(resolve(body, selection: .range(range), sourceID: atlasID))
    XCTAssertNil(resolve(body, selection: .range(range), missingTarget: true))
    XCTAssertNil(resolve(body, selection: .range(range), target: .init(vaultID: vaultID, pageID: atlasID, isDeleted: true)))
    XCTAssertNil(resolve(body, selection: .range(range), target: .init(vaultID: VaultID(rawValue: "other"), pageID: atlasID)))
  }

  func testOpenActionOnlyOpensSameTargetAfterFlushAndRevalidation() async throws {
    let reference = try XCTUnwrap(reference())
    let recorder = OpenRecorder()
    let opened = await PageReferenceOpenAction.perform(
      captured: reference,
      flushAndRevalidate: { _ in reference },
      open: { value in await recorder.record(value) }
    )
    XCTAssertTrue(opened)
    let valuesAfterOpen = await recorder.values()
    XCTAssertEqual(valuesAfterOpen, [reference])

    let stale = PageReferenceSelectionResolver.ResolvedReference(
      sourceVaultID: vaultID,
      sourcePageID: sourceID,
      destination: .init(vaultID: vaultID, pageID: orionID),
      label: "Orion"
    )
    let refused = await PageReferenceOpenAction.perform(
      captured: reference,
      flushAndRevalidate: { _ in stale },
      open: { value in await recorder.record(value) }
    )
    XCTAssertFalse(refused)
    let valuesAfterRefusal = await recorder.values()
    XCTAssertEqual(valuesAfterRefusal, [reference])
  }

  func testOpenActionRefusesNavigationWhenAnOwnedMutationCannotFlushYet() async throws {
    let reference = try XCTUnwrap(reference())
    let recorder = OpenRecorder()

    let opened = await PageReferenceOpenAction.perform(
      captured: reference,
      // This is the same contract as a tagged-page transaction in progress:
      // no durable snapshot is available, so navigation must not proceed.
      flushAndRevalidate: { _ in nil },
      open: { value in await recorder.record(value) }
    )

    XCTAssertFalse(opened)
    let values = await recorder.values()
    XCTAssertTrue(values.isEmpty)
  }

  func testOpenActionKeepsTheTapTimeTargetWhenLiveSelectionMovesDuringFlush() async throws {
    let tappedReference = try XCTUnwrap(reference())
    let liveSelection = LiveSelection(tapTimeReference: tappedReference)
    let recorder = OpenRecorder()

    // This models UIKit moving the visible caret while the editor's flush is
    // suspended. The revalidation adapter must resolve the selection captured
    // by the press, not read this current UI selection.
    await liveSelection.move(to: PageReferenceSelectionResolver.ResolvedReference(
      sourceVaultID: vaultID,
      sourcePageID: sourceID,
      destination: .init(vaultID: vaultID, pageID: orionID),
      label: "Orion"
    ))

    let opened = await PageReferenceOpenAction.perform(
      captured: tappedReference,
      flushAndRevalidate: { captured in
        await liveSelection.revalidateCapturedRequest(captured)
      },
      open: { value in await recorder.record(value) }
    )

    XCTAssertTrue(opened)
    let recorded = await recorder.values()
    XCTAssertEqual(recorded, [tappedReference])
  }

  func testOpenActionRejectsAChangedCapturedSelectionAfterFlush() async throws {
    let tappedReference = try XCTUnwrap(reference())
    let liveSelection = LiveSelection(tapTimeReference: tappedReference)
    let recorder = OpenRecorder()
    await liveSelection.invalidateCapturedRequest()

    let opened = await PageReferenceOpenAction.perform(
      captured: tappedReference,
      flushAndRevalidate: { captured in
        await liveSelection.revalidateCapturedRequest(captured)
      },
      open: { value in await recorder.record(value) }
    )

    XCTAssertFalse(opened)
    let recorded = await recorder.values()
    XCTAssertTrue(recorded.isEmpty)
  }

  func testOpenRequestRevalidatesCapturedOffsetsAfterLiveSelectionMoves() throws {
    var durableBody = AttributedString("Atlas Orion")
    let atlasRange = try XCTUnwrap(durableBody.range(of: "Atlas"))
    let orionRange = try XCTUnwrap(durableBody.range(of: "Orion"))
    durableBody[atlasRange][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(atlasID, label: "Atlas")]
    durableBody[orionRange][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(orionID, label: "Orion")]
    let capturedAtlasRange = try XCTUnwrap(durableBody.range(of: "Atlas"))
    let movedOrionRange = try XCTUnwrap(durableBody.range(of: "Orion"))
    let request = try XCTUnwrap(openRequest(in: durableBody, selection: .range(capturedAtlasRange)))

    // The live TextEditor selection has since moved to Orion. It is not an
    // input to revalidation; the captured Atlas offsets decide the result.
    let movedLiveSelection = AttributedTextSelection(range: movedOrionRange)
    XCTAssertNotNil(movedLiveSelection)
    let revalidated = request.revalidate(
      in: durableBody,
      pageID: sourceID,
      loadGeneration: 7,
      sourceVaultID: vaultID,
      liveDestination: { .init(vaultID: self.vaultID, pageID: $0) }
    )

    XCTAssertEqual(revalidated?.destination.pageID, atlasID)
  }

  func testOpenRequestRejectsChangedDestinationAndUnavailableTargets() throws {
    var durableBody = AttributedString("Atlas")
    let range = try XCTUnwrap(durableBody.range(of: "Atlas"))
    durableBody[range][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(atlasID, label: "Atlas")]
    let capturedRange = try XCTUnwrap(durableBody.range(of: "Atlas"))
    let request = try XCTUnwrap(openRequest(in: durableBody, selection: .range(capturedRange)))

    var changedBody = durableBody
    let changedRange = try XCTUnwrap(changedBody.range(of: "Atlas"))
    changedBody[changedRange][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(orionID, label: "Orion")]
    XCTAssertNil(revalidate(request, body: changedBody))
    XCTAssertNil(revalidate(request, body: durableBody, missingTarget: true))
    XCTAssertNil(revalidate(request, body: durableBody, target: .init(vaultID: vaultID, pageID: atlasID, isDeleted: true)))
  }

  func testOpenRequestRejectsPageAndLoadGenerationChanges() throws {
    var body = AttributedString("Atlas")
    let range = try XCTUnwrap(body.range(of: "Atlas"))
    body[range][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark(atlasID, label: "Atlas")]
    let capturedRange = try XCTUnwrap(body.range(of: "Atlas"))
    let request = try XCTUnwrap(openRequest(in: body, selection: .range(capturedRange)))

    XCTAssertNil(request.revalidate(
      in: body,
      pageID: PageID(rawValue: "page_other"),
      loadGeneration: 7,
      sourceVaultID: vaultID,
      liveDestination: { .init(vaultID: self.vaultID, pageID: $0) }
    ))
    XCTAssertNil(request.revalidate(
      in: body,
      pageID: sourceID,
      loadGeneration: 8,
      sourceVaultID: vaultID,
      liveDestination: { .init(vaultID: self.vaultID, pageID: $0) }
    ))
  }

  private func reference() -> PageReferenceSelectionResolver.ResolvedReference? {
    let body = AttributedString("Atlas")
    return PageReferenceSelectionResolver.ResolvedReference(
      sourceVaultID: vaultID,
      sourcePageID: sourceID,
      destination: .init(vaultID: vaultID, pageID: atlasID),
      label: String(body.characters)
    )
  }

  private func resolve(
    _ body: AttributedString,
    selection: PageReferenceSelectionResolver.Selection,
    sourceID: PageID? = nil,
    target: PageReferenceSelectionResolver.LiveDestination? = nil,
    missingTarget: Bool = false
  ) -> PageReferenceSelectionResolver.ResolvedReference? {
    PageReferenceSelectionResolver.resolve(
      in: body,
      selection: selection,
      sourceVaultID: vaultID,
      sourcePageID: sourceID ?? self.sourceID,
      liveDestination: { pageID in
        if missingTarget { return nil }
        return target ?? .init(vaultID: self.vaultID, pageID: pageID)
      }
    )
  }

  private func openRequest(
    in body: AttributedString,
    selection: PageReferenceSelectionResolver.Selection
  ) -> NativeRichEditorOpenRequest? {
    let attributedSelection: AttributedTextSelection
    switch selection {
    case .caret(let index): attributedSelection = AttributedTextSelection(insertionPoint: index)
    case .range(let range): attributedSelection = AttributedTextSelection(range: range)
    case .rangeSet: return nil
    }
    guard let committed = NativeRichEditorCommittedSelection(from: attributedSelection, in: body),
      let reference = PageReferenceSelectionResolver.resolve(
        in: body,
        selection: attributedSelection,
        sourceVaultID: vaultID,
        sourcePageID: sourceID,
        liveDestination: { .init(vaultID: self.vaultID, pageID: $0) }
      )
    else { return nil }
    return NativeRichEditorOpenRequest(
      reference: reference,
      selection: .init(pageID: sourceID, loadGeneration: 7, bodyRevision: 11, selection: committed)
    )
  }

  private func revalidate(
    _ request: NativeRichEditorOpenRequest,
    body: AttributedString,
    target: PageReferenceSelectionResolver.LiveDestination? = nil,
    missingTarget: Bool = false
  ) -> PageReferenceSelectionResolver.ResolvedReference? {
    request.revalidate(
      in: body,
      pageID: sourceID,
      loadGeneration: 7,
      sourceVaultID: vaultID,
      liveDestination: { pageID in
        if missingTarget { return nil }
        return target ?? .init(vaultID: self.vaultID, pageID: pageID)
      }
    )
  }

  private func referenceMark(_ pageID: PageID, label: String) -> PageRichTextMark {
    try! PageDocument.pageReferenceMark(to: pageID, label: label)
  }
}

private actor OpenRecorder {
  private var recorded: [PageReferenceSelectionResolver.ResolvedReference] = []

  func record(_ reference: PageReferenceSelectionResolver.ResolvedReference) {
    recorded.append(reference)
  }

  func values() -> [PageReferenceSelectionResolver.ResolvedReference] { recorded }
}

private actor LiveSelection {
  private let tapTimeReference: PageReferenceSelectionResolver.ResolvedReference
  private var liveReference: PageReferenceSelectionResolver.ResolvedReference?
  private var capturedRequestIsValid = true

  init(tapTimeReference: PageReferenceSelectionResolver.ResolvedReference) {
    self.tapTimeReference = tapTimeReference
    liveReference = tapTimeReference
  }

  func move(to reference: PageReferenceSelectionResolver.ResolvedReference) {
    liveReference = reference
  }

  func invalidateCapturedRequest() {
    capturedRequestIsValid = false
  }

  func revalidateCapturedRequest(
    _ captured: PageReferenceSelectionResolver.ResolvedReference
  ) -> PageReferenceSelectionResolver.ResolvedReference? {
    guard capturedRequestIsValid, captured == tapTimeReference else { return nil }
    // `liveReference` intentionally has no part in this lookup.
    _ = liveReference
    return tapTimeReference
  }
}
