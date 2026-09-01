import Foundation
import XCTest
@testable import AthenaeumAppUI
@testable import AthenaeumCore
import AthenaeumDomain

final class LoroNativeRichEditingEngineTests: XCTestCase {
    func testReplaceIsLosslessAndPublishesCanonicalSemanticValue() {
        var engine = LoroNativeRichEditingEngine(document: heading("title", marks: [.code, .strong]))

        let effect = engine.replace(utf16Range: NSRange(location: 4, length: 0), withPlainText: "!")

        XCTAssertEqual(effect, .publish(
            document: heading("titl!e", marks: [.code, .strong]),
            selection: .init(location: 5, length: 0)
        ))
        XCTAssertEqual(engine.admittedDocument, heading("titl!e", marks: [.code, .strong]))
        XCTAssertEqual(engine.pendingLocalDocument, heading("titl!e", marks: [.code, .strong]))
    }

    func testToggleUsesTheSharedCanonicalMarkerPath() {
        var engine = LoroNativeRichEditingEngine(document: paragraph("hello"))

        XCTAssertEqual(
            engine.toggle(mark: .strong, utf16Range: NSRange(location: 0, length: 5)),
            .publish(
                document: paragraph("hello", marks: [.strong]),
                selection: .init(location: 0, length: 5)
            )
        )
        // A second local command is intentionally fenced until the parent acknowledges the
        // first proposal; this is the same single-flight contract used by both native adapters.
        XCTAssertEqual(engine.receiveParentDocument(paragraph("hello", marks: [.strong])), .acknowledged(
            document: paragraph("hello", marks: [.strong]), selection: .init(location: 0, length: 5)
        ))
        XCTAssertEqual(
            engine.toggle(mark: .strong, utf16Range: NSRange(location: 0, length: 5)),
            .publish(document: paragraph("hello"), selection: .init(location: 0, length: 5))
        )
    }

    func testTaskTextEditingPreservesChecklistTopologyAndCheckedState() {
        let source = taskList([
            .init(checked: true, runs: [.init(text: "one")]),
            .init(checked: false, runs: [.init(text: "two")])
        ])
        var engine = LoroNativeRichEditingEngine(document: source)

        let effect = engine.replace(utf16Range: NSRange(location: 1, length: 1), withPlainText: "N")

        XCTAssertEqual(effect, .publish(
            document: taskList([
                .init(checked: true, runs: [.init(text: "oNe")]),
                .init(checked: false, runs: [.init(text: "two")])
            ]),
            selection: .init(location: 2, length: 0)
        ))
        XCTAssertEqual(engine.admittedDocument.semantic.blocks, [
            .taskList([
                .init(checked: true, runs: [.init(text: "oNe")]),
                .init(checked: false, runs: [.init(text: "two")])
            ])
        ])
    }

    func testChecklistCommandCanTargetTrailingEmptyItem() throws {
        let source = taskList([
            .init(checked: false, runs: [.init(text: "one")]),
            .init(checked: false, runs: [])
        ])
        var engine = LoroNativeRichEditingEngine(document: source)
        let rendered = try LoroNativeRichTextCodec.attributedString(for: source)
        let command = try XCTUnwrap(engine.makeTaskToggleCommand(atUTF16Offset: rendered.length - 1))
        XCTAssertEqual(command.taskListIndex, 0)
        XCTAssertEqual(command.itemIndex, 1)
        XCTAssertEqual(command.expectedItem.runs, [])
    }

