import XCTest
@testable import AthenaeumCore

final class LoroNativePlanTodayStarterTests: XCTestCase {
    func testManifestUsesOnlyCanonicalHeadingsAndParagraphs() {
        XCTAssertEqual(
            LoroNativePlanTodayStarter.document.semantic.blocks,
            [
                .heading(level: 2, runs: [.init(text: "Focus")]),
                .paragraph([.init(text: "Priority 1")]),
                .paragraph([.init(text: "Priority 2")]),
                .paragraph([.init(text: "Priority 3")]),
                .heading(level: 2, runs: [.init(text: "Notes")]),
                .paragraph([]),
            ]
        )
    }

    func testCanonicalEmptyRecognitionDoesNotTreatAuthoredStructureAsEmpty() {
        XCTAssertTrue(LoroNativePlanTodayStarter.isCanonicalEmpty(.init(semantic: .init(blocks: [.paragraph([])]))))
        XCTAssertFalse(LoroNativePlanTodayStarter.isCanonicalEmpty(LoroNativePlanTodayStarter.document))
        XCTAssertFalse(LoroNativePlanTodayStarter.isCanonicalEmpty(.init(semantic: .init(blocks: [.heading(level: 2, runs: [])]))))
        XCTAssertFalse(LoroNativePlanTodayStarter.isCanonicalEmpty(.init(semantic: .init(blocks: [.paragraph([.init(text: " ")])]))))
    }

    func testFirstPriorityFocusStartsAfterFocusHeadingAndBlockBoundary() {
        XCTAssertEqual(LoroNativePlanTodayStarter.firstPriorityScalarFocusLocation, 6)
    }
}
