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
