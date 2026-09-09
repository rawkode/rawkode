import AppKit

extension NSAttributedString.Key {
    static let codeLanguage = NSAttributedString.Key("dev.rawkode.code-language")
}

enum CodeBlockStyle {
    static func attributed(_ source: String, language: String) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        paragraph.paragraphSpacing = 0
        paragraph.firstLineHeadIndent = 14
        paragraph.headIndent = 14
        paragraph.tailIndent = -14
        return NSAttributedString(string: source.isEmpty ? "\n" : source, attributes: [
            .codeLanguage: language,
            .font: NSFont.monospacedSystemFont(ofSize: 14, weight: .regular),
            .foregroundColor: NSColor.textColor,
            .backgroundColor: NSColor.quaternaryLabelColor,
            .paragraphStyle: paragraph,
        ])
    }
}
