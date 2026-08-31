#if os(macOS)
import AppKit
import SwiftUI
import AthenaeumCore

/// A deliberately value-only TextKit boundary for the native rich editor.  It does not know how
/// a document is submitted; its sole output is a canonical semantic document.
struct LoroNativeRichTextEditor: NSViewRepresentable {
    let state: LoroNativeRichEditorState
    let isEditable: Bool
    /// Monotonic SwiftUI-owned focus requests. The controller consumes each generation only
    /// after its own NSTextView is attached to a window and remains editable.
    let focusRequestGeneration: Int
    /// Optional scalar selection captured before an editor-adjacent command moved focus. It is
    /// consumed only with the matching focus generation, never on ordinary SwiftUI updates.
    let focusRequestSelection: LoroNativeRichTextSelection?
    let onDocumentChange: (LoroNativeRichDocumentV1) -> Void
    let onSelectionChange: (LoroNativeRichTextSelection) -> Void
    let onRejectedInput: (LoroNativeRichTextEditorRejection) -> Void
    /// Presentation-only responder state. Durable editing semantics stay in the engine.
    let onFocusChange: (Bool) -> Void
    /// Semantic activation stays typed; routing belongs to the parent workspace surface.
    let onOpenReference: (LoroCanonicalSemanticValueV1.InlineReference) -> Void

    func makeCoordinator() -> LoroNativeRichTextEditorController {
        LoroNativeRichTextEditorController(document: state.document, isEditable: isEditable,
                                           onDocumentChange: onDocumentChange,
                                           onSelectionChange: onSelectionChange,
                                           onRejectedInput: onRejectedInput,
                                           onFocusChange: onFocusChange,
                                           onOpenReference: onOpenReference)
    }

    func makeNSView(context: Context) -> NSScrollView { context.coordinator.makeScrollView() }

    func updateNSView(_ view: NSScrollView, context: Context) {
        context.coordinator.update(document: state.document, isEditable: isEditable)
        context.coordinator.requestFocus(generation: focusRequestGeneration, selection: focusRequestSelection)
    }
}

/// Kept separate from the representable so its editing boundary can be exercised without a
/// SwiftUI host.  Storage only ever contains the codec's private marker attributes.
final class LoroNativeRichTextEditorController: NSObject, NSTextViewDelegate {
    typealias Rejection = LoroNativeRichTextEditorRejection

    private enum Marker {
        static let marks = NSAttributedString.Key("dev.athenaeum.rich.marks.v1")
        static let reference = NSAttributedString.Key("dev.athenaeum.rich.reference.v1")
        static let block = NSAttributedString.Key("dev.athenaeum.rich.block.v1")
        static let separatorBefore = NSAttributedString.Key("dev.athenaeum.rich.separator-before.v1")
        static let separatorAfter = NSAttributedString.Key("dev.athenaeum.rich.separator-after.v1")
    }

    private let textView: GuardedRichTextView
    /// Authoritative semantic storage. AppKit may synthesize font defaults for display; this
    /// value is what is decoded, validated, and rendered, and contains marker attrs only.
    private var semanticStorage = NSMutableAttributedString()
    private var engine: LoroNativeRichEditingEngine
    private var rendering = false
    private var pendingComposition = false
    private var hostCompositionGeneration = 0
    private var scheduledFlushGeneration: Int?
    /// A parent refresh received during IME is applied only after the shared engine has either
    /// committed or cancelled the captured semantic composition. This prevents date navigation
    /// from silently destroying marked text while still converging on the requested document.
    private var deferredParentDocument: LoroNativeRichDocumentV1?
    private var isEditableInput: Bool
    private var completedFocusGeneration = 0
    private var pendingFocusGeneration: Int?
    private var pendingFocusSelection: LoroNativeRichTextSelection?
    #if DEBUG
    /// Test-only responder result seam. Production always asks this controller's own window.
    private var testingFocusAttempt: (() -> Bool)?
    #endif
    private let onDocumentChange: (LoroNativeRichDocumentV1) -> Void
    private let onSelectionChange: (LoroNativeRichTextSelection) -> Void
    private let onRejectedInput: (Rejection) -> Void
    private let onFocusChange: (Bool) -> Void
    private let onOpenReference: (LoroCanonicalSemanticValueV1.InlineReference) -> Void

