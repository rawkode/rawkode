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
