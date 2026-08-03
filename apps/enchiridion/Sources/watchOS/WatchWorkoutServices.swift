import EnchiridionWorkoutTransport
import Foundation
import HealthKit
import WatchConnectivity

struct WatchWorkoutHealthKitExport: Sendable {
  var state: WorkoutHealthKitExportState
  var errorCategory: String? = nil
  var workoutUUID: String? = nil
  var routeState: WorkoutRouteState = .notRequested
}
@MainActor protocol WatchWorkoutHealthKitExporting: AnyObject {
  func begin(eventID: UUID, activity: WorkoutActivity, startedAt: Date) async
  func cancel(eventID: UUID) async
  func finishOrRecover(eventID: UUID, activity: WorkoutActivity, startedAt: Date, completedAt: Date)
    async -> WatchWorkoutHealthKitExport
  func recover(eventID: UUID) async -> WatchWorkoutHealthKitExport
}

/// Best-effort HealthKit mirror. `HKMetadataKeyExternalUUID` is the durable
/// idempotency key: recovery queries it before any save, so a crash never makes
/// a second HKWorkout. Route geometry remains in HealthKit and never crosses the
/// Enchiridion transport boundary.
@MainActor final class WatchHealthKitExportService: WatchWorkoutHealthKitExporting {
  private let store = HKHealthStore()
  private var activeSessions: [UUID: HKWorkoutSession] = [:]
  private var authorizedEvents: Set<UUID> = []
  func begin(eventID: UUID, activity: WorkoutActivity, startedAt: Date) async {
    guard HKHealthStore.isHealthDataAvailable() else { return }
    let types: Set<HKSampleType> = [HKObjectType.workoutType()]
    do { try await store.requestAuthorization(toShare: types, read: types) } catch { return }
    guard store.authorizationStatus(for: .workoutType()) == .sharingAuthorized else { return }
    authorizedEvents.insert(eventID)
    guard activeSessions[eventID] == nil else { return }
    let config = HKWorkoutConfiguration()
    config.activityType = activity.hkType
    if let session = try? HKWorkoutSession(healthStore: store, configuration: config) {
      activeSessions[eventID] = session
      session.startActivity(with: startedAt)
    }
  }
  func cancel(eventID: UUID) async {
    activeSessions.removeValue(forKey: eventID)?.end()
    authorizedEvents.remove(eventID)
  }
  func finishOrRecover(eventID: UUID, activity: WorkoutActivity, startedAt: Date, completedAt: Date)
    async -> WatchWorkoutHealthKitExport
  {
    let existing = await recover(eventID: eventID)
    if existing.state == .saved {
      activeSessions.removeValue(forKey: eventID)?.end()
      return existing
    }
    guard HKHealthStore.isHealthDataAvailable() else {
      return .init(state: .unavailable, routeState: .unavailable)
    }
    guard store.authorizationStatus(for: .workoutType()) == .sharingAuthorized else {
      let state: WorkoutHealthKitExportState =
        authorizedEvents.contains(eventID) ? .revoked : .notAuthorized
      activeSessions.removeValue(forKey: eventID)?.end()
      authorizedEvents.remove(eventID)
      return .init(state: state, routeState: activity.requiresRoute ? .unavailable : .notRequested)
    }
    let workout = HKWorkout(
      activityType: activity.hkType, start: startedAt, end: completedAt, workoutEvents: nil,
      totalEnergyBurned: nil, totalDistance: nil,
      metadata: [HKMetadataKeyExternalUUID: eventID.uuidString])
    do {
      try await store.save(workout)
      activeSessions.removeValue(forKey: eventID)?.end()
      authorizedEvents.remove(eventID)
      return .init(
        state: .saved, workoutUUID: workout.uuid.uuidString,
        routeState: activity.requiresRoute ? .unavailable : .notRequested)
    } catch { return .init(state: .failed, errorCategory: "save-failed") }
  }
  func recover(eventID: UUID) async -> WatchWorkoutHealthKitExport {
    guard HKHealthStore.isHealthDataAvailable() else {
      return .init(state: .unavailable, routeState: .unavailable)
    }
    for attempt in 0..<3 {
      let result = await find(eventID: eventID)
      if result.state != .notRequested { return result }
      if attempt < 2 { try? await Task.sleep(for: .seconds(1)) }
    }
    return .init(state: .failed, errorCategory: "metadata-not-indexed")
  }
  private func find(eventID: UUID) async -> WatchWorkoutHealthKitExport {
    let predicate = HKQuery.predicateForObjects(
      withMetadataKey: HKMetadataKeyExternalUUID, allowedValues: [eventID.uuidString])
    return await withCheckedContinuation { continuation in
      store.execute(
        HKSampleQuery(
          sampleType: .workoutType(), predicate: predicate, limit: 1, sortDescriptors: nil
        ) { _, samples, error in
          if let workout = samples?.first as? HKWorkout {
            continuation.resume(
              returning: .init(state: .saved, workoutUUID: workout.uuid.uuidString))
          } else if error != nil {
            continuation.resume(returning: .init(state: .failed, errorCategory: "query-failed"))
          } else {
            continuation.resume(returning: .init(state: .notRequested))
          }
        })
    }
  }
}
extension WorkoutActivity {
  fileprivate var hkType: HKWorkoutActivityType {
    switch self {
    case .strengthTraining: .traditionalStrengthTraining
    case .outdoorRun, .indoorRun: .running
    case .outdoorCycle, .indoorCycle: .cycling
    case .outdoorWalk: .walking
    case .hiking: .hiking
    case .other: .other
    }
  }
  fileprivate var requiresRoute: Bool {
    self == .outdoorRun || self == .outdoorCycle || self == .outdoorWalk || self == .hiking
  }
}

@MainActor protocol WatchWorkoutTransferring: AnyObject {
  @discardableResult func enqueueEnvelope(_ envelope: WorkoutCaptureEnvelope) -> Bool
  @discardableResult func enqueueAcknowledgementObserved(
    _ acknowledgement: WorkoutImportAcknowledgement
  ) -> Bool
}
@MainActor
final class WatchConnectivityTransfer: NSObject, WatchWorkoutTransferring, WCSessionDelegate {
  static var responseHandler: (@MainActor (WorkoutDeliveryResponse) -> Void)?
  private let session: WCSession
  override init() {
    session = .default
    super.init()
    if WCSession.isSupported() {
      session.delegate = self
      session.activate()
    }
  }
  func enqueueEnvelope(_ envelope: WorkoutCaptureEnvelope) -> Bool {
    guard let data = try? JSONEncoder().encode(envelope), WCSession.isSupported() else {
      return false
    }
    _ = session.transferUserInfo([WorkoutWatchConnectivityWire.envelopeKey: data])
    return true
  }
  func enqueueAcknowledgementObserved(_ acknowledgement: WorkoutImportAcknowledgement) -> Bool {
    guard let data = try? JSONEncoder().encode(acknowledgement), WCSession.isSupported() else {
      return false
    }
    _ = session.transferUserInfo([WorkoutWatchConnectivityWire.responseObservedKey: data])
    return true
  }
  nonisolated func session(
    _: WCSession, activationDidCompleteWith: WCSessionActivationState, error: Error?
  ) {}
  nonisolated func session(_: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
    guard let data = userInfo[WorkoutWatchConnectivityWire.responseKey] as? Data,
      let response = try? JSONDecoder().decode(WorkoutDeliveryResponse.self, from: data)
    else { return }
    Task { @MainActor in Self.responseHandler?(response) }
  }
}
