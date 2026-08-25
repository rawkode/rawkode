import CoreGraphics
import XCTest
@testable import Kree

final class SkyLightFocusTests: XCTestCase {
    func testRecordLayoutAndOrderedMarkers() {
        let first = SkyLightFocus.makeRecord(windowID: 0x11223344, kind: .first)
        let second = SkyLightFocus.makeRecord(windowID: 0x11223344, kind: .second)

        XCTAssertEqual(first.count, 248)
        XCTAssertEqual(first[0x04], 0xf8)
        XCTAssertEqual(first[0x3a], 0x10)
        XCTAssertEqual(Array(first[0x20..<0x30]), Array(repeating: 0xff, count: 16))
        XCTAssertEqual(Array(first[0x3c..<0x40]), [0x44, 0x33, 0x22, 0x11])
        XCTAssertEqual(first[0x08], 0x01)
        XCTAssertEqual(second[0x08], 0x02)
    }

    func testMissingCapabilityFailsClosedWithoutMutation() {
        let fake = configuredFake()
        fake.missingSymbols = ["SLPSSetFrontProcessWithOptions/_SLPSSetFrontProcessWithOptions"]

        let outcome = SkyLightFocus(operations: fake).activate(target: makeTarget(), raise: false)

        XCTAssertEqual(outcome, .noMutation(reason: .unavailable(fake.missingSymbols[0])))
        XCTAssertTrue(fake.calls.isEmpty)
    }

    func testRaiseAndNoRaiseUseExactSetterOptions() {
        let fake = configuredFake()
        XCTAssertEqual(SkyLightFocus(operations: fake).activate(target: makeTarget(), raise: true), .requestAccepted)
        XCTAssertEqual(fake.setterOptions, [0x200])
        XCTAssertEqual(fake.setterWindowIDs, [123])

        let noRaise = configuredFake()
        XCTAssertEqual(SkyLightFocus(operations: noRaise).activate(target: makeTarget(), raise: false), .requestAccepted)
        XCTAssertEqual(noRaise.setterOptions, [0x600])
        XCTAssertEqual(noRaise.setterWindowIDs, [123])
    }

    func testTransactionUsesPIDPSNFinalSnapshotTargetPSNAndCallOrder() {
        let fake = configuredFake()
        let target = makeTarget()

        XCTAssertEqual(SkyLightFocus(operations: fake).activate(target: target, raise: false), .requestAccepted)
        XCTAssertEqual(fake.calls, ["pid-psn", "snapshot", "setter", "post-1", "post-2"])
        XCTAssertEqual(fake.setterProcess, .init(high: 3, low: 4))
        XCTAssertEqual(fake.setterWindowID, 123)
        XCTAssertEqual(fake.postProcesses, [.init(high: 3, low: 4), .init(high: 3, low: 4)])
        XCTAssertEqual(fake.records.map { $0[0x08] }, [0x01, 0x02])
    }

    func testBothSetterSpellingsAreRepresentedByInjectedOperation() {
        for spelling in ["SLPSSetFrontProcessWithOptions", "_SLPSSetFrontProcessWithOptions"] {
            let fake = configuredFake()
            fake.setterSpelling = spelling
            XCTAssertEqual(SkyLightFocus(operations: fake).activate(target: makeTarget(), raise: true), .requestAccepted)
            XCTAssertEqual(fake.usedSetterSpelling, spelling)
        }
    }

    func testSetterFailurePostsNoRecords() {
        let fake = configuredFake()
        fake.setterResult = .failure(.failed(step: "setter", status: 17))

        XCTAssertEqual(SkyLightFocus(operations: fake).activate(target: makeTarget(), raise: false), .setterFailed(status: 17))
        XCTAssertEqual(fake.calls, ["pid-psn", "snapshot", "setter"])
    }

    func testBothRecordFailuresAreReportedAndBothAreAttempted() {
        let fake = configuredFake()
        fake.postResults = [
            .failure(.failed(step: "first", status: 21)),
            .failure(.failed(step: "second", status: 22))
        ]

        XCTAssertEqual(
            SkyLightFocus(operations: fake).activate(target: makeTarget(), raise: false),
            .recordFailures(
                SkyLightRecordFailure(kind: .first, status: 21),
                SkyLightRecordFailure(kind: .second, status: 22)
            )
        )
        XCTAssertEqual(fake.calls.suffix(2), ["post-1", "post-2"])
    }