    init(document: LoroNativeRichDocumentV1, isEditable: Bool,
         onDocumentChange: @escaping (LoroNativeRichDocumentV1) -> Void = { _ in },
         onSelectionChange: @escaping (LoroNativeRichTextCodec.ScalarSelection) -> Void = { _ in },
         onRejectedInput: @escaping (Rejection) -> Void = { _ in },
         onFocusChange: @escaping (Bool) -> Void = { _ in },
         onOpenReference: @escaping (LoroCanonicalSemanticValueV1.InlineReference) -> Void = { _ in }) {
        engine = .init(document: document); isEditableInput = isEditable
        self.onDocumentChange = onDocumentChange; self.onSelectionChange = onSelectionChange; self.onRejectedInput = onRejectedInput; self.onFocusChange = onFocusChange; self.onOpenReference = onOpenReference
        textView = GuardedRichTextView(frame: .zero)
        super.init()
        textView.controller = self
        textView.delegate = self
        textView.isRichText = false
        textView.importsGraphics = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.allowsImageEditing = false
        textView.setAccessibilityLabel("Rich text editor. Command-click a linked label to open it.")
        textView.setAccessibilityCustomActions([
            .init(name: "Open linked reference") { [weak self] in self?.openReferenceAtCurrentSelection() ?? false }
        ])
        render(document, preserving: nil)
        textView.isEditable = isEditable
    }

    func makeScrollView() -> NSScrollView {
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.documentView = textView
        textView.minSize = NSSize(width: 0, height: 0); textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true; textView.isHorizontallyResizable = false
        return scroll
    }

    func update(document: LoroNativeRichDocumentV1, isEditable: Bool) {
        let wasEditable = isEditableInput
        isEditableInput = isEditable; textView.isEditable = isEditable
        if !wasEditable, isEditable { fulfillFocusRequestIfPossible() }
        if wasEditable, !isEditable, (engine.compositionState != .idle || pendingComposition || textView.hasMarkedText()) {
            deferredParentDocument = document
            cancelComposition()
            return
        }
        // Parent refreshes are deliberately inert during IME and while a local proposal remains
        // admitted locally; otherwise a SwiftUI update can destroy marked text or the caret.
        if let selection = scalarSelection() { engine.setSelection(selection) }
        switch engine.receiveParentDocument(document) {
        case let .adopted(document, selection), let .acknowledged(document, selection):
            render(document, preserving: selection)
        case .deferredForComposition:
            deferredParentDocument = document
        case .deferredForLocalProposal, .unchanged:
            return
        }
    }

    /// Stores a SwiftUI request until this editor has an actual window. The controller owns no
    /// global window state, and it never makes a disabled editor first responder.
    func requestFocus(generation: Int, selection: LoroNativeRichTextSelection? = nil) {
        guard generation > completedFocusGeneration else { return }
        pendingFocusGeneration = max(pendingFocusGeneration ?? 0, generation)
        pendingFocusSelection = selection
        fulfillFocusRequestIfPossible()
    }

    fileprivate func didMoveToWindow() { fulfillFocusRequestIfPossible() }

