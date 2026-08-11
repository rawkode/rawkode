// Enchiridion2MacWidgetBundle.swift
// Enchiridion2MacWidget
//
// P6 "Widgets" task — macOS half. Deliberately thin: both widgets' actual
// `TimelineProvider`/`View`/`Widget` conformances live in the shared
// `EnchiridionWidgetKit` SPM library (Package.swift); this file is only
// the `@main` entry point WidgetKit requires to live in the extension
// target itself. Identical in spirit to
// `Sources/iOSWidget/Enchiridion2iOSWidgetBundle.swift` — kept as a
// separate per-platform file rather than shared, the same pattern
// `Sources/iOS/RootView.swift`/`Sources/macOS/RootView.swift` already
// established for this project's thin per-platform app-shell files.
//
// `import SwiftUI` is required here (not just `WidgetKit`) — `body: some
// Widget` below is an opaque SwiftUI-flavored return type, and without
// this import the compiler cannot resolve `Widget`/`WidgetBundle` at all
// ("cannot find type in scope"), even though `EnchiridionTodayTasksWidget`/
// `EnchiridionNextEventWidget` themselves come from `EnchiridionWidgetKit`.
// Confirmed by direct experiment — an earlier version of this file omitted
// the import and hit exactly that error.

import EnchiridionWidgetKit
import SwiftUI
import WidgetKit

@main
struct Enchiridion2MacWidgetBundle: WidgetBundle {
  var body: some Widget {
    EnchiridionTodayTasksWidget()
    EnchiridionNextEventWidget()
  }
}
