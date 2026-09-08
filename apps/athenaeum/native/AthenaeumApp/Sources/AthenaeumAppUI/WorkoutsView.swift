import Foundation
import SwiftUI
import AthenaeumDomain
import AthenaeumRPC

/// Native read-only workout review. HealthKit import remains owned by the native core pipeline;
/// this screen gives the imported typed graph a calm list/detail surface on macOS and iOS.
@MainActor
final class WorkoutsViewModel: ObservableObject {
    @Published private(set) var workouts: [RPCWorkoutSummary] = []
    @Published private(set) var hasLoadedWorkouts = false
    @Published private(set) var selectedDetail: RPCWorkoutDetail?
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingDetail = false
    @Published var errorMessage: String?
    @Published var detailErrorMessage: String?

    private let client: WorkspaceRPCClient

    init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.client = WorkspaceRPCClient(
            baseURL: workspaceURL,
            workspaceId: workspaceId.rawValue,
            bearerCredential: bearerCredential
        )
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            workouts = try await client.listWorkouts().sorted { $0.startedAt > $1.startedAt }
            hasLoadedWorkouts = true
            errorMessage = nil
        } catch {
            errorMessage = Self.workoutsLoadFailureMessage(for: error)
        }
    }

    func select(_ nodeId: String) async {
        isLoadingDetail = true
        detailErrorMessage = nil
        defer { isLoadingDetail = false }
        do {
            selectedDetail = try await client.getWorkout(nodeId: nodeId)
        } catch {
            selectedDetail = nil
            detailErrorMessage = Self.workoutDetailLoadFailureMessage(for: error)
        }
    }

    /// Read failures can contain backend or credential-adjacent details. The existing refresh and
    /// selection controls are the safe ways to recover without exposing those details.
    static func workoutsLoadFailureMessage(for _: Error) -> String {
        "Workouts couldn’t be loaded. Nothing has been changed. Refresh to check your workouts again."
    }

    static func workoutDetailLoadFailureMessage(for _: Error) -> String {
        "This workout couldn’t be loaded. Nothing has been changed. Select it again or refresh your workouts."
    }

    /// The import surface is empty only after an idle, successful list read. Before that, or
    /// after a failed refresh, we do not know whether a HealthKit import exists.
    static func shouldShowEmptyWorkouts(
        isEmpty: Bool,
        hasLoadedWorkouts: Bool,
        isLoading: Bool,
        errorMessage: String?
    ) -> Bool {
        isEmpty && hasLoadedWorkouts && !isLoading && errorMessage == nil
    }

    /// The first render is unresolved until the existing list read succeeds or fails. A later
    /// refresh keeps the cached rows and selected immutable detail visible.
    static func shouldShowWorkoutsLoading(
        hasLoadedWorkouts: Bool,
        isLoading: Bool,
        errorMessage: String?
    ) -> Bool {
        !hasLoadedWorkouts && (isLoading || errorMessage == nil)
    }

    static func formatDuration(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let remaining = total % 60
        if hours > 0 { return "\(hours)h \(minutes)m" }
        if minutes > 0 { return "\(minutes)m \(remaining)s" }
        return "\(remaining)s"
    }

    static func formatPace(_ secondsPerKilometre: Double?) -> String? {
        guard let secondsPerKilometre, secondsPerKilometre.isFinite, secondsPerKilometre >= 0 else {
            return nil
        }
        let total = max(0, Int(secondsPerKilometre.rounded()))
        return String(format: "%d:%02d/km", total / 60, total % 60)
    }

    static func formatDate(_ value: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: value) ?? {
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: value)
        }()
        guard let date else { return value }
        return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
    }
}

/// Workout detail reads are immutable, but repeated row taps can otherwise allow a slower first
/// result to replace the later highlighted workout. Keep both retry eligibility and this
/// single-flight interaction state in `WorkoutsView`, rather than changing the HealthKit/RPC model.
enum WorkoutDetailSelectionPresentation {
    static func canRetryDetail(workoutId: String?, isLoadingDetail: Bool) -> Bool {
        workoutId != nil && !isLoadingDetail
    }

    static func canStartSelection(pendingWorkoutId: String?) -> Bool {
        pendingWorkoutId == nil
    }

    static func pendingWorkoutId(afterCompleting workoutId: String, pendingWorkoutId: String?) -> String? {
        pendingWorkoutId == workoutId ? nil : pendingWorkoutId
    }
}

/// The workout list read remains model-owned; this claim only rejects rapid UI activations before
/// the model's asynchronous loading publication can update the view.
enum WorkoutsListRefreshPresentation {
    static func canStartRefresh(isRefreshInFlight: Bool) -> Bool {
        !isRefreshInFlight
    }

