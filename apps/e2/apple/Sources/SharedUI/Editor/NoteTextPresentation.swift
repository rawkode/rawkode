import ApsidesCore
import SwiftUI

/// The typography of one text block: what the semantic marks are drawn relative to.
struct NoteBaseFont: Hashable {
    var size: CGFloat
    var weight: Font.Weight
    var design: Font.Design = .default

    static let body = NoteBaseFont(size: 17, weight: .regular)
    static let quote = NoteBaseFont(size: 17, weight: .regular, design: .serif)
    static func heading(_ level: Int) -> NoteBaseFont {
        switch level {
        case 1: NoteBaseFont(size: 30, weight: .bold)
        case 2: NoteBaseFont(size: 24, weight: .semibold)
        default: NoteBaseFont(size: 20, weight: .semibold)
        }
    }

    static func base(for block: NoteBlock) -> NoteBaseFont {
        switch block.node.type {
        case .heading: heading(block.node.attrs?.level ?? 1)
        default: block.quoteDepth > 0 ? .quote : .body
        }
    }
}

/// Derives SwiftUI presentation attributes from the semantic note keys. The
/// projection in ApsidesCore never reads presentation back, so these are safe
/// to recompute on every edit.
enum NoteTextPresentation {
    static func styled(_ text: AttributedString, base: NoteBaseFont, theme: ApsidesTheme) -> AttributedString {
        var result = text
        for run in text.runs {
            let attributes = run.attributes
            result[run.range].font = font(for: attributes, base: base)
            result[run.range].foregroundColor = foregroundColor(for: attributes, theme: theme)
            result[run.range].backgroundColor = backgroundColor(for: attributes, theme: theme)
            result[run.range].underlineStyle = attributes.noteUnderline == true || attributes.noteLink != nil ? .single : nil
            result[run.range].strikethroughStyle = attributes.noteStrike == true ? .single : nil
            result[run.range].link = attributes.noteLink?.href.flatMap { NoteValidation.httpURL($0, mail: true) }
        }
        return result
    }

    static func font(for attributes: AttributeContainer, base: NoteBaseFont) -> Font {
        var size = base.size
        var design = base.design
        var family: String?
        if let style = attributes.noteTextStyle {
            if let value = style.fontSize, NoteValidation.isFontSize(value), let points = Double(value.dropLast(2)) { size = CGFloat(points) }
            if let value = style.fontFamily, !value.isEmpty { family = value }
        }
        if attributes.noteCode == true { design = .monospaced; size = max(11, size - 1); family = nil }
        var font: Font = family.map { Font.custom($0, size: size) } ?? Font.system(size: size, weight: base.weight, design: design)
        if attributes.noteBold == true { font = font.weight(.bold) }
        if attributes.noteItalic == true { font = font.italic() }
        return font
    }

    static func foregroundColor(for attributes: AttributeContainer, theme: ApsidesTheme) -> Color? {
        if attributes.noteEntity != nil || attributes.noteLink != nil { return theme.accent }
        if let value = attributes.noteTextStyle?.color, let color = NoteColor.parse(value) { return color }
        return nil
    }

    static func backgroundColor(for attributes: AttributeContainer, theme: ApsidesTheme) -> Color? {
        if let value = attributes.noteTextStyle?.backgroundColor, let color = NoteColor.parse(value) { return color }
        if attributes.noteCode == true { return theme.ink.opacity(0.08) }
        if attributes.noteEntity != nil { return theme.accent.opacity(0.12) }
        return nil
    }
}

/// CSS colors the schema allows: named, `#rgb[a]`, `#rrggbb[aa]`, `rgb()` and `rgba()`.
enum NoteColor {
    private static let named: [String: UInt32] = [
        "black": 0x000000, "silver": 0xc0c0c0, "gray": 0x808080, "white": 0xffffff, "maroon": 0x800000, "red": 0xff0000,
        "purple": 0x800080, "fuchsia": 0xff00ff, "green": 0x008000, "lime": 0x00ff00, "olive": 0x808000, "yellow": 0xffff00,
        "navy": 0x000080, "blue": 0x0000ff, "teal": 0x008080, "aqua": 0x00ffff,
    ]

