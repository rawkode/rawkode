import AppKit

/// The canonical document is the same Tiptap JSON tree used by the Vue editor.
struct NoteDocument: Codable, Equatable {
    let type = "doc"
    var content: [EditorNode]

    enum DocumentError: LocalizedError {
        case unsupportedContent(String)
        var errorDescription: String? {
            switch self { case .unsupportedContent(let detail): return "Unsupported note content: \(detail)." }
        }
    }

    private enum Keys: String, CodingKey { case type, content }
    init(content: [EditorNode] = [.init(type: .paragraph)]) { self.content = content.isEmpty ? [.init(type: .paragraph)] : content }
    init(from decoder: Decoder) throws {
        try TiptapValidation.validate(decoder)
        let container = try decoder.container(keyedBy: Keys.self)
        guard try container.decode(String.self, forKey: .type) == "doc" else { throw DocumentError.unsupportedContent("expected a Tiptap document") }
        content = try container.decode([EditorNode].self, forKey: .content)
        guard !content.isEmpty else { throw DocumentError.unsupportedContent("document needs a paragraph") }
    }

    static func decode(_ data: Data) throws -> NoteDocument {
        guard data.count <= TiptapValidation.byteLimit else { throw DocumentError.unsupportedContent("file exceeds 16 MiB") }
        return try JSONDecoder().decode(NoteDocument.self, from: data)
    }

    private func validate() throws { _ = try Self.decode(JSONEncoder().encode(self)) }
    @MainActor init(attributedString: NSAttributedString) throws {
        content = try NativeDocumentBridge.read(attributedString)
        try validate()
    }
    @MainActor func attributedString() throws -> NSAttributedString {
        try validate()
        return try NativeDocumentBridge.project(content)
    }

    var descendants: [EditorNode] { content.flatMap { [$0] + $0.descendants } }
    var components: [Component] { descendants.compactMap { $0.type == .component ? $0.attrs?.component : nil } }
    var codeBlocks: [EditorNode] { descendants.filter { $0.type == .codeBlock } }
    var textNodes: [EditorNode] { descendants.filter { $0.type == .text } }
}

struct EditorNode: Codable, Equatable {
    enum Kind: String, Codable { case paragraph, heading, blockquote, bulletList, orderedList, listItem, taskList, taskItem, codeBlock, text, hardBreak, component, entity }
    var type: Kind
    var attrs: EditorAttributes?
    var content: [EditorNode]?
    var text: String?
    var marks: [EditorMark]?

    var descendants: [EditorNode] { (content ?? []).flatMap { [$0] + $0.descendants } }
    var textContent: String { text ?? (content ?? []).map(\.textContent).joined() }
    func hasMark(_ kind: EditorMark.Kind) -> Bool { marks?.contains { $0.type == kind } == true }

}

struct EntityReference: Codable, Equatable {
    var provider: String
    var kind: String
    var id: String
    var label: String
    var avatarURL: URL?
    var meta: String?
}

struct EditorAttributes: Codable, Equatable {
    var level: Int?
    var textAlign: String?
    var start: Int?
    var type: String?
    var checked: Bool?
    var language: String?
    var component: Component?
    var entity: EntityReference?
    var fontFamily: String?
    var fontSize: String?
    var color: String?
    var backgroundColor: String?
    var href: String?
    var target: String?
    var rel: String?
    var `class`: String?
    var title: String?
    // In Tiptap, explicit null can override a non-null extension default.
    var nullFields: Set<String> = []
}

extension EditorAttributes {
    private enum Key: String, CodingKey {
        case level, textAlign, start, type, checked, language, component, entity, fontFamily, fontSize, color, backgroundColor, href, target, rel, `class`, title
    }
    private static let strings: [(Key, WritableKeyPath<EditorAttributes, String?>)] = [
        (.textAlign, \.textAlign), (.type, \.type), (.language, \.language), (.fontFamily, \.fontFamily), (.fontSize, \.fontSize),
        (.color, \.color), (.backgroundColor, \.backgroundColor), (.href, \.href), (.target, \.target), (.rel, \.rel), (.class, \.class), (.title, \.title),
    ]
    init(from decoder: Decoder) throws {
        self.init()
        let container = try decoder.container(keyedBy: Key.self)
        level = try container.decodeIfPresent(Int.self, forKey: .level)
        start = try container.decodeIfPresent(Int.self, forKey: .start)
        checked = try container.decodeIfPresent(Bool.self, forKey: .checked)
        component = try container.decodeIfPresent(Component.self, forKey: .component)
        entity = try container.decodeIfPresent(EntityReference.self, forKey: .entity)
        for (key, path) in Self.strings {
            self[keyPath: path] = try container.decodeIfPresent(String.self, forKey: key)
            if container.contains(key), try container.decodeNil(forKey: key) { nullFields.insert(key.rawValue) }
        }
    }
    func encode(to encoder: Encoder) throws {
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
}

struct EditorMark: Codable, Equatable {
    enum Kind: String, Codable { case bold, italic, underline, strike, code, link, textStyle }
    var type: Kind
    var attrs: EditorAttributes?
}
