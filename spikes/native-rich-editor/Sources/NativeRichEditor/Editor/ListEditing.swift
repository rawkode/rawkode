import AppKit

@MainActor
enum ListEditing {
    enum Kind { case bullet, numbered, task }

    private static var editing = false
    private static let markerPattern = try! NSRegularExpression(pattern: "^\\t(☐|☑|[•◦▪]|[0-9]+\\.)\\t")

    /// Keep visible markers in the attributed string, including clickable task
    /// boxes. Older AppKit versions already use this representation.
    static func configure(in text: DocumentTextView) {
        if #available(macOS 26, *) {
            (text.textLayoutManager?.textContentManager as? NSTextContentStorage)?.includesTextListMarkers = true
        }
    }

    static func apply(_ kind: Kind, in text: DocumentTextView) {
        edit(in: text, action: "Format list") { value, selection, typing in
            let ranges = paragraphs(in: value.string, selection: selection)
            let remove = !ranges.isEmpty && ranges.allSatisfy { self.kind(at: $0.location, in: value, fallback: typing) == kind }
            let list = makeList(kind)
            let previous = ranges.first.flatMap { previousLists(before: $0.location, in: value, kind: kind) }
            for range in ranges.reversed() {
                guard !isProtected(range, in: value) else { continue }
                let oldMarker = marker(in: value, paragraph: range)
                let style = paragraphStyle(at: range.location, in: value, fallback: typing)
                var lists = style.textLists
                if remove { lists = [] }
                else if lists.isEmpty { lists = previous ?? [list] }
                else { lists[lists.count - 1] = list }
                let prefix = remove ? "" : markerText(kind, checked: oldMarker?.checked == true)
                rewriteParagraph(range, in: value, lists: lists, prefix: prefix,
                                 replacingPrefixLength: oldMarker?.range.length ?? 0, selection: &selection)
            }
            typing = attributesForCaret(selection.location, in: value, fallback: typing)
        }
    }

    static func remove(in text: DocumentTextView) {
        edit(in: text, action: "Remove list") { value, selection, typing in
            for range in paragraphs(in: value.string, selection: selection).reversed() {
                guard !isProtected(range, in: value) else { continue }
                let oldMarker = marker(in: value, paragraph: range)
                let style = paragraphStyle(at: range.location, in: value, fallback: typing)
                guard oldMarker != nil || !style.textLists.isEmpty else { continue }
                rewriteParagraph(range, in: value, lists: [], prefix: "",
                                 replacingPrefixLength: oldMarker?.range.length ?? 0, selection: &selection)
            }
            typing = attributesForCaret(selection.location, in: value, fallback: typing)
        }
    }

    @discardableResult
    static func handlePrefix(in text: DocumentTextView) -> Bool {
        guard !editing, let storage = text.textStorage, text.selectedRange().length == 0 else { return false }
        let selection = text.selectedRange()
        let range = paragraph(in: storage.string, at: selection.location)
        guard !isProtected(range, in: storage) else { return false }
        let existing = marker(in: storage, paragraph: range)
        let start = range.location + (existing?.range.length ?? 0)
        guard selection.location >= start else { return false }
        let prefixRange = NSRange(location: start, length: selection.location - start)
        let prefix = (storage.string as NSString).substring(with: prefixRange)
        let kind: Kind
        let checked: Bool
        switch prefix {
        case "- ", "* ": kind = .bullet; checked = false
        case "1. ": kind = .numbered; checked = false
        case "[] ", "[ ] ", "- [ ] ": kind = .task; checked = false
        case "[x] ", "[X] ", "- [x] ", "- [X] ": kind = .task; checked = true
        default: return false
        }
        edit(in: text, action: "Create list") { value, selection, typing in
            var lists = paragraphStyle(at: range.location, in: value, fallback: typing).textLists
            if lists.isEmpty { lists = previousLists(before: range.location, in: value, kind: kind) ?? [makeList(kind)] }
            else if self.kind(at: range.location, in: value, fallback: typing) != kind {
                lists[lists.count - 1] = makeList(kind)
            }
            rewriteParagraph(range, in: value, lists: lists, prefix: markerText(kind, checked: checked),
                             replacingPrefixLength: prefixRange.length + (existing?.range.length ?? 0), selection: &selection)
            typing = attributesForCaret(selection.location, in: value, fallback: typing)
        }
        return true
    }

    @discardableResult
    static func handleNewline(in text: DocumentTextView) -> Bool {
        guard !editing, let storage = text.textStorage else { return false }
        let selection = text.selectedRange()
        let range = paragraph(in: storage.string, at: selection.location)
        guard NSMaxRange(selection) <= NSMaxRange(range), !isProtected(range, in: storage),
              let kind = kind(at: range.location, in: storage, fallback: text.typingAttributes) else { return false }
        let marker = marker(in: storage, paragraph: range)
        let bodyStart = range.location + (marker?.range.length ?? 0)
        guard selection.location >= bodyStart || selection.length == 0 else { return false }
        let body = (storage.string as NSString).substring(with: NSRange(location: bodyStart, length: NSMaxRange(range) - bodyStart))
        let style = paragraphStyle(at: range.location, in: storage, fallback: text.typingAttributes)
        edit(in: text, action: body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "End list" : "Continue list") { value, selection, typing in
            if body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let end = contentEnd(of: range, in: value.string)
                rewriteParagraph(range, in: value, lists: [], prefix: "", replacingPrefixLength: end - range.location,
                                 selection: &selection)
                selection = NSRange(location: range.location, length: 0)
                typing[.paragraphStyle] = styled(style, lists: [])
            } else {
                let insertion = NSRange(location: max(selection.location, bodyStart), length: selection.length)
                var attributes = typing
                attributes.removeValue(forKey: .attachment)
                attributes[.paragraphStyle] = styled(style, lists: style.textLists)
                let next = NSAttributedString(string: "\n" + markerText(kind), attributes: attributes)
                value.replaceCharacters(in: insertion, with: next)
                selection = NSRange(location: insertion.location + next.length, length: 0)
                let nextRange = paragraph(in: value.string, at: selection.location)
                if nextRange.length > 0 { value.addAttribute(.paragraphStyle, value: styled(style, lists: style.textLists), range: nextRange) }
                typing = attributes
            }
        }
        return true
    }

    @discardableResult
    static func handleIndent(in text: DocumentTextView, outdent: Bool) -> Bool {
        guard !editing, let storage = text.textStorage else { return false }
        let ranges = paragraphs(in: storage.string, selection: text.selectedRange())
        guard ranges.contains(where: { kind(at: $0.location, in: storage, fallback: text.typingAttributes) != nil }) else { return false }
        edit(in: text, action: outdent ? "Outdent list" : "Indent list") { value, selection, typing in
            let firstKind = kind(at: ranges[0].location, in: value, fallback: typing) ?? .bullet
            let nested = makeList(firstKind)
            for range in ranges.reversed() {
                guard let kind = kind(at: range.location, in: value, fallback: typing), !isProtected(range, in: value) else { continue }
                var lists = paragraphStyle(at: range.location, in: value, fallback: typing).textLists
                if outdent {
                    lists.removeLast()
                    if let parent = lists.last, listKind(parent) != kind { lists[lists.count - 1] = makeList(kind) }
                } else if lists.count < 6 { lists.append(kind == firstKind ? nested : makeList(kind)) }
                let oldMarker = marker(in: value, paragraph: range)
                rewriteParagraph(range, in: value, lists: lists,
                                 prefix: lists.isEmpty ? "" : markerText(kind, checked: oldMarker?.checked == true),
                                 replacingPrefixLength: oldMarker?.range.length ?? 0, selection: &selection)
            }
            typing = attributesForCaret(selection.location, in: value, fallback: typing)
        }
        return true
    }

    @discardableResult
    static func toggleTask(in text: DocumentTextView, at index: Int) -> Bool {
        guard !editing, let storage = text.textStorage, index >= 0, index < storage.length else { return false }
        let range = paragraph(in: storage.string, at: index)
        guard let marker = marker(in: storage, paragraph: range), marker.kind == .task,
              (marker.range.location + 1 ... marker.range.location + 2).contains(index) else { return false }
        edit(in: text, action: marker.checked ? "Uncheck task" : "Complete task") { value, _, _ in
            value.replaceCharacters(in: NSRange(location: marker.range.location + 1, length: 1), with: marker.checked ? "☐" : "☑")
        }
        return true
    }

    private static func edit(in text: DocumentTextView, action: String,
                             mutation: (NSMutableAttributedString, inout NSRange, inout [NSAttributedString.Key: Any]) -> Void) {
        guard !editing, let storage = text.textStorage, let session = text.session else { return }
        configure(in: text)
        editing = true
        defer { editing = false }
        let original = NSAttributedString(attributedString: storage)
        let value = NSMutableAttributedString(attributedString: original)
        var selection = text.selectedRange()
        var typing = text.typingAttributes
        mutation(value, &selection, &typing)
        renumber(value, selection: &selection)
        if let difference = changedRange(from: original, to: value) {
            session.replace(difference.old, with: value.attributedSubstring(from: difference.new), action: action)
        }
        text.setSelectedRange(NSRange(location: min(selection.location, value.length),
                                      length: min(selection.length, max(0, value.length - selection.location))))
        typing.removeValue(forKey: .attachment)
        text.typingAttributes = typing
    }

    private static func rewriteParagraph(_ range: NSRange, in value: NSMutableAttributedString, lists: [NSTextList],
                                         prefix: String, replacingPrefixLength: Int, selection: inout NSRange) {
        let sourceStyle = paragraphStyle(at: range.location, in: value, fallback: [:])
        let style = styled(sourceStyle, lists: lists)
        let replaced = NSRange(location: range.location, length: replacingPrefixLength)
        var attributes = range.location < value.length ? value.attributes(at: range.location, effectiveRange: nil) : EditorSession.bodyAttributes
        attributes[.paragraphStyle] = style
        attributes.removeValue(forKey: .attachment)
        value.replaceCharacters(in: replaced, with: NSAttributedString(string: prefix, attributes: attributes))
        selection = adjusted(selection, replacing: replaced, length: prefix.utf16.count)
        let newRange = NSRange(location: range.location, length: range.length - replacingPrefixLength + prefix.utf16.count)
        if newRange.length > 0 { value.addAttribute(.paragraphStyle, value: style, range: newRange) }
    }

    private static func styled(_ original: NSParagraphStyle, lists: [NSTextList]) -> NSParagraphStyle {
        let style = original.mutableCopy() as! NSMutableParagraphStyle
        style.textLists = lists
        let depth = CGFloat(lists.count)
        style.firstLineHeadIndent = max(0, depth - 1) * 28
        style.headIndent = depth * 28
        style.tabStops = lists.isEmpty ? [] : [NSTextTab(textAlignment: .left, location: depth * 28 - 18),
                                             NSTextTab(textAlignment: .left, location: depth * 28)]
        style.defaultTabInterval = 28
        style.paragraphSpacing = lists.isEmpty ? 12 : 5
        return style
    }

    private static func makeList(_ kind: Kind) -> NSTextList {
        let format: NSTextList.MarkerFormat
        switch kind {
        case .bullet: format = .disc
        case .numbered: format = NSTextList.MarkerFormat(rawValue: "{decimal}.")
        case .task: format = .box
        }
        return NSTextList(markerFormat: format, options: 0)
    }

    private static func markerText(_ kind: Kind, checked: Bool = false, number: Int = 1) -> String {
        switch kind {
        case .bullet: return "\t•\t"
        case .numbered: return "\t\(number).\t"
        case .task: return checked ? "\t☑\t" : "\t☐\t"
        }
    }

    private struct Marker {
        var range: NSRange
        var kind: Kind
        var checked: Bool
    }

    private static func marker(in value: NSAttributedString, paragraph: NSRange) -> Marker? {
        let source = (value.string as NSString).substring(with: paragraph)
        guard let match = markerPattern.firstMatch(in: source, range: NSRange(location: 0, length: source.utf16.count)) else { return nil }
        let token = (source as NSString).substring(with: match.range(at: 1))
        let kind: Kind = token == "☐" || token == "☑" ? .task : token.last == "." ? .numbered : .bullet
        return Marker(range: NSRange(location: paragraph.location, length: match.range.length), kind: kind, checked: token == "☑")
    }

    private static func kind(at index: Int, in value: NSAttributedString, fallback: [NSAttributedString.Key: Any]) -> Kind? {
        guard let list = paragraphStyle(at: index, in: value, fallback: fallback).textLists.last else { return nil }
        return listKind(list)
    }

    private static func listKind(_ list: NSTextList) -> Kind {
        if list.isOrdered { return .numbered }
        if list.markerFormat == .box || list.markerFormat == .check { return .task }
        return .bullet
    }

    private static func paragraphStyle(at index: Int, in value: NSAttributedString, fallback: [NSAttributedString.Key: Any]) -> NSParagraphStyle {
        if index < value.length, let style = value.attribute(.paragraphStyle, at: index, effectiveRange: nil) as? NSParagraphStyle { return style }
        return fallback[.paragraphStyle] as? NSParagraphStyle ?? NSParagraphStyle.default
    }

    private static func attributesForCaret(_ index: Int, in value: NSAttributedString, fallback: [NSAttributedString.Key: Any]) -> [NSAttributedString.Key: Any] {
        guard value.length > 0 else {
            var attributes = fallback
            attributes[.paragraphStyle] = styled(NSParagraphStyle.default, lists: [])
            return attributes
        }
        return value.attributes(at: min(max(0, index - 1), value.length - 1), effectiveRange: nil)
    }

    private static func previousLists(before index: Int, in value: NSAttributedString, kind: Kind) -> [NSTextList]? {
        guard index > 0, self.kind(at: index - 1, in: value, fallback: [:]) == kind else { return nil }
        return paragraphStyle(at: index - 1, in: value, fallback: [:]).textLists
    }

    private static func paragraph(in string: String, at index: Int) -> NSRange {
        (string as NSString).paragraphRange(for: NSRange(location: min(max(0, index), string.utf16.count), length: 0))
    }

    private static func paragraphs(in string: String, selection: NSRange) -> [NSRange] {
        let first = paragraph(in: string, at: selection.location)
        let last = paragraph(in: string, at: max(selection.location, NSMaxRange(selection) - 1))
        var ranges = [first]
        var cursor = NSMaxRange(first)
        while cursor < NSMaxRange(last) {
            let next = paragraph(in: string, at: cursor)
            guard next.length > 0 else { break }
            ranges.append(next)
            cursor = NSMaxRange(next)
        }
        return ranges
    }

    private static func contentEnd(of range: NSRange, in string: String) -> Int {
        let string = string as NSString
        var end = NSMaxRange(range)
        while end > range.location, [10, 13, 0x2029].contains(Int(string.character(at: end - 1))) { end -= 1 }
        return end
    }

    private static func isProtected(_ range: NSRange, in value: NSAttributedString) -> Bool {
        var protected = false
        value.enumerateAttributes(in: range) { attributes, _, stop in
            if attributes[.attachment] != nil || attributes[.codeLanguage] != nil { protected = true; stop.pointee = true }
        }
        return protected
    }

    private static func renumber(_ value: NSMutableAttributedString, selection: inout NSRange) {
        var counts: [Int: (Kind, Int)] = [:]
        var replacements: [(NSRange, String)] = []
        for range in paragraphs(in: value.string, selection: NSRange(location: 0, length: value.length)) {
            let style = paragraphStyle(at: range.location, in: value, fallback: [:])
            guard let kind = kind(at: range.location, in: value, fallback: [:]) else { counts.removeAll(); continue }
            let depth = style.textLists.count
            counts = counts.filter { $0.key <= depth }
            let number = counts[depth].map { $0.0 == kind ? $0.1 + 1 : 1 } ?? 1
            counts[depth] = (kind, number)
            if kind == .numbered, let marker = marker(in: value, paragraph: range) {
                let desired = markerText(kind, number: number)
                if (value.string as NSString).substring(with: marker.range) != desired { replacements.append((marker.range, desired)) }
            }
        }
        for (range, marker) in replacements.reversed() {
            value.replaceCharacters(in: range, with: marker)
            selection = adjusted(selection, replacing: range, length: marker.utf16.count)
        }
    }

    private static func adjusted(_ selection: NSRange, replacing range: NSRange, length: Int) -> NSRange {
        func position(_ index: Int) -> Int {
            if index < range.location { return index }
            if index >= NSMaxRange(range) { return index + length - range.length }
            return range.location + length
        }
        let start = position(selection.location)
        return NSRange(location: start, length: max(0, position(NSMaxRange(selection)) - start))
    }

    /// Only replace changed content, so an edit in one list does not recreate
    /// unrelated inline components or reset their playback state.
    private static func changedRange(from old: NSAttributedString, to new: NSAttributedString) -> (old: NSRange, new: NSRange)? {
        let a = old.string as NSString, b = new.string as NSString
        func equal(_ i: Int, _ j: Int) -> Bool {
            a.character(at: i) == b.character(at: j)
                && NSDictionary(dictionary: old.attributes(at: i, effectiveRange: nil)).isEqual(to: new.attributes(at: j, effectiveRange: nil))
        }
        var start = 0
        while start < min(old.length, new.length), equal(start, start) { start += 1 }
        if start == old.length && start == new.length { return nil }
        if start < old.length { start = min(start, a.rangeOfComposedCharacterSequence(at: start).location) }
        if start < new.length { start = min(start, b.rangeOfComposedCharacterSequence(at: start).location) }
        var oldEnd = old.length, newEnd = new.length
        while oldEnd > start, newEnd > start, equal(oldEnd - 1, newEnd - 1) { oldEnd -= 1; newEnd -= 1 }
        if oldEnd < old.length {
            let sequence = a.rangeOfComposedCharacterSequence(at: oldEnd)
            if sequence.location < oldEnd { oldEnd = NSMaxRange(sequence) }
        }
        if newEnd < new.length {
            let sequence = b.rangeOfComposedCharacterSequence(at: newEnd)
            if sequence.location < newEnd { newEnd = NSMaxRange(sequence) }
        }
        return (NSRange(location: start, length: oldEnd - start), NSRange(location: start, length: newEnd - start))
    }
}
