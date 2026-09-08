import Foundation
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
        static let reference = NSAttributedString.Key("dev.athenaeum.rich.reference.v1")
        static let block = NSAttributedString.Key("dev.athenaeum.rich.block.v1")
        static let separatorBefore = NSAttributedString.Key("dev.athenaeum.rich.separator-before.v1")
        static let separatorAfter = NSAttributedString.Key("dev.athenaeum.rich.separator-after.v1")
        static let terminalEmptyDocument = NSAttributedString.Key("dev.athenaeum.rich.terminal-empty-document.v1")
        static let allowed: Set<NSAttributedString.Key> = [marks, reference, block, separatorBefore, separatorAfter, terminalEmptyDocument]
    }

    /// A task item marker is deliberately an opaque object rather than a string.  It is only
    /// emitted by this codec and therefore cannot be manufactured by an attributed paste or a
    /// caller that merely knows our private attribute keys.  The list/item ordinals are
    /// presentation witnesses used to retain topology in TextKit's flat storage; they are never
    /// part of the canonical Loro value.
    private final class TaskItemMarker: NSObject {
        let listOrdinal: Int
        let itemOrdinal: Int
        let checked: Bool

        init(listOrdinal: Int, itemOrdinal: Int, checked: Bool) {
            self.listOrdinal = listOrdinal
            self.itemOrdinal = itemOrdinal
            self.checked = checked
        }

        override func isEqual(_ object: Any?) -> Bool {
            guard let other = object as? TaskItemMarker else { return false }
            return listOrdinal == other.listOrdinal && itemOrdinal == other.itemOrdinal && checked == other.checked
        }

        override var hash: Int {
            var hasher = Hasher()
            hasher.combine(listOrdinal); hasher.combine(itemOrdinal); hasher.combine(checked)
            return hasher.finalize()
        }
    }

    private enum BlockMarker: Equatable {
        case paragraph
        case heading(Int)
        case task(TaskItemMarker)

        static func == (lhs: Self, rhs: Self) -> Bool {
            switch (lhs, rhs) {
            case (.paragraph, .paragraph): return true
            case let (.heading(a), .heading(b)): return a == b
            case let (.task(a), .task(b)): return a.isEqual(b)
            default: return false
            }
        }
    }

    /// TextKit storage is not a wire format.  This typed, in-process marker prevents untrusted
    /// attributed paste from manufacturing an id-bearing reference with a dictionary or string.
    private final class ReferenceMarker: NSObject {
        let reference: LoroCanonicalSemanticValueV1.InlineReference

        init(reference: LoroCanonicalSemanticValueV1.InlineReference) { self.reference = reference }

        override func isEqual(_ object: Any?) -> Bool {
            (object as? ReferenceMarker)?.reference == reference
        }

        override var hash: Int {
            var hasher = Hasher()
            hasher.combine(reference.id)
            hasher.combine(reference.label)
            hasher.combine(reference.kind == .entity ? 0 : 1)
            return hasher.finalize()
        }
    }

    enum Error: Swift.Error, Equatable, Sendable {
        case unsupportedAttribute(String)
        case malformedMarker(String)
        case invalidUTF16Range(location: Int, length: Int)
        case invalidSemanticDocument
    }

    typealias ScalarSelection = LoroNativeRichTextSelection

    /// Render only controlled semantic markers.  Visual styling and editor commands belong to the
    /// R3-B `NSTextView` wrapper; keeping it out of this codec prevents arbitrary AppKit font
    /// traits from being mistaken for durable editor semantics.
    static func attributedString(for document: LoroNativeRichDocumentV1) throws -> NSAttributedString {
        let semantic = try canonical(document.semantic)
        var logicalBlocks: [(marker: BlockMarker, runs: [LoroCanonicalSemanticValueV1.TextRun])] = []
        for (blockOrdinal, block) in semantic.blocks.enumerated() {
            switch block {
            case let .paragraph(runs): logicalBlocks.append((.paragraph, runs))
            case let .heading(level, runs): logicalBlocks.append((.heading(level), runs))
            case let .taskList(items):
                // The canonical top-level block ordinal is the structural identity used by the
                // checkbox command witness. It remains stable across an ordinary render and does
                // not collapse two adjacent task lists into one presentation list.
                let currentList = blockOrdinal
                for (itemOrdinal, item) in items.enumerated() {
                    logicalBlocks.append((.task(.init(listOrdinal: currentList, itemOrdinal: itemOrdinal, checked: item.checked)), item.runs))
                }
            }
        }
        if logicalBlocks.count == 1, logicalBlocks[0].runs.isEmpty, logicalBlocks[0].marker != .paragraph {
            // A zero-length attributed string cannot carry a marker.  The single separator is an
            // explicit terminal encoding for this otherwise unrepresentable empty heading; it is
            // distinct from user-typed unmarked `\n`, which decodes to two empty paragraphs.
            let marker = logicalBlocks[0].marker
            return NSAttributedString(string: "\n", attributes: [
                Attribute.terminalEmptyDocument: markerValue(marker)
            ])
        }
        let result = NSMutableAttributedString()

        for index in logicalBlocks.indices {
            let logical = logicalBlocks[index]
            let runs = logical.runs
            let blockMarker = logical.marker
            for run in runs {
                var attributes: [NSAttributedString.Key: Any] = [Attribute.block: markerValue(blockMarker)]
                if !run.marks.isEmpty {
                    attributes[Attribute.marks] = marksMarker(run.marks)
                }
                if let reference = run.reference {
                    attributes[Attribute.reference] = ReferenceMarker(reference: reference)
                }
                result.append(NSAttributedString(string: run.text, attributes: attributes))
            }

            if index < logicalBlocks.index(before: logicalBlocks.endIndex) {
                let following = logicalBlocks[logicalBlocks.index(after: index)]
                result.append(NSAttributedString(
                    string: "\n",
                    attributes: [
                        Attribute.separatorBefore: markerValue(blockMarker),
                        Attribute.separatorAfter: markerValue(following.marker)
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
        if text == "\n", let rawMarker = attributed.attribute(Attribute.terminalEmptyDocument, at: 0, effectiveRange: nil) {
            let marker = try parseMarker(rawMarker)
            switch marker {
            case .paragraph: throw Error.malformedMarker("terminal empty document")
            case let .heading(level):
                return LoroNativeRichDocumentV1(semantic: try canonical(.init(blocks: [.heading(level: level, runs: [])])))
            case let .task(item):
                guard item.itemOrdinal == 0 else { throw Error.malformedMarker("terminal task item") }
                return LoroNativeRichDocumentV1(semantic: try canonical(.init(blocks: [.taskList([.init(checked: item.checked, runs: [])])])))
            }
        }

        let pieces = text.split(separator: "\n", omittingEmptySubsequences: false)
        var logicalBlocks: [(marker: BlockMarker, runs: [LoroCanonicalSemanticValueV1.TextRun])] = []
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
            logicalBlocks.append((kind, runs))
            utf16Offset += pieceLength + (nextSeparatorRange == nil ? 0 : 1)
        }

        var blocks: [LoroCanonicalSemanticValueV1.Block] = []
        var activeTaskList: (ordinal: Int, items: [LoroCanonicalSemanticValueV1.TaskItem])?
        func flushTaskList() {
            if let activeTaskList { blocks.append(.taskList(activeTaskList.items)) }
        }
        for logical in logicalBlocks {
            switch logical.marker {
            case .paragraph:
                flushTaskList(); activeTaskList = nil; blocks.append(.paragraph(logical.runs))
            case let .heading(level):
                flushTaskList(); activeTaskList = nil; blocks.append(.heading(level: level, runs: logical.runs))
            case let .task(item):
                guard item.itemOrdinal >= 0 else { throw Error.malformedMarker("task item ordinal") }
                if let active = activeTaskList {
                    if active.ordinal != item.listOrdinal {
                        guard item.itemOrdinal == 0 else { throw Error.malformedMarker("task list start") }
                        blocks.append(.taskList(active.items))
                        activeTaskList = (item.listOrdinal, [.init(checked: item.checked, runs: logical.runs)])
                    } else {
                        guard item.itemOrdinal == active.items.count else { throw Error.malformedMarker("task list topology") }
                        activeTaskList = (active.ordinal, active.items + [.init(checked: item.checked, runs: logical.runs)])
                    }
                } else {
                    guard item.itemOrdinal == 0 else { throw Error.malformedMarker("task list start") }
                    activeTaskList = (item.listOrdinal, [.init(checked: item.checked, runs: logical.runs)])
                }
            }
        }
        flushTaskList()
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

    /// Resolves only this codec's private, typed marker for a native interaction host.  It never
    /// decodes generic attributed input, so an untrusted id-bearing string or map cannot become
    /// an activation target.
    static func reference(atUTF16Offset offset: Int, in attributed: NSAttributedString) -> LoroCanonicalSemanticValueV1.InlineReference? {
        var range = NSRange(location: NSNotFound, length: 0)
        guard offset >= 0, offset < attributed.length,
              let marker = attributed.attribute(Attribute.reference, at: offset, effectiveRange: &range) as? ReferenceMarker,
              range.location != NSNotFound
        else { return nil }
        return (try? decodeReference(marker, text: attributed.attributedSubstring(from: range).string)) == nil
            ? nil
            : marker.reference
    }

    /// Returns the checklist witness at a visible character or separator.  Empty task items have
    /// no content characters, so their terminating separator carries the item's typed marker and
    /// is intentionally accepted here as the checkbox hit target.
    static func taskItem(atUTF16Offset offset: Int, in attributed: NSAttributedString) -> LoroNativeRichTaskItemLocation? {
        guard offset >= 0, offset < attributed.length else { return nil }
        if let marker = attributed.attribute(Attribute.block, at: offset, effectiveRange: nil) as? TaskItemMarker {
            return .init(taskListIndex: marker.listOrdinal, itemIndex: marker.itemOrdinal, checked: marker.checked)
        }
        guard attributed.string.utf16[at: offset] == 10 else { return nil }
        // A trailing empty item has no content characters; its only witness is the separator
        // immediately before it. Prefer that `separatorAfter` marker when this is the final
        // storage character, while normal/middle items resolve from the separator ending them.
        let before = attributed.attribute(Attribute.separatorBefore, at: offset, effectiveRange: nil) as? TaskItemMarker
        let after = attributed.attribute(Attribute.separatorAfter, at: offset, effectiveRange: nil) as? TaskItemMarker
        if offset == attributed.length - 1, let marker = after ?? before {
            return .init(taskListIndex: marker.listOrdinal, itemIndex: marker.itemOrdinal, checked: marker.checked)
        }
        if let marker = before ?? after {
            return .init(taskListIndex: marker.listOrdinal, itemIndex: marker.itemOrdinal, checked: marker.checked)
        }
        if let marker = attributed.attribute(Attribute.terminalEmptyDocument, at: offset, effectiveRange: nil) as? TaskItemMarker {
            return .init(taskListIndex: marker.listOrdinal, itemIndex: marker.itemOrdinal, checked: marker.checked)
        }
        return nil
    }

    /// Native layout managers report glyph bounds in text-container coordinates.  Keeping this
    /// arithmetic pure makes the platform hosts prove they cannot activate a neighbouring label,
    /// padding, or trailing whitespace after scroll/inset conversion.
    static func textContainerPoint(_ viewPoint: CGPoint, origin: CGPoint) -> CGPoint {
        .init(x: viewPoint.x - origin.x, y: viewPoint.y - origin.y)
    }

    static func admitsReferenceHit(
        characterIndex: Int,
        textLength: Int,
        textContainerPoint: CGPoint,
        glyphRect: CGRect
    ) -> Bool {
        characterIndex >= 0 && characterIndex < textLength && !glyphRect.isEmpty && glyphRect.contains(textContainerPoint)
    }

    private static func canonical(_ semantic: LoroCanonicalSemanticValueV1) throws -> LoroCanonicalSemanticValueV1 {
        let limits = LoroPageProjectionLimits()
        guard !semantic.blocks.isEmpty, semantic.blocks.count <= limits.maxChildren else { throw Error.invalidSemanticDocument }
        var runCount = 0
        var utf8Bytes = 0
        for block in semantic.blocks {
            switch block {
            case let .paragraph(runs), let .heading(_, runs):
                try validateRuns(runs)
            case let .taskList(items):
                guard !items.isEmpty, items.count <= limits.maxChildren else { throw Error.invalidSemanticDocument }
                for item in items { try validateRuns(item.runs) }
            }
        }
        return semantic

        func validateRuns(_ runs: [LoroCanonicalSemanticValueV1.TextRun]) throws {
            var previous: (marks: [LoroCanonicalSemanticValueV1.Mark], reference: LoroCanonicalSemanticValueV1.InlineReference?)?
            for run in runs {
                runCount += 1
                utf8Bytes += run.text.lengthOfBytes(using: .utf8)
                if let reference = run.reference { utf8Bytes += reference.label.lengthOfBytes(using: .utf8) }
                guard !run.text.isEmpty,
                      !run.text.contains("\n"),
                      !run.text.contains("\r"),
                      run.marks == canonicalMarks.filter(run.marks.contains),
                      Set(run.marks.map(\.rawValue)).count == run.marks.count,
                      runCount <= limits.maxTextRuns,
                      utf8Bytes <= limits.maxUTF8Bytes,
                      run.marks.count <= limits.maxMarks
                else { throw Error.invalidSemanticDocument }
                if let reference = run.reference {
                    guard !reference.label.isEmpty,
                          !reference.label.contains("\n"),
                          !reference.label.contains("\r"),
                          reference.label.lengthOfBytes(using: .utf8) <= 500,
                          reference.label == run.text
                    else { throw Error.invalidSemanticDocument }
                }
                guard previous == nil || previous!.marks != run.marks || previous!.reference != run.reference
                else { throw Error.invalidSemanticDocument }
                previous = (run.marks, run.reference)
            }
        }
    }

    private static func markerValue(_ marker: BlockMarker) -> Any {
        switch marker {
        case .paragraph: return "paragraph"
        case let .heading(level): return "heading-\(level)"
        case let .task(item): return item
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

    private static func decodeReference(
        _ value: Any?,
        text: String
    ) throws -> LoroCanonicalSemanticValueV1.InlineReference? {
        guard let value else { return nil }
        guard let marker = value as? ReferenceMarker else { throw Error.malformedMarker("reference") }
        let reference = marker.reference
        guard !reference.label.isEmpty,
              !reference.label.contains("\n"),
              !reference.label.contains("\r"),
              reference.label.lengthOfBytes(using: .utf8) <= 500,
              reference.label == text
        else { throw Error.malformedMarker("reference") }
        return reference
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
                let reference = try decodeReference(attributes[Attribute.reference], text: text)
                // The label is the exact text of one reference span, so reference spans can
                // never coalesce without corrupting that snapshot.
                if let previous = result.last, previous.reference == nil, reference == nil, previous.marks == marks {
                    result[result.index(before: result.endIndex)] = .init(text: previous.text + text, marks: marks)
                } else {
                    result.append(.init(text: text, marks: marks, reference: reference))
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
    ) throws -> BlockMarker {
        var candidates: [BlockMarker] = []
        var sawMissingContentMarker = false
        var sawMarksWithoutBlock = false
        var malformedContentMarker = false
        if contentRange.length > 0 {
            attributed.enumerateAttributes(in: contentRange, options: []) { attributes, _, _ in
                if let rawValue = attributes[Attribute.block] {
                    if let value = try? parseMarker(rawValue) { candidates.append(value) }
                    else { malformedContentMarker = true }
                } else { sawMissingContentMarker = true }
                if (attributes[Attribute.marks] != nil || attributes[Attribute.reference] != nil), attributes[Attribute.block] == nil {
                    sawMarksWithoutBlock = true
                }
            }
        }
        guard !malformedContentMarker else { throw Error.malformedMarker("block") }
        guard !sawMarksWithoutBlock else { throw Error.malformedMarker("marks without block") }
        if let previousSeparatorRange, let value = attributed.attribute(Attribute.separatorAfter, at: previousSeparatorRange.location, effectiveRange: nil) {
            candidates.append(try parseMarker(value))
        }
        if let nextSeparatorRange, let value = attributed.attribute(Attribute.separatorBefore, at: nextSeparatorRange.location, effectiveRange: nil) {
            candidates.append(try parseMarker(value))
        }
        guard !(sawMissingContentMarker && !candidates.isEmpty) else { throw Error.malformedMarker("mixed block markers") }
        if candidates.isEmpty { return .paragraph }
        guard candidates.allSatisfy({ $0 == candidates[0] }) else { throw Error.malformedMarker("block") }
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
                if attributes[Attribute.marks] != nil || attributes[Attribute.reference] != nil || attributes[Attribute.block] != nil {
                    throw Error.malformedMarker("separator")
                } else {
                    let before = attributes[Attribute.separatorBefore]
                    let after = attributes[Attribute.separatorAfter]
                    let terminal = attributes[Attribute.terminalEmptyDocument]
                    if terminal != nil { terminalOffsets.append(offset) }
                    if (before == nil) != (after == nil) ||
                        (before != nil && ((try? parseMarker(before!)) == nil || (try? parseMarker(after!)) == nil)) ||
                        (terminal != nil && ((try? parseMarker(terminal!)) == nil || before != nil || after != nil)) {
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
                  let marker = try? parseMarker(terminal!),
                  marker != .paragraph
            else {
                throw Error.malformedMarker("terminal empty document")
            }
        }
    }

    private static func parseMarker(_ value: Any) throws -> BlockMarker {
        if let marker = value as? TaskItemMarker { return .task(marker) }
        guard let marker = value as? String else { throw Error.malformedMarker("block") }
        switch marker {
        case "paragraph": return .paragraph
        case "heading-1": return .heading(1)
        case "heading-2": return .heading(2)
        case "heading-3": return .heading(3)
        default: throw Error.malformedMarker("block")
        }
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
