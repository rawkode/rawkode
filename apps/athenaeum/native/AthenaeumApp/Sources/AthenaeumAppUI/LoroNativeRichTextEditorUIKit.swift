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
    /// Picker results are one-shot commands keyed by a trigger generation. The controller
    /// validates the captured range against its current semantic document before admitting them.
    let mentionInsertion: LoroNativeRichTextMentionInsertion?
    let supertagInsertion: LoroNativeRichTextSupertagInsertion?
    /// Checklist toggles are a separate acknowledged-adoption lane; they never enter the
    /// ordinary rich draft callback.
    let taskToggleAcknowledgement: LoroNativeRichTaskItemToggleAcknowledgement?
    let taskListInsertionRequestGeneration: Int
    let taskListInsertionAcknowledgement: LoroNativeRichTaskListInsertionAcknowledgement?
    let taskListInsertionCancellation: LoroNativeRichTaskListInsertionCancellation?
    let onDocumentChange: (LoroNativeRichDocumentV1) -> Void
    let onTaskToggle: (LoroNativeRichTaskItemToggleCommand) -> Void
    let onTaskListInsertion: (LoroNativeRichTaskListInsertionCommand) -> Void
    let onSelectionChange: (LoroNativeRichTextSelection) -> Void
    let onRejectedInput: (LoroNativeRichTextEditorRejection) -> Void
    /// Presentation-only responder state. Durable editing semantics stay in the engine.
    let onFocusChange: (Bool) -> Void
    /// Semantic activation stays typed; routing belongs to the parent workspace surface.
    let onOpenReference: (LoroCanonicalSemanticValueV1.InlineReference) -> Void
    /// The host owns the SwiftUI picker; the adapter only reports an immutable trigger snapshot.
    let onMentionQueryChange: (LoroNativeRichTextMentionContext?) -> Void
    let onSupertagQueryChange: (LoroNativeRichTextSupertagContext?) -> Void
    /// Delivered only after a contextual insertion has published and reached the host document
    /// callback, so follow-up capture cannot race a rejected or no-op command.
    let onInlineReferenceInserted: (LoroNativeRichTextInlineReferenceInsertionAcknowledgement) -> Void

    init(
        state: LoroNativeRichEditorState,
        isEditable: Bool,
        focusRequestGeneration: Int,
        focusRequestSelection: LoroNativeRichTextSelection?,
        mentionInsertion: LoroNativeRichTextMentionInsertion? = nil,
        supertagInsertion: LoroNativeRichTextSupertagInsertion? = nil,
        taskToggleAcknowledgement: LoroNativeRichTaskItemToggleAcknowledgement? = nil,
        taskListInsertionRequestGeneration: Int = 0,
        taskListInsertionAcknowledgement: LoroNativeRichTaskListInsertionAcknowledgement? = nil,
        taskListInsertionCancellation: LoroNativeRichTaskListInsertionCancellation? = nil,
        onDocumentChange: @escaping (LoroNativeRichDocumentV1) -> Void,
        onTaskToggle: @escaping (LoroNativeRichTaskItemToggleCommand) -> Void = { _ in },
        onTaskListInsertion: @escaping (LoroNativeRichTaskListInsertionCommand) -> Void = { _ in },
        onSelectionChange: @escaping (LoroNativeRichTextSelection) -> Void,
        onRejectedInput: @escaping (LoroNativeRichTextEditorRejection) -> Void,
        onFocusChange: @escaping (Bool) -> Void,
        onOpenReference: @escaping (LoroCanonicalSemanticValueV1.InlineReference) -> Void,
        onMentionQueryChange: @escaping (LoroNativeRichTextMentionContext?) -> Void = { _ in },
        onSupertagQueryChange: @escaping (LoroNativeRichTextSupertagContext?) -> Void = { _ in },
        onInlineReferenceInserted: @escaping (LoroNativeRichTextInlineReferenceInsertionAcknowledgement) -> Void = { _ in }
    ) {
        self.state = state
        self.isEditable = isEditable
        self.focusRequestGeneration = focusRequestGeneration
        self.focusRequestSelection = focusRequestSelection
        self.mentionInsertion = mentionInsertion
        self.supertagInsertion = supertagInsertion
        self.taskToggleAcknowledgement = taskToggleAcknowledgement
        self.taskListInsertionRequestGeneration = taskListInsertionRequestGeneration
        self.taskListInsertionAcknowledgement = taskListInsertionAcknowledgement
        self.taskListInsertionCancellation = taskListInsertionCancellation
        self.onDocumentChange = onDocumentChange
        self.onTaskToggle = onTaskToggle
        self.onTaskListInsertion = onTaskListInsertion
        self.onSelectionChange = onSelectionChange
        self.onRejectedInput = onRejectedInput
        self.onFocusChange = onFocusChange
        self.onOpenReference = onOpenReference
        self.onMentionQueryChange = onMentionQueryChange
        self.onSupertagQueryChange = onSupertagQueryChange
        self.onInlineReferenceInserted = onInlineReferenceInserted
    }

    func makeCoordinator() -> LoroNativeRichTextEditorUIKitController {
        .init(
            document: state.document,
            isEditable: isEditable,
            onDocumentChange: onDocumentChange,
            onTaskToggle: onTaskToggle,
            onTaskListInsertion: onTaskListInsertion,
            onSelectionChange: onSelectionChange,
            onRejectedInput: onRejectedInput,
            onFocusChange: onFocusChange,
            onOpenReference: onOpenReference,
            onMentionQueryChange: onMentionQueryChange,
            onSupertagQueryChange: onSupertagQueryChange,
            onInlineReferenceInserted: onInlineReferenceInserted
        )
    }

    func makeUIView(context: Context) -> LoroNativeRichTextEditorUIKitHostView { context.coordinator.makeHostView() }

    func updateUIView(_ view: LoroNativeRichTextEditorUIKitHostView, context: Context) {
        context.coordinator.applyTaskToggleAcknowledgement(taskToggleAcknowledgement)
        context.coordinator.applyTaskListInsertionCancellation(taskListInsertionCancellation)
        context.coordinator.applyTaskListInsertionAcknowledgement(taskListInsertionAcknowledgement)
        context.coordinator.requestTaskListInsertion(generation: taskListInsertionRequestGeneration)
        context.coordinator.update(document: state.document, isEditable: isEditable)
        view.updateStyleState(context.coordinator.blockStyleState())
        context.coordinator.requestFocus(generation: focusRequestGeneration, selection: focusRequestSelection)
        context.coordinator.applyMentionInsertion(mentionInsertion)
        context.coordinator.applySupertagInsertion(supertagInsertion)
    }

    static func dismantleUIView(_ view: LoroNativeRichTextEditorUIKitHostView, coordinator: LoroNativeRichTextEditorUIKitController) {
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

    /// UIKit's TextKit 1 layout manager has no temporary-attribute API. Keep the semantic
    /// snapshot marker-only, but install the controlled presentation attributes into this same
    /// editable text view. One TextKit layout therefore owns glyph metrics, caret, selection, and
    /// IME geometry; no second view can drift from the input surface. The styled text storage is
    /// never decoded and is always rebuilt from `semanticStorage`.
    private let textView = GuardedUIKitRichTextView(frame: .zero, textContainer: nil)
    private weak var styleHost: LoroNativeRichTextEditorUIKitHostView?
    private let referenceTap = UITapGestureRecognizer()
    private let taskToggleTap = UITapGestureRecognizer()
    private var engine: LoroNativeRichEditingEngine
    /// Marker-only snapshot used by every semantic boundary. UIKit's editable storage carries
    /// controlled display attributes for the single TextKit layout, but this value never does and
    /// is never decoded from UIKit.
    private var semanticStorage = NSMutableAttributedString()
    private var rendering = false
    private var pendingComposition = false
    private var presentationRefreshPending = false
    private var hostCompositionGeneration = 0
    private var scheduledFlushGeneration: Int?
    private var deferredParentDocument: LoroNativeRichDocumentV1?
    private var isEditableInput: Bool
    private var completedFocusGeneration = 0
    private var pendingFocusGeneration: Int?
    private var pendingFocusSelection: LoroNativeRichTextSelection?
    private var pendingTaskToggle: LoroNativeRichTaskItemToggleCommand?
    private var lastAppliedTaskToggleID: UUID?
    private var nextTaskListInsertionRequestToken = 0
    private var lastTaskListInsertionRequestGeneration = 0
    private var pendingTaskListInsertion: (token: Int, command: LoroNativeRichTaskListInsertionCommand)?
    private var lastAppliedTaskListInsertionID: UUID?
    private var pendingMarkdownShortcutWitness: (token: Int, range: NSRange, selection: LoroNativeRichTextSelection)?
    private var nextMarkdownShortcutRequestToken = 0
    private var lastAppliedTaskListInsertionCancellationID: UUID?
    private var nextBlockStyleRequestToken = 0
    private var nextInlineMarkRequestToken = 0
    private var pendingInlineMark: LoroNativeRichInlineMarkCommand?
    #if DEBUG
    /// Test-only responder result seam. Production always asks this controller's own window.
    private var testingFocusAttempt: (() -> Bool)?
    #endif
    private let onDocumentChange: (LoroNativeRichDocumentV1) -> Void
    private let onTaskToggle: (LoroNativeRichTaskItemToggleCommand) -> Void
    private let onTaskListInsertion: (LoroNativeRichTaskListInsertionCommand) -> Void
    private let onSelectionChange: (LoroNativeRichTextSelection) -> Void
    private let onRejectedInput: (LoroNativeRichTextEditorRejection) -> Void
    private let onFocusChange: (Bool) -> Void
    private let onOpenReference: (LoroCanonicalSemanticValueV1.InlineReference) -> Void
    private let onMentionQueryChange: (LoroNativeRichTextMentionContext?) -> Void
    private let onSupertagQueryChange: (LoroNativeRichTextSupertagContext?) -> Void
    private let onInlineReferenceInserted: (LoroNativeRichTextInlineReferenceInsertionAcknowledgement) -> Void
    private var nextReferenceGenerations: [LoroNativeRichTextReferenceTrigger: Int] = [:]
    private var lastReferenceContexts: [LoroNativeRichTextReferenceTrigger: LoroNativeRichTextInlineReferenceContext] = [:]
    private var lastAppliedReferenceGenerations: [LoroNativeRichTextReferenceTrigger: Int] = [:]

    init(
        document: LoroNativeRichDocumentV1,
        isEditable: Bool,
        onDocumentChange: @escaping (LoroNativeRichDocumentV1) -> Void = { _ in },
        onTaskToggle: @escaping (LoroNativeRichTaskItemToggleCommand) -> Void = { _ in },
        onTaskListInsertion: @escaping (LoroNativeRichTaskListInsertionCommand) -> Void = { _ in },
        onSelectionChange: @escaping (LoroNativeRichTextSelection) -> Void = { _ in },
        onRejectedInput: @escaping (LoroNativeRichTextEditorRejection) -> Void = { _ in },
        onFocusChange: @escaping (Bool) -> Void = { _ in },
        onOpenReference: @escaping (LoroCanonicalSemanticValueV1.InlineReference) -> Void = { _ in },
        onMentionQueryChange: @escaping (LoroNativeRichTextMentionContext?) -> Void = { _ in },
        onSupertagQueryChange: @escaping (LoroNativeRichTextSupertagContext?) -> Void = { _ in },
        onInlineReferenceInserted: @escaping (LoroNativeRichTextInlineReferenceInsertionAcknowledgement) -> Void = { _ in }
    ) {
        engine = .init(document: document)
        isEditableInput = isEditable
        self.onDocumentChange = onDocumentChange
        self.onTaskToggle = onTaskToggle
        self.onTaskListInsertion = onTaskListInsertion
        self.onSelectionChange = onSelectionChange
        self.onRejectedInput = onRejectedInput
        self.onFocusChange = onFocusChange
        self.onOpenReference = onOpenReference
        self.onMentionQueryChange = onMentionQueryChange
        self.onSupertagQueryChange = onSupertagQueryChange
        self.onInlineReferenceInserted = onInlineReferenceInserted
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
        textView.adjustsFontForContentSizeCategory = true
        textView.font = .preferredFont(forTextStyle: .body)
        textView.textColor = .label
        textView.smartQuotesType = .no
        textView.smartDashesType = .no
        textView.smartInsertDeleteType = .no
        textView.autocorrectionType = .no
        textView.textDragInteraction?.isEnabled = false
        textView.accessibilityLabel = "Rich text editor. References are links."
        textView.accessibilityCustomActions = [
            UIAccessibilityCustomAction(name: "Open linked reference") { [weak self] _ in
                self?.openReferenceAtCurrentSelection() ?? false
            },
            UIAccessibilityCustomAction(name: "Toggle checklist item") { [weak self] _ in
                self?.requestTaskToggleAtCurrentSelection() ?? false
            },
            UIAccessibilityCustomAction(name: "Add checklist") { [weak self] _ in
                self?.requestTaskListInsertion() ?? false
            }
        ]
        referenceTap.addTarget(self, action: #selector(handleReferenceTap(_:)))
        referenceTap.delegate = self
        referenceTap.cancelsTouchesInView = false
        referenceTap.delaysTouchesBegan = false
        textView.addGestureRecognizer(referenceTap)
        taskToggleTap.addTarget(self, action: #selector(handleTaskToggleTap(_:)))
        taskToggleTap.delegate = self
        taskToggleTap.cancelsTouchesInView = false
        taskToggleTap.delaysTouchesBegan = false
        textView.addGestureRecognizer(taskToggleTap)
        render(document, preserving: nil)
    }

    func makeTextView() -> UITextView { textView }

    func makeHostView() -> LoroNativeRichTextEditorUIKitHostView {
        let host = LoroNativeRichTextEditorUIKitHostView(
            controller: self,
            textView: textView
        )
        styleHost = host
        host.updateStyleState(blockStyleState())
        return host
    }

    func update(document: LoroNativeRichDocumentV1, isEditable: Bool) {
        let wasEditable = isEditableInput
        isEditableInput = isEditable
        textView.isEditable = isEditable
        if !isEditable { invalidateAllReferenceContexts() }
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
            invalidateAllReferenceContexts()
            pendingInlineMark = nil
            render(document, preserving: selection)
        case let .acknowledged(document, selection):
            invalidateAllReferenceContexts()
            pendingInlineMark = nil
            render(document, preserving: selection)
        case .deferredForComposition:
            deferredParentDocument = document
        case .deferredForLocalProposal, .unchanged:
            publishReferenceContexts()
            return
        }
        publishReferenceContexts()
    }

    func requestFocus(generation: Int, selection: LoroNativeRichTextSelection? = nil) {
        guard generation > completedFocusGeneration else { return }
        pendingFocusGeneration = max(pendingFocusGeneration ?? 0, generation)
        pendingFocusSelection = selection
        fulfillFocusRequestIfPossible()
    }

    @discardableResult
    func requestTaskListInsertion() -> Bool {
        guard isEditableInput, !pendingComposition, !hasMarkedText,
              engine.pendingLocalDocument == nil, pendingTaskToggle == nil,
              pendingTaskListInsertion == nil, pendingInlineMark == nil,
              let selection = scalarSelection(), selection.length == 0,
              let command = engine.makeTaskListInsertionCommand(atScalarOffset: selection.location) else { return false }
        nextTaskListInsertionRequestToken &+= 1
        pendingTaskListInsertion = (nextTaskListInsertionRequestToken, command)
        onTaskListInsertion(command)
        return true
    }

    func requestTaskListInsertion(generation: Int) {
        guard generation > lastTaskListInsertionRequestGeneration else { return }
        lastTaskListInsertionRequestGeneration = generation
        _ = requestTaskListInsertion()
    }

    /// The adapter captures its own UITextView selection when a keyboard/edit-menu command fires.
    @discardableResult
    func requestBlockStyle(_ style: LoroNativeRichBlockStyle) -> Bool {
        guard let target = captureBlockStyleTarget() else { return false }
        return requestBlockStyle(style, target: target)
    }

    func captureBlockStyleTarget() -> LoroNativeRichBlockStyleTarget? {
        guard isEditableInput, !pendingComposition, !hasMarkedText,
              engine.pendingLocalDocument == nil, pendingTaskToggle == nil,
              pendingTaskListInsertion == nil, pendingInlineMark == nil,
              let selection = scalarSelection()
        else { return nil }
        return engine.makeBlockStyleTarget(selection: selection)
    }

    @discardableResult
    func requestBlockStyle(_ style: LoroNativeRichBlockStyle, target: LoroNativeRichBlockStyleTarget) -> Bool {
        guard isEditableInput, !pendingComposition, !hasMarkedText,
              engine.pendingLocalDocument == nil, pendingTaskToggle == nil,
              pendingTaskListInsertion == nil, pendingInlineMark == nil
        else { return false }
        let requestToken = nextBlockStyleRequestToken &+ 1
        let command = engine.makeBlockStyleCommand(style: style, target: target,
                                                    requestToken: requestToken)
        nextBlockStyleRequestToken = requestToken
        _ = apply(engine.applyBlockStyle(command))
        return true
    }

    func blockStyleState() -> LoroNativeRichBlockStyleState {
        guard isEditableInput, let selection = scalarSelection()
        else { return .disabled }
        let state = engine.blockStyleState(for: selection)
        guard pendingTaskToggle == nil, pendingTaskListInsertion == nil,
              pendingInlineMark == nil,
              !pendingComposition, !hasMarkedText else {
            return .init(current: state.current, isEnabled: false)
        }
        return state
    }

    @discardableResult
    fileprivate func armMarkdownShortcutForTypedSpace() -> Int? {
        guard isEditableInput, !pendingComposition, !hasMarkedText,
              engine.pendingLocalDocument == nil, let selection = scalarSelection(),
              pendingTaskToggle == nil, pendingTaskListInsertion == nil, pendingInlineMark == nil,
              textView.selectedRange.length == 0 else { return nil }
        nextMarkdownShortcutRequestToken &+= 1
        let token = nextMarkdownShortcutRequestToken
        pendingMarkdownShortcutWitness = (token, textView.selectedRange, selection)
        return token
    }

    fileprivate func clearMarkdownShortcutWitness(token: Int) {
        guard pendingMarkdownShortcutWitness?.token == token else { return }
        pendingMarkdownShortcutWitness = nil
    }

    private func consumeMarkdownShortcutIfEligible(range: NSRange, replacement: String) -> Bool {
        guard replacement == " ", let witness = pendingMarkdownShortcutWitness, witness.range == range else { return false }
        pendingMarkdownShortcutWitness = nil
        guard let command = engine.makeMarkdownShortcutCommand(selection: witness.selection, requestToken: witness.token) else { return false }
        invalidateReferenceContext(.supertag)
        _ = apply(engine.applyMarkdownShortcut(command))
        return true
    }

    func captureInlineMarkTarget() -> LoroNativeRichInlineMarkTarget? {
        captureInlineMarkTarget(forUTF16Range: textView.selectedRange)
    }

    /// Captures the range supplied by UIKit before an edit menu can move focus. The target is
    /// value-witnessed and therefore remains safe if the menu action runs after selection moves.
    func captureInlineMarkTarget(forUTF16Range range: NSRange) -> LoroNativeRichInlineMarkTarget? {
        guard isEditableInput, !pendingComposition, !hasMarkedText,
              engine.pendingLocalDocument == nil, pendingTaskToggle == nil,
              pendingTaskListInsertion == nil, pendingInlineMark == nil,
              range.location >= 0, range.length > 0,
              range.location <= Int.max - range.length,
              NSMaxRange(range) <= semanticStorage.length,
              let selection = try? LoroNativeRichTextCodec.scalarSelection(forUTF16Range: range, in: semanticStorage)
        else { return nil }
        return engine.makeInlineMarkTarget(selection: selection)
    }

    func captureInlineMarkTarget(for textRange: UITextRange) -> LoroNativeRichInlineMarkTarget? {
        guard let range = utf16Range(for: textRange) else { return nil }
        return captureInlineMarkTarget(forUTF16Range: range)
    }

    @discardableResult
    func requestInlineMark(_ mark: LoroCanonicalSemanticValueV1.Mark, target: LoroNativeRichInlineMarkTarget) -> Bool {
        guard isEditableInput, !pendingComposition, !hasMarkedText,
              engine.pendingLocalDocument == nil, pendingTaskToggle == nil,
              pendingTaskListInsertion == nil, pendingInlineMark == nil else { return false }
        let token = nextInlineMarkRequestToken &+ 1
        let command = engine.makeInlineMarkCommand(mark: mark, target: target, requestToken: token)
        nextInlineMarkRequestToken = token
        pendingInlineMark = command
        let didPublish = apply(engine.applyInlineMark(command))
        if !didPublish { pendingInlineMark = nil }
        return didPublish
    }

    func applyTaskListInsertionAcknowledgement(_ acknowledgement: LoroNativeRichTaskListInsertionAcknowledgement?) {
        guard let acknowledgement, acknowledgement.commandID != lastAppliedTaskListInsertionID else { return }
        guard let pending = pendingTaskListInsertion,
              pending.command.commandID == acknowledgement.commandID,
              engine.isValidTaskListInsertionWitness(pending.command),
              let expected = insertedTaskListDocument(for: pending.command, in: engine.admittedDocument),
              expected == acknowledgement.document,
              let expectedAcknowledgement = LoroNativeRichTaskListInsertionAcknowledgement(command: pending.command, document: acknowledgement.document),
              expectedAcknowledgement == acknowledgement else {
            if pendingTaskListInsertion != nil { pendingTaskListInsertion = nil; onRejectedInput(.invalidEdit) }
            return
        }
        pendingTaskListInsertion = nil
        lastAppliedTaskListInsertionID = acknowledgement.commandID
        let selection = LoroNativeRichTextSelection(location: acknowledgement.postInsertionScalarOffset, length: 0)
        switch engine.receiveParentDocument(acknowledgement.document) {
        case let .adopted(document, _), let .acknowledged(document, _):
            engine.setSelection(selection)
            render(document, preserving: selection)
        case .unchanged, .deferredForComposition, .deferredForLocalProposal: onRejectedInput(.invalidEdit)
        }
    }

    @discardableResult
    func applyTaskListInsertionCancellation(_ cancellation: LoroNativeRichTaskListInsertionCancellation?) -> Bool {
        guard let cancellation,
              cancellation.commandID != lastAppliedTaskListInsertionCancellationID,
              let pending = pendingTaskListInsertion,
              pending.command.commandID == cancellation.commandID else { return false }
        pendingTaskListInsertion = nil
        lastAppliedTaskListInsertionCancellationID = cancellation.commandID
        onRejectedInput(.disabled)
        return true
    }

    private func insertedTaskListDocument(for command: LoroNativeRichTaskListInsertionCommand, in document: LoroNativeRichDocumentV1) -> LoroNativeRichDocumentV1? {
        guard command.topLevelBlockIndex >= 0, command.topLevelBlockIndex < document.semantic.blocks.count,
              document.semantic.blocks[command.topLevelBlockIndex] == command.expectedBlock else { return nil }
        switch command.expectedBlock {
        case .paragraph, .heading: break
        case .taskList: return nil
        }
        var blocks = document.semantic.blocks
        guard command.topLevelBlockIndex < blocks.count else { return nil }
        blocks.insert(.taskList([.init(checked: false, runs: [])]), at: command.topLevelBlockIndex + 1)
        return .init(semantic: .init(blocks: blocks))
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
        if consumeMarkdownShortcutIfEligible(range: range, replacement: text) { return false }
        // The engine has rendered the admitted document itself. Returning `true` would allow
        // UIKit to replay the original native edit into that rendered document.
        _ = apply(engine.replace(utf16Range: range, withPlainText: text))
        return false
    }

    func textViewDidChange(_ textView: UITextView) {
        guard !rendering else { return }
        if pendingComposition || hasMarkedText {
            pendingComposition = hasMarkedText
            if !pendingComposition { scheduleCompositionFlush() }
            return
        }
        // Every intended non-composition write returns false from `shouldChangeTextIn` and is
        // rendered by us. Any other storage change is untrusted and restored atomically. The
        // live text view contains controlled fonts/paragraphs for its one TextKit layout, so
        // compare only after removing those presentation keys from a copy.
        guard semanticStorageMatchesInput() else { reject(.invalidEdit); return }
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        guard !rendering, !pendingComposition, let selection = scalarSelection() else { return }
        engine.setSelection(selection)
        onSelectionChange(selection)
        styleHost?.updateStyleState(blockStyleState())
        publishReferenceContexts()
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
        invalidateAllReferenceContexts()
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
    @discardableResult
    func insert(
        reference: LoroCanonicalSemanticValueV1.InlineReference,
        replacingUTF16Range range: NSRange
    ) -> Bool {
        guard isEditableInput, !pendingComposition, !hasMarkedText else {
            reject(.disabled)
            return false
        }
        return apply(engine.insert(reference: reference, replacingUTF16Range: range))
    }

    /// Requests a store-owned checklist toggle without changing local semantic state. The parent
    /// must return an exact acknowledgement through `applyTaskToggleAcknowledgement` before the
    /// checkbox can visually change.
    @discardableResult
    func requestTaskToggle(atUTF16Offset offset: Int) -> Bool {
        guard isEditableInput,
              !pendingComposition,
              !hasMarkedText,
              engine.pendingLocalDocument == nil,
              pendingTaskToggle == nil,
              pendingInlineMark == nil,
              let command = engine.makeTaskToggleCommand(atUTF16Offset: offset)
        else {
            if !isEditableInput { reject(.disabled) }
            return false
        }
        pendingTaskToggle = command
        onTaskToggle(command)
        return true
    }

    @discardableResult
    private func requestTaskToggleAtCurrentSelection() -> Bool {
        let range = textView.selectedRange
        guard range.location != NSNotFound else { return false }
        let offset = range.location < textView.textStorage.length ? range.location : max(0, range.location - 1)
        return requestTaskToggle(atUTF16Offset: offset)
    }

    /// Applies the store's exact post-toggle result through a parent adoption path. This method
    /// intentionally never calls `onDocumentChange`, avoiding the generic rich-draft debounce.
    func applyTaskToggleAcknowledgement(_ acknowledgement: LoroNativeRichTaskItemToggleAcknowledgement?) {
        guard let acknowledgement, acknowledgement.commandID != lastAppliedTaskToggleID else { return }
        guard let pending = pendingTaskToggle, pending.commandID == acknowledgement.commandID,
              pending.editorGeneration == engine.documentGeneration,
              let expected = toggledDocument(for: pending, in: engine.admittedDocument),
              expected == acknowledgement.document
        else {
            if pendingTaskToggle != nil { pendingTaskToggle = nil; onRejectedInput(.invalidEdit) }
            return
        }
        pendingTaskToggle = nil
        lastAppliedTaskToggleID = acknowledgement.commandID
        let requestedSelection = acknowledgement.selection
        switch engine.receiveParentDocument(acknowledgement.document) {
        case let .adopted(document, adoptedSelection), let .acknowledged(document, adoptedSelection):
            render(document, preserving: requestedSelection ?? adoptedSelection)
        case .unchanged, .deferredForComposition, .deferredForLocalProposal:
            onRejectedInput(.invalidEdit)
        }
        publishReferenceContexts()
    }

    func testingTaskToggle(atUTF16Offset offset: Int) -> LoroNativeRichTaskItemToggleCommand? {
        guard requestTaskToggle(atUTF16Offset: offset) else { return nil }
        return pendingTaskToggle
    }

    private func toggledDocument(
        for command: LoroNativeRichTaskItemToggleCommand,
        in document: LoroNativeRichDocumentV1
    ) -> LoroNativeRichDocumentV1? {
        guard command.taskListIndex >= 0,
              command.taskListIndex < document.semantic.blocks.count,
              case let .taskList(items) = document.semantic.blocks[command.taskListIndex],
              command.itemIndex >= 0,
              command.itemIndex < items.count,
              items[command.itemIndex] == command.expectedItem else { return nil }
        var updated = document.semantic.blocks
        var nextItems = items
        nextItems[command.itemIndex] = .init(checked: !command.expectedItem.checked, runs: command.expectedItem.runs)
        updated[command.taskListIndex] = .taskList(nextItems)
        return .init(semantic: .init(blocks: updated))
    }

    fileprivate func reject(_ reason: LoroNativeRichTextEditorRejection) {
        guard !rendering else { return }
        render(engine.admittedDocument, preserving: engine.admittedSelection)
        onRejectedInput(reason)
    }

    // These value-facing seams let the iOS test bundle exercise UIKit policy without making the
    // representable part of daily-note product admission.
    func testingDocument() -> LoroNativeRichDocumentV1 { engine.admittedDocument }
    func testingSemanticStorage() -> NSAttributedString { semanticStorage.copy() as! NSAttributedString }
    func testingDisplayStorage() -> NSAttributedString { textView.attributedText ?? NSAttributedString() }
    func testingRefreshPresentation() { refreshPresentation() }
    func testingPresentationRefreshPending() -> Bool { presentationRefreshPending }
    func testingSelection() -> LoroNativeRichTextSelection { engine.admittedSelection }
    func testingTaskListInsertion() -> LoroNativeRichTaskListInsertionCommand? {
        guard requestTaskListInsertion() else { return nil }
        return pendingTaskListInsertion?.command
    }
    @discardableResult
    func testingRequestBlockStyle(_ style: LoroNativeRichBlockStyle) -> Bool { requestBlockStyle(style) }
    func testingSelect(_ range: NSRange) {
        textView.selectedRange = range
        if let selection = scalarSelection() { engine.setSelection(selection) }
        publishReferenceContexts()
    }
    func testingApplyMentionInsertion(_ insertion: LoroNativeRichTextMentionInsertion?) {
        applyMentionInsertion(insertion)
    }
    func testingApplySupertagInsertion(_ insertion: LoroNativeRichTextSupertagInsertion?) {
        applySupertagInsertion(insertion)
    }
    func testingDismissMentionContext() { dismissMentionContext() }
    func testingDismissSupertagContext() { dismissSupertagContext() }
    func testingSelection() -> LoroNativeRichTextSelection? { scalarSelection() }
    func testingInlineMarkTarget(forUTF16Range range: NSRange? = nil) -> LoroNativeRichInlineMarkTarget? {
        if let range { return captureInlineMarkTarget(forUTF16Range: range) }
        return captureInlineMarkTarget()
    }
    @discardableResult
    func testingRequestInlineMark(_ mark: LoroCanonicalSemanticValueV1.Mark) -> Bool {
        guard let target = captureInlineMarkTarget() else { return false }
        return requestInlineMark(mark, target: target)
    }
    func testingCanHandleInlineMarkShortcut() -> Bool { canHandleInlineMarkShortcut() }
    func testingApplyInlineMarkShortcut(_ input: String) { applyInlineMarkShortcut(input) }
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
        var didPublish = false
        switch effect {
        case let .publish(document, selection):
            render(document, preserving: selection)
            onDocumentChange(document)
            didPublish = true
        case let .restore(document, selection):
            render(document, preserving: selection)
        case let .rejected(reason):
            reject(reason)
        case .noChange:
            break
        }
        publishReferenceContexts()
        styleHost?.updateStyleState(blockStyleState())
        return didPublish
    }

    private func render(_ document: LoroNativeRichDocumentV1, preserving selection: LoroNativeRichTextSelection?) {
        guard let rendered = try? LoroNativeRichTextCodec.attributedString(for: document) else { return }
        rendering = true
        defer { rendering = false }
        semanticStorage = NSMutableAttributedString(attributedString: rendered)
        presentationRefreshPending = false
        applyTemporaryPresentation()
        if let selection,
           let range = try? LoroNativeRichTextCodec.utf16Range(forScalarSelection: selection, in: rendered) {
            textView.selectedRange = range
        }
    }

    private func applyTemporaryPresentation() {
        let selection = textView.selectedRange
        let contentOffset = textView.contentOffset
        let wasRendering = rendering
        // Rebuilding attributedText can synchronously move UIKit's selection and viewport. Keep
        // this presentation-only operation behind the same rendering fence used by semantic
        // renders, then restore both values without publishing an ephemeral selection event.
        rendering = true
        defer {
            if !wasRendering {
                let length = textView.textStorage.length
                let location = min(max(0, selection.location), length)
                let restoredRange = NSRange(
                    location: location,
                    length: min(selection.length, length - location)
                )
                textView.selectedRange = restoredRange
                textView.setContentOffset(contentOffset, animated: false)
            }
            rendering = wasRendering
        }

        let plan = LoroNativeRichTextPresentation.make(for: engine.admittedDocument)
        guard let plan else {
            // A malformed/future topology still gets a visible, editable body surface. The
            // semantic snapshot remains the only value that can be decoded or submitted.
            textView.attributedText = semanticStorage
            textView.setNeedsDisplay()
            return
        }

        // TextKit 1 on UIKit does not expose AppKit's temporary-attribute API. Keep the canonical
        // snapshot marker-only, and put the deterministic presentation attrs into the same
        // editable storage. This preserves one layout geometry for glyphs, caret, selection, and
        // marked text while keeping presentation attrs out of every semantic read path.
        let display = NSMutableAttributedString(attributedString: semanticStorage)
        for block in plan.blocks where block.presentationRange.length > 0 {
            let font = nativeFont(for: block.role, marks: [])
            display.addAttribute(.font, value: font, range: block.presentationRange)
            display.addAttribute(.paragraphStyle, value: paragraphStyle(for: block.role, font: font), range: block.presentationRange)
        }
        for span in plan.spans {
            guard let block = plan.blocks.first(where: { NSIntersectionRange($0.contentRange, span.range).length == span.range.length }) else { continue }
            let font = nativeFont(for: block.role, marks: span.marks)
            display.addAttribute(.font, value: font, range: span.range)
            if span.marks.contains(.emphasis) {
                display.addAttribute(.obliqueness, value: 0.18, range: span.range)
            }
            if let reference = span.reference {
                display.addAttribute(.foregroundColor, value: referenceColor(reference), range: span.range)
                display.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: span.range)
            }
        }
        textView.attributedText = display
        textView.setNeedsDisplay()
    }

    /// Presentation attrs are intentionally present in the editable TextKit storage so UIKit can
    /// use one layout for visible glyphs and input-method geometry. Normalize a copy before
    /// treating a UIKit-originated mutation as semantic input.
    private func semanticStorageMatchesInput() -> Bool {
        guard let displayed = textView.attributedText else { return false }
        let normalized = NSMutableAttributedString(attributedString: displayed)
        let fullRange = NSRange(location: 0, length: normalized.length)
        for key in Self.presentationAttributeKeys {
            normalized.removeAttribute(key, range: fullRange)
        }
        return normalized.isEqual(to: semanticStorage)
    }

    private static let presentationAttributeKeys: [NSAttributedString.Key] = [
        .font,
        .foregroundColor,
        .paragraphStyle,
        .underlineStyle,
        .obliqueness,
        NSAttributedString.Key("NSOriginalFont")
    ]

    private func nativeFont(
        for role: LoroNativeRichTextPresentation.BlockRole,
        marks: [LoroCanonicalSemanticValueV1.Mark]
    ) -> UIFont {
        let textStyle: UIFont.TextStyle
        switch role {
        case .paragraph, .task: textStyle = .body
        case .heading(1): textStyle = .title1
        case .heading(2): textStyle = .title2
        case .heading: textStyle = .title3
        }
        let base = UIFont.preferredFont(forTextStyle: textStyle)
        if marks.contains(.code) {
            let code = UIFont.monospacedSystemFont(ofSize: base.pointSize, weight: marks.contains(.strong) ? .bold : .regular)
            var traits = code.fontDescriptor.symbolicTraits
            if marks.contains(.emphasis) { traits.insert(.traitItalic) }
            if traits != code.fontDescriptor.symbolicTraits,
               let descriptor = code.fontDescriptor.withSymbolicTraits(traits) {
                return UIFont(descriptor: descriptor, size: base.pointSize)
            }
            return code
        }
        var traits = base.fontDescriptor.symbolicTraits
        if marks.contains(.strong) { traits.insert(.traitBold) }
        if marks.contains(.emphasis) { traits.insert(.traitItalic) }
        if let descriptor = base.fontDescriptor.withSymbolicTraits(traits) {
            return UIFont(descriptor: descriptor, size: base.pointSize)
        }
        return base
    }

    private func paragraphStyle(
        for role: LoroNativeRichTextPresentation.BlockRole,
        font: UIFont
    ) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        let bodyPointSize = UIFont.preferredFont(forTextStyle: .body).pointSize
        let scale = max(1, font.pointSize / max(1, bodyPointSize))
        switch role {
        case .paragraph, .task:
            style.paragraphSpacing = 4 * scale
        case .heading(1):
            style.paragraphSpacingBefore = 14 * scale
            style.paragraphSpacing = 8 * scale
        case .heading(2):
            style.paragraphSpacingBefore = 10 * scale
            style.paragraphSpacing = 6 * scale
        case .heading:
            style.paragraphSpacingBefore = 8 * scale
            style.paragraphSpacing = 4 * scale
        }
        return style
    }

    private func referenceColor(_ reference: LoroNativeRichTextPresentation.ReferenceKind) -> UIColor {
        switch reference {
        case .entity: return .systemBlue
        case .supertag: return .systemPurple
        }
    }

    /// Refreshes only transient layout attributes. A marked-text session owns its transient
    /// ranges, so a Dynamic Type/appearance change waits until the engine settles it.
    func refreshPresentation() {
        guard !rendering else { return }
        guard engine.compositionState == .idle, !pendingComposition, !hasMarkedText else {
            presentationRefreshPending = true
            return
        }
        presentationRefreshPending = false
        applyTemporaryPresentation()
    }

    private func flushPresentationRefreshIfNeeded() {
        guard presentationRefreshPending else { return }
        refreshPresentation()
    }

    /// Draws checklist affordances outside semantic storage. The square/checkmark is
    /// presentation-only and is positioned from the exact line fragment carrying this codec's
    /// opaque task marker in the same layout that renders the text.
    fileprivate func drawChecklist(in view: GuardedUIKitRichTextView) {
        let layoutManager = textView.layoutManager
        let textContainer = textView.textContainer
        guard semanticStorage.length > 0 else { return }
        layoutManager.ensureLayout(for: textContainer)
        let origin = CGPoint(x: textView.textContainerInset.left, y: textView.textContainerInset.top)
        var drawn: Set<String> = []
        for offset in 0..<semanticStorage.length {
            guard let location = LoroNativeRichTextCodec.taskItem(atUTF16Offset: offset, in: semanticStorage) else { continue }
            let key = "\(location.taskListIndex):\(location.itemIndex)"
            guard drawn.insert(key).inserted else { continue }
            let glyphRange = layoutManager.glyphRange(
                forCharacterRange: NSRange(location: offset, length: 1),
                actualCharacterRange: nil
            )
            guard glyphRange.location != NSNotFound else { continue }
            let lineRect = layoutManager.lineFragmentRect(forGlyphAt: glyphRange.location, effectiveRange: nil)
            guard !lineRect.isEmpty else { continue }
            let size: CGFloat = 16
            let checkbox = CGRect(
                x: origin.x + max(3, lineRect.minX - 24),
                y: origin.y + lineRect.midY - size / 2,
                width: size,
                height: size
            )
            let path = UIBezierPath(roundedRect: checkbox, cornerRadius: 4)
            if location.checked {
                UIColor.systemBlue.setFill()
                path.fill()
                UIColor.white.setStroke()
                let check = UIBezierPath()
                check.lineWidth = 1.8
                check.move(to: CGPoint(x: checkbox.minX + 3.5, y: checkbox.midY))
                check.addLine(to: CGPoint(x: checkbox.minX + 7, y: checkbox.minY + 4))
                check.addLine(to: CGPoint(x: checkbox.maxX - 3, y: checkbox.maxY - 4))
                check.stroke()
            } else {
                UIColor.systemGray3.setStroke()
                path.lineWidth = 1.3
                path.stroke()
            }
        }
    }

    /// Returns a semantic offset only when the pointer is inside the presentation checkbox. A
    /// tap on the prose still follows UITextView's ordinary caret/touch behaviour.
    fileprivate func taskToggleOffset(atViewPoint viewPoint: CGPoint, in view: GuardedUIKitRichTextView) -> Int? {
        guard isEditableInput, !hasMarkedText, semanticStorage.length > 0 else { return nil }
        let layoutManager = textView.layoutManager
        let textContainer = textView.textContainer
        layoutManager.ensureLayout(for: textContainer)
        let origin = CGPoint(x: textView.textContainerInset.left, y: textView.textContainerInset.top)
        let point = LoroNativeRichTextCodec.textContainerPoint(viewPoint, origin: origin)
        var seen: Set<String> = []
        for offset in 0..<semanticStorage.length {
            guard let location = LoroNativeRichTextCodec.taskItem(atUTF16Offset: offset, in: semanticStorage) else { continue }
            let key = "\(location.taskListIndex):\(location.itemIndex)"
            guard seen.insert(key).inserted else { continue }
            let glyphRange = layoutManager.glyphRange(
                forCharacterRange: NSRange(location: offset, length: 1),
                actualCharacterRange: nil
            )
            guard glyphRange.location != NSNotFound else { continue }
            let lineRect = layoutManager.lineFragmentRect(forGlyphAt: glyphRange.location, effectiveRange: nil)
            let size: CGFloat = 16
            let checkbox = CGRect(
                x: max(3, lineRect.minX - 24),
                y: lineRect.midY - size / 2,
                width: size,
                height: size
            )
            if checkbox.insetBy(dx: -6, dy: -6).contains(point) { return offset }
        }
        return nil
    }

    /// Consumes only the command for the exact context still visible at the current caret. This
    /// prevents a delayed picker result from applying after a query, caret, document, or trigger
    /// change.
    private func applyInlineReferenceInsertion(
        _ insertion: LoroNativeRichTextInlineReferenceInsertion?,
        trigger: LoroNativeRichTextReferenceTrigger
    ) {
        guard let insertion else { return }
        guard isEditableInput else { reject(.disabled); return }
        guard !pendingComposition, !hasMarkedText else { reject(.invalidEdit); return }
        guard insertion.trigger == trigger,
              insertion.reference.kind == trigger.referenceKind,
              insertion.generation > (lastAppliedReferenceGenerations[trigger] ?? 0),
              let published = lastReferenceContexts[trigger],
              insertion.generation == published.generation,
              insertion.trigger == published.trigger,
              insertion.utf16Range == published.utf16Range,
              scalarSelection() == published.selection,
              let current = LoroNativeRichTextInlineReferenceContext.detect(
                  in: semanticStorage,
                  selection: textView.selectedRange,
                  trigger: trigger
              ),
              current.trigger == published.trigger,
              current.query == published.query,
              current.utf16Range == published.utf16Range,
              current.selection == published.selection
        else { reject(.invalidEdit); return }
        guard insert(reference: insertion.reference, replacingUTF16Range: insertion.utf16Range) else { return }
        lastAppliedReferenceGenerations[trigger] = insertion.generation
        onInlineReferenceInserted(.init(insertion))
    }

    func applyMentionInsertion(_ insertion: LoroNativeRichTextMentionInsertion?) {
        applyInlineReferenceInsertion(insertion, trigger: .mention)
    }

    func applySupertagInsertion(_ insertion: LoroNativeRichTextSupertagInsertion?) {
        applyInlineReferenceInsertion(insertion, trigger: .supertag)
    }

    /// The host calls this when a picker is dismissed without a selection.
    func dismissMentionContext() { invalidateReferenceContext(.mention) }
    func dismissSupertagContext() { invalidateReferenceContext(.supertag) }

    private func publishReferenceContexts() {
        for trigger in LoroNativeRichTextReferenceTrigger.allCases {
            guard isEditableInput, !pendingComposition, !hasMarkedText,
                  let context = LoroNativeRichTextInlineReferenceContext.detect(
                      in: semanticStorage,
                      selection: textView.selectedRange,
                      trigger: trigger
                  ) else {
                invalidateReferenceContext(trigger)
                continue
            }

            if let previous = lastReferenceContexts[trigger],
               previous.query == context.query,
               previous.utf16Range == context.utf16Range,
               previous.selection == context.selection {
                continue
            }
            let nextGeneration = (nextReferenceGenerations[trigger] ?? 0) &+ 1
            nextReferenceGenerations[trigger] = nextGeneration
            let published = LoroNativeRichTextInlineReferenceContext(
                generation: nextGeneration,
                query: context.query,
                utf16Range: context.utf16Range,
                selection: context.selection,
                trigger: trigger
            )
            lastReferenceContexts[trigger] = published
            switch trigger {
            case .mention:
                onMentionQueryChange(published)
            case .supertag:
                onSupertagQueryChange(published)
            }
        }
    }

    private func invalidateAllReferenceContexts() {
        for trigger in LoroNativeRichTextReferenceTrigger.allCases {
            invalidateReferenceContext(trigger)
        }
    }

    private func invalidateReferenceContext(_ trigger: LoroNativeRichTextReferenceTrigger) {
        guard lastReferenceContexts.removeValue(forKey: trigger) != nil else { return }
        switch trigger {
        case .mention:
            onMentionQueryChange(nil)
        case .supertag:
            onSupertagQueryChange(nil)
        }
    }

    private func scalarSelection() -> LoroNativeRichTextSelection? {
        return try? LoroNativeRichTextCodec.scalarSelection(forUTF16Range: textView.selectedRange, in: semanticStorage)
    }

    fileprivate func canHandleInlineMarkShortcut() -> Bool {
        isEditableInput && !pendingComposition && !hasMarkedText &&
            engine.pendingLocalDocument == nil && pendingTaskToggle == nil &&
            pendingTaskListInsertion == nil && pendingInlineMark == nil &&
            (scalarSelection()?.length ?? 0) > 0
    }

    fileprivate func applyInlineMarkShortcut(_ input: String) {
        let mark: LoroCanonicalSemanticValueV1.Mark?
        switch input.lowercased() {
        case "b": mark = .strong
        case "i": mark = .emphasis
        case "e": mark = .code
        default: mark = nil
        }
        guard let mark, canHandleInlineMarkShortcut(), let target = captureInlineMarkTarget() else { return }
        _ = requestInlineMark(mark, target: target)
    }

    @discardableResult
    private func openReference(atUTF16Offset offset: Int) -> Bool {
        guard !pendingComposition, !hasMarkedText,
              let reference = LoroNativeRichTextCodec.reference(atUTF16Offset: offset, in: semanticStorage)
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

    @objc private func handleTaskToggleTap(_ recognizer: UITapGestureRecognizer) {
        guard recognizer.state == .ended,
              let offset = taskToggleOffset(atViewPoint: recognizer.location(in: textView), in: textView)
        else { return }
        _ = requestTaskToggle(atUTF16Offset: offset)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard !hasMarkedText else { return false }
        let point = touch.location(in: textView)
        if gestureRecognizer === referenceTap {
            return referenceHit(atViewPoint: point) != nil
        }
        if gestureRecognizer === taskToggleTap {
            return taskToggleOffset(atViewPoint: point, in: textView) != nil
        }
        return false
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        gestureRecognizer === referenceTap || gestureRecognizer === taskToggleTap
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
        guard !hasMarkedText, index >= 0, index < semanticStorage.length else { return nil }
        let glyphRange = textView.layoutManager.glyphRange(forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil)
        let glyphRect = textView.layoutManager.boundingRect(forGlyphRange: glyphRange, in: textView.textContainer)
        guard LoroNativeRichTextCodec.admitsReferenceHit(characterIndex: index, textLength: semanticStorage.length, textContainerPoint: containerPoint, glyphRect: glyphRect),
              LoroNativeRichTextCodec.reference(atUTF16Offset: index, in: semanticStorage) != nil
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
        flushPresentationRefreshIfNeeded()
    }

    private func cancelComposition() {
        hostCompositionGeneration &+= 1
        scheduledFlushGeneration = nil
        pendingComposition = false
        textView.unmarkText()
        _ = apply(engine.cancelComposition())
        reconcileDeferredParentIfPossible()
        flushPresentationRefreshIfNeeded()
    }

    private func reconcileDeferredParentIfPossible() {
        guard engine.compositionState == .idle, let document = deferredParentDocument else { return }
        deferredParentDocument = nil
        switch engine.receiveParentDocument(document) {
        case let .adopted(document, selection), let .acknowledged(document, selection):
            pendingInlineMark = nil
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

/// UIKit-owned accessory control. The button lives in the same host as the text view and starts a
/// UIEditMenuInteraction only after the controller has captured the live topology target. The
/// interaction owns dismissal cleanup; menu actions consume that frozen target and let the shared
/// engine reject any generation/block mismatch.
@available(iOS 16.0, *)
final class LoroNativeRichTextEditorUIKitHostView: UIView, UIEditMenuInteractionDelegate {
    private weak var controller: LoroNativeRichTextEditorUIKitController?
    private let styleButton: UIButton
    private let textView: UITextView
    private lazy var styleMenuInteraction = UIEditMenuInteraction(delegate: self)
    private var pendingStyleTarget: LoroNativeRichBlockStyleTarget?

    init(
        controller: LoroNativeRichTextEditorUIKitController,
        textView: UITextView
    ) {
        self.controller = controller
        self.textView = textView
        styleButton = UIButton(type: .system)
        super.init(frame: .zero)

        styleButton.contentHorizontalAlignment = .leading
        styleButton.accessibilityLabel = "Text style"
        styleButton.accessibilityHint = "Changes the current paragraph or heading without changing its content."
        styleButton.setContentHuggingPriority(.required, for: .vertical)
        styleButton.setContentCompressionResistancePriority(.required, for: .vertical)
        styleButton.addTarget(self, action: #selector(styleButtonPressed), for: .touchUpInside)
        addInteraction(styleMenuInteraction)

        let editorContainer = UIView()
        editorContainer.backgroundColor = .clear
        editorContainer.addSubview(self.textView)
        self.textView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            self.textView.leadingAnchor.constraint(equalTo: editorContainer.leadingAnchor),
            self.textView.trailingAnchor.constraint(equalTo: editorContainer.trailingAnchor),
            self.textView.topAnchor.constraint(equalTo: editorContainer.topAnchor),
            self.textView.bottomAnchor.constraint(equalTo: editorContainer.bottomAnchor)
        ])

        let stack = UIStackView(arrangedSubviews: [styleButton, editorContainer])
        stack.axis = .vertical
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
            styleButton.heightAnchor.constraint(equalToConstant: 32)
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func updateStyleState(_ state: LoroNativeRichBlockStyleState) {
        let current = state.current
        styleButton.setTitle(current?.title ?? "Text style", for: .normal)
        styleButton.isEnabled = state.isEnabled
    }

    @objc private func styleButtonPressed() {
        guard styleButton.isEnabled,
              let target = controller?.captureBlockStyleTarget() else { return }
        pendingStyleTarget = target
        let sourcePoint = styleButton.convert(
            CGPoint(x: styleButton.bounds.midX, y: styleButton.bounds.maxY),
            to: self
        )
        let configuration = UIEditMenuConfiguration(identifier: nil, sourcePoint: sourcePoint)
        styleMenuInteraction.presentEditMenu(with: configuration)
    }

    func editMenuInteraction(
        _: UIEditMenuInteraction,
        menuFor _: UIEditMenuConfiguration,
        suggestedActions _: [UIMenuElement]
    ) -> UIMenu? {
        guard pendingStyleTarget != nil else { return nil }
        let actions = LoroNativeRichBlockStyle.allCases.map { style in
            UIAction(title: style.title, state: style == controller?.blockStyleState().current ? .on : .off) { [weak self] _ in
                guard let self, let target = self.pendingStyleTarget else { return }
                _ = self.controller?.requestBlockStyle(style, target: target)
                self.pendingStyleTarget = nil
                self.updateStyleState(self.controller?.blockStyleState() ?? .disabled)
            }
        }
        return UIMenu(title: "Text style", image: UIImage(systemName: "textformat"), children: actions)
    }

    func editMenuInteraction(
        _: UIEditMenuInteraction,
        targetRectFor _: UIEditMenuConfiguration
    ) -> CGRect {
        styleButton.frame
    }

    func editMenuInteraction(
        _: UIEditMenuInteraction,
        willDismissMenuFor _: UIEditMenuConfiguration,
        animator _: UIEditMenuInteractionAnimating
    ) {
        pendingStyleTarget = nil
    }

#if DEBUG
    /// Test-only seams exercise the same pre-menu capture and post-selection application used by
    /// the UI interaction without depending on simulator timing or private menu internals.
    func testingCaptureStyleMenuTarget() -> Bool {
        guard let target = controller?.captureBlockStyleTarget() else { return false }
        pendingStyleTarget = target
        return true
    }

    @discardableResult
    func testingApplyStyleFromMenu(_ style: LoroNativeRichBlockStyle) -> Bool {
        guard let target = pendingStyleTarget else { return false }
        pendingStyleTarget = nil
        return controller?.requestBlockStyle(style, target: target) ?? false
    }
#endif
}

private final class GuardedUIKitRichTextView: UITextView {
    weak var richController: LoroNativeRichTextEditorUIKitController?
    private var suppressCompositionCallbacks = false
    private var unmarking = false

    override func draw(_ rect: CGRect) {
        super.draw(rect)
        richController?.drawChecklist(in: self)
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        richController?.refreshPresentation()
    }

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
        var commands = (super.keyCommands ?? []) + [
            UIKeyCommand(input: "\r", modifierFlags: .command, action: #selector(openReferenceShortcut(_:)))
        ]
        if richController?.canHandleInlineMarkShortcut() == true {
            commands += [
                UIKeyCommand(input: "b", modifierFlags: .command, action: #selector(inlineMarkShortcut(_:))),
                UIKeyCommand(input: "i", modifierFlags: .command, action: #selector(inlineMarkShortcut(_:))),
                UIKeyCommand(input: "e", modifierFlags: .command, action: #selector(inlineMarkShortcut(_:)))
            ]
        }
        return commands
    }

    @available(iOS 16.0, *)
    override func editMenu(for textRange: UITextRange, suggestedActions: [UIMenuElement]) -> UIMenu {
        let target = richController?.captureBlockStyleTarget()
        // UIKit supplies the range that was active before the menu moved focus. Capture that
        // range, rather than re-reading the controller's current selection after presentation.
        let markTarget = richController?.captureInlineMarkTarget(for: textRange)
        let actions = LoroNativeRichBlockStyle.allCases.map { style in
            UIAction(title: style.title) { [weak self] _ in
                guard let self, let target else { return }
                _ = self.richController?.requestBlockStyle(style, target: target)
            }
        }
        let styleMenu = UIMenu(title: "Block Style", image: UIImage(systemName: "textformat"), children: actions)
        var children = suggestedActions + [styleMenu]
        if let markTarget {
            let formatActions = LoroCanonicalSemanticValueV1.Mark.allCases.map { mark in
                let action = UIAction(title: mark.editorTitle) { [weak self] _ in
                    _ = self?.richController?.requestInlineMark(mark, target: markTarget)
                }
                switch markTarget.state(for: mark) {
                case .on: action.state = .on
                case .mixed: action.state = .mixed
                case .off: action.state = .off
                }
                return action
            }
            let formatMenu = UIMenu(title: "Format", image: UIImage(systemName: "textformat.alt"), children: formatActions)
            children.insert(formatMenu, at: suggestedActions.count)
        }
        return UIMenu(children: children)
    }

    @objc private func openReferenceShortcut(_ sender: UIKeyCommand) {
        _ = richController?.openReferenceAtCurrentSelection()
    }

    @objc private func inlineMarkShortcut(_ sender: UIKeyCommand) {
        if let input = sender.input { richController?.applyInlineMarkShortcut(input) }
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
        var markdownWitnessToken: Int?
        if text == " " { markdownWitnessToken = richController?.armMarkdownShortcutForTypedSpace() }
        defer {
            if let markdownWitnessToken {
                richController?.clearMarkdownShortcutWitness(token: markdownWitnessToken)
            }
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
