@preconcurrency import HealthKit
import Foundation

struct WorkoutSummary: Identifiable, Sendable {
    let id: UUID
    let activityName: String
    let startedAt: Date
    let duration: TimeInterval
    let activeEnergyKilocalories: Double?
}

protocol HealthKitClient: Sendable {
    func requestAuthorization() async throws
    func replaceMeal(id: UUID, name: String, eatenAt: Date, nutrients: [NutritionAmount]) async throws -> UUID
    func deleteMeal(id: UUID) async throws
    func fetchTodayWorkouts() async throws -> [WorkoutSummary]
}

enum HealthKitClientError: LocalizedError {
    case unavailable
    case missingType(String)

    var errorDescription: String? {
        switch self {
        case .unavailable: "Apple Health is unavailable on this device."
        case .missingType(let name): "Apple Health does not provide the \(name) data type."
        }
    }
}

actor LiveHealthKitClient: HealthKitClient {
    static let mealIDMetadataKey = "dev.rawkode.napalmera.meal-id"
    private let store = HKHealthStore()

    func requestAuthorization() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw HealthKitClientError.unavailable }
        let share = Set(NutritionMetric.allCases.compactMap { HKObjectType.quantityType(forIdentifier: $0.healthKitIdentifier) })
            .union([HKObjectType.workoutType()])
        let read: Set<HKObjectType> = [HKObjectType.workoutType()]
        try await store.requestAuthorization(toShare: share, read: read)
    }

    func replaceMeal(id: UUID, name: String, eatenAt: Date, nutrients: [NutritionAmount]) async throws -> UUID {
        try await deleteMeal(id: id)
        let metadata: [String: Any] = [HKMetadataKeyFoodType: name, Self.mealIDMetadataKey: id.uuidString]
        let samples = try Set(nutrients.map { value -> HKQuantitySample in
            guard let type = HKObjectType.quantityType(forIdentifier: value.metric.healthKitIdentifier) else {
                throw HealthKitClientError.missingType(value.metric.title)
            }
            return HKQuantitySample(
                type: type,
                quantity: HKQuantity(unit: value.metric.healthKitUnit, doubleValue: value.amount),
                start: eatenAt,
                end: eatenAt,
                metadata: metadata
            )
        })
        guard let foodType = HKObjectType.correlationType(forIdentifier: .food) else {
            throw HealthKitClientError.missingType("food correlation")
        }
        let correlation = HKCorrelation(type: foodType, start: eatenAt, end: eatenAt, objects: samples, metadata: metadata)
        try await store.save(correlation)
        return correlation.uuid
    }

    func deleteMeal(id: UUID) async throws {
        guard let foodType = HKObjectType.correlationType(forIdentifier: .food) else { return }
        let predicate = HKQuery.predicateForObjects(withMetadataKey: Self.mealIDMetadataKey, allowedValues: [id.uuidString])
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, any Error>) in
            store.deleteObjects(of: foodType, predicate: predicate) { _, _, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    func fetchTodayWorkouts() async throws -> [WorkoutSummary] {
        let start = Calendar.autoupdatingCurrent.startOfDay(for: .now)
        let end = Calendar.autoupdatingCurrent.date(byAdding: .day, value: 1, to: start) ?? .now
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        return try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<[WorkoutSummary], any Error>) in
            let query = HKSampleQuery(
                sampleType: HKObjectType.workoutType(),
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let values = (samples as? [HKWorkout] ?? []).map { workout in
                    let activeEnergy: Double?
                    if let type = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) {
                        activeEnergy = workout.statistics(for: type)?.sumQuantity()?.doubleValue(for: .kilocalorie())
                    } else {
                        activeEnergy = nil
                    }
                    return WorkoutSummary(
                        id: workout.uuid,
                        activityName: workout.workoutActivityType.displayName,
                        startedAt: workout.startDate,
                        duration: workout.duration,
                        activeEnergyKilocalories: activeEnergy
                    )
                }
                continuation.resume(returning: values)
            }
            store.execute(query)
        }
    }
}

actor PreviewHealthKitClient: HealthKitClient {
    func requestAuthorization() async throws {}
    func replaceMeal(id: UUID, name: String, eatenAt: Date, nutrients: [NutritionAmount]) async throws -> UUID { UUID() }
    func deleteMeal(id: UUID) async throws {}
    func fetchTodayWorkouts() async throws -> [WorkoutSummary] {
        [WorkoutSummary(id: UUID(), activityName: "Traditional Strength Training", startedAt: .now.addingTimeInterval(-3_600), duration: 2_700, activeEnergyKilocalories: 280)]
    }
}

private extension HKWorkoutActivityType {
    var displayName: String {
        switch self {
        case .traditionalStrengthTraining: "Strength Training"
        case .functionalStrengthTraining: "Functional Strength Training"
        case .running: "Run"
        case .walking: "Walk"
        case .cycling: "Cycling"
        case .rowing: "Rowing"
        default: "Workout"
        }
    }
}
