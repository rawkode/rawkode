import Foundation
import AthenaeumCore

/// A scalar-based selection is stable across TextKit implementations.  UI adapters convert at
/// their boundary; the semantic editor never accepts a UTF-16 range that splits a scalar.
public struct LoroNativeRichTextSelection: Equatable, Sendable {
    public let location: Int
    public let length: Int

    public init(location: Int, length: Int) {
        self.location = location
        self.length = length
    }
}

/// The only block styles exposed by the native rich editor.  This remains a UI intent type;
/// semantic conversion is performed by `LoroNativeRichEditingEngine`.
enum LoroNativeRichBlockStyle: String, CaseIterable, Equatable, Sendable {
    case text
    case h1
    case h2
    case h3

    var title: String {
        switch self {
        case .text: return "Text"
        case .h1: return "Heading 1"
        case .h2: return "Heading 2"
        case .h3: return "Heading 3"
        }
    }

    var headingLevel: Int? {
        switch self {
        case .text: return nil
        case .h1: return 1
        case .h2: return 2
        case .h3: return 3
        }
    }

    static func forBlock(_ block: LoroCanonicalSemanticValueV1.Block) -> Self? {
        switch block {
        case .paragraph: return .text
        case let .heading(level, _): return Self.allCases.first { $0.headingLevel == level }
        case .taskList: return nil
        }
    }
}

/// Presentation state for the adapter-owned style control. A nil style means the current
/// selection is not one eligible paragraph/heading (for example a task item, separator, or
/// cross-block range), so the control must fail closed rather than guess a target.
struct LoroNativeRichBlockStyleState: Equatable, Sendable {
    let current: LoroNativeRichBlockStyle?
    let isEnabled: Bool

    static let disabled = Self(current: nil, isEnabled: false)
}

/// The topology witness captured before an editor-adjacent menu can move focus. The eventual
/// command adds its style and request identity, while this value keeps the exact live target.
struct LoroNativeRichBlockStyleTarget: Equatable, Sendable {
    let editorGeneration: Int
    let selection: LoroNativeRichTextSelection
    let topLevelBlockIndex: Int
    let expectedBlock: LoroCanonicalSemanticValueV1.Block
}

/// Immutable witness for a block-style request. `requestToken` is monotonic within an adapter;
/// the UUID is retained for diagnostics and tests without making either value durable.
struct LoroNativeRichBlockStyleCommand: Equatable, Sendable, Identifiable {
    let commandID: UUID
    let requestToken: Int
    let editorGeneration: Int
    let style: LoroNativeRichBlockStyle
    let selection: LoroNativeRichTextSelection
    let topLevelBlockIndex: Int
    let expectedBlock: LoroCanonicalSemanticValueV1.Block

    var id: UUID { commandID }

    init(
        commandID: UUID = UUID(),
        requestToken: Int = 0,
        editorGeneration: Int,
        style: LoroNativeRichBlockStyle,
        selection: LoroNativeRichTextSelection,
        topLevelBlockIndex: Int,
        expectedBlock: LoroCanonicalSemanticValueV1.Block
    ) {
        self.commandID = commandID
        self.requestToken = requestToken
        self.editorGeneration = editorGeneration
        self.style = style
        self.selection = selection
        self.topLevelBlockIndex = topLevelBlockIndex
        self.expectedBlock = expectedBlock
    }
}

enum LoroNativeRichInlineMarkContainer: Equatable, Sendable {
    case block(index: Int, expected: LoroCanonicalSemanticValueV1.Block)
    case taskItem(listIndex: Int, itemIndex: Int, expectedList: [LoroCanonicalSemanticValueV1.TaskItem], expectedItem: LoroCanonicalSemanticValueV1.TaskItem)
}

extension LoroCanonicalSemanticValueV1.Mark {
    var editorTitle: String {
        switch self {
        case .strong: return "Bold"
        case .emphasis: return "Italic"
        case .code: return "Code"
        }
    }

