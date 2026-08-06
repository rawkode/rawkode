// Enchiridion2App.swift
// Enchiridion2iOS
//
// P1 "iOS app" task — plan §Phasing P1: "full editor (Text + marks + page
// references), ... iOS app." This is the minimal app shell the plan calls
// for at this stage: no navigation/list UI yet (that lands once
// EnchiridionStore's local query layer exists — a concurrent sibling task),
// just enough to create-or-open a single page and host the real
// `PageEditorView` (EnchiridionUI) on it. Everything editor-shaped already
// lives in EnchiridionUI/EnchiridionSync; this file is deliberately thin.

import SwiftUI

@main
struct Enchiridion2App: App {
  var body: some Scene {
    WindowGroup {
      RootView()
    }
  }
}
