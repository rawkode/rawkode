import Foundation

/// The real test double `WorkoutDataSource`'s dependency-injection seam exists for (hard
/// constraint: "genuinely test the import/transformation pipeline... end to end... using a
/// synthetic/injected data source"). Two fixtures, matching the task's own examples verbatim: "a
/// strength session with multiple exercises/sets, a cardio session with distance/pace" — both
/// real, realistic, hand-authored values (plausible weights/reps/paces for an actual training
/// session), not degenerate placeholders. `fetchRecentWorkouts` replays whichever fixtures fall
/// within `[since, .now]`, so a caller can exercise "no results" / "one result" / "both results"
/// the same way a real HealthKit query's date predicate would.
public final class SyntheticWorkoutDataSource: WorkoutDataSource, @unchecked Sendable {
    private let workouts: [ImportedWorkout]

    /// `workouts` defaults to `Self.defaultFixtures` (below) — a caller wanting a different mix
    /// (an empty workspace, a single cardio-only session, many workouts for a pagination test) passes
    /// its own array instead.
    public init(workouts: [ImportedWorkout] = SyntheticWorkoutDataSource.defaultFixtures) {
        self.workouts = workouts
    }

    public func requestAuthorizationIfNeeded() async throws -> Bool { true }

    public func fetchRecentWorkouts(since: Date, limit: Int) async throws -> [ImportedWorkout] {
        Array(
            workouts
                .filter { $0.completedAt >= since }
                .sorted { $0.startedAt > $1.startedAt }
                .prefix(max(0, limit))
        )
    }

    /// A strength session: Back Squat (3 sets, ramping weight, last set to RPE 8) then Bench Press
    /// (2 sets) — mirrors this stage's own backend test fixture
    /// (`packages/backend/test/workouts.test.ts#strengthPayload`) so the same shape is proven
    /// through both the native transformation pipeline and the backend's `WorkoutsService`
    /// independently.
    public static let strengthFixture = ImportedWorkout(
        sourceWorkoutId: "synthetic-strength-fixture-1",
        source: .synthetic,
        activity: .strengthTraining,
        startedAt: ISO8601DateFormatter().date(from: "2026-08-15T09:00:00Z")!,
        completedAt: ISO8601DateFormatter().date(from: "2026-08-15T09:45:00Z")!,
        durationSeconds: 2700,
        energyKilocalories: 320,
        averageHeartRate: 118,
        maximumHeartRate: 152,
        strengthExercises: [
            ImportedStrengthExercise(
                ordinal: 1,
                name: "Back Squat",
                sets: [
                    ImportedStrengthSet(ordinal: 1, repetitions: 8, loadKilograms: 60),
                    ImportedStrengthSet(ordinal: 2, repetitions: 8, loadKilograms: 65),
                    ImportedStrengthSet(ordinal: 3, repetitions: 6, loadKilograms: 70, rpe: 8)
                ]
            ),
            ImportedStrengthExercise(
                ordinal: 2,
                name: "Bench Press",
                sets: [
                    ImportedStrengthSet(ordinal: 1, repetitions: 10, loadKilograms: 40),
                    ImportedStrengthSet(ordinal: 2, repetitions: 8, loadKilograms: 45)
                ]
            )
        ]
    )

    /// A cardio session: a 3 km run with three 1 km splits and real pace/distance roll-ups —
    /// mirrors `packages/backend/test/workouts.test.ts#cardioPayload`.
    public static let cardioFixture = ImportedWorkout(
        sourceWorkoutId: "synthetic-cardio-fixture-1",
        source: .synthetic,
        activity: .running,
        startedAt: ISO8601DateFormatter().date(from: "2026-08-16T07:00:00Z")!,
        completedAt: ISO8601DateFormatter().date(from: "2026-08-16T07:32:00Z")!,
        durationSeconds: 1920,
        energyKilocalories: 410,
        averageHeartRate: 152,
        maximumHeartRate: 171,
        cardioSplits: [
            ImportedCardioSplit(ordinal: 1, distanceMeters: 1000, durationSeconds: 300, averageHeartRate: 148),
            ImportedCardioSplit(ordinal: 2, distanceMeters: 1000, durationSeconds: 295, averageHeartRate: 153),
            ImportedCardioSplit(ordinal: 3, distanceMeters: 1000, durationSeconds: 310, averageHeartRate: 156)
        ],
        cardioTotals: ImportedCardioTotals(
            distanceMeters: 3000,
            elevationMeters: 12,
            averageSpeedMetersPerSecond: 3.1,
            averagePaceSecondsPerKilometre: 322
        )
    )

    public static let defaultFixtures: [ImportedWorkout] = [strengthFixture, cardioFixture]
}
