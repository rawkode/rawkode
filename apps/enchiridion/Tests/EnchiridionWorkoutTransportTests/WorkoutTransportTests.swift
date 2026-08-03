import EnchiridionWorkoutTransport
import XCTest

final class WorkoutTransportTests: XCTestCase {
  func testSemanticHashIsStableAndAcknowledgementUsesExactTuple() {
    let start = Date(timeIntervalSince1970: 1_000)
    let payload: WorkoutPayload = .strength(exercises: [
      .init(ordinal: 1, name: "Squat", sets: [.init(ordinal: 1, repetitions: 5, loadKilograms: 100)]),
    ])
    let first = WorkoutCaptureEnvelope(eventID: "00000000-0000-0000-0000-000000000001", startedAt: start, completedAt: start.addingTimeInterval(60), activity: .strengthTraining, status: .complete, durationSeconds: 60, payload: payload)
    let second = WorkoutCaptureEnvelope(eventID: "00000000-0000-0000-0000-000000000001", startedAt: start, completedAt: start.addingTimeInterval(60), activity: .strengthTraining, status: .complete, durationSeconds: 60, payload: payload)
    XCTAssertEqual(first.payloadHash, second.payloadHash)
    XCTAssertTrue(first.isAuthentic())
    XCTAssertEqual(WorkoutImportAcknowledgement(first).payloadHash, first.payloadHash)
  }

  func testHashRejectsTamperedTransportAndIncludesCardioMetrics() throws {
    let start = Date(timeIntervalSince1970: 1_000)
    let envelope = WorkoutCaptureEnvelope(eventID: "10000000-0000-0000-0000-000000000001", startedAt: start, completedAt: start.addingTimeInterval(60), activity: .outdoorRun, status: .complete, durationSeconds: 60, payload: .cardio(splits: [.init(ordinal: 1, distanceMeters: 200, durationSeconds: 60)], distanceMeters: 200, elevationMeters: 3, averageSpeedMetersPerSecond: 3.33, averagePaceSecondsPerKilometre: 300))
    let data = try JSONEncoder().encode(envelope)
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    object["durationSeconds"] = 61
    let tampered = try JSONDecoder().decode(WorkoutCaptureEnvelope.self, from: JSONSerialization.data(withJSONObject: object))
    XCTAssertFalse(tampered.isAuthentic())
    XCTAssertTrue(envelope.isAuthentic())
  }
}
