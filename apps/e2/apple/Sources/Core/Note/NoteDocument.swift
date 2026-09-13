import Foundation

/// The canonical Tiptap/ProseMirror JSON tree shared with the web editor
/// (`packages/documents/src/note.ts`). Swift never persists another shape:
/// decoding validates the exact contract, editing mutates this value, and
/// encoding writes the same tree back.
public struct NoteDocument: Codable, Equatable, Hashable, Sendable {
    public var content: [NoteNode]

    public enum FormatError: LocalizedError, Equatable {
        case unsupportedContent(String)
        public var errorDescription: String? {
            switch self { case .unsupportedContent(let detail): "Unsupported note content: \(detail)." }
        }
    }

    private enum Keys: String, CodingKey { case type, content }

    public init(content: [NoteNode] = [.paragraph()]) {
        self.content = content.isEmpty ? [.paragraph()] : content
    }

    public init(from decoder: Decoder) throws {
        try NoteValidation.validate(decoder)
        let container = try decoder.container(keyedBy: Keys.self)
        guard try container.decode(String.self, forKey: .type) == "doc" else {
            throw FormatError.unsupportedContent("expected a Tiptap document")
        }
        content = try container.decode([NoteNode].self, forKey: .content)
        guard !content.isEmpty else { throw FormatError.unsupportedContent("document needs a paragraph") }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode("doc", forKey: .type)
        try container.encode(content, forKey: .content)
    }

    public static func decode(_ data: Data) throws -> NoteDocument {
        guard data.count <= NoteValidation.byteLimit else { throw FormatError.unsupportedContent("file exceeds 16 MiB") }
        return try JSONDecoder().decode(NoteDocument.self, from: data)
    }

    /// Encode, then prove the result still satisfies the shared contract.
    public func encoded() throws -> Data {
        let data = try JSONEncoder().encode(self)
        _ = try Self.decode(data)
        return data
    }

    /// The JSON object form used by the document API envelope (`{ note, expectedRevision }`).
    public func jsonObject() throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: encoded()) as? [String: Any] else {
            throw FormatError.unsupportedContent("document did not encode to an object")
        }
        return object
    }

    public var descendants: [NoteNode] { content.flatMap { [$0] + $0.descendants } }
    public var components: [NoteComponent] { descendants.compactMap { $0.type == .component ? $0.attrs?.component : nil } }
    public var entities: [EntityReference] { descendants.compactMap { $0.type == .entity ? $0.attrs?.entity : nil } }
    /// Block text joined by newlines: previews and search, never a storage format.
    public var plainText: String { content.map(\.plainText).joined(separator: "\n") }
}

public struct NoteNode: Codable, Equatable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable, CaseIterable {
        case paragraph, heading, blockquote, bulletList, orderedList, listItem, taskList, taskItem, codeBlock
        case text, hardBreak, component, entity

        public var isTextBlock: Bool { self == .paragraph || self == .heading || self == .codeBlock }
        public var isInline: Bool { self == .text || self == .hardBreak || self == .component || self == .entity }
        public var isList: Bool { self == .bulletList || self == .orderedList || self == .taskList }
        public var isListItem: Bool { self == .listItem || self == .taskItem }
        /// An inline node that is not text: one indivisible unit in the editor.
        public var isAtom: Bool { self == .component || self == .entity }
    }

    public var type: Kind
    public var attrs: NoteAttributes?
    public var content: [NoteNode]?
    public var text: String?
    public var marks: [NoteMark]?

    public init(type: Kind, attrs: NoteAttributes? = nil, content: [NoteNode]? = nil, text: String? = nil, marks: [NoteMark]? = nil) {
        self.type = type; self.attrs = attrs; self.content = content; self.text = text; self.marks = marks
    }

    public var descendants: [NoteNode] { (content ?? []).flatMap { [$0] + $0.descendants } }
    public var children: [NoteNode] { content ?? [] }
    public func hasMark(_ kind: NoteMark.Kind) -> Bool { marks?.contains { $0.type == kind } == true }
    public func mark(_ kind: NoteMark.Kind) -> NoteMark? { marks?.first { $0.type == kind } }
    public var isEmptyTextBlock: Bool { type.isTextBlock && (content ?? []).isEmpty }
    public var containsAtom: Bool { (content ?? []).contains { $0.type.isAtom } }

    public var plainText: String {
        switch type {
        case .text: return text ?? ""
        case .hardBreak: return "\n"
        case .component: return attrs?.component?.title ?? ""
        case .entity: return attrs?.entity?.displayText ?? ""
        case .paragraph, .heading, .codeBlock: return children.map(\.plainText).joined()
        default: return children.map(\.plainText).joined(separator: "\n")
        }
    }
}

