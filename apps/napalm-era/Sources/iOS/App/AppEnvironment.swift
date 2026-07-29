import Observation
import SwiftUI

private struct NutritionAssistantKey: EnvironmentKey {
    static let defaultValue: any NutritionAssistantClient = PreviewNutritionAssistant()
}

private struct HealthKitClientKey: EnvironmentKey {
    static let defaultValue: any HealthKitClient = PreviewHealthKitClient()
}

extension EnvironmentValues {
    var nutritionAssistant: any NutritionAssistantClient {
        get { self[NutritionAssistantKey.self] }
        set { self[NutritionAssistantKey.self] = newValue }
    }

    var healthKitClient: any HealthKitClient {
        get { self[HealthKitClientKey.self] }
        set { self[HealthKitClientKey.self] = newValue }
    }
}

@MainActor
@Observable
final class AppPreferences {
    var massUnit: MassUnitPreference {
        didSet { defaults.set(massUnit.rawValue, forKey: "mass-unit") }
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        massUnit = MassUnitPreference(rawValue: defaults.string(forKey: "mass-unit") ?? "") ?? .kilograms
    }
}

