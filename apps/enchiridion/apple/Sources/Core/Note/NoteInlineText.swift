import Foundation

// MARK: - Semantic attribute keys

/// The inline content of one text block projected into `AttributedString`.
/// Only these semantic keys are meaningful; presentation (fonts, colors) is
/// derived by the view layer and ignored when reading the string back.
public enum NoteText {
    public struct Bold: CodableAttributedStringKey { public typealias Value = Bool; public static let name = "rawkode.note.bold" }
    public struct Italic: CodableAttributedStringKey { public typealias Value = Bool; public static let name = "rawkode.note.italic" }
    public struct Underline: CodableAttributedStringKey { public typealias Value = Bool; public static let name = "rawkode.note.underline" }
    public struct Strike: CodableAttributedStringKey { public typealias Value = Bool; public static let name = "rawkode.note.strike" }
    public struct Code: CodableAttributedStringKey { public typealias Value = Bool; public static let name = "rawkode.note.code" }
    public struct Link: CodableAttributedStringKey { public typealias Value = NoteAttributes; public static let name = "rawkode.note.link" }
    public struct TextStyle: CodableAttributedStringKey { public typealias Value = NoteAttributes; public static let name = "rawkode.note.textStyle" }
    /// An indivisible mention. Typed text never inherits it; a run whose text
    /// no longer equals the entity's display text is removed as a whole.
    public struct Entity: CodableAttributedStringKey {
        public typealias Value = EntityReference
        public static let name = "rawkode.note.entity"
        public static let inheritedByAddedText = false
    }
    /// One U+FFFC placeholder per inline component.
    public struct Component: CodableAttributedStringKey {
        public typealias Value = NoteComponent
        public static let name = "rawkode.note.component"
        public static let inheritedByAddedText = false
    }
    /// One U+2028 per `hardBreak` node; a literal U+2028 without it is text.
    public struct HardBreak: CodableAttributedStringKey {
        public typealias Value = Bool
        public static let name = "rawkode.note.hardBreak"
        public static let inheritedByAddedText = false
    }
}

extension AttributeScopes {
    public struct NoteTextAttributes: AttributeScope {
        public let noteBold: NoteText.Bold
        public let noteItalic: NoteText.Italic
        public let noteUnderline: NoteText.Underline
        public let noteStrike: NoteText.Strike
        public let noteCode: NoteText.Code
        public let noteLink: NoteText.Link
        public let noteTextStyle: NoteText.TextStyle
        public let noteEntity: NoteText.Entity
        public let noteComponent: NoteText.Component
        public let noteHardBreak: NoteText.HardBreak
    }
    public var noteText: NoteTextAttributes.Type { NoteTextAttributes.self }
}

extension AttributeDynamicLookup {
    public subscript<T: AttributedStringKey>(dynamicMember keyPath: KeyPath<AttributeScopes.NoteTextAttributes, T>) -> T { self[T.self] }
}

// MARK: - Projection

public enum NoteInlineText {
    public static let componentCharacter: Character = "\u{FFFC}"
    public static let hardBreakCharacter: Character = "\u{2028}"

    /// One piece of a paragraph as the block view lays it out: editable text
    /// between components, or a component card. `range` is in characters of
    /// the whole paragraph projection.
    public enum Segment: Equatable {
        case text(AttributedString, range: Range<Int>)
        case component(NoteComponent, offset: Int)
    }

    // MARK: Inline nodes → AttributedString

    public static func attributed(_ inline: [NoteNode]) -> AttributedString {
        var result = AttributedString()
        for node in inline {
            switch node.type {
            case .text:
                guard let text = node.text, !text.isEmpty else { continue }
                result += AttributedString(text, attributes: attributes(node.marks))
            case .hardBreak:
                var container = attributes(node.marks)
                container.noteHardBreak = true
                result += AttributedString(String(hardBreakCharacter), attributes: container)
            case .component:
                guard let component = node.attrs?.component else { continue }
                var container = attributes(node.marks)
                container.noteComponent = component
                result += AttributedString(String(componentCharacter), attributes: container)
            case .entity:
                guard let entity = node.attrs?.entity else { continue }
                var container = attributes(node.marks)
                container.noteEntity = entity
                result += AttributedString(entity.displayText, attributes: container)
            default:
                continue
            }
        }
        return result
    }

    public static func attributes(_ marks: [NoteMark]?) -> AttributeContainer {
        var container = AttributeContainer()
        for mark in marks ?? [] {
            switch mark.type {
            case .bold: container.noteBold = true
            case .italic: container.noteItalic = true
            case .underline: container.noteUnderline = true
            case .strike: container.noteStrike = true
            case .code: container.noteCode = true
            case .link: container.noteLink = mark.attrs ?? NoteAttributes()
            case .textStyle: container.noteTextStyle = mark.attrs ?? NoteAttributes()
            }
        }
        return container
    }

