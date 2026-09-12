import XCTest
@testable import MultipassNetwork

final class RequestLeaseTests: XCTestCase {
    func testRevocationIsImmediateAndPermanent() {
        let lease = RequestLease()
        XCTAssertTrue(lease.isValid)
        lease.invalidate()
        XCTAssertFalse(lease.isValid)
        lease.invalidate()
        XCTAssertFalse(lease.isValid)
    }

    func testMonotonicExpiry() async {
        let lease = RequestLease(durationNanoseconds: 20_000_000)
        XCTAssertTrue(lease.isValid)
        try? await Task.sleep(nanoseconds: 40_000_000)
        XCTAssertFalse(lease.isValid)
    }
}
