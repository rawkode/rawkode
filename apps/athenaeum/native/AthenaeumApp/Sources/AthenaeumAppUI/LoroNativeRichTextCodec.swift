#if os(macOS)
import AppKit
import AthenaeumCore

/// The only AppKit representation admitted by the native rich editor.
///
/// TextKit's editing ranges are UTF-16 while the semantic document's text is Swift `String`.
/// This codec consequently owns every range conversion and refuses a range that bisects a
/// surrogate pair.  It deliberately does not expose any CRDT, route, request, or transport
/// material: callers exchange semantic values before and after TextKit editing only.
enum LoroNativeRichTextCodec {
    /// Private attributes are an allow-list, not a presentation protocol.  In particular, bold
    /// system fonts are not semantic `strong` marks: external attributed paste with a font, link,
    /// colour, attachment, paragraph style, or unrecognised custom key is rejected atomically.
    ///
    /// A block is represented by its text followed by one `\n` separator.  Empty input means one
    /// empty paragraph.  A trailing separator creates a trailing empty paragraph; consecutive
    /// separators create empty paragraph blocks between their neighbours.  Separators optionally
    /// carry the block kinds on their two sides, which preserves empty headings.  Plain text with
    /// no markers is accepted as paragraph blocks, so ordinary paste has deterministic semantics.
    private enum Attribute {
        static let marks = NSAttributedString.Key("dev.athenaeum.rich.marks.v1")
        static let block = NSAttributedString.Key("dev.athenaeum.rich.block.v1")
        static let separatorBefore = NSAttributedString.Key("dev.athenaeum.rich.separator-before.v1")
        static let separatorAfter = NSAttributedString.Key("dev.athenaeum.rich.separator-after.v1")
        static let terminalEmptyDocument = NSAttributedString.Key("dev.athenaeum.rich.terminal-empty-document.v1")
        static let allowed: Set<NSAttributedString.Key> = [marks, block, separatorBefore, separatorAfter, terminalEmptyDocument]
    }

    enum Error: Swift.Error, Equatable, Sendable {
        case unsupportedAttribute(String)
        case malformedMarker(String)
        case invalidUTF16Range(location: Int, length: Int)
        case invalidSemanticDocument
    }

    struct ScalarSelection: Equatable, Sendable {
        let location: Int
        let length: Int

        init(location: Int, length: Int) {
            self.location = location
            self.length = length
        }
    }

    /// Render only controlled semantic markers.  Visual styling and editor commands belong to the
    /// R3-B `NSTextView` wrapper; keeping it out of this codec prevents arbitrary AppKit font
    /// traits from being mistaken for durable editor semantics.
    static func attributedString(for document: LoroNativeRichDocumentV1) throws -> NSAttributedString {
        let semantic = try canonical(document.semantic)
        if semantic.blocks.count == 1, runs(in: semantic.blocks[0]).isEmpty, marker(for: semantic.blocks[0]) != "paragraph" {
            // A zero-length attributed string cannot carry a marker.  The single separator is an
            // explicit terminal encoding for this otherwise unrepresentable empty heading; it is
            // distinct from user-typed unmarked `\n`, which decodes to two empty paragraphs.
            return NSAttributedString(string: "\n", attributes: [
                Attribute.terminalEmptyDocument: marker(for: semantic.blocks[0])
            ])
        }
        let result = NSMutableAttributedString()

        for index in semantic.blocks.indices {
            let block = semantic.blocks[index]
            let runs = runs(in: block)
            let blockMarker = marker(for: block)
            for run in runs {
                var attributes: [NSAttributedString.Key: Any] = [Attribute.block: blockMarker]
                if !run.marks.isEmpty {
                    attributes[Attribute.marks] = marksMarker(run.marks)
                }
                result.append(NSAttributedString(string: run.text, attributes: attributes))
            }

            if index < semantic.blocks.index(before: semantic.blocks.endIndex) {
                let following = semantic.blocks[semantic.blocks.index(after: index)]
                result.append(NSAttributedString(
                    string: "\n",
                    attributes: [
                        Attribute.separatorBefore: blockMarker,
                        Attribute.separatorAfter: marker(for: following)
                    ]
                ))
            }
        }
        return result
    }

