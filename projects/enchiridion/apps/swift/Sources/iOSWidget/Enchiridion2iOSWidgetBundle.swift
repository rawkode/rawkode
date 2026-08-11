// Enchiridion2iOSWidgetBundle.swift
// Enchiridion2iOSWidget
//
// P6 "Widgets" task — iOS half. See
// `Sources/macOSWidget/Enchiridion2MacWidgetBundle.swift`'s header for the
// full rationale (identical file, other than the `@main` type's own name)
// — including why `import SwiftUI` is required here alongside
// `WidgetKit`.

import EnchiridionWidgetKit
import SwiftUI
import WidgetKit

@main
struct Enchiridion2iOSWidgetBundle: WidgetBundle {
  var body: some Widget {
    EnchiridionTodayTasksWidget()
    EnchiridionNextEventWidget()
  }
}