    var editorShortcut: String {
        switch self {
        case .strong: return "B"
        case .emphasis: return "I"
        case .code: return "E"
        }
    }
}

struct LoroNativeRichInlineMarkRunFingerprint: Equatable, Sendable {
    let scalarRange: LoroNativeRichTextSelection
    let text: String
    let marks: [LoroCanonicalSemanticValueV1.Mark]
    let reference: LoroCanonicalSemanticValueV1.InlineReference?
}

/// Captured before an editor menu receives focus. It contains no platform object or mirrored
/// selection, only the semantic container and selected-run value witness.
struct LoroNativeRichInlineMarkTarget: Equatable, Sendable {
    let editorGeneration: Int
    let selection: LoroNativeRichTextSelection
    let container: LoroNativeRichInlineMarkContainer
    let selectedRuns: [LoroNativeRichInlineMarkRunFingerprint]

    func state(for mark: LoroCanonicalSemanticValueV1.Mark) -> LoroNativeRichInlineMarkSelectionState {
        let markedCount = selectedRuns.reduce(into: 0) { count, run in
            if run.marks.contains(mark) { count += 1 }
        }
        if markedCount == 0 { return .off }
        if markedCount == selectedRuns.count { return .on }
        return .mixed
    }
}

enum LoroNativeRichInlineMarkSelectionState: String, Equatable, Sendable {
    case off
    case mixed
    case on
}

struct LoroNativeRichInlineMarkCommand: Equatable, Sendable, Identifiable {
    enum Operation: Equatable, Sendable { case add, remove }
    let commandID: UUID
    let requestToken: Int
    let editorGeneration: Int
    let mark: LoroCanonicalSemanticValueV1.Mark
    let operation: Operation
    let selection: LoroNativeRichTextSelection
    let container: LoroNativeRichInlineMarkContainer
    let selectedRuns: [LoroNativeRichInlineMarkRunFingerprint]
    var id: UUID { commandID }

    init(commandID: UUID = UUID(), requestToken: Int = 0, mark: LoroCanonicalSemanticValueV1.Mark, operation: Operation, target: LoroNativeRichInlineMarkTarget) {
        self.commandID = commandID
        self.requestToken = requestToken
        self.editorGeneration = target.editorGeneration
        self.mark = mark
        self.operation = operation
        self.selection = target.selection
        self.container = target.container
        self.selectedRuns = target.selectedRuns
    }
}

enum LoroNativeRichMarkdownShortcutKind: String, Equatable, Sendable {
    case h1, h2, h3, uncheckedTask
}

struct LoroNativeRichMarkdownShortcutCommand: Equatable, Sendable, Identifiable {
    let commandID: UUID
    let requestToken: Int
    let editorGeneration: Int
    let selection: LoroNativeRichTextSelection
    let topLevelBlockIndex: Int
    let expectedBlock: LoroCanonicalSemanticValueV1.Block
    let kind: LoroNativeRichMarkdownShortcutKind
    let requestedBlock: LoroCanonicalSemanticValueV1.Block
    var id: UUID { commandID }
}

/// A value-only structural location for a top-level checklist item.  The ordinals are never
/// persisted as semantic data; they are paired with the editor generation and full item value in
/// `LoroNativeRichTaskItemToggleCommand` before a mutation can leave the UI process.
struct LoroNativeRichTaskItemLocation: Equatable, Sendable {
    let taskListIndex: Int
    let itemIndex: Int
    let checked: Bool

    init(taskListIndex: Int, itemIndex: Int, checked: Bool) {
        self.taskListIndex = taskListIndex
        self.itemIndex = itemIndex
        self.checked = checked
    }
}

/// Acknowledged toggle state is a separate parent-adoption lane. It must never be routed through
/// the ordinary rich-draft callback, which would arm a second whole-document debounce submission.
public struct LoroNativeRichTaskItemToggleAcknowledgement: Equatable, Sendable {
    public let commandID: UUID
    public let document: LoroNativeRichDocumentV1
    public let selection: LoroNativeRichTextSelection?

