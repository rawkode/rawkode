import SwiftData
import SwiftUI

@main
struct NapalmEraApp: App {
    private let persistence: AppPersistence
    private let assistant: any NutritionAssistantClient
    private let healthKit: any HealthKitClient
    @State private var preferences: AppPreferences
    @State private var watchSync: PhoneWatchSync

    @MainActor
    init() {
        let isTesting = ProcessInfo.processInfo.arguments.contains("-ui-testing")
        let persistence = AppPersistence.make(inMemory: isTesting)
        self.persistence = persistence
        assistant = isTesting ? PreviewNutritionAssistant() : FoundationModelsNutritionAssistant()
        healthKit = isTesting ? PreviewHealthKitClient() : LiveHealthKitClient()
        _preferences = State(initialValue: AppPreferences())
        _watchSync = State(initialValue: PhoneWatchSync(container: persistence.container))
    }

    var body: some Scene {
        WindowGroup {
            AppRootView(watchSync: watchSync)
                .environment(preferences)
                .environment(\.nutritionAssistant, assistant)
                .environment(\.healthKitClient, healthKit)
        }
        .modelContainer(persistence.container)
    }
}