    static func parse(_ value: String) -> Color? {
        let text = value.trimmingCharacters(in: .whitespaces).lowercased()
        if text == "transparent" { return .clear }
        if let hex = named[text] { return Color(hex: hex) }
        if text.hasPrefix("#") {
            var digits = Array(text.dropFirst())
            if digits.count == 3 || digits.count == 4 { digits = digits.flatMap { [$0, $0] } }
            guard digits.count == 6 || digits.count == 8, let number = UInt64(String(digits), radix: 16) else { return nil }
            let alpha = digits.count == 8 ? Double(number & 0xff) / 255 : 1
            let rgb = digits.count == 8 ? number >> 8 : number
            return Color(.sRGB, red: Double(rgb >> 16 & 0xff) / 255, green: Double(rgb >> 8 & 0xff) / 255, blue: Double(rgb & 0xff) / 255, opacity: alpha)
        }
        guard text.hasPrefix("rgb"), let open = text.firstIndex(of: "("), let close = text.lastIndex(of: ")") else { return nil }
        let parts = text[text.index(after: open)..<close].split(separator: ",").map { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count >= 3, let r = parts[0], let g = parts[1], let b = parts[2] else { return nil }
        let alpha = parts.count == 4 ? (parts[3] ?? 1) : 1
        return Color(.sRGB, red: r / 255, green: g / 255, blue: b / 255, opacity: alpha)
    }
}

/// Keeps the text editor's own edits inside the note schema: only the semantic
/// keys and the presentation derived from them survive typing and pasting.
struct NoteFormattingDefinition: AttributedTextFormattingDefinition {
    struct Scope: AttributeScope {
        let noteBold: NoteText.Bold
        let noteItalic: NoteText.Italic
        let noteUnderline: NoteText.Underline
        let noteStrike: NoteText.Strike
        let noteCode: NoteText.Code
        let noteLink: NoteText.Link
        let noteTextStyle: NoteText.TextStyle
        let noteEntity: NoteText.Entity
        let noteComponent: NoteText.Component
        let noteHardBreak: NoteText.HardBreak
        let font: AttributeScopes.SwiftUIAttributes.FontAttribute
        let foregroundColor: AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute
        let backgroundColor: AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute
        let underlineStyle: AttributeScopes.SwiftUIAttributes.UnderlineStyleAttribute
        let strikethroughStyle: AttributeScopes.SwiftUIAttributes.StrikethroughStyleAttribute
        let link: AttributeScopes.FoundationAttributes.LinkAttribute
    }

    let base: NoteBaseFont
    let theme: ApsidesTheme

    var body: some AttributedTextFormattingDefinition<Scope> {
        NoteFontConstraint(base: base)
        NoteForegroundConstraint(theme: theme)
        NoteBackgroundConstraint(theme: theme)
        NoteUnderlineConstraint()
        NoteStrikethroughConstraint()
    }
}

struct NoteFontConstraint: AttributedTextValueConstraint {
    typealias Scope = NoteFormattingDefinition.Scope
    typealias AttributeKey = AttributeScopes.SwiftUIAttributes.FontAttribute
    let base: NoteBaseFont
    func constrain(_ container: inout Attributes) {
        var semantic = AttributeContainer()
        semantic.noteBold = container.noteBold
        semantic.noteItalic = container.noteItalic
        semantic.noteCode = container.noteCode
        semantic.noteTextStyle = container.noteTextStyle
        container.font = NoteTextPresentation.font(for: semantic, base: base)
    }
}

struct NoteForegroundConstraint: AttributedTextValueConstraint {
    typealias Scope = NoteFormattingDefinition.Scope
    typealias AttributeKey = AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute
    let theme: ApsidesTheme
    func constrain(_ container: inout Attributes) {
        var semantic = AttributeContainer()
        semantic.noteEntity = container.noteEntity
        semantic.noteLink = container.noteLink
        semantic.noteTextStyle = container.noteTextStyle
        container.foregroundColor = NoteTextPresentation.foregroundColor(for: semantic, theme: theme)
    }
}

struct NoteBackgroundConstraint: AttributedTextValueConstraint {
    typealias Scope = NoteFormattingDefinition.Scope
    typealias AttributeKey = AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute
    let theme: ApsidesTheme
    func constrain(_ container: inout Attributes) {
        var semantic = AttributeContainer()
        semantic.noteEntity = container.noteEntity
        semantic.noteCode = container.noteCode
        semantic.noteTextStyle = container.noteTextStyle
        container.backgroundColor = NoteTextPresentation.backgroundColor(for: semantic, theme: theme)
    }
}

struct NoteUnderlineConstraint: AttributedTextValueConstraint {
    typealias Scope = NoteFormattingDefinition.Scope
    typealias AttributeKey = AttributeScopes.SwiftUIAttributes.UnderlineStyleAttribute
    func constrain(_ container: inout Attributes) {
        container.underlineStyle = container.noteUnderline == true || container.noteLink != nil ? .single : nil
    }
}

struct NoteStrikethroughConstraint: AttributedTextValueConstraint {
    typealias Scope = NoteFormattingDefinition.Scope
    typealias AttributeKey = AttributeScopes.SwiftUIAttributes.StrikethroughStyleAttribute
    func constrain(_ container: inout Attributes) {
        container.strikethroughStyle = container.noteStrike == true ? .single : nil
    }
}
