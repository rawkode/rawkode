import XCTest
@testable import AthenaeumCore
import AthenaeumRPC

/// Pure unit tests for `WorkoutImportBridge.payload(for:)` — the transformation logic between a
/// source-agnostic `ImportedWorkout` and the wire-shaped `RPCWorkoutImportPayload`, including the
/// "no structured breakdown available" fallback rule (see that function's own doc comment). No
/// network, no `WorkspaceRPCClient` — genuinely tests the transformation independent of the RPC/
/// backend layer, complementing `WorkoutImportBridgeLiveTests`' end-to-end proof.
final class WorkoutImportBridgeTests: XCTestCase {
    func testStrengthWorkoutWithExercisesProducesAStrengthPayload() {
        let payload = WorkoutImportBridge.payload(for: SyntheticWorkoutDataSource.strengthFixture)
        guard case .strength(let exercises) = payload else {
            return XCTFail("expected a .strength payload")
        }
        XCTAssertEqual(exercises.count, 2)
        XCTAssertEqual(exercises[0].name, "Back Squat")
        XCTAssertEqual(exercises[0].sets.count, 3)
        XCTAssertEqual(exercises[0].sets[2].rpe, 8)
        XCTAssertEqual(exercises[1].sets.count, 2)
    }

    func testCardioWorkoutWithSplitsProducesACardioPayload() {
        let payload = WorkoutImportBridge.payload(for: SyntheticWorkoutDataSource.cardioFixture)
        guard case .cardio(let splits, let distanceMeters, let elevationMeters, let averageSpeed, let averagePace) = payload else {
            return XCTFail("expected a .cardio payload")
        }
        XCTAssertEqual(splits.count, 3)
        XCTAssertEqual(distanceMeters, 3000)
        XCTAssertEqual(elevationMeters, 12)
        XCTAssertEqual(averageSpeed, 3.1)
        XCTAssertEqual(averagePace, 322)
    }

    /// The real, load-bearing fallback rule (`WorkoutImportBridge`'s own header comment): a
    /// strength-activity workout with NO structured exercise data — exactly what
    /// `HealthKitWorkoutDataSource` always produces, per its own header comment — must NOT be sent
    /// as `.strength(exercises: [])`, since `workout-rpc.ts`'s schema rejects an empty exercise
    /// list outright. It falls back to an empty `.cardio` payload instead.
    func testStrengthActivityWithNoStructuredDataFallsBackToEmptyCardioPayload() {
        let workout = ImportedWorkout(
            sourceWorkoutId: "hk-strength-no-structure",
            source: .healthKit,
            activity: .strengthTraining,
            startedAt: Date(timeIntervalSince1970: 0),
            completedAt: Date(timeIntervalSince1970: 1_800),
            durationSeconds: 1_800,
            strengthExercises: nil,
            cardioSplits: []
        )
        let payload = WorkoutImportBridge.payload(for: workout)
        guard case .cardio(let splits, _, _, _, _) = payload else {
            return XCTFail("expected a fallback .cardio payload")
        }
        XCTAssertTrue(splits.isEmpty)
    }

    /// Same fallback, but for an EMPTY (not nil) exercises array — a data source that returns
    /// `strengthExercises: []` rather than `nil` must be treated identically (both mean "no real
    /// structure"), per `payload(for:)`'s own `!exercises.isEmpty` check.
    func testEmptyStrengthExercisesArrayAlsoFallsBackToCardio() {
        let workout = ImportedWorkout(
            sourceWorkoutId: "empty-exercises",
            source: .synthetic,
            activity: .strengthTraining,
            startedAt: Date(timeIntervalSince1970: 0),
            completedAt: Date(timeIntervalSince1970: 60),
            durationSeconds: 60,
            strengthExercises: []
        )
        guard case .cardio = WorkoutImportBridge.payload(for: workout) else {
            return XCTFail("expected a fallback .cardio payload")
        }
    }

    func testSetCompletedAtIsFormattedAsIso8601() {
        let completedAt = Date(timeIntervalSince1970: 1_755_000_000)
        let workout = ImportedWorkout(
            sourceWorkoutId: "iso-check",
            source: .synthetic,
            activity: .strengthTraining,
            startedAt: Date(timeIntervalSince1970: 0),
            completedAt: Date(timeIntervalSince1970: 60),
            durationSeconds: 60,
            strengthExercises: [
                ImportedStrengthExercise(
                    ordinal: 1,
                    name: "Deadlift",
                    sets: [ImportedStrengthSet(ordinal: 1, repetitions: 5, loadKilograms: 100, completedAt: completedAt)]
                )
            ]
        )
        guard case .strength(let exercises) = WorkoutImportBridge.payload(for: workout) else {
            return XCTFail("expected a .strength payload")
        }
        let iso = try? XCTUnwrap(exercises.first?.sets.first?.completedAt)
        XCTAssertEqual(iso, ISO8601DateFormatter().string(from: completedAt))
    }
}