    static func isLoading(isModelLoading: Bool, isRefreshInFlight: Bool) -> Bool {
        isModelLoading || isRefreshInFlight
    }
}

public struct WorkoutsView: View {
    @StateObject private var model: WorkoutsViewModel
    @State private var selectedWorkoutId: String?
    @State private var pendingDetailSelectionWorkoutId: String?
    @State private var isListRefreshInFlight = false

    public init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        _model = StateObject(
            wrappedValue: WorkoutsViewModel(
                backendURL: backendURL,
                workspaceId: workspaceId,
                bearerCredential: bearerCredential
            )
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Typed health context")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Workouts")
                        .font(.title2.bold())
                }
                Spacer()
                Button {
                    startListRefresh()
                } label: {
                    Label(isLoadingWorkouts ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(isLoadingWorkouts)
            }

            Text("Review workouts imported from HealthKit as structured entities in your second brain.")
                .font(.callout)
                .foregroundStyle(.secondary)

            if let error = model.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            if WorkoutsViewModel.shouldShowWorkoutsLoading(
                hasLoadedWorkouts: model.hasLoadedWorkouts,
                isLoading: isLoadingWorkouts,
                errorMessage: model.errorMessage
            ) {
                ProgressView("Loading workouts…")
                    .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
            } else if WorkoutsViewModel.shouldShowEmptyWorkouts(
                isEmpty: model.workouts.isEmpty,
                hasLoadedWorkouts: model.hasLoadedWorkouts,
                isLoading: isLoadingWorkouts,
                errorMessage: model.errorMessage
            ) {
                WorkoutsEmptyState()
            } else {
                HStack(alignment: .top, spacing: 20) {
                    workoutList
                        .frame(minWidth: 280, maxWidth: 360, alignment: .leading)
                    Divider()
                    workoutDetail
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                }
            }
        }
        .padding()
        .task { await refreshWorkoutsOnAppear() }
    }

    private var isLoadingWorkouts: Bool {
        WorkoutsListRefreshPresentation.isLoading(
            isModelLoading: model.isLoading,
            isRefreshInFlight: isListRefreshInFlight
        )
    }

    private func startListRefresh() {
        guard beginListRefresh() else { return }
        Task { @MainActor in
            await completeListRefresh()
        }
    }

    private func refreshWorkoutsOnAppear() async {
        guard beginListRefresh() else { return }
        await completeListRefresh()
    }

    private func beginListRefresh() -> Bool {
        guard WorkoutsListRefreshPresentation.canStartRefresh(
            isRefreshInFlight: isListRefreshInFlight
        ) else {
            return false
        }
        isListRefreshInFlight = true
        return true
    }

    private func completeListRefresh() async {
        defer { isListRefreshInFlight = false }
        await model.refresh()
    }

    private var workoutList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Recent workouts")
                .font(.headline)
            ForEach(model.workouts, id: \.nodeId) { workout in
                let isLoadingThisWorkout = pendingDetailSelectionWorkoutId == workout.nodeId
                Button {
                    selectWorkoutDetail(workout.nodeId)
                } label: {
                    HStack(alignment: .top, spacing: 9) {
                        Image(systemName: workout.kind == "cardio" ? "figure.run" : "figure.strengthtraining.traditional")
                            .foregroundStyle(.secondary)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(workout.activity)
                                .font(.body.weight(.semibold))
                                .lineLimit(1)
                            Text(WorkoutsViewModel.formatDate(workout.startedAt))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(WorkoutsViewModel.formatDuration(workout.durationSeconds) + " · " + workout.source)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                            if isLoadingThisWorkout {
                                Text("Loading…")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(.vertical, 7)
                    .padding(.horizontal, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!WorkoutDetailSelectionPresentation.canStartSelection(pendingWorkoutId: pendingDetailSelectionWorkoutId))
                .background(
                    selectedWorkoutId == workout.nodeId ? Color.accentColor.opacity(0.12) : .clear,
                    in: RoundedRectangle(cornerRadius: 7)
                )
            }
        }
    }

    @ViewBuilder
    private var workoutDetail: some View {
        if model.isLoadingDetail {
            ProgressView("Loading workout…")
                .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
        } else if let error = model.detailErrorMessage {
            VStack(alignment: .leading, spacing: 8) {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                if let workoutId = selectedWorkoutId,
                   WorkoutDetailSelectionPresentation.canRetryDetail(
                       workoutId: workoutId,
                       isLoadingDetail: model.isLoadingDetail
                   ) {
                    Button("Retry workout") {
                        selectWorkoutDetail(workoutId)
                    }
                    .buttonStyle(.bordered)
                    .disabled(!WorkoutDetailSelectionPresentation.canStartSelection(pendingWorkoutId: pendingDetailSelectionWorkoutId))
                    .accessibilityHint("Retries loading the selected workout details.")
                }
            }
        } else if let detail = model.selectedDetail {
            WorkoutDetail(detail: detail)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: "figure.walk.motion")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text("Select a workout")
                    .font(.headline)
                Text("Its metrics and typed exercise or split structure will appear here.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
        }
    }

    private func selectWorkoutDetail(_ workoutId: String) {
        guard WorkoutDetailSelectionPresentation.canStartSelection(
            pendingWorkoutId: pendingDetailSelectionWorkoutId
        ) else {
            return
        }

        selectedWorkoutId = workoutId
        pendingDetailSelectionWorkoutId = workoutId
        Task {
            await model.select(workoutId)
            pendingDetailSelectionWorkoutId = WorkoutDetailSelectionPresentation.pendingWorkoutId(
                afterCompleting: workoutId,
                pendingWorkoutId: pendingDetailSelectionWorkoutId
            )
        }
    }
}

