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

    private enum EntityDeletionDirection { case backward, forward }

    private func entityRange(at position: Int) -> NSRange? {
        guard let storage = textStorage, position >= 0, position < storage.length else { return nil }
        var range = NSRange(location: position, length: 0)
        guard storage.attribute(.nativeEntity, at: position, longestEffectiveRange: &range,
                                in: NSRange(location: 0, length: storage.length)) != nil else { return nil }
        return range
    }

    /// Entity nodes are inline atoms in the portable document. Expand an edit
    /// that touches one so AppKit cannot leave a partially labelled entity
    /// behind while the bridge still serializes the original payload.
    private func entityRangeForEdit(_ range: NSRange, direction: EntityDeletionDirection? = nil) -> NSRange? {
        guard let storage = textStorage, storage.length > 0 else { return nil }
        if range.length == 0 {
            switch direction {
            case .backward:
                return entityRange(at: range.location - 1)
            case .forward:
                return entityRange(at: range.location)
            case nil:
                guard let entity = entityRange(at: range.location),
                      range.location > entity.location,
                      range.location < NSMaxRange(entity) else { return nil }
                return entity
            }
        }

        var result: NSRange?
        storage.enumerateAttribute(.nativeEntity, in: NSRange(location: 0, length: storage.length)) { value, candidate, _ in
            guard value != nil, NSIntersectionRange(range, candidate).length > 0 else { return }
            result = result.map { NSUnionRange($0, candidate) } ?? candidate
        }
        return result
    }

    private func rangeIncludingEntity(_ range: NSRange, direction: EntityDeletionDirection? = nil) -> NSRange {
        guard let entity = entityRangeForEdit(range, direction: direction) else { return range }
        return range.length == 0 && direction == nil ? entity : NSUnionRange(range, entity)
    }

    private func clearProjectionTypingAttributes() {
        var attributes = typingAttributes
        for key: NSAttributedString.Key in [
            .attachment, .nativeEntity, .nativeLiteralSeparator, .nativeEmptyBlock,
            .nativeBlockSeparator, .nativeFollowingBlock,
        ] {
            attributes.removeValue(forKey: key)
        }
        typingAttributes = attributes
    }

    private func prepareEntityDeletion(_ direction: EntityDeletionDirection) {
        setSelectedRange(rangeIncludingEntity(selectedRange(), direction: direction))
        clearProjectionTypingAttributes()
    }

    private func prepareCommandDeletion(_ movement: (Any?) -> Void) {
        if selectedRange().length == 0 { movement(nil) }
        setSelectedRange(rangeIncludingEntity(selectedRange()))
        clearProjectionTypingAttributes()
    }

    override func copy(_ sender: Any?) {
        let range = rangeIncludingEntity(selectedRange())
        guard range.length > 0, let storage = textStorage,
              let fragment = try? NoteDocument(attributedString: storage.attributedSubstring(from: range)),
              let data = try? JSONEncoder().encode(fragment) else { super.copy(sender); return }
        super.copy(sender)
        NSPasteboard.general.addTypes([Self.documentPasteboard], owner: nil)
        NSPasteboard.general.setData(data, forType: Self.documentPasteboard)
    }

    override func cut(_ sender: Any?) {
        copy(sender)
        session?.replace(rangeIncludingEntity(selectedRange()), with: NSAttributedString(string: ""), action: "Cut")
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
            session?.replace(rangeIncludingEntity(selectedRange()), with: value, action: "Paste")
        } else {
            let range = rangeIncludingEntity(selectedRange())
            if range != selectedRange() { setSelectedRange(range) }
            clearProjectionTypingAttributes()
            super.paste(sender)
            clearProjectionTypingAttributes()
            session?.convertCompletedFences()
        }
    }

    override func insertText(_ insertString: Any, replacementRange: NSRange) {
        let requestedRange = replacementRange.location == NSNotFound ? selectedRange() : replacementRange
        let editRange = rangeIncludingEntity(requestedRange)
        if editRange != requestedRange { setSelectedRange(editRange) }
        clearProjectionTypingAttributes()
        super.insertText(insertString, replacementRange: editRange)
        clearProjectionTypingAttributes()
        let inserted = (insertString as? String) ?? (insertString as? NSAttributedString)?.string ?? ""
        if inserted.contains("\n") || inserted.contains("```") { session?.convertCompletedFences() }
        MarkdownEditing.handleInput(in: self, inserted: inserted)
    }

    override func insertNewline(_ sender: Any?) {
        if let entity = entityRangeForEdit(selectedRange()) {
            setSelectedRange(NSUnionRange(selectedRange(), entity))
            clearProjectionTypingAttributes()
            super.insertNewline(sender)
            clearProjectionTypingAttributes()
            session?.convertCompletedFences()
            return
        }
        clearProjectionTypingAttributes()
        if !FencedCode.isInsideOpenFence(in: string, at: selectedRange().location), ListEditing.handleNewline(in: self) { return }
        let font = typingAttributes[.font] as? NSFont
        let wasHeading = (font?.pointSize ?? 17) >= 20 && typingAttributes[.codeLanguage] == nil
        super.insertNewline(sender)
        clearProjectionTypingAttributes()
        session?.convertCompletedFences()
        if wasHeading { typingAttributes = EditorSession.bodyAttributes }
    }

    override func deleteBackward(_ sender: Any?) {
        setSelectedRange(rangeIncludingEntity(selectedRange(), direction: .backward))
        super.deleteBackward(sender)
        clearProjectionTypingAttributes()
    }

    override func deleteForward(_ sender: Any?) {
        prepareEntityDeletion(.forward)
        super.deleteForward(sender)
        clearProjectionTypingAttributes()
    }

    override func deleteBackwardByDecomposingPreviousCharacter(_ sender: Any?) {
        prepareEntityDeletion(.backward)
        super.deleteBackwardByDecomposingPreviousCharacter(sender)
        clearProjectionTypingAttributes()
    }

    override func deleteWordBackward(_ sender: Any?) {
        prepareCommandDeletion(moveWordBackwardAndModifySelection)
        super.deleteBackward(sender)
        clearProjectionTypingAttributes()
    }

    override func deleteWordForward(_ sender: Any?) {
        prepareCommandDeletion(moveWordForwardAndModifySelection)
        super.deleteForward(sender)
        clearProjectionTypingAttributes()
    }

    override func deleteToBeginningOfLine(_ sender: Any?) {
        prepareCommandDeletion(moveToBeginningOfLineAndModifySelection)
        super.deleteBackward(sender)
        clearProjectionTypingAttributes()
    }

    override func deleteToEndOfLine(_ sender: Any?) {
        prepareCommandDeletion(moveToEndOfLineAndModifySelection)
        super.deleteForward(sender)
        clearProjectionTypingAttributes()
    }

    override func deleteToBeginningOfParagraph(_ sender: Any?) {
        prepareCommandDeletion(moveToBeginningOfParagraphAndModifySelection)
        super.deleteBackward(sender)
        clearProjectionTypingAttributes()
    }

    override func deleteToEndOfParagraph(_ sender: Any?) {
        prepareCommandDeletion(moveToEndOfParagraphAndModifySelection)
        super.deleteForward(sender)
        clearProjectionTypingAttributes()
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
