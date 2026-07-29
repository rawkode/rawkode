@preconcurrency import HealthKit
import Foundation
import Observation

@MainActor
@Observable
final class WatchWorkoutManager: NSObject {
    private let store = HKHealthStore()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private(set) var isRunning = false
    private(set) var errorMessage: String?

    func start() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw WatchWorkoutError.healthUnavailable }
        let workoutType = HKObjectType.workoutType()
        try await store.requestAuthorization(toShare: [workoutType], read: [workoutType])

        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .traditionalStrengthTraining
        configuration.locationType = .indoor
        let session = try HKWorkoutSession(healthStore: store, configuration: configuration)
        let builder = session.associatedWorkoutBuilder()
        builder.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: configuration)
        session.delegate = self
        self.session = session
        self.builder = builder
        let start = Date.now
        session.startActivity(with: start)
        try await builder.beginCollection(at: start)
        isRunning = true
    }

    func recoverIfNeeded() async {
        guard session == nil else { return }
        do {
            let recovered: HKWorkoutSession? = try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<HKWorkoutSession?, any Error>) in
                store.recoverActiveWorkoutSession { session, error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume(returning: session) }
                }
            }
            guard let recovered else { return }
            recovered.delegate = self
            session = recovered
            builder = recovered.associatedWorkoutBuilder()
            isRunning = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func finish() async throws -> UUID? {
        guard let session, let builder else { return nil }
        let end = Date.now
        session.end()
        try await builder.endCollection(at: end)
        let workout = try await builder.finishWorkout()
        self.session = nil
        self.builder = nil
        isRunning = false
        return workout?.uuid
    }
}

extension WatchWorkoutManager: HKWorkoutSessionDelegate {
    nonisolated func workoutSession(
        _ workoutSession: HKWorkoutSession,
        didChangeTo toState: HKWorkoutSessionState,
        from fromState: HKWorkoutSessionState,
        date: Date
    ) {
        Task { @MainActor in isRunning = toState == .running || toState == .paused }
    }

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: any Error) {
        Task { @MainActor in
            errorMessage = error.localizedDescription
            isRunning = false
        }
    }
}

enum WatchWorkoutError: LocalizedError {
    case healthUnavailable
    var errorDescription: String? { "Apple Health is unavailable on this Watch." }
}