    func testTaskListInsertionCommandUsesAbsoluteScalarWitnessForParagraphAndHeading() throws {
        let source = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .paragraph([.init(text: "one")]),
            .heading(level: 2, runs: [.init(text: "two")]),
            .paragraph([.init(text: "three")])
        ]))
        var engine = LoroNativeRichEditingEngine(document: source)

        let paragraphCommand = try XCTUnwrap(engine.makeTaskListInsertionCommand(atScalarOffset: 1))
        XCTAssertEqual(paragraphCommand.topLevelBlockIndex, 0)
        XCTAssertEqual(paragraphCommand.collapsedScalarOffset, 1)
        XCTAssertTrue(engine.isValidTaskListInsertionWitness(paragraphCommand))

        // The heading starts after the paragraph's three scalars and its separator.
        let headingCommand = try XCTUnwrap(engine.makeTaskListInsertionCommand(atScalarOffset: 4))
        XCTAssertEqual(headingCommand.topLevelBlockIndex, 1)
        XCTAssertEqual(headingCommand.expectedBlock, .heading(level: 2, runs: [.init(text: "two")]))
        XCTAssertTrue(engine.isValidTaskListInsertionWitness(headingCommand))
        XCTAssertFalse(engine.isValidTaskListInsertionWitness(.init(
            commandID: headingCommand.commandID,
            editorGeneration: headingCommand.editorGeneration,
            topLevelBlockIndex: headingCommand.topLevelBlockIndex,
            expectedBlock: headingCommand.expectedBlock,
            collapsedScalarOffset: 3
        )))
    }

    func testBlockStyleTransformsOnlyWitnessedTopLevelBlockAndPreservesRuns() throws {
        let reference = LoroCanonicalSemanticValueV1.InlineReference(
            kind: .entity,
            id: try EntityId(validating: "10000000-0000-4000-8000-000000000001"),
            label: "Title"
        )
        let strong = LoroCanonicalSemanticValueV1.TextRun(text: "Title", marks: [.strong], reference: reference)
        let source = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .paragraph([strong]),
            .taskList([.init(checked: false, runs: [.init(text: "task")])]),
            .heading(level: 2, runs: [.init(text: "Notes", marks: [.emphasis])])
        ]))
        var engine = LoroNativeRichEditingEngine(document: source)
        let command = try XCTUnwrap(engine.makeBlockStyleCommand(
            style: .h1,
            selection: .init(location: 2, length: 1),
            requestToken: 7
        ))
        XCTAssertEqual(command.requestToken, 7)
        XCTAssertEqual(command.topLevelBlockIndex, 0)
        XCTAssertEqual(engine.applyBlockStyle(command), .publish(
            document: .init(semantic: .init(blocks: [
                .heading(level: 1, runs: [strong]),
                .taskList([.init(checked: false, runs: [.init(text: "task")])]),
                .heading(level: 2, runs: [.init(text: "Notes", marks: [.emphasis])])
            ])),
            selection: .init(location: 2, length: 1)
        ))
    }

    func testBlockStyleRejectsTaskListsSeparatorsCrossBlockAndStaleGeneration() throws {
        let source = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .paragraph([.init(text: "one")]),
            .heading(level: 2, runs: [.init(text: "two")]),
            .taskList([.init(checked: false, runs: [.init(text: "task")])])
        ]))
        var engine = LoroNativeRichEditingEngine(document: source)
        XCTAssertNil(engine.makeBlockStyleCommand(style: .h1, selection: .init(location: 3, length: 0)))
        XCTAssertNil(engine.makeBlockStyleCommand(style: .h1, selection: .init(location: 2, length: 2)))
        XCTAssertNil(engine.makeBlockStyleCommand(style: .h1, selection: .init(location: 7, length: 0)))
        let command = try XCTUnwrap(engine.makeBlockStyleCommand(style: .h1, selection: .init(location: 0, length: 1)))
        _ = engine.replace(utf16Range: NSRange(location: 0, length: 0), withPlainText: "x")
        XCTAssertEqual(engine.applyBlockStyle(command), .rejected(.invalidEdit))
    }

    func testBlockStyleSameStyleIsNoChange() throws {
        var engine = LoroNativeRichEditingEngine(document: paragraph("text"))
        let command = try XCTUnwrap(engine.makeBlockStyleCommand(style: .text, selection: .init(location: 1, length: 0)))
        XCTAssertEqual(engine.applyBlockStyle(command), .noChange)
        XCTAssertNil(engine.pendingLocalDocument)
    }

    func testInlineMarkCommandAppliesMixedRunsAcrossParagraphHeadingAndTaskItem() throws {
        let task = LoroCanonicalSemanticValueV1.TaskItem(checked: false, runs: [.init(text: "todo")])
        let source = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .paragraph([.init(text: "one"), .init(text: " two", marks: [.strong])]),
            .heading(level: 2, runs: [.init(text: "head")]),
            .taskList([task])
        ]))
        var engine = LoroNativeRichEditingEngine(document: source)
        let command = try XCTUnwrap(engine.makeInlineMarkCommand(mark: .strong, selection: .init(location: 0, length: 7), requestToken: 4))
        XCTAssertEqual(command.operation, .remove)
        guard case let .publish(document, selection) = engine.applyInlineMark(command) else { return XCTFail("expected semantic publish") }
        XCTAssertEqual(selection, .init(location: 0, length: 7))
        XCTAssertEqual(document.semantic.blocks[0], .paragraph([.init(text: "one two")]))
        _ = engine.receiveParentDocument(document)
        let taskCommand = try XCTUnwrap(engine.makeInlineMarkCommand(mark: .code, selection: .init(location: 13, length: 4)))
        XCTAssertEqual(engine.applyInlineMark(taskCommand), .publish(document: .init(semantic: .init(blocks: [
            .paragraph([.init(text: "one two")]), .heading(level: 2, runs: [.init(text: "head")]),
            .taskList([.init(checked: false, runs: [.init(text: "todo", marks: [.code])])])
        ])), selection: .init(location: 13, length: 4)))
    }

    func testInlineMarkRejectsPartialReferenceAndStaleFingerprint() throws {
        let reference = LoroCanonicalSemanticValueV1.InlineReference(kind: .entity, id: try EntityId(validating: "10000000-0000-4000-8000-000000000001"), label: "Alice")
        let source = LoroNativeRichDocumentV1(semantic: .init(blocks: [.paragraph([.init(text: "Alice", reference: reference)])]))
        var engine = LoroNativeRichEditingEngine(document: source)
        XCTAssertNil(engine.makeInlineMarkCommand(mark: .strong, selection: .init(location: 1, length: 2)))
        let command = try XCTUnwrap(engine.makeInlineMarkCommand(mark: .strong, selection: .init(location: 0, length: 5)))
        _ = engine.replace(utf16Range: NSRange(location: 0, length: 0), withPlainText: "x")
        XCTAssertEqual(engine.applyInlineMark(command), .rejected(.invalidEdit))
    }

    func testMarkdownShortcutConvertsAllApprovedTerminalPatternsAtomically() throws {
        let cases: [(String, LoroCanonicalSemanticValueV1.Block)] = [
            ("#", .heading(level: 1, runs: [])),
            ("##", .heading(level: 2, runs: [])),
            ("###", .heading(level: 3, runs: [])),
            ("[]", .taskList([.init(checked: false, runs: [])])),
            ("[ ]", .taskList([.init(checked: false, runs: [])]))
        ]
        for (text, expected) in cases {
            var engine = LoroNativeRichEditingEngine(document: paragraph(text))
            let command = try XCTUnwrap(engine.makeMarkdownShortcutCommand(selection: .init(location: text.unicodeScalars.count, length: 0), requestToken: 9))
            XCTAssertEqual(command.requestedBlock, expected)
            XCTAssertEqual(engine.applyMarkdownShortcut(command), .publish(document: .init(semantic: .init(blocks: [expected])), selection: .init(location: 0, length: 0)))
        }
    }

    func testMarkdownShortcutPreservesDocumentTopologyAndPlacesCaretAtBlockStart() throws {
        let source = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .paragraph([.init(text: "before")]),
            .paragraph([.init(text: "#")]),
            .paragraph([.init(text: "after")])
        ]))
        var engine = LoroNativeRichEditingEngine(document: source)
        let command = try XCTUnwrap(engine.makeMarkdownShortcutCommand(selection: .init(location: 8, length: 0), requestToken: 3))

        XCTAssertEqual(
            engine.applyMarkdownShortcut(command),
            .publish(
                document: .init(semantic: .init(blocks: [
                    .paragraph([.init(text: "before")]),
                    .heading(level: 1, runs: []),
                    .paragraph([.init(text: "after")])
                ])),
                selection: .init(location: 7, length: 0)
            )
        )
    }

    func testMarkdownShortcutRejectsNonExactOrUnsafeWitnesses() throws {
        var tooMany = LoroNativeRichEditingEngine(document: paragraph("####"))
        var suffix = LoroNativeRichEditingEngine(document: paragraph("#x"))
        var marked = LoroNativeRichEditingEngine(document: paragraph("#", marks: [.strong]))
        XCTAssertNil(tooMany.makeMarkdownShortcutCommand(selection: .init(location: 4, length: 0)))
        XCTAssertNil(suffix.makeMarkdownShortcutCommand(selection: .init(location: 2, length: 0)))
        XCTAssertNil(marked.makeMarkdownShortcutCommand(selection: .init(location: 1, length: 0)))
        var engine = LoroNativeRichEditingEngine(document: paragraph("#"))
        let command = try XCTUnwrap(engine.makeMarkdownShortcutCommand(selection: .init(location: 1, length: 0)))
        _ = engine.replace(utf16Range: NSRange(location: 0, length: 0), withPlainText: "x")
        XCTAssertEqual(engine.applyMarkdownShortcut(command), .rejected(.invalidEdit))
    }

    func testBlockStyleCanTargetEmptyParagraphAtLeadingMiddleAndTrailingTopologyPositions() throws {
        let leading = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .paragraph([]), .paragraph([.init(text: "after")])
        ]))
        var leadingEngine = LoroNativeRichEditingEngine(document: leading)
        let leadingCommand = try XCTUnwrap(leadingEngine.makeBlockStyleCommand(
            style: .h1, selection: .init(location: 0, length: 0)
        ))
        XCTAssertEqual(leadingCommand.topLevelBlockIndex, 0)
        XCTAssertEqual(leadingEngine.applyBlockStyle(leadingCommand), .publish(
            document: .init(semantic: .init(blocks: [
                .heading(level: 1, runs: []), .paragraph([.init(text: "after")])
            ])), selection: .init(location: 0, length: 0)
        ))

        let middle = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .paragraph([.init(text: "before")]), .paragraph([]), .paragraph([.init(text: "after")])
        ]))
        var middleEngine = LoroNativeRichEditingEngine(document: middle)
        let middleCommand = try XCTUnwrap(middleEngine.makeBlockStyleCommand(
            style: .h2, selection: .init(location: 7, length: 0)
        ))
        XCTAssertEqual(middleCommand.topLevelBlockIndex, 1)
        XCTAssertEqual(middleEngine.applyBlockStyle(middleCommand), .publish(
            document: .init(semantic: .init(blocks: [
                .paragraph([.init(text: "before")]), .heading(level: 2, runs: []), .paragraph([.init(text: "after")])
            ])), selection: .init(location: 7, length: 0)
        ))

        let trailing = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .paragraph([.init(text: "before")]), .paragraph([])
        ]))
        var trailingEngine = LoroNativeRichEditingEngine(document: trailing)
        let trailingCommand = try XCTUnwrap(trailingEngine.makeBlockStyleCommand(
            style: .h3, selection: .init(location: 7, length: 0)
        ))
        XCTAssertEqual(trailingCommand.topLevelBlockIndex, 1)
        XCTAssertEqual(trailingEngine.applyBlockStyle(trailingCommand), .publish(
            document: .init(semantic: .init(blocks: [
                .paragraph([.init(text: "before")]), .heading(level: 3, runs: [])
            ])), selection: .init(location: 7, length: 0)
        ))
    }

    func testPendingParentAcknowledgementIsExactAndDifferentParentIsDeferred() {
        var engine = LoroNativeRichEditingEngine(document: paragraph("base"))
        let local = paragraph("base local")
        _ = engine.replace(utf16Range: NSRange(location: 4, length: 0), withPlainText: " local")

        XCTAssertEqual(engine.receiveParentDocument(paragraph("remote")), .deferredForLocalProposal)
        XCTAssertEqual(engine.admittedDocument, local)
        XCTAssertEqual(
            engine.receiveParentDocument(local),
            .acknowledged(document: local, selection: .init(location: 10, length: 0))
        )
        XCTAssertNil(engine.pendingLocalDocument)
        XCTAssertEqual(
            engine.receiveParentDocument(paragraph("remote")),
            .adopted(document: paragraph("remote"), selection: .init(location: 10, length: 0))
        )
    }

    func testCompositionDefersParentAndCommitsOnceFromCapturedSemanticBase() {
        let source = heading("title", marks: [.code, .strong])
        var engine = LoroNativeRichEditingEngine(document: source)

        XCTAssertEqual(engine.beginComposition(utf16Range: NSRange(location: 4, length: 0)), .noChange)
        engine.updateComposition("intermediate")
        XCTAssertEqual(engine.receiveParentDocument(paragraph("remote")), .deferredForComposition)
        engine.finalizeComposition("final")

        XCTAssertEqual(
            engine.commitComposition(),
            .publish(
                document: heading("titlfinale", marks: [.code, .strong]),
                selection: .init(location: 9, length: 0)
            )
        )
        XCTAssertEqual(engine.commitComposition(), .noChange)
    }

    func testCancelCompositionRestoresAdmittedDocumentAndSurrogateInteriorIsRejected() {
        let source = paragraph("A😀B")
        var engine = LoroNativeRichEditingEngine(document: source)
        XCTAssertEqual(engine.beginComposition(utf16Range: NSRange(location: 1, length: 0)), .noChange)
        engine.updateComposition("x")
        XCTAssertEqual(engine.cancelComposition(), .restore(document: source, selection: .init(location: 0, length: 0)))
        XCTAssertEqual(engine.replace(utf16Range: NSRange(location: 2, length: 0), withPlainText: "x"), .rejected(.invalidEdit))
        XCTAssertEqual(engine.admittedDocument, source)
    }

    func testReferenceEditingIsAtomicWhileBoundaryInsertionStaysOutside() throws {
        let source = referenceParagraph()
        var engine = LoroNativeRichEditingEngine(document: source)

        XCTAssertEqual(engine.replace(utf16Range: NSRange(location: 6, length: 0), withPlainText: "x"), .rejected(.invalidEdit))
        XCTAssertEqual(engine.replace(utf16Range: NSRange(location: 5, length: 1), withPlainText: "A"), .rejected(.invalidEdit))
        XCTAssertEqual(engine.admittedDocument, source)

        guard case let .publish(boundary, _) = engine.replace(utf16Range: NSRange(location: 5, length: 0), withPlainText: "dear ") else {
            return XCTFail("expected boundary insertion")
        }
        XCTAssertEqual(boundary.semantic.blocks, [.paragraph([
            .init(text: "Meet dear "),
            .init(text: "Alice", reference: reference()),
            .init(text: " today")
        ])])
    }

    func testReferenceAllowsOnlyFullSpanDeletion() {
        var engine = LoroNativeRichEditingEngine(document: referenceParagraph())
        XCTAssertEqual(engine.replace(utf16Range: NSRange(location: 6, length: 2), withPlainText: ""), .rejected(.invalidEdit))
        guard case let .publish(deleted, _) = engine.replace(utf16Range: NSRange(location: 5, length: 5), withPlainText: "") else {
            return XCTFail("expected full-span deletion")
        }
        XCTAssertEqual(deleted.semantic.blocks, [.paragraph([.init(text: "Meet  today")])])
    }

    func testInsertReferenceReplacesExplicitTriggerRangeAndMovesCaretAfterAtomicRun() {
        var engine = LoroNativeRichEditingEngine(document: paragraph("Meet @al today"))

        let effect = engine.insert(reference: reference(), replacingUTF16Range: NSRange(location: 5, length: 3))

        let expected = LoroNativeRichDocumentV1(semantic: .init(blocks: [.paragraph([
            .init(text: "Meet "),
            .init(text: "Alice", reference: reference()),
            .init(text: " today")
        ])]))
        XCTAssertEqual(effect, .publish(document: expected, selection: .init(location: 10, length: 0)))
        XCTAssertEqual(engine.admittedDocument, expected)
    }

    func testInsertReferenceRejectsCompositionAndAnyReferenceOverlap() {
        let source = referenceParagraph()
        var engine = LoroNativeRichEditingEngine(document: source)

        XCTAssertEqual(engine.insert(reference: reference(), replacingUTF16Range: NSRange(location: 5, length: 5)), .rejected(.invalidEdit))
        XCTAssertEqual(engine.beginComposition(utf16Range: NSRange(location: 0, length: 0)), .noChange)
        XCTAssertEqual(engine.insert(reference: reference(), replacingUTF16Range: NSRange(location: 0, length: 0)), .rejected(.invalidEdit))
        XCTAssertEqual(engine.admittedDocument, source)
    }

    private func paragraph(_ text: String, marks: [LoroCanonicalSemanticValueV1.Mark] = []) -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.paragraph(text.isEmpty ? [] : [.init(text: text, marks: marks)])]))
    }

    private func taskList(_ items: [LoroCanonicalSemanticValueV1.TaskItem]) -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.taskList(items)]))
    }

    private func heading(_ text: String, marks: [LoroCanonicalSemanticValueV1.Mark] = []) -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.heading(level: 1, runs: text.isEmpty ? [] : [.init(text: text, marks: marks)])]))
    }

    private func reference() -> LoroCanonicalSemanticValueV1.InlineReference {
        .init(kind: .entity, id: try! EntityId(validating: "10000000-0000-4000-8000-000000000001"), label: "Alice")
    }

    private func referenceParagraph() -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.paragraph([
            .init(text: "Meet "), .init(text: "Alice", reference: reference()), .init(text: " today")
        ])]))
    }
}
