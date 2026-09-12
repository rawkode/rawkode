import AppKit
import XCTest
@testable import NativeRichEditor

final class EditorKeyboardTests: XCTestCase {
    @MainActor
    func testBoldAndItalicKeepSelectionAndUnselectedText() throws {
        try withEditor("before chosen after") { session, text in
            let selection = (text.string as NSString).range(of: "chosen")
            text.setSelectedRange(selection)

            for trait in [NSFontTraitMask.boldFontMask, .italicFontMask] {
                session.toggleFont(trait)
                XCTAssertEqual(text.selectedRange(), selection)
                XCTAssertEqual(text.string, "before chosen after")
                XCTAssertTrue(try fontTraits(text, at: selection.location).contains(trait))
                XCTAssertFalse(try fontTraits(text, at: 0).contains(trait))
                XCTAssertFalse(try fontTraits(text, at: NSMaxRange(selection) + 1).contains(trait))

                session.toggleFont(trait)
                XCTAssertEqual(text.selectedRange(), selection)
                XCTAssertFalse(try fontTraits(text, at: selection.location).contains(trait))
            }
        }
    }

    @MainActor
    func testCaretFontToggleCanTurnOffBeforeTyping() throws {
        try withEditor("hello") { session, text in
            for trait in [NSFontTraitMask.boldFontMask, .italicFontMask] {
                text.setSelectedRange(NSRange(location: 2, length: 0))
                text.typingAttributes = EditorSession.bodyAttributes
                session.toggleFont(trait)
                let enabled = try XCTUnwrap(text.typingAttributes[.font] as? NSFont)
                XCTAssertTrue(NSFontManager.shared.traits(of: enabled).contains(trait))
                session.toggleFont(trait)
                let disabled = try XCTUnwrap(text.typingAttributes[.font] as? NSFont)
                XCTAssertFalse(NSFontManager.shared.traits(of: disabled).contains(trait),
                               "A second shortcut must read the active typing font, not the character ahead")
            }
            text.insertText("X", replacementRange: text.selectedRange())
            XCTAssertEqual(text.string, "heXllo")
            XCTAssertFalse(try fontTraits(text, at: 2).contains(.italicFontMask))
        }
    }

