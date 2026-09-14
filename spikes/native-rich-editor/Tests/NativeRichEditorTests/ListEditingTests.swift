import AppKit
import XCTest
@testable import NativeRichEditor

final class ListEditingTests: XCTestCase {
    @MainActor
    func testMarkdownPrefixesProduceEditableNativeListMarkers() throws {
        for (prefix, expected, ordered) in [
            ("- ", "\t•\t", false), ("* ", "\t•\t", false), ("1. ", "\t1.\t", true),
            ("[] ", "\t☐\t", false), ("[ ] ", "\t☐\t", false), ("- [ ] ", "\t☐\t", false),
        ] {
            try withEditor(prefix) { _, text in
                XCTAssertTrue(ListEditing.handlePrefix(in: text), prefix)
                XCTAssertEqual(text.string, expected, prefix)
                XCTAssertEqual(text.selectedRange().location, expected.utf16.count)
                let style = try paragraphStyle(text, at: 0)
                XCTAssertEqual(style.textLists.count, 1)
                XCTAssertEqual(style.textLists.first?.isOrdered, ordered)
                XCTAssertNotNil(text.textLayoutManager)
            }
        }
    }

    @MainActor
    func testReturnContinuesListAndEmptyReturnExits() throws {
        try withEditor("One") { _, text in
            ListEditing.apply(.bullet, in: text)
            text.typingAttributes[.font] = NSFont.boldSystemFont(ofSize: 19)
            XCTAssertTrue(ListEditing.handleNewline(in: text))
            XCTAssertEqual(text.string, "\t•\tOne\n\t•\t")
            XCTAssertEqual((text.typingAttributes[.font] as? NSFont)?.pointSize, 19)
            XCTAssertEqual((text.typingAttributes[.paragraphStyle] as? NSParagraphStyle)?.textLists.count, 1)
            XCTAssertTrue(ListEditing.handleNewline(in: text))
            XCTAssertEqual(text.string, "\t•\tOne\n")
            XCTAssertTrue((text.typingAttributes[.paragraphStyle] as? NSParagraphStyle)?.textLists.isEmpty == true)
            text.insertText("After", replacementRange: text.selectedRange())
            XCTAssertEqual(text.string, "\t•\tOne\nAfter")
            XCTAssertTrue(try paragraphStyle(text, at: text.string.utf16.count - 1).textLists.isEmpty)
        }
    }

    @MainActor
    func testNumberedInsertionRenumbersFollowingItems() throws {
        try withEditor("One\nTwo\nThree") { _, text in
            text.setSelectedRange(NSRange(location: 0, length: text.string.utf16.count))
            ListEditing.apply(.numbered, in: text)
            XCTAssertEqual(text.string, "\t1.\tOne\n\t2.\tTwo\n\t3.\tThree")
            text.setSelectedRange(NSRange(location: "\t1.\tOne".utf16.count, length: 0))
            text.typingAttributes = text.textStorage!.attributes(at: 4, effectiveRange: nil)
            XCTAssertTrue(ListEditing.handleNewline(in: text))
            XCTAssertEqual(text.string, "\t1.\tOne\n\t2.\t\n\t3.\tTwo\n\t4.\tThree")
            XCTAssertEqual(text.selectedRange().location, "\t1.\tOne\n\t2.\t".utf16.count)
        }
    }

    @MainActor
    func testIndentAndOutdentMaintainNestedNativeLists() throws {
        try withEditor("One\nTwo\nThree") { _, text in
            text.setSelectedRange(NSRange(location: 0, length: text.string.utf16.count))
            ListEditing.apply(.numbered, in: text)
            text.setSelectedRange((text.string as NSString).range(of: "Two"))
            XCTAssertTrue(ListEditing.handleIndent(in: text, outdent: false))
            let middle = (text.string as NSString).range(of: "Two").location
            XCTAssertEqual(try paragraphStyle(text, at: middle).textLists.count, 2)
            XCTAssertEqual(try paragraphStyle(text, at: middle).headIndent, 56)
            XCTAssertEqual(text.string, "\t1.\tOne\n\t1.\tTwo\n\t2.\tThree")
            XCTAssertTrue(ListEditing.handleIndent(in: text, outdent: true))
            XCTAssertEqual(text.string, "\t1.\tOne\n\t2.\tTwo\n\t3.\tThree")
            XCTAssertEqual(try paragraphStyle(text, at: (text.string as NSString).range(of: "Two").location).textLists.count, 1)
        }
    }

