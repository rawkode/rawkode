import AppKit
import XCTest
@testable import NativeRichEditor

final class TiptapDocumentTests: XCTestCase {
    private var fixture: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/tiptap.native-note") }

    @MainActor
    func testNestedMultiParagraphListsKeepTheirTreeWhenTextChanges() throws {
        let nested = EditorNode(type: .orderedList, attrs: .init(start: 3), content: [
            .init(type: .listItem, content: [paragraph("First"), paragraph("Continuation"),
                .init(type: .taskList, content: [.init(type: .taskItem, attrs: .init(checked: true), content: [paragraph("Nested task")])])]),
            .init(type: .listItem, content: [paragraph("Second")]),
        ])
        let note = NoteDocument(content: [.init(type: .blockquote, content: [paragraph("Quote"), nested])])
        let native = NSMutableAttributedString(attributedString: try note.attributedString())
        XCTAssertTrue(native.string.contains("\t3.\tFirst\nContinuation\n\t☑\tNested task\n\t4.\tSecond"))
        let range = (native.string as NSString).range(of: "Continuation")
        native.replaceCharacters(in: range, with: "Edited continuation")
        let saved = try NoteDocument(attributedString: native)
        XCTAssertEqual(saved.content.first?.type, .blockquote)
        let list = try XCTUnwrap(saved.descendants.first { $0.type == .orderedList })
        XCTAssertEqual(list.attrs?.start, 3)
        XCTAssertEqual(list.content?.count, 2)
        XCTAssertEqual(list.content?.first?.content?[1].textContent, "Edited continuation")
        XCTAssertEqual(list.content?.first?.content?[2].type, .taskList)
        XCTAssertEqual(saved.descendants.first { $0.type == .taskItem }?.attrs?.checked, true)
        XCTAssertEqual(try NoteDocument(attributedString: saved.attributedString()), saved)
    }

