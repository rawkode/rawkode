import XCTest
@testable import MultipassCore

final class AttachmentPolicyTests: XCTestCase {
    func testLaunchWithKeyboardDoesNotClaim() {
        var policy = AttachmentPolicy()
        XCTAssertNil(policy.observe(keyboardPresent: true))
        XCTAssertNil(policy.observe(keyboardPresent: true))
    }

    func testOnlyFreshArrivalClaimsAndDepartureInvalidates() throws {
        var policy = AttachmentPolicy()
        XCTAssertNil(policy.observe(keyboardPresent: false))
        let token = try XCTUnwrap(policy.observe(keyboardPresent: true))
        XCTAssertTrue(policy.isCurrent(token))
        XCTAssertNil(policy.observe(keyboardPresent: true))
        XCTAssertNil(policy.observe(keyboardPresent: false))
        XCTAssertFalse(policy.isCurrent(token))
    }

    func testWakeOrPauseInvalidatesInFlightClaim() throws {
        var policy = AttachmentPolicy()
        _ = policy.observe(keyboardPresent: false)
        let token = try XCTUnwrap(policy.observe(keyboardPresent: true))
        policy.reset()
        XCTAssertFalse(policy.isCurrent(token))
        XCTAssertNil(policy.observe(keyboardPresent: true))
    }

    func testRemoteClaimRequiresLocalKeyboardAbsentAndDifferentValidSlot() {
        func allowed(_ enabled: Bool = true, _ local: Int = 1, _ target: Int = 2,
                     _ keyboard: Bool = false, _ mouse: Bool = true) -> Bool {
            AttachmentPolicy.permitsSwitch(enabled: enabled, localSlot: local, targetSlot: target,
                                           keyboardPresent: keyboard, mousePresent: mouse)
        }
        XCTAssertTrue(allowed())
        XCTAssertFalse(allowed(false))
        XCTAssertFalse(allowed(true, 1, 1))
        XCTAssertFalse(allowed(true, 1, 4))
        XCTAssertFalse(allowed(true, 0, 2))
        XCTAssertFalse(allowed(true, 1, 2, true))
        XCTAssertFalse(allowed(true, 1, 2, false, false))
    }
}
