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
    let onDocumentChange: (LoroNativeRichDocumentV1) -> Void
    let onSelectionChange: (LoroNativeRichTextCodec.ScalarSelection) -> Void
    let onRejectedInput: (LoroNativeRichTextEditorController.Rejection) -> Void

    func makeCoordinator() -> LoroNativeRichTextEditorController {
        LoroNativeRichTextEditorController(document: state.document, isEditable: isEditable,
                                           onDocumentChange: onDocumentChange,
                                           onSelectionChange: onSelectionChange,
                                           onRejectedInput: onRejectedInput)
    }

    func makeNSView(context: Context) -> NSScrollView { context.coordinator.makeScrollView() }

    func updateNSView(_ view: NSScrollView, context: Context) {
        context.coordinator.update(document: state.document, isEditable: isEditable)
        context.coordinator.requestFocus(generation: focusRequestGeneration)
    }
}

/// Kept separate from the representable so its editing boundary can be exercised without a
/// SwiftUI host.  Storage only ever contains the codec's private marker attributes.
final class LoroNativeRichTextEditorController: NSObject, NSTextViewDelegate {
    enum Rejection: Equatable { case disabled, attributedPaste, invalidEdit }

    private enum Marker {
        static let marks = NSAttributedString.Key("dev.athenaeum.rich.marks.v1")
        static let block = NSAttributedString.Key("dev.athenaeum.rich.block.v1")
        static let separatorBefore = NSAttributedString.Key("dev.athenaeum.rich.separator-before.v1")
        static let separatorAfter = NSAttributedString.Key("dev.athenaeum.rich.separator-after.v1")
    }

    private let textView: GuardedRichTextView
    /// Authoritative semantic storage. AppKit may synthesize font defaults for display; this
    /// value is what is decoded, validated, and rendered, and contains marker attrs only.
    private var semanticStorage = NSMutableAttributedString()
    private var admitted: LoroNativeRichDocumentV1
    private var admittedSelection = LoroNativeRichTextCodec.ScalarSelection(location: 0, length: 0)
    private var rendering = false
    private var pendingComposition = false
    private var compositionGeneration = 0
    private var scheduledFlushGeneration: Int?
    private var compositionFinalized = false
    private var composition: (base: NSAttributedString, range: NSRange, replacement: String)?
    private var pendingLocal: LoroNativeRichDocumentV1?
    private var isEditableInput: Bool
    private var completedFocusGeneration = 0
    private var pendingFocusGeneration: Int?
    #if DEBUG
    /// Test-only responder result seam. Production always asks this controller's own window.
    private var testingFocusAttempt: (() -> Bool)?
    #endif
    private let onDocumentChange: (LoroNativeRichDocumentV1) -> Void
    private let onSelectionChange: (LoroNativeRichTextCodec.ScalarSelection) -> Void
    private let onRejectedInput: (Rejection) -> Void

    init(document: LoroNativeRichDocumentV1, isEditable: Bool,
         onDocumentChange: @escaping (LoroNativeRichDocumentV1) -> Void = { _ in },
         onSelectionChange: @escaping (LoroNativeRichTextCodec.ScalarSelection) -> Void = { _ in },
         onRejectedInput: @escaping (Rejection) -> Void = { _ in }) {
        admitted = document; isEditableInput = isEditable
        self.onDocumentChange = onDocumentChange; self.onSelectionChange = onSelectionChange; self.onRejectedInput = onRejectedInput
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
        if wasEditable, !isEditable, (composition != nil || pendingComposition || textView.hasMarkedText()) {
            cancelComposition()
            return
        }
        // Parent refreshes are deliberately inert during IME and while a local proposal remains
        // admitted locally; otherwise a SwiftUI update can destroy marked text or the caret.
        guard !pendingComposition, !textView.hasMarkedText() else { return }
        if let pendingLocal {
            if document == pendingLocal { self.pendingLocal = nil; admitted = document }
            return
        }
        guard document != admitted else { return }
        let selection = scalarSelection()
        admitted = document
        render(document, preserving: selection)
    }

