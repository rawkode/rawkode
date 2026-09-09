import AppKit
import XCTest
@testable import NativeRichEditor

final class PortableDocumentTests: XCTestCase {
    private var fixtures: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures") }

    @MainActor
    func testNativePortableRoundTripPreservesTextMarksListsAndAdjacentComponents() throws {
        let content = try sample()
        let note = try NoteDocument(attributedString: content)
        let encoder = JSONEncoder()
        let data = try encoder.encode(note)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(root["version"] as? Int, 2)
        let reopened = try JSONDecoder().decode(NoteDocument.self, from: data).attributedString()
        XCTAssertEqual(reopened.string, content.string)
        let boldIndex = (reopened.string as NSString).range(of: "bold").location
        XCTAssertTrue(NSFontManager.shared.traits(of: reopened.attribute(.font, at: boldIndex, effectiveRange: nil) as! NSFont).contains(.boldFontMask))
        let nestedIndex = (reopened.string as NSString).range(of: "Checked").location
        XCTAssertEqual((reopened.attribute(.paragraphStyle, at: nestedIndex, effectiveRange: nil) as? NSParagraphStyle)?.textLists.count, 3)
        XCTAssertTrue(reopened.string.contains("\t☑\tChecked"))
        let normalized = try NoteDocument(attributedString: reopened)
        let twice = try NoteDocument(attributedString: normalized.attributedString())
        XCTAssertEqual(normalized, twice, "Repeated projection must stabilize without adding separators or IDs")
    }

