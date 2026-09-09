import Foundation

/// Validate the shared JSON contract before Codable can discard unknown fields.
/// This walks the decoder directly; it is not another persisted document model.
enum TiptapValidation {
    static let byteLimit = 16 * 1024 * 1024
    private static let textLimit = 4 * 1024 * 1024
    private struct Key: CodingKey {
        let stringValue: String
        let intValue: Int? = nil
        init(_ value: String) { stringValue = value }
        init?(stringValue: String) { self.init(stringValue) }
        init?(intValue: Int) { return nil }
    }
    private struct Object {
        let values: KeyedDecodingContainer<Key>
        init(_ decoder: Decoder, keys: Set<String>) throws {
            values = try decoder.container(keyedBy: Key.self)
            guard Set(values.allKeys.map(\.stringValue)).isSubset(of: keys) else { throw invalid("unknown fields") }
        }
        func has(_ key: String) -> Bool { values.contains(Key(key)) }
        func child(_ key: String) throws -> Decoder { try values.superDecoder(forKey: Key(key)) }
        func string(_ key: String, max: Int, required: Bool = false, nullable: Bool = false) throws -> String? {
            guard has(key) else { if required { throw invalid("missing \(key)") }; return nil }
            if nullable, try values.decodeNil(forKey: Key(key)) { return nil }
            let value = try values.decode(String.self, forKey: Key(key))
            guard value.utf16.count <= max else { throw invalid("\(key) is too long") }
            return value
        }
        func integer(_ key: String, range: ClosedRange<Int>, required: Bool = false) throws {
            guard has(key) else { if required { throw invalid("missing \(key)") }; return }
            guard range.contains(try values.decode(Int.self, forKey: Key(key))) else { throw invalid(key) }
        }
        func number(_ key: String, range: ClosedRange<Double>) throws {
            let number = try values.decode(Double.self, forKey: Key(key))
            guard number.isFinite, range.contains(number) else { throw invalid(key) }
        }
        func boolean(_ key: String) throws { _ = try values.decode(Bool.self, forKey: Key(key)) }
        func choice(_ key: String, _ choices: Set<String>, required: Bool = false, nullable: Bool = false) throws {
            if let value = try string(key, max: 128, required: required, nullable: nullable), !choices.contains(value) { throw invalid(key) }
        }
        func url(_ key: String, required: Bool = false, mail: Bool = false) throws {
            if let value = try string(key, max: 8192, required: required) { try validateURL(value, mail: mail) }
        }
    }
    private final class Budget {
        var nodes = 1
        var text = 0
        var componentIDs = Set<String>()
    }
    private static func invalid(_ detail: String) -> NoteDocument.DocumentError { .unsupportedContent(detail) }
    private static func matches(_ string: String, _ pattern: String) -> Bool { string.range(of: pattern, options: .regularExpression) != nil }

    static func validate(_ decoder: Decoder) throws {
        let root = try Object(decoder, keys: ["type", "content"])
        try root.choice("type", ["doc"], required: true)
        let budget = Budget()
        try children(root, allowed: blocks, minimum: 1, depth: 1, budget: budget)
    }

