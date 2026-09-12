import AppKit
import XCTest
@testable import NativeRichEditor

final class DocumentTests: XCTestCase {
    @MainActor
    func testRoundTripMixedDocumentKeepsRichTextCodeAndComponents() throws {
        ComponentAttachment.register()
        let content = NSMutableAttributedString(string: "Hello 👋\n", attributes: [.font: NSFont.boldSystemFont(ofSize: 23)])
        content.append(CodeBlockStyle.attributed("let π = 3.14\nprint(π)", language: "swift"))
        content.append(NSAttributedString(string: "\n"))
        let diagram = Component(kind: .diagram, title: "A → B", source: "a -> b", svg: "<svg/>")
        let mermaid = Component(kind: .mermaid, title: "Flow", source: "graph LR\nA --> B")
        let drawing = Component(kind: .drawing, title: "Sketch", drawing: .sample)
        let link = Component(kind: .link, title: "Film", source: "https://example.com/watch", metadata: LinkMetadata(title: "Film", playback: .embedURL(URL(string: "https://player.example.com/film")!)))
        for component in [diagram, mermaid, drawing, link] { content.append(NSAttributedString(attachment: ComponentAttachment(component))) }
        let document = try NoteDocument(attributedString: content)
        let decoded = try JSONDecoder().decode(NoteDocument.self, from: JSONEncoder().encode(document))
        let projected = try decoded.attributedString()
        XCTAssertEqual(projected.string, content.string)
        XCTAssertEqual((projected.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize, 23)
        XCTAssertEqual(projected.attribute(.codeLanguage, at: ("Hello 👋\n" as NSString).length, effectiveRange: nil) as? String, "swift")
        XCTAssertEqual(decoded.components, [diagram, mermaid, drawing, link])
    }

    @MainActor
    func testFenceConversionUndoAndSaveUseTextKit2() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let session = EditorSession(dataDirectory: directory)
        let text = DocumentTextView(usingTextLayoutManager: true)
        text.session = session
        text.delegate = session
        text.allowsUndo = true
        session.attach(text)
        let source = "before 👋\n```d2\na -> b\n```\nafter\n```swift\nlet x = 1\n```\n"
        session.replace(NSRange(location: 0, length: text.string.utf16.count), with: NSAttributedString(string: source, attributes: EditorSession.bodyAttributes), action: "Author fences")
        XCTAssertNotNil(text.textLayoutManager)
        XCTAssertFalse(text.string.contains("```"))
        let snapshot = try XCTUnwrap(session.document)
        XCTAssertTrue(snapshot.components.contains { $0.source == "a -> b" })
        XCTAssertTrue(snapshot.codeBlocks.contains { $0.attrs?.language == "swift" && $0.textContent == "let x = 1" })
        let saved = EditorSession(dataDirectory: directory)
        XCTAssertEqual(saved.document, snapshot)
    }
}
