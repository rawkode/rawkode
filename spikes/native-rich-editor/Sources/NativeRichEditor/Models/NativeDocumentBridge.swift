import AppKit

enum NativeBlockKind: String { case paragraph, heading1, heading2, heading3, quote }

extension NSAttributedString.Key {
    static let nativeBlockKind = NSAttributedString.Key("dev.rawkode.block-kind")
    static let nativeInlineCode = NSAttributedString.Key("dev.rawkode.inline-code")
    static let nativeBold = NSAttributedString.Key("dev.rawkode.inline-bold")
    static let nativeItalic = NSAttributedString.Key("dev.rawkode.inline-italic")
    static let emptyCode = NSAttributedString.Key("dev.rawkode.empty-code")
    static let nativeTreeContext = NSAttributedString.Key("dev.rawkode.tree-context")
    static let nativeBlockSeparator = NSAttributedString.Key("dev.rawkode.block-separator")
    static let nativeFollowingBlock = NSAttributedString.Key("dev.rawkode.following-block")
    static let nativeInlineState = NSAttributedString.Key("dev.rawkode.inline-state")
    static let nativeLiteralSeparator = NSAttributedString.Key("dev.rawkode.literal-separator")
    static let nativeEmptyBlock = NSAttributedString.Key("dev.rawkode.empty-block")
}

/// These identities exist only in the NSTextView projection. They let ordinary
/// text edits retain imported quote/list ancestry and multi-paragraph list items.
private struct NativeAncestor {
    let id = UUID()
    var type: EditorNode.Kind
    var attrs: EditorAttributes?
}

private final class NativeBlockContext: NSObject {
    let ancestors: [NativeAncestor]
    let kind: NativeBlockKind
    let attrs: EditorAttributes?
    init(_ ancestors: [NativeAncestor], kind: NativeBlockKind, attrs: EditorAttributes?) {
        self.ancestors = ancestors; self.kind = kind; self.attrs = attrs
    }
}

private final class NativeInlineState: NSObject {
    let marks: [EditorMark]
    let font: NSFont
    let foreground: NSColor?
    let background: NSColor?
    init(marks: [EditorMark], attributes: [NSAttributedString.Key: Any]) {
        self.marks = marks
        font = attributes[.font] as! NSFont
        foreground = attributes[.foregroundColor] as? NSColor
        background = attributes[.backgroundColor] as? NSColor
    }
}

@MainActor
enum NativeDocumentBridge {
    private static let markerPattern = try! NSRegularExpression(pattern: "^\\t(☐|☑|•|[0-9]+\\.)\\t")
    private struct Leaf { var node: EditorNode; var ancestors: [NativeAncestor]; var marker: String? }

