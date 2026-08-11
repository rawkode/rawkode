// WorkoutSessionController.swift
// EnchiridionWatchKit
//
// P6 "watchOS workout capture" task (plan §Platform parity: "start/stop
// workout via HKWorkoutSession/HKLiveWorkoutBuilder ... on completion
// write a real workout page"). The HealthKit-specific half of workout
// capture — driving a real `HKWorkoutSession`/`HKLiveWorkoutBuilder`, then
// handing the result to `WorkoutCapture.capture` (this target's
// platform-agnostic, HealthKit-free write path) on `stop()`.
//
// #if canImport(HealthKit) && os(watchOS): HealthKit does not exist on
// macOS at all (not even as an unavailable stub), and this package's
// `swift build`/`swift test` runs on the macOS host (see Package.swift's
// header — every target in this package gets compiled for the host
// platform by a plain `swift build`/`swift test` invocation, there is no
// per-target platform restriction in SwiftPM). Without this guard, adding
// `EnchiridionWatchKit` to this package would break `swift build` on
// macOS outright. `os(watchOS)` (not just `canImport(HealthKit)`) because
// `HKWorkoutSession`'s single-device (non-mirrored) session API this file
// uses is the watchOS-native shape task #79's brief asks for
// ("HKWorkoutSession/HKLiveWorkoutBuilder ... watchOS workout capture");
// iOS's own newer mirrored-session APIs are a different setup this task
// does not build.
//
// WHAT'S VERIFIED, WHAT ISN'T (task #79's own honesty bar — see
// EnchiridionGadgetsTests' Package.swift comment for the same class of
// gap): this file's actual `HKWorkoutSession`/`HKLiveWorkoutBuilder` call
// sequence (start/beginCollection/stopActivity/endCollection/statistics)
// matches Apple's documented API contract and compiles under the watchOS
// SDK (see this task's own report for the exact `xcodebuild` verification
// performed), but is NOT exercised by any automated test in this
// package — there is no watchOS simulator/device in this sandbox, no
// HealthKit authorization to grant a test process, and
// `HKWorkoutSession`/`HKLiveWorkoutBuilder` have no meaningful fake/mock
// surface to drive outside a real HealthKit runtime. What IS tested
// (`EnchiridionWatchKitTests/WorkoutCaptureTests.swift`) is everything
// downstream of a completed `WorkoutRecord` — the actual CRDT-backed
// persistence this file hands off to on `stop()`.

