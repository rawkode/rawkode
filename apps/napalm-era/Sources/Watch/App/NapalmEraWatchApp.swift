import SwiftUI

@main
struct NapalmEraWatchApp: App {
    @State private var gym = WatchGymStore()
    @State private var workout = WatchWorkoutManager()

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environment(gym)
                .environment(workout)
        }
    }
}