    // MARK: AttributedString → inline nodes

    /// Marks in the shared schema's order so re-projected text matches Tiptap's own output.
    public static func marks(_ attributes: AttributeContainer) -> [NoteMark]? {
        var marks: [NoteMark] = []
        if attributes.noteBold == true { marks.append(.bold) }
        if attributes.noteItalic == true { marks.append(.italic) }
        if attributes.noteStrike == true { marks.append(.strike) }
        if attributes.noteUnderline == true { marks.append(.underline) }
        if let link = attributes.noteLink { marks.append(NoteMark(type: .link, attrs: link)) }
        if attributes.noteCode == true { marks.append(.code) }
        if let style = attributes.noteTextStyle, !style.isEmpty || !style.nullFields.isEmpty { marks.append(NoteMark(type: .textStyle, attrs: style)) }
        return marks.isEmpty ? nil : marks
    }

    public static func inline(_ text: AttributedString) -> [NoteNode] {
        var nodes: [NoteNode] = []
        func appendText(_ string: String, marks: [NoteMark]?) {
            guard !string.isEmpty else { return }
            if let last = nodes.last, last.type == .text, last.marks == marks {
                nodes[nodes.count - 1].text = (last.text ?? "") + string
            } else {
                nodes.append(.text(string, marks: marks))
            }
        }
        for run in text.runs {
            let marks = marks(run.attributes)
            // Runs can end inside a grapheme cluster (a base letter and its combining
            // accent carrying different marks); read scalars so no mark moves.
            let string = scalars(text[run.range])
            if let component = run.noteComponent {
                for character in string {
                    if character == componentCharacter { nodes.append(.component(component, marks: marks)) }
                    else { appendText(String(character), marks: marks) }
                }
                continue
            }
            if let entity = run.noteEntity {
                var remainder = Substring(string)
                let display = entity.displayText
                while !display.isEmpty, remainder.hasPrefix(display) {
                    nodes.append(.entity(entity, marks: marks))
                    remainder = remainder.dropFirst(display.count)
                }
                appendText(String(remainder), marks: marks)
                continue
            }
            let hardBreak = run.noteHardBreak == true
            for character in string {
                if character == "\n" || (hardBreak && character == hardBreakCharacter) { nodes.append(.hardBreak(marks: marks)) }
                else { appendText(String(character), marks: marks) }
            }
        }
        return nodes
    }

    private static func scalars(_ slice: AttributedSubstring) -> String {
        var string = ""
        string.unicodeScalars.append(contentsOf: slice.unicodeScalars)
        return string
    }

    /// Enforce atom semantics after an edit: any entity or component run whose
    /// text was altered is removed entirely, as Tiptap deletes a whole atom.
    public static func reconciled(_ text: AttributedString) -> AttributedString {
        var result = AttributedString()
        var changed = false
        for run in text.runs {
            let slice = text[run.range]
            let string = scalars(slice)
            if let component = run.noteComponent {
                let expected = String(componentCharacter)
                if string == expected { result += AttributedString(slice) } else {
                    changed = true
                    _ = component
                }
                continue
            }
            if let entity = run.noteEntity {
                let display = entity.displayText
                let repeats = display.isEmpty ? false : string.count % display.count == 0 && string == String(repeating: display, count: string.count / display.count)
                if repeats { result += AttributedString(slice) } else { changed = true }
                continue
            }
            result += AttributedString(slice)
        }
        return changed ? result : text
    }

    // MARK: Segments and offsets

    public static func segments(_ text: AttributedString) -> [Segment] {
        var segments: [Segment] = []
        var pending = AttributedString()
        var pendingStart = 0
        var offset = 0
        var endsWithComponent = false
        for run in text.runs {
            let slice = text[run.range]
            let length = slice.characters.count
            if let component = run.noteComponent {
                if !pending.characters.isEmpty {
                    segments.append(.text(pending, range: pendingStart..<offset))
                    pending = AttributedString()
                }
                for index in 0..<length { segments.append(.component(component, offset: offset + index)) }
                offset += length
                pendingStart = offset
                endsWithComponent = true
            } else {
                pending += AttributedString(slice)
                offset += length
                endsWithComponent = false
            }
        }
        if !pending.characters.isEmpty || segments.isEmpty || endsWithComponent {
            segments.append(.text(pending, range: pendingStart..<offset))
        }
        return segments
    }

    public static func index(in text: AttributedString, offset: Int) -> AttributedString.Index {
        let clamped = min(max(offset, 0), text.characters.count)
        return text.characters.index(text.startIndex, offsetBy: clamped)
    }

