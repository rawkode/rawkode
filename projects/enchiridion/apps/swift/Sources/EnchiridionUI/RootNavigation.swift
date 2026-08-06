// RootNavigation.swift
// EnchiridionUI
//
// Task #85 (P7 integration wave — "make it actually drivable"). The
// navigation-shell VOCABULARY shared by both platforms' real `RootView`
// (`Sources/iOS/RootView.swift`/`Sources/macOS/RootView.swift`) — kept here
// (a plain, SwiftUI-view-free enum) specifically so it's reachable by
// `swift test`: the `TabView`/`NavigationSplitView` shells themselves live
// in the Xcode-app-target-only `Sources/iOS`/`Sources/macOS` directories
// (not part of any SwiftPM target — see this package's `Package.swift`),
// so THEY are exercised only by the real `xcodebuild build` this task's
// verification bar requires, never by `swift test`. Extracting the
// destinations/titles/icons into one small, plain, testable type is the
// difference between "this task's navigation-shell claim is 100% asserted
// only by a human reading Xcode" and "the destination vocabulary itself has
// a real, automated regression test" — see `RootNavigationTests.swift`.
import Foundation

/// One of the app's real navigation destinations — see the plan's §Core
/// Product UI (P7) "Scope, five tracks" for why exactly the first three
/// screens exist (day navigation+calendar is track 1+2, folded into
/// `.today`; task list/kanban is track 3, `.tasks`; assistant reachability
/// is track 4, `.assistant`). Track 5 (canvas) has no destination of its
/// own — it's reached FROM any page via `PageEditorView`'s "Insert Canvas"
/// action (`PageCanvasEmbedding.swift`), not a separate tab/sidebar row,
/// since a canvas is always embedded IN a page, never a freestanding
/// screen.
///
/// `.devices` (task #96, plan §Live Backend Connectivity (P8) scope item
/// 5) is the fourth, added later: `DeviceSettingsView.swift`'s own header
/// explains why — task #95 built real device-enrollment UI
/// (`AddDeviceView`/`EnrollDeviceView`/`DeviceCredentialExpiryBanner`) with
/// no call site anywhere in the app until now.
public enum RootTab: String, CaseIterable, Identifiable, Sendable {
  case today
  case tasks
  case assistant
  case devices

  public var id: String { rawValue }

  public var title: String {
    switch self {
    case .today: "Today"
    case .tasks: "Tasks"
    case .assistant: "Assistant"
    case .devices: "Devices"
    }
  }

  public var systemImage: String {
    switch self {
    case .today: "calendar"
    case .tasks: "checklist"
    case .assistant: "sparkles"
    case .devices: "laptopcomputer.and.iphone"
    }
  }
}