private struct WorkoutDetail: View {
    let detail: RPCWorkoutDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 5) {
                Text(detail.activity)
                    .font(.title3.bold())
                if let rawActivity = detail.rawActivity, rawActivity != detail.activity {
                    Text(rawActivity)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(WorkoutsViewModel.formatDate(detail.startedAt) + " · " + WorkoutsViewModel.formatDuration(detail.durationSeconds))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("Imported from \(detail.source)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            HStack(spacing: 8) {
                MetricPill(label: "Duration", value: WorkoutsViewModel.formatDuration(detail.durationSeconds))
                if let calories = detail.energyKilocalories {
                    MetricPill(label: "Energy", value: "\(Int(calories.rounded())) kcal")
                }
                if let heartRate = detail.averageHeartRate {
                    MetricPill(label: "Avg HR", value: "\(Int(heartRate.rounded())) bpm")
                }
            }

            switch detail.payload {
            case .strength(let exercises):
                StrengthDetail(exercises: exercises)
            case .cardio(let splits, let distance, let elevation, _, let pace):
                CardioDetail(
                    splits: splits,
                    distanceMeters: distance,
                    elevationMeters: elevation,
                    averagePaceSecondsPerKilometre: pace
                )
            }
        }
    }
}

private struct MetricPill: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.weight(.semibold))
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 9)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct StrengthDetail: View {
    let exercises: [RPCWorkoutStrengthExercise]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Exercises")
                .font(.headline)
            if exercises.isEmpty {
                Text("No exercises recorded.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(exercises, id: \.nodeId) { exercise in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("\(exercise.ordinal). \(exercise.name)")
                                .font(.body.weight(.semibold))
                            Spacer()
                            Text("\(exercise.volumeKilograms, specifier: "%.1f") kg total")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(exercise.sets, id: \.nodeId) { set in
                            HStack(spacing: 10) {
                                Text("#\(set.ordinal)")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                Text("\(set.repetitions) reps")
                                Text("\(set.loadKilograms, specifier: "%.1f") kg")
                                if let rpe = set.rpe { Text("RPE \(rpe, specifier: "%.1f")") }
                                Spacer()
                            }
                            .font(.caption)
                        }
                    }
                    .padding(.vertical, 7)
                    Divider()
                }
            }
        }
    }
}

private struct CardioDetail: View {
    let splits: [RPCWorkoutCardioSplit]
    let distanceMeters: Double?
    let elevationMeters: Double?
    let averagePaceSecondsPerKilometre: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Splits")
                .font(.headline)
            HStack(spacing: 12) {
                if let distanceMeters { Text("\(distanceMeters / 1000, specifier: "%.2f") km") }
                if let elevationMeters { Text("\(Int(elevationMeters.rounded())) m elevation") }
                if let pace = WorkoutsViewModel.formatPace(averagePaceSecondsPerKilometre) { Text("\(pace) avg") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if splits.isEmpty {
                Text("No split or lap structure recorded.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(splits, id: \.nodeId) { split in
                    HStack(spacing: 10) {
                        Text("#\(split.ordinal)")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                        Text("\(split.distanceMeters / 1000, specifier: "%.2f") km")
                        Text(WorkoutsViewModel.formatDuration(split.durationSeconds))
                        if let pace = WorkoutsViewModel.formatPace(split.paceSecondsPerKilometre) { Text(pace) }
                        if let heartRate = split.averageHeartRate { Text("\(Int(heartRate.rounded())) bpm") }
                        Spacer()
                    }
                    .font(.caption)
                    Divider()
                }
            }
        }
    }
}

private struct WorkoutsEmptyState: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "figure.run")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("No workouts imported yet")
                .font(.headline)
            Text("Import a workout from the native HealthKit pipeline to make it available to your second brain.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
    }
}
