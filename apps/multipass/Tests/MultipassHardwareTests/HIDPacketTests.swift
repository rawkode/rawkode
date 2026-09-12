import XCTest
@testable import MultipassHardware

final class HIDPacketTests: XCTestCase {
    let request = HIDRequest(device: 0xff, feature: 0x0e, function: 1)

    func testSwitchReportUsesZeroBasedTargetAndSoftwareID() {
        let report = request.report(parameters: [1])
        XCTAssertEqual(report.count, 20)
        XCTAssertEqual(Array(report.prefix(5)), [0x11, 0xff, 0x0e, 0x1d, 1])
        XCTAssertTrue(report.dropFirst(5).allSatisfy { $0 == 0 })
    }

    func testIgnoresUnrelatedDevicesFeaturesFunctionsAndSoftwareIDs() {
        let reply: [UInt8] = [0x11, 0xff, 0x0e, 0x1d, 0, 0, 0]
        for index in 1..<4 {
            var unrelated = reply
            unrelated[index] ^= 1
            XCTAssertNil(request.match(unrelated))
        }
        var otherFunction = reply
        otherFunction[3] = 0x2d
        XCTAssertNil(request.match(otherFunction))
        var unsupportedReport = reply
        unsupportedReport[0] = 0x12
        XCTAssertNil(request.match(unsupportedReport))
    }

    func testMatchesErrorsOnlyForTheOutstandingRequest() {
        let error: [UInt8] = [0x10, 0xff, 0xff, 0x0e, 0x1d, 0x07, 0]
        XCTAssertEqual(request.match(error), .error(7))
        for index in [1, 3, 4] {
            var unrelated = error
            unrelated[index] ^= 1
            XCTAssertNil(request.match(unrelated))
        }
    }

    func testShortAndLongRepliesAndTruncation() {
        for reportID: UInt8 in [0x10, 0x11] {
            let reply: [UInt8] = [reportID, 0xff, 0x0e, 0x1d, 3, 1, 0]
            XCTAssertEqual(request.match(reply), .reply([3, 1, 0]))
            for count in 0..<7 { XCTAssertNil(request.match(Array(reply.prefix(count)))) }
        }
    }

    func testInvalidSlotsAndCancellationNeverOpenHardware() async {
        let controller = MouseController()
        for slot in [0, 4, -1] {
            guard case .failed = await controller.switchTo(slot: slot) else { return XCTFail("Invalid slot accepted") }
        }
        guard case .unavailable = await controller.switchTo(slot: 2, shouldProceed: { false }) else {
            return XCTFail("Cancelled switch accepted")
        }
    }
}