    private static let blocks: Set<String> = ["paragraph", "heading", "blockquote", "bulletList", "orderedList", "taskList", "codeBlock"]
    private static let inlines: Set<String> = ["text", "hardBreak", "component"]
    private static func children(_ object: Object, allowed: Set<String>, minimum: Int = 0, depth: Int, budget: Budget, plain: Bool = false, firstParagraph: Bool = false) throws {
        guard object.has("content") else { if minimum > 0 { throw invalid("missing children") }; return }
        var content = try object.child("content").unkeyedContainer()
        guard (content.count ?? 0) <= 20_000 else { throw invalid("too many children") }
        var count = 0
        while !content.isAtEnd {
            try node(content.superDecoder(), allowed: firstParagraph && count == 0 ? ["paragraph"] : allowed, depth: depth, budget: budget, plain: plain)
            count += 1
        }
        guard count >= minimum else { throw invalid("missing children") }
    }
    private static func node(_ decoder: Decoder, allowed: Set<String>, depth: Int, budget: Budget, plain: Bool = false) throws {
        budget.nodes += 1
        guard depth <= 32, budget.nodes <= 20_000 else { throw invalid("document exceeds node or depth limit") }
        let initial = try decoder.container(keyedBy: Key.self)
        let type = try initial.decode(String.self, forKey: Key("type"))
        guard allowed.contains(type) else { throw invalid("\(type) in the wrong position") }
        let keys: Set<String>
        switch type {
        case "text": keys = ["type", "text", "marks"]
        case "hardBreak": keys = ["type", "marks"]
        case "component": keys = ["type", "attrs", "marks"]
        case "paragraph", "heading", "codeBlock", "orderedList", "taskItem": keys = ["type", "attrs", "content"]
        default: keys = ["type", "content"]
        }
        let object = try Object(decoder, keys: keys)
        if object.has("marks") { try marks(object.child("marks"), plain: plain) }
        switch type {
        case "text":
            let text = try object.string("text", max: textLimit, required: true)!
            budget.text += text.utf16.count
            guard !text.isEmpty, budget.text <= textLimit else { throw invalid("text size") }
        case "hardBreak": break
        case "component":
            let attrs = try Object(object.child("attrs"), keys: ["component"])
            try component(attrs.child("component"), budget: budget)
        case "paragraph", "heading":
            if type == "heading" || object.has("attrs") {
                let attrs = try Object(object.child("attrs"), keys: type == "heading" ? ["level", "textAlign"] : ["textAlign"])
                if type == "heading" { try attrs.integer("level", range: 1...3, required: true) }
                try attrs.choice("textAlign", ["left", "center", "right", "justify"], nullable: true)
            }
            try children(object, allowed: inlines, depth: depth + 1, budget: budget)
        case "codeBlock":
            if object.has("attrs") { _ = try Object(object.child("attrs"), keys: ["language"]).string("language", max: 128, nullable: true) }
            try children(object, allowed: ["text"], depth: depth + 1, budget: budget, plain: true)
        case "orderedList":
            if object.has("attrs") {
                let attrs = try Object(object.child("attrs"), keys: ["start", "type"])
                try attrs.integer("start", range: 1...1_000_000)
                try attrs.choice("type", ["1"], nullable: true)
            }
            try children(object, allowed: ["listItem"], minimum: 1, depth: depth + 1, budget: budget)
        case "bulletList", "taskList":
            try children(object, allowed: [type == "taskList" ? "taskItem" : "listItem"], minimum: 1, depth: depth + 1, budget: budget)
        case "listItem", "taskItem":
            if type == "taskItem" { try Object(object.child("attrs"), keys: ["checked"]).boolean("checked") }
            try children(object, allowed: blocks, minimum: 1, depth: depth + 1, budget: budget, firstParagraph: true)
        default: try children(object, allowed: blocks, minimum: 1, depth: depth + 1, budget: budget)
        }
    }
    private static func marks(_ decoder: Decoder, plain: Bool) throws {
        var array = try decoder.unkeyedContainer()
        guard (array.count ?? 0) <= (plain ? 0 : 7) else { throw invalid("marks") }
        var seen = Set<String>()
        while !array.isAtEnd {
            let object = try Object(array.superDecoder(), keys: ["type", "attrs"])
            let type = try object.string("type", max: 32, required: true)!
            guard seen.insert(type).inserted else { throw invalid("duplicate marks") }
            switch type {
            case "bold", "italic", "underline", "strike", "code":
                if object.has("attrs") { _ = try Object(object.child("attrs"), keys: []) }
            case "link":
                let attrs = try Object(object.child("attrs"), keys: ["href", "target", "rel", "class", "title"])
                try attrs.url("href", required: true, mail: true)
                try attrs.choice("target", ["_blank", "_self"], nullable: true)
                if let rel = try attrs.string("rel", max: 128, nullable: true), !matches(rel, "^(?:(?:noopener|noreferrer|nofollow|ugc|sponsored)(?:\\s+|$))*$") { throw invalid("link rel") }
                if let name = try attrs.string("class", max: 256, nullable: true), !matches(name, "^[A-Za-z0-9_ \\-]*$") { throw invalid("link class") }
                _ = try attrs.string("title", max: 10_000, nullable: true)
            case "textStyle":
                let attrs = try Object(object.child("attrs"), keys: ["fontFamily", "fontSize", "color", "backgroundColor"])
                if let family = try attrs.string("fontFamily", max: 128, nullable: true), !matches(family, "^[\\p{L}\\p{N} ._+'\",\\-]+$") { throw invalid("font family") }
                if let size = try attrs.string("fontSize", max: 16, nullable: true) {
                    guard matches(size, "^[0-9]+(?:\\.[0-9]+)?px$"), let number = Double(size.dropLast(2)), (1...512).contains(number) else { throw invalid("font size") }
                }
                for key in ["color", "backgroundColor"] { if let value = try attrs.string(key, max: 100, nullable: true) { try color(value) } }
            default: throw invalid("unknown mark")
            }
        }
    }
    private static func validateURL(_ value: String, mail: Bool = false) throws {
        guard value.utf16.count <= 8192, matches(value, "^[^\\x00-\\x20\\x7f]+$"), let url = URLComponents(string: value), url.user == nil, url.password == nil else { throw invalid("unsafe URL") }
        if mail, url.scheme?.lowercased() == "mailto" { return }
        guard matches(value, "(?i)^https?://"), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), !(url.host ?? "").isEmpty else { throw invalid("expected HTTP(S) URL") }
    }
    private static func color(_ value: String) throws {
        let names: Set<String> = ["black", "silver", "gray", "white", "maroon", "red", "purple", "fuchsia", "green", "lime", "olive", "yellow", "navy", "blue", "teal", "aqua", "transparent"]
        if names.contains(value) || matches(value, "^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$") { return }
        let channel = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])"
        if value.count <= 80, matches(value, "(?i)^rgb\\(\\s*\(channel)\\s*,\\s*\(channel)\\s*,\\s*\(channel)\\s*\\)$") { return }
        if matches(value, "(?i)^rgba\\(\\s*\(channel)\\s*,\\s*\(channel)\\s*,\\s*\(channel)\\s*,\\s*(?:0(?:\\.[0-9]+)?|1(?:\\.0+)?)\\s*\\)$") { return }
        throw invalid("color")
    }
    private static func component(_ decoder: Decoder, budget: Budget) throws {
        let object = try Object(decoder, keys: ["id", "kind", "title", "source", "svg", "drawing", "metadata"])
        let id = try identifier(object)
        guard budget.componentIDs.insert(id).inserted, budget.componentIDs.count <= 1_000 else { throw invalid("duplicate or too many components") }
        try object.choice("kind", ["diagram", "mermaid", "drawing", "link"], required: true)
        _ = try object.string("title", max: 10_000, required: true)
        let source = try object.string("source", max: 200_000, required: true)!
        if try object.string("kind", max: 32) == "link", !source.isEmpty { try validateURL(source) }
        _ = try object.string("svg", max: 8 * 1024 * 1024)
        if object.has("drawing") { try drawing(object.child("drawing")) }
        if object.has("metadata") {
            let metadata = try Object(object.child("metadata"), keys: ["title", "summary", "imageURL", "playback", "discoveryNote"])
            _ = try metadata.string("title", max: 10_000, required: true)
            _ = try metadata.string("summary", max: 100_000)
            _ = try metadata.string("discoveryNote", max: 10_000)
            try metadata.url("imageURL")
            if metadata.has("playback") {
                let playback = try Object(metadata.child("playback"), keys: ["type", "url"])
                try playback.choice("type", ["directVideo", "embedURL"], required: true)
                try playback.url("url", required: true)
            }
        }
    }
    private static func identifier(_ object: Object) throws -> String {
        let id = try object.string("id", max: 36, required: true)!
        guard matches(id, "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$") else { throw invalid("identifier") }
        return id.lowercased()
    }
    private static func drawing(_ decoder: Decoder) throws {
        let object = try Object(decoder, keys: ["elements"])
        var elements = try object.child("elements").unkeyedContainer()
        guard (elements.count ?? 0) <= 2_000 else { throw invalid("too many drawing elements") }
        var ids = Set<String>()
        var pointCount = 0
        while !elements.isAtEnd {
            let element = try Object(elements.superDecoder(), keys: ["id", "kind", "ink", "points", "text", "lineWidth"])
            guard try ids.insert(identifier(element)).inserted else { throw invalid("duplicate drawing elements") }
            try element.choice("kind", ["pen", "rectangle", "ellipse", "arrow", "text"], required: true)
            try element.choice("ink", ["graphite", "blue", "purple", "orange", "green", "red"], required: true)
            _ = try element.string("text", max: 100_000, required: true)
            try element.number("lineWidth", range: 0.1...100)
            var points = try element.child("points").unkeyedContainer()
            while !points.isAtEnd {
                pointCount += 1
                guard pointCount <= 100_000 else { throw invalid("too many drawing points") }
                let point = try Object(points.superDecoder(), keys: ["x", "y"])
                try point.number("x", range: -100_000...100_000)
                try point.number("y", range: -100_000...100_000)
            }
        }
    }
}
