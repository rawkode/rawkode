import SwiftUI

struct WatchRootView: View {
    @Environment(WatchGymStore.self) private var gym
    @Environment(WatchWorkoutManager.self) private var workout
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if gym.active != nil {
                    GymGridView()
                } else {
                    VStack(spacing: 14) {
                        Image(systemName: "figure.strengthtraining.traditional")
                            .font(.system(size: 42))
                            .foregroundStyle(.tint)
                        Text("Gym Mode").font(.title2.weight(.semibold))
                        Text("Start an indoor strength workout and log each set with buttons.")
                            .font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
                        Button("Enter Gym Mode") { Task { await startGym() } }
                            .buttonStyle(.borderedProminent)
                    }
                    .padding()
                }
            }
            .navigationTitle("Napalm Era")
            .task {
                if gym.active != nil { await workout.recoverIfNeeded() }
            }
            .alert("Gym Mode", isPresented: .init(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: { Text(errorMessage ?? "Unknown error") }
        }
    }

    private func startGym() async {
        do {
            try await workout.start()
            gym.begin()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct GymGridView: View {
    @Environment(WatchGymStore.self) private var gym
    @Environment(WatchWorkoutManager.self) private var workout
    @State private var isFinishing = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(gym.visibleMachines) { machine in
                    NavigationLink {
                        MachineDetailView(machine: machine)
                    } label: {
                        MachineTile(machine: machine, state: gym.progress(for: machine))
                    }
                    .buttonStyle(.plain)
                }
            }
            Button(role: .destructive) {
                Task { await finishGym() }
            } label: {
                if isFinishing { ProgressView() }
                else { Label("Finish Workout", systemImage: "stop.fill") }
            }
            .buttonStyle(.bordered)
            .disabled(isFinishing)
            .padding(.top, 10)
        }
        .navigationTitle("Gym Mode")
        .alert("Couldn’t Finish", isPresented: .init(
            get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(errorMessage ?? "Unknown error") }
    }

    private func finishGym() async {
        isFinishing = true
        do {
            let workoutID = try await workout.finish()
            gym.finish(workoutUUID: workoutID)
        } catch {
            errorMessage = error.localizedDescription
        }
        isFinishing = false
    }
}

private struct MachineTile: View {
    let machine: GymMachineSnapshot
    let state: MachineProgressState

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(color)
            Text(machine.name)
                .font(.caption2.weight(.semibold))
                .multilineTextAlignment(.center)
                .lineLimit(2)
            Image(systemName: statusSymbol).font(.caption2).foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, minHeight: 72)
        .padding(5)
        .background(color.opacity(0.14), in: .rect(cornerRadius: 14))
        .overlay { RoundedRectangle(cornerRadius: 14).stroke(color.opacity(0.4)) }
    }

    private var symbol: String { machine.symbol.isEmpty ? "figure.strengthtraining.traditional" : machine.symbol }
    private var color: Color {
        switch state { case .unstarted: .secondary; case .inProgress: .orange; case .completed: .green }
    }
    private var statusSymbol: String {
        switch state { case .unstarted: "circle"; case .inProgress: "ellipsis.circle.fill"; case .completed: "checkmark.circle.fill" }
    }
}

private struct MachineDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(WatchGymStore.self) private var gym
    let machine: GymMachineSnapshot

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                Text(gym.catalog.massUnit.formatted(kilograms: gym.load(for: machine)))
                    .font(.title2.monospacedDigit().weight(.bold))

                HStack(spacing: 5) {
                    loadButton("−10", -10)
                    loadButton("−5", -5)
                    loadButton("+5", 5)
                    loadButton("+10", 10)
                }

                HStack {
                    choiceMenu(title: "Sets", value: gym.sets(for: machine), choices: [2, 3]) {
                        gym.setPlannedSets($0, for: machine)
                    }
                    choiceMenu(title: "Reps", value: gym.reps(for: machine), choices: [10, 12, 15]) {
                        gym.setPlannedReps($0, for: machine)
                    }
                }

                Text("Set \(min(gym.completedCount(for: machine.id) + 1, gym.sets(for: machine))) of \(gym.sets(for: machine))")
                    .font(.footnote).foregroundStyle(.secondary)

                Button("Complete Set", systemImage: "checkmark") {
                    if gym.completeSet(for: machine) { dismiss() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(gym.completedCount(for: machine.id) >= gym.sets(for: machine))

                Button("Undo Last Set", systemImage: "arrow.uturn.backward") {
                    gym.undoLastSet(for: machine)
                }
                .buttonStyle(.bordered)
                .disabled(gym.completedCount(for: machine.id) == 0)
            }
        }
        .navigationTitle(machine.name)
    }

    private func loadButton(_ title: String, _ delta: Double) -> some View {
        Button(title) { gym.adjustLoad(for: machine, displayedDelta: delta) }
            .buttonStyle(.bordered)
            .font(.caption2.monospacedDigit())
    }

    private func choiceMenu(title: String, value: Int, choices: [Int], set: @escaping (Int) -> Void) -> some View {
        Button {
            let index = choices.firstIndex(of: value) ?? 0
            set(choices[(index + 1) % choices.count])
        } label: {
            VStack { Text(title).font(.caption2); Text("\(value)").font(.headline.monospacedDigit()) }
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
    }
}