    public init(commandID: UUID, document: LoroNativeRichDocumentV1, selection: LoroNativeRichTextSelection? = nil) {
        self.commandID = commandID
        self.document = document
        self.selection = selection
    }
}

/// The native inline-reference picker receives an immutable snapshot of the trigger before it
/// leaves the editor. Keeping the trigger in the value is important: a delayed `@` result must
/// never be able to satisfy a newer `#` query that happens to share the same range.
enum LoroNativeRichTextReferenceTrigger: String, CaseIterable, Equatable, Sendable {
    case mention = "@"
    case supertag = "#"

    var character: Character { Character(rawValue) }

    var referenceKind: LoroCanonicalSemanticValueV1.InlineReference.Kind {
        switch self {
        case .mention: return .entity
        case .supertag: return .supertag
        }
    }
}

/// The UTF-16 range is deliberately retained alongside the scalar selection because the platform
/// adapters use TextKit ranges while the semantic engine uses scalar-safe selections.
struct LoroNativeRichTextInlineReferenceContext: Identifiable, Equatable {
    let generation: Int
    let trigger: LoroNativeRichTextReferenceTrigger
    let query: String
    let utf16Range: NSRange
    let selection: LoroNativeRichTextSelection

    var id: Int { generation }

    init(
        generation: Int,
        query: String,
        utf16Range: NSRange,
        selection: LoroNativeRichTextSelection,
        trigger: LoroNativeRichTextReferenceTrigger = .mention
    ) {
        self.generation = generation
        self.trigger = trigger
        self.query = query
        self.utf16Range = utf16Range
        self.selection = selection
    }
}

/// A SwiftUI host sends this command back to the native adapter after the user chooses an existing
/// reference. The generation and trigger prevent a delayed picker result from mutating a newer
/// note, caret, or reference kind.
struct LoroNativeRichTextInlineReferenceInsertion: Equatable {
    /// A host-generated identity distinguishes two otherwise identical picker commands at the
    /// same caret.  In particular, an acknowledgement must never be enough to advance a later
    /// field-capture request merely because the tag/range happen to match.
    let commandID: UUID
    let generation: Int
    let utf16Range: NSRange
    let reference: LoroCanonicalSemanticValueV1.InlineReference
    let trigger: LoroNativeRichTextReferenceTrigger

    init(
        commandID: UUID = UUID(),
        generation: Int,
        utf16Range: NSRange,
        reference: LoroCanonicalSemanticValueV1.InlineReference,
        trigger: LoroNativeRichTextReferenceTrigger = .mention
    ) {
        self.commandID = commandID
        self.generation = generation
        self.utf16Range = utf16Range
        self.reference = reference
        self.trigger = trigger
    }
}

/// Emitted only after a contextual insertion has passed the adapter's complete admission checks,
/// the editing engine has published the resulting semantic document, and the host has received
/// that document through `onDocumentChange`.  It is deliberately the immutable command identity,
/// not an inferred text/range observation, so follow-up UI cannot mistake a stale or rejected
/// command for a successful insertion.
struct LoroNativeRichTextInlineReferenceInsertionAcknowledgement: Equatable, Identifiable {
    let commandID: UUID
    let generation: Int
    let utf16Range: NSRange
    let reference: LoroCanonicalSemanticValueV1.InlineReference
    let trigger: LoroNativeRichTextReferenceTrigger

    var id: UUID { commandID }

    init(_ insertion: LoroNativeRichTextInlineReferenceInsertion) {
        commandID = insertion.commandID
        generation = insertion.generation
        utf16Range = insertion.utf16Range
        reference = insertion.reference
        trigger = insertion.trigger
    }
}

/// Compatibility aliases keep the existing `@` mention surface source-compatible while both
/// platform adapters move to the trigger-neutral contract above.
typealias LoroNativeRichTextMentionContext = LoroNativeRichTextInlineReferenceContext
typealias LoroNativeRichTextMentionInsertion = LoroNativeRichTextInlineReferenceInsertion
typealias LoroNativeRichTextSupertagContext = LoroNativeRichTextInlineReferenceContext
typealias LoroNativeRichTextSupertagInsertion = LoroNativeRichTextInlineReferenceInsertion

