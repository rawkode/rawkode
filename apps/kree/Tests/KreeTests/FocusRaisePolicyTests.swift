import XCTest
@testable import Kree

final class FocusRaisePolicyTests: XCTestCase {
    func testRawValuesAreStable() {
        XCTAssertEqual(FocusRaisePolicy.allCases.map(\.rawValue), ["automatic", "always", "never"])
        XCTAssertEqual(FocusRaisePolicy.allCases.map(\.displayName), ["Automatic", "Always", "Never"])
    }

    func testShouldRaiseMapping() {
        let target = WindowTarget(
            windowID: 1,
            ownerPID: 2,
            bounds: .zero,
            ownerName: "Test"
        )
        let coveredTarget = WindowTarget(
            windowID: 3,
            ownerPID: 4,
            bounds: .zero,
            ownerName: "Test",
            requiresNoRaise: true
        )

        XCTAssertTrue(FocusRaisePolicy.automatic.shouldRaise(for: target))
        XCTAssertFalse(FocusRaisePolicy.automatic.shouldRaise(for: coveredTarget))
        XCTAssertTrue(FocusRaisePolicy.always.shouldRaise(for: coveredTarget))
        XCTAssertFalse(FocusRaisePolicy.never.shouldRaise(for: target))
    }

    func testDecodeDefaultsMissingAndUnknownValuesToAutomatic() {
        XCTAssertEqual(FocusRaisePolicy.decode(nil), .automatic)
        XCTAssertEqual(FocusRaisePolicy.decode("unexpected"), .automatic)
        XCTAssertEqual(FocusRaisePolicy.decode("always"), .always)
    }
}
