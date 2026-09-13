import XCTest
@testable import ApsidesCore

enum NoteFixture {
    static func data() throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "tiptap", withExtension: "native-note", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }
    static func document() throws -> NoteDocument { try NoteDocument.decode(try data()) }
    static func canonical(_ data: Data) throws -> Data {
        try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: data), options: [.sortedKeys])
    }
    static let canonicalEntityNote = """
    {"type":"doc","content":[{"type":"paragraph","attrs":{"textAlign":null},"content":[
      {"type":"text","text":"Ping "},
      {"type":"entity","attrs":{"entity":{"version":1,"entityId":"30000000-0000-4000-8000-000000000001","fallbackLabel":"Ada","displayText":"Ada Lovelace","presentation":"mention"}}},
      {"type":"text","text":" about "},
      {"type":"entity","attrs":{"entity":{"version":1,"entityId":"30000000-0000-4000-8000-000000000002","fallbackLabel":"Engine","displayText":"the engine","presentation":"link"}}},
      {"type":"entity","attrs":{"entity":{"provider":"github","kind":"issue","id":"octo/repo#7","label":"Issue 7","avatarURL":"https://example.com/a.png","meta":"open"}}}
    ]}]}
    """
}

final class NoteDocumentTests: XCTestCase {
    func testSharedFixtureRoundTripsWithoutChangingTheTree() throws {
        let data = try NoteFixture.data()
        let document = try NoteDocument.decode(data)
        XCTAssertEqual(document.components.count, 5)
        XCTAssertEqual(document.components.map(\.kind), [.diagram, .mermaid, .drawing, .link, .link])
        XCTAssertEqual(try NoteFixture.canonical(document.encoded()), try NoteFixture.canonical(data))
        XCTAssertEqual(try NoteDocument.decode(document.encoded()), document)
    }

    func testExplicitNullsAndLinkDefaultsSurviveReencoding() throws {
        let document = try NoteFixture.document()
        let paragraph = try XCTUnwrap(document.node(at: NotePath(2)))
        XCTAssertEqual(paragraph.attrs?.nullFields, ["textAlign"])
        let explicit = try XCTUnwrap(document.node(at: NotePath(8, 0)))
        XCTAssertEqual(explicit.mark(.link)?.attrs?.nullFields, ["target", "rel", "class", "title"])
        let json = try document.jsonObject()
        let blocks = try XCTUnwrap(json["content"] as? [[String: Any]])
        XCTAssertTrue((blocks[2]["attrs"] as? [String: Any])?["textAlign"] is NSNull)
    }

    func testCanonicalAndProviderEntitiesDecodeAndReencode() throws {
        let data = Data(NoteFixture.canonicalEntityNote.utf8)
        let document = try NoteDocument.decode(data)
        XCTAssertEqual(document.entities.count, 3)
        XCTAssertEqual(document.entities.map(\.displayText), ["@Ada Lovelace", "the engine", "@Issue 7"])
        XCTAssertEqual(document.entities.first?.canonicalID, "30000000-0000-4000-8000-000000000001")
        XCTAssertEqual(try NoteFixture.canonical(document.encoded()), try NoteFixture.canonical(data))
        XCTAssertEqual(document.plainText, "Ping @Ada Lovelace about the engine@Issue 7")
    }

    func testRejectsContentOutsideTheSharedContract() throws {
        func rejects(_ json: String, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
            XCTAssertThrowsError(try NoteDocument.decode(Data(json.utf8)), message, file: file, line: line)
        }
        rejects(#"{"type":"doc","content":[{"type":"table"}]}"#, "unknown node")
        rejects(#"{"type":"doc","content":[]}"#, "empty document")
        rejects(#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a","marks":[{"type":"highlight"}]}]}]}"#, "unknown mark")
        rejects(#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a","marks":[{"type":"bold"},{"type":"bold"}]}]}]}"#, "duplicate mark")
        rejects(#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]}]}]}"#, "unsafe link")
        rejects(#"{"type":"doc","content":[{"type":"heading","attrs":{"level":4},"content":[{"type":"text","text":"a"}]}]}"#, "heading level")
        rejects(#"{"type":"doc","content":[{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"heading","attrs":{"level":1}}]}]}]}"#, "item must start with a paragraph")
        rejects(#"{"type":"doc","content":[{"type":"codeBlock","content":[{"type":"text","text":"a","marks":[{"type":"bold"}]}]}]}"#, "marks in code")
        rejects(#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"entity","attrs":{"entity":{"version":1,"entityId":"nope","fallbackLabel":"a","displayText":"a","presentation":"mention"}}}]}]}"#, "canonical entity id")
        rejects(#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"entity","attrs":{"entity":{"version":2,"entityId":"30000000-0000-4000-8000-000000000001","fallbackLabel":"a","displayText":"a","presentation":"mention"}}}]}]}"#, "entity version")
        rejects(#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"entity","attrs":{"entity":{"provider":"slack","kind":"person","id":"1","label":"a"}}}]}]}"#, "provider")
        let component = #"{"id":"10000000-0000-4000-8000-000000000001","kind":"diagram","title":"D","source":"a"}"#
        rejects(#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"component","attrs":{"component":\#(component)}},{"type":"component","attrs":{"component":\#(component)}}]}]}"#, "duplicate component")
        rejects(#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"component","attrs":{"component":{"id":"10000000-0000-4000-8000-000000000001","kind":"link","title":"L","source":"ftp://x"}}}]}]}"#, "link source")
        rejects(#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a","marks":[{"type":"textStyle","attrs":{"fontSize":"12pt"}}]}]}]}"#, "font size")
        rejects(#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a","marks":[{"type":"textStyle","attrs":{"color":"url(x)"}}]}]}]}"#, "color")
    }

    func testNewDocumentsUseTiptapDefaultsAndValidate() throws {
        var document = NoteDocument()
        document.content = [
            .heading(1, [.text("Title")]),
            .paragraph([.text("Bold", marks: [.bold]), .text(" plain "), .text("link", marks: [.link("https://example.com")]), .hardBreak(), .text("next")]),
            .bulletList([.listItem([.paragraph([.text("a")]), .orderedList([.listItem([.paragraph([.text("b")])])], start: 4)])]),
            .taskList([.taskItem(checked: true, [.paragraph([.text("done")])])]),
            .blockquote([.paragraph([.text("q")])]),
            .codeBlock(language: "swift", "let x = 1\n"),
            .paragraph([.component(.default(.drawing)), .entity(.canonical(id: NoteIdentifier.new(), label: "Ada", trigger: "@"))]),
        ]
        let data = try document.encoded()
        XCTAssertEqual(try NoteDocument.decode(data), document)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let blocks = try XCTUnwrap(json["content"] as? [[String: Any]])
        XCTAssertTrue((blocks[1]["attrs"] as? [String: Any])?["textAlign"] is NSNull)
        let inline = try XCTUnwrap(blocks[1]["content"] as? [[String: Any]])
        let link = try XCTUnwrap((inline[2]["marks"] as? [[String: Any]])?.first?["attrs"] as? [String: Any])
        XCTAssertEqual(link["target"] as? String, "_blank")
        XCTAssertTrue(link["title"] is NSNull)
    }
}
