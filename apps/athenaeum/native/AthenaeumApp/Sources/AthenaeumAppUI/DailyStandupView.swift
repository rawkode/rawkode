import AthenaeumDomain
import AthenaeumRPC
import Foundation
import SwiftUI

typealias DailyStandupLoader = @Sendable () async throws -> [RPCLedgerActivityEntry]

/// The local calendar-day window sent to the ledger projection. Keeping this calculation in the
/// client means a standup follows the user's day even when the backend stores UTC instants.
struct DailyStandupDayWindow: Equatable, Sendable {
    let from: String
    let to: String

    init(now: Date = Date(), calendar: Calendar = .autoupdatingCurrent) {
        let start = calendar.startOfDay(for: now)
        let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.from = formatter.string(from: start)
        self.to = formatter.string(from: end)
    }
}

@MainActor
final class DailyStandupViewModel: ObservableObject {
    enum State: Equatable {
        case idle
        case loading
        case loaded([RPCLedgerActivityEntry])
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    private let loader: DailyStandupLoader

    init(loader: @escaping DailyStandupLoader) {
        self.loader = loader
    }

    convenience init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        let client = WorkspaceRPCClient(
            baseURL: workspaceURL,
            workspaceId: workspaceId.rawValue,
            bearerCredential: bearerCredential
        )
        self.init(loader: {
            let window = DailyStandupDayWindow()
            return try await client.listRecentLedgerActivity(from: window.from, to: window.to)
        })
    }

    func refresh() async {
        state = .loading
        do {
            state = .loaded(try await loader())
        } catch {
            state = .failed(Self.loadFailureMessage(for: error))
        }
    }

    /// Ledger read errors can carry transport, provider, or credential-adjacent details. The
    /// existing Retry control is the safe recovery path, so the visible state stays static.
    static func loadFailureMessage(for _: Error) -> String {
        "Unable to load the daily standup. Please try again."
    }
}

struct DailyStandupSummary: Equatable, Sendable {
    let total: Int
    let byYou: Int
    let byWorkspaceMembers: Int
    let byAutomatedActors: Int

    init(entries: [RPCLedgerActivityEntry]) {
        total = entries.count
        byYou = entries.filter { $0.actor == .you }.count
        byWorkspaceMembers = entries.filter { $0.actor == .workspaceMember }.count
        byAutomatedActors = entries.filter { $0.actor == .anonymous }.count
    }
}

enum DailyStandupRefreshPresentation {
    static func canStartRefresh(isRefreshInFlight: Bool) -> Bool {
        !isRefreshInFlight
    }

    static func actionTitle(isRefreshing: Bool) -> String {
        isRefreshing ? "Refreshing…" : "Refresh"
    }

    static func retryTitle(isRefreshing: Bool) -> String {
        isRefreshing ? "Retrying…" : "Retry"
    }

    static func progressTitle(isRefreshing: Bool) -> String {
        isRefreshing ? "Refreshing recorded work…" : "Loading standup…"
    }
}

public struct DailyStandupView: View {
    @StateObject private var model: DailyStandupViewModel
    @State private var isRefreshInFlight = false

    public init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        _model = StateObject(
            wrappedValue: DailyStandupViewModel(
                backendURL: backendURL,
                workspaceId: workspaceId,
                bearerCredential: bearerCredential
            )
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Daily standup")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Recorded work")
                        .font(.title2.bold())
                }
                Spacer()
                HStack(spacing: 10) {
                    Button {
                        startRefresh()
                    } label: {
                        Label(
                            DailyStandupRefreshPresentation.actionTitle(isRefreshing: isRefreshing),
                            systemImage: "arrow.clockwise"
                        )
                    }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .disabled(isRefreshing)
                    .help("Refresh recorded work")

                    Label("Ledger", systemImage: "checkmark.seal")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Text("Changes recorded today. Every entry has an actor and a commit reason.")
                .font(.caption)
                .foregroundStyle(.secondary)

            switch model.state {
            case .idle, .loading:
                ProgressView(DailyStandupRefreshPresentation.progressTitle(isRefreshing: isRefreshing))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.updatesFrequently)
            case .failed(let message):
                VStack(alignment: .leading, spacing: 8) {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                    Button(DailyStandupRefreshPresentation.retryTitle(isRefreshing: isRefreshing)) {
                        startRefresh()
                    }
                    .disabled(isRefreshing)
                }
            case .loaded(let entries):
                if entries.isEmpty {
                    Text("No recorded work yet.")
                        .foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        DailyStandupSummaryView(summary: DailyStandupSummary(entries: entries))
                        ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                            DailyStandupEntryRow(entry: entry)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 8)
        .task { await refreshOnAppear() }
    }

    private var isRefreshing: Bool {
        if isRefreshInFlight { return true }
        if case .loading = model.state { return true }
        return false
    }

    private func startRefresh() {
        guard beginRefresh() else { return }
        Task { @MainActor in
            await completeRefresh()
        }
    }

    private func refreshOnAppear() async {
        guard beginRefresh() else { return }
        await completeRefresh()
    }

    private func beginRefresh() -> Bool {
        guard DailyStandupRefreshPresentation.canStartRefresh(isRefreshInFlight: isRefreshInFlight) else {
            return false
        }
        isRefreshInFlight = true
        return true
    }

    private func completeRefresh() async {
        defer { isRefreshInFlight = false }
        await model.refresh()
    }
}

private struct DailyStandupEntryRow: View {
    let entry: RPCLedgerActivityEntry

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: entry.type.systemImage)
                .foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(entry.type.displayName)
                        .font(.caption.weight(.semibold))
                    Text(entry.actor.displayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Text(Self.timeFormatter.string(from: Self.date(from: entry.occurredAt.rawValue) ?? .distantPast))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Commit reason")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                        .tracking(0.5)
                    Text(entry.message)
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    private static func date(from value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? {
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: value)
        }()
    }
}

private struct DailyStandupSummaryView: View {
    let summary: DailyStandupSummary

    var body: some View {
        HStack(spacing: 10) {
            Text("\(summary.total) \(summary.total == 1 ? "change" : "changes")")
            if summary.byYou > 0 { Text("\(summary.byYou) by you") }
            if summary.byWorkspaceMembers > 0 { Text("\(summary.byWorkspaceMembers) by workspace members") }
            if summary.byAutomatedActors > 0 { Text("\(summary.byAutomatedActors) automated") }
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(summary.accessibilityLabel)
    }
}

private extension DailyStandupSummary {
    var accessibilityLabel: String {
        var parts = ["\(total) \(total == 1 ? "change" : "changes")"]
        if byYou > 0 { parts.append("\(byYou) by you") }
        if byWorkspaceMembers > 0 { parts.append("\(byWorkspaceMembers) by workspace members") }
        if byAutomatedActors > 0 { parts.append("\(byAutomatedActors) automated") }
        return parts.joined(separator: ", ")
    }
}
