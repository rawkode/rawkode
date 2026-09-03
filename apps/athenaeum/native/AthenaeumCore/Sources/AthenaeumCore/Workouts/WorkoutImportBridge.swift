import Foundation
import AthenaeumRPC

// The glue between `WorkoutDataSource`'s source-agnostic `ImportedWorkout` (this file's own
// import) and `AthenaeumRPC.WorkspaceRPCClient.importWorkout`'s plain wire-shaped parameters
// (`WorkspaceRPCClient+Workouts.swift`, `AthenaeumRPC` — see that file's own header comment for why
// the bridge lives HERE, in `AthenaeumCore`, rather than in `AthenaeumRPC` itself: `AthenaeumRPC`
// must stay buildable on watchOS, which cannot link `AthenaeumCore`/HealthKit types).
//
// This is the one place the "no structured breakdown available" fallback decision
// (`ImportedWorkout.strengthExercises`'s own doc comment) actually gets made:
//
// **Fallback rule**: if `activity == .strengthTraining` but `strengthExercises` is `nil` or
// empty (every real `HealthKitWorkoutDataSource` read of a strength-activity workout, per that
// file's own header comment — HealthKit's public API exposes no per-set/per-exercise structure
// for a workout it didn't build itself), the wire payload sent is `.cardio(splits: [])` — an
// empty-but-valid cardio-shaped payload — rather than `.strength(exercises: [])`, which
// `workout-rpc.ts`'s `WorkoutImportPayload` schema rejects outright (`exercises` requires
// `Schema.minItems(1)`, so a strength payload MUST carry at least one real exercise). The
// resulting root node is tagged `Cardio Workout`, not `Strength Workout` — a deliberate, honest
// consequence of "we know this was a strength session (`activity` fact says so) but have no
// structured breakdown to hang under it," not a silent misclassification: `activity` and
// `rawActivity` on the root node still record `"strength-training"` accurately (see
// `WorkoutsService#buildRootFacts`, backend) even though the node's *tag* reads Cardio Workout.
// `docs/workouts-decisions.md` documents this trade-off and names the alternative (a
// `strength-training`-typed root with zero children, no `Strength Workout`/`Cardio Workout` tag at
// all) that was considered and rejected for weakening the tag-closure guarantee every OTHER
// workout node gets ("every Workout-tagged node is either Strength or Cardio, no third state").
public enum WorkoutImportBridge {
    /// Builds the `AthenaeumRPC.RPCWorkoutImportPayload` for `workout`, applying the fallback rule
    /// above. Pure — no I/O, fully unit-testable without a `WorkspaceRPCClient`.
    public static func payload(for workout: ImportedWorkout) -> RPCWorkoutImportPayload {
        if let exercises = workout.strengthExercises, !exercises.isEmpty {
            return .strength(exercises: exercises.map { exercise in
                RPCStrengthExerciseInput(
                    ordinal: exercise.ordinal,
                    name: exercise.name,
                    sets: exercise.sets.map { set in
                        RPCStrengthSetInput(
                            ordinal: set.ordinal,
                            repetitions: set.repetitions,
                            loadKilograms: set.loadKilograms,
                            rpe: set.rpe,
                            completedAt: set.completedAt.map(Self.isoString)
                        )
                    }
                )
            })
        }
        return .cardio(
            splits: workout.cardioSplits.map { split in
                RPCCardioSplitInput(
                    ordinal: split.ordinal,
                    distanceMeters: split.distanceMeters,
                    durationSeconds: split.durationSeconds,
                    averageHeartRate: split.averageHeartRate,
                    energyKilocalories: split.energyKilocalories
                )
            },
            distanceMeters: workout.cardioTotals.distanceMeters,
            elevationMeters: workout.cardioTotals.elevationMeters,
            averageSpeedMetersPerSecond: workout.cardioTotals.averageSpeedMetersPerSecond,
            averagePaceSecondsPerKilometre: workout.cardioTotals.averagePaceSecondsPerKilometre
        )
    }

    private static func isoString(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    /// Sends `workout` to `client.importWorkout`, translating every field (including the payload
    /// fallback above). The one real, end-to-end entrypoint the hard constraint asks for: "genuinely
    /// test the import/transformation pipeline... end to end" — a caller drives
    /// `SyntheticWorkoutDataSource.fetchRecentWorkouts` → this function → a real `WorkspaceRPCClient`
    /// → the real backend `WorkoutsService`, then reads the resulting graph back over the same RPC
    /// surface (`Phase7ExitCriterionCLI`/`WorkoutImportBridgeLiveTests` do exactly this).
    public static func importWorkout(
        _ workout: ImportedWorkout,
        using client: WorkspaceRPCClient
    ) async throws -> (receipt: RPCWorkoutImportReceipt, duplicate: Bool) {
        try await client.importWorkout(
            sourceWorkoutId: workout.sourceWorkoutId,
            source: workout.source.rawValue,
            activity: workout.activity.rawValue,
            rawActivity: workout.rawActivity,
            startedAt: isoString(workout.startedAt),
            completedAt: isoString(workout.completedAt),
            durationSeconds: workout.durationSeconds,
            energyKilocalories: workout.energyKilocalories,
            averageHeartRate: workout.averageHeartRate,
            maximumHeartRate: workout.maximumHeartRate,
            payload: payload(for: workout)
        )
    }

    /// Builds the `RPCWorkoutImportItem` for one workout within a batch `importWorkouts` call —
    /// same field translation and payload-fallback rule as `importWorkout` above, factored out so
    /// both the single and batch entrypoints share one source of truth for the fallback logic.
    public static func batchItem(for workout: ImportedWorkout) -> RPCWorkoutImportItem {
        RPCWorkoutImportItem(
            sourceWorkoutId: workout.sourceWorkoutId,
            source: workout.source.rawValue,
            activity: workout.activity.rawValue,
            rawActivity: workout.rawActivity,
            startedAt: isoString(workout.startedAt),
            completedAt: isoString(workout.completedAt),
            durationSeconds: workout.durationSeconds,
            energyKilocalories: workout.energyKilocalories,
            averageHeartRate: workout.averageHeartRate,
            maximumHeartRate: workout.maximumHeartRate,
            payload: payload(for: workout)
        )
    }

    /// Batched sibling of `importWorkout(_:using:)` — a native sync loop backfilling HealthKit
    /// history has N workouts to send, not one (see `workout-rpc.ts`'s `ImportWorkoutsInput` doc
    /// comment for why this is a real batching win, not just a convenience). Results come back in
    /// the same order as `workouts`.
    public static func importWorkouts(
        _ workouts: [ImportedWorkout],
        using client: WorkspaceRPCClient
    ) async throws -> [RPCWorkoutImportBatchItemResult] {
        try await client.importWorkouts(workouts.map(batchItem(for:)))
    }
}
