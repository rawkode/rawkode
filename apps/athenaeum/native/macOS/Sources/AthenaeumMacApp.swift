import SwiftUI
import AthenaeumAppUI

/// The macOS app shell's entire job: host `AthenaeumAppUI.AthenaeumRootView` in a window. All
/// real logic (daily note editor, backlinks, graph view, view-model construction/error handling)
/// lives in the shared `AthenaeumAppUI` library — see `AthenaeumApp/Package.swift`'s top doc
/// comment for why the split is shaped this way.
@main
struct AthenaeumMacApp: App {
    var body: some Scene {
        WindowGroup {
            AthenaeumRootView()
                .frame(minWidth: 920, minHeight: 640)
        }
        .defaultSize(width: 1180, height: 780)
        .windowToolbarStyle(.unified)
    }
}
