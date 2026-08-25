import XCTest
@testable import Kree

final class FocusGenerationTests: XCTestCase {
    func testInvalidationMakesEarlierTokenStale() {
        let generation = FocusGeneration()
        let first = generation.activate()

        XCTAssertTrue(generation.isCurrent(first))

        let second = generation.invalidate()

        XCTAssertFalse(generation.isCurrent(first))
        XCTAssertTrue(generation.isCurrent(second))
    }

    func testDeactivationInvalidatesTokenAndStopsActivity() {
        let generation = FocusGeneration()
        let token = generation.activate()

        generation.deactivate()

        XCTAssertFalse(generation.isActive())
        XCTAssertFalse(generation.isCurrent(token))
    }
}