// MARK: - Constructors matching Tiptap's default attributes

public extension NoteNode {
    static func text(_ text: String, marks: [NoteMark]? = nil) -> NoteNode {
        NoteNode(type: .text, text: text, marks: marks?.isEmpty == true ? nil : marks)
    }
    static func hardBreak(marks: [NoteMark]? = nil) -> NoteNode { NoteNode(type: .hardBreak, marks: marks?.isEmpty == true ? nil : marks) }
    static func component(_ component: NoteComponent, marks: [NoteMark]? = nil) -> NoteNode {
        NoteNode(type: .component, attrs: NoteAttributes(component: component), marks: marks?.isEmpty == true ? nil : marks)
    }
    static func entity(_ entity: EntityReference, marks: [NoteMark]? = nil) -> NoteNode {
        NoteNode(type: .entity, attrs: NoteAttributes(entity: entity), marks: marks?.isEmpty == true ? nil : marks)
    }
    static func paragraph(_ inline: [NoteNode] = [], textAlign: String? = nil) -> NoteNode {
        var attrs = NoteAttributes(textAlign: textAlign)
        if textAlign == nil { attrs.nullFields = ["textAlign"] }
        return NoteNode(type: .paragraph, attrs: attrs, content: inline.isEmpty ? nil : inline)
    }
    static func heading(_ level: Int, _ inline: [NoteNode] = [], textAlign: String? = nil) -> NoteNode {
        var attrs = NoteAttributes(level: min(max(level, 1), 3), textAlign: textAlign)
        if textAlign == nil { attrs.nullFields = ["textAlign"] }
        return NoteNode(type: .heading, attrs: attrs, content: inline.isEmpty ? nil : inline)
    }
    static func codeBlock(language: String? = nil, _ text: String = "") -> NoteNode {
        var attrs = NoteAttributes(language: language)
        if language == nil { attrs.nullFields = ["language"] }
        return NoteNode(type: .codeBlock, attrs: attrs, content: text.isEmpty ? nil : [.text(text)])
    }
    static func blockquote(_ blocks: [NoteNode]) -> NoteNode { NoteNode(type: .blockquote, content: blocks.isEmpty ? [.paragraph()] : blocks) }
    static func listItem(_ blocks: [NoteNode]) -> NoteNode { NoteNode(type: .listItem, content: blocks.isEmpty ? [.paragraph()] : blocks) }
    static func taskItem(checked: Bool = false, _ blocks: [NoteNode]) -> NoteNode {
        NoteNode(type: .taskItem, attrs: NoteAttributes(checked: checked), content: blocks.isEmpty ? [.paragraph()] : blocks)
    }
    static func bulletList(_ items: [NoteNode]) -> NoteNode { NoteNode(type: .bulletList, content: items) }
    static func orderedList(_ items: [NoteNode], start: Int? = nil) -> NoteNode {
        var attrs = NoteAttributes(start: start ?? 1)
        attrs.nullFields = ["type"]
        return NoteNode(type: .orderedList, attrs: attrs, content: items)
    }
    static func taskList(_ items: [NoteNode]) -> NoteNode { NoteNode(type: .taskList, content: items) }

    /// The list kind whose items this node holds, or the list kind an item belongs to.
    static func listKind(forItem item: Kind) -> Kind { item == .taskItem ? .taskList : .bulletList }
    static func itemKind(forList list: Kind) -> Kind { list == .taskList ? .taskItem : .listItem }
}

