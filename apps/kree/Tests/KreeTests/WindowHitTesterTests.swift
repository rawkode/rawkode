import CoreGraphics
import XCTest
@testable import Kree

final class WindowHitTesterTests: XCTestCase {
    private let display = CGRect(x: 0, y: 0, width: 1000, height: 800)

    func testSelectsFirstContainingLayerZeroWindow() {
        let result = hitTest([
            candidate(id: 1, bounds: CGRect(x: 0, y: 0, width: 1000, height: 800)),
            candidate(id: 2, bounds: CGRect(x: 100, y: 100, width: 400, height: 400))
        ], at: CGPoint(x: 200, y: 200))

        XCTAssertEqual(result, .target(WindowTarget(
            windowID: 1,
            ownerPID: 10,
            bounds: display,
            ownerName: "Example"
        )))
    }

    func testPositiveLayerContainingPointBlocksLowerWindow() {
        let result = hitTest([
            candidate(id: 1, layer: 1, bounds: CGRect(x: 100, y: 100, width: 300, height: 300)),
            candidate(id: 2, bounds: display)
        ], at: CGPoint(x: 200, y: 200))

        XCTAssertEqual(result, .blocked)
    }

    func testMostlyOffscreenPositiveLayerStillBlocksUnderlyingWindow() {
        let result = hitTest([
            candidate(id: 1, layer: 1, bounds: CGRect(x: 950, y: 0, width: 1000, height: 800)),
            candidate(id: 2, bounds: display)
        ], at: CGPoint(x: 975, y: 100))

        XCTAssertEqual(result, .blocked)
    }

    func testWindowServerIsSkippedAndDoesNotBlock() {
        let result = hitTest([
            candidate(id: 1, layer: 2, ownerName: "Window Server", bounds: display),
            candidate(id: 2, bounds: display)
        ], at: CGPoint(x: 10, y: 10))

        XCTAssertEqual(result, .target(WindowTarget(
            windowID: 2,
            ownerPID: 10,
            bounds: display,
            ownerName: "Example"
        )))
    }

    func testOverlappingHigherWindowRequiresNoRaise() {
        let result = hitTest([
            candidate(id: 1, bounds: CGRect(x: 100, y: 100, width: 200, height: 200)),
            candidate(id: 2, bounds: display)
        ], at: CGPoint(x: 20, y: 20))

        XCTAssertEqual(result, .target(WindowTarget(
            windowID: 2,
            ownerPID: 10,
            bounds: display,
            ownerName: "Example",
            requiresNoRaise: true
        )))
    }

    func testWindowServerDoesNotMakeTargetRequireNoRaise() {
        let result = hitTest([
            candidate(id: 1, layer: 2, ownerName: "Window Server", bounds: CGRect(x: 100, y: 100, width: 200, height: 200)),
            candidate(id: 2, bounds: display)
        ], at: CGPoint(x: 20, y: 20))

        XCTAssertEqual(result, .target(WindowTarget(
            windowID: 2,
            ownerPID: 10,
            bounds: display,
            ownerName: "Example"
        )))
    }

    func testRejectsNegativeAndZeroAreaCandidates() {
        let result = hitTest([
            candidate(id: 1, bounds: CGRect(x: 0, y: 0, width: 0, height: 100)),
            candidate(id: 2, bounds: CGRect(x: 0, y: 0, width: -10, height: 100)),
            candidate(id: 3, bounds: display)
        ], at: CGPoint(x: 10, y: 10))

        XCTAssertEqual(result, .target(WindowTarget(
            windowID: 3,
            ownerPID: 10,
            bounds: display,
            ownerName: "Example"
        )))
    }

    func testRejectsOffscreenSliver() {
        let result = hitTest([
            candidate(id: 1, bounds: CGRect(x: 950, y: 0, width: 1000, height: 800))
        ], at: CGPoint(x: 975, y: 100))

        XCTAssertEqual(result, .none)
    }

    func testUnionsOverlappingDisplaysWithNegativeCoordinates() {
        let displays = [
            CGRect(x: -1000, y: 0, width: 1000, height: 800),
            CGRect(x: -500, y: 0, width: 1000, height: 800)
        ]
        let result = hitTest([
            candidate(id: 1, bounds: CGRect(x: -1000, y: 0, width: 1500, height: 800))
        ], displays: displays, at: CGPoint(x: -750, y: 200))

        XCTAssertEqual(result, .target(WindowTarget(
            windowID: 1,
            ownerPID: 10,
            bounds: CGRect(x: -1000, y: 0, width: 1500, height: 800),
            ownerName: "Example"
        )))
    }

    func testReturnsNoResultWhenNothingContainsPoint() {
        let result = hitTest([
            candidate(id: 1, bounds: CGRect(x: 0, y: 0, width: 100, height: 100))
        ], at: CGPoint(x: 500, y: 500))

        XCTAssertEqual(result, .none)
    }

    private func hitTest(
        _ candidates: [WindowCandidate],
        displays: [CGRect]? = nil,
        at point: CGPoint
    ) -> WindowHitResult {
        WindowHitTester.hitTest(
            point: point,
            candidates: candidates,
            displayRects: displays ?? [display]
        )
    }

    private func candidate(
        id: CGWindowID,
        layer: Int = 0,
        ownerName: String = "Example",
        bounds: CGRect
    ) -> WindowCandidate {
        WindowCandidate(
            windowID: id,
            ownerPID: 10,
            layer: layer,
            bounds: bounds,
            ownerName: ownerName
        )
    }
}
