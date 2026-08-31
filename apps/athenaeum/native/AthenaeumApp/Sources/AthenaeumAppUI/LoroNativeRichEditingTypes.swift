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

/// The native mention picker receives an immutable snapshot of the trigger before it leaves the
/// editor. The UTF-16 range is deliberately retained alongside the scalar selection because the
/// platform adapters use TextKit ranges while the semantic engine uses scalar-safe selections.
struct LoroNativeRichTextMentionContext: Identifiable, Equatable {
    let generation: Int
    let query: String
    let utf16Range: NSRange
    let selection: LoroNativeRichTextSelection

    var id: Int { generation }
}

/// A SwiftUI host sends this command back to the native adapter after the user chooses an existing
/// entity. The generation prevents a delayed picker result from mutating a newer note or caret.
struct LoroNativeRichTextMentionInsertion: Equatable {
    let generation: Int
    let utf16Range: NSRange
    let reference: LoroCanonicalSemanticValueV1.InlineReference
}

extension LoroNativeRichTextMentionContext {
    /// Mirrors the web editor's `(?:^|\\s)@...` trigger while keeping the range in the native
    /// adapter's coordinate space. This is a pure value helper so AppKit and UIKit cannot drift in
    /// how they decide whether a picker is eligible.
    static func detect(in attributed: NSAttributedString, selection: NSRange) -> Self? {
        guard selection.length == 0,
              selection.location >= 0,
              NSMaxRange(selection) <= attributed.length,
              let scalarSelection = try? LoroNativeRichTextCodec.scalarSelection(
                forUTF16Range: selection,
                in: attributed
              )
        else { return nil }

        // A caret inside or immediately after a reference belongs to that atomic value, not to a
        // new mention query. The latter guard also avoids reopening the picker while a user is
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
        guard let at = prefix.lastIndex(of: "@") else { return nil }
        let beforeAt = prefix[..<at]
        guard beforeAt.last.map(\.isWhitespace) ?? true else { return nil }

        let queryStart = prefix.index(after: at)
        let query = String(prefix[queryStart...])
        guard query.unicodeScalars.count <= 40,
              !query.contains(where: { $0.isWhitespace || $0 == "@" }) else { return nil }

        let from = String(prefix[..<at]).utf16.count
        return .init(
            generation: 0,
            query: query,
            utf16Range: NSRange(location: from, length: selection.location - from),
            selection: .init(location: scalarSelection.location, length: scalarSelection.length)
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