public struct NoteMark: Codable, Equatable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable, CaseIterable { case bold, italic, underline, strike, code, link, textStyle }
    public var type: Kind
    public var attrs: NoteAttributes?
    public init(type: Kind, attrs: NoteAttributes? = nil) { self.type = type; self.attrs = attrs }

    public static let bold = NoteMark(type: .bold)
    public static let italic = NoteMark(type: .italic)
    public static let underline = NoteMark(type: .underline)
    public static let strike = NoteMark(type: .strike)
    public static let code = NoteMark(type: .code)
    /// A link with Tiptap's configured defaults for the attributes it always writes.
    public static func link(_ href: String, title: String? = nil) -> NoteMark {
        var attrs = NoteAttributes(href: href, target: "_blank", rel: "noopener noreferrer nofollow", title: title)
        attrs.nullFields = title == nil ? ["class", "title"] : ["class"]
        return NoteMark(type: .link, attrs: attrs)
    }
    public static func textStyle(fontFamily: String? = nil, fontSize: String? = nil, color: String? = nil, backgroundColor: String? = nil) -> NoteMark {
        var attrs = NoteAttributes(fontFamily: fontFamily, fontSize: fontSize, color: color, backgroundColor: backgroundColor)
        attrs.nullFields = Set([("fontFamily", fontFamily), ("fontSize", fontSize), ("color", color), ("backgroundColor", backgroundColor)]
            .filter { $0.1 == nil }.map(\.0))
        return NoteMark(type: .textStyle, attrs: attrs)
    }
}

/// Every attribute any node or mark can carry. Absent keys are omitted;
/// keys the web wrote as explicit `null` are retained in `nullFields` so an
/// untouched node re-encodes byte-for-byte as Tiptap wrote it.
public struct NoteAttributes: Codable, Equatable, Hashable, Sendable {
    public var level: Int?
    public var textAlign: String?
    public var start: Int?
    public var type: String?
    public var checked: Bool?
    public var language: String?
    public var component: NoteComponent?
    public var entity: EntityReference?
    public var fontFamily: String?
    public var fontSize: String?
    public var color: String?
    public var backgroundColor: String?
    public var href: String?
    public var target: String?
    public var rel: String?
    public var `class`: String?
    public var title: String?
    public var nullFields: Set<String> = []

    public init(level: Int? = nil, textAlign: String? = nil, start: Int? = nil, type: String? = nil, checked: Bool? = nil, language: String? = nil,
                component: NoteComponent? = nil, entity: EntityReference? = nil, fontFamily: String? = nil, fontSize: String? = nil,
                color: String? = nil, backgroundColor: String? = nil, href: String? = nil, target: String? = nil, rel: String? = nil,
                class: String? = nil, title: String? = nil, nullFields: Set<String> = []) {
        self.level = level; self.textAlign = textAlign; self.start = start; self.type = type; self.checked = checked; self.language = language
        self.component = component; self.entity = entity; self.fontFamily = fontFamily; self.fontSize = fontSize; self.color = color
        self.backgroundColor = backgroundColor; self.href = href; self.target = target; self.rel = rel; self.class = `class`; self.title = title
        self.nullFields = nullFields
    }

    private enum Key: String, CodingKey {
        case level, textAlign, start, type, checked, language, component, entity, fontFamily, fontSize, color, backgroundColor, href, target, rel, `class`, title
    }
    private static var strings: [(Key, WritableKeyPath<NoteAttributes, String?>)] {
        [(.textAlign, \.textAlign), (.type, \.type), (.language, \.language), (.fontFamily, \.fontFamily), (.fontSize, \.fontSize),
         (.color, \.color), (.backgroundColor, \.backgroundColor), (.href, \.href), (.target, \.target), (.rel, \.rel), (.class, \.class), (.title, \.title)]
    }

    public init(from decoder: Decoder) throws {
        self.init()
        let container = try decoder.container(keyedBy: Key.self)
        level = try container.decodeIfPresent(Int.self, forKey: .level)
        start = try container.decodeIfPresent(Int.self, forKey: .start)
        checked = try container.decodeIfPresent(Bool.self, forKey: .checked)
        component = try container.decodeIfPresent(NoteComponent.self, forKey: .component)
        entity = try container.decodeIfPresent(EntityReference.self, forKey: .entity)
        for (key, path) in Self.strings {
            self[keyPath: path] = try container.decodeIfPresent(String.self, forKey: key)
            if container.contains(key), try container.decodeNil(forKey: key) { nullFields.insert(key.rawValue) }
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        try container.encodeIfPresent(level, forKey: .level)
        try container.encodeIfPresent(start, forKey: .start)
        try container.encodeIfPresent(checked, forKey: .checked)
        try container.encodeIfPresent(component, forKey: .component)
        try container.encodeIfPresent(entity, forKey: .entity)
        for (key, path) in Self.strings {
            if let value = self[keyPath: path] { try container.encode(value, forKey: key) }
            else if nullFields.contains(key.rawValue) { try container.encodeNil(forKey: key) }
        }
    }

    /// Drop null markers for keys that now carry a value.
    public mutating func normalizeNulls() {
        let present = Set(Self.strings.filter { self[keyPath: $0.1] != nil }.map(\.0.rawValue))
        nullFields.subtract(present)
        if level != nil { nullFields.remove("level") }
        if start != nil { nullFields.remove("start") }
        if checked != nil { nullFields.remove("checked") }
    }

    /// True when nothing but explicit nulls remain.
    public var isEmpty: Bool {
        level == nil && start == nil && checked == nil && component == nil && entity == nil
            && Self.strings.allSatisfy { self[keyPath: $0.1] == nil }
    }
}

// MARK: - Components

public struct NoteComponent: Codable, Equatable, Hashable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable, CaseIterable { case diagram, mermaid, drawing, link }
    /// Lower-case UUID text, exactly as the web writes it. Never re-cased.
    public var id: String
    public var kind: Kind
    public var title: String
    public var source: String
    public var svg: String?
    public var drawing: DrawingDocument?
    public var metadata: LinkMetadata?

