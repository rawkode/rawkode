#if os(iOS)
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import AthenaeumCore

/// UIKit's native adapter for the shared, lossless semantic editing engine. It deliberately owns
/// no durable document state: every accepted mutation is reduced by `LoroNativeRichEditingEngine`.
struct LoroNativeRichTextEditorUIKit: UIViewRepresentable {
    let state: LoroNativeRichEditorState
    let isEditable: Bool
    let focusRequestGeneration: Int
    /// Optional scalar selection captured before an editor-adjacent command moved focus. It is
    /// consumed only with the matching focus generation, never on ordinary SwiftUI updates.
    let focusRequestSelection: LoroNativeRichTextSelection?
    /// A picker result is a one-shot command keyed by the trigger generation. The controller
    /// validates the captured range against its current semantic document before admitting it.
    let mentionInsertion: LoroNativeRichTextMentionInsertion?
    let onDocumentChange: (LoroNativeRichDocumentV1) -> Void
    let onSelectionChange: (LoroNativeRichTextSelection) -> Void
    let onRejectedInput: (LoroNativeRichTextEditorRejection) -> Void
    /// Presentation-only responder state. Durable editing semantics stay in the engine.
    let onFocusChange: (Bool) -> Void
    /// Semantic activation stays typed; routing belongs to the parent workspace surface.
    let onOpenReference: (LoroCanonicalSemanticValueV1.InlineReference) -> Void
    /// The host owns the SwiftUI picker; the adapter only reports an immutable trigger snapshot.
    let onMentionQueryChange: (LoroNativeRichTextMentionContext?) -> Void

    init(
        state: LoroNativeRichEditorState,
        isEditable: Bool,
        focusRequestGeneration: Int,
        focusRequestSelection: LoroNativeRichTextSelection?,
        mentionInsertion: LoroNativeRichTextMentionInsertion? = nil,
        onDocumentChange: @escaping (LoroNativeRichDocumentV1) -> Void,
        onSelectionChange: @escaping (LoroNativeRichTextSelection) -> Void,
        onRejectedInput: @escaping (LoroNativeRichTextEditorRejection) -> Void,
        onFocusChange: @escaping (Bool) -> Void,
        onOpenReference: @escaping (LoroCanonicalSemanticValueV1.InlineReference) -> Void,
        onMentionQueryChange: @escaping (LoroNativeRichTextMentionContext?) -> Void = { _ in }
    ) {
        self.state = state
        self.isEditable = isEditable
        self.focusRequestGeneration = focusRequestGeneration
        self.focusRequestSelection = focusRequestSelection
        self.mentionInsertion = mentionInsertion
        self.onDocumentChange = onDocumentChange
        self.onSelectionChange = onSelectionChange
        self.onRejectedInput = onRejectedInput
        self.onFocusChange = onFocusChange
        self.onOpenReference = onOpenReference
        self.onMentionQueryChange = onMentionQueryChange
    }

    func makeCoordinator() -> LoroNativeRichTextEditorUIKitController {
        .init(
            document: state.document,
            isEditable: isEditable,
            onDocumentChange: onDocumentChange,
            onSelectionChange: onSelectionChange,
            onRejectedInput: onRejectedInput,
            onFocusChange: onFocusChange,
            onOpenReference: onOpenReference,
            onMentionQueryChange: onMentionQueryChange
        )
    }

    func makeUIView(context: Context) -> UITextView { context.coordinator.makeTextView() }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.update(document: state.document, isEditable: isEditable)
        context.coordinator.requestFocus(generation: focusRequestGeneration, selection: focusRequestSelection)
        context.coordinator.applyMentionInsertion(mentionInsertion)
    }

    static func dismantleUIView(_ view: UITextView, coordinator: LoroNativeRichTextEditorUIKitController) {
        coordinator.dismantle()
    }
}

/// Kept separate from the representable for iOS-focused tests. The controller enforces three
/// invariants: the engine is the only semantic authority; non-plain ingress is rejected before it
/// can publish; and parent replacement waits for marked composition to be committed or cancelled.
@MainActor
final class LoroNativeRichTextEditorUIKitController: NSObject, UITextViewDelegate, UITextPasteDelegate, UITextDropDelegate, UIGestureRecognizerDelegate {
    private enum Marker {
        static let marks = NSAttributedString.Key("dev.athenaeum.rich.marks.v1")
        static let reference = NSAttributedString.Key("dev.athenaeum.rich.reference.v1")
        static let block = NSAttributedString.Key("dev.athenaeum.rich.block.v1")
    }

