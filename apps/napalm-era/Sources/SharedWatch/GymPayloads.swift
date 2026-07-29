import Foundation

enum MassUnitPreference: String, Codable, CaseIterable, Identifiable, Sendable {
    case kilograms
    case pounds

    var id: String { rawValue }
    var title: String { self == .kilograms ? "Kilograms" : "Pounds" }
    var symbol: String { self == .kilograms ? "kg" : "lb" }

    func displayValue(kilograms: Double) -> Double {
        self == .kilograms ? kilograms : kilograms * 2.204_622_621_8
    }

    func kilograms(displayValue: Double) -> Double {
        self == .kilograms ? displayValue : displayValue / 2.204_622_621_8
    }

    func kilograms(from displayValue: Double) -> Double {
        kilograms(displayValue: displayValue)
    }

    func formatted(kilograms: Double) -> String {
        "\(displayValue(kilograms: kilograms).formatted(.number.precision(.fractionLength(0...1)))) \(symbol)"
    }
}

struct GymMachineSnapshot: Identifiable, Codable, Hashable, Sendable {
    var id: UUID
    var name: String
    var symbol: String
    var order: Int
    var defaultLoadKilograms: Double
    var defaultSets: Int
    var defaultReps: Int
    var isVisible: Bool
}

struct MachineCatalogPayload: Codable, Sendable {
    static let version = 1
    var version: Int = Self.version
    var massUnit: MassUnitPreference
    var machines: [GymMachineSnapshot]
}

struct CompletedSetPayload: Identifiable, Codable, Hashable, Sendable {
    var id: UUID
    var machineID: UUID
    var machineName: String
    var order: Int
    var loadKilograms: Double
    var repetitions: Int
    var completedAt: Date
}

struct GymSessionPayload: Identifiable, Codable, Hashable, Sendable {
    var id: UUID
    var startedAt: Date
    var endedAt: Date
    var healthKitWorkoutUUID: UUID?
    var sets: [CompletedSetPayload]
}

enum WatchTransferKey {
    static let catalog = "machine-catalog"
    static let gymSession = "gym-session"
}
