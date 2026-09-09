import AppKit
import XCTest
@testable import NativeRichEditor

final class BlockConversionTests: XCTestCase {
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
                XCTAssertTrue(snapshot.segments.contains { if case .component(let value) = $0 { return value == component }; return false })
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