    /// Validate and decode without mutating an `NSTextView`, so R3-B can preflight paste and defer
    /// conversion while `hasMarkedText` is true.  A caller must retain the prior semantic draft on
    /// failure; this function never performs a lossy downgrade.
    static func decode(_ attributed: NSAttributedString) throws -> LoroNativeRichDocumentV1 {
        try validateAttributes(in: attributed)
        let text = attributed.string
        guard !text.unicodeScalars.contains("\r") else { throw Error.malformedMarker("carriage return") }
        if text == "\n", let marker = attributed.attribute(Attribute.terminalEmptyDocument, at: 0, effectiveRange: nil) as? String {
            guard isBlockMarker(marker), marker != "paragraph" else { throw Error.malformedMarker("terminal empty document") }
            return LoroNativeRichDocumentV1(semantic: try canonical(.init(blocks: [makeBlock(kind: marker, runs: [])])))
        }

        let pieces = text.split(separator: "\n", omittingEmptySubsequences: false)
        var blocks: [LoroCanonicalSemanticValueV1.Block] = []
        var utf16Offset = 0

        for pieceIndex in pieces.indices {
            let piece = String(pieces[pieceIndex])
            let pieceLength = piece.utf16.count
            let contentRange = NSRange(location: utf16Offset, length: pieceLength)
            let nextSeparatorRange = pieceIndex < pieces.index(before: pieces.endIndex)
                ? NSRange(location: utf16Offset + pieceLength, length: 1)
                : nil
            let previousSeparatorRange = pieceIndex > pieces.startIndex
                ? NSRange(location: utf16Offset - 1, length: 1)
                : nil

            let kind = try blockMarker(
                in: attributed,
                contentRange: contentRange,
                previousSeparatorRange: previousSeparatorRange,
                nextSeparatorRange: nextSeparatorRange
            )
            let runs = try decodeRuns(in: attributed, range: contentRange)
            blocks.append(makeBlock(kind: kind, runs: runs))
            utf16Offset += pieceLength + (nextSeparatorRange == nil ? 0 : 1)
        }

        return LoroNativeRichDocumentV1(semantic: try canonical(.init(blocks: blocks)))
    }

    static func scalarSelection(forUTF16Range range: NSRange, in attributed: NSAttributedString) throws -> ScalarSelection {
        try scalarSelection(forUTF16Range: range, in: attributed.string)
    }

    static func scalarSelection(forUTF16Range range: NSRange, in text: String) throws -> ScalarSelection {
        guard range.location >= 0, range.length >= 0,
              range.location <= text.utf16.count,
              range.length <= text.utf16.count - range.location
        else { throw Error.invalidUTF16Range(location: range.location, length: range.length) }
        let start = try scalarOffset(atUTF16Offset: range.location, in: text, original: range)
        let end = try scalarOffset(atUTF16Offset: range.location + range.length, in: text, original: range)
        return ScalarSelection(location: start, length: end - start)
    }

    static func utf16Range(forScalarSelection selection: ScalarSelection, in attributed: NSAttributedString) throws -> NSRange {
        try utf16Range(forScalarSelection: selection, in: attributed.string)
    }

    static func utf16Range(forScalarSelection selection: ScalarSelection, in text: String) throws -> NSRange {
        let scalars = text.unicodeScalars
        guard selection.location >= 0, selection.length >= 0,
              selection.location <= scalars.count,
              selection.length <= scalars.count - selection.location
        else { throw Error.invalidUTF16Range(location: selection.location, length: selection.length) }
        let start = scalars.index(scalars.startIndex, offsetBy: selection.location)
        let end = scalars.index(start, offsetBy: selection.length)
        return NSRange(
            location: text.utf16.distance(from: text.utf16.startIndex, to: start),
            length: text.utf16.distance(from: start, to: end)
        )
    }

