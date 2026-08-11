// Enchiridion2WatchApp.swift
// Enchiridion2Watch
//
// P6 "watchOS workout capture" task (plan §Platform parity). The watch
// app's own one-file `@main App` entry point — same shape as
// `Sources/iOS/Enchiridion2App.swift`/`Sources/macOS/Enchiridion2App.swift`
// (a thin per-platform Xcode-target-only source directory on top of a
// shared SPM library — here `EnchiridionWatchKit`, see that target's own
// Package.swift comment).

import SwiftUI

@main
struct Enchiridion2WatchApp: App {
  var body: some Scene {
    WindowGroup {
      WorkoutCaptureRootView()
    }
  }
}
