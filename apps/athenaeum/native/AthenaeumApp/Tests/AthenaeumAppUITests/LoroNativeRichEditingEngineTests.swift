import Foundation
import XCTest
@testable import AthenaeumAppUI
@testable import AthenaeumCore

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

    private func paragraph(_ text: String, marks: [LoroCanonicalSemanticValueV1.Mark] = []) -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.paragraph(text.isEmpty ? [] : [.init(text: text, marks: marks)])]))
    }

    private func heading(_ text: String, marks: [LoroCanonicalSemanticValueV1.Mark] = []) -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.heading(level: 1, runs: text.isEmpty ? [] : [.init(text: text, marks: marks)])]))
    }
}
