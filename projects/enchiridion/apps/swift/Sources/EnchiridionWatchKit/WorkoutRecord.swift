// WorkoutRecord.swift
// EnchiridionWatchKit
//
// P6 "watchOS workout capture" task (plan §Platform parity). A completed
// workout's data, independent of HealthKit — this is what
// `WorkoutSessionController` (HealthKit-specific, watchOS-only) produces
// on `stop()` and what `WorkoutCapture` (platform-agnostic, see that
// file) actually persists. Kept as its own plain, `Sendable`,
// HealthKit-free type specifically so `WorkoutCapture`'s write path is
// testable from a plain `swift test` process without any HealthKit
// runtime — see `WorkoutCapture.swift`'s header.

import EnchiridionSchema
import Foundation

/// A completed workout, ready to be written as a `dev.rawkode.enchiridion.workouts.workout`
/// page (`supertags/workouts`, task #79's own module — see
/// `EnchiridionSchema/Generated/WorkoutsSupertags.swift`).
public struct WorkoutRecord: Hashable, Sendable {
  public var activity: WorkoutsWorkoutActivity
  public var startedAt: Date
  /// Matches the `duration-minutes` field exactly (see
  /// `supertags/workouts/src/index.ts`'s header for why minutes, not
  /// seconds) — a caller computing this from a `TimeInterval` (HealthKit
  /// reports seconds) divides by 60 itself; this type doesn't do unit
  /// conversion.
  public var durationMinutes: Double
  /// Active energy in kilocalories, matching HealthKit's
  /// `HKQuantityTypeIdentifier.activeEnergyBurned` unit. `nil` when no
  /// estimate is available — `WorkoutCapture.capture` omits the
  /// `calories` field entirely in that case rather than writing `0`
  /// (a real zero-calorie workout is indistinguishable from "unknown"
  /// otherwise).
  public var calories: Double?

  public init(
    activity: WorkoutsWorkoutActivity,
    startedAt: Date,
    durationMinutes: Double,
    calories: Double? = nil
  ) {
    self.activity = activity
    self.startedAt = startedAt
    self.durationMinutes = durationMinutes
    self.calories = calories
  }
}

extension WorkoutsWorkoutActivity {
  /// Matches `supertags/workouts/src/index.ts`'s `f.select()` option
  /// `name`s exactly (Title Case) — used to build a completed workout
  /// page's title (`WorkoutCapture.title(for:)`).
  public var displayName: String {
    switch self {
    case .run: "Run"
    case .walk: "Walk"
    case .cycle: "Cycle"
    case .swim: "Swim"
    case .strength: "Strength"
    case .other: "Other"
    }
  }
}