    @MainActor
    func testCodeContentExactAndEmptyDocumentUsesParagraph() throws {
        let note = NoteDocument(content: [
            .init(type: .codeBlock, attrs: .init(language: "swift"), content: [.init(type: .text, text: "let π = 3.14\r\nprint(π)\n")]),
            .init(type: .codeBlock), paragraph("After"),
        ])
        let roundTrip = try NoteDocument(attributedString: note.attributedString())
        XCTAssertEqual(roundTrip.codeBlocks.map(\.textContent), ["let π = 3.14\r\nprint(π)\n", ""])
        XCTAssertEqual(roundTrip.content.last?.textContent, "After")
        XCTAssertEqual(try NoteDocument(attributedString: NSAttributedString(string: "")).content, [.init(type: .paragraph)])
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(note)) as! [String: Any]
        XCTAssertEqual(encoded["type"] as? String, "doc")
        XCTAssertNil(encoded["version"])
        XCTAssertNil(encoded["segments"])
    }

    @MainActor
    func testInlineComponentsAndHardBreaksKeepMarksAndPayloads() throws {
        let component = Component(kind: .diagram, title: "Inline", source: "a -> b")
        let marks: [EditorMark] = [.init(type: .bold), .init(type: .link, attrs: .init(href: "https://example.com", target: "_blank", rel: "noopener noreferrer")), .init(type: .textStyle, attrs: .init(color: "red"))]
        let note = NoteDocument(content: [.init(type: .paragraph, content: [
            .init(type: .text, text: "before "), .init(type: .component, attrs: .init(component: component), marks: marks),
            .init(type: .hardBreak, marks: [.init(type: .italic)]), .init(type: .text, text: "after"),
        ])])
        let native = try note.attributedString()
        XCTAssertEqual(native.string, "before \u{fffc}\u{2028}after")
        let saved = try NoteDocument(attributedString: native)
        XCTAssertEqual(saved.components, [component])
        let atom = try XCTUnwrap(saved.descendants.first { $0.type == .component })
        XCTAssertTrue(atom.hasMark(.bold))
        XCTAssertEqual(atom.marks?.first { $0.type == .link }?.attrs?.rel, "noopener noreferrer")
        XCTAssertEqual(atom.marks?.first { $0.type == .textStyle }?.attrs?.color, "red")
        XCTAssertTrue(saved.descendants.first { $0.type == .hardBreak }?.hasMark(.italic) == true)
    }

    @MainActor
    func testRejectsOldShapesAndUnsupportedNativeContent() throws {
        for json in [#"{"version":2,"segments":[]}"#, #"{"type":"doc","content":[{"type":"future"}]}"#, #"{"type":"doc","content":[{"type":"heading","attrs":{"level":4}}]}"#] {
            XCTAssertThrowsError(try JSONDecoder().decode(NoteDocument.self, from: Data(json.utf8)))
        }
        XCTAssertThrowsError(try NoteDocument(attributedString: NSAttributedString(attachment: NSTextAttachment())))
        XCTAssertThrowsError(try NoteDocument(attributedString: NSAttributedString(string: "x²", attributes: [.superscript: 1])))
    }

    @MainActor
    func testSharedFixtureRoundTripsAndCanExportForZodVerification() throws {
        let input = ProcessInfo.processInfo.environment["FIELDNOTES_ROUNDTRIP_INPUT"].map { URL(fileURLWithPath: $0) } ?? fixture
        let note = try NoteDocument.decode(Data(contentsOf: input))
        let first = try NoteDocument(attributedString: note.attributedString())
        let second = try NoteDocument(attributedString: first.attributedString())
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.content.map(normalized), note.content.map(normalized), "The first native projection must preserve every block, text node, mark, and component")
        XCTAssertEqual(first.components, note.components)
        XCTAssertEqual(first.codeBlocks.map(\.textContent), note.codeBlocks.map(\.textContent))
        if let output = ProcessInfo.processInfo.environment["FIELDNOTES_ROUNDTRIP_OUTPUT"] {
            let destination = URL(fileURLWithPath: output).standardizedFileURL
            guard destination.path.hasPrefix("/private/tmp/") || destination.path.hasPrefix("/tmp/") else { return XCTFail("Test export must use a temporary destination") }
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            try encoder.encode(first).write(to: destination, options: .withoutOverwriting)
        }
    }

    @MainActor
    func testEmptyBlocksAndLiteralTextSeparatorsKeepTheirStructure() throws {
        for node: EditorNode in [
            .init(type: .heading, attrs: .init(level: 2, textAlign: "right")),
            .init(type: .blockquote, content: [.init(type: .paragraph)]),
            .init(type: .paragraph, attrs: .init(textAlign: "left")),
            .init(type: .taskList, content: [.init(type: .taskItem, attrs: .init(checked: false), content: [.init(type: .paragraph)])]),
        ] {
            let note = NoteDocument(content: [node])
            XCTAssertEqual(try NoteDocument(attributedString: note.attributedString()).content.map(normalized), [normalized(node)])
        }
        let note = NoteDocument(content: [
            .init(type: .paragraph), paragraph("before\n\r\u{2028}\u{2029}after"), .init(type: .paragraph),
            .init(type: .paragraph, content: [.init(type: .hardBreak)]), .init(type: .paragraph),
        ])
        XCTAssertEqual(try NoteDocument(attributedString: note.attributedString()).content.map(normalized), note.content.map(normalized))
    }

    @MainActor
    func testEmptyHeadingPlaceholderDoesNotLeakThroughTypingNewlineOrUndo() throws {
        let note = NoteDocument(content: [.init(type: .heading, attrs: .init(level: 2))])
        let text = DocumentTextView(usingTextLayoutManager: true)
        text.isRichText = true
        text.allowsUndo = true
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 600, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = text
        text.textStorage!.setAttributedString(try note.attributedString())
        text.setSelectedRange(NSRange(location: 1, length: 0))
        text.typingAttributes = text.textStorage!.attributes(at: 0, effectiveRange: nil)
        let undo = try XCTUnwrap(text.undoManager)
        undo.groupsByEvent = false
        undo.beginUndoGrouping()
        text.insertText("Typed", replacementRange: text.selectedRange())
        undo.endUndoGrouping()
        let typed = try NoteDocument(attributedString: text.textStorage!)
        XCTAssertEqual(typed.content.count, 1)
        XCTAssertEqual(typed.content[0].type, .heading)
        XCTAssertEqual(typed.content[0].textContent, "Typed")
        undo.undo()
        XCTAssertEqual(try NoteDocument(attributedString: text.textStorage!).content, note.content)
        text.setSelectedRange(NSRange(location: 1, length: 0))
        undo.beginUndoGrouping()
        text.insertNewline(nil)
        undo.endUndoGrouping()
        let split = try NoteDocument(attributedString: text.textStorage!)
        XCTAssertEqual(split.content.map(\.type), [.heading, .paragraph])
        XCTAssertTrue(split.textNodes.isEmpty)
        undo.undo()
        XCTAssertEqual(try NoteDocument(attributedString: text.textStorage!).content, note.content)
    }

    @MainActor
    func testCombiningCharactersKeepDistinctMarksAndNullLinkDefaults() throws {
        let note = try NoteDocument.decode(Data(#"{"type":"doc","content":[{"type":"paragraph","attrs":{"textAlign":"left"},"content":[{"type":"text","text":"e","marks":[{"type":"bold"}]},{"type":"text","text":"\u0301","marks":[{"type":"italic"}]},{"type":"text","text":" link","marks":[{"type":"link","attrs":{"href":"https://example.com","target":null,"rel":null}},{"type":"textStyle","attrs":{"color":"RGB(1, 2, 3)"}}]}]}]}"#.utf8))
        XCTAssertEqual(try NoteDocument(attributedString: note.attributedString()).content.map(normalized), note.content.map(normalized))
    }

    private func normalized(_ node: EditorNode) -> EditorNode {
        var result = node
        if result.attrs == .init() { result.attrs = nil }
        result.marks = result.marks?.map { mark in
            var value = mark
            if value.attrs == .init() { value.attrs = nil }
            return value
        }.sorted { $0.type.rawValue < $1.type.rawValue }
        if result.marks?.isEmpty == true { result.marks = nil }
        var children: [EditorNode] = []
        for child in (result.content ?? []).map(normalized) {
            if let last = children.last, last.type == .text, child.type == .text, last.marks == child.marks { children[children.count - 1].text! += child.text! }
            else { children.append(child) }
        }
        result.content = children.isEmpty ? nil : children
        return result
    }

    private func paragraph(_ text: String) -> EditorNode { .init(type: .paragraph, content: [.init(type: .text, text: text)]) }
}
