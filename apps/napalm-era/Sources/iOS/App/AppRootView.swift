import SwiftData
import SwiftUI

struct AppRootView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(AppPreferences.self) private var preferences
    let watchSync: PhoneWatchSync

    var body: some View {
        TabView {
            Tab("Today", systemImage: "sun.max.fill") {
                NavigationStack { TodayView() }
            }
            Tab("Settings", systemImage: "gearshape.fill") {
                NavigationStack { SettingsView(watchSync: watchSync) }
            }
        }
        .task {
            do {
                try SeedData.installIfNeeded(in: modelContext)
                watchSync.sendCatalog(massUnit: preferences.massUnit)
            } catch {
                assertionFailure("Seed data failed: \(error.localizedDescription)")
            }
        }
    }
}

