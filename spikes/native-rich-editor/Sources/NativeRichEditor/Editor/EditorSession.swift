import AppKit
import Combine
import UniformTypeIdentifiers

@MainActor
final class EditorSession: NSObject, ObservableObject, NSTextViewDelegate {
    struct ComponentEdit: Identifiable {
        let id = UUID()
        var component: Component
        var insertionRange: NSRange?
    }

    @Published var editing: ComponentEdit?
    @Published var status = "Saved on this Mac"
    @Published var error: String?
    @Published private(set) var document: NoteDocument?
    weak var textView: DocumentTextView?
    private var saveURL: URL
    private var loadFailed = false
    private var convertingFences = false
    private var undoObservers: [NSObjectProtocol] = []

    static var bodyAttributes: [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 5
        paragraph.paragraphSpacing = 12
        return [.font: NSFont.systemFont(ofSize: 17), .foregroundColor: NSColor.textColor, .paragraphStyle: paragraph]
    }

    init(dataDirectory: URL? = nil) {
        let base = dataDirectory ?? ProcessInfo.processInfo.environment["NATIVE_EDITOR_DATA_DIR"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Rawkode Native Rich Editor", isDirectory: true)
        saveURL = base.appendingPathComponent("note.native-note")
        super.init()
        ComponentAttachment.register()
        for name in [Notification.Name.NSUndoManagerDidUndoChange, Notification.Name.NSUndoManagerDidRedoChange] {
            undoObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                MainActor.assumeIsolated {
                    guard let self, let manager = notification.object as? UndoManager,
                          manager === self.textView?.undoManager else { return }
                    self.acceptNativeEdit()
                }
            })
        }
        if FileManager.default.fileExists(atPath: saveURL.path) {
            do { document = try JSONDecoder().decode(NoteDocument.self, from: Data(contentsOf: saveURL)) }
            catch { loadFailed = true; self.error = "Could not open saved note: \(error.localizedDescription). The original file has been preserved." }
        }
    }

    deinit { undoObservers.forEach(NotificationCenter.default.removeObserver) }

    func attach(_ textView: DocumentTextView) {
        self.textView = textView
        do {
            let content = try document?.attributedString() ?? Self.sample()
            textView.textStorage?.setAttributedString(content)
            bindAttachments()
            textView.setSelectedRange(NSRange(location: content.length, length: 0))
            if !loadFailed { acceptNativeEdit() }
        } catch {
            loadFailed = true
            self.error = "Could not decode note: \(error.localizedDescription). Use Save As to save a separate file."
        }
    }

    func textDidChange(_ notification: Notification) { acceptNativeEdit() }

    func textViewDidChangeSelection(_ notification: Notification) {
        guard let textView else { return }
        var attributes = textView.typingAttributes
        attributes.removeValue(forKey: .attachment)
        textView.typingAttributes = attributes
    }

    private func bindAttachments() {
        guard let storage = textView?.textStorage else { return }
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, _, _ in
            (value as? ComponentAttachment)?.session = self
        }
    }

    func acceptNativeEdit() {
        guard let textView, let storage = textView.textStorage else { return }
        bindAttachments()
        do {
            // Commit native transactions to the value model without re-projecting text.
            document = try NoteDocument(attributedString: storage)
            if !loadFailed {
                try writeDocument()
                status = textView.textLayoutManager != nil ? "Saved on this Mac" : "Saved • TextKit compatibility mode; reopen to restore interactive components"
            }
        } catch { self.error = "Save failed: \(error.localizedDescription)"; status = "Not saved" }
    }

    private func writeDocument() throws {
        guard let document else { throw CocoaError(.fileWriteUnknown) }
        try FileManager.default.createDirectory(at: saveURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(document).write(to: saveURL, options: .atomic)
    }

    func replace(_ range: NSRange, with replacement: NSAttributedString, action: String) {
        guard let textView, let storage = textView.textStorage,
              NSMaxRange(range) <= storage.length,
              textView.shouldChangeText(in: range, replacementString: replacement.string) else { return }
        textView.breakUndoCoalescing()
        // NSTextView.insertText normalizes supplied font sizes on this host.
        // The native validation/change bracket preserves exact attributed data
        // and registers the inverse operation with the text view's undo manager.
        storage.beginEditing()
        storage.replaceCharacters(in: range, with: replacement)
        storage.endEditing()
        textView.didChangeText()
        textView.setSelectedRange(NSRange(location: range.location + replacement.length, length: 0))
        textView.undoManager?.setActionName(action)
        textView.typingAttributes = Self.bodyAttributes
        bindAttachments()
        textView.window?.makeFirstResponder(textView)
        if replacement.string.contains("```") { convertCompletedFences() }
    }

    func insert(_ kind: Component.Kind) {
        guard let textView else { return }
        let component: Component
        switch kind {
        case .diagram: component = Component(kind: .diagram, title: "D2 diagram", source: Component.diagramSource)
        case .mermaid: component = Component(kind: .mermaid, title: "Mermaid diagram", source: "flowchart LR\n    Idea --> Note --> Diagram")
        case .drawing: component = Component(kind: .drawing, title: "Drawing", drawing: DrawingDocument())
        case .link: component = Component(kind: .link, title: "Link")
        }
        editing = ComponentEdit(component: component, insertionRange: textView.selectedRange())
    }

    func insertCodeBlock() {
        guard let textView else { return }
        let selection = textView.selectedRange()
        let code = CodeBlockStyle.attributed("Write code here", language: "")
        let replacement = NSMutableAttributedString(string: "\n", attributes: Self.bodyAttributes)
        replacement.append(code)
        replacement.append(NSAttributedString(string: "\n", attributes: Self.bodyAttributes))
        replace(selection, with: replacement, action: "Insert code block")
        textView.setSelectedRange(NSRange(location: selection.location + 1, length: code.length))
        textView.typingAttributes = code.attributes(at: 0, effectiveRange: nil)
    }

    func convertCompletedFences() {
        guard !convertingFences, let textView, let storage = textView.textStorage else { return }
        convertingFences = true
        defer { convertingFences = false }
        for block in FencedCode.parseCompleted(in: storage.string).reversed() {
            guard storage.attribute(.codeLanguage, at: block.range.location, effectiveRange: nil) == nil else { continue }
            let replacement: NSAttributedString
            if ["d2", "mermaid"].contains(block.language) {
                let component = Component(kind: block.language == "d2" ? .diagram : .mermaid,
                                          title: block.language == "d2" ? "D2 diagram" : "Mermaid diagram", source: block.source)
                replacement = NSAttributedString(attachment: ComponentAttachment(component))
            } else {
                replacement = CodeBlockStyle.attributed(block.source, language: block.language)
            }
            let oldSelection = textView.selectedRange()
            replace(block.range, with: replacement, action: "Create \(block.language.isEmpty ? "code" : block.language) block")
            func mapPosition(_ position: Int) -> Int {
                if position <= block.range.location { return position }
                if position < NSMaxRange(block.range) { return block.range.location + replacement.length }
                return position + replacement.length - block.range.length
            }
            let start = mapPosition(oldSelection.location)
            let end = mapPosition(NSMaxRange(oldSelection))
            textView.setSelectedRange(NSRange(location: start, length: max(0, end - start)))
            textView.typingAttributes = Self.bodyAttributes
        }
    }

    func edit(_ component: Component) { editing = ComponentEdit(component: component, insertionRange: nil) }

    func commit(_ component: Component) {
        guard let edit = editing, let storage = textView?.textStorage else { return }
        if let range = edit.insertionRange {
            let value = NSMutableAttributedString(string: "\n", attributes: Self.bodyAttributes)
            value.append(NSAttributedString(attachment: ComponentAttachment(component)))
            value.append(NSAttributedString(string: "\n", attributes: Self.bodyAttributes))
            replace(range, with: value, action: "Insert \(component.title)")
        } else {
            var target: NSRange?
            storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, stop in
                if (value as? ComponentAttachment)?.component.id == component.id { target = range; stop.pointee = true }
            }
            if let target { replace(target, with: NSAttributedString(attachment: ComponentAttachment(component)), action: "Edit \(component.title)") }
        }
        editing = nil
    }

    func toggleFont(_ trait: NSFontTraitMask) {
        guard let textView, let storage = textView.textStorage else { return }
        let range = textView.selectedRange()
        let current = (range.length == 0 ? textView.typingAttributes[.font] : storage.attribute(.font, at: range.location, effectiveRange: nil)) as? NSFont ?? .systemFont(ofSize: 17)
        let remove = NSFontManager.shared.traits(of: current).contains(trait)
        if range.length == 0 {
            var attributes = textView.typingAttributes
            attributes[.font] = remove ? NSFontManager.shared.convert(current, toNotHaveTrait: trait) : NSFontManager.shared.convert(current, toHaveTrait: trait)
            textView.typingAttributes = attributes
        } else {
            let value = NSMutableAttributedString(attributedString: storage.attributedSubstring(from: range))
            value.enumerateAttribute(.font, in: NSRange(location: 0, length: value.length)) { font, span, _ in
                let font = font as? NSFont ?? .systemFont(ofSize: 17)
                value.addAttribute(.font, value: remove ? NSFontManager.shared.convert(font, toNotHaveTrait: trait) : NSFontManager.shared.convert(font, toHaveTrait: trait), range: span)
            }
            replace(range, with: value, action: "Format text")
            textView.setSelectedRange(range)
        }
        textView.window?.makeFirstResponder(textView)
    }

    func setParagraphStyle(heading: Bool) {
        applyTextStyle(heading ? .heading2 : .paragraph)
    }

    func saveAs() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Fieldnotes.native-note"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            guard let storage = textView?.textStorage else { throw CocoaError(.fileWriteUnknown) }
            let snapshot = try NoteDocument(attributedString: storage)
            try JSONEncoder().encode(snapshot).write(to: url, options: .atomic)
            document = snapshot
            saveURL = url
            loadFailed = false
            status = "Saved \(url.lastPathComponent)"
        } catch { self.error = error.localizedDescription }
    }

    func open() {
        if loadFailed {
            error = "Use Save As to preserve the current note before opening another file."
            return
        }
        do {
            if let storage = textView?.textStorage { document = try NoteDocument(attributedString: storage) }
            try writeDocument()
        }
        catch { self.error = "The current note could not be saved. Use Save As before opening another file."; return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = []
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let loaded = try JSONDecoder().decode(NoteDocument.self, from: Data(contentsOf: url))
            let value = try loaded.attributedString()
            document = loaded
            saveURL = url
            loadFailed = false
            textView?.textStorage?.setAttributedString(value)
            textView?.undoManager?.removeAllActions()
            bindAttachments()
            status = "Opened \(url.lastPathComponent)"
        } catch { self.error = "Could not open note: \(error.localizedDescription)" }
    }

    static func sample() -> NSAttributedString {
        let result = NSMutableAttributedString(string: "")
        func paragraph(_ text: String, size: CGFloat = 17, weight: NSFont.Weight = .regular) {
            var attributes = bodyAttributes
            attributes[.font] = NSFont.systemFont(ofSize: size, weight: weight)
            result.append(NSAttributedString(string: text + "\n", attributes: attributes))
        }
        func component(_ component: Component) {
            result.append(NSAttributedString(attachment: ComponentAttachment(component)))
            paragraph("")
        }
        paragraph("Room to think.", size: 38, weight: .bold)
        paragraph("Words, diagrams, drawings, and the web — in one note.")
        paragraph("Start with a connection", size: 24, weight: .semibold)
        let svg = Bundle.main.url(forResource: "sample", withExtension: "svg").flatMap { try? String(contentsOf: $0, encoding: .utf8) }
        component(Component(kind: .diagram, title: "From idea to diagram", source: Component.diagramSource, svg: svg))
        paragraph("Click the diagram to change its D2 source. Keep writing here; everything above and below belongs to the same document.")
        paragraph("Make space for a sketch", size: 24, weight: .semibold)
        component(Component(kind: .drawing, title: "A little room to explore", drawing: .sample))
        paragraph("Collect something worth watching", size: 24, weight: .semibold)
        paragraph("Use Insert → Link to paste a URL. Available page metadata supplies its title, preview, and inline player.")
        component(Component(kind: .link, title: "Big Buck Bunny", source: "https://www.youtube.com/watch?v=aqz-KE-bpKQ"))
        paragraph("And carry on writing…")
        return result
    }
}
