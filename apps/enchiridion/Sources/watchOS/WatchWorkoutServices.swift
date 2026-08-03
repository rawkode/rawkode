import CoreLocation
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

enum WatchWorkoutRouteStatePolicy {
  static func authorization(_ status: CLAuthorizationStatus) -> WorkoutRouteState? {
    switch status {
    case .denied, .restricted: .unavailable
    case .notDetermined, .authorizedAlways, .authorizedWhenInUse: nil
    @unknown default: .unavailable
    }
  }

  static func finalized(
    priorState: WorkoutRouteState?, hasBuilder: Bool, savedRoute: Bool
  ) -> WorkoutRouteState {
    if let priorState { return priorState }
    guard hasBuilder else { return .unavailable }
    return savedRoute ? .saved : .failed
  }

  static func recovered(
    requiresRoute: Bool, foundRoute: Bool, queryFailed: Bool
  ) -> WorkoutRouteState {
    guard requiresRoute else { return .notRequested }
    if queryFailed { return .failed }
    return foundRoute ? .saved : .unavailable
  }
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
@MainActor
final class WatchHealthKitExportService: NSObject, WatchWorkoutHealthKitExporting,
  CLLocationManagerDelegate
{
  private static let activityMetadataKey = "dev.rawkode.enchiridion.workout.activity"
  private let store = HKHealthStore()
  private var activeSessions: [UUID: HKWorkoutSession] = [:]
  private var authorizedEvents: Set<UUID> = []
  private var routeBuilders: [UUID: HKWorkoutRouteBuilder] = [:]
  private var locationManagers: [UUID: CLLocationManager] = [:]
  private var routeEventsByManagerID: [ObjectIdentifier: UUID] = [:]
  private var routeStates: [UUID: WorkoutRouteState] = [:]
  func begin(eventID: UUID, activity: WorkoutActivity, startedAt: Date) async {
    guard HKHealthStore.isHealthDataAvailable() else { return }
    let types: Set<HKSampleType> = [HKObjectType.workoutType(), HKSeriesType.workoutRoute()]
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
    if activity.requiresRoute {
      let location = CLLocationManager()
      location.delegate = self
      locationManagers[eventID] = location
      routeEventsByManagerID[ObjectIdentifier(location)] = eventID
      location.requestWhenInUseAuthorization()
      guard
        location.authorizationStatus == .authorizedWhenInUse
          || location.authorizationStatus == .authorizedAlways
      else {
        if location.authorizationStatus == .notDetermined { return }
        routeStates[eventID] = .unavailable
        return
      }
      routeBuilders[eventID] = HKWorkoutRouteBuilder(healthStore: store, device: .local())
      location.startUpdatingLocation()
    }
  }
  func cancel(eventID: UUID) async {
    activeSessions.removeValue(forKey: eventID)?.end()
    authorizedEvents.remove(eventID)
    cleanUpRoute(eventID: eventID)
  }
  func finishOrRecover(eventID: UUID, activity: WorkoutActivity, startedAt: Date, completedAt: Date)
    async -> WatchWorkoutHealthKitExport
  {
    let existing = await recover(eventID: eventID)
    if existing.state == .saved {
      activeSessions.removeValue(forKey: eventID)?.end()
      authorizedEvents.remove(eventID)
      cleanUpRoute(eventID: eventID)
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
      cleanUpRoute(eventID: eventID)
      return .init(state: state, routeState: activity.requiresRoute ? .unavailable : .notRequested)
    }
    let workout = HKWorkout(
      activityType: activity.hkType, start: startedAt, end: completedAt, workoutEvents: nil,
      totalEnergyBurned: nil, totalDistance: nil,
      metadata: [
        HKMetadataKeyExternalUUID: eventID.uuidString,
        Self.activityMetadataKey: activity.rawValue,
      ])
    do {
      try await store.save(workout)
      activeSessions.removeValue(forKey: eventID)?.end()
      authorizedEvents.remove(eventID)
      let routeState = await finishRoute(eventID: eventID, workout: workout, activity: activity)
      return .init(state: .saved, workoutUUID: workout.uuid.uuidString, routeState: routeState)
    } catch {
      cleanUpRoute(eventID: eventID)
      return .init(state: .failed, errorCategory: "save-failed")
    }
  }
  nonisolated func locationManager(
    _ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]
  ) {
    let managerID = ObjectIdentifier(manager)
    Task { @MainActor in
      guard let event = self.routeEventsByManagerID[managerID],
        let builder = self.routeBuilders[event], !locations.isEmpty
      else { return }
      do { try await builder.insertRouteData(locations) } catch {
        self.routeBuilders.removeValue(forKey: event)
        self.routeStates[event] = .failed
      }
    }
  }
  nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let managerID = ObjectIdentifier(manager)
    let status = manager.authorizationStatus
    Task { @MainActor in
      guard let event = self.routeEventsByManagerID[managerID] else { return }
      if status == .authorizedWhenInUse || status == .authorizedAlways {
        if self.routeBuilders[event] == nil {
          self.routeBuilders[event] = HKWorkoutRouteBuilder(
            healthStore: self.store, device: .local())
          self.locationManagers[event]?.startUpdatingLocation()
        }
      } else if let state = WatchWorkoutRouteStatePolicy.authorization(status) {
        self.routeStates[event] = state
        self.locationManagers[event]?.stopUpdatingLocation()
        self.routeBuilders.removeValue(forKey: event)
      }
    }
  }
  private func finishRoute(eventID: UUID, workout: HKWorkout, activity: WorkoutActivity) async
    -> WorkoutRouteState
  {
    defer { cleanUpRoute(eventID: eventID) }
    guard activity.requiresRoute else { return .notRequested }
    let priorState = routeStates[eventID]
    guard let builder = routeBuilders[eventID] else {
      return WatchWorkoutRouteStatePolicy.finalized(
        priorState: priorState, hasBuilder: false, savedRoute: false)
    }
    let savedRoute = await withCheckedContinuation { continuation in
      builder.finishRoute(with: workout, metadata: nil) { route, _ in
        continuation.resume(returning: route != nil)
      }
    }
    return WatchWorkoutRouteStatePolicy.finalized(
      priorState: priorState, hasBuilder: true, savedRoute: savedRoute)
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
            Task { @MainActor in
              let route = await self.recoveredRouteState(for: workout)
              continuation.resume(
                returning: .init(
                  state: .saved, workoutUUID: workout.uuid.uuidString, routeState: route))
            }
          } else if error != nil {
            continuation.resume(returning: .init(state: .failed, errorCategory: "query-failed"))
          } else {
            continuation.resume(returning: .init(state: .notRequested))
          }
        })
    }
  }
  private func recoveredRouteState(for workout: HKWorkout) async -> WorkoutRouteState {
    let requiresRoute =
      (workout.metadata?[Self.activityMetadataKey] as? String)
      .flatMap(WorkoutActivity.init(rawValue:))?.requiresRoute
      ?? workout.workoutActivityType.requiresRoute
    return await withCheckedContinuation { continuation in
      let predicate = HKQuery.predicateForObjects(from: workout)
      store.execute(
        HKSampleQuery(
          sampleType: HKSeriesType.workoutRoute(), predicate: predicate, limit: 1,
          sortDescriptors: nil
        ) { _, samples, error in
          continuation.resume(
            returning: WatchWorkoutRouteStatePolicy.recovered(
              requiresRoute: requiresRoute, foundRoute: samples?.isEmpty == false,
              queryFailed: error != nil))
        })
    }
  }

  private func cleanUpRoute(eventID: UUID) {
    if let manager = locationManagers.removeValue(forKey: eventID) {
      manager.stopUpdatingLocation()
      routeEventsByManagerID.removeValue(forKey: ObjectIdentifier(manager))
    }
    routeBuilders.removeValue(forKey: eventID)
    routeStates.removeValue(forKey: eventID)
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

extension HKWorkoutActivityType {
  fileprivate var requiresRoute: Bool {
    self == .running || self == .cycling || self == .walking || self == .hiking
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