    func testSecondRecordFailureKeepsItsPositionalSlot() {
        let fake = configuredFake()
        fake.postResults = [
            .success(()),
            .failure(.failed(step: "second", status: 22))
        ]

        XCTAssertEqual(
            SkyLightFocus(operations: fake).activate(target: makeTarget(), raise: false),
            .recordFailures(
                nil,
                SkyLightRecordFailure(kind: .second, status: 22)
            )
        )
    }

    func testRejectsRecycledWindowIDOwnerMismatchAndBoundsMismatch() {
        let ownerMismatch = configuredFake()
        ownerMismatch.snapshot = .success(SkyLightWindowSnapshot(windowID: 123, ownerPID: 99, bounds: makeTarget().bounds))
        XCTAssertEqual(SkyLightFocus(operations: ownerMismatch).activate(target: makeTarget(), raise: false), .noMutation(reason: .staleTarget))
        XCTAssertFalse(ownerMismatch.calls.contains("setter"))

        let boundsMismatch = configuredFake()
        boundsMismatch.snapshot = .success(SkyLightWindowSnapshot(windowID: 123, ownerPID: 42, bounds: CGRect(x: 0, y: 0, width: 80.25, height: 80)))
        XCTAssertEqual(SkyLightFocus(operations: boundsMismatch).activate(target: makeTarget(), raise: false), .noMutation(reason: .staleTarget))
        XCTAssertFalse(boundsMismatch.calls.contains("setter"))
    }

    private func makeTarget() -> WindowTarget {
        WindowTarget(windowID: 123, ownerPID: 42, bounds: CGRect(x: 0, y: 0, width: 80, height: 80), ownerName: "Test")
    }

    private func configuredFake() -> FakeSkyLightOperations {
        let fake = FakeSkyLightOperations()
        fake.snapshot = .success(SkyLightWindowSnapshot(windowID: 123, ownerPID: 42, bounds: makeTarget().bounds))
        fake.pidProcess = .success(.init(high: 3, low: 4))
        return fake
    }
}

private final class FakeSkyLightOperations: SkyLightOperations {
    var missingSymbols: [String] = []
    var snapshot: Result<SkyLightWindowSnapshot, SkyLightOperationError> = .failure(.unavailable("snapshot"))
    var pidProcess: Result<SkyLightProcessSerialNumber, SkyLightOperationError> = .failure(.unavailable("PID PSN"))
    var setterResult: Result<Void, SkyLightOperationError> = .success(())
    var postResults: [Result<Void, SkyLightOperationError>] = [.success(()), .success(())]
    var setterOptions: [UInt32] = []
    var setterWindowIDs: [CGWindowID] = []
    var setterWindowID: CGWindowID?
    var setterProcess: SkyLightProcessSerialNumber?
    var postProcesses: [SkyLightProcessSerialNumber] = []
    var records: [[UInt8]] = []
    var setterSpelling = "SLPSSetFrontProcessWithOptions"
    var usedSetterSpelling: String?
    var calls: [String] = []

    func windowSnapshot(for windowID: CGWindowID) -> Result<SkyLightWindowSnapshot, SkyLightOperationError> {
        calls.append("snapshot")
        return snapshot
    }

    func processPSN(for pid: pid_t) -> Result<SkyLightProcessSerialNumber, SkyLightOperationError> {
        calls.append("pid-psn")
        return pidProcess
    }

    func setFrontProcess(_ process: SkyLightProcessSerialNumber, windowID: CGWindowID, options: UInt32) -> Result<Void, SkyLightOperationError> {
        calls.append("setter")
        setterOptions.append(options)
        setterWindowIDs.append(windowID)
        setterWindowID = windowID
        setterProcess = process
        usedSetterSpelling = setterSpelling
        return setterResult
    }

    func postEventRecord(to process: SkyLightProcessSerialNumber, record: [UInt8]) -> Result<Void, SkyLightOperationError> {
        calls.append(record[0x08] == 0x01 ? "post-1" : "post-2")
        postProcesses.append(process)
        records.append(record)
        return postResults.removeFirst()
    }
}
