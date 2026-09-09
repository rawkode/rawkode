import AppKit

enum TextBlockStyle: String, CaseIterable {
    case paragraph = "Text", heading1 = "Heading 1", heading2 = "Heading 2", heading3 = "Heading 3", quote = "Quote"
    var font: NSFont {
        switch self {
        case .paragraph, .quote: return .systemFont(ofSize: 17)
        case .heading1: return .systemFont(ofSize: 32, weight: .bold)
        case .heading2: return .systemFont(ofSize: 25, weight: .semibold)
        case .heading3: return .systemFont(ofSize: 20, weight: .semibold)
        }
    }
}

@MainActor
enum MarkdownEditing {
    static func handleInput(in text: DocumentTextView, inserted: String) {
        guard let storage = text.textStorage, let session = text.session, text.selectedRange().length == 0 else { return }
        let caret = text.selectedRange().location
        guard caret > 0, caret <= storage.length else { return }
        guard !FencedCode.isInsideOpenFence(in: text.string, at: caret) else { return }
        guard storage.attribute(.codeLanguage, at: caret - 1, effectiveRange: nil) == nil else { return }
        let paragraph = (text.string as NSString).paragraphRange(for: NSRange(location: caret, length: 0))
        let before = (text.string as NSString).substring(with: NSRange(location: paragraph.location, length: caret - paragraph.location))
        if before == "/", inserted == "/" {
            DispatchQueue.main.async { [weak text] in
                guard let text else { return }
                BlockMenu.show(in: text, slashRange: NSRange(location: paragraph.location, length: 1))
            }
            return
        }
        if inserted == " " {
            if ListEditing.handlePrefix(in: text) { return }
            let shortcut: [String: TextBlockStyle] = ["# ": .heading1, "## ": .heading2, "### ": .heading3, "> ": .quote]
            if let style = shortcut[before] {
                session.replace(NSRange(location: paragraph.location, length: before.utf16.count), with: NSAttributedString(string: "", attributes: EditorSession.bodyAttributes), action: "Turn into \(style.rawValue)")
                session.applyTextStyle(style)
                return
            }
        }
        guard !before.hasPrefix("```"), !before.isEmpty else { return }
        let patterns: [(String, String)] = [
            (#"\*\*([^*\n]+)\*\*$"#, "bold"),
            (#"(?<!\*)\*([^*\n]+)\*$"#, "italic"),
            (#"~~([^~\n]+)~~$"#, "strike"),
            (#"(?<!`)`([^`\n]+)`$"#, "code"),
        ]
        for (pattern, style) in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: before, range: NSRange(location: 0, length: before.utf16.count)) else { continue }
            let matchedRange = NSRange(location: paragraph.location + match.range.location, length: match.range.length)
            var containsAttachment = false
            storage.enumerateAttribute(.attachment, in: matchedRange) { attachment, _, stop in
                if attachment != nil { containsAttachment = true; stop.pointee = true }
            }
            guard !containsAttachment else { return }
            let source = (before as NSString).substring(with: match.range(at: 1))
            var attributes = text.typingAttributes
            let font = attributes[.font] as? NSFont ?? .systemFont(ofSize: 17)
            switch style {
            case "bold": attributes[.font] = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
            case "italic": attributes[.font] = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
            case "strike": attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            default: attributes[.font] = NSFont.monospacedSystemFont(ofSize: font.pointSize - 1, weight: .regular); attributes[.backgroundColor] = NSColor.quaternaryLabelColor
            }
            session.replace(matchedRange, with: NSAttributedString(string: source, attributes: attributes), action: "Format \(style)")
            return
        }
    }
}

extension EditorSession {
    func applyTextStyle(_ style: TextBlockStyle) {
        guard let text = textView, let storage = text.textStorage else { return }
        let undo = text.undoManager
        undo?.beginUndoGrouping()
        defer { undo?.endUndoGrouping() }
        ListEditing.remove(in: text)
        let selection = text.selectedRange()
        let range = (storage.string as NSString).paragraphRange(for: selection)
        var attributes = Self.bodyAttributes
        attributes[.font] = style.font
        if style == .quote {
            let paragraph = (attributes[.paragraphStyle] as! NSParagraphStyle).mutableCopy() as! NSMutableParagraphStyle
            paragraph.headIndent = 24
            paragraph.firstLineHeadIndent = 24
            attributes[.paragraphStyle] = paragraph
            attributes[.foregroundColor] = NSColor.secondaryLabelColor
        }
        if range.length > 0 {
            let replacement = NSMutableAttributedString(attributedString: storage.attributedSubstring(from: range))
            replacement.removeAttribute(.codeLanguage, range: NSRange(location: 0, length: replacement.length))
            replacement.removeAttribute(.backgroundColor, range: NSRange(location: 0, length: replacement.length))
            replacement.addAttributes(attributes, range: NSRange(location: 0, length: replacement.length))
            replace(range, with: replacement, action: "Turn into \(style.rawValue)")
            text.setSelectedRange(selection)
        }
        text.window?.makeFirstResponder(text)
        text.typingAttributes = attributes
    }

    func toggleDecoration(_ key: NSAttributedString.Key) {
        guard let text = textView, let storage = text.textStorage else { return }
        let range = text.selectedRange()
        let existing = range.length == 0 ? text.typingAttributes[key] : storage.attribute(key, at: range.location, effectiveRange: nil)
        let enabled = (existing as? Int ?? 0) != 0
        if range.length == 0 {
            text.typingAttributes[key] = enabled ? 0 : NSUnderlineStyle.single.rawValue
        } else {
            let replacement = NSMutableAttributedString(attributedString: storage.attributedSubstring(from: range))
            replacement.addAttribute(key, value: enabled ? 0 : NSUnderlineStyle.single.rawValue, range: NSRange(location: 0, length: replacement.length))
            replace(range, with: replacement, action: "Format text")
            text.setSelectedRange(range)
        }
        text.window?.makeFirstResponder(text)
    }
}