    public static func offset(in text: AttributedString, of index: AttributedString.Index) -> Int {
        text.characters.distance(from: text.startIndex, to: index)
    }

    public static func split(_ inline: [NoteNode], at offset: Int) -> (before: [NoteNode], after: [NoteNode]) {
        let text = attributed(inline)
        let index = index(in: text, offset: offset)
        return (self.inline(AttributedString(text[text.startIndex..<index])), self.inline(AttributedString(text[index...])))
    }

    public static func replacing(_ inline: [NoteNode], characters range: Range<Int>, with replacement: AttributedString) -> [NoteNode] {
        var text = attributed(inline)
        let lower = index(in: text, offset: range.lowerBound)
        let upper = index(in: text, offset: range.upperBound)
        text.replaceSubrange(lower..<upper, with: replacement)
        return self.inline(reconciled(text))
    }

    public static func inserting(_ nodes: [NoteNode], into inline: [NoteNode], at offset: Int) -> [NoteNode] {
        replacing(inline, characters: offset..<offset, with: attributed(nodes))
    }

    public static func characterCount(_ inline: [NoteNode]) -> Int { attributed(inline).characters.count }

    /// Code blocks hold plain text only. Marks are dropped; hard breaks become newlines.
    public static func plainText(_ inline: [NoteNode]) -> String {
        inline.map { node in
            switch node.type {
            case .text: node.text ?? ""
            case .hardBreak: "\n"
            default: ""
            }
        }.joined()
    }

    // MARK: Marks on ranges

    public enum MarkState { case none, some, all }

    public static func state(of kind: NoteMark.Kind, in text: AttributedString, ranges: [Range<AttributedString.Index>]) -> MarkState {
        var seenOn = false, seenOff = false
        for range in ranges where !range.isEmpty {
            for run in text[range].runs {
                if has(kind, run.attributes) { seenOn = true } else { seenOff = true }
            }
        }
        if seenOn && !seenOff { return .all }
        return seenOn ? .some : .none
    }

    public static func has(_ kind: NoteMark.Kind, _ attributes: AttributeContainer) -> Bool {
        switch kind {
        case .bold: attributes.noteBold == true
        case .italic: attributes.noteItalic == true
        case .underline: attributes.noteUnderline == true
        case .strike: attributes.noteStrike == true
        case .code: attributes.noteCode == true
        case .link: attributes.noteLink != nil
        case .textStyle: attributes.noteTextStyle != nil
        }
    }

    /// Toggle a boolean mark over ranges: on unless every character already has it.
    public static func toggle(_ kind: NoteMark.Kind, in text: inout AttributedString, ranges: [Range<AttributedString.Index>]) {
        let enable = state(of: kind, in: text, ranges: ranges) != .all
        for range in ranges where !range.isEmpty { set(kind, enabled: enable, in: &text, range: range) }
    }

    public static func set(_ kind: NoteMark.Kind, enabled: Bool, in text: inout AttributedString, range: Range<AttributedString.Index>) {
        let value: Bool? = enabled ? true : nil
        switch kind {
        case .bold: text[range].noteBold = value
        case .italic: text[range].noteItalic = value
        case .underline: text[range].noteUnderline = value
        case .strike: text[range].noteStrike = value
        case .code: text[range].noteCode = value
        case .link, .textStyle: if !enabled { text[range].noteLink = nil; text[range].noteTextStyle = nil }
        }
    }

    public static func setLink(_ href: String?, in text: inout AttributedString, ranges: [Range<AttributedString.Index>]) {
        for range in ranges where !range.isEmpty {
            text[range].noteLink = href.map { NoteMark.link($0).attrs! }
        }
    }

    public static func updateTextStyle(in text: inout AttributedString, ranges: [Range<AttributedString.Index>], _ update: (inout NoteAttributes) -> Void) {
        for range in ranges where !range.isEmpty {
            for run in text[range].runs {
                var style = run.noteTextStyle ?? NoteMark.textStyle().attrs!
                update(&style)
                style.normalizeNulls()
                text[run.range].noteTextStyle = style.isEmpty ? nil : style
            }
        }
    }

    /// Block style changes clear inline font family/size, as `applyBlockStyle` does on the web.
    public static func clearingFonts(_ inline: [NoteNode]) -> [NoteNode] {
        inline.map { node in
            guard var marks = node.marks, let index = marks.firstIndex(where: { $0.type == .textStyle }) else { return node }
            var style = marks[index].attrs ?? NoteAttributes()
            style.fontFamily = nil
            style.fontSize = nil
            style.nullFields.formUnion(["fontFamily", "fontSize"])
            style.normalizeNulls()
            if style.isEmpty { marks.remove(at: index) } else { marks[index].attrs = style }
            var copy = node
            copy.marks = marks.isEmpty ? nil : marks
            return copy
        }
    }
}
