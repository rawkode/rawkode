import Foundation
import HealthKit

// Real HealthKit-backed `WorkoutDataSource` — genuine `HKHealthStore`/`HKSampleQuery`/
// `HKStatisticsQuery` usage, type-checked against the real HealthKit SDK on this machine
// (`swift build` succeeds — see `docs/workouts-decisions.md` for the exact command run and its
// output) but **genuinely untested end-to-end here**, same "real, correctly structured code that
// cannot be exercised live in this sandboxed environment" situation `ScreenCaptureKitAudioSource`
// (Meetings, Phase 6) already documents for its own reason: no TCC consent dialog can be clicked
// by a human in this automated environment, HealthKit has no simulator/injectable store, and this
// machine has no real Apple Watch/HealthKit data to query in the first place (hard constraint).
// `SyntheticWorkoutDataSource` is what proves the REST of the pipeline (transformation, RPC call,
// backend graph materialization) end to end instead — see that file's own header comment.
//
// **What this class can and cannot actually give you, verified against the real HealthKit SDK
// headers on this machine (`HealthKit.framework/Headers`) this stage, not assumed from memory:**
//
//   - `HKWorkout.totalEnergyBurned`/`.totalDistance` are `API_DEPRECATED` (in favor of
//     `statistics(for:)`/`allStatistics`, since iOS 18/macOS 15 per this SDK's own headers) — this
//     class uses `statistics(for:)` throughout, not the deprecated properties, since this is new
//     code with no legacy-API-support obligation.
//   - `HKWorkout` carries no average/maximum heart rate directly — those are derived here via a
//     separate `HKStatisticsQuery` over `HKQuantityType(.heartRate)` samples correlated to the
//     workout via `HKQuery.predicateForObjects(from:)` (Apple's documented pattern for "samples
//     that belong to this specific workout").
//   - **Per-exercise/per-set structure for a `.strengthTraining` `HKWorkout` is NOT exposed by any
//     public HealthKit read API** — verified by inspecting `HKWorkout.h`/`HKWorkoutActivity.h`:
//     `workoutActivities`/`allStatistics` describe aggregate *statistics* per constituent
//     activity (useful for a multi-sport workout), never per-exercise-name/per-set/per-rep data,
//     which only exists inside whichever first- or third-party Fitness app recorded the workout
//     and is not re-exposed to other apps. This class therefore NEVER populates
//     `ImportedWorkout.strengthExercises` — see that field's own doc comment and
//     `WorkoutImportBridge`'s fallback rule for the consequence.
//   - Cardio **splits** ARE derivable, best-effort: `HKWorkout.workoutEvents` of type `.lap`/
//     `.segment` carry a `dateInterval` (their only guaranteed field); this class runs one
//     `HKStatisticsQuery` per segment (over the activity-appropriate distance type, predicate
//     bounded to that segment's own interval AND `predicateForObjects(from: workout)`) to recover
//     that segment's own distance. Many real `HKWorkout` samples carry NO lap/segment events at
//     all (lap/segment marking is an originating-app choice) — `cardioSplits` is simply empty in
//     that case, and only the root-level `cardioTotals` roll-up is populated.
@available(macOS 13.0, iOS 16.0, *)
public final class HealthKitWorkoutDataSource: WorkoutDataSource, @unchecked Sendable {
    private let store: HKHealthStore

