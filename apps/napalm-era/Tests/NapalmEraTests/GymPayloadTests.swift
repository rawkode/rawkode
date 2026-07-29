import XCTest
@testable import NapalmEra

final class GymPayloadTests: XCTestCase {
    func testMassConversionRoundTrips() {
        let kilograms = 62.5
        let pounds = MassUnitPreference.pounds.displayValue(kilograms: kilograms)
        XCTAssertEqual(MassUnitPreference.pounds.kilograms(displayValue: pounds), kilograms, accuracy: 0.0001)
    }

    func testCompletedSetSnapshotsLoadAndRepetitions() {
        let set = CompletedSetPayload(
            id: UUID(), machineID: UUID(), machineName: "Chest press", order: 1,
            loadKilograms: 45, repetitions: 12, completedAt: .now
        )
        XCTAssertEqual(set.loadKilograms, 45)
        XCTAssertEqual(set.repetitions, 12)
    }
}

