import AthenaeumCore

/// The first-action affordance for a canonical, structurally empty native rich document.
///
/// It deliberately recognizes only the one empty paragraph emitted for a new Loro page. An empty
/// heading (or any other structure) is meaningful user-authored content and must not be obscured
/// by a writing prompt.
struct LoroNativeRichEmptyStatePresentation: Equatable {
    static let promptText = "What is worth remembering today?"

    let prompt: String?

    init(document: LoroNativeRichDocumentV1) {
        guard document.semantic.blocks.count == 1,
              case let .paragraph(runs) = document.semantic.blocks[0],
              runs.isEmpty
        else {
            prompt = nil
            return
        }
        prompt = Self.promptText
    }

    /// The TextKit wrapper intentionally receives its accepted base while a local draft is
    /// debounced. Presentation follows that published draft so the affordance disappears on the
    /// first character rather than after the next accepted checkpoint.
    init(baseDocument: LoroNativeRichDocumentV1, liveDraft: LoroNativeRichDocumentV1?) {
        self.init(document: liveDraft ?? baseDocument)
    }
}