    /// The full read-authorization set this source ever queries — requested together, once, so a
    /// caller gets one consent sheet rather than one per quantity type discovered lazily.
    private static var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [HKObjectType.workoutType()]
        for identifier: HKQuantityTypeIdentifier in [
            .activeEnergyBurned, .distanceWalkingRunning, .distanceCycling, .distanceSwimming, .heartRate
        ] {
            if let type = HKObjectType.quantityType(forIdentifier: identifier) {
                types.insert(type)
            }
        }
        return types
    }

    public init() throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw WorkoutDataSourceError.healthDataUnavailable }
        self.store = HKHealthStore()
    }

    /// Requests read authorization for every type `Self.readTypes` names. **Per Apple's own
    /// documented privacy model, a `true` return means "the user was presented the sheet and
    /// responded" — NOT "every type was granted"**: HealthKit deliberately never reports per-type
    /// grant/deny status for READ authorization back to the requesting app (so an app cannot probe
    /// what health data a user chose to withhold). A denied type simply returns no samples from
    /// later queries, indistinguishable from "the user has no data of that type" — this class
    /// (and `fetchRecentWorkouts` below) has no way to tell those two cases apart, by HealthKit's
    /// own design, not a limitation of this code.
    public func requestAuthorizationIfNeeded() async throws -> Bool {
        try await withCheckedThrowingContinuation { continuation in
            store.requestAuthorization(toShare: [], read: Self.readTypes) { success, error in
                if let error {
                    continuation.resume(throwing: WorkoutDataSourceError.queryFailed(error.localizedDescription))
                } else {
                    continuation.resume(returning: success)
                }
            }
        }
    }

    public func fetchRecentWorkouts(since: Date, limit: Int) async throws -> [ImportedWorkout] {
        let workouts = try await queryWorkouts(since: since, limit: limit)
        var imported: [ImportedWorkout] = []
        imported.reserveCapacity(workouts.count)
        for workout in workouts {
            imported.append(try await importedWorkout(from: workout))
        }
        return imported
    }

    // MARK: - HKWorkout query

    private func queryWorkouts(since: Date, limit: Int) async throws -> [HKWorkout] {
        try await withCheckedThrowingContinuation { continuation in
            let predicate = HKQuery.predicateForSamples(withStart: since, end: nil, options: [.strictStartDate])
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
            let query = HKSampleQuery(
                sampleType: HKObjectType.workoutType(),
                predicate: predicate,
                limit: max(0, limit),
                sortDescriptors: [sort]
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: WorkoutDataSourceError.queryFailed(error.localizedDescription))
                    return
                }
                continuation.resume(returning: (samples as? [HKWorkout]) ?? [])
            }
            store.execute(query)
        }
    }

    // MARK: - Per-workout transformation

    private func importedWorkout(from workout: HKWorkout) async throws -> ImportedWorkout {
        let (activity, rawActivity) = Self.mapActivityType(workout.workoutActivityType)
        let energyKilocalories = try await statisticSum(
            identifier: .activeEnergyBurned,
            unit: .kilocalorie(),
            workout: workout
        )
        let distanceType = Self.distanceQuantityTypeIdentifier(for: workout.workoutActivityType)
        var distanceMeters: Double?
        if let distanceType {
            distanceMeters = try await statisticSum(identifier: distanceType, unit: .meter(), workout: workout)
        }
        let averageHeartRate = try await statisticAverage(identifier: .heartRate, unit: Self.heartRateUnit, workout: workout)
        let maximumHeartRate = try await statisticMax(identifier: .heartRate, unit: Self.heartRateUnit, workout: workout)
        let splits = try await cardioSplits(for: workout, distanceType: distanceType)

        return ImportedWorkout(
            sourceWorkoutId: workout.uuid.uuidString,
            source: .healthKit,
            activity: activity,
            rawActivity: rawActivity,
            startedAt: workout.startDate,
            completedAt: workout.endDate,
            durationSeconds: workout.duration,
            energyKilocalories: energyKilocalories,
            averageHeartRate: averageHeartRate,
            maximumHeartRate: maximumHeartRate,
            // Per this class's own header comment: HealthKit's public API never exposes
            // per-exercise/per-set structure, so this is always nil for a real read.
            strengthExercises: nil,
            cardioSplits: splits,
            cardioTotals: ImportedCardioTotals(
                distanceMeters: distanceMeters,
                elevationMeters: nil, // `HKQuantityTypeIdentifier.elevationAscended` — not requested/read this stage.
                averageSpeedMetersPerSecond: distanceMeters.map { $0 / workout.duration },
                averagePaceSecondsPerKilometre: (distanceMeters.map { $0 > 0 ? workout.duration / $0 * 1000 : nil }) ?? nil
            )
        )
    }

    /// Best-effort split derivation from lap/segment `HKWorkoutEvent`s — see this class's own
    /// header comment for why this is best-effort (many real workouts carry none).
    private func cardioSplits(for workout: HKWorkout, distanceType: HKQuantityTypeIdentifier?) async throws -> [ImportedCardioSplit] {
        guard let distanceType else { return [] }
        let segments = (workout.workoutEvents ?? []).filter { $0.type == .lap || $0.type == .segment }
        guard !segments.isEmpty else { return [] }

        var splits: [ImportedCardioSplit] = []
        splits.reserveCapacity(segments.count)
        for (index, event) in segments.enumerated() {
            let interval = event.dateInterval
            let distance = try await statisticSum(
                identifier: distanceType,
                unit: .meter(),
                workout: workout,
                interval: interval
            )
            let averageHeartRate = try await statisticAverage(
                identifier: .heartRate,
                unit: Self.heartRateUnit,
                workout: workout,
                interval: interval
            )
            let energy = try await statisticSum(
                identifier: .activeEnergyBurned,
                unit: .kilocalorie(),
                workout: workout,
                interval: interval
            )
            splits.append(
                ImportedCardioSplit(
                    ordinal: index + 1,
                    distanceMeters: distance ?? 0,
                    durationSeconds: interval.duration,
                    averageHeartRate: averageHeartRate,
                    energyKilocalories: energy
                )
            )
        }
        // Only return a shape the wire schema can accept (`CardioSplitImportInput.distanceMeters`
        // requires > 0, `workout-rpc.ts`) — a segment HealthKit reports zero distance for (a pause
        // marker, not a real lap) is dropped rather than sent as an invalid split.
        return splits.filter { $0.distanceMeters > 0 }
    }

    // MARK: - HKStatisticsQuery helpers

    private static let heartRateUnit = HKUnit.count().unitDivided(by: .minute())

    private func statisticSum(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        workout: HKWorkout,
        interval: DateInterval? = nil
    ) async throws -> Double? {
        try await statistic(identifier: identifier, unit: unit, workout: workout, interval: interval, options: .cumulativeSum) {
            $0.sumQuantity()
        }
    }

    private func statisticAverage(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        workout: HKWorkout,
        interval: DateInterval? = nil
    ) async throws -> Double? {
        try await statistic(identifier: identifier, unit: unit, workout: workout, interval: interval, options: .discreteAverage) {
            $0.averageQuantity()
        }
    }

    private func statisticMax(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        workout: HKWorkout,
        interval: DateInterval? = nil
    ) async throws -> Double? {
        try await statistic(identifier: identifier, unit: unit, workout: workout, interval: interval, options: .discreteMax) {
            $0.maximumQuantity()
        }
    }

    private func statistic(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        workout: HKWorkout,
        interval: DateInterval?,
        options: HKStatisticsOptions,
        extract: @escaping (HKStatistics) -> HKQuantity?
    ) async throws -> Double? {
        guard let quantityType = HKObjectType.quantityType(forIdentifier: identifier) else { return nil }
        let workoutPredicate = HKQuery.predicateForObjects(from: workout)
        let predicate: NSPredicate
        if let interval {
            let boundsPredicate = HKQuery.predicateForSamples(withStart: interval.start, end: interval.end, options: [])
            predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [workoutPredicate, boundsPredicate])
        } else {
            predicate = workoutPredicate
        }
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsQuery(quantityType: quantityType, quantitySamplePredicate: predicate, options: options) { _, statistics, error in
                if let error {
                    continuation.resume(throwing: WorkoutDataSourceError.queryFailed(error.localizedDescription))
                    return
                }
                let value = statistics.flatMap(extract)?.doubleValue(for: unit)
                continuation.resume(returning: value)
            }
            store.execute(query)
        }
    }

    // MARK: - Activity-type mapping

    /// The right distance quantity type for `activityType`, when one exists — mirrors how the
    /// Health app itself picks a distance metric per sport. `nil` for activity types with no
    /// natural distance concept (e.g. strength training).
    private static func distanceQuantityTypeIdentifier(for activityType: HKWorkoutActivityType) -> HKQuantityTypeIdentifier? {
        switch activityType {
        case .running, .walking, .hiking: return .distanceWalkingRunning
        case .cycling: return .distanceCycling
        case .swimming: return .distanceSwimming
        default: return nil
        }
    }

    /// Maps `HKWorkoutActivityType` to `WorkoutActivityKind`, per `WorkoutActivityKind`'s own doc
    /// comment: "map what you can name, preserve the rest losslessly." Returns the mapped kind
    /// plus, for `.other`, the SDK's own raw case description so nothing is silently dropped.
    private static func mapActivityType(_ activityType: HKWorkoutActivityType) -> (WorkoutActivityKind, String?) {
        switch activityType {
        case .traditionalStrengthTraining, .functionalStrengthTraining: return (.strengthTraining, nil)
        case .running: return (.running, nil)
        case .cycling: return (.cycling, nil)
        case .walking: return (.walking, nil)
        case .hiking: return (.hiking, nil)
        case .swimming: return (.swimming, nil)
        case .rowing: return (.rowing, nil)
        case .elliptical: return (.elliptical, nil)
        case .yoga: return (.yoga, nil)
        case .highIntensityIntervalTraining: return (.hiit, nil)
        default: return (.other, "HKWorkoutActivityType(rawValue: \(activityType.rawValue))")
        }
    }
}