    @MainActor
    func testRejectsUnsupportedAttachmentsFormattingAndVersions() throws {
        XCTAssertThrowsError(try JSONDecoder().decode(NoteDocument.self, from: Data(#"{"version":1,"segments":[]}"#.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(NoteDocument.self, from: Data(#"{"version":3,"segments":[]}"#.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(NoteDocument.self, from: Data(#"{"version":2,"segments":[{"type":"future"}]}"#.utf8)))
        XCTAssertThrowsError(try NoteDocument(attributedString: NSAttributedString(attachment: NSTextAttachment())))
        XCTAssertThrowsError(try NoteDocument(attributedString: NSAttributedString(string: "x²", attributes: [.superscript: 1])))
        XCTAssertThrowsError(try NoteDocument(attributedString: NSAttributedString(string: "double", attributes: [.underlineStyle: NSUnderlineStyle.double.rawValue])))
        let unsupportedList = NSMutableParagraphStyle()
        unsupportedList.textLists = [NSTextList(markerFormat: .circle, options: 0)]
        XCTAssertThrowsError(try NoteDocument(attributedString: NSAttributedString(string: "\t◦\tCircle", attributes: [.paragraphStyle: unsupportedList])))
    }

    @MainActor
    func testExactTabsSeparatorsAndEmptyCode() throws {
        let content = NSMutableAttributedString(string: "literal\t•\ttext\r\n\r\nnext\rfinal\u{2029}", attributes: EditorSession.bodyAttributes)
        content.append(CodeBlockStyle.attributed("", language: "txt"))
        content.append(CodeBlockStyle.attributed("a\r\nb", language: "python"))
        let note = try NoteDocument(attributedString: content)
        XCTAssertEqual(try note.attributedString().string, content.string)
        XCTAssertTrue(note.segments.contains(.code(language: "txt", source: "")))
        XCTAssertTrue(note.segments.contains(.code(language: "python", source: "a\r\nb")))
        let multilineList = NoteDocument(segments: [.text(.init(text: "First\r\nSecond\n", paragraph: .init(list: .init(path: [.numbered]))))])
        XCTAssertEqual(try multilineList.attributedString().string, "\t1.\tFirst\r\n\t1.\tSecond\n")
        let adjacentCode = NoteDocument(segments: [.code(language: "swift", source: "one"), .code(language: "swift", source: ""), .code(language: "swift", source: "two")])
        XCTAssertEqual(try NoteDocument(attributedString: adjacentCode.attributedString()), adjacentCode)
    }

    @MainActor
    func testSharedFixturesReopenAndStabilize() throws {
        let portable = try JSONDecoder().decode(NoteDocument.self, from: Data(contentsOf: fixtures.appendingPathComponent("portable-v2.native-note")))
        let first = try NoteDocument(attributedString: portable.attributedString())
        let second = try NoteDocument(attributedString: first.attributedString())
        XCTAssertEqual(first, second)
    }

    @MainActor
    private func sample() throws -> NSAttributedString {
        let result = NSMutableAttributedString(string: "Portable notes 👩🏽‍💻\n", attributes: [.font: NSFont.boldSystemFont(ofSize: 32), .portableBlockKind: "heading1", .portableBold: false])
        result.append(NSAttributedString(string: "Plain\ttext\r\n\r\n", attributes: EditorSession.bodyAttributes))
        let quote = NSMutableParagraphStyle()
        quote.headIndent = 24; quote.firstLineHeadIndent = 24
        result.append(NSAttributedString(string: "A quoted thought.\n", attributes: [.font: NSFont.systemFont(ofSize: 17), .paragraphStyle: quote, .portableBlockKind: "quote", .foregroundColor: NSColor.secondaryLabelColor]))
        func list(_ text: String, path: [NSTextList], bold: Bool = false) {
            let style = NSMutableParagraphStyle()
            style.textLists = path
            var attributes = EditorSession.bodyAttributes
            attributes[.paragraphStyle] = style
            if bold { attributes[.font] = NSFont.boldSystemFont(ofSize: 17) }
            result.append(NSAttributedString(string: text, attributes: attributes))
        }
        let bullet = NSTextList(markerFormat: .disc, options: 0)
        let numbered = NSTextList(markerFormat: .init(rawValue: "{decimal}."), options: 0)
        let task = NSTextList(markerFormat: .box, options: 0)
        list("\t•\tbold", path: [bullet], bold: true)
        list(" and normal\n", path: [bullet])
        list("\t3.\tNested numbered\n", path: [bullet, numbered])
        list("\t☑\tChecked\n", path: [bullet, numbered, task])
        list("\t☐\tPending\n", path: [task])
        result.append(NSAttributedString(string: "styled link", attributes: [.font: NSFontManager.shared.convert(NSFont.systemFont(ofSize: 19), toHaveTrait: .italicFontMask), .underlineStyle: 1, .strikethroughStyle: 1, .link: "https://example.com", .foregroundColor: NSColor(srgbRed: 0.1, green: 0.3, blue: 0.7, alpha: 0.8)]))
        result.append(NSAttributedString(string: "\ncode span\n", attributes: [.font: NSFont.monospacedSystemFont(ofSize: 16, weight: .regular), .portableInlineCode: true, .backgroundColor: NSColor.quaternaryLabelColor]))
        result.append(CodeBlockStyle.attributed("let π = 3.14\r\nprint(π)", language: "swift"))
        result.append(CodeBlockStyle.attributed("", language: "text"))
        var drawing = DrawingDocument.sample
        for index in drawing.elements.indices { drawing.elements[index].id = UUID(uuidString: String(format: "55555555-5555-4555-8555-%012d", index))! }
        let components = [
            Component(id: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!, kind: .diagram, title: "D2", source: "a -> b", svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
            Component(id: UUID(uuidString: "22222222-2222-4222-8222-222222222222")!, kind: .mermaid, title: "Mermaid", source: "flowchart LR\nA --> B"),
            Component(id: UUID(uuidString: "33333333-3333-4333-8333-333333333333")!, kind: .drawing, title: "Drawing", drawing: drawing),
            Component(id: UUID(uuidString: "44444444-4444-4444-8444-444444444444")!, kind: .link, title: "Video", source: "https://example.com/watch", metadata: .init(title: "Video", playback: .directVideo(URL(string: "https://example.com/film.mp4")!))),
            Component(id: UUID(uuidString: "66666666-6666-4666-8666-666666666666")!, kind: .link, title: "Embedded video", source: "https://example.com/embedded", metadata: .init(title: "Embedded video", playback: .embedURL(URL(string: "https://player.example.com/watch")!))),
        ]
        for component in components { result.append(NSAttributedString(attachment: ComponentAttachment(component))) }
        result.append(NSAttributedString(string: "\n\nEnd.\n", attributes: EditorSession.bodyAttributes))
        return result
    }

}
