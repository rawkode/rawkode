import XCTest
@testable import Kree

final class FocusAttemptGateTests: XCTestCase {
    func testReservesOnlyAfterCooldown() {
        let gate = FocusAttemptGate()

        XCTAssertTrue(gate.reserve(after: 0.25, now: 10.0))
        XCTAssertEqual(gate.remaining(after: 0.25, now: 10.1), 0.15, accuracy: 0.000_001)
        XCTAssertFalse(gate.reserve(after: 0.25, now: 10.1))
        XCTAssertTrue(gate.reserve(after: 0.25, now: 10.26))
    }
}
