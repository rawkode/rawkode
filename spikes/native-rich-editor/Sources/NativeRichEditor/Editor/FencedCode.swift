import Foundation

enum FencedCode {
    struct Block: Equatable {
        /// UTF-16 range from the opening line's indentation through the closing
        /// fence's trailing whitespace. The closing line ending is excluded.
        var range: NSRange
        var language: String
        var source: String
    }

    private struct Opening {
        var start: Int
        var fenceLength: Int
        var language: String
        var sourceStart: Int
        var sourceEnd: Int
    }

    static func parseCompleted(in text: String) -> [Block] {
        scan(text).blocks
    }

    static func isInsideOpenFence(in text: String, at location: Int) -> Bool {
        let value = text as NSString
        return scan(value.substring(to: min(max(0, location), value.length))).hasOpening
    }

    private static func scan(_ text: String) -> (blocks: [Block], hasOpening: Bool) {
        let text = text as NSString
        var blocks: [Block] = []
        var opening: Opening?
        var cursor = 0

        while cursor < text.length {
            var start = 0
            var end = 0
            var contentsEnd = 0
            text.getLineStart(&start, end: &end, contentsEnd: &contentsEnd,
                              for: NSRange(location: cursor, length: 0))
            let line = text.substring(with: NSRange(location: start, length: contentsEnd - start))

            if var current = opening {
                if let fence = fencePrefix(in: line), fence.length >= current.fenceLength,
                   fence.remainder.allSatisfy({ $0 == " " || $0 == "\t" }) {
                    blocks.append(Block(
                        range: NSRange(location: current.start, length: contentsEnd - current.start),
                        language: current.language,
                        source: text.substring(with: NSRange(location: current.sourceStart,
                                                             length: current.sourceEnd - current.sourceStart))
                    ))
                    opening = nil
                } else {
                    current.sourceEnd = contentsEnd
                    opening = current
                }
            } else if let fence = fencePrefix(in: line), !fence.remainder.contains("`") {
                let language = fence.remainder.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
                opening = Opening(start: start, fenceLength: fence.length, language: language.lowercased(),
                                  sourceStart: end, sourceEnd: end)
            }
            cursor = end
        }
        return (blocks, opening != nil)
    }

    /// CommonMark-style backtick fences: at least three backticks, preceded by
    /// at most three ASCII spaces. Once opened, shorter fences are source text.
    private static func fencePrefix(in line: String) -> (length: Int, remainder: Substring)? {
        var index = line.startIndex
        var indentation = 0
        while index < line.endIndex, line[index] == " " {
            indentation += 1
            guard indentation <= 3 else { return nil }
            line.formIndex(after: &index)
        }
        var length = 0
        while index < line.endIndex, line[index] == "`" {
            length += 1
            line.formIndex(after: &index)
        }
        guard length >= 3 else { return nil }
        return (length, line[index...])
    }
}