    static func project(_ nodes: [EditorNode]) throws -> NSAttributedString {
        var leaves: [Leaf] = []
        func walk(_ node: EditorNode, ancestors: [NativeAncestor], marker: String? = nil) {
            switch node.type {
            case .paragraph, .heading, .codeBlock: leaves.append(Leaf(node: node, ancestors: ancestors, marker: marker))
            case .blockquote:
                let path = ancestors + [NativeAncestor(type: .blockquote, attrs: node.attrs)]
                for child in node.content ?? [] { walk(child, ancestors: path) }
            case .bulletList, .orderedList, .taskList:
                let list = NativeAncestor(type: node.type, attrs: node.attrs)
                for (index, item) in (node.content ?? []).enumerated() {
                    let path = ancestors + [list, NativeAncestor(type: item.type, attrs: item.attrs)]
                    let token = node.type == .orderedList ? "\((node.attrs?.start ?? 1) + index)." : node.type == .taskList ? (item.attrs?.checked == true ? "☑" : "☐") : "•"
                    for (childIndex, child) in (item.content ?? []).enumerated() { walk(child, ancestors: path, marker: childIndex == 0 ? "\t\(token)\t" : nil) }
                }
            default: break
            }
        }
        for node in nodes { walk(node, ancestors: []) }
        let result = NSMutableAttributedString(string: "")
        let contexts = leaves.map { leaf in NativeBlockContext(leaf.ancestors, kind: kind(for: leaf.node, ancestors: leaf.ancestors), attrs: leaf.node.attrs) }
        for (index, leaf) in leaves.enumerated() {
            let context = contexts[index]
            var base = baseAttributes(kind: context.kind, alignment: leaf.node.attrs?.textAlign)
            base[.nativeTreeContext] = context
            if let marker = leaf.marker {
                let lists = leaf.ancestors.filter { [.bulletList, .orderedList, .taskList].contains($0.type) }
                let style = (base[.paragraphStyle] as! NSParagraphStyle).mutableCopy() as! NSMutableParagraphStyle
                style.textLists = lists.map { NSTextList(markerFormat: $0.type == .orderedList ? .init(rawValue: "{decimal}.") : $0.type == .taskList ? .box : .disc, options: 0) }
                let depth = CGFloat(lists.count)
                style.firstLineHeadIndent = max(0, depth - 1) * 28; style.headIndent = depth * 28
                style.tabStops = [NSTextTab(textAlignment: .left, location: depth * 28 - 18), NSTextTab(textAlignment: .left, location: depth * 28)]
                style.defaultTabInterval = 28; style.paragraphSpacing = 5
                base[.paragraphStyle] = style
                result.append(NSAttributedString(string: marker, attributes: base))
            }
            if leaf.node.type == .codeBlock {
                let code = NSMutableAttributedString(attributedString: CodeBlockStyle.attributed(leaf.node.textContent, language: leaf.node.attrs?.language ?? ""))
                code.addAttribute(.nativeTreeContext, value: context, range: NSRange(location: 0, length: code.length))
                result.append(code)
            } else {
                for inline in leaf.node.content ?? [] {
                    var attributes = try inlineAttributes(inline.marks ?? [], base: base)
                    attributes[.nativeInlineState] = NativeInlineState(marks: inline.marks ?? [], attributes: attributes)
                    switch inline.type {
                    case .text:
                        let part = NSMutableAttributedString(string: inline.text ?? "", attributes: attributes)
                        let source = part.string as NSString
                        for offset in 0..<source.length where [10, 13, 0x2028, 0x2029].contains(Int(source.character(at: offset))) {
                            part.addAttribute(.nativeLiteralSeparator, value: true, range: NSRange(location: offset, length: 1))
                        }
                        result.append(part)
                    case .hardBreak: result.append(NSAttributedString(string: "\u{2028}", attributes: attributes))
                    case .component:
                        let part = NSMutableAttributedString(attachment: ComponentAttachment(inline.attrs!.component!))
                        part.addAttributes(attributes, range: NSRange(location: 0, length: part.length))
                        result.append(part)
                    default: break
                    }
                }
            }
            if index < leaves.count - 1 {
                base[.nativeBlockSeparator] = true
                base[.nativeFollowingBlock] = contexts[index + 1]
                result.append(NSAttributedString(string: "\n", attributes: base))
            } else if result.length == 0, leaf.node.type != .paragraph || !leaf.ancestors.isEmpty || leaf.node.attrs != nil {
                // A zero-length attributed string cannot carry block attributes.
                // This invisible projection-only placeholder is never serialized.
                base[.nativeEmptyBlock] = true
                result.append(NSAttributedString(string: "\u{200b}", attributes: base))
            }
        }
        return result
    }

    private static func kind(for node: EditorNode, ancestors: [NativeAncestor]) -> NativeBlockKind {
        if node.type == .heading { return NativeBlockKind(rawValue: "heading\(node.attrs?.level ?? 1)") ?? .heading1 }
        return ancestors.contains { $0.type == .blockquote } ? .quote : .paragraph
    }

    /// Builder references mirror the canonical tree, never a second file format.
    private final class Builder {
        var node: EditorNode
        var identity: UUID?
        var children: [Builder] = []
        init(_ node: EditorNode, identity: UUID? = nil) { self.node = node; self.identity = identity }
        var value: EditorNode {
            var value = node
            if !children.isEmpty { value.content = children.map(\.value) }
            return value
        }
    }