extension LoroNativeRichTextInlineReferenceContext {
    /// Mirrors the web editor's `(?:^|\\s)@...` and `(?:^|\\s)#...` triggers while keeping the
    /// range in the native adapter's coordinate space. This is a pure value helper so AppKit and
    /// UIKit cannot drift in how they decide whether a picker is eligible.
    static func detect(
        in attributed: NSAttributedString,
        selection: NSRange,
        trigger: LoroNativeRichTextReferenceTrigger = .mention
    ) -> Self? {
        guard selection.length == 0,
              selection.location >= 0,
              NSMaxRange(selection) <= attributed.length,
              let scalarSelection = try? LoroNativeRichTextCodec.scalarSelection(
                forUTF16Range: selection,
                in: attributed
              )
        else { return nil }

        // A caret inside or immediately after a reference belongs to that atomic value, not to a
        // new inline-reference query. The latter guard also avoids reopening the picker while a user is
        // navigating out of a just-inserted reference.
        if selection.location < attributed.length,
           LoroNativeRichTextCodec.reference(atUTF16Offset: selection.location, in: attributed) != nil {
            return nil
        }
        if selection.location > 0,
           LoroNativeRichTextCodec.reference(atUTF16Offset: selection.location - 1, in: attributed) != nil {
            return nil
        }

        let string = attributed.string
        let prefix = (string as NSString).substring(with: NSRange(location: 0, length: selection.location))
        guard let triggerIndex = prefix.lastIndex(of: trigger.character) else { return nil }
        let beforeTrigger = prefix[..<triggerIndex]
        guard beforeTrigger.last.map(\.isWhitespace) ?? true else { return nil }

        let queryStart = prefix.index(after: triggerIndex)
        let query = String(prefix[queryStart...])
        guard query.unicodeScalars.count <= 40,
              !query.contains(where: { $0.isWhitespace || $0 == trigger.character }) else { return nil }

        let from = String(prefix[..<triggerIndex]).utf16.count
        return .init(
            generation: 0,
            query: query,
            utf16Range: NSRange(location: from, length: selection.location - from),
            selection: .init(location: scalarSelection.location, length: scalarSelection.length),
            trigger: trigger
        )
    }
}

/// Rejections are product-level outcomes rather than AppKit implementation details, so each
/// native host reports the same reason to the view model and its audit trail.
enum LoroNativeRichTextEditorRejection: Equatable, Sendable {
    case disabled
    case attributedPaste
    case invalidEdit
}

/// The shared engine owns this state while a platform input method has temporary marked text.
/// Hosts must either synchronously finish or cancel it before replacing the parent document,
/// disabling input, or dismantling the editor.
enum LoroNativeRichTextCompositionState: Equatable, Sendable {
    case idle
    case composing(generation: Int)
}

/// A value-only result from an editing operation. Platform hosts render these effects and publish
/// only the `publish` document; they never derive durable values from transient TextKit storage.
enum LoroNativeRichEditingEffect: Equatable, Sendable {
    case publish(document: LoroNativeRichDocumentV1, selection: LoroNativeRichTextSelection)
    case restore(document: LoroNativeRichDocumentV1, selection: LoroNativeRichTextSelection)
    case rejected(LoroNativeRichTextEditorRejection)
    case noChange
}

/// Parent update handling is explicit so a host cannot silently discard a local proposal or IME
/// composition during SwiftUI reconciliation or date navigation.
enum LoroNativeRichParentUpdateDisposition: Equatable, Sendable {
    case adopted(document: LoroNativeRichDocumentV1, selection: LoroNativeRichTextSelection)
    case acknowledged(document: LoroNativeRichDocumentV1, selection: LoroNativeRichTextSelection)
    case deferredForComposition
    case deferredForLocalProposal
    case unchanged
}
