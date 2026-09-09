import AppKit
import XCTest
@testable import NativeRichEditor

final class TiptapValidationTests: XCTestCase {
    func testUnknownFieldsAndWrongTreePositionsAreRejectedBeforeCodableDropsThem() throws {
        let invalidNodes = [
            #"{"type":"paragraph","future":true}"#,
            #"{"type":"paragraph","attrs":{"future":true}}"#,
            #"{"type":"paragraph","content":null}"#,
            #"{"type":"paragraph","marks":[{"type":"bold"}]}"#,
            #"{"type":"listItem","content":[{"type":"paragraph"}]}"#,
            #"{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph"}]}"#,
            #"{"type":"heading","attrs":{"level":2,"language":"swift"}}"#,
            #"{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"heading","attrs":{"level":1}}]}]}"#,
            #"{"type":"codeBlock","content":[{"type":"text","text":"x","marks":[{"type":"bold"}]}]}"#,
            #"{"type":"paragraph","content":[{"type":"text","text":"x","attrs":{}}]}"#,
            #"{"type":"paragraph","content":[{"type":"hardBreak","content":[]}]}"#,
        ]
        for node in invalidNodes { XCTAssertThrowsError(try decode(node), node) }
        XCTAssertThrowsError(try NoteDocument.decode(Data(#"{"type":"doc","content":[{"type":"paragraph"}],"version":2}"#.utf8)))
    }

    func testMarksAndURLsUseTheSharedStrictContract() throws {
        let invalidMarks = [
            #"{"type":"bold","attrs":{"future":true}}"#,
            #"{"type":"bold","attrs":null}"#,
            #"{"type":"textStyle","attrs":{"fontSize":"900px"}}"#,
            #"{"type":"textStyle","attrs":{"color":"rgb(300, 0, 0)"}}"#,
            #"{"type":"textStyle","attrs":{"fontFamily":"url(evil)"}}"#,
            #"{"type":"link","attrs":{"href":"javascript:alert(1)"}}"#,
            #"{"type":"link","attrs":{"href":"https://name:secret@example.com"}}"#,
            #"{"type":"link","attrs":{"href":"https://example.com","target":"frame"}}"#,
            #"{"type":"link","attrs":{"href":"https://example.com","rel":"opener"}}"#,
            #"{"type":"link","attrs":{"href":"https://example.com","future":true}}"#,
            #"{"type":"bold"},{"type":"bold"}"#,
        ]
        for mark in invalidMarks { XCTAssertThrowsError(try decode(#"{"type":"paragraph","content":[{"type":"text","text":"x","marks":["# + mark + "]}]}"), mark) }
        for rel in ["", "noopener ", "noopener noreferrer"] {
            XCTAssertNoThrow(try decode(#"{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"link","attrs":{"href":"mailto:notes@example.com","rel":""# + rel + #""}}]}]}"#))
        }
    }

    @MainActor
    func testComponentsAndDrawingPayloadsAreStrictAndIDsMustBeUnique() throws {
        let component = Component(kind: .link, title: "Video", source: "https://example.com", metadata: .init(title: "Video", playback: .embedURL(URL(string: "https://example.com/embed")!)))
        let node = EditorNode(type: .paragraph, content: [.init(type: .component, attrs: .init(component: component))])
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        let encoded = try encoder.encode(NoteDocument(content: [node]))
        let text = String(decoding: encoded, as: UTF8.self)
        XCTAssertThrowsError(try NoteDocument.decode(Data(text.replacingOccurrences(of: "\"embedURL\"", with: "\"embedURL\",\"future\":true").utf8)))
        XCTAssertThrowsError(try NoteDocument.decode(Data(text.replacingOccurrences(of: "https://example.com/embed", with: "file:///private/secret").utf8)))
        XCTAssertThrowsError(try NoteDocument(content: [node, node]).attributedString())
        let duplicate = NSMutableAttributedString(attachment: ComponentAttachment(component))
        duplicate.append(NSAttributedString(attachment: ComponentAttachment(component)))
        XCTAssertThrowsError(try NoteDocument(attributedString: duplicate))

        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/tiptap.native-note")
        var raw = try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as! [String: Any]
        raw["unknown"] = true
        XCTAssertThrowsError(try NoteDocument.decode(JSONSerialization.data(withJSONObject: raw)))
        let payload = #"{"type":"paragraph","content":[{"type":"component","attrs":{"component":{"id":"10000000-0000-4000-8000-000000000001","kind":"drawing","title":"Canvas","source":"","drawing":{"elements":[{"id":"20000000-0000-4000-8000-000000000001","kind":"pen","ink":"blue","text":"","lineWidth":2,"points":[{"x":100001,"y":0}]}]}}}}]}"#
        XCTAssertThrowsError(try decode(payload))
    }

    func testDocumentBudgetsRejectExcessiveDepthNodesTextAndBytes() throws {
        var nested = #"{"type":"paragraph"}"#
        for _ in 0..<32 { nested = #"{"type":"blockquote","content":["# + nested + "]}" }
        XCTAssertThrowsError(try decode(nested))
        XCTAssertThrowsError(try decode(Array(repeating: #"{"type":"paragraph"}"#, count: 20_000).joined(separator: ",")))
        let long = String(repeating: "x", count: 4 * 1024 * 1024 + 1)
        XCTAssertThrowsError(try decode(#"{"type":"paragraph","content":[{"type":"text","text":""# + long + #""}]}"#))
        XCTAssertThrowsError(try NoteDocument.decode(Data(repeating: 32, count: TiptapValidation.byteLimit + 1)))
    }

    private func decode(_ nodes: String) throws -> NoteDocument { try NoteDocument.decode(Data((#"{"type":"doc","content":["# + nodes + "]}").utf8)) }
}
