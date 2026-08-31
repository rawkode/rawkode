import XCTest
@testable import AthenaeumAppUI

final class AgentReviewPresentationTests: XCTestCase {
    func testPendingSurfaceUsesServerLabelsAndNeverInterpolatesRawGraphIds() throws {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: directory.appendingPathComponent("Sources/AthenaeumAppUI/PendingChangesView.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("Label(item.label"))
        XCTAssertFalse(source.contains("fact.predicateId"))
        XCTAssertFalse(source.contains("edge.sourceNodeId"))
        XCTAssertFalse(source.contains("Note: \\(fork.nodeId)"))
    }

    func testReviewLoadingFailsClosedForAcceptance() throws {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: directory.appendingPathComponent("Sources/AthenaeumAppUI/AgentEditViewModel.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("reviewStatus == .loaded"))
        XCTAssertTrue(source.contains("let witness = reviewWitness"))
        XCTAssertTrue(source.contains("allSatisfy({ $0.stamped"))
        XCTAssertTrue(source.contains("generation == reviewGeneration"))
        XCTAssertTrue(source.contains("$0.lane == \"structured\""))
        XCTAssertTrue(source.contains("item.lane == \"legacy-fork\""))
        XCTAssertTrue(source.contains("previewDigest"))
        XCTAssertTrue(source.contains("expectedPreviewDigest: digest"))
    }

    func testStructuredDecisionsUseWitnessedSequenceBounds() throws {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: directory.appendingPathComponent("Sources/AthenaeumAppUI/AgentEditViewModel.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("let sequenceBoundary = pendingReviewItems.map(\\.sequence).max()!"))
        XCTAssertTrue(source.contains("let sequenceBoundary = pendingReviewItems.map(\\.sequence).min()!"))
        XCTAssertFalse(source.contains("acceptAllSentinel"))
    }

    func testLegacyLaneGapsRemainVisibleWithoutActionableForkRows() throws {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: directory.appendingPathComponent("Sources/AthenaeumAppUI/PendingChangesView.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("model.hasLegacyReviewGap || !model.pendingNoteForks.isEmpty"))
        XCTAssertTrue(source.contains("couldn’t be safely shown"))
        XCTAssertTrue(source.contains("lane.shown") && source.contains("lane.total"))
    }
}
