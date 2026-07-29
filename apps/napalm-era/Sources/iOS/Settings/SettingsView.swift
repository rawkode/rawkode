import SwiftData
import SwiftUI

struct SettingsView: View {
    @Environment(\.healthKitClient) private var healthKit
    @Environment(\.nutritionAssistant) private var assistant
    @Environment(AppPreferences.self) private var preferences
    let watchSync: PhoneWatchSync
    @State private var healthMessage: String?
    @State private var modelAvailability: NutritionAssistantAvailability = .available("Checking Apple Intelligence…")

    var body: some View {
        @Bindable var preferences = preferences
        List {
            Section("Apple Intelligence") {
                LabeledContent("Nutrition capture") {
                    switch modelAvailability {
                    case .available: Label("Available", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    case .unavailable: Label("Unavailable", systemImage: "exclamationmark.circle.fill").foregroundStyle(.orange)
                    }
                }
                switch modelAvailability {
                case .available(let status), .unavailable(let status):
                    Text(status).font(.footnote).foregroundStyle(.secondary)
                }
                Text("Napalm Era prefers Private Cloud Compute and automatically falls back to the on-device system model. There is no manual nutrition fallback.")
                    .font(.footnote).foregroundStyle(.secondary)
            }

            Section("Apple Health") {
                Button("Review Health Permissions", systemImage: "heart.fill") {
                    Task { await requestHealthAuthorization() }
                }
                if let healthMessage { Text(healthMessage).font(.footnote).foregroundStyle(.secondary) }
            }

            Section("Units") {
                Picker("Gym weight", selection: $preferences.massUnit) {
                    ForEach(MassUnitPreference.allCases) { Text($0.title).tag($0) }
                }
                .onChange(of: preferences.massUnit) { _, unit in watchSync.sendCatalog(massUnit: unit) }
            }

            Section("Personalise") {
                NavigationLink { NutritionTargetsView() } label: {
                    Label("Nutrition Targets", systemImage: "scope")
                }
                NavigationLink { MachineSettingsView(watchSync: watchSync) } label: {
                    Label("Gym Machines", systemImage: "dumbbell.fill")
                }
            }

            Section("Privacy") {
                Text("Confirmed structured meals are stored locally. Meal photos, voice recordings, raw transcripts, and full assistant conversations are not retained.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
        .task { modelAvailability = assistant.availability }
    }

    private func requestHealthAuthorization() async {
        do {
            try await healthKit.requestAuthorization()
            healthMessage = "Permission request completed. You can change individual choices in the Health app."
        } catch {
            healthMessage = error.localizedDescription
        }
    }
}

private struct NutritionTargetsView: View {
    @Query(sort: \NutritionTarget.metricRaw) private var targets: [NutritionTarget]

    var body: some View {
        List(targets) { target in TargetRow(target: target) }
            .navigationTitle("Nutrition Targets")
            .navigationBarTitleDisplayMode(.inline)
    }
}

private struct TargetRow: View {
    @Bindable var target: NutritionTarget

    var body: some View {
        if let metric = target.metric {
            Stepper(value: $target.amount, in: 0...metric.plausibleMaximum, step: step(for: metric)) {
                LabeledContent(metric.title) {
                    Text("\(target.amount.formatted(.number.precision(.fractionLength(target.amount < 10 ? 1 : 0)))) \(metric.unitSymbol)")
                        .monospacedDigit()
                }
            }
        }
    }

    private func step(for metric: NutritionMetric) -> Double {
        switch metric.unitSymbol {
        case "kcal": 50
        case "g": 1
        case "µg": metric == .vitaminD ? 1 : 5
        default: metric == .sodium || metric == .potassium ? 50 : 1
        }
    }
}

private struct MachineSettingsView: View {
    @Environment(AppPreferences.self) private var preferences
    @Query(sort: \MachineProfile.order) private var machines: [MachineProfile]
    let watchSync: PhoneWatchSync

    var body: some View {
        List(machines) { machine in
            NavigationLink(machine.name) {
                MachineSettingsDetail(machine: machine) {
                    watchSync.sendCatalog(massUnit: preferences.massUnit)
                }
            }
        }
        .navigationTitle("Gym Machines")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct MachineSettingsDetail: View {
    @Environment(AppPreferences.self) private var preferences
    @Bindable var machine: MachineProfile
    let didChange: () -> Void

    var body: some View {
        List {
            Section("Watch Grid") {
                Toggle("Show machine", isOn: $machine.isVisible)
            }
            Section("Default Load") {
                HStack {
                    Button("−5") { adjustLoad(-5) }
                    Spacer()
                    Text(preferences.massUnit.formatted(kilograms: machine.defaultLoadKilograms))
                        .font(.title3.monospacedDigit().weight(.semibold))
                    Spacer()
                    Button("+5") { adjustLoad(5) }
                }
            }
            Section("Plan") {
                Picker("Sets", selection: $machine.defaultSets) {
                    Text("2").tag(2); Text("3").tag(3)
                }
                Picker("Reps", selection: $machine.defaultReps) {
                    Text("10").tag(10); Text("12").tag(12); Text("15").tag(15)
                }
            }
        }
        .navigationTitle(machine.name)
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: machine.isVisible) { _, _ in didChange() }
        .onChange(of: machine.defaultSets) { _, _ in didChange() }
        .onChange(of: machine.defaultReps) { _, _ in didChange() }
    }

    private func adjustLoad(_ displayedDelta: Double) {
        let shown = preferences.massUnit.displayValue(kilograms: machine.defaultLoadKilograms)
        machine.defaultLoadKilograms = preferences.massUnit.kilograms(from: max(0, shown + displayedDelta))
        didChange()
    }
}
