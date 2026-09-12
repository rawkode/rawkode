import XCTest
@testable import ApsidesCore

final class RemoteCaptureTests: XCTestCase {
    private let id = "capture:00000000-0000-4000-8000-000000000001"
    private let date = Date(timeIntervalSince1970: 1_800_000_000)
    private func envelope(_ note: [String: Any], id: String? = nil) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["document": ["id": id ?? self.id, "revision": 1, "note": note]])
    }
    func testActualUploadPayloadImportsWithoutLosingBlankLinesOrUnicode() throws {
        let text = "A thought 📝\n\n第二行\n"
        let note = try RemoteCaptureDocument.note(text: text, date: date)
        let decoded = try RemoteCaptureDocument.decode(envelope(note), expectedID: id)
        XCTAssertEqual(decoded.text, text)
        XCTAssertEqual(decoded.createdAt, date)
        XCTAssertEqual(decoded.source, .workspace)
    }
    func testRejectsRichContentAndWrongDocumentIdentity() throws {
        var note = try RemoteCaptureDocument.note(text: "Keep formatting", date: date)
        XCTAssertThrowsError(try RemoteCaptureDocument.decode(envelope(note, id: "capture:other"), expectedID: id))
        var blocks = note["content"] as! [[String: Any]]
        blocks[1] = ["type": "paragraph", "content": [["type": "text", "text": "Keep formatting", "marks": [["type": "bold"]]]]]
        note["content"] = blocks
        XCTAssertThrowsError(try RemoteCaptureDocument.decode(envelope(note), expectedID: id))
        XCTAssertThrowsError(try RemoteCaptureDocument.decode(envelope(["type": "doc", "content": [["type": "paragraph", "content": [["type": "text", "text": "Ordinary document"]]]]]), expectedID: id))
    }
}