    @MainActor
    func testTasksToggleAndPersistAcrossRichTextRoundTrip() throws {
        try withEditor("Plan 👩🏽‍💻\nShip") { session, text in
            text.setSelectedRange(NSRange(location: 0, length: text.string.utf16.count))
            ListEditing.apply(.task, in: text)
            let selection = text.selectedRange()
            XCTAssertTrue(ListEditing.toggleTask(in: text, at: 1))
            XCTAssertEqual(text.string, "\t☑\tPlan 👩🏽‍💻\n\t☐\tShip")
            XCTAssertEqual(text.selectedRange(), selection)
            XCTAssertFalse(ListEditing.toggleTask(in: text, at: 5), "Clicking task text should not toggle it")
            let encoded = try JSONEncoder().encode(XCTUnwrap(session.document))
            let restored = try JSONDecoder().decode(NoteDocument.self, from: encoded).attributedString()
            XCTAssertEqual(restored.string, text.string)
            XCTAssertEqual((restored.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)?.textLists.first?.markerFormat, .box)
            XCTAssertTrue(ListEditing.toggleTask(in: text, at: 1))
            XCTAssertTrue(text.string.hasPrefix("\t☐\t"))
        }
    }

    @MainActor
    func testListFormattingPreservesInlineFontsAndCanUndo() throws {
        try withEditor("One\nTwo") { session, text in
            text.textStorage?.addAttribute(.font, value: NSFont.boldSystemFont(ofSize: 24), range: NSRange(location: 0, length: 3))
            text.setSelectedRange(NSRange(location: 0, length: text.string.utf16.count))
            let undo = try XCTUnwrap(text.undoManager)
            undo.removeAllActions()
            undo.groupsByEvent = false
            undo.beginUndoGrouping()
            ListEditing.apply(.bullet, in: text)
            undo.endUndoGrouping()
            XCTAssertEqual((text.textStorage?.attribute(.font, at: 3, effectiveRange: nil) as? NSFont)?.pointSize, 24)
            XCTAssertTrue(undo.canUndo)
            undo.undo()
            XCTAssertEqual(text.string, "One\nTwo")
            XCTAssertEqual((text.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize, 24)
            XCTAssertEqual(try session.document?.attributedString().string, "One\nTwo")
            undo.redo()
            XCTAssertEqual(text.string, "\t•\tOne\n\t•\tTwo")
            undo.groupsByEvent = true
            text.setSelectedRange(NSRange(location: 0, length: text.string.utf16.count))
            ListEditing.apply(.bullet, in: text)
            XCTAssertFalse(text.string.contains("•"))
        }
    }

    @MainActor
    func testEditingListDoesNotReplaceUnrelatedAttachment() throws {
        try withEditor("Item") { session, text in
            let attachment = ComponentAttachment(Component(kind: .drawing, title: "Preserve", drawing: .sample))
            let value = NSMutableAttributedString(attachment: attachment)
            value.append(NSAttributedString(string: "\nItem", attributes: EditorSession.bodyAttributes))
            text.textStorage?.setAttributedString(value)
            session.acceptNativeEdit()
            text.setSelectedRange(NSRange(location: value.length, length: 0))
            ListEditing.apply(.bullet, in: text)
            XCTAssertTrue((text.textStorage?.attribute(.attachment, at: 0, effectiveRange: nil) as? ComponentAttachment) === attachment)
            XCTAssertEqual(text.string, "\u{fffc}\n\t•\tItem")
        }
    }

    @MainActor
    private func paragraphStyle(_ text: DocumentTextView, at index: Int) throws -> NSParagraphStyle {
        try XCTUnwrap(text.textStorage?.attribute(.paragraphStyle, at: index, effectiveRange: nil) as? NSParagraphStyle)
    }

    @MainActor
    private func withEditor(_ source: String, body: (EditorSession, DocumentTextView) throws -> Void) throws {
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 500),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let session = EditorSession(dataDirectory: directory)
        let text = DocumentTextView(usingTextLayoutManager: true)
        ListEditing.configure(in: text)
        text.session = session
        text.delegate = session
        text.allowsUndo = true
        text.isRichText = true
        text.frame = NSRect(x: 0, y: 0, width: 700, height: 500)
        window.contentView = text
        window.makeFirstResponder(text)
        session.attach(text)
        text.textStorage?.setAttributedString(NSAttributedString(string: source, attributes: EditorSession.bodyAttributes))
        text.setSelectedRange(NSRange(location: source.utf16.count, length: 0))
        text.typingAttributes = EditorSession.bodyAttributes
        session.acceptNativeEdit()
        text.undoManager?.removeAllActions()
        try body(session, text)
    }
}
