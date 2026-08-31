import Foundation

/// The small, ordinary rich-text document used to turn a brand-new Today note into a plan.
///
/// This is deliberately a manifest rather than a new document type. It uses only the canonical
/// heading and paragraph semantics already understood by the web and native Loro projections, so
/// it remains readable and editable everywhere that can open a v1 rich note.
public enum LoroNativePlanTodayStarter {
    public static let document = LoroNativeRichDocumentV1(semantic: .init(blocks: [
        .heading(level: 2, runs: [.init(text: "Focus")]),
        .paragraph([.init(text: "Priority 1")]),
        .paragraph([.init(text: "Priority 2")]),
        .paragraph([.init(text: "Priority 3")]),
        .heading(level: 2, runs: [.init(text: "Notes")]),
        .paragraph([]),
    ]))

    /// The scalar location at the start of the first priority. The native text hosts use scalar
    /// selections while rendering block boundaries as a single newline.
    public static let firstPriorityScalarFocusLocation = "Focus".unicodeScalars.count + 1

    /// A new native Loro page has exactly one empty paragraph. Any other structure, including an
    /// empty heading, is meaningful authored content and must never be replaced by a starter.
    public static func isCanonicalEmpty(_ document: LoroNativeRichDocumentV1) -> Bool {
        guard document.semantic.blocks.count == 1,
              case let .paragraph(runs) = document.semantic.blocks[0]
        else { return false }
        return runs.isEmpty
    }
}
