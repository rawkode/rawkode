import AppKit
import XCTest
@testable import NativeRichEditor

final class BlockConversionTests: XCTestCase {
    @MainActor
    func testBlockStyleChangesPreserveInlineMarksAndCodeThroughReopen() throws {
        let value = NSMutableAttributedString(string: "bold italic code plain", attributes: EditorSession.bodyAttributes)
        value.addAttribute(.font, value: NSFont.boldSystemFont(ofSize: 17), range: NSRange(location: 0, length: 4))
        value.addAttribute(.font, value: NSFontManager.shared.convert(NSFont.systemFont(ofSize: 17), toHaveTrait: .italicFontMask), range: NSRange(location: 5, length: 6))
        value.addAttributes([.nativeInlineCode: true, .font: NSFont.monospacedSystemFont(ofSize: 16, weight: .regular), .backgroundColor: NSColor.quaternaryLabelColor], range: NSRange(location: 12, length: 4))
        try withEditor(value) { session, text in
            for style in [TextBlockStyle.heading2, .paragraph, .quote, .heading3, .paragraph] {
                text.setSelectedRange(NSRange(location: 0, length: value.length))
                session.applyTextStyle(style)
                let note = try XCTUnwrap(session.document)
                let runs = note.textNodes
                XCTAssertEqual(runs.first(where: { $0.textContent.contains("bold") })?.hasMark(.bold), true)
                XCTAssertEqual(runs.first(where: { $0.textContent.contains("italic") })?.hasMark(.italic), true)
                XCTAssertEqual(runs.first(where: { $0.textContent.contains("code") })?.hasMark(.code), true)
                XCTAssertEqual(runs.first(where: { $0.textContent.contains("plain") })?.hasMark(.bold), false, "Structural heading weight must not become an inline bold mark")
                let reopened = try note.attributedString()
                XCTAssertEqual(reopened.string, value.string)
                XCTAssertEqual((reopened.attribute(.font, at: 12, effectiveRange: nil) as? NSFont)?.isFixedPitch, true)
                let background = try XCTUnwrap((reopened.attribute(.backgroundColor, at: 12, effectiveRange: nil) as? NSColor)?.usingColorSpace(.sRGB))
                let expected = try XCTUnwrap(NSColor.quaternaryLabelColor.usingColorSpace(.sRGB))
                XCTAssertEqual(background.redComponent, expected.redComponent, accuracy: 0.005)
                XCTAssertEqual(background.alphaComponent, expected.alphaComponent, accuracy: 0.005)
                // Exercise the next conversion from the actual persisted projection.
                text.textStorage?.setAttributedString(reopened)
            }
        }
    }

