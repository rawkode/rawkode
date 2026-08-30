import AthenaeumDomain
import AthenaeumRPC
import Foundation
import SwiftUI

typealias DailyStandupLoader = @Sendable (DailyStandupDayWindow) async throws -> [RPCLedgerActivityEntry]
typealias EmployeeUpdatesLoader = @Sendable () async throws -> [StandupPublication]

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

enum DailyStandupLifecyclePresentation {
    static func nextLocalMidnight(after now: Date, calendar: Calendar = .autoupdatingCurrent) -> Date {
        let start = calendar.startOfDay(for: now)
        return calendar.date(byAdding: .day, value: 1, to: start) ?? now
    }
}

/// The view owns lifecycle observation, while this small injected seam owns clock/scheduling.
/// Tests can advance a day without relying on wall-clock time or a real sleep.
public struct DailyStandupLifecycleDriver: Sendable {
    public let now: @Sendable () -> Date
    public let sleepUntil: @Sendable (Date) async throws -> Void

    public init(
        now: @escaping @Sendable () -> Date,
        sleepUntil: @escaping @Sendable (Date) async throws -> Void
    ) {
        self.now = now
        self.sleepUntil = sleepUntil
    }

    public static let live = Self(
        now: { Date() },
        sleepUntil: { date in
            let interval = max(date.timeIntervalSinceNow, 0)
            try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        }
    )
}

@MainActor
final class DailyStandupViewModel: ObservableObject {
    enum State: Equatable {
        case idle
        case loading
        case loaded([RPCLedgerActivityEntry])
        case failed(String)
    }

    enum EmployeeState: Equatable {
        case idle
        case loading
        case loaded([StandupPublication])
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var employeeState: EmployeeState = .idle
    private let loader: DailyStandupLoader?
    private let employeeLoader: EmployeeUpdatesLoader?
    private let employeeLoaderFactory: (@Sendable (EntityId) async throws -> [StandupPublication])?
    private var selectedDailyNoteId: EntityId?
    private var ledgerEnabled = true
    private var dayWindowIdentity = "historical"
    private var generation = 0

    var employeeLoaderAvailable: Bool {
        employeeLoader != nil || (employeeLoaderFactory != nil && selectedDailyNoteId != nil)
    }

    init(loader: @escaping DailyStandupLoader, employeeLoader: EmployeeUpdatesLoader? = nil) {
        self.loader = loader
        self.employeeLoader = employeeLoader
        self.employeeLoaderFactory = nil
        self.selectedDailyNoteId = nil
    }

    init(ledgerLoader: DailyStandupLoader?, employeeLoader: EmployeeUpdatesLoader?) {
        self.loader = ledgerLoader
        self.employeeLoader = employeeLoader
        self.employeeLoaderFactory = nil
        self.selectedDailyNoteId = nil
    }

    init(
        ledgerLoader: DailyStandupLoader?,
        employeeLoaderFactory: (@Sendable (EntityId) async throws -> [StandupPublication])?,
        dailyNoteId: EntityId?
    ) {
        self.loader = ledgerLoader
        self.employeeLoader = nil
        self.employeeLoaderFactory = employeeLoaderFactory
        self.selectedDailyNoteId = dailyNoteId
    }