    static func read(_ value: NSAttributedString) throws -> [EditorNode] {
        let root = Builder(.init(type: .paragraph))
        let source = value.string as NSString
        var position = 0
        var inline: [EditorNode] = []
        var paragraphAttributes: [NSAttributedString.Key: Any] = [:]
        var hasParagraph = false
        var afterCode = false
        var trailingBoundary = false
        var following: NativeBlockContext?
        var previousListPath: [EditorNode.Kind] = []
        var previousListFrames: [NativeAncestor] = []
        var quoteFrame: NativeAncestor?

        func append(_ node: EditorNode, ancestors: [NativeAncestor]) {
            var parent = root
            for frame in ancestors {
                if let last = parent.children.last, last.identity == frame.id { parent = last }
                else {
                    let next = Builder(.init(type: frame.type, attrs: frame.attrs), identity: frame.id)
                    parent.children.append(next); parent = next
                }
            }
            if [.listItem, .taskItem].contains(parent.node.type), parent.children.isEmpty, node.type != .paragraph { parent.children.append(Builder(.init(type: .paragraph))) }
            parent.children.append(Builder(node))
        }

        func listFrames(path: [EditorNode.Kind], number: Int, checked: Bool) -> [NativeAncestor] {
            var frames: [NativeAncestor] = []
            for depth in path.indices {
                let matches = previousListPath.count > depth && Array(previousListPath.prefix(depth + 1)) == Array(path.prefix(depth + 1))
                let list = matches ? previousListFrames[depth * 2] : NativeAncestor(type: path[depth], attrs: path[depth] == .orderedList ? .init(start: number) : nil)
                let item = matches && depth < path.count - 1 ? previousListFrames[depth * 2 + 1] : NativeAncestor(type: path[depth] == .taskList ? .taskItem : .listItem, attrs: path[depth] == .taskList ? .init(checked: checked) : nil)
                frames += [list, item]
            }
            previousListPath = path; previousListFrames = frames
            return frames
        }

        var currentMarker: (path: [EditorNode.Kind], number: Int, checked: Bool)?
        func flush(force: Bool = false) {
            guard hasParagraph || force else { return }
            let context = paragraphAttributes[.nativeTreeContext] as? NativeBlockContext
            let blockKind = (paragraphAttributes[.nativeBlockKind] as? String).flatMap(NativeBlockKind.init(rawValue:)) ?? context?.kind ?? .paragraph
            let level = Int(blockKind.rawValue.replacingOccurrences(of: "heading", with: ""))
            let style = paragraphAttributes[.paragraphStyle] as? NSParagraphStyle
            var attrs = EditorAttributes(level: level)
            if context?.attrs?.nullFields.contains("textAlign") == true { attrs.nullFields.insert("textAlign") }
            switch style?.alignment {
            case .left: attrs.textAlign = "left"
            case .center: attrs.textAlign = "center"
            case .right: attrs.textAlign = "right"
            case .justified: attrs.textAlign = "justify"
            default: break
            }
            var frames = context?.ancestors ?? []
            if let marker = currentMarker {
                if frames.filter({ [.bulletList, .orderedList, .taskList].contains($0.type) }).map(\.type) != marker.path { frames = listFrames(path: marker.path, number: marker.number, checked: marker.checked) }
                else if let last = frames.last, last.type == .taskItem { frames[frames.count - 1].attrs?.checked = marker.checked }
            } else if frames.isEmpty { previousListPath = []; previousListFrames = [] }
            if blockKind == .quote, !frames.contains(where: { $0.type == .blockquote }) {
                if quoteFrame == nil { quoteFrame = NativeAncestor(type: .blockquote) }
                frames.insert(quoteFrame!, at: 0)
            } else if blockKind != .quote { quoteFrame = nil }
            append(.init(type: level == nil ? .paragraph : .heading, attrs: attrs == .init() ? nil : attrs, content: inline.isEmpty ? nil : inline), ancestors: frames)
            inline = []; paragraphAttributes = [:]; hasParagraph = false; currentMarker = nil
        }

        while position < value.length {
            let attributes = value.attributes(at: position, effectiveRange: nil)
            let char = source.character(at: position)
            if attributes[.nativeBlockSeparator] as? Bool == true, char == 10 {
                if !hasParagraph { paragraphAttributes = attributes }
                flush(force: !afterCode)
                following = attributes[.nativeFollowingBlock] as? NativeBlockContext
                position += 1; trailingBoundary = true; afterCode = false
                continue
            }
            if let language = attributes[.codeLanguage] as? String, attributes[.attachment] == nil {
                flush()
                let identity = attributes[.codeBlockID] as? String
                var end = position
                while end < value.length {
                    let next = value.attributes(at: end, effectiveRange: nil)
                    guard next[.attachment] == nil, next[.nativeBlockSeparator] as? Bool != true,
                          next[.codeLanguage] as? String == language, next[.codeBlockID] as? String == identity else { break }
                    end += 1
                }
                let raw = source.substring(with: NSRange(location: position, length: end - position))
                let code = attributes[.emptyCode] as? Bool == true && raw == "\n" ? "" : raw
                let context = attributes[.nativeTreeContext] as? NativeBlockContext
                let codeAttrs = (context?.attrs?.language ?? "") == language ? context?.attrs ?? (language.isEmpty ? nil : .init(language: language)) : .init(language: language)
                append(.init(type: .codeBlock, attrs: codeAttrs, content: code.isEmpty ? nil : [.init(type: .text, text: code)]), ancestors: context?.ancestors ?? [])
                position = end; afterCode = true; trailingBoundary = false
                continue
            }
            let literalSeparator = attributes[.nativeLiteralSeparator] as? Bool == true
            if !literalSeparator && (char == 10 || char == 13 || char == 0x2029) {
                if !afterCode {
                    if !hasParagraph { paragraphAttributes = attributes }
                    flush(force: true)
                }
                if char == 13, position + 1 < value.length, source.character(at: position + 1) == 10 { position += 1 }
                position += 1; trailingBoundary = true; afterCode = false; following = nil
                continue
            }
            if !hasParagraph {
                paragraphAttributes = attributes; hasParagraph = true
                let style = attributes[.paragraphStyle] as? NSParagraphStyle
                if let lists = style?.textLists, !lists.isEmpty {
                    let range = source.paragraphRange(for: NSRange(location: position, length: 0))
                    let rest = source.substring(with: NSRange(location: position, length: NSMaxRange(range) - position))
                    if let match = markerPattern.firstMatch(in: rest, range: NSRange(location: 0, length: (rest as NSString).length)) {
                        let token = (rest as NSString).substring(with: match.range(at: 1))
                        currentMarker = (lists.map { $0.isOrdered ? .orderedList : $0.markerFormat == .box || $0.markerFormat == .check ? .taskList : .bulletList }, Int(token.dropLast()) ?? 1, token == "☑")
                        position += match.range.length
                        continue
                    }
                }
            }
            if char == 0x200b, attributes[.nativeEmptyBlock] as? Bool == true {
                position += 1; trailingBoundary = false; afterCode = false
                continue
            }
            let marks = try readMarks(attributes, kind: (paragraphAttributes[.nativeBlockKind] as? String).flatMap(NativeBlockKind.init(rawValue:)) ?? .paragraph)
            if let attachment = attributes[.attachment] {
                guard let component = attachment as? ComponentAttachment, char == 0xfffc else { throw NoteDocument.DocumentError.unsupportedContent("native attachment") }
                inline.append(.init(type: .component, attrs: .init(component: component.component), marks: marks.isEmpty ? nil : marks))
                position += 1
            } else if char == 0x2028 && !literalSeparator {
                inline.append(.init(type: .hardBreak, marks: marks.isEmpty ? nil : marks)); position += 1
            } else {
                // A grapheme can span separately styled text nodes. Consume one
                // Unicode scalar, not the whole combining/ZWJ character sequence.
                let length = (0xd800...0xdbff).contains(char) ? 2 : 1
                guard position + length <= source.length,
                      !(0xdc00...0xdfff).contains(char),
                      length == 1 || (0xdc00...0xdfff).contains(source.character(at: position + 1)) else {
                    throw NoteDocument.DocumentError.unsupportedContent("invalid Unicode text")
                }
                let range = NSRange(location: position, length: length)
                let text = source.substring(with: range)
                if let last = inline.last, last.type == .text, (last.marks ?? []) == marks { inline[inline.count - 1].text! += text }
                else { inline.append(.init(type: .text, text: text, marks: marks.isEmpty ? nil : marks)) }
                position = NSMaxRange(range)
            }
            trailingBoundary = false; afterCode = false
        }
        flush()
        if trailingBoundary {
            if let following {
                paragraphAttributes = baseAttributes(kind: following.kind, alignment: following.attrs?.textAlign)
                paragraphAttributes[.nativeTreeContext] = following
            }
            flush(force: true)
        }
        return root.children.isEmpty ? [.init(type: .paragraph)] : root.children.map(\.value)
    }

