import AppKit

struct PortableText: Codable, Equatable {
    struct Marks: Codable, Equatable {
        var bold: Bool?; var italic: Bool?; var underline: Bool?; var strike: Bool?
        var inlineCode: Bool?; var link: String?
    }
    struct Paragraph: Codable, Equatable {
        enum Kind: String, Codable { case paragraph, heading1, heading2, heading3, quote }
        enum Alignment: String, Codable { case left, center, right, justified }
        struct List: Codable, Equatable {
            enum Kind: String, Codable { case bullet, numbered, task }
            var path: [Kind]
            var checked: Bool?
            /// Displayed item number, not an opaque native list-object identity.
            var start: Int?
        }
        var kind: Kind = .paragraph
        var list: List?
        var alignment: Alignment?
    }
    var text: String
    var marks: Marks?
    var fontSize: Double?
    var fontFamily: String?
    var foreground: String?
    var background: String?
    var paragraph: Paragraph?
}

extension NSAttributedString.Key {
    static let portableBlockKind = NSAttributedString.Key("dev.rawkode.block-kind")
    static let portableInlineCode = NSAttributedString.Key("dev.rawkode.inline-code")
    static let portableBold = NSAttributedString.Key("dev.rawkode.inline-bold")
    static let portableItalic = NSAttributedString.Key("dev.rawkode.inline-italic")
    static let emptyCode = NSAttributedString.Key("dev.rawkode.empty-code")
}

@MainActor
enum PortableTextAdapter {
    private static let marker = try! NSRegularExpression(pattern: "^\\t(☐|☑|[•◦▪]|[0-9]+\\.)\\t")

    static func isParagraphSeparator(_ char: unichar) -> Bool { [10, 13, 0x2029].contains(char) }

    static func segments(from value: NSAttributedString) throws -> [NoteDocument.Segment] {
        var result: [NoteDocument.Segment] = []
        var lastCodeIdentity: String?
        let source = value.string as NSString
        var paragraphStart = 0
        while paragraphStart < value.length {
            let paragraphRange = source.paragraphRange(for: NSRange(location: paragraphStart, length: 0))
            let end = NSMaxRange(paragraphRange)
            let firstAttributes = value.attributes(at: paragraphStart, effectiveRange: nil)
            var paragraph = try paragraphMetadata(firstAttributes)
            var contentStart = paragraphStart
            if var list = paragraph.list,
               let match = marker.firstMatch(in: source.substring(with: paragraphRange), range: NSRange(location: 0, length: paragraphRange.length)) {
                let token = source.substring(with: NSRange(location: paragraphStart + match.range(at: 1).location, length: match.range(at: 1).length))
                let actual: PortableText.Paragraph.List.Kind = token == "☐" || token == "☑" ? .task : token.hasSuffix(".") ? .numbered : .bullet
                guard list.path.last == actual else { throw NoteDocument.DocumentError.unsupportedContent("inconsistent list marker") }
                guard actual != .bullet || token == "•" else { throw NoteDocument.DocumentError.unsupportedContent("nonstandard bullet glyph") }
                list.checked = actual == .task ? token == "☑" : nil
                list.start = actual == .numbered ? Int(token.dropLast()) : nil
                paragraph.list = list
                contentStart += match.range.length
            } else if paragraph.list != nil {
                // Partial clipboard selections may begin inside a list item.
                // Keep that text literal instead of inventing a new marker.
                paragraph.list = nil
            }
            if contentStart == end {
                result.append(.text(try portableText("", attributes: firstAttributes, paragraph: paragraph)))
            }
            var position = contentStart
            while position < end {
                var effective = NSRange()
                let attributes = value.attributes(at: position, effectiveRange: &effective)
                let range = NSRange(location: position, length: min(NSMaxRange(effective), end) - position)
                if let attachment = attributes[.attachment] {
                    guard let attachment = attachment as? ComponentAttachment else { throw NoteDocument.DocumentError.unsupportedContent("native attachment") }
                    guard source.substring(with: range).allSatisfy({ $0 == "\u{fffc}" }) else { throw NoteDocument.DocumentError.unsupportedContent("attachment applied to ordinary text") }
                    for _ in 0..<range.length { result.append(.component(attachment.component)) }
                } else if let language = attributes[.codeLanguage] as? String {
                    let body = source.substring(with: range)
                    let code = attributes[.emptyCode] as? Bool == true && body == "\n" ? "" : body
                    let identity = attributes[.codeBlockID] as? String
                    if case .code(let previousLanguage, let previousSource) = result.last, previousLanguage == language, identity == lastCodeIdentity {
                        result[result.count - 1] = .code(language: language, source: previousSource + code)
                    } else { result.append(.code(language: language, source: code)) }
                    lastCodeIdentity = identity
                } else {
                    result.append(.text(try portableText(source.substring(with: range), attributes: attributes, paragraph: paragraph)))
                }
                position = NSMaxRange(range)
            }
            paragraphStart = end
        }
        return result
    }