    convenience init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?, dailyNoteId: EntityId? = nil, includeLedger: Bool = true) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        let client = WorkspaceRPCClient(
            baseURL: workspaceURL,
            workspaceId: workspaceId.rawValue,
            bearerCredential: bearerCredential
        )
        let employeeLoaderFactory: (@Sendable (EntityId) async throws -> [StandupPublication])?
        if dailyNoteId != nil {
            employeeLoaderFactory = { noteId in
                try await client.listStandupPublications(dailyNoteId: noteId.rawValue)
            }
        } else {
            employeeLoaderFactory = nil
        }
        let ledgerLoader: DailyStandupLoader?
        if includeLedger {
            ledgerLoader = { window in
                return try await client.listRecentLedgerActivity(
                    limit: DailyStandupPresentation.fetchLimit,
                    from: window.from,
                    to: window.to
                )
            }
        } else {
            ledgerLoader = nil
        }
        self.init(ledgerLoader: ledgerLoader, employeeLoaderFactory: employeeLoaderFactory, dailyNoteId: dailyNoteId)
    }

    func updateDailyNoteId(_ dailyNoteId: EntityId?) {
        update(dailyNoteId: dailyNoteId, includeLedger: ledgerEnabled)
    }

    /// A DailyNoteView owns this model and advances the snapshot before starting either lane.
    /// Every terminal write subsequently checks the same monotonic generation and note identity.
    func update(
        dailyNoteId: EntityId?,
        includeLedger: Bool,
        dayWindow: DailyStandupDayWindow = DailyStandupDayWindow()
    ) {
        let normalizedDayWindow = includeLedger ? Self.dayWindowKey(dayWindow) : "historical"
        guard selectedDailyNoteId != dailyNoteId || ledgerEnabled != includeLedger || dayWindowIdentity != normalizedDayWindow else { return }
        generation &+= 1
        selectedDailyNoteId = dailyNoteId
        ledgerEnabled = includeLedger
        dayWindowIdentity = normalizedDayWindow
        state = .idle
        employeeState = .idle
    }

    /// The host may call this from foreground/midnight observation. Historical notes deliberately
    /// retain the inert identity so crossing midnight never refetches their publications.
    func invalidateForLifecycle(now: Date, calendar: Calendar = .autoupdatingCurrent) {
        update(
            dailyNoteId: selectedDailyNoteId,
            includeLedger: ledgerEnabled,
            dayWindow: DailyStandupDayWindow(now: now, calendar: calendar)
        )
    }

    /// The caller supplies the exact civil window captured for this generation. The ledger RPC
    /// must never silently recalculate it after a rollover.
    func refresh(window: DailyStandupDayWindow = DailyStandupDayWindow()) async {
        generation &+= 1
        let refreshGeneration = generation
        let noteIdentity = selectedDailyNoteId
        let shouldLoadLedger = ledgerEnabled && loader != nil
        let requestedWindow = shouldLoadLedger ? window : nil
        let refreshDayWindow = requestedWindow.map(Self.dayWindowKey) ?? "historical"
        dayWindowIdentity = refreshDayWindow
        if shouldLoadLedger { state = .loading } else { state = .idle }
        let employeeLoader: EmployeeUpdatesLoader?
        if let directEmployeeLoader = self.employeeLoader {
            employeeLoader = directEmployeeLoader
        } else if let noteIdentity, let employeeLoaderFactory {
            employeeLoader = {
                try await employeeLoaderFactory(noteIdentity)
            }
        } else {
            employeeLoader = nil
        }
        if employeeLoader != nil { employeeState = .loading } else { employeeState = .idle }

        await withTaskGroup(of: LaneResult.self) { group in
            if let requestedWindow, let loader {
                group.addTask {
                    do { return .ledger(.success(try await loader(requestedWindow))) }
                    catch { return .ledger(.failure(error)) }
                }
            }
            if let employeeLoader {
                group.addTask {
                    do { return .employee(.success(try await employeeLoader())) }
                    catch { return .employee(.failure(error)) }
                }
            }
            for await result in group where accepts(refreshGeneration: refreshGeneration, noteIdentity: noteIdentity, dayWindow: refreshDayWindow) {
                switch result {
                case .ledger(.success(let entries)): state = .loaded(entries)
                case .ledger(.failure(let error)): state = .failed(Self.loadFailureMessage(for: error))
                case .employee(.success(let publications)): employeeState = .loaded(publications)
                case .employee(.failure(let error)): employeeState = .failed(Self.employeeLoadFailureMessage(for: error))
                }
            }
        }
    }

    private func accepts(refreshGeneration: Int, noteIdentity: EntityId?, dayWindow: String) -> Bool {
        generation == refreshGeneration && selectedDailyNoteId == noteIdentity && dayWindowIdentity == dayWindow
    }

    private static func dayWindowKey(_ window: DailyStandupDayWindow) -> String {
        "\(window.from)|\(window.to)"
    }

    private enum LaneResult: @unchecked Sendable {
        case ledger(Result<[RPCLedgerActivityEntry], Error>)
        case employee(Result<[StandupPublication], Error>)
    }

    /// Ledger read errors can carry transport, provider, or credential-adjacent details. The
    /// existing Retry control is the safe recovery path, so the visible state stays static.
    static func loadFailureMessage(for _: Error) -> String {
        "Unable to load the daily standup. Please try again."
    }

    static func employeeLoadFailureMessage(for _: Error) -> String {
        "Unable to load employee updates. Please try again."
    }
}