    public init(id: String = NoteIdentifier.new(), kind: Kind, title: String, source: String = "", svg: String? = nil,
                drawing: DrawingDocument? = nil, metadata: LinkMetadata? = nil) {
        self.id = id; self.kind = kind; self.title = title; self.source = source; self.svg = svg; self.drawing = drawing; self.metadata = metadata
    }

    /// The same starting content `website/src/lib/component.ts` inserts from the slash menu.
    public static func `default`(_ kind: Kind) -> NoteComponent {
        switch kind {
        case .diagram: NoteComponent(kind: kind, title: "D2 diagram", source: "direction: right\nIdea -> Note: write\nNote -> Diagram: visualize")
        case .mermaid: NoteComponent(kind: kind, title: "Mermaid diagram", source: "flowchart LR\n  Idea --> Note\n  Note --> Diagram")
        case .drawing: NoteComponent(kind: kind, title: "Drawing", drawing: DrawingDocument())
        case .link: NoteComponent(kind: kind, title: "Link")
        }
    }

    public var sourceURL: URL? { kind == .link ? NoteValidation.httpURL(source) : nil }
}

public enum NoteIdentifier {
    public static func new() -> String { UUID().uuidString.lowercased() }
    public static func isValid(_ value: String) -> Bool {
        value.range(of: "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$", options: .regularExpression) != nil
    }
}

public struct DrawingDocument: Codable, Equatable, Hashable, Sendable {
    public static let worldWidth: Double = 900
    public static let worldHeight: Double = 420
    public var elements: [DrawingElement]
    public init(elements: [DrawingElement] = []) { self.elements = elements }
}

public struct DrawingPoint: Codable, Equatable, Hashable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

public enum DrawingInk: String, Codable, Sendable, CaseIterable, Identifiable {
    case graphite, blue, purple, orange, green, red
    public var id: String { rawValue }
    public var label: String { rawValue.capitalized }
    /// The web palette from `website/src/lib/component.ts`.
    public var hex: UInt32 {
        switch self {
        case .graphite: 0x20242b
        case .blue: 0x1766bd
        case .purple: 0x8544b5
        case .orange: 0xb65e08
        case .green: 0x25763f
        case .red: 0xc23435
        }
    }
}

public struct DrawingElement: Codable, Equatable, Hashable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable, CaseIterable { case pen, rectangle, ellipse, arrow, text }
    public var id: String
    public var kind: Kind
    public var ink: DrawingInk
    public var points: [DrawingPoint]
    public var text: String
    public var lineWidth: Double

    public init(id: String = NoteIdentifier.new(), kind: Kind, ink: DrawingInk = .graphite, points: [DrawingPoint], text: String = "", lineWidth: Double = 3) {
        self.id = id; self.kind = kind; self.ink = ink; self.points = points; self.text = text; self.lineWidth = lineWidth
    }

    /// Axis-aligned bounds in world units: (minX, minY, width, height).
    public var bounds: (x: Double, y: Double, width: Double, height: Double) {
        guard let first = points.first else { return (0, 0, 0, 0) }
        if kind == .text { return (first.x, first.y, max(36, Double(text.count) * 12), 30) }
        let xs = points.map(\.x), ys = points.map(\.y)
        return (xs.min()!, ys.min()!, xs.max()! - xs.min()!, ys.max()! - ys.min()!)
    }

    public func moved(dx: Double, dy: Double) -> DrawingElement {
        let box = bounds
        let cx = min(max(dx, -box.x), DrawingDocument.worldWidth - (box.x + box.width))
        let cy = min(max(dy, -box.y), DrawingDocument.worldHeight - (box.y + box.height))
        var copy = self
        copy.points = points.map { DrawingPoint(x: $0.x + cx, y: $0.y + cy) }
        return copy
    }
}

