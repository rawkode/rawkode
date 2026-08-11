// WorkoutCaptureRootView.swift
// Enchiridion2Watch
//
// P6 "watchOS workout capture" task (plan §Platform parity: "minimal
// watchOS SwiftUI app: start/stop workout via
// HKWorkoutSession/HKLiveWorkoutBuilder"). The watch app's entire UI for
// v1 — an activity picker plus a start/stop button, backed by
// `WorkoutSessionController` (`EnchiridionWatchKit`, HealthKit-specific)
// writing into the watch's OWN local store
// (`LocalGraphStore.openWatchLocalStore()`,
// `EnchiridionWatchKit/WatchLocalStoreLocation.swift` — see that file's
// header for why not the phone's App-Group-shared store). Deliberately
// minimal: no workout history list, no live metrics HUD — task #79's
// scope is capture, not a full workout-review UI.
//
// Not `#if canImport(HealthKit)`-guarded, unlike `WorkoutSessionController`
// itself (`EnchiridionWatchKit`): this whole `Sources/watchOS/` directory
// is a thin, Xcode-target-only source directory (mirroring
// `Sources/iOS`/`Sources/macOS`/`Sources/iOSWidget`, none of which are
// SPM package targets — see `Package.swift`) that is never compiled by a
// plain `swift build`/`swift test` invocation, only by `xcodebuild`
// building the `Enchiridion2Watch` Xcode target, where HealthKit is
// always available.

import EnchiridionSchema
import EnchiridionStore
import EnchiridionWatchKit
import SwiftUI

struct WorkoutCaptureRootView: View {
  @State private var store: LocalGraphStore?
  @State private var openStoreError: String?
  @State private var selectedActivity: WorkoutsWorkoutActivity = .run
  @State private var controller: WorkoutSessionController?

  var body: some View {
    NavigationStack {
      Group {
        if let openStoreError {
          ContentUnavailableView(
            "Couldn't open local store",
            systemImage: "exclamationmark.triangle",
            description: Text(openStoreError)
          )
        } else if let store {
          WorkoutSessionView(store: store, selectedActivity: $selectedActivity, controller: $controller)
        } else {
          ProgressView()
        }
      }
      .navigationTitle("Workout")
    }
    .task {
      openStore()
    }
  }

  private func openStore() {
    guard store == nil, openStoreError == nil else { return }
    do {
      store = try LocalGraphStore.openWatchLocalStore()
    } catch {
      openStoreError = error.localizedDescription
    }
  }
}

/// Owns the actual `WorkoutSessionController` lifecycle — created fresh
/// (with whatever `selectedActivity` currently is) each time a workout
/// starts, so the activity picker stays a real, live `Binding` up until
/// `Start` is pressed rather than a frozen `.constant()` value.
private struct WorkoutSessionView: View {
  let store: LocalGraphStore
  @Binding var selectedActivity: WorkoutsWorkoutActivity
  @Binding var controller: WorkoutSessionController?

  var body: some View {
    if let controller {
      RunningWorkoutView(controller: controller, activity: selectedActivity) {
        self.controller = nil
      }
    } else {
      VStack(spacing: 12) {
        Picker("Activity", selection: $selectedActivity) {
          ForEach(WorkoutsWorkoutActivity.allCases, id: \.self) { activity in
            Text(activity.displayName).tag(activity)
          }
        }
        Button("Start") {
          let newController = WorkoutSessionController(activity: selectedActivity, store: store)
          controller = newController
          Task {
            await newController.requestAuthorization()
            try? newController.start()
          }
        }
      }
      .padding()
    }
  }
}

private struct RunningWorkoutView: View {
  let controller: WorkoutSessionController
  let activity: WorkoutsWorkoutActivity
  /// Called once the session has fully wound down (saved or failed), so
  /// the parent can go back to showing the activity picker for the next
  /// workout.
  let onFinished: () -> Void

  var body: some View {
    VStack(spacing: 12) {
      switch controller.state {
      case .idle, .requestingAuthorization:
        ProgressView("Requesting HealthKit access…")
      case .authorizationDenied:
        Text("HealthKit access is unavailable on this device.")
        Button("Back", action: onFinished)
      case .running(let startedAt):
        Text(activity.displayName)
          .font(.headline)
        Text(startedAt, style: .timer)
          .font(.title2.monospacedDigit())
        Button("Stop", role: .destructive) {
          Task { await controller.stop() }
        }
      case .saving:
        ProgressView("Saving workout…")
      case .saved:
        Label("Workout saved", systemImage: "checkmark.circle.fill")
        Button("Done", action: onFinished)
      case .failed(let message):
        Text(message)
          .foregroundStyle(.red)
        Button("Back", action: onFinished)
      }
    }
    .padding()
  }
}
