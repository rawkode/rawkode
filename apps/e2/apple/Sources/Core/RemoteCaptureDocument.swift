import Foundation

/// The exact native capture envelope. Rich documents outside this contract are never flattened.
public enum RemoteCaptureDocument {
    public enum FormatError: LocalizedError {
        case invalid
        public var errorDescription: String? { "This document is not a supported native capture." }
    }

    public static func note(text: String, date: Date) throws -> [String: Any] {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf8.count <= 64 * 1024 else { throw FormatError.invalid }
        let lines = text.components(separatedBy: "\n")
        guard lines.count < 9_000 else { throw FormatError.invalid }
        let heading: [String: Any] = [
            "type": "heading", "attrs": ["level": 1],
            "content": [["type": "text", "text": "Capture · \(ISO8601DateFormatter().string(from: date))"]],
        ]
        let paragraphs: [[String: Any]] = lines.map { line in
            ["type": "paragraph", "content": line.isEmpty ? [] : [["type": "text", "text": line]]]
        }
        return ["type": "doc", "content": [heading] + paragraphs]
    }

    public static func decode(_ data: Data, expectedID: String) throws -> Capture {
        guard expectedID.hasPrefix("capture:"),
              let id = UUID(uuidString: String(expectedID.dropFirst(8))),
              let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let document = envelope["document"] as? [String: Any], document["id"] as? String == expectedID,
              let revision = document["revision"] as? Int, revision > 0,
              let note = document["note"] as? [String: Any],
              let blocks = note["content"] as? [[String: Any]], blocks.count >= 2,
              let heading = blocks.first?["content"] as? [[String: Any]], heading.count == 1,
              let title = heading.first?["text"] as? String, title.hasPrefix("Capture · "),
              let date = ISO8601DateFormatter().date(from: String(title.dropFirst("Capture · ".count))) else {
            throw FormatError.invalid
        }
        var lines: [String] = []
        for block in blocks.dropFirst() {
            guard let nodes = block["content"] as? [[String: Any]], nodes.count <= 1 else { throw FormatError.invalid }
            if nodes.isEmpty { lines.append("") }
            else {
                guard let text = nodes[0]["text"] as? String else { throw FormatError.invalid }
                lines.append(text)
            }
        }
        let text = lines.joined(separator: "\n")
        let canonical = try Self.note(text: text, date: date)
        guard NSDictionary(dictionary: note).isEqual(to: canonical) else { throw FormatError.invalid }
        return Capture(id: id, text: text, createdAt: date, source: .workspace)
    }
}
