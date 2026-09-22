import Foundation

/// A small excerpt from the authenticated shared daily-note editor, never a local draft.
/// Empty text is a verified empty note and replaces any previously cached excerpt.
public struct DailyNotePreview: Codable, Equatable, Sendable {
    public let accountID: String
    public let day: String
    public let text: String

    public init?(accountID: String, day: String, editorText: String) {
        guard !accountID.isEmpty, !day.isEmpty else { return nil }
        let lines = editorText.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let body = lines.first == "Today" ? Array(lines.dropFirst()) : lines
        let normalized = body.joined(separator: " ").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        self.accountID = accountID
        self.day = day
        text = String(normalized.prefix(160))
    }

    public func matches(accountID: String?, day: String) -> Bool {
        self.accountID == accountID && self.day == day
    }
}