#if canImport(HealthKit) && os(watchOS)

  import EnchiridionCore
  import EnchiridionSchema
  import EnchiridionStore
  import Foundation
  import HealthKit
  import Observation

  /// Drives one workout session end to end: authorization ->
  /// start -> (live, on the watch's wrist) -> stop -> persisted page.
  /// `@MainActor`/`@Observable` so a SwiftUI view
  /// (`Sources/watchOS/WorkoutCaptureRootView.swift`) can bind directly to
  /// `state` — same shape as `EnchiridionUI/PageEditorController.swift`
  /// (task #78), which this file's persistence call ultimately shares its
  /// write path with (`WorkoutCapture.capture`, not a separate shortcut —
  /// see that file's header).
  @MainActor
  @Observable
  public final class WorkoutSessionController: NSObject {
    public enum State: Equatable, Sendable {
      case idle
      case requestingAuthorization
      case authorizationDenied
      case running(startedAt: Date)
      case saving
      case saved(pageID: PageID)
      case failed(String)
    }

    public private(set) var state: State = .idle

    private let healthStore: HKHealthStore
    private let store: LocalGraphStore
    private let activity: WorkoutsWorkoutActivity
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var startedAt: Date?

    public init(activity: WorkoutsWorkoutActivity, store: LocalGraphStore, healthStore: HKHealthStore = HKHealthStore()) {
      self.activity = activity
      self.store = store
      self.healthStore = healthStore
      super.init()
    }

    /// Requests write access to log a workout and read access to the two
    /// quantity types `stop()` reads back (`activeEnergyBurned`,
    /// `heartRate`) — the minimum set task #79's "calories if easy"
    /// scope needs, not a broad HealthKit read grant.
    public func requestAuthorization() async {
      guard HKHealthStore.isHealthDataAvailable() else {
        state = .authorizationDenied
        return
      }
      state = .requestingAuthorization
      let typesToShare: Set<HKSampleType> = [HKObjectType.workoutType()]
      var typesToRead: Set<HKObjectType> = [HKObjectType.workoutType()]
      if let activeEnergy = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) {
        typesToRead.insert(activeEnergy)
      }
      if let heartRate = HKObjectType.quantityType(forIdentifier: .heartRate) {
        typesToRead.insert(heartRate)
      }
      do {
        try await healthStore.requestAuthorization(toShare: typesToShare, read: typesToRead)
        state = .idle
      } catch {
        state = .failed(error.localizedDescription)
      }
    }

    /// Starts a real `HKWorkoutSession` + its `HKLiveWorkoutBuilder`, both
    /// configured for `activity`. Must be preceded by a successful
    /// `requestAuthorization()` — HealthKit itself enforces this (the
    /// session init/`startActivity` calls throw/no-op without it), this
    /// method doesn't duplicate that check.
    public func start() throws {
      let configuration = HKWorkoutConfiguration()
      configuration.activityType = activity.healthKitActivityType
      configuration.locationType = .unknown

      let session = try HKWorkoutSession(healthStore: healthStore, configuration: configuration)
      let builder = session.associatedWorkoutBuilder()
      builder.dataSource = HKLiveWorkoutDataSource(
        healthStore: healthStore, workoutConfiguration: configuration)
      session.delegate = self
      builder.delegate = self

      self.session = session
      self.builder = builder

      let now = Date()
      startedAt = now
      state = .running(startedAt: now)
      session.startActivity(with: now)
      builder.beginCollection(withStart: now) { _, _ in }
    }

    /// Ends the live session, reads back accumulated calories, builds a
    /// `WorkoutRecord`, and persists it via `WorkoutCapture.capture` into
    /// `store` — the real CRDT-backed write path (`WorkoutCapture.swift`'s
    /// header), not a bespoke shortcut. Safe to call even if `start()`
    /// was never called (no-ops).
    public func stop() async {
      guard let session, let builder, let startedAt else { return }
      let endDate = Date()
      session.stopActivity(with: endDate)
      session.end()
      state = .saving

      do {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
          builder.endCollection(withEnd: endDate) { _, error in
            if let error {
              continuation.resume(throwing: error)
            } else {
              continuation.resume()
            }
          }
        }

        let calories = builder.statistics(for: HKQuantityType(.activeEnergyBurned))?
          .sumQuantity()?
          .doubleValue(for: .kilocalorie())

        let record = WorkoutRecord(
          activity: activity,
          startedAt: startedAt,
          durationMinutes: endDate.timeIntervalSince(startedAt) / 60,
          calories: calories
        )
        let pageID = try await WorkoutCapture.capture(record, into: store)
        state = .saved(pageID: pageID)
      } catch {
        state = .failed(error.localizedDescription)
      }

      self.session = nil
      self.builder = nil
      self.startedAt = nil
    }
  }

  extension WorkoutSessionController: HKWorkoutSessionDelegate {
    public nonisolated func workoutSession(
      _ workoutSession: HKWorkoutSession,
      didChangeTo toState: HKWorkoutSessionState,
      from fromState: HKWorkoutSessionState,
      date: Date
    ) {
      // Intentionally minimal for v1 — a follow-up could surface
      // pause/resume UI off `toState`; task #79's scope is start/stop only.
    }

    public nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
      Task { @MainActor [weak self] in
        self?.state = .failed(error.localizedDescription)
      }
    }
  }

  extension WorkoutSessionController: HKLiveWorkoutBuilderDelegate {
    public nonisolated func workoutBuilder(
      _ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>
    ) {
      // Live statistics are re-read on `stop()` (`builder.statistics(for:)`)
      // rather than accumulated incrementally here — v1 doesn't surface a
      // live calorie/heart-rate readout during the workout (task #79's
      // scope: "start/stop workout ... on completion write a real workout
      // page", not a live metrics HUD).
    }

    public nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}
  }

  extension WorkoutsWorkoutActivity {
    /// v1's `HKWorkoutActivityType` mapping — see
    /// `supertags/workouts/src/index.ts`'s header for why only these six
    /// `activity` options exist yet; anything HealthKit itself might
    /// report outside this set has no path back into this enum (this app
    /// only ever constructs sessions with one of these six, so the
    /// question doesn't arise for capture, only for a hypothetical future
    /// HealthKit-import path — out of this task's scope).
    var healthKitActivityType: HKWorkoutActivityType {
      switch self {
      case .run: .running
      case .walk: .walking
      case .cycle: .cycling
      case .swim: .swimming
      case .strength: .traditionalStrengthTraining
      case .other: .other
      }
    }
  }

#endif