    private static func canonical(_ semantic: LoroCanonicalSemanticValueV1) throws -> LoroCanonicalSemanticValueV1 {
        let limits = LoroPageProjectionLimits()
        guard !semantic.blocks.isEmpty, semantic.blocks.count <= limits.maxChildren else { throw Error.invalidSemanticDocument }
        var runCount = 0
        var utf8Bytes = 0
        for block in semantic.blocks {
            let runs = runs(in: block)
            if case let .heading(level, _) = block, !(1...3).contains(level) {
                throw Error.invalidSemanticDocument
            }
            var previous: [LoroCanonicalSemanticValueV1.Mark]?
            for run in runs {
                runCount += 1
                utf8Bytes += run.text.lengthOfBytes(using: .utf8)
                guard !run.text.isEmpty,
                      !run.text.contains("\n"),
                      !run.text.contains("\r"),
                      run.marks == canonicalMarks.filter(run.marks.contains),
                      Set(run.marks.map(\.rawValue)).count == run.marks.count,
                      previous != run.marks,
                      runCount <= limits.maxTextRuns,
                      utf8Bytes <= limits.maxUTF8Bytes,
                      run.marks.count <= limits.maxMarks
                else { throw Error.invalidSemanticDocument }
                previous = run.marks
            }
        }
        return semantic
    }

    private static func runs(in block: LoroCanonicalSemanticValueV1.Block) -> [LoroCanonicalSemanticValueV1.TextRun] {
        switch block {
        case let .paragraph(runs): return runs
        case let .heading(_, runs): return runs
        }
    }

    private static func marker(for block: LoroCanonicalSemanticValueV1.Block) -> String {
        switch block {
        case .paragraph: return "paragraph"
        case let .heading(level, _): return "heading-\(level)"
        }
    }

    private static func makeBlock(kind: String, runs: [LoroCanonicalSemanticValueV1.TextRun]) -> LoroCanonicalSemanticValueV1.Block {
        switch kind {
        case "paragraph": return .paragraph(runs)
        case "heading-1": return .heading(level: 1, runs: runs)
        case "heading-2": return .heading(level: 2, runs: runs)
        case "heading-3": return .heading(level: 3, runs: runs)
        default: preconditionFailure("validated block marker required")
        }
    }

    private static func marksMarker(_ marks: [LoroCanonicalSemanticValueV1.Mark]) -> String {
        marks.map(\.rawValue).joined(separator: ",")
    }

    private static func decodeMarks(_ value: Any?) throws -> [LoroCanonicalSemanticValueV1.Mark] {
        guard let value else { return [] }
        guard let marker = value as? String else { throw Error.malformedMarker("marks") }
        let components = marker.split(separator: ",", omittingEmptySubsequences: false)
        let decoded = marker.isEmpty ? [] : components.compactMap { LoroCanonicalSemanticValueV1.Mark(rawValue: String($0)) }
        guard marker == marksMarker(decoded),
              decoded.count == (marker.isEmpty ? 0 : components.count),
              decoded == canonicalMarks.filter(decoded.contains),
              Set(decoded.map(\.rawValue)).count == decoded.count
        else { throw Error.malformedMarker("marks") }
        return decoded
    }

    private static func decodeRuns(in attributed: NSAttributedString, range: NSRange) throws -> [LoroCanonicalSemanticValueV1.TextRun] {
        guard range.length > 0 else { return [] }
        var result: [LoroCanonicalSemanticValueV1.TextRun] = []
        var failure: Error?
        attributed.enumerateAttributes(in: range, options: []) { attributes, subrange, _ in
            guard failure == nil else { return }
            do {
                _ = try scalarOffset(atUTF16Offset: subrange.location, in: attributed.string, original: subrange)
                _ = try scalarOffset(atUTF16Offset: subrange.location + subrange.length, in: attributed.string, original: subrange)
                let text = attributed.attributedSubstring(from: subrange).string
                guard !text.isEmpty, !text.contains("\n") else { throw Error.malformedMarker("run text") }
                let marks = try decodeMarks(attributes[Attribute.marks])
                if let previous = result.last, previous.marks == marks {
                    result[result.index(before: result.endIndex)] = .init(text: previous.text + text, marks: marks)
                } else {
                    result.append(.init(text: text, marks: marks))
                }
            } catch {
                failure = error as? Error ?? .invalidSemanticDocument
            }
        }
        if let failure { throw failure }
        return result
    }