struct DailyStandupSummary: Equatable, Sendable {
    let total: Int
    let byYou: Int
    let byWorkspaceMembers: Int
    let byAutomatedActors: Int

    init(entries: [RPCLedgerActivityEntry]) {
        total = entries.count
        byYou = entries.filter {
            if let kind = $0.actorDetail?.kind { return kind == .user }
            return $0.actor == .you
        }.count
        byWorkspaceMembers = entries.filter {
            if let kind = $0.actorDetail?.kind { return kind == .employee }
            return $0.actor == .workspaceMember
        }.count
        byAutomatedActors = entries.filter {
            if let kind = $0.actorDetail?.kind { return kind == .system }
            return $0.actor == .anonymous
        }.count
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

enum DailyStandupPresentation {
    static let fetchLimit = 20
    static let initialVisibleEntryCount = 8

    static func visibleEntries(
        _ entries: [RPCLedgerActivityEntry],
        isExpanded: Bool
    ) -> ArraySlice<RPCLedgerActivityEntry> {
        isExpanded ? entries[...] : entries.prefix(initialVisibleEntryCount)
    }

    static func additionalEntryCount(_ entries: [RPCLedgerActivityEntry]) -> Int {
        max(entries.count - initialVisibleEntryCount, 0)
    }

    static func disclosureTitle(isExpanded: Bool, additionalEntryCount: Int) -> String {
        if isExpanded { return "Show fewer recorded changes" }
        return "Show \(additionalEntryCount) more recorded \(additionalEntryCount == 1 ? "change" : "changes")"
    }
}

public struct DailyStandupView: View {
    @ObservedObject private var model: DailyStandupViewModel
    @State private var isShowingAllEntries = false
    private let dailyNoteId: EntityId?
    private let onOpenEmployeeUpdate: ((EntityId) -> Void)?
    private let onRefresh: () -> Void

    init(
        model: DailyStandupViewModel,
        dailyNoteId: EntityId? = nil,
        includeLedger: Bool = true,
        onOpenEmployeeUpdate: ((EntityId) -> Void)? = nil,
        onRefresh: @escaping () -> Void = {}
    ) {
        self.model = model
        self.dailyNoteId = dailyNoteId
        self.includeLedger = includeLedger
        self.onOpenEmployeeUpdate = onOpenEmployeeUpdate
        self.onRefresh = onRefresh
    }

    private let includeLedger: Bool

    public var body: some View {
        Group {
            if model.employeeLoaderAvailable || includeLedger {
                VStack(alignment: .leading, spacing: 10) {
                    subdocumentHeader
                    VStack(alignment: .leading, spacing: 14) {
                        if model.employeeLoaderAvailable {
                            employeeUpdates
                        }
                        if includeLedger {
                            ledgerActivity
                        }
                    }
                }
                .padding(.vertical, 8)
            }
        }
    }

    private var subdocumentHeader: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Daily note sub-document")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Daily standup")
                .font(.title2.bold())
            Text("Employee updates and recorded changes for this day.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var employeeUpdates: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Workforce")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Employee updates")
                        .font(.headline)
                }
                Spacer()
                Label("Workforce", systemImage: "person.3")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            switch model.employeeState {
            case .idle, .loading:
                ProgressView("Loading employee updates…")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.updatesFrequently)
            case .failed(let message):
                VStack(alignment: .leading, spacing: 8) {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                    Button(DailyStandupRefreshPresentation.retryTitle(isRefreshing: isRefreshing)) {
                        onRefresh()
                    }
                    .disabled(isRefreshing)
                }
            case .loaded(let publications):
                if publications.isEmpty {
                    Text("No published employee updates for this note yet.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    let partitions = EmployeeUpdatePresentation.partition(publications)
                    if !partitions.needsAttention.isEmpty {
                        employeeUpdateGroup(
                            title: "Needs attention",
                            publications: partitions.needsAttention,
                            isAttention: true
                        )
                    }
                    if !partitions.updates.isEmpty {
                        employeeUpdateGroup(
                            title: "Updates",
                            publications: partitions.updates,
                            isAttention: false
                        )
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func employeeUpdateGroup(
        title: String,
        publications: [StandupPublication],
        isAttention: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
                .foregroundStyle(isAttention ? .red : .primary)
                .accessibilityAddTraits(.isHeader)
            ForEach(publications, id: \.id) { publication in
                EmployeeUpdateRow(
                    publication: publication,
                    onOpen: onOpenEmployeeUpdate
                )
            }
        }
    }

    @ViewBuilder
    private var ledgerActivity: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Ledger")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Recorded work")
                        .font(.headline)
                }
                Spacer()
                HStack(spacing: 10) {
                    Button {
                        onRefresh()
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

            Text("Recent recorded changes today (up to \(DailyStandupPresentation.fetchLimit)). Every entry has an actor and a commit reason.")
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
                        onRefresh()
                    }
                    .disabled(isRefreshing)
                }
            case .loaded(let entries):
                if entries.isEmpty {
                    Text("No recorded work yet.")
                        .foregroundStyle(.secondary)
                } else {
                    let visibleEntries = DailyStandupPresentation.visibleEntries(entries, isExpanded: isShowingAllEntries)
                    let additionalEntryCount = DailyStandupPresentation.additionalEntryCount(entries)
                    VStack(alignment: .leading, spacing: 10) {
                        DailyStandupSummaryView(summary: DailyStandupSummary(entries: entries))
                        ForEach(Array(visibleEntries.enumerated()), id: \.offset) { _, entry in
                            DailyStandupEntryRow(entry: entry)
                        }
                        if additionalEntryCount > 0 {
                            Button(DailyStandupPresentation.disclosureTitle(
                                isExpanded: isShowingAllEntries,
                                additionalEntryCount: additionalEntryCount
                            )) {
                                isShowingAllEntries.toggle()
                            }
                            .buttonStyle(.borderless)
                            .font(.caption)
                            .accessibilityHint("Expands the recent recorded changes in this daily note.")
                        }
                    }
                }
            }
        }
    }

    private var isRefreshing: Bool {
        if case .loading = model.state { return true }
        if case .loading = model.employeeState { return true }
        return false
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
                    Text(entry.actorDetail?.label ?? entry.actor.displayName)
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
                if let target = entry.target {
                    Link(destination: URL(string: "athenaeum://node/\(target.id.rawValue)")!) {
                        Label("Open affected note", systemImage: "arrow.up.right.square")
                            .font(.caption)
                    }
                    .foregroundStyle(.tint)
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

enum EmployeeUpdatePresentation {
    struct Outcome: Equatable, Sendable {
        let label: String
        let systemImage: String
        let isAttention: Bool
    }

    struct Partitions: Equatable, Sendable {
        let needsAttention: [StandupPublication]
        let updates: [StandupPublication]
    }

    /// Keep the server's publication order within each section. The order is already a durable
    /// projection order, so client-side timestamp sorting would make equal timestamps unstable.
    static func partition(_ publications: [StandupPublication]) -> Partitions {
        var needsAttention: [StandupPublication] = []
        var updates: [StandupPublication] = []
        for publication in publications {
            switch publication.resultKind {
            case .blocked, .failed:
                needsAttention.append(publication)
            case .completed, .skipped, .none:
                updates.append(publication)
            }
        }
        return Partitions(needsAttention: needsAttention, updates: updates)
    }

    static func outcome(for resultKind: StandupPublicationResultKind?) -> Outcome? {
        switch resultKind {
        case .completed:
            return Outcome(label: "Completed", systemImage: "checkmark.circle", isAttention: false)
        case .blocked:
            return Outcome(label: "Blocked", systemImage: "exclamationmark.triangle", isAttention: true)
        case .failed:
            return Outcome(label: "Failed", systemImage: "xmark.octagon", isAttention: true)
        case .skipped:
            return Outcome(label: "Skipped", systemImage: "minus.circle", isAttention: false)
        case .none:
            return nil
        }
    }

    static func canOpenCompanion(
        status: StandupPublicationCompanionStatus,
        hasOpenAction: Bool
    ) -> Bool {
        hasOpenAction && (status == .verifiedOriginal || status == .modified)
    }
}

private struct EmployeeUpdateRow: View {
    let publication: StandupPublication
    let onOpen: ((EntityId) -> Void)?

    private var statusLabel: String {
        switch publication.companionStatus {
        case .verifiedOriginal: return "Original update verified."
        case .modified: return "This update may have changed since publication."
        case .missing: return "The companion update is no longer available."
        case .unavailable: return "The companion update is currently unavailable."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            VStack(alignment: .leading, spacing: 5) {
                if let outcome = EmployeeUpdatePresentation.outcome(for: publication.resultKind) {
                    Label(outcome.label, systemImage: outcome.systemImage)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(outcome.isAttention ? .red : .secondary)
                }
                Text(publication.originalText)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Employee: \(publication.microEmployeeLabel) · Job: \(publication.jobLabel)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("Workflow: \(publication.workflowLabel) · Schedule: \(publication.scheduleLabel)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(statusLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)

            if EmployeeUpdatePresentation.canOpenCompanion(
                status: publication.companionStatus,
                hasOpenAction: onOpen != nil
            ), let onOpen {
                Button("Open update") {
                    onOpen(publication.childNodeId)
                }
                .buttonStyle(.borderless)
                .accessibilityHint("Opens this employee update's companion page.")
            }
        }
    }
}

private struct DailyStandupSummaryView: View {
    let summary: DailyStandupSummary

    fileprivate struct Item: Identifiable {
        let id: String
        let value: String
        let label: String
    }

    private var items: [Item] {
        var values = [
            Item(
                id: "total",
                value: "\(summary.total)",
                label: summary.total == 1 ? "change" : "changes"
            )
        ]
        if summary.byYou > 0 {
            values.append(Item(id: "you", value: "\(summary.byYou)", label: "by you"))
        }
        if summary.byWorkspaceMembers > 0 {
            values.append(Item(id: "workspace", value: "\(summary.byWorkspaceMembers)", label: "workspace members"))
        }
        if summary.byAutomatedActors > 0 {
            values.append(Item(id: "automated", value: "\(summary.byAutomatedActors)", label: "automated"))
        }
        return values
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(items) { item in
                    DailyStandupSummaryChip(item: item, isPrimary: item.id == "total")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(summary.accessibilityLabel)
    }
}

private struct DailyStandupSummaryChip: View {
    let item: DailyStandupSummaryView.Item
    let isPrimary: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(item.value)
                .font(.headline.monospacedDigit())
                .foregroundStyle(isPrimary ? Color.primary : Color.accentColor)
            Text(item.label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            isPrimary ? Color.primary.opacity(0.07) : Color.accentColor.opacity(0.07),
            in: RoundedRectangle(cornerRadius: 8, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(isPrimary ? Color.primary.opacity(0.16) : Color.accentColor.opacity(0.16), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.value) \(item.label)")
    }
}

extension DailyStandupSummary {
    var accessibilityLabel: String {
        var parts = ["\(total) \(total == 1 ? "change" : "changes")"]
        if byYou > 0 { parts.append("\(byYou) by you") }
        if byWorkspaceMembers > 0 { parts.append("\(byWorkspaceMembers) by workspace members") }
        if byAutomatedActors > 0 { parts.append("\(byAutomatedActors) automated") }
        return parts.joined(separator: ", ")
    }
}