    private static func paragraphMetadata(_ attributes: [NSAttributedString.Key: Any]) throws -> PortableText.Paragraph {
        let style = attributes[.paragraphStyle] as? NSParagraphStyle ?? .default
        guard style.textBlocks.isEmpty else { throw NoteDocument.DocumentError.unsupportedContent("native text table") }
        var result = PortableText.Paragraph()
        if let semantic = attributes[.portableBlockKind] as? String, let kind = PortableText.Paragraph.Kind(rawValue: semantic) { result.kind = kind }
        if !style.textLists.isEmpty {
            let supported: [NSTextList.MarkerFormat] = [.disc, .box, .check, .init(rawValue: "{decimal}.")]
            guard style.textLists.allSatisfy({ supported.contains($0.markerFormat) }) else { throw NoteDocument.DocumentError.unsupportedContent("native list marker style") }
            result.list = .init(path: style.textLists.map { $0.isOrdered ? .numbered : ($0.markerFormat == .box || $0.markerFormat == .check ? .task : .bullet) })
        }
        switch style.alignment {
        case .center: result.alignment = .center
        case .right: result.alignment = .right
        case .justified: result.alignment = .justified
        default: break
        }
        return result
    }

    private static func portableText(_ text: String, attributes: [NSAttributedString.Key: Any], paragraph: PortableText.Paragraph) throws -> PortableText {
        for key: NSAttributedString.Key in [.superscript, .baselineOffset, .kern, .strokeWidth, .shadow, .obliqueness, .expansion] {
            if let value = attributes[key], (value as? NSNumber)?.doubleValue != 0 { throw NoteDocument.DocumentError.unsupportedContent(key.rawValue) }
        }
        for key: NSAttributedString.Key in [.underlineStyle, .strikethroughStyle] {
            if let value = attributes[key] as? Int, ![0, NSUnderlineStyle.single.rawValue].contains(value) { throw NoteDocument.DocumentError.unsupportedContent("non-single \(key.rawValue)") }
        }
        let font = attributes[.font] as? NSFont ?? .systemFont(ofSize: 17)
        let traits = NSFontManager.shared.traits(of: font)
        var marks = PortableText.Marks()
        marks.bold = (attributes[.portableBold] as? Bool ?? traits.contains(.boldFontMask)) ? true : nil
        marks.italic = (attributes[.portableItalic] as? Bool ?? traits.contains(.italicFontMask)) ? true : nil
        marks.underline = ((attributes[.underlineStyle] as? Int) ?? 0) != 0 ? true : nil
        marks.strike = ((attributes[.strikethroughStyle] as? Int) ?? 0) != 0 ? true : nil
        marks.inlineCode = attributes[.portableInlineCode] as? Bool == true ? true : nil
        if let url = attributes[.link] as? URL { marks.link = url.absoluteString }
        else { marks.link = attributes[.link] as? String }
        let family = font.familyName ?? "system-ui"
        return PortableText(text: text, marks: marks == .init() ? nil : marks, fontSize: font.pointSize,
                            fontFamily: family.hasPrefix(".") ? "system-ui" : family,
                            foreground: color(attributes[.foregroundColor] as? NSColor),
                            background: color(attributes[.backgroundColor] as? NSColor), paragraph: paragraph)
    }

    private static func color(_ value: NSColor?) -> String? {
        guard let value else { return nil }
        if value == .textColor { return "text" }
        if value == .secondaryLabelColor { return "secondary" }
        if value == .quaternaryLabelColor { return "muted" }
        guard let rgb = value.usingColorSpace(.sRGB) else { return nil }
        return String(format: "#%02X%02X%02X%02X", Int(round(rgb.redComponent * 255)), Int(round(rgb.greenComponent * 255)), Int(round(rgb.blueComponent * 255)), Int(round(rgb.alphaComponent * 255)))
    }