    private let textView = GuardedUIKitRichTextView(frame: .zero, textContainer: nil)
    private let referenceTap = UITapGestureRecognizer()
    private var engine: LoroNativeRichEditingEngine
    private var rendering = false
    private var pendingComposition = false
    private var hostCompositionGeneration = 0
    private var scheduledFlushGeneration: Int?
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
    private let onRejectedInput: (LoroNativeRichTextEditorRejection) -> Void
    private let onFocusChange: (Bool) -> Void
    private let onOpenReference: (LoroCanonicalSemanticValueV1.InlineReference) -> Void
    private let onMentionQueryChange: (LoroNativeRichTextMentionContext?) -> Void
    private var nextMentionGeneration = 0
    private var lastMentionContext: LoroNativeRichTextMentionContext?
    private var lastAppliedMentionGeneration = 0

    init(
        document: LoroNativeRichDocumentV1,
        isEditable: Bool,
        onDocumentChange: @escaping (LoroNativeRichDocumentV1) -> Void = { _ in },
        onSelectionChange: @escaping (LoroNativeRichTextSelection) -> Void = { _ in },
        onRejectedInput: @escaping (LoroNativeRichTextEditorRejection) -> Void = { _ in },
        onFocusChange: @escaping (Bool) -> Void = { _ in },
        onOpenReference: @escaping (LoroCanonicalSemanticValueV1.InlineReference) -> Void = { _ in },
        onMentionQueryChange: @escaping (LoroNativeRichTextMentionContext?) -> Void = { _ in }
    ) {
        engine = .init(document: document)
        isEditableInput = isEditable
        self.onDocumentChange = onDocumentChange
        self.onSelectionChange = onSelectionChange
        self.onRejectedInput = onRejectedInput
        self.onFocusChange = onFocusChange
        self.onOpenReference = onOpenReference
        self.onMentionQueryChange = onMentionQueryChange
        super.init()
        textView.richController = self
        textView.delegate = self
        textView.pasteDelegate = self
        textView.textDropDelegate = self
        textView.pasteConfiguration = .init(acceptableTypeIdentifiers: [UTType.plainText.identifier])
        textView.allowsEditingTextAttributes = false
        textView.isEditable = isEditable
        textView.isSelectable = true
        textView.alwaysBounceVertical = true
        textView.backgroundColor = .clear
        textView.smartQuotesType = .no
        textView.smartDashesType = .no
        textView.smartInsertDeleteType = .no
        textView.autocorrectionType = .no
        textView.textDragInteraction?.isEnabled = false
        textView.accessibilityLabel = "Rich text editor. References are links."
        textView.accessibilityCustomActions = [
            UIAccessibilityCustomAction(name: "Open linked reference") { [weak self] _ in
                self?.openReferenceAtCurrentSelection() ?? false
            }
        ]
        referenceTap.addTarget(self, action: #selector(handleReferenceTap(_:)))
        referenceTap.delegate = self
        referenceTap.cancelsTouchesInView = false
        referenceTap.delaysTouchesBegan = false
        textView.addGestureRecognizer(referenceTap)
        render(document, preserving: nil)
    }

    func makeTextView() -> UITextView { textView }

    func update(document: LoroNativeRichDocumentV1, isEditable: Bool) {
        let wasEditable = isEditableInput
        isEditableInput = isEditable
        textView.isEditable = isEditable
        if !isEditable { invalidateMentionContext() }
        if !wasEditable, isEditable { fulfillFocusRequestIfPossible() }
        if wasEditable, !isEditable, (engine.compositionState != .idle || pendingComposition || hasMarkedText) {
            deferredParentDocument = document
            cancelComposition()
            return
        }
        if let selection = scalarSelection() { engine.setSelection(selection) }
        switch engine.receiveParentDocument(document) {
        case let .adopted(document, selection):
            // A remote replacement may happen to contain the same visible trigger. It still
            // needs a new generation so a picker result from the prior document cannot apply.
            invalidateMentionContext()
            render(document, preserving: selection)
        case let .acknowledged(document, selection):
            invalidateMentionContext()
            render(document, preserving: selection)
        case .deferredForComposition:
            deferredParentDocument = document
        case .deferredForLocalProposal, .unchanged:
            publishMentionContext()
            return
        }
        publishMentionContext()
    }

    func requestFocus(generation: Int, selection: LoroNativeRichTextSelection? = nil) {
        guard generation > completedFocusGeneration else { return }
        pendingFocusGeneration = max(pendingFocusGeneration ?? 0, generation)
        pendingFocusSelection = selection
        fulfillFocusRequestIfPossible()
    }

    func dismantle() {
        guard engine.compositionState != .idle || pendingComposition || hasMarkedText else { return }
        // Teardown cannot leave a transient input-method value in storage. A finalized string has
        // already been captured through `insertText`; incomplete marked text is cancelled.
        if engine.compositionReplacement() != nil, !hasMarkedText {
            commitComposition()
        } else {
            cancelComposition()
        }
    }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        guard !rendering else { return false }
        guard isEditableInput else { reject(.disabled); return false }
        guard !text.contains("\u{FFFC}") else { reject(.attributedPaste); return false }
        // UIKit owns transient marked presentation. We only accept its final plain string through
        // the shared engine after unmark/insert establishes an exactly-once boundary.
        guard !pendingComposition, !hasMarkedText else { return true }
        return apply(engine.replace(utf16Range: range, withPlainText: text))
    }

