import SwiftUI
import AthenaeumAppUI

/// The iOS app shell's entire job: host `AthenaeumAppUI.AthenaeumRootView`. See
/// `native/macOS/Sources/AthenaeumMacApp.swift`'s doc comment — identical rationale, iOS side.
@main
struct AthenaeumiOSApp: App {
    var body: some Scene {
        WindowGroup {
            AthenaeumRootView()
        }
    }
}
