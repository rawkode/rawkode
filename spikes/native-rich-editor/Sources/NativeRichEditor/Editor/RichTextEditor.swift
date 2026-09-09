import AppKit
import SwiftUI

struct RichTextEditor: NSViewRepresentable {
    let session: EditorSession

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let text = DocumentTextView(usingTextLayoutManager: true)
        ListEditing.configure(in: text)
        text.session = session
        text.delegate = session
        text.isRichText = true
        text.importsGraphics = true
        text.allowsUndo = true
        text.isAutomaticQuoteSubstitutionEnabled = false
        text.isAutomaticDashSubstitutionEnabled = false
        text.isAutomaticLinkDetectionEnabled = true
        text.isAutomaticTextReplacementEnabled = false
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        text.autoresizingMask = [.width]
        text.minSize = NSSize(width: 0, height: 600)
        text.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        text.textContainer?.widthTracksTextView = true
        text.textContainerInset = NSSize(width: 52, height: 36)
        text.backgroundColor = .textBackgroundColor
        text.typingAttributes = EditorSession.bodyAttributes
        text.setAccessibilityLabel("Note editor")
        scroll.documentView = text
        session.attach(text)
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {}
}

final class DocumentTextView: NSTextView {
    static let documentPasteboard = NSPasteboard.PasteboardType("dev.rawkode.native-rich-editor.fragment")
    weak var session: EditorSession?

    override func copy(_ sender: Any?) {
        let range = selectedRange()
        guard range.length > 0, let storage = textStorage,
              let fragment = try? NoteDocument(attributedString: storage.attributedSubstring(from: range)),
              let data = try? JSONEncoder().encode(fragment) else { super.copy(sender); return }
        super.copy(sender)
        NSPasteboard.general.addTypes([Self.documentPasteboard], owner: nil)
        NSPasteboard.general.setData(data, forType: Self.documentPasteboard)
    }

    override func cut(_ sender: Any?) {
        copy(sender)
        session?.replace(selectedRange(), with: NSAttributedString(string: ""), action: "Cut")
    }

    override func paste(_ sender: Any?) {
        if let data = NSPasteboard.general.data(forType: Self.documentPasteboard),
           let fragment = try? NoteDocument.decode(data),
           let attributed = try? fragment.attributedString() {
            // A paste creates new component identities, even within the same note.
            let value = NSMutableAttributedString(attributedString: attributed)
            value.enumerateAttribute(.attachment, in: NSRange(location: 0, length: value.length)) { attachment, range, _ in
                if let attachment = attachment as? ComponentAttachment {
                    var component = attachment.component
                    component.id = UUID()
                    value.addAttribute(.attachment, value: ComponentAttachment(component), range: range)
                }
            }
            session?.replace(selectedRange(), with: value, action: "Paste")
        } else {
            super.paste(sender)
            session?.convertCompletedFences()
        }
    }

    override func insertText(_ insertString: Any, replacementRange: NSRange) {
        var attributes = typingAttributes
        attributes.removeValue(forKey: .attachment)
        attributes.removeValue(forKey: .nativeLiteralSeparator)
        attributes.removeValue(forKey: .nativeEmptyBlock)
        attributes.removeValue(forKey: .nativeBlockSeparator)
        attributes.removeValue(forKey: .nativeFollowingBlock)
        typingAttributes = attributes
        super.insertText(insertString, replacementRange: replacementRange)
        let inserted = (insertString as? String) ?? (insertString as? NSAttributedString)?.string ?? ""
        if inserted.contains("\n") || inserted.contains("```") { session?.convertCompletedFences() }
        MarkdownEditing.handleInput(in: self, inserted: inserted)
    }

    override func insertNewline(_ sender: Any?) {
        typingAttributes.removeValue(forKey: .nativeLiteralSeparator)
        typingAttributes.removeValue(forKey: .nativeEmptyBlock)
        typingAttributes.removeValue(forKey: .nativeBlockSeparator)
        typingAttributes.removeValue(forKey: .nativeFollowingBlock)
        if !FencedCode.isInsideOpenFence(in: string, at: selectedRange().location), ListEditing.handleNewline(in: self) { return }
        let font = typingAttributes[.font] as? NSFont
        let wasHeading = (font?.pointSize ?? 17) >= 20 && typingAttributes[.codeLanguage] == nil
        super.insertNewline(sender)
        session?.convertCompletedFences()
        if wasHeading { typingAttributes = EditorSession.bodyAttributes }
    }

    override func insertTab(_ sender: Any?) {
        if !ListEditing.handleIndent(in: self, outdent: false) {
            insertText("\t", replacementRange: selectedRange())
        }
    }

    override func insertBacktab(_ sender: Any?) {
        if !ListEditing.handleIndent(in: self, outdent: true) { super.insertBacktab(sender) }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let index = characterIndexForInsertion(at: point)
        if ListEditing.toggleTask(in: self, at: index) { return }
        super.mouseDown(with: event)
    }
}