    func textViewDidChange(_ textView: UITextView) {
        guard !rendering else { return }
        if pendingComposition || hasMarkedText {
            pendingComposition = hasMarkedText
            if !pendingComposition { scheduleCompositionFlush() }
            return
        }
        // Every intended non-composition write returns false from `shouldChangeTextIn` and is
        // rendered by us. Any other storage change is untrusted and restored atomically.
        guard let displayed = textView.attributedText,
              (try? LoroNativeRichTextCodec.decode(displayed)) == engine.admittedDocument
        else { reject(.invalidEdit); return }
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        guard !rendering, let selection = scalarSelection() else { return }
        engine.setSelection(selection)
        onSelectionChange(selection)
        publishMentionContext()
    }

    fileprivate func didChangeFocus(_ isFocused: Bool) { onFocusChange(isFocused) }

    // MARK: Text input / IME hooks from GuardedUIKitRichTextView

    fileprivate func beginComposition(range: NSRange) {
        guard isEditableInput, !pendingComposition else { reject(.disabled); return }
        let effect = engine.beginComposition(utf16Range: range)
        guard case .noChange = effect else { _ = apply(effect); return }
        hostCompositionGeneration &+= 1
        scheduledFlushGeneration = nil
        pendingComposition = true
        invalidateMentionContext()
    }

    fileprivate func updateComposition(_ replacement: String) { engine.updateComposition(replacement) }

    fileprivate func finalizeComposition(_ replacement: String) { engine.finalizeComposition(replacement) }

    fileprivate var hasPendingComposition: Bool { engine.compositionState != .idle }

    fileprivate func endComposition() {
        guard engine.compositionState != .idle else { return }
        pendingComposition = hasMarkedText
        guard !pendingComposition else { return }
        scheduleCompositionFlush()
    }

    fileprivate func paste(_ pasteboard: UIPasteboard) {
        guard isEditableInput, !pendingComposition, !hasMarkedText else { reject(.disabled); return }
        guard let plain = Self.lonePlainText(from: pasteboard) else { reject(.attributedPaste); return }
        _ = apply(engine.replace(utf16Range: textView.selectedRange, withPlainText: plain))
    }

    /// Inserts an already-resolved semantic reference without exposing UIKit's attributed-text
    /// mutation path. A future SwiftUI picker can call this after it captures its trigger range.
    func insert(
        reference: LoroCanonicalSemanticValueV1.InlineReference,
        replacingUTF16Range range: NSRange
    ) {
        guard isEditableInput, !pendingComposition, !hasMarkedText else {
            reject(.disabled)
            return
        }
        _ = apply(engine.insert(reference: reference, replacingUTF16Range: range))
    }