    private static func blockMarker(
        in attributed: NSAttributedString,
        contentRange: NSRange,
        previousSeparatorRange: NSRange?,
        nextSeparatorRange: NSRange?
    ) throws -> String {
        var candidates: [String] = []
        var sawMissingContentMarker = false
        var sawMarksWithoutBlock = false
        var malformedContentMarker = false
        if contentRange.length > 0 {
            attributed.enumerateAttributes(in: contentRange, options: []) { attributes, _, _ in
                if let rawValue = attributes[Attribute.block] {
                    if let value = rawValue as? String { candidates.append(value) }
                    else { malformedContentMarker = true }
                } else { sawMissingContentMarker = true }
                if attributes[Attribute.marks] != nil, attributes[Attribute.block] == nil {
                    sawMarksWithoutBlock = true
                }
            }
        }
        guard !malformedContentMarker else { throw Error.malformedMarker("block") }
        guard !sawMarksWithoutBlock else { throw Error.malformedMarker("marks without block") }
        if let previousSeparatorRange, let value = attributed.attribute(Attribute.separatorAfter, at: previousSeparatorRange.location, effectiveRange: nil) {
            guard let marker = value as? String else { throw Error.malformedMarker("separator-after") }
            candidates.append(marker)
        }
        if let nextSeparatorRange, let value = attributed.attribute(Attribute.separatorBefore, at: nextSeparatorRange.location, effectiveRange: nil) {
            guard let marker = value as? String else { throw Error.malformedMarker("separator-before") }
            candidates.append(marker)
        }
        guard !(sawMissingContentMarker && !candidates.isEmpty) else { throw Error.malformedMarker("mixed block markers") }
        if candidates.isEmpty { return "paragraph" }
        guard candidates.allSatisfy({ $0 == candidates[0] }), isBlockMarker(candidates[0]) else { throw Error.malformedMarker("block") }
        return candidates[0]
    }

    private static func validateAttributes(in attributed: NSAttributedString) throws {
        var terminalOffsets: [Int] = []
        for offset in 0..<attributed.length {
            let attributes = attributed.attributes(at: offset, effectiveRange: nil)
            for key in attributes.keys where !Attribute.allowed.contains(key) {
                throw Error.unsupportedAttribute(key.rawValue)
            }
            if attributed.string.utf16[at: offset] == 10 {
                if attributes[Attribute.marks] != nil || attributes[Attribute.block] != nil {
                    throw Error.malformedMarker("separator")
                } else {
                    let before = attributes[Attribute.separatorBefore]
                    let after = attributes[Attribute.separatorAfter]
                    let terminal = attributes[Attribute.terminalEmptyDocument]
                    if terminal != nil { terminalOffsets.append(offset) }
                    if (before == nil) != (after == nil) ||
                        (before != nil && (!(before is String) || !(after is String))) ||
                        (terminal != nil && (!(terminal is String) || before != nil || after != nil)) {
                        throw Error.malformedMarker("separator")
                    }
                }
            } else if attributes[Attribute.separatorBefore] != nil || attributes[Attribute.separatorAfter] != nil || attributes[Attribute.terminalEmptyDocument] != nil {
                throw Error.malformedMarker("non-separator")
            }
        }
        if !terminalOffsets.isEmpty {
            var terminalRange = NSRange(location: NSNotFound, length: 0)
            let terminal = attributed.attribute(Attribute.terminalEmptyDocument, at: terminalOffsets[0], effectiveRange: &terminalRange)
            guard attributed.string == "\n",
                  terminalOffsets == [0],
                  terminalRange == NSRange(location: 0, length: 1),
                  let marker = terminal as? String,
                  isBlockMarker(marker),
                  marker != "paragraph"
            else {
                throw Error.malformedMarker("terminal empty document")
            }
        }
    }

    private static func isBlockMarker(_ marker: String) -> Bool {
        ["paragraph", "heading-1", "heading-2", "heading-3"].contains(marker)
    }

    private static func scalarOffset(atUTF16Offset offset: Int, in text: String, original: NSRange) throws -> Int {
        let utf16 = text.utf16
        let index = utf16.index(utf16.startIndex, offsetBy: offset)
        guard let scalarIndex = String.Index(index, within: text.unicodeScalars) else {
            throw Error.invalidUTF16Range(location: original.location, length: original.length)
        }
        return text.unicodeScalars.distance(from: text.unicodeScalars.startIndex, to: scalarIndex)
    }

    private static let canonicalMarks: [LoroCanonicalSemanticValueV1.Mark] = [.code, .emphasis, .strong]
}

private extension String.UTF16View {
    subscript(at offset: Int) -> UInt16 {
        self[index(startIndex, offsetBy: offset)]
    }
}
#endif
