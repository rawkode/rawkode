import Foundation
import Observation

struct ActiveGymState: Codable, Sendable {
    var id: UUID
    var startedAt: Date
    var completedSets: [CompletedSetPayload]
    var loads: [UUID: Double]
    var plannedSets: [UUID: Int]
    var plannedReps: [UUID: Int]
}

enum MachineProgressState {
    case unstarted, inProgress, completed
}

@MainActor
@Observable
final class WatchGymStore {
    private(set) var catalog: MachineCatalogPayload
    private(set) var active: ActiveGymState?
    private(set) var lastTransferError: String?
    private let defaults: UserDefaults
    private let sync: WatchSync

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let storedCatalog = Self.load(MachineCatalogPayload.self, key: "machine-catalog", defaults: defaults)
        catalog = storedCatalog ?? Self.fallbackCatalog
        active = Self.load(ActiveGymState.self, key: "active-gym", defaults: defaults)
        sync = WatchSync()
        if storedCatalog == nil, let data = try? JSONEncoder().encode(catalog) {
            defaults.set(data, forKey: "machine-catalog")
        }
        sync.onCatalog = { [weak self] catalog in self?.receive(catalog) }
        sync.onTransferError = { [weak self] message in self?.lastTransferError = message }
        sync.activate()
    }

    var visibleMachines: [GymMachineSnapshot] {
        catalog.machines.filter(\.isVisible).sorted { $0.order < $1.order }
    }

    func begin() {
        active = ActiveGymState(
            id: UUID(),
            startedAt: .now,
            completedSets: [],
            loads: Dictionary(uniqueKeysWithValues: catalog.machines.map { ($0.id, $0.defaultLoadKilograms) }),
            plannedSets: Dictionary(uniqueKeysWithValues: catalog.machines.map { ($0.id, $0.defaultSets) }),
            plannedReps: Dictionary(uniqueKeysWithValues: catalog.machines.map { ($0.id, $0.defaultReps) })
        )
        persistActive()
    }

    func progress(for machine: GymMachineSnapshot) -> MachineProgressState {
        let count = completedCount(for: machine.id)
        if count == 0 { return .unstarted }
        return count >= sets(for: machine) ? .completed : .inProgress
    }

    func completedCount(for machineID: UUID) -> Int {
        active?.completedSets.filter { $0.machineID == machineID }.count ?? 0
    }

    func load(for machine: GymMachineSnapshot) -> Double {
        active?.loads[machine.id] ?? machine.defaultLoadKilograms
    }

    func displayedLoad(for machine: GymMachineSnapshot) -> Double {
        catalog.massUnit.displayValue(kilograms: load(for: machine))
    }

    func adjustLoad(for machine: GymMachineSnapshot, displayedDelta: Double) {
        guard var active else { return }
        let next = max(0, displayedLoad(for: machine) + displayedDelta)
        active.loads[machine.id] = catalog.massUnit.kilograms(displayValue: next)
        self.active = active
        persistActive()
    }

    func sets(for machine: GymMachineSnapshot) -> Int {
        active?.plannedSets[machine.id] ?? machine.defaultSets
    }

    func setPlannedSets(_ value: Int, for machine: GymMachineSnapshot) {
        guard [2, 3].contains(value), var active else { return }
        active.plannedSets[machine.id] = value
        self.active = active
        persistActive()
    }

    func reps(for machine: GymMachineSnapshot) -> Int {
        active?.plannedReps[machine.id] ?? machine.defaultReps
    }

    func setPlannedReps(_ value: Int, for machine: GymMachineSnapshot) {
        guard [10, 12, 15].contains(value), var active else { return }
        active.plannedReps[machine.id] = value
        self.active = active
        persistActive()
    }

    @discardableResult
    func completeSet(for machine: GymMachineSnapshot) -> Bool {
        guard var active else { return false }
        let set = CompletedSetPayload(
            id: UUID(),
            machineID: machine.id,
            machineName: machine.name,
            order: active.completedSets.count,
            loadKilograms: load(for: machine),
            repetitions: reps(for: machine),
            completedAt: .now
        )
        active.completedSets.append(set)
        self.active = active
        persistActive()
        return completedCount(for: machine.id) >= sets(for: machine)
    }

    func undoLastSet(for machine: GymMachineSnapshot) {
        guard var active,
              let index = active.completedSets.lastIndex(where: { $0.machineID == machine.id }) else { return }
        active.completedSets.remove(at: index)
        self.active = active
        persistActive()
    }

    func finish(workoutUUID: UUID?) {
        guard let active else { return }
        let payload = GymSessionPayload(
            id: active.id,
            startedAt: active.startedAt,
            endedAt: .now,
            healthKitWorkoutUUID: workoutUUID,
            sets: active.completedSets
        )

        let finalLoads = Dictionary(grouping: active.completedSets, by: \.machineID)
            .compactMapValues { $0.max(by: { $0.completedAt < $1.completedAt })?.loadKilograms }
        for index in catalog.machines.indices {
            if let load = finalLoads[catalog.machines[index].id] {
                catalog.machines[index].defaultLoadKilograms = load
            }
        }
        persistCatalog()
        sync.transfer(payload)
        self.active = nil
        defaults.removeObject(forKey: "active-gym")
    }

    private func receive(_ catalog: MachineCatalogPayload) {
        guard catalog.version == MachineCatalogPayload.version else { return }
        self.catalog = catalog
        persistCatalog()
    }

    private func persistActive() {
        guard let active, let data = try? JSONEncoder().encode(active) else { return }
        defaults.set(data, forKey: "active-gym")
    }

    private func persistCatalog() {
        guard let data = try? JSONEncoder().encode(catalog) else { return }
        defaults.set(data, forKey: "machine-catalog")
    }

    private static func load<Value: Decodable>(_ type: Value.Type, key: String, defaults: UserDefaults) -> Value? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private static let fallbackCatalog = MachineCatalogPayload(
        massUnit: .kilograms,
        machines: [
            ("Chest press", 3, 10), ("Shoulder press", 3, 10), ("Lat pulldown", 3, 10),
            ("Seated row", 3, 10), ("Leg press", 3, 10), ("Leg extension", 2, 12),
            ("Leg curl", 2, 12), ("Pec fly", 2, 12), ("Reverse fly", 2, 12),
            ("Biceps curl", 2, 12), ("Triceps extension", 2, 12), ("Hip abductor", 2, 15),
            ("Hip adductor", 2, 15), ("Back extension", 2, 15), ("Calf raise", 3, 15),
            ("Abdominal crunch", 3, 15),
        ].enumerated().map { index, seed in
            GymMachineSnapshot(
                id: UUID(), name: seed.0, symbol: "figure.strengthtraining.traditional", order: index,
                defaultLoadKilograms: 0, defaultSets: seed.1, defaultReps: seed.2, isVisible: true
            )
        }
    )
}
