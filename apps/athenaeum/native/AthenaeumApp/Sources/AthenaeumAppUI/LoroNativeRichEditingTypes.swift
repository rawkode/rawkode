import Foundation
import AthenaeumCore

/// A scalar-based selection is stable across TextKit implementations.  UI adapters convert at
/// their boundary; the semantic editor never accepts a UTF-16 range that splits a scalar.
struct LoroNativeRichTextSelection: Equatable, Sendable {
    let location: Int
    let length: Int

    init(location: Int, length: Int) {
        self.location = location
        self.length = length
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