    private static func baseAttributes(kind: NativeBlockKind, alignment: String? = nil) -> [NSAttributedString.Key: Any] {
        let size: CGFloat = kind == .heading1 ? 32 : kind == .heading2 ? 25 : kind == .heading3 ? 20 : 17
        let weight: NSFont.Weight = kind == .heading1 ? .bold : [.heading2, .heading3].contains(kind) ? .semibold : .regular
        let style = (EditorSession.bodyAttributes[.paragraphStyle] as! NSParagraphStyle).mutableCopy() as! NSMutableParagraphStyle
        if kind == .quote { style.headIndent = 24; style.firstLineHeadIndent = 24 }
        switch alignment { case "left": style.alignment = .left; case "center": style.alignment = .center; case "right": style.alignment = .right; case "justify": style.alignment = .justified; default: break }
        return [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: NSColor.textColor, .paragraphStyle: style,
                .nativeBlockKind: kind.rawValue, .nativeBold: false, .nativeItalic: false]
    }

    private static func inlineAttributes(_ marks: [EditorMark], base: [NSAttributedString.Key: Any]) throws -> [NSAttributedString.Key: Any] {
        var attributes = base
        var font = base[.font] as! NSFont
        if let style = marks.first(where: { $0.type == .textStyle })?.attrs {
            let size = style.fontSize.flatMap { Double($0.replacingOccurrences(of: "px", with: "")) } ?? font.pointSize
            guard size > 0, size <= 512 else { throw NoteDocument.DocumentError.unsupportedContent("font size") }
            font = style.fontFamily.flatMap { NSFont(name: $0, size: size) } ?? NSFontManager.shared.convert(font, toSize: size)
            if let color = style.color { attributes[.foregroundColor] = try nativeColor(color) }
            if let background = style.backgroundColor { attributes[.backgroundColor] = try nativeColor(background) }
        }
        if marks.contains(where: { $0.type == .code }) { font = .monospacedSystemFont(ofSize: font.pointSize, weight: .regular); attributes[.nativeInlineCode] = true }
        if marks.contains(where: { $0.type == .bold }) { font = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask); attributes[.nativeBold] = true }
        if marks.contains(where: { $0.type == .italic }) { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask); attributes[.nativeItalic] = true }
        if marks.contains(where: { $0.type == .underline }) { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        if marks.contains(where: { $0.type == .strike }) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        if let link = marks.first(where: { $0.type == .link })?.attrs?.href { attributes[.link] = link }
        attributes[.font] = font
        return attributes
    }

    private static func readMarks(_ attributes: [NSAttributedString.Key: Any], kind: NativeBlockKind) throws -> [EditorMark] {
        if let style = attributes[.paragraphStyle] as? NSParagraphStyle, !style.textBlocks.isEmpty { throw NoteDocument.DocumentError.unsupportedContent("native text table") }
        for key: NSAttributedString.Key in [.superscript, .baselineOffset, .kern, .strokeWidth, .shadow, .obliqueness, .expansion] {
            if let value = attributes[key], (value as? NSNumber)?.doubleValue != 0 { throw NoteDocument.DocumentError.unsupportedContent(key.rawValue) }
        }
        let font = attributes[.font] as? NSFont ?? .systemFont(ofSize: 17)
        let traits = NSFontManager.shared.traits(of: font)
        let state = attributes[.nativeInlineState] as? NativeInlineState
        var marks: [EditorMark] = []
        if attributes[.nativeBold] as? Bool ?? traits.contains(.boldFontMask) { marks.append(.init(type: .bold)) }
        if attributes[.nativeItalic] as? Bool ?? traits.contains(.italicFontMask) { marks.append(.init(type: .italic)) }
        for (key, mark): (NSAttributedString.Key, EditorMark.Kind) in [(.underlineStyle, .underline), (.strikethroughStyle, .strike)] {
            let value = attributes[key] as? Int ?? 0
            guard [0, NSUnderlineStyle.single.rawValue].contains(value) else { throw NoteDocument.DocumentError.unsupportedContent(key.rawValue) }
            if value != 0 { marks.append(.init(type: mark)) }
        }
        if attributes[.nativeInlineCode] as? Bool == true { marks.append(.init(type: .code)) }
        if let link = (attributes[.link] as? URL)?.absoluteString ?? attributes[.link] as? String {
            var attrs = state?.marks.first(where: { $0.type == .link })?.attrs ?? .init()
            attrs.href = link; marks.append(.init(type: .link, attrs: attrs))
        }
        var style = state?.marks.first(where: { $0.type == .textStyle })?.attrs ?? .init()
        let defaultFont = baseAttributes(kind: kind)[.font] as! NSFont
        if state?.font != font {
            style.fontSize = font.pointSize == defaultFont.pointSize ? nil : "\(Double(font.pointSize))px"
            let family = font.familyName ?? ""
            style.fontFamily = family.hasPrefix(".") || family.isEmpty ? nil : family
        }
        let foreground = attributes[.foregroundColor] as? NSColor
        if state?.foreground != foreground { style.color = color(foreground, foreground: true) }
        let background = attributes[.backgroundColor] as? NSColor
        if state?.background != background { style.backgroundColor = color(background, foreground: false) }
        if style != .init() || state?.marks.contains(where: { $0.type == .textStyle }) == true { marks.append(.init(type: .textStyle, attrs: style)) }
        return marks
    }

    private static func color(_ value: NSColor?, foreground: Bool) -> String? {
        guard let value, !(foreground && (value == .textColor || value == .secondaryLabelColor)), let rgb = value.usingColorSpace(.sRGB) else { return nil }
        return String(format: "#%02X%02X%02X%02X", Int(round(rgb.redComponent * 255)), Int(round(rgb.greenComponent * 255)), Int(round(rgb.blueComponent * 255)), Int(round(rgb.alphaComponent * 255)))
    }

    private static func nativeColor(_ value: String) throws -> NSColor {
        let names = ["black": "#000000", "silver": "#c0c0c0", "gray": "#808080", "white": "#ffffff", "maroon": "#800000", "red": "#ff0000", "purple": "#800080", "fuchsia": "#ff00ff", "green": "#008000", "lime": "#00ff00", "olive": "#808000", "yellow": "#ffff00", "navy": "#000080", "blue": "#0000ff", "teal": "#008080", "aqua": "#00ffff", "transparent": "#00000000"]
        let text = names[value.lowercased()] ?? value
        if text.hasPrefix("#") {
            var hex = String(text.dropFirst())
            if hex.count == 3 || hex.count == 4 { hex = hex.map { "\($0)\($0)" }.joined() }
            if hex.count == 6 { hex += "ff" }
            if hex.count == 8, let rgba = UInt64(hex, radix: 16) { return NSColor(srgbRed: Double((rgba >> 24) & 255) / 255, green: Double((rgba >> 16) & 255) / 255, blue: Double((rgba >> 8) & 255) / 255, alpha: Double(rgba & 255) / 255) }
        }
        if text.lowercased().hasPrefix("rgb"), let open = text.firstIndex(of: "("), text.hasSuffix(")") {
            let channels = text[text.index(after: open)..<text.index(before: text.endIndex)].split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            if channels.count == 3 || channels.count == 4 { return NSColor(srgbRed: channels[0] / 255, green: channels[1] / 255, blue: channels[2] / 255, alpha: channels.count == 4 ? channels[3] : 1) }
        }
        throw NoteDocument.DocumentError.unsupportedContent("color \(value)")
    }
}