    @MainActor
    func testHeadingKeepsCaretAndStylesSubsequentTyping() throws {
        try withEditor("alpha beta\nnext paragraph") { session, text in
            let caret = NSRange(location: 5, length: 0)
            text.setSelectedRange(caret)
            session.setParagraphStyle(heading: true)

            XCTAssertEqual(text.selectedRange(), caret, "Formatting a paragraph should not move the insertion point")
            let heading = try XCTUnwrap(text.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
            let next = try XCTUnwrap(text.textStorage?.attribute(.font, at: 11, effectiveRange: nil) as? NSFont)
            XCTAssertGreaterThan(heading.pointSize, next.pointSize)
            text.insertText("!", replacementRange: text.selectedRange())
            XCTAssertEqual(text.string, "alpha! beta\nnext paragraph")
            let inserted = try XCTUnwrap(text.textStorage?.attribute(.font, at: 5, effectiveRange: nil) as? NSFont)
            XCTAssertEqual(inserted.pointSize, heading.pointSize, "Typing inside a heading must keep its style")
        }
    }

    @MainActor
    func testHeadingFormattingCanUndoAndRedo() throws {
        try withEditor("A heading\nBody") { session, text in
            let undo = try XCTUnwrap(text.undoManager)
            undo.groupsByEvent = false
            text.setSelectedRange(NSRange(location: 2, length: 0))
            undo.beginUndoGrouping()
            session.setParagraphStyle(heading: true)
            undo.endUndoGrouping()
            let heading = try XCTUnwrap(text.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
            XCTAssertGreaterThan(heading.pointSize, 17)
            XCTAssertTrue(undo.canUndo)

            undo.undo()
            let restored = try XCTUnwrap(text.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
            XCTAssertEqual(restored.pointSize, 17)
            XCTAssertEqual(try XCTUnwrap(session.document).attributedString().string, "A heading\nBody")
            XCTAssertTrue(undo.canRedo)
            undo.redo()
            let redone = try XCTUnwrap(text.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
            XCTAssertEqual(redone.pointSize, heading.pointSize)
            let saved = try XCTUnwrap(session.document).attributedString()
            XCTAssertEqual((saved.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize, heading.pointSize)
        }
    }

    @MainActor
    func testTypingInsideCodePreservesEditableSourceAndCodeSemantics() throws {
        let content = NSMutableAttributedString(attributedString: CodeBlockStyle.attributed("let answer = 4", language: "swift"))
        content.append(NSAttributedString(string: "\nAfter", attributes: EditorSession.bodyAttributes))
        try withEditor(content) { session, text in
            let position = ("let answer = " as NSString).length
            text.setSelectedRange(NSRange(location: position, length: 0))
            text.insertText("2", replacementRange: text.selectedRange())
            XCTAssertEqual(text.string, "let answer = 24\nAfter")
            XCTAssertEqual(text.selectedRange(), NSRange(location: position + 1, length: 0))
            XCTAssertEqual(text.textStorage?.attribute(.codeLanguage, at: position, effectiveRange: nil) as? String, "swift")
            let document = try XCTUnwrap(session.document)
            XCTAssertEqual(try document.attributedString().string, text.string)
            let code = document.codeBlocks.filter { $0.attrs?.language == "swift" }.map(\.textContent).joined()
            XCTAssertEqual(code, "let answer = 24")
            XCTAssertNil(text.textStorage?.attribute(.codeLanguage, at: ("let answer = 24\n" as NSString).length, effectiveRange: nil))
        }
    }

    @MainActor
    func testDiagramConversionMapsUnicodeSelectionAfterFence() throws {
        let prefix = "Sketch 👩🏽‍💻 and café\n"
        let fenced = "```mermaid\nflowchart LR\n火 --> 💡\n```"
        let suffix = "\nTail 💡 words"
        try withEditor(prefix + fenced + suffix) { session, text in
            let selectedText = "Tail 💡"
            text.setSelectedRange((text.string as NSString).range(of: selectedText))
            session.convertCompletedFences()
            XCTAssertEqual(text.string, prefix + "\u{fffc}" + suffix)
            XCTAssertEqual(text.selectedRange(), (text.string as NSString).range(of: selectedText),
                           "Conversion must map both selection endpoints in UTF-16")
            let attachment = try XCTUnwrap(text.textStorage?.attribute(.attachment, at: (prefix as NSString).length,
                                                                       effectiveRange: nil) as? ComponentAttachment)
            XCTAssertEqual(attachment.component.kind, .mermaid)
            XCTAssertEqual(attachment.component.source, "flowchart LR\n火 --> 💡")
            XCTAssertNotNil(text.textLayoutManager)
        }
    }

    @MainActor
    func testDiagramConversionDoesNotMoveCaretBeforeFence() {
        withEditor("Before 👋\n```d2\na -> b\n```\nAfter") { session, text in
            let caret = NSRange(location: 3, length: 0)
            text.setSelectedRange(caret)
            session.convertCompletedFences()
            XCTAssertEqual(text.selectedRange(), caret)
            XCTAssertEqual(text.string, "Before 👋\n\u{fffc}\nAfter")
        }
    }

    @MainActor
    func testMarkdownShortcutsDoNotRewriteSourceInsideOpenFence() throws {
        try withEditor("```python\n") { session, text in
            text.setSelectedRange(NSRange(location: text.string.utf16.count, length: 0))
            for input in ["#", " ", "comment"] {
                text.insertText(input, replacementRange: text.selectedRange())
            }
            XCTAssertEqual(text.string, "```python\n# comment", "Source must stay literal before the closing fence")
            text.insertNewline(nil)
            text.insertText("```", replacementRange: text.selectedRange())
            XCTAssertEqual(text.string, "# comment")
            let document = try XCTUnwrap(session.document)
            XCTAssertTrue(document.codeBlocks.contains { $0.attrs?.language == "python" && $0.textContent == "# comment" })
        }
    }

    @MainActor
    private func fontTraits(_ text: DocumentTextView, at position: Int) throws -> NSFontTraitMask {
        let font = try XCTUnwrap(text.textStorage?.attribute(.font, at: position, effectiveRange: nil) as? NSFont)
        return NSFontManager.shared.traits(of: font)
    }

    @MainActor
    private func withEditor(_ source: String, _ body: (EditorSession, DocumentTextView) throws -> Void) rethrows {
        try withEditor(NSAttributedString(string: source, attributes: EditorSession.bodyAttributes), body)
    }

    @MainActor
    private func withEditor(_ content: NSAttributedString, _ body: (EditorSession, DocumentTextView) throws -> Void) rethrows {
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-note-keyboard-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        // An unshown window provides the native responder and undo environment.
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 500),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let session = EditorSession(dataDirectory: directory)
        let text = DocumentTextView(usingTextLayoutManager: true)
        text.frame = NSRect(x: 0, y: 0, width: 700, height: 500)
        text.isRichText = true
        text.allowsUndo = true
        text.session = session
        text.delegate = session
        text.typingAttributes = EditorSession.bodyAttributes
        window.contentView = text
        window.makeFirstResponder(text)
        session.attach(text)
        text.textStorage?.setAttributedString(content)
        text.setSelectedRange(NSRange(location: 0, length: 0))
        session.acceptNativeEdit()
        text.undoManager?.removeAllActions()
        try body(session, text)
    }
}
