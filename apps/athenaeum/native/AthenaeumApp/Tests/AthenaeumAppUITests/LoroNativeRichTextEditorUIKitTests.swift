#if os(iOS)
import Foundation
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import AthenaeumAppUI
@testable import AthenaeumCore
import AthenaeumDomain

@MainActor
final class LoroNativeRichTextEditorUIKitTests: XCTestCase {
    func testPlainTextProviderIsAllowedAndRichAndAttachmentProvidersAreRejected() {
        let plain = NSItemProvider(object: "plain" as NSString)
        let rich = NSItemProvider()
        rich.registerDataRepresentation(forTypeIdentifier: UTType.rtf.identifier, visibility: .all) { completion in
            completion(Data(), nil)
            return nil
        }
        let attachment = NSItemProvider(object: UIImage(systemName: "paperclip")!)

        XCTAssertTrue(LoroNativeRichTextEditorUIKitController.testingAllowsOnlyLonePlainTextProvider(plain))
        XCTAssertFalse(LoroNativeRichTextEditorUIKitController.testingAllowsOnlyLonePlainTextProvider(rich))
        XCTAssertFalse(LoroNativeRichTextEditorUIKitController.testingAllowsOnlyLonePlainTextProvider(attachment))
    }

    func testCompositionPublishesExactlyOnceFromCapturedSemanticBase() {
        let source = heading("title", marks: [.code, .strong])
        var published: [LoroNativeRichDocumentV1] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: source,
            isEditable: true,
            onDocumentChange: { published.append($0) }
        )

        controller.testingBeginComposition(range: NSRange(location: 4, length: 0))
        controller.testingChangeComposition("intermediate")
        controller.testingFinalizeComposition("final")
        controller.testingEndComposition()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))

        XCTAssertEqual(controller.testingDocument(), heading("titlfinale", marks: [.code, .strong]))
        XCTAssertEqual(published.count, 1)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(published.count, 1)
    }

    func testParentReplacementCancelsCompositionBeforeRenderingNextDocument() {
        let source = paragraph("today")
        let next = paragraph("tomorrow")
        let controller = LoroNativeRichTextEditorUIKitController(document: source, isEditable: true)

        controller.testingBeginComposition(range: NSRange(location: 5, length: 0))
        controller.testingChangeComposition("draft")
        controller.testingUpdate(document: next, isEditable: false)

        XCTAssertEqual(controller.testingDocument(), next)
    }

    func testAcknowledgedParentDocumentRetainsThePublishedSemanticValueWithoutASecondWrite() throws {
        let source = heading("title", marks: [.code, .strong])
        var published: [LoroNativeRichDocumentV1] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: source,
            isEditable: true,
            onDocumentChange: { published.append($0) }
        )

        controller.testingReplace(NSRange(location: 5, length: 0), with: " today")
        let persisted = try XCTUnwrap(published.first)
        controller.testingUpdate(document: persisted, isEditable: true)

        XCTAssertEqual(persisted, heading("title today", marks: [.code, .strong]))
        XCTAssertEqual(controller.testingDocument(), persisted)
        XCTAssertEqual(published, [persisted])
    }

    func testReferencePasteAndActivationStayAtTheTypedUIKitBoundary() {
        let source = referenceParagraph()
        var opened: LoroCanonicalSemanticValueV1.InlineReference?
        let controller = LoroNativeRichTextEditorUIKitController(
            document: source,
            isEditable: true,
            onOpenReference: { opened = $0 }
        )

        controller.testingPastePlainText("x", at: NSRange(location: 6, length: 0))
        XCTAssertFalse(controller.testingOpenReference(atUTF16Offset: 1))
        XCTAssertTrue(controller.testingOpenReference(atUTF16Offset: 6))

        XCTAssertEqual(controller.testingDocument(), source)
        XCTAssertEqual(opened, reference())
    }

    func testReferenceKeyboardSelectionActivationUsesOnlyTheTypedMarker() {
        var opened = 0
        let controller = LoroNativeRichTextEditorUIKitController(document: referenceParagraph(), isEditable: true, onOpenReference: { _ in opened += 1 })
        controller.testingOpenReference(atUTF16Offset: 6)
        XCTAssertEqual(opened, 1)
    }

    func testNativeFocusChangesAreForwardedForWritingSurfacePresentation() {
        var changes: [Bool] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: paragraph("focus"),
            isEditable: true,
            onFocusChange: { changes.append($0) }
        )

        controller.testingNotifyFocusChanged(true)
        controller.testingNotifyFocusChanged(false)

        XCTAssertEqual(changes, [true, false])
    }

    private func paragraph(_ text: String) -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.paragraph([.init(text: text)])]))
    }

    private func heading(_ text: String, marks: [LoroCanonicalSemanticValueV1.Mark]) -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.heading(level: 1, runs: [.init(text: text, marks: marks)])]))
    }

    private func reference() -> LoroCanonicalSemanticValueV1.InlineReference {
        .init(kind: .supertag, id: try! EntityId(validating: "10000000-0000-4000-8000-000000000002"), label: "Project")
    }

    private func referenceParagraph() -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.paragraph([
            .init(text: "Meet "), .init(text: "Project", reference: reference())
        ])]))
    }
}
#endif
