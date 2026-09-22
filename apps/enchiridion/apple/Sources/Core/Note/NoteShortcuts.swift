import Foundation

/// Markdown-style input rules matching the web editor's StarterKit rules and
/// slash/mention triggers. All offsets count characters of the text before the caret.
public enum NoteShortcuts {
    public enum BlockShortcut: Equatable, Sendable {
        case heading(Int), quote, bullet, ordered(start: Int), task(checked: Bool), code(language: String?)
    }

    public struct InlineShortcut: Equatable, Sendable {
        /// The characters to replace, from the opening delimiter through the closing one.
        public var range: Range<Int>
        public var text: String
        public var mark: NoteMark.Kind
    }

    public struct Trigger: Equatable, Sendable {
        public var character: Character
        /// Characters from the trigger to the caret.
        public var range: Range<Int>
        public var query: String
    }

    /// The paragraph prefix typed before a space, e.g. `## `, `- `, `1. `, `[ ] `, `> `, ```` ```swift ````.
    public static func blockShortcut(prefix: String) -> BlockShortcut? {
        let trimmed = prefix.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, prefix.hasSuffix(" ") else { return nil }
        if let match = trimmed.wholeMatch(of: /#{1,3}/) { return .heading(match.output.count) }
        if trimmed == ">" { return .quote }
        if trimmed == "-" || trimmed == "*" || trimmed == "+" { return .bullet }
        if let match = trimmed.wholeMatch(of: /(\d{1,7})\./), let start = Int(match.output.1), start >= 1 { return .ordered(start: start) }
        if let match = trimmed.wholeMatch(of: /\[( |x|X)?\]/) { return .task(checked: match.output.1.map { $0.lowercased() == "x" } ?? false) }
        if let match = trimmed.wholeMatch(of: /```([A-Za-z0-9_+#.-]*)/) {
            let language = String(match.output.1)
            return .code(language: language.isEmpty ? nil : language.lowercased())
        }
        return nil
    }

    /// A whole paragraph that is only an opening fence turns into a code block on Return.
    public static func fenceLanguage(paragraphText: String) -> String?? {
        guard let match = paragraphText.trimmingCharacters(in: .whitespaces).wholeMatch(of: /```([A-Za-z0-9_+#.-]*)/) else { return nil }
        let language = String(match.output.1)
        return .some(language.isEmpty ? nil : language.lowercased())
    }

    /// `**bold**`, `__bold__`, `*italic*`, `_italic_`, `~~strike~~`, `` `code` `` once the closing delimiter is typed.
    public static func inlineShortcut(before: String) -> InlineShortcut? {
        // Group 1 spans the delimiters; group 2 is the formatted text. Swift Regex has no lookbehind,
        // so the required boundary is consumed by the non-capturing prefix.
        let patterns: [(Regex<(Substring, Substring, Substring)>, NoteMark.Kind)] = [
            (/(\*\*([^*\n]+)\*\*)$/, .bold),
            (/(__([^_\n]+)__)$/, .bold),
            (/(~~([^~\n]+)~~)$/, .strike),
            (/(?:^|\s)(\*([^*\n]+)\*)$/, .italic),
            (/(?:^|\s)(_([^_\n]+)_)$/, .italic),
            (/(?:^|[^`])(`([^`\n]+)`)$/, .code),
        ]
        for (pattern, mark) in patterns {
            guard let match = before.firstMatch(of: pattern) else { continue }
            let start = before.distance(from: before.startIndex, to: match.output.1.startIndex)
            let end = before.distance(from: before.startIndex, to: match.output.1.endIndex)
            let text = String(match.output.2)
            guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            return InlineShortcut(range: start..<end, text: text, mark: mark)
        }
        return nil
    }

    /// `/` at the start of a paragraph with an optional short query, as `updateSlash` requires.
    public static func slashTrigger(before: String) -> Trigger? {
        guard before.wholeMatch(of: /\/[\w ]{0,30}/) != nil else { return nil }
        return Trigger(character: "/", range: 0..<before.count, query: String(before.dropFirst()))
    }

    /// `@name` or `#name` after a word boundary, as the shared entity composer matches.
    public static func entityTrigger(before: String) -> Trigger? {
        guard let match = before.firstMatch(of: /(?:^|[\s(\[{])([#@])([\p{L}\p{N}._ -]{0,64})$/) else { return nil }
        let start = before.distance(from: before.startIndex, to: match.output.1.startIndex)
        return Trigger(character: match.output.1.first!, range: start..<before.count, query: String(match.output.2))
    }

    /// Text before the caret to split before applying a `\n` typed into a text segment.
    public static func newlineSplit(_ text: String) -> (before: String, after: String)? {
        guard let index = text.firstIndex(of: "\n") else { return nil }
        return (String(text[..<index]), String(text[text.index(after: index)...]))
    }
}