public struct LinkMetadata: Codable, Equatable, Hashable, Sendable {
    public enum Playback: Codable, Equatable, Hashable, Sendable {
        case directVideo(String)
        case embedURL(String)

        private enum Keys: String, CodingKey { case type, url }
        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: Keys.self)
            let url = try container.decode(String.self, forKey: .url)
            switch try container.decode(String.self, forKey: .type) {
            case "directVideo": self = .directVideo(url)
            case "embedURL": self = .embedURL(url)
            default: throw NoteDocument.FormatError.unsupportedContent("playback type")
            }
        }
        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: Keys.self)
            switch self {
            case .directVideo(let url): try container.encode("directVideo", forKey: .type); try container.encode(url, forKey: .url)
            case .embedURL(let url): try container.encode("embedURL", forKey: .type); try container.encode(url, forKey: .url)
            }
        }
        public var url: String { switch self { case .directVideo(let url), .embedURL(let url): url } }
    }

    public var title: String
    public var summary: String?
    public var imageURL: String?
    public var playback: Playback?
    public var discoveryNote: String?

    public init(title: String, summary: String? = nil, imageURL: String? = nil, playback: Playback? = nil, discoveryNote: String? = nil) {
        self.title = title; self.summary = summary; self.imageURL = imageURL; self.playback = playback; self.discoveryNote = discoveryNote
    }
}

// MARK: - Entities

/// An `@` mention or `#` link. Provider references are the legacy Google/GitHub
/// shape; canonical references point at workspace entities by UUID.
public enum EntityReference: Codable, Equatable, Hashable, Sendable {
    case provider(ProviderEntity)
    case canonical(CanonicalEntity)

    public struct ProviderEntity: Codable, Equatable, Hashable, Sendable {
        public var provider: String
        public var kind: String
        public var id: String
        public var label: String
        public var avatarURL: String?
        public var meta: String?
        public init(provider: String, kind: String, id: String, label: String, avatarURL: String? = nil, meta: String? = nil) {
            self.provider = provider; self.kind = kind; self.id = id; self.label = label; self.avatarURL = avatarURL; self.meta = meta
        }
    }

    public struct CanonicalEntity: Codable, Equatable, Hashable, Sendable {
        public enum Presentation: String, Codable, Sendable { case link, mention }
        public var version: Int = 1
        public var entityId: String
        public var fallbackLabel: String
        public var displayText: String
        public var presentation: Presentation
        public init(entityId: String, fallbackLabel: String, displayText: String? = nil, presentation: Presentation) {
            self.entityId = entityId; self.fallbackLabel = fallbackLabel; self.displayText = displayText ?? fallbackLabel; self.presentation = presentation
        }
    }

    private struct Probe: Decodable { let version: Int? }

    public init(from decoder: Decoder) throws {
        if try Probe(from: decoder).version != nil { self = .canonical(try CanonicalEntity(from: decoder)) }
        else { self = .provider(try ProviderEntity(from: decoder)) }
    }
    public func encode(to encoder: Encoder) throws {
        switch self {
        case .provider(let entity): try entity.encode(to: encoder)
        case .canonical(let entity): try entity.encode(to: encoder)
        }
    }

    /// The text the web renders, including the `@` prefix for mentions.
    public var displayText: String {
        switch self {
        case .provider(let entity): "@" + entity.label
        case .canonical(let entity): (entity.presentation == .link ? "" : "@") + entity.displayText
        }
    }
    public var canonicalID: String? { if case .canonical(let entity) = self { entity.entityId } else { nil } }

    /// The reference the shared composer writes for a chosen search result.
    public static func canonical(id: String, label: String, trigger: Character, selectedText: String? = nil) -> EntityReference {
        .canonical(CanonicalEntity(entityId: id, fallbackLabel: label, displayText: selectedText ?? label, presentation: trigger == "@" ? .mention : .link))
    }
}