    func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange, replacementString: String?) -> Bool {
        guard !rendering else { return false }
        guard isEditableInput else { reject(.disabled); return false }
        // While an input method owns marked text, TextKit must be allowed to mutate its
        // transient display buffer. `unmarkText` subsequently commits from our marker-only
        // snapshot, never from those display attributes.
        guard !pendingComposition, !textView.hasMarkedText() else { return true }
        guard let replacementString else { reject(.invalidEdit); return false }
        return replace(range: affectedCharRange, withPlainText: replacementString)
    }

    func textDidChange(_ notification: Notification) { guard !rendering else { return }; flushAfterCompositionIfNeeded() }
    func textViewDidChangeSelection(_ notification: Notification) {
        guard !rendering, let selection = scalarSelection() else { return }
        engine.setSelection(selection); onSelectionChange(selection)
    }

    fileprivate func didChangeFocus(_ isFocused: Bool) { onFocusChange(isFocused) }

    fileprivate func paste(_ pasteboard: NSPasteboard) {
        guard isEditableInput, !pendingComposition else { reject(.disabled); return }
        // Anything other than a lone plain string is rejected before TextKit or its undo manager
        // can touch storage (RTF, attachments, links and services all take this path).
        let types = Set(pasteboard.types ?? [])
        let plainTypes: Set<NSPasteboard.PasteboardType> = [.string, .init("public.utf8-plain-text"), .init("public.text")]
        guard types.isSubset(of: plainTypes), let string = pasteboard.string(forType: .string) else { reject(.attributedPaste); return }
        _ = replace(range: textView.selectedRange(), withPlainText: string)
    }

    fileprivate func reject(_ reason: Rejection) {
        guard !rendering else { return }
        render(engine.admittedDocument, preserving: engine.admittedSelection)
        onRejectedInput(reason)
    }

    /// Formatting is semantic-marker-only: visual font traits never enter `textStorage`.
    func toggle(mark: LoroCanonicalSemanticValueV1.Mark) {
        guard isEditableInput else { reject(.disabled); return }
        // A formatting command during an IME composition must not rebuild or decode the marked
        // display buffer. It is consumed by the shortcut handler until the composition commits.
        guard !pendingComposition, !textView.hasMarkedText() else { return }
        let range = textView.selectedRange()
        guard range.length > 0 else { return }
        _ = apply(engine.toggle(mark: mark, utf16Range: range))
    }

    /// Consumes only the standard rich-writing shortcuts that this editor can represent
    /// losslessly. Unsupported shortcuts continue through AppKit unchanged.
    fileprivate func handleFormattingShortcut(
        charactersIgnoringModifiers: String?,
        modifierFlags: NSEvent.ModifierFlags
    ) -> Bool {
        let modifiers = modifierFlags.intersection(.deviceIndependentFlagsMask)
        if (charactersIgnoringModifiers == "\r" || charactersIgnoringModifiers == "\n"), modifiers == .command {
            return openReferenceAtCurrentSelection()
        }
        let mark: LoroCanonicalSemanticValueV1.Mark?
        switch (charactersIgnoringModifiers?.lowercased(), modifiers) {
        case ("b", .command): mark = .strong
        case ("i", .command): mark = .emphasis
        default: mark = nil
        }
        guard let mark else { return false }
        guard !pendingComposition, !textView.hasMarkedText() else { return true }
        // The canonical value has no typing-attributes state. Without a selection, leave the
        // event to AppKit rather than inventing a latent format that cannot be persisted.
        guard textView.selectedRange().length > 0 else { return false }
        toggle(mark: mark)
        return true
    }

    // Internal inspection points keep the AppKit contract directly testable without a live window.
    func testingDocument() -> LoroNativeRichDocumentV1 { engine.admittedDocument }
    func testingStorage() -> NSAttributedString { semanticStorage.copy() as! NSAttributedString }
    func testingReplace(_ range: NSRange, with string: String) { _ = replace(range: range, withPlainText: string) }
    /// Exercises the same plain-text-only admission path as `paste(_:)` without a global pasteboard.
    func testingPastePlainText(_ string: String, at range: NSRange) { _ = replace(range: range, withPlainText: string) }
    func testingOpenReference(_ reference: LoroCanonicalSemanticValueV1.InlineReference) { onOpenReference(reference) }
    @discardableResult
    func testingOpenReference(atUTF16Offset offset: Int) -> Bool { openReference(atUTF16Offset: offset) }
    func testingSelect(_ range: NSRange) { textView.setSelectedRange(range) }
    func testingHandleFormattingShortcut(
        charactersIgnoringModifiers: String?,
        modifierFlags: NSEvent.ModifierFlags
    ) -> Bool {
        handleFormattingShortcut(
            charactersIgnoringModifiers: charactersIgnoringModifiers,
            modifierFlags: modifierFlags
        )
    }
    func testingBeginComposition(range: NSRange) {
        guard isEditableInput, !pendingComposition else { reject(.disabled); return }
        let effect = engine.beginComposition(utf16Range: range)
        guard case .noChange = effect else { _ = apply(effect); return }
        hostCompositionGeneration &+= 1
        scheduledFlushGeneration = nil
        pendingComposition = true
    }
    func testingChangeComposition(_ replacement: String) {
        engine.updateComposition(replacement)
    }
    func testingEndComposition() {
        guard engine.compositionState != .idle else { return }
        pendingComposition = false
        scheduleCompositionFlush()
    }
    func testingSetMarkedText(_ value: Any, selectedRange: NSRange, replacementRange: NSRange) {
        textView.setMarkedText(value, selectedRange: selectedRange, replacementRange: replacementRange)
    }
    func testingUnmarkText() { textView.unmarkText() }
    func testingInsertText(_ value: Any, replacementRange: NSRange) { textView.insertText(value, replacementRange: replacementRange) }
    func testingCompositionReplacement() -> String? { engine.compositionReplacement() }
    func testingDisplayedString() -> String { textView.attributedString().string }
    func testingRequestFocus(generation: Int, selection: LoroNativeRichTextSelection? = nil) {
        requestFocus(generation: generation, selection: selection)
    }
    func testingSelection() -> LoroNativeRichTextSelection? { scalarSelection() }
    func testingSetFocusAttempt(_ attempt: @escaping () -> Bool) {
        #if DEBUG
        testingFocusAttempt = attempt
        #endif
    }
    func testingNotifyViewDidMoveToWindow() { didMoveToWindow() }
    func testingNotifyFocusChanged(_ isFocused: Bool) { didChangeFocus(isFocused) }
    func testingCompletedFocusGeneration() -> Int { completedFocusGeneration }
    fileprivate func beginComposition(range: NSRange) { testingBeginComposition(range: range) }
    fileprivate func updateComposition(_ replacement: String) { testingChangeComposition(replacement) }
    fileprivate func endComposition() { testingEndComposition() }
    fileprivate var hasPendingComposition: Bool { engine.compositionState != .idle }
    fileprivate func finalizeComposition(with replacement: String) {
        engine.finalizeComposition(replacement)
    }

    private func fulfillFocusRequestIfPossible() {
        guard isEditableInput, let generation = pendingFocusGeneration else { return }
        let didFocus: Bool
        #if DEBUG
        if let testingFocusAttempt {
            didFocus = testingFocusAttempt()
        } else {
            didFocus = textView.window?.makeFirstResponder(textView) ?? false
        }
        #else
        didFocus = textView.window?.makeFirstResponder(textView) ?? false
        #endif
        guard didFocus else { return }
        if let selection = pendingFocusSelection,
           let range = try? LoroNativeRichTextCodec.utf16Range(forScalarSelection: selection, in: semanticStorage) {
            textView.setSelectedRange(range)
            engine.setSelection(selection)
        }
        completedFocusGeneration = generation
        pendingFocusGeneration = nil
        pendingFocusSelection = nil
    }

    private func replace(range: NSRange, withPlainText replacement: String) -> Bool {
        apply(engine.replace(utf16Range: range, withPlainText: replacement))
    }

    @discardableResult
    fileprivate func openReference(atUTF16Offset offset: Int) -> Bool {
        guard !pendingComposition,
              let reference = LoroNativeRichTextCodec.reference(atUTF16Offset: offset, in: semanticStorage)
        else { return false }
        onOpenReference(reference)
        return true
    }

    @discardableResult
    fileprivate func openReferenceAtCurrentSelection() -> Bool {
        let range = textView.selectedRange()
        guard range.location != NSNotFound else { return false }
        let offset = range.location < semanticStorage.length ? range.location : range.location - 1
        return openReference(atUTF16Offset: offset)
    }

    @discardableResult
    private func apply(_ effect: LoroNativeRichEditingEffect) -> Bool {
        switch effect {
        case let .publish(document, selection):
            render(document, preserving: selection)
            onDocumentChange(document)
        case let .restore(document, selection):
            render(document, preserving: selection)
        case let .rejected(reason):
            reject(reason)
        case .noChange:
            break
        }
        return false // The controller always performs a validated render itself.
    }

    private func render(_ document: LoroNativeRichDocumentV1, preserving selection: LoroNativeRichTextCodec.ScalarSelection?) {
        guard let rendered = try? LoroNativeRichTextCodec.attributedString(for: document) else { return }
        rendering = true; defer { rendering = false }
        semanticStorage = NSMutableAttributedString(attributedString: rendered)
        textView.textStorage?.setAttributedString(rendered)
        applyTemporaryPresentation()
        // NSTextView can install a default `NSOriginalFont` while it lays out a temporary font.
        // It is presentation residue, never an admitted semantic attribute.
        textView.textStorage?.removeAttribute(.font, range: NSRange(location: 0, length: rendered.length))
        textView.textStorage?.removeAttribute(NSAttributedString.Key("NSOriginalFont"), range: NSRange(location: 0, length: rendered.length))
        if let scalar = selection, let range = try? LoroNativeRichTextCodec.utf16Range(forScalarSelection: scalar, in: rendered) { textView.setSelectedRange(range) }
    }

    private func applyTemporaryPresentation() {
        guard let layout = textView.layoutManager, let storage = textView.textStorage else { return }
        layout.removeTemporaryAttribute(.font, forCharacterRange: NSRange(location: 0, length: storage.length))
        layout.removeTemporaryAttribute(.foregroundColor, forCharacterRange: NSRange(location: 0, length: storage.length))
        layout.removeTemporaryAttribute(.underlineStyle, forCharacterRange: NSRange(location: 0, length: storage.length))
        storage.enumerateAttribute(Marker.block, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            guard let marker = value as? String, marker.hasPrefix("heading-") else { return }
            let level = CGFloat(Int(marker.dropFirst(8)) ?? 1)
            layout.addTemporaryAttribute(.font, value: NSFont.boldSystemFont(ofSize: 22 - level * 2), forCharacterRange: range)
        }
        storage.enumerateAttribute(Marker.marks, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            guard let marks = value as? String else { return }
            if marks.contains("strong") { layout.addTemporaryAttribute(.font, value: NSFont.boldSystemFont(ofSize: NSFont.systemFontSize), forCharacterRange: range) }
            if marks.contains("code") { layout.addTemporaryAttribute(.font, value: NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular), forCharacterRange: range) }
            if marks.contains("emphasis") { layout.addTemporaryAttribute(.obliqueness, value: 0.18, forCharacterRange: range) }
        }
        storage.enumerateAttribute(Marker.reference, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            guard value != nil else { return }
            layout.addTemporaryAttribute(.foregroundColor, value: NSColor.controlAccentColor, forCharacterRange: range)
            layout.addTemporaryAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, forCharacterRange: range)
        }
    }

    private func scalarSelection() -> LoroNativeRichTextCodec.ScalarSelection? {
        try? LoroNativeRichTextCodec.scalarSelection(forUTF16Range: textView.selectedRange(), in: textView.attributedString())
    }

    private func flushAfterCompositionIfNeeded() {
        pendingComposition = textView.hasMarkedText()
        guard !pendingComposition, engine.compositionState != .idle else { return }
        scheduleCompositionFlush()
    }

    private func scheduleCompositionFlush() {
        let generation = hostCompositionGeneration
        guard scheduledFlushGeneration != generation else { return }
        scheduledFlushGeneration = generation
        DispatchQueue.main.async { [weak self] in
            guard let self, self.scheduledFlushGeneration == generation else { return }
            self.scheduledFlushGeneration = nil
            guard generation == self.hostCompositionGeneration else { return }
            guard !self.textView.hasMarkedText() else { self.pendingComposition = true; return }
            self.commitComposition()
        }
    }

    private func commitComposition() {
        guard isEditableInput else { cancelComposition(); return }
        pendingComposition = false
        // Never decode AppKit's marked/presentation attributed storage. The engine commits from
        // its captured semantic base and final plain string instead.
        _ = apply(engine.commitComposition())
        reconcileDeferredParentIfPossible()
    }

    private func cancelComposition() {
        hostCompositionGeneration &+= 1
        scheduledFlushGeneration = nil
        pendingComposition = false
        textView.cancelMarkedText()
        _ = apply(engine.cancelComposition())
        reconcileDeferredParentIfPossible()
    }

    private func reconcileDeferredParentIfPossible() {
        guard engine.compositionState == .idle, let document = deferredParentDocument else { return }
        deferredParentDocument = nil
        switch engine.receiveParentDocument(document) {
        case let .adopted(document, selection), let .acknowledged(document, selection):
            render(document, preserving: selection)
        case .deferredForComposition:
            deferredParentDocument = document
        case .deferredForLocalProposal, .unchanged:
            return
        }
    }
}

