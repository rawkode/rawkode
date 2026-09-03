import Foundation

// Phase 7 (plan §"Phased delivery": "HealthKit import as typed graph pages, proves graph
// generality, no new mechanism"; hard constraint: "build the real HealthKit integration...
// behind a real Swift protocol... so a synthetic/injected data source can genuinely test the
// import/transformation pipeline... end to end, even though the live HealthKit store itself can't
// be queried here"). This file owns only the *interface* — the same domain/implementation split
// `AudioCaptureSource.swift` (Meetings, Phase 6) already establishes for the identical reason. Two
// real implementations exist: `HealthKitWorkoutDataSource` (genuine `HKHealthStore`/`HKSampleQuery`
// usage, real but untestable live in this environment — see its own header comment) and
// `SyntheticWorkoutDataSource` (a real, in-memory test double with realistic fixture data, used to
// prove the transformation/import pipeline end to end via `WorkoutImportBridge` against a real
// backend). Full design rationale: `docs/workouts-decisions.md`.

/// The activity vocabulary this pipeline recognizes — mirrors `packages/domain/src/workout.ts`'s
/// `WorkoutActivityKind` literal set exactly (raw values are the wire strings sent to
/// `importWorkout`). Wider than `HKWorkoutActivityType`'s ~80 cases; `HealthKitWorkoutDataSource`
/// maps every `HKWorkoutActivityType` it doesn't specifically recognize to `.other`, preserving
/// the SDK's own raw case name in `ImportedWorkout.rawActivity` (never dropped) — see
/// `workout.ts`'s `WorkoutActivityKind` doc comment for why this is deliberately wider than
/// Enchiridion's own narrower `WorkoutActivity` enum.
public enum WorkoutActivityKind: String, Sendable, Equatable, CaseIterable {
    case strengthTraining = "strength-training"
    case running
    case cycling
    case walking
    case hiking
    case swimming
    case rowing
    case elliptical
    case yoga
    case hiit
    case other
}

/// Which pipeline produced an `ImportedWorkout` — mirrors `workout.ts`'s `WorkoutSource`.
public enum WorkoutSourceKind: String, Sendable, Equatable {
    case healthKit = "healthkit"
    case synthetic = "synthetic"
}

/// One strength set — mirrors `workout-rpc.ts`'s `StrengthSetImportInput`. `ordinal` is 1-based.
public struct ImportedStrengthSet: Sendable, Equatable {
    public let ordinal: Int
    public let repetitions: Int
    public let loadKilograms: Double
    public let rpe: Double?
    public let completedAt: Date?

    public init(ordinal: Int, repetitions: Int, loadKilograms: Double, rpe: Double? = nil, completedAt: Date? = nil) {
        self.ordinal = ordinal
        self.repetitions = repetitions
        self.loadKilograms = loadKilograms
        self.rpe = rpe
        self.completedAt = completedAt
    }
}

/// One exercise within a strength workout — mirrors `workout-rpc.ts`'s
/// `StrengthExerciseImportInput`. `ordinal` is 1-based.
public struct ImportedStrengthExercise: Sendable, Equatable {
    public let ordinal: Int
    public let name: String
    public let sets: [ImportedStrengthSet]

    public init(ordinal: Int, name: String, sets: [ImportedStrengthSet]) {
        self.ordinal = ordinal
        self.name = name
        self.sets = sets
    }
}

/// One distance/time split — mirrors `workout-rpc.ts`'s `CardioSplitImportInput`. `ordinal` is
/// 1-based.
public struct ImportedCardioSplit: Sendable, Equatable {
    public let ordinal: Int
    public let distanceMeters: Double
    public let durationSeconds: Double
    public let averageHeartRate: Double?
    public let energyKilocalories: Double?

    public init(
        ordinal: Int,
        distanceMeters: Double,
        durationSeconds: Double,
        averageHeartRate: Double? = nil,
        energyKilocalories: Double? = nil
    ) {
        self.ordinal = ordinal
        self.distanceMeters = distanceMeters
        self.durationSeconds = durationSeconds
        self.averageHeartRate = averageHeartRate
        self.energyKilocalories = energyKilocalories
    }
}

/// Root-level cardio roll-ups — mirrors the cardio branch of `workout-rpc.ts`'s
/// `WorkoutImportPayload` union (`distanceMeters`/`elevationMeters`/
/// `averageSpeedMetersPerSecond`/`averagePaceSecondsPerKilometre`, all optional).
public struct ImportedCardioTotals: Sendable, Equatable {
    public let distanceMeters: Double?
    public let elevationMeters: Double?
    public let averageSpeedMetersPerSecond: Double?
    public let averagePaceSecondsPerKilometre: Double?