    private static func nativeColor(_ value: String?) throws -> NSColor? {
        guard let value else { return nil }
        switch value {
        case "text": return .textColor
        case "secondary": return .secondaryLabelColor
        case "muted": return .quaternaryLabelColor
        default:
            guard value.hasPrefix("#"), [7, 9].contains(value.count), let hex = UInt64(value.dropFirst(), radix: 16) else { throw NoteDocument.DocumentError.unsupportedContent("invalid color") }
            let rgba = value.count == 7 ? hex << 8 | 255 : hex
            return NSColor(srgbRed: Double((rgba >> 24) & 255) / 255, green: Double((rgba >> 16) & 255) / 255, blue: Double((rgba >> 8) & 255) / 255, alpha: Double(rgba & 255) / 255)
        }
    }

    static func project(_ run: PortableText, startsParagraph: Bool) throws -> NSAttributedString {
        // The portable contract also permits one run spanning several equally
        // styled paragraphs. Project each marker while preserving separators.
        let source = run.text as NSString
        if source.length > 0, NSMaxRange(source.paragraphRange(for: NSRange(location: 0, length: 0))) < source.length {
            let result = NSMutableAttributedString(string: "")
            var position = 0
            while position < source.length {
                let range = source.paragraphRange(for: NSRange(location: position, length: 0))
                var part = run
                part.text = source.substring(with: range)
                result.append(try project(part, startsParagraph: position == 0 ? startsParagraph : true))
                position = NSMaxRange(range)
            }
            return result
        }
        let paragraph = run.paragraph ?? .init()
        if let list = paragraph.list {
            guard !list.path.isEmpty, list.path.count <= 6, (list.start ?? 1) > 0 else { throw NoteDocument.DocumentError.unsupportedContent("invalid list") }
        }
        let size = run.fontSize ?? (paragraph.kind == .heading1 ? 32 : paragraph.kind == .heading2 ? 25 : paragraph.kind == .heading3 ? 20 : 17)
        guard size.isFinite, size > 0, size <= 512 else { throw NoteDocument.DocumentError.unsupportedContent("invalid font size") }
        let weight: NSFont.Weight = paragraph.kind == .heading1 ? .bold : [.heading2, .heading3].contains(paragraph.kind) ? .semibold : .regular
        var font = (run.fontFamily == "system-ui" ? nil : run.fontFamily.flatMap { NSFont(name: $0, size: size) }) ?? NSFont.systemFont(ofSize: size, weight: weight)
        if run.marks?.inlineCode == true { font = .monospacedSystemFont(ofSize: size, weight: .regular) }
        if run.marks?.bold == true { font = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask) }
        if run.marks?.italic == true { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
        let style = (EditorSession.bodyAttributes[.paragraphStyle] as! NSParagraphStyle).mutableCopy() as! NSMutableParagraphStyle
        if paragraph.kind == .quote { style.headIndent = 24; style.firstLineHeadIndent = 24 }
        switch paragraph.alignment {
        case .center: style.alignment = .center
        case .right: style.alignment = .right
        case .justified: style.alignment = .justified
        default: style.alignment = .left
        }
        if let list = paragraph.list {
            style.textLists = list.path.map { kind in NSTextList(markerFormat: kind == .numbered ? .init(rawValue: "{decimal}.") : kind == .task ? .box : .disc, options: 0) }
            let depth = CGFloat(list.path.count)
            style.firstLineHeadIndent = max(0, depth - 1) * 28; style.headIndent = depth * 28
            style.tabStops = [NSTextTab(textAlignment: .left, location: depth * 28 - 18), NSTextTab(textAlignment: .left, location: depth * 28)]
            style.defaultTabInterval = 28; style.paragraphSpacing = 5
        }
        var attributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: style, .portableBlockKind: paragraph.kind.rawValue,
                                                       .portableBold: run.marks?.bold == true, .portableItalic: run.marks?.italic == true]
        attributes[.foregroundColor] = try nativeColor(run.foreground) ?? .textColor
        attributes[.backgroundColor] = try nativeColor(run.background)
        if run.marks?.underline == true { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        if run.marks?.strike == true { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        if run.marks?.inlineCode == true { attributes[.portableInlineCode] = true }
        if let link = run.marks?.link { attributes[.link] = link }
        var text = run.text
        if startsParagraph, let list = paragraph.list, let kind = list.path.last {
            let marker = kind == .numbered ? "\(list.start ?? 1)." : kind == .task ? (list.checked == true ? "☑" : "☐") : "•"
            text = "\t\(marker)\t" + text
        }
        return NSAttributedString(string: text, attributes: attributes)
    }
}
