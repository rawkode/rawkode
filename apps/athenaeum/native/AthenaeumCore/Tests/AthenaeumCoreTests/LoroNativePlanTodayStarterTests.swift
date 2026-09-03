import XCTest
@testable import AthenaeumCore

final class LoroNativePlanTodayStarterTests: XCTestCase {
    func testManifestUsesCanonicalFocusChecklistAndNotes() {
        XCTAssertEqual(
            LoroNativePlanTodayStarter.document.semantic.blocks,
            [
                .heading(level: 2, runs: [.init(text: "Focus")]),
                .taskList([
                    .init(checked: false, runs: [.init(text: "Priority 1")]),
                    .init(checked: false, runs: [.init(text: "Priority 2")]),
                    .init(checked: false, runs: [.init(text: "Priority 3")]),
                ]),
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
