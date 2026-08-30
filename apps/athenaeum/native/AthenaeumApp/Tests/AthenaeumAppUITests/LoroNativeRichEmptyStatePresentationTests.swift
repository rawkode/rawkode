import XCTest
@testable import AthenaeumAppUI
@testable import AthenaeumCore

final class LoroNativeRichEmptyStatePresentationTests: XCTestCase {
    func testCanonicalEmptyParagraphShowsTheWritingPrompt() {
        let presentation = LoroNativeRichEmptyStatePresentation(document: document(blocks: [.paragraph([])]))

        XCTAssertEqual(presentation.prompt, "Start with what matters. Use # to connect a person or project; @ to link context.")
    }

    func testExistingTextAndIntentionalEmptyStructureDoNotShowThePrompt() {
        XCTAssertNil(LoroNativeRichEmptyStatePresentation(
            document: document(blocks: [.paragraph([.init(text: "Already writing")])])
        ).prompt)
        XCTAssertNil(LoroNativeRichEmptyStatePresentation(
            document: document(blocks: [.heading(level: 2, runs: [])])
        ).prompt)
        XCTAssertNil(LoroNativeRichEmptyStatePresentation(
            document: document(blocks: [.paragraph([]), .paragraph([])])
        ).prompt)
    }

    func testPublishedLiveDraftWinsOverAcceptedBaseDuringDebounce() {
        let base = document(blocks: [.paragraph([])])
        let draft = document(blocks: [.paragraph([.init(text: "First thought")])])

        XCTAssertNil(LoroNativeRichEmptyStatePresentation(baseDocument: base, liveDraft: draft).prompt)
        XCTAssertEqual(
            LoroNativeRichEmptyStatePresentation(baseDocument: draft, liveDraft: base).prompt,
            "Start with what matters. Use # to connect a person or project; @ to link context."
        )
    }

    private func document(blocks: [LoroCanonicalSemanticValueV1.Block]) -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: blocks))
    }
}