private final class GuardedRichTextView: NSTextView {
    weak var controller: LoroNativeRichTextEditorController?
    private var isUnmarking = false
    private var suppressCompositionCallbacks = false
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        controller?.didMoveToWindow()
    }
    override func becomeFirstResponder() -> Bool {
        let didBecome = super.becomeFirstResponder()
        if didBecome { controller?.didChangeFocus(true) }
        return didBecome
    }
    override func resignFirstResponder() -> Bool {
        let didResign = super.resignFirstResponder()
        if didResign { controller?.didChangeFocus(false) }
        return didResign
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if controller?.handleFormattingShortcut(
            charactersIgnoringModifiers: event.charactersIgnoringModifiers,
            modifierFlags: event.modifierFlags
        ) == true {
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
    override func keyDown(with event: NSEvent) {
        if controller?.handleFormattingShortcut(
            charactersIgnoringModifiers: event.charactersIgnoringModifiers,
            modifierFlags: event.modifierFlags
        ) == true {
            return
        }
        super.keyDown(with: event)
    }
    override func mouseDown(with event: NSEvent) {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if modifiers == .command,
           let layoutManager,
           let textContainer {
            let viewPoint = convert(event.locationInWindow, from: nil)
            let point = LoroNativeRichTextCodec.textContainerPoint(viewPoint, origin: textContainerOrigin)
            let index = layoutManager.characterIndex(for: point, in: textContainer, fractionOfDistanceBetweenInsertionPoints: nil)
            guard index >= 0, index < string.utf16.count else { super.mouseDown(with: event); return }
            let glyphRange = layoutManager.glyphRange(forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil)
            let glyphRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
            if LoroNativeRichTextCodec.admitsReferenceHit(characterIndex: index, textLength: string.utf16.count, textContainerPoint: point, glyphRect: glyphRect),
               controller?.openReference(atUTF16Offset: index) == true { return }
        }
        super.mouseDown(with: event)
    }
    override func paste(_ sender: Any?) { controller?.paste(.general) }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool { controller?.reject(.attributedPaste); return false }
    override func readSelection(from pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool { controller?.reject(.attributedPaste); return false }
    override func validRequestor(forSendType sendType: NSPasteboard.PasteboardType?, returnType: NSPasteboard.PasteboardType?) -> Any? { nil }
    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        guard !suppressCompositionCallbacks else {
            super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
            return
        }
        // `setMarkedText` bypasses normal key editing. Reject before calling AppKit so a disabled
        // editor cannot even acquire transient marked display text.
        guard isEditable else { controller?.reject(.disabled); return }
        let range = replacementRange.location == NSNotFound ? self.selectedRange() : replacementRange
        if !hasMarkedText() { controller?.beginComposition(range: range) }
        if !isUnmarking {
            controller?.updateComposition(plainString(from: string))
        }
        super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
    }
    override func insertText(_ string: Any, replacementRange: NSRange) {
        guard !suppressCompositionCallbacks else { super.insertText(string, replacementRange: replacementRange); return }
        guard isEditable else { controller?.reject(.disabled); return }
        if controller?.hasPendingComposition == true {
            controller?.finalizeComposition(with: plainString(from: string))
            super.insertText(string, replacementRange: replacementRange)
            // `insertText` can precede or follow `unmarkText`; the controller's guarded scheduler
            // de-duplicates both paths and commits the final plain string exactly once.
            controller?.endComposition()
            return
        }
        super.insertText(string, replacementRange: replacementRange)
    }
    override func unmarkText() {
        guard !suppressCompositionCallbacks else { super.unmarkText(); return }
        isUnmarking = true
        defer { isUnmarking = false }
        super.unmarkText()
        controller?.endComposition()
    }
    func cancelMarkedText() {
        suppressCompositionCallbacks = true
        defer { suppressCompositionCallbacks = false }
        super.unmarkText()
    }

    private func plainString(from value: Any) -> String {
        (value as? NSAttributedString)?.string
            ?? (value as? String)
            ?? (value as? NSString).map { $0 as String }
            ?? ""
    }
}
#endif
