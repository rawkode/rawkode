import SwiftUI
import AthenaeumWatchUI

/// The watchOS app shell's entire job: host `AthenaeumWatchUI.QuickCaptureRootView`. See
/// `native/iOS/Sources/AthenaeumiOSApp.swift`'s doc comment — identical rationale, watch side.
@main
struct AthenaeumWatchApp: App {
    var body: some Scene {
        WindowGroup {
            QuickCaptureRootView()
        }
    }
}