    fileprivate func reject(_ reason: LoroNativeRichTextEditorRejection) {
        guard !rendering else { return }
        render(engine.admittedDocument, preserving: engine.admittedSelection)
        onRejectedInput(reason)
    }

    // These value-facing seams let the iOS test bundle exercise UIKit policy without making the
    // representable part of daily-note product admission.
    func testingDocument() -> LoroNativeRichDocumentV1 { engine.admittedDocument }
    func testingSelect(_ range: NSRange) {
        textView.selectedRange = range
        if let selection = scalarSelection() { engine.setSelection(selection) }
        publishMentionContext()
    }
    func testingApplyMentionInsertion(_ insertion: LoroNativeRichTextMentionInsertion?) {
        applyMentionInsertion(insertion)
    }
    func testingDismissMentionContext() { dismissMentionContext() }
    func testingSelection() -> LoroNativeRichTextSelection? { scalarSelection() }
    func testingRequestFocus(generation: Int, selection: LoroNativeRichTextSelection? = nil) {
        requestFocus(generation: generation, selection: selection)
    }
    func testingReplace(_ range: NSRange, with text: String) { _ = apply(engine.replace(utf16Range: range, withPlainText: text)) }
    func testingInsert(reference: LoroCanonicalSemanticValueV1.InlineReference, replacingUTF16Range range: NSRange) {
        insert(reference: reference, replacingUTF16Range: range)
    }
    /// Exercises the same plain-text-only admission path as `paste(_:)` without UIPasteboard.
    func testingPastePlainText(_ text: String, at range: NSRange) { _ = apply(engine.replace(utf16Range: range, withPlainText: text)) }
    func testingOpenReference(_ reference: LoroCanonicalSemanticValueV1.InlineReference) { onOpenReference(reference) }
    @discardableResult
    func testingOpenReference(atUTF16Offset offset: Int) -> Bool { openReference(atUTF16Offset: offset) }
    func testingBeginComposition(range: NSRange) { beginComposition(range: range) }
    func testingChangeComposition(_ text: String) { updateComposition(text) }
    func testingFinalizeComposition(_ text: String) { finalizeComposition(text) }
    func testingEndComposition() { endComposition() }
    func testingUpdate(document: LoroNativeRichDocumentV1, isEditable: Bool) { update(document: document, isEditable: isEditable) }
    func testingNotifyFocusChanged(_ isFocused: Bool) { didChangeFocus(isFocused) }
    func testingSetFocusAttempt(_ attempt: @escaping () -> Bool) {
        #if DEBUG
        testingFocusAttempt = attempt
        #endif
    }
    func testingCompletedFocusGeneration() -> Int { completedFocusGeneration }
    static func testingAllowsOnlyLonePlainTextProvider(_ provider: NSItemProvider) -> Bool { isLonePlainTextProvider(provider) }

    // MARK: Paste / drop admission

    func textPasteConfigurationSupporting(
        _ textPasteConfigurationSupporting: UITextPasteConfigurationSupporting,
        transform item: UITextPasteItem
    ) {
        guard isEditableInput, Self.isLonePlainTextProvider(item.itemProvider) else {
            item.setNoResult()
            reject(.attributedPaste)
            return
        }
        item.itemProvider.loadObject(ofClass: NSString.self) { [weak self] object, _ in
            let string = (object as? NSString).map(String.init) ?? ""
            Task { @MainActor [weak self] in
                guard let self, self.isEditableInput else { item.setNoResult(); return }
                item.setResult(string: string)
            }
        }
    }

    func textPasteConfigurationSupporting(
        _ textPasteConfigurationSupporting: UITextPasteConfigurationSupporting,
        performPasteOf attributedString: NSAttributedString,
        to textRange: UITextRange
    ) -> UITextRange {
        guard isEditableInput,
              let range = utf16Range(for: textRange),
              Self.containsOnlyPlainTextAttributes(attributedString)
        else { reject(.attributedPaste); return textRange }
        _ = apply(engine.replace(utf16Range: range, withPlainText: attributedString.string))
        return textRange
    }