    @MainActor
    func testHeadingDefaultsStayStructuralAndExplicitBoldSurvivesStyleConversion() throws {
        try withEditor(NSAttributedString(string: "Heading", attributes: EditorSession.bodyAttributes)) { session, text in
            for style in [TextBlockStyle.heading1, .heading2, .heading3] {
                session.applyTextStyle(style)
                let saved = try XCTUnwrap(session.document).attributedString()
                XCTAssertEqual((saved.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.fontName, style.font.fontName)
                let note = try XCTUnwrap(session.document)
                let run = try XCTUnwrap(note.textNodes.first)
                XCTAssertFalse(run.hasMark(.bold))
                session.applyTextStyle(.paragraph)
                XCTAssertFalse(NSFontManager.shared.traits(of: text.textStorage!.attribute(.font, at: 0, effectiveRange: nil) as! NSFont).contains(.boldFontMask))
            }
            session.applyTextStyle(.heading1)
            text.setSelectedRange(NSRange(location: 0, length: 7))
            session.toggleFont(.boldFontMask)
            session.applyTextStyle(.paragraph)
            let bold = try XCTUnwrap(session.document?.textNodes.first)
            XCTAssertTrue(bold.hasMark(.bold))
        }
        let imported = NoteDocument(content: [.init(type: .heading, attrs: .init(level: 2), content: [.init(type: .text, text: "Browser heading")])])
        XCTAssertEqual((try imported.attributedString().attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.fontName, TextBlockStyle.heading2.font.fontName)
    }

    @MainActor
    func testListToHeadingOrBodyRemovesMarkersAndUndoesAsOneAction() throws {
        for (kind, style) in [(ListEditing.Kind.bullet, TextBlockStyle.heading1),
                              (.bullet, .paragraph), (.numbered, .paragraph), (.task, .paragraph)] {
            try withEditor(NSAttributedString(string: "Item 👩🏽‍💻", attributes: EditorSession.bodyAttributes)) { session, text in
                ListEditing.apply(kind, in: text)
                let listed = text.string
                let oldSelection = text.selectedRange()
                let undo = try XCTUnwrap(text.undoManager)
                undo.removeAllActions()
                undo.groupsByEvent = false

                session.applyTextStyle(style)

                XCTAssertEqual(text.string, "Item 👩🏽‍💻")
                XCTAssertEqual(text.selectedRange().location, text.string.utf16.count)
                let paragraph = try XCTUnwrap(text.textStorage?.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
                XCTAssertTrue(paragraph.textLists.isEmpty)
                XCTAssertEqual((text.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize, style.font.pointSize)
                XCTAssertTrue(undo.canUndo)

                undo.undo()

                XCTAssertEqual(text.string, listed, "One undo must restore both list markers and formatting")
                XCTAssertEqual(text.selectedRange(), oldSelection)
                let restored = try XCTUnwrap(text.textStorage?.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
                XCTAssertEqual(restored.textLists.count, 1)
                XCTAssertEqual(try session.document?.attributedString().string, listed)

                undo.redo()
                XCTAssertEqual(text.string, "Item 👩🏽‍💻")
                XCTAssertEqual((text.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize, style.font.pointSize)
            }
        }
    }

    @MainActor
    func testRemovingListsKeepsProtectedCodeAndComponentParagraphs() throws {
        let paragraph = NSMutableParagraphStyle()
        paragraph.textLists = [NSTextList(markerFormat: .disc, options: 0)]
        var attributes = EditorSession.bodyAttributes
        attributes[.paragraphStyle] = paragraph
        let content = NSMutableAttributedString(string: "\t•\tBody\n", attributes: attributes)
        var codeAttributes = attributes
        codeAttributes[.codeLanguage] = "swift"
        content.append(NSAttributedString(string: "\t•\tlet x = 1\n", attributes: codeAttributes))
        content.append(NSAttributedString(string: "\t•\t", attributes: attributes))
        let component = Component(kind: .diagram, title: "Protected", source: "a -> b")
        content.append(NSAttributedString(attachment: ComponentAttachment(component)))
        content.append(NSAttributedString(string: "\n", attributes: attributes))
        try withEditor(content) { _, text in
            text.setSelectedRange(NSRange(location: 0, length: content.length))
            ListEditing.remove(in: text)

            XCTAssertEqual(text.string, "Body\n\t•\tlet x = 1\n\t•\t\u{fffc}\n")
            let codeIndex = (text.string as NSString).range(of: "let x").location
            XCTAssertEqual(text.textStorage?.attribute(.codeLanguage, at: codeIndex, effectiveRange: nil) as? String, "swift")
            let codeStyle = try XCTUnwrap(text.textStorage?.attribute(.paragraphStyle, at: codeIndex, effectiveRange: nil) as? NSParagraphStyle)
            XCTAssertEqual(codeStyle.textLists.count, 1)
            let attachmentIndex = (text.string as NSString).range(of: "\u{fffc}").location
            XCTAssertEqual((text.textStorage?.attribute(.attachment, at: attachmentIndex, effectiveRange: nil) as? ComponentAttachment)?.component, component)
        }
    }

    @MainActor
    func testInlineMarkdownNeverReplacesAttachmentPayloadWithPlainCharacter() throws {
        for delimiter in ["**", "*", "~~", "`"] {
            let component = Component(kind: .diagram, title: "Keep source", source: "a -> b")
            let content = NSMutableAttributedString(string: delimiter, attributes: EditorSession.bodyAttributes)
            content.append(NSAttributedString(attachment: ComponentAttachment(component)))
            content.append(NSAttributedString(string: String(delimiter.dropLast()), attributes: EditorSession.bodyAttributes))
            try withEditor(content) { session, text in
                text.typingAttributes = EditorSession.bodyAttributes
                text.insertText(String(delimiter.suffix(1)), replacementRange: text.selectedRange())

                XCTAssertEqual(text.string, delimiter + "\u{fffc}" + delimiter)
                let attachment = try XCTUnwrap(text.textStorage?.attribute(.attachment, at: delimiter.utf16.count, effectiveRange: nil) as? ComponentAttachment)
                XCTAssertEqual(attachment.component, component)
                let snapshot = try XCTUnwrap(session.document)
                XCTAssertTrue(snapshot.components.contains(component))
            }
        }
    }

    @MainActor
    private func withEditor(_ content: NSAttributedString, body: (EditorSession, DocumentTextView) throws -> Void) throws {
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let session = EditorSession(dataDirectory: directory)
        let text = DocumentTextView(usingTextLayoutManager: true)
        ListEditing.configure(in: text)
        text.session = session
        text.delegate = session
        text.isRichText = true
        text.allowsUndo = true
        text.frame = window.contentView!.bounds
        window.contentView = text
        window.makeFirstResponder(text)
        session.attach(text)
        text.textStorage?.setAttributedString(content)
        text.setSelectedRange(NSRange(location: content.length, length: 0))
        text.typingAttributes = EditorSession.bodyAttributes
        session.acceptNativeEdit()
        text.undoManager?.removeAllActions()
        try body(session, text)
    }
}
