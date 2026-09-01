import Foundation
import XCTest
@testable import AthenaeumAppUI
@testable import AthenaeumCore
import AthenaeumDomain

final class LoroNativeRichTextPresentationTests: XCTestCase {
    func testPlanSeparatesTaskItemsAndExcludesSeparatorsFromSpans() {
        let document = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .heading(level: 2, runs: [.init(text: "Title", marks: [.strong])]),
            .taskList([
                .init(checked: false, runs: [.init(text: "one")]),
                .init(checked: true, runs: [.init(text: "two", reference: .init(kind: .supertag, id: try! EntityId(validating: "10000000-0000-4000-8000-000000000001"), label: "two"))])
            ]),
            .paragraph([])
        ]))
        let plan = try! XCTUnwrap(LoroNativeRichTextPresentation.make(for: document))
        let roles: [LoroNativeRichTextPresentation.BlockRole] = [.heading(2), .task, .task, .paragraph]
        XCTAssertEqual(plan.blocks.map { $0.role }, roles)
        XCTAssertEqual(plan.spans.map(\.range), [
            NSRange(location: 0, length: 5),
            NSRange(location: 6, length: 3),
            NSRange(location: 10, length: 3)
        ])
        XCTAssertEqual(plan.blocks[1].separatorRange, NSRange(location: 9, length: 1))
        XCTAssertEqual(plan.blocks[2].separatorRange, NSRange(location: 13, length: 1))
    }

    func testPlanCarriesTerminalEmptyHeadingPresentationRangeWithoutContentSpan() {
        let document = LoroNativeRichDocumentV1(semantic: .init(blocks: [.heading(level: 3, runs: [])]))
        let plan = try! XCTUnwrap(LoroNativeRichTextPresentation.make(for: document))
        XCTAssertEqual(plan.blocks[0].contentRange, NSRange(location: 0, length: 0))
        XCTAssertEqual(plan.blocks[0].presentationRange, NSRange(location: 0, length: 1))
        XCTAssertEqual(plan.blocks[0].separatorRange, NSRange(location: 0, length: 1))
        XCTAssertTrue(plan.spans.isEmpty)
    }

    func testPlanKeepsEmptyLeadingAndTrailingBlocksOnDistinctSeparators() throws {
        let document = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .paragraph([]),
            .heading(level: 1, runs: [.init(text: "Title", marks: [.code, .emphasis, .strong])]),
            .paragraph([])
        ]))

        let plan = try XCTUnwrap(LoroNativeRichTextPresentation.make(for: document))
        XCTAssertEqual(plan.renderedUTF16Length, 7)
        XCTAssertEqual(plan.blocks.map(\.contentRange), [
            NSRange(location: 0, length: 0),
            NSRange(location: 1, length: 5),
            NSRange(location: 7, length: 0)
        ])
        XCTAssertEqual(plan.blocks.map(\.presentationRange), [
            NSRange(location: 0, length: 1),
            NSRange(location: 1, length: 5),
            NSRange(location: 6, length: 1)
        ])
        XCTAssertEqual(plan.blocks.map(\.separatorRange), [
            NSRange(location: 0, length: 1),
            NSRange(location: 6, length: 1),
            NSRange(location: 6, length: 1)
        ])
        XCTAssertEqual(plan.spans.map(\.marks), [[.code, .emphasis, .strong]])
        XCTAssertEqual(plan.spans.map(\.range), [NSRange(location: 1, length: 5)])
    }

    func testPlanCarriesTypedReferenceKindWithoutPlatformAttributes() throws {
        let reference = LoroCanonicalSemanticValueV1.InlineReference(
            kind: .entity,
            id: try EntityId(validating: "10000000-0000-4000-8000-000000000001"),
            label: "Alice"
        )
        let document = LoroNativeRichDocumentV1(semantic: .init(blocks: [.paragraph([
            .init(text: "Alice", marks: [.strong], reference: reference)
        ])]))

        let plan = try XCTUnwrap(LoroNativeRichTextPresentation.make(for: document))
        XCTAssertEqual(plan.spans, [
            .init(range: NSRange(location: 0, length: 5), marks: [.strong], reference: .entity)
        ])
        XCTAssertEqual(LoroNativeRichTextPresentation.metadataPrecedence, ["block", "marks", "reference"])
    }

    func testPlanRejectsAnUnsupportedHeadingLevelBeforeStyling() {
        let document = LoroNativeRichDocumentV1(semantic: .init(blocks: [.heading(level: 4, runs: [.init(text: "bad")])]))
        XCTAssertNil(LoroNativeRichTextPresentation.make(for: document))
    }
}