    func textDroppableView(
        _ textDroppableView: UIView & UITextDroppable,
        proposalForDrop drop: UITextDropRequest
    ) -> UITextDropProposal {
        guard isEditableInput,
              !pendingComposition,
              !hasMarkedText,
              drop.dropSession.items.count == 1,
              let provider = drop.dropSession.items.first?.itemProvider,
              Self.isLonePlainTextProvider(provider)
        else {
            reject(.attributedPaste)
            return .init(operation: .forbidden)
        }
        return .init(operation: .copy)
    }

    func textDroppableView(_ textDroppableView: UIView & UITextDroppable, willPerformDrop drop: UITextDropRequest) {
        guard drop.dropSession.items.count == 1,
              let provider = drop.dropSession.items.first?.itemProvider,
              Self.isLonePlainTextProvider(provider)
        else { reject(.attributedPaste); return }
    }

    // MARK: Rendering and reconciliation

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
        publishMentionContext()
        return false
    }

    private func render(_ document: LoroNativeRichDocumentV1, preserving selection: LoroNativeRichTextSelection?) {
        guard let rendered = try? LoroNativeRichTextCodec.attributedString(for: document) else { return }
        rendering = true
        defer { rendering = false }
        textView.attributedText = rendered
        textView.textStorage.removeAttribute(.font, range: NSRange(location: 0, length: textView.textStorage.length))
        textView.textStorage.removeAttribute(.link, range: NSRange(location: 0, length: textView.textStorage.length))
        applyTemporaryPresentation()
        if let selection,
           let range = try? LoroNativeRichTextCodec.utf16Range(forScalarSelection: selection, in: rendered) {
            textView.selectedRange = range
        }
    }

    private func applyTemporaryPresentation() {
        // UIKit's current TextKit layout manager has no temporary-attribute surface. Keep its
        // typography on the view (not `textStorage`), so marker attributes remain the sole
        // semantic value. Reference hit testing still reads the typed marker directly; the
        // native rich editor can add a platform-specific visual treatment when UIKit exposes a
        // non-semantic presentation hook again.
        textView.font = .preferredFont(forTextStyle: .body)
        textView.textColor = .label
    }

    /// Consumes only the command for the exact context still visible at the current caret. This
    /// prevents a delayed picker result from applying after a query, caret, or document change.
    func applyMentionInsertion(_ insertion: LoroNativeRichTextMentionInsertion?) {
        guard let insertion else { return }
        guard isEditableInput else { reject(.disabled); return }
        guard !pendingComposition, !hasMarkedText else { reject(.invalidEdit); return }
        guard insertion.generation > lastAppliedMentionGeneration,
              let published = lastMentionContext,
              insertion.generation == published.generation,
              insertion.utf16Range == published.utf16Range,
              scalarSelection() == published.selection,
              let current = LoroNativeRichTextMentionContext.detect(
                  in: textView.attributedText ?? NSAttributedString(),
                  selection: textView.selectedRange
              ),
              current.query == published.query,
              current.utf16Range == published.utf16Range,
              current.selection == published.selection
        else { reject(.invalidEdit); return }
        lastAppliedMentionGeneration = insertion.generation
        insert(reference: insertion.reference, replacingUTF16Range: insertion.utf16Range)
    }

    /// The host calls this when its picker is dismissed without a selection.
    func dismissMentionContext() { invalidateMentionContext() }

    private func publishMentionContext() {
        guard isEditableInput, !pendingComposition, !hasMarkedText,
              let context = LoroNativeRichTextMentionContext.detect(
                  in: textView.attributedText ?? NSAttributedString(),
                  selection: textView.selectedRange
              ) else {
            invalidateMentionContext()
            return
        }

        if let previous = lastMentionContext,
           previous.query == context.query,
           previous.utf16Range == context.utf16Range,
           previous.selection == context.selection {
            return
        }
        nextMentionGeneration &+= 1
        let published = LoroNativeRichTextMentionContext(
            generation: nextMentionGeneration,
            query: context.query,
            utf16Range: context.utf16Range,
            selection: context.selection
        )
        lastMentionContext = published
        onMentionQueryChange(published)
    }

    private func invalidateMentionContext() {
        guard lastMentionContext != nil else { return }
        lastMentionContext = nil
        onMentionQueryChange(nil)
    }

    private func scalarSelection() -> LoroNativeRichTextSelection? {
        try? LoroNativeRichTextCodec.scalarSelection(forUTF16Range: textView.selectedRange, in: textView.attributedText ?? NSAttributedString())
    }

    @discardableResult
    private func openReference(atUTF16Offset offset: Int) -> Bool {
        guard !pendingComposition,
              let rendered = textView.attributedText,
              let reference = LoroNativeRichTextCodec.reference(atUTF16Offset: offset, in: rendered)
        else { return false }
        onOpenReference(reference)
        return true
    }

    @discardableResult
    fileprivate func openReferenceAtCurrentSelection() -> Bool {
        let range = textView.selectedRange
        guard range.location != NSNotFound else { return false }
        let offset = range.location < textView.textStorage.length ? range.location : range.location - 1
        return openReference(atUTF16Offset: offset)
    }

    @objc private func handleReferenceTap(_ recognizer: UITapGestureRecognizer) {
        guard recognizer.state == .ended else { return }
        _ = openReference(atViewPoint: recognizer.location(in: textView))
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard gestureRecognizer === referenceTap, !hasMarkedText else { return false }
        return referenceHit(atViewPoint: touch.location(in: textView)) != nil
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        gestureRecognizer === referenceTap
    }

    private func referenceHit(atViewPoint point: CGPoint) -> Int? {
        // `location(in: textView)` is already in the scroll view's bounds/content coordinate
        // space. TextKit's container origin is the inset only; line-fragment padding belongs to
        // glyph layout and contentOffset must not be applied a second time here.
        let origin = CGPoint(
            x: textView.textContainerInset.left,
            y: textView.textContainerInset.top
        )
        let containerPoint = LoroNativeRichTextCodec.textContainerPoint(point, origin: origin)
        let index = textView.layoutManager.characterIndex(for: containerPoint, in: textView.textContainer, fractionOfDistanceBetweenInsertionPoints: nil)
        guard index >= 0, index < textView.textStorage.length else { return nil }
        let glyphRange = textView.layoutManager.glyphRange(forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil)
        let glyphRect = textView.layoutManager.boundingRect(forGlyphRange: glyphRange, in: textView.textContainer)
        guard LoroNativeRichTextCodec.admitsReferenceHit(characterIndex: index, textLength: textView.textStorage.length, textContainerPoint: containerPoint, glyphRect: glyphRect),
              let rendered = textView.attributedText,
              LoroNativeRichTextCodec.reference(atUTF16Offset: index, in: rendered) != nil
        else { return nil }
        return index
    }

    @discardableResult
    private func openReference(atViewPoint point: CGPoint) -> Bool {
        guard let index = referenceHit(atViewPoint: point) else { return false }
        return openReference(atUTF16Offset: index)
    }

    private func utf16Range(for textRange: UITextRange) -> NSRange? {
        let start = textView.offset(from: textView.beginningOfDocument, to: textRange.start)
        let end = textView.offset(from: textView.beginningOfDocument, to: textRange.end)
        guard start >= 0, end >= start else { return nil }
        return NSRange(location: start, length: end - start)
    }

    private func scheduleCompositionFlush() {
        let generation = hostCompositionGeneration
        guard scheduledFlushGeneration != generation else { return }
        scheduledFlushGeneration = generation
        DispatchQueue.main.async { [weak self] in
            guard let self, self.scheduledFlushGeneration == generation else { return }
            self.scheduledFlushGeneration = nil
            guard generation == self.hostCompositionGeneration, !self.hasMarkedText else { return }
            self.commitComposition()
        }
    }

    private func commitComposition() {
        guard isEditableInput else { cancelComposition(); return }
        pendingComposition = false
        _ = apply(engine.commitComposition())
        reconcileDeferredParentIfPossible()
    }

    private func cancelComposition() {
        hostCompositionGeneration &+= 1
        scheduledFlushGeneration = nil
        pendingComposition = false
        textView.unmarkText()
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
            break
        }
    }

    private func fulfillFocusRequestIfPossible() {
        guard isEditableInput, let generation = pendingFocusGeneration else { return }
        let didFocus: Bool
        #if DEBUG
        if let testingFocusAttempt {
            didFocus = testingFocusAttempt()
        } else {
            guard textView.window != nil else { return }
            didFocus = textView.becomeFirstResponder()
        }
        #else
        guard textView.window != nil else { return }
        didFocus = textView.becomeFirstResponder()
        #endif
        guard didFocus else { return }
        if let selection = pendingFocusSelection,
           let rendered = textView.attributedText,
           let range = try? LoroNativeRichTextCodec.utf16Range(forScalarSelection: selection, in: rendered) {
            textView.selectedRange = range
            engine.setSelection(selection)
        }
        completedFocusGeneration = generation
        pendingFocusGeneration = nil
        pendingFocusSelection = nil
    }

    private var hasMarkedText: Bool { textView.markedTextRange != nil }

    private static let plainTextIdentifiers: Set<String> = [
        UTType.plainText.identifier,
        UTType.utf8PlainText.identifier,
        "public.text"
    ]

    private static func isLonePlainTextProvider(_ provider: NSItemProvider) -> Bool {
        let identifiers = Set(provider.registeredTypeIdentifiers)
        return !identifiers.isEmpty
            && identifiers.isSubset(of: plainTextIdentifiers)
            && identifiers.contains { UTType($0)?.conforms(to: .plainText) == true }
    }

    private static func lonePlainText(from pasteboard: UIPasteboard) -> String? {
        guard pasteboard.items.count == 1,
              let item = pasteboard.items.first,
              Set(item.keys).isSubset(of: plainTextIdentifiers),
              let string = pasteboard.string
        else { return nil }
        return string
    }

    private static func containsOnlyPlainTextAttributes(_ attributed: NSAttributedString) -> Bool {
        var allowed = true
        attributed.enumerateAttributes(in: NSRange(location: 0, length: attributed.length), options: []) { attributes, _, stop in
            // UIKit may supply baseline typography for a plain item. Semantic markers, links,
            // attachments, colours, and arbitrary rich attributes are never an admitted payload.
            let keys = Set(attributes.keys)
            if !keys.isSubset(of: [.font]) || attributed.string.contains("\u{FFFC}") {
                allowed = false
                stop.pointee = true
            }
        }
        return allowed
    }
}