    public init(
        distanceMeters: Double? = nil,
        elevationMeters: Double? = nil,
        averageSpeedMetersPerSecond: Double? = nil,
        averagePaceSecondsPerKilometre: Double? = nil
    ) {
        self.distanceMeters = distanceMeters
        self.elevationMeters = elevationMeters
        self.averageSpeedMetersPerSecond = averageSpeedMetersPerSecond
        self.averagePaceSecondsPerKilometre = averagePaceSecondsPerKilometre
    }

    public static let empty = ImportedCardioTotals()
}

/// One imported workout session, source-agnostic (real `HKWorkout` or synthetic fixture) — the
/// value type both `HealthKitWorkoutDataSource` and `SyntheticWorkoutDataSource` produce, and the
/// input `WorkoutImportBridge` transforms into an `AthenaeumRPC.importWorkout` call.
///
/// **`strengthExercises` is deliberately optional AND separate from `cardioSplits`/`cardioTotals`**
/// (rather than one `payload` enum mirroring the wire's discriminated union directly) — because
/// what a *data source* can observe and what the *wire payload* requires are different shapes.
/// HealthKit's public API cannot supply per-exercise/per-set structure for a
/// `.strengthTraining`-activity `HKWorkout` it did not itself build via `HKWorkoutBuilder`
/// (verified this stage — see `HealthKitWorkoutDataSource`'s own header comment); a strength-
/// activity `HKWorkout` therefore always arrives here with `strengthExercises == nil`. Deciding
/// what wire payload shape to send for THAT case is `WorkoutImportBridge`'s job, not this type's —
/// see that file's own header comment for the exact fallback rule. `SyntheticWorkoutDataSource`
/// is the one source that CAN populate
/// `strengthExercises` for real, which is exactly what proves the transformation pipeline's
/// strength-shaped path end to end even though the live HealthKit source never exercises it.
public struct ImportedWorkout: Sendable, Equatable {
    public let sourceWorkoutId: String
    public let source: WorkoutSourceKind
    public let activity: WorkoutActivityKind
    public let rawActivity: String?
    public let startedAt: Date
    public let completedAt: Date
    public let durationSeconds: Double
    public let energyKilocalories: Double?
    public let averageHeartRate: Double?
    public let maximumHeartRate: Double?
    /// `nil` when the source has no per-exercise/per-set structure for this workout (every real
    /// `HealthKitWorkoutDataSource` read, always); non-nil and non-empty for a
    /// `SyntheticWorkoutDataSource` strength fixture.
    public let strengthExercises: [ImportedStrengthExercise]?
    public let cardioSplits: [ImportedCardioSplit]
    public let cardioTotals: ImportedCardioTotals

    public init(
        sourceWorkoutId: String,
        source: WorkoutSourceKind,
        activity: WorkoutActivityKind,
        rawActivity: String? = nil,
        startedAt: Date,
        completedAt: Date,
        durationSeconds: Double,
        energyKilocalories: Double? = nil,
        averageHeartRate: Double? = nil,
        maximumHeartRate: Double? = nil,
        strengthExercises: [ImportedStrengthExercise]? = nil,
        cardioSplits: [ImportedCardioSplit] = [],
        cardioTotals: ImportedCardioTotals = .empty
    ) {
        self.sourceWorkoutId = sourceWorkoutId
        self.source = source
        self.activity = activity
        self.rawActivity = rawActivity
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.durationSeconds = durationSeconds
        self.energyKilocalories = energyKilocalories
        self.averageHeartRate = averageHeartRate
        self.maximumHeartRate = maximumHeartRate
        self.strengthExercises = strengthExercises
        self.cardioSplits = cardioSplits
        self.cardioTotals = cardioTotals
    }
}

public enum WorkoutDataSourceError: Error, Sendable, Equatable {
    case healthDataUnavailable
    case authorizationDenied
    case queryFailed(String)
}

/// The real dependency-injection seam (hard constraint: "a real Swift protocol... so a
/// synthetic/injected data source can genuinely test the import/transformation pipeline"). One
/// implementation reads real HealthKit data; the other replays fixture data — both produce the
/// exact same `ImportedWorkout` shape, so `WorkoutImportBridge`/the backend `importWorkout` RPC
/// cannot distinguish which one produced a given call.
public protocol WorkoutDataSource: Sendable {
    /// Requests HealthKit read authorization for everything this source needs (workouts, energy,
    /// distance, heart rate). Returns `true` once the user has responded to every requested type
    /// (matching HealthKit's own `requestAuthorization` contract — see
    /// `HealthKitWorkoutDataSource`'s own doc comment for what this does and does not tell the
    /// caller). A synthetic source has nothing to authorize and returns `true` unconditionally.
    func requestAuthorizationIfNeeded() async throws -> Bool

    /// Fetches every workout that completed on or after `since`, most recent first, capped at
    /// `limit`.
    func fetchRecentWorkouts(since: Date, limit: Int) async throws -> [ImportedWorkout]
}
