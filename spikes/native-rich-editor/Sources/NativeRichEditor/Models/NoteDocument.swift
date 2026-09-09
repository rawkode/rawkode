import AppKit

/// The serializable document boundary. Views and text-system objects never cross it.
struct NoteDocument: Codable, Equatable {
    let version = 2
    var segments: [Segment]

    enum Segment: Equatable {
        case text(PortableText)
        case component(Component)
        case code(language: String, source: String)
    }

    enum DocumentError: LocalizedError {
        case unsupportedVersion(Int), unsupportedContent(String)
        var errorDescription: String? {
            switch self {
            case .unsupportedVersion(let version): return "Note version \(version) is not supported. The original file was not changed."
            case .unsupportedContent(let detail): return "This note contains unsupported content (\(detail)); it cannot be saved losslessly."
            }
        }
    }

    private enum Keys: String, CodingKey { case version, segments }
    init(segments: [Segment]) { self.segments = segments }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let version = try container.decode(Int.self, forKey: .version)
        guard version == 2 else { throw DocumentError.unsupportedVersion(version) }
        segments = try container.decode([Segment].self, forKey: .segments)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(version, forKey: .version)
        try container.encode(segments, forKey: .segments)
    }

    @MainActor
    init(attributedString: NSAttributedString) throws { segments = try PortableTextAdapter.segments(from: attributedString) }

    @MainActor
    func attributedString() throws -> NSAttributedString {
        let result = NSMutableAttributedString(string: "")
        for segment in segments {
            switch segment {
            case .text(let text):
                let startsParagraph = result.length == 0 || PortableTextAdapter.isParagraphSeparator((result.string as NSString).character(at: result.length - 1))
                result.append(try PortableTextAdapter.project(text, startsParagraph: startsParagraph))
            case .component(let component):
                result.append(NSAttributedString(attachment: ComponentAttachment(component)))
            case .code(let language, let source):
                result.append(CodeBlockStyle.attributed(source, language: language))
            }
        }
        return result
    }
}

extension NoteDocument.Segment: Codable {
    private enum Keys: String, CodingKey { case type, component, language, source }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "text": self = .text(try PortableText(from: decoder))
        case "component": self = .component(try container.decode(Component.self, forKey: .component))
        case "code": self = .code(language: try container.decode(String.self, forKey: .language), source: try container.decode(String.self, forKey: .source))
        default: throw NoteDocument.DocumentError.unsupportedContent("unknown segment type")
        }
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        switch self {
        case .text(let text):
            try container.encode("text", forKey: .type)
            try text.encode(to: encoder)
        case .component(let component):
            try container.encode("component", forKey: .type)
            try container.encode(component, forKey: .component)
        case .code(let language, let source):
            try container.encode("code", forKey: .type)
            try container.encode(language, forKey: .language)
            try container.encode(source, forKey: .source)
        }
    }
}