    /// Stores a SwiftUI request until this editor has an actual window. The controller owns no
    /// global window state, and it never makes a disabled editor first responder.
    func requestFocus(generation: Int) {
        guard generation > completedFocusGeneration else { return }
        pendingFocusGeneration = max(pendingFocusGeneration ?? 0, generation)
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
        admittedSelection = selection; onSelectionChange(selection)
    }

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
        render(admitted, preserving: admittedSelection)
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
        let candidate = NSMutableAttributedString(attributedString: semanticStorage)
        let existing = candidate.attribute(Marker.marks, at: range.location, effectiveRange: nil) as? String ?? ""
        var marks = existing.isEmpty ? [] : existing.split(separator: ",").map(String.init)
        if let index = marks.firstIndex(of: mark.rawValue) { marks.remove(at: index) } else { marks.append(mark.rawValue) }
        let canonical = ["code", "emphasis", "strong"].filter(marks.contains).joined(separator: ",")
        if canonical.isEmpty { candidate.removeAttribute(Marker.marks, range: range) }
        else { candidate.addAttribute(Marker.marks, value: canonical, range: range) }
        admit(candidate, selection: range)
    }

    /// Consumes only the standard rich-writing shortcuts that this editor can represent
    /// losslessly. Unsupported shortcuts continue through AppKit unchanged.
    fileprivate func handleFormattingShortcut(
        charactersIgnoringModifiers: String?,
        modifierFlags: NSEvent.ModifierFlags
    ) -> Bool {
        let modifiers = modifierFlags.intersection(.deviceIndependentFlagsMask)
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
    func testingDocument() -> LoroNativeRichDocumentV1 { admitted }
    func testingStorage() -> NSAttributedString { semanticStorage.copy() as! NSAttributedString }
    func testingReplace(_ range: NSRange, with string: String) { _ = replace(range: range, withPlainText: string) }
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
        guard isEditableInput, !pendingComposition, range.location >= 0, NSMaxRange(range) <= semanticStorage.length else { reject(.disabled); return }
        compositionGeneration &+= 1
        scheduledFlushGeneration = nil
        compositionFinalized = false
        pendingComposition = true
        composition = (semanticStorage.copy() as! NSAttributedString, range, "")
    }
    func testingChangeComposition(_ replacement: String) {
        guard !compositionFinalized, var composition else { return }
        composition.replacement = replacement
        self.composition = composition
    }
    func testingEndComposition() {
        guard composition != nil else { return }
        pendingComposition = false
        scheduleCompositionFlush()
    }
    func testingSetMarkedText(_ value: Any, selectedRange: NSRange, replacementRange: NSRange) {
        textView.setMarkedText(value, selectedRange: selectedRange, replacementRange: replacementRange)
    }
    func testingUnmarkText() { textView.unmarkText() }
    func testingInsertText(_ value: Any, replacementRange: NSRange) { textView.insertText(value, replacementRange: replacementRange) }
    func testingCompositionReplacement() -> String? { composition?.replacement }
    func testingDisplayedString() -> String { textView.attributedString().string }
    func testingRequestFocus(generation: Int) { requestFocus(generation: generation) }
    func testingSetFocusAttempt(_ attempt: @escaping () -> Bool) {
        #if DEBUG
        testingFocusAttempt = attempt
        #endif
    }
    func testingNotifyViewDidMoveToWindow() { didMoveToWindow() }
    func testingCompletedFocusGeneration() -> Int { completedFocusGeneration }
    fileprivate func beginComposition(range: NSRange) { testingBeginComposition(range: range) }
    fileprivate func updateComposition(_ replacement: String) { testingChangeComposition(replacement) }
    fileprivate func endComposition() { testingEndComposition() }
    fileprivate var hasPendingComposition: Bool { composition != nil }
    fileprivate func finalizeComposition(with replacement: String) {
        guard var composition else { return }
        composition.replacement = replacement
        self.composition = composition
        compositionFinalized = true
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
        completedFocusGeneration = generation
        pendingFocusGeneration = nil
    }

    private func replace(range: NSRange, withPlainText replacement: String) -> Bool {
        replace(in: semanticStorage, range: range, withPlainText: replacement)
    }

    @discardableResult
    private func admit(_ candidate: NSAttributedString, selection: NSRange) -> Bool {
        guard let decoded = try? LoroNativeRichTextCodec.decode(candidate),
              let canonical = try? LoroNativeRichTextCodec.attributedString(for: decoded),
              (try? LoroNativeRichTextCodec.decode(canonical)) == decoded else { reject(.invalidEdit); return false }
        admitted = decoded
        pendingLocal = decoded
        admittedSelection = (try? LoroNativeRichTextCodec.scalarSelection(forUTF16Range: selection, in: canonical)) ?? admittedSelection
        render(decoded, preserving: admittedSelection)
        onDocumentChange(decoded)
        return false // we performed the one validated storage replacement ourselves.
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
    }

    private func scalarSelection() -> LoroNativeRichTextCodec.ScalarSelection? {
        try? LoroNativeRichTextCodec.scalarSelection(forUTF16Range: textView.selectedRange(), in: textView.attributedString())
    }

    private func flushAfterCompositionIfNeeded() {
        pendingComposition = textView.hasMarkedText()
        guard !pendingComposition, composition != nil else { return }
        scheduleCompositionFlush()
    }

    private func scheduleCompositionFlush() {
        let generation = compositionGeneration
        guard scheduledFlushGeneration != generation else { return }
        scheduledFlushGeneration = generation
        DispatchQueue.main.async { [weak self] in
            guard let self, self.scheduledFlushGeneration == generation else { return }
            self.scheduledFlushGeneration = nil
            guard generation == self.compositionGeneration else { return }
            guard !self.textView.hasMarkedText() else { self.pendingComposition = true; return }
            self.commitComposition()
        }
    }

    private func commitComposition() {
        guard isEditableInput else { cancelComposition(); return }
        guard let composition else { return }
        pendingComposition = false; self.composition = nil; compositionFinalized = false
        // Never decode AppKit's marked/presentation attributed storage.  Rebuild from the
        // captured marker-only snapshot and the committed plain text instead.
        _ = replace(in: composition.base, range: composition.range, withPlainText: composition.replacement)
    }

    private func cancelComposition() {
        compositionGeneration &+= 1
        scheduledFlushGeneration = nil
        pendingComposition = false
        compositionFinalized = false
        composition = nil
        textView.cancelMarkedText()
        render(admitted, preserving: admittedSelection)
    }

    private func replace(in base: NSAttributedString, range: NSRange, withPlainText replacement: String) -> Bool {
        guard range.location >= 0, range.length >= 0, NSMaxRange(range) <= base.length else { reject(.invalidEdit); return false }
        guard let document = try? LoroNativeRichTextCodec.decode(base),
              let candidate = semanticSplice(document, utf16Range: range, replacement: replacement),
              let rendered = try? LoroNativeRichTextCodec.attributedString(for: candidate) else { reject(.invalidEdit); return false }
        return admit(rendered, selection: NSRange(location: range.location + replacement.utf16.count, length: 0))
    }

    /// The only text edit path. It is value-level: both the affected block and all inherited
    /// marks come from a decoded canonical document, never from AppKit's display storage.
    private func semanticSplice(_ document: LoroNativeRichDocumentV1, utf16Range: NSRange, replacement: String) -> LoroNativeRichDocumentV1? {
        guard let rendered = try? LoroNativeRichTextCodec.attributedString(for: document),
              let scalarRange = try? LoroNativeRichTextCodec.scalarSelection(forUTF16Range: utf16Range, in: rendered)
        else { return nil }

        typealias Block = LoroCanonicalSemanticValueV1.Block
        typealias Run = LoroCanonicalSemanticValueV1.TextRun
        func runs(in block: Block) -> [Run] { switch block { case let .paragraph(r), let .heading(_, r): return r } }
        func scalarCount(_ runs: [Run]) -> Int { runs.reduce(0) { $0 + $1.text.unicodeScalars.count } }
        func makeLike(_ block: Block, runs: [Run]) -> Block { if case let .heading(level, _) = block { return .heading(level: level, runs: runs) }; return .paragraph(runs) }
        func coalesced(_ runs: [Run]) -> [Run] {
            runs.reduce(into: []) { result, run in
                guard !run.text.isEmpty else { return }
                if let last = result.last, last.marks == run.marks { result[result.count - 1] = .init(text: last.text + run.text, marks: last.marks) }
                else { result.append(run) }
            }
        }
        func split(_ runs: [Run], at scalarOffset: Int) -> ([Run], [Run]) {
            var prefix: [Run] = []; var suffix: [Run] = []; var remaining = scalarOffset
            for run in runs {
                let count = run.text.unicodeScalars.count
                if remaining <= 0 { suffix.append(run) }
                else if remaining >= count { prefix.append(run); remaining -= count }
                else {
                    let scalars = run.text.unicodeScalars
                    let splitIndex = scalars.index(scalars.startIndex, offsetBy: remaining)
                    prefix.append(.init(text: String(scalars[..<splitIndex]), marks: run.marks))
                    suffix.append(.init(text: String(scalars[splitIndex...]), marks: run.marks))
                    remaining = 0
                }
            }
            return (coalesced(prefix), coalesced(suffix))
        }

        var starts: [Int] = []; var cursor = 0
        for block in document.semantic.blocks { starts.append(cursor); cursor += scalarCount(runs(in: block)) + 1 }
        let totalScalars = rendered.string.unicodeScalars.count
        func owningBlock(for scalarOffset: Int) -> Int? {
            guard scalarOffset <= totalScalars else { return nil }
            for index in document.semantic.blocks.indices {
                let end = starts[index] + scalarCount(runs(in: document.semantic.blocks[index]))
                if scalarOffset >= starts[index], scalarOffset <= end { return index }
            }
            return nil
        }
        let scalarEnd = scalarRange.location + scalarRange.length
        guard let blockIndex = owningBlock(for: scalarRange.location),
              owningBlock(for: scalarEnd) == blockIndex
        else { return nil } // A range that includes a separator is rejected atomically.

        let original = document.semantic.blocks[blockIndex]
        let originalRuns = runs(in: original)
        let localStart = scalarRange.location - starts[blockIndex]
        let localEnd = scalarEnd - starts[blockIndex]
        let prefix = split(originalRuns, at: localStart).0
        let suffix = split(originalRuns, at: localEnd).1
        var traversed = 0
        let inherited = originalRuns.first { run in
            defer { traversed += run.text.unicodeScalars.count }
            return localStart < traversed + run.text.unicodeScalars.count
        }?.marks ?? originalRuns.last?.marks ?? []
        let lines = replacement.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var emitted: [Block] = []
        for index in lines.indices {
            var lineRuns = index == lines.startIndex ? prefix : []
            if !lines[index].isEmpty { lineRuns.append(.init(text: lines[index], marks: inherited)) }
            if index == lines.index(before: lines.endIndex) { lineRuns += suffix }
            emitted.append(index == lines.startIndex ? makeLike(original, runs: coalesced(lineRuns)) : .paragraph(coalesced(lineRuns)))
        }
        var blocks = document.semantic.blocks
        blocks.replaceSubrange(blockIndex...blockIndex, with: emitted)
        return .init(semantic: .init(blocks: blocks))
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