private final class GuardedUIKitRichTextView: UITextView {
    weak var richController: LoroNativeRichTextEditorUIKitController?
    private var suppressCompositionCallbacks = false
    private var unmarking = false

    override func becomeFirstResponder() -> Bool {
        let didBecome = super.becomeFirstResponder()
        if didBecome { richController?.didChangeFocus(true) }
        return didBecome
    }

    override func resignFirstResponder() -> Bool {
        let didResign = super.resignFirstResponder()
        if didResign { richController?.didChangeFocus(false) }
        return didResign
    }

    override func paste(_ sender: Any?) { richController?.paste(.general) }

    override var keyCommands: [UIKeyCommand]? {
        (super.keyCommands ?? []) + [
            UIKeyCommand(input: "\r", modifierFlags: .command, action: #selector(openReferenceShortcut(_:)))
        ]
    }

    @objc private func openReferenceShortcut(_ sender: UIKeyCommand) {
        _ = richController?.openReferenceAtCurrentSelection()
    }

    override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        guard !suppressCompositionCallbacks else { super.setMarkedText(markedText, selectedRange: selectedRange); return }
        guard isEditable else { richController?.reject(.disabled); return }
        if self.markedTextRange == nil { richController?.beginComposition(range: self.selectedRange) }
        if !unmarking { richController?.updateComposition(markedText ?? "") }
        super.setMarkedText(markedText, selectedRange: selectedRange)
    }

    override func insertText(_ text: String) {
        guard !suppressCompositionCallbacks else { super.insertText(text); return }
        guard isEditable else { richController?.reject(.disabled); return }
        if richController?.hasPendingComposition == true {
            richController?.finalizeComposition(text)
            super.insertText(text)
            richController?.endComposition()
            return
        }
        super.insertText(text)
    }

    override func unmarkText() {
        guard !suppressCompositionCallbacks else { super.unmarkText(); return }
        unmarking = true
        defer { unmarking = false }
        super.unmarkText()
        richController?.endComposition()
    }
}
#endif
