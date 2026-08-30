import SwiftUI
import AthenaeumDomain
import AthenaeumRPC

// Phase 5 native stage — the native mirror of `web/src/CalendarDayView.tsx`: lists today's synced
// `calendarEvents` (`listCalendarEvents`) inside a real local-day `[from, to)` window, sorted
// chronologically, and exposes the server-authoritative sanitized binding catalog with the same
// governed `syncGoogleCalendar` action as the web connection surface. OAuth connect/callback and
// disconnect remain out of this view because they need a real browser redirect/account lifecycle;
// this view never fabricates a connected account or exposes private provider identity. If no
// `GatekeeperBinding` exists yet for this workspace, `listCalendarEvents` simply returns an empty
// list (`calendar-service-live.ts`'s `listEvents` doesn't require one to answer a read) — this
// view renders that as "No events today," not an error.
@MainActor
final class CalendarDayViewModel: ObservableObject {
    enum SyncState: Equatable {
        case idle
        case syncing(bindingId: String)
        case success(bindingId: String)
        case failure(bindingId: String)
    }

    struct EventRow: Identifiable, Equatable {
        let id: String
        let title: String
        let startDisplay: String
        let endDisplay: String
        let attendees: String
        let status: String
        let linkedNodeId: String?
        let startSortKey: String
    }

    @Published private(set) var events: [EventRow] = []
    @Published private(set) var isLoading = false
    @Published private(set) var hasLoadedEvents = false
    @Published var errorMessage: String?
    @Published private(set) var bindings: [RPCGatekeeperBindingSummary] = []
    @Published private(set) var isLoadingBindings = false
    @Published private(set) var bindingsErrorMessage: String?
    @Published private(set) var syncState: SyncState = .idle

    private let client: WorkspaceRPCClient

    init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.client = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
    }

    /// Test-only construction seam: production continues to resolve its workspace-scoped client
    /// above, while focused lifecycle tests can exercise the exact calendar read protocol.
    init(client: WorkspaceRPCClient) {
        self.client = client
    }

    /// Local-day `[from, to)` window in UTC ISO-8601 — matches `web/src/day-window.ts`'s own
    /// "today, in the caller's local calendar day" semantics, computed against the device's
    /// current `Calendar`/`TimeZone` (not hard-coded UTC-midnight, which would silently mismatch a
    /// non-UTC device's "today").
    static func todayWindow(now: Date = Date(), calendar: Calendar = .current) -> (from: String, to: String) {
        let startOfDay = calendar.startOfDay(for: now)
        let startOfNextDay = calendar.date(byAdding: .day, value: 1, to: startOfDay) ?? now
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return (formatter.string(from: startOfDay), formatter.string(from: startOfNextDay))
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        let window = Self.todayWindow()
        do {
            let raw = try await client.listCalendarEvents(from: window.from, to: window.to)
            events = raw
                .sorted { $0.start.isoString < $1.start.isoString }
                .map { event in
                    EventRow(
                        id: event.id,
                        title: event.title,
                        startDisplay: Self.displayTime(event.start),
                        endDisplay: Self.displayTime(event.end),
                        attendees: event.attendees.map { $0.displayName ?? $0.email }.joined(separator: ", "),
                        status: event.status,
                        linkedNodeId: event.linkedNodeId,
                        startSortKey: event.start.isoString
                    )
                }
            hasLoadedEvents = true
            errorMessage = nil
        } catch {
            errorMessage = Self.calendarLoadFailureMessage(for: error)
        }
    }

    /// The catalog is a separate read from the event projection. Keeping it independent means a
    /// temporary catalog failure cannot turn an otherwise successful day read into an empty or
    /// failed schedule, while the UI can still disable sync until a binding is confirmed.
    func refreshBindings() async {
        isLoadingBindings = true
        defer { isLoadingBindings = false }
        do {
            bindings = try await client.listGatekeeperBindings()
            bindingsErrorMessage = nil
            if case .syncing(let bindingId) = syncState,
               !bindings.contains(where: { $0.id == bindingId }) {
                syncState = .idle
            }
        } catch {
            bindingsErrorMessage = Self.calendarBindingsFailureMessage(for: error)
        }
    }

    /// Triggers only a server-confirmed binding and then re-reads the bounded day projection. The
    /// acknowledgement is intentionally presented as a request, not as a promise that provider
    /// rows have already arrived.
    func syncGoogleCalendar(bindingId: String) async {
        guard bindings.contains(where: { $0.id == bindingId }) else {
            return
        }
        if case .syncing = syncState {
            return
        }
        syncState = .syncing(bindingId: bindingId)
        do {
            guard try await client.syncGoogleCalendar(bindingId: bindingId) else {
                syncState = .failure(bindingId: bindingId)
                return
            }
            syncState = .success(bindingId: bindingId)
            await refresh()
        } catch {
            syncState = .failure(bindingId: bindingId)
        }
    }

    /// Calendar read failures can contain provider or credential-adjacent detail. The existing
    /// refresh control is the safe recovery path without presenting an unavailable day as empty.
    static func calendarLoadFailureMessage(for _: Error) -> String {
        "Calendar events couldn’t be loaded. Nothing has been changed. Refresh to check today again."
    }

    static func calendarBindingsFailureMessage(for _: Error) -> String {
        "Calendar connections couldn’t be confirmed. Retry before requesting a sync."
    }

    static let calendarSyncFailureMessage =
        "Calendar sync couldn’t be started. Nothing has changed. Retry from this connection."

    static let calendarSyncSuccessMessage =
        "Sync requested. Calendar events will refresh shortly."

    /// A blank result only means "no events" after the current day window has completed a
    /// successful read. Before then, or after a failure, the schedule remains unknown.
    static func shouldShowEmptyEvents(
        isEmpty: Bool,
        hasLoadedEvents: Bool,
        isLoading: Bool,
        errorMessage: String?
    ) -> Bool {
        isEmpty && hasLoadedEvents && !isLoading && errorMessage == nil
    }

    static func shouldShowEventsLoading(
        hasLoadedEvents: Bool,
        isLoading: Bool,
        errorMessage: String?
    ) -> Bool {
        isLoading || (!hasLoadedEvents && errorMessage == nil)
    }

    /// An inline retry is useful only after a failed read has completed. During a refresh the
    /// existing loading state takes over, so the action cannot imply that the schedule is empty.
    static func shouldShowEventsRetry(errorMessage: String?, isLoading: Bool) -> Bool {
        errorMessage != nil && !isLoading
    }

    private static let displayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    private static func displayTime(_ time: RPCCalendarEventTime) -> String {
        switch time {
        case .date(let date):
            return date
        case .dateTime(let dateTime, _):
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let parsed = iso.date(from: dateTime) {
                return displayFormatter.string(from: parsed)
            }
            iso.formatOptions = [.withInternetDateTime]
            if let parsed = iso.date(from: dateTime) {
                return displayFormatter.string(from: parsed)
            }
            return dateTime
        }
    }
}

enum CalendarDayRefreshPresentation {
    static func canStartRefresh(isRefreshInFlight: Bool) -> Bool {
        !isRefreshInFlight
    }

    static func isLoading(isModelLoading: Bool, isRefreshInFlight: Bool) -> Bool {
        isModelLoading || isRefreshInFlight
    }
}

public struct CalendarDayView: View {
    @StateObject private var model: CalendarDayViewModel
    // View-local so rapid header/retry activation is rejected before the model's asynchronous
    // loading state can re-render. The calendar read and its data contract remain model-owned.
    @State private var isRefreshInFlight = false
    @State private var selectedBindingId: String?
    private let onOpenEntity: ((String) -> Void)?

    public init(
        backendURL: URL,
        workspaceId: EntityId,
        bearerCredential: String?,
        onOpenEntity: ((String) -> Void)? = nil
    ) {
        _model = StateObject(
            wrappedValue: CalendarDayViewModel(backendURL: backendURL, workspaceId: workspaceId, bearerCredential: bearerCredential)
        )
        _selectedBindingId = State(initialValue: nil)
        self.onOpenEntity = onOpenEntity
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Today").font(.title2.bold())
                Spacer()
                if CalendarDayViewModel.shouldShowEventsLoading(
                    hasLoadedEvents: model.hasLoadedEvents,
                    isLoading: isLoadingEvents,
                    errorMessage: model.errorMessage
                ) {
                    ProgressView().controlSize(.small)
                } else {
                    Button("Refresh") { startRefresh() }
                }
            }

            calendarConnectionControls

            if CalendarDayViewModel.shouldShowEventsLoading(
                hasLoadedEvents: model.hasLoadedEvents,
                isLoading: isLoadingEvents,
                errorMessage: model.errorMessage
            ) {
                ProgressView("Loading today’s events…")
                    .foregroundStyle(.secondary)
            } else if let error = model.errorMessage {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Calendar events are unavailable", systemImage: "exclamationmark.triangle")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                    if CalendarDayViewModel.shouldShowEventsRetry(
                        errorMessage: model.errorMessage,
                        isLoading: isLoadingEvents
                    ) {
                        Button("Retry") { startRefresh() }
                            .accessibilityHint("Retries loading today’s calendar events.")
                    }
                }
            } else if CalendarDayViewModel.shouldShowEmptyEvents(
                isEmpty: model.events.isEmpty,
                hasLoadedEvents: model.hasLoadedEvents,
                isLoading: isLoadingEvents,
                errorMessage: model.errorMessage
            ) {
                Text("No events today.").foregroundStyle(.secondary)
            }
            ForEach(model.events) { row in
                HStack(alignment: .top) {
                    Text("\(row.startDisplay) – \(row.endDisplay)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .frame(width: 110, alignment: .leading)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title).bold()
                        if !row.attendees.isEmpty {
                            Text(row.attendees).font(.caption).foregroundStyle(.secondary)
                        }
                        if let linkedNodeId = row.linkedNodeId, let onOpenEntity {
                            Button {
                                onOpenEntity(linkedNodeId)
                            } label: {
                                Label("Open linked entity", systemImage: "link")
                                    .font(.caption)
                            }
                            #if os(macOS)
                            .buttonStyle(.link)
                            #else
                            .buttonStyle(.borderless)
                            #endif
                        }
                    }
                    Spacer()
                    if row.status != "confirmed" {
                        Text(row.status).font(.caption2).foregroundStyle(.orange)
                    }
                }
            }
        }
        .padding()
        .task {
            await refreshOnAppear()
            await model.refreshBindings()
        }
        .onChange(of: model.bindings) { _ in
            selectDefaultBinding()
        }
    }

    @ViewBuilder
    private var calendarConnectionControls: some View {
        if model.isLoadingBindings {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Checking calendar connections…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
        } else if let error = model.bindingsErrorMessage {
            VStack(alignment: .leading, spacing: 6) {
                Label("Calendar connections unavailable", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                Button("Retry connections") {
                    Task { @MainActor in await model.refreshBindings() }
                }
                .disabled(model.isLoadingBindings)
                .accessibilityHint("Retries checking the workspace calendar connections.")
            }
        } else if model.bindings.isEmpty {
            Label("No Google Calendar connections", systemImage: "calendar.badge.exclamationmark")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else if let selectedBinding {
            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Label("Google Calendar connected", systemImage: "checkmark.circle.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    if model.bindings.count > 1 {
                        Menu {
                            ForEach(model.bindings.indices, id: \.self) { index in
                                let binding = model.bindings[index]
                                Button(bindingLabel(for: binding, index: index)) {
                                    selectedBindingId = binding.id
                                }
                            }
                        } label: {
                            Label(selectedBindingLabel, systemImage: "rectangle.stack")
                                .font(.caption)
                        }
                        .disabled(isSyncing)
                        .accessibilityLabel("Select Google Calendar connection")
                    }
                }
                Text(bindingLabel(for: selectedBinding, index: selectedBindingIndex))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    Button(isSyncing ? "Syncing…" : "Sync now") {
                        Task { @MainActor in await model.syncGoogleCalendar(bindingId: selectedBinding.id) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(isSyncing || model.isLoadingBindings)
                    .accessibilityLabel("Sync selected Google Calendar")
                    .accessibilityHint("Requests a server sync, then refreshes today’s events.")
                    switch selectedSyncState {
                    case .success:
                        Text(CalendarDayViewModel.calendarSyncSuccessMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityAddTraits(.updatesFrequently)
                    case .failure:
                        Text(CalendarDayViewModel.calendarSyncFailureMessage)
                            .font(.caption)
                            .foregroundStyle(.red)
                    case .idle, .syncing:
                        EmptyView()
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }

    private var selectedBinding: RPCGatekeeperBindingSummary? {
        guard !model.bindings.isEmpty else { return nil }
        if let selectedBindingId,
           let selected = model.bindings.first(where: { $0.id == selectedBindingId }) {
            return selected
        }
        return model.bindings.first
    }

    private var selectedBindingIndex: Int {
        guard let selectedBinding,
              let index = model.bindings.firstIndex(where: { $0.id == selectedBinding.id })
        else { return 0 }
        return index
    }

    private var selectedBindingLabel: String {
        bindingLabel(for: selectedBinding ?? model.bindings[0], index: selectedBindingIndex)
    }

    private var selectedSyncState: CalendarDayViewModel.SyncState {
        guard let selectedBinding else { return .idle }
        switch model.syncState {
        case .success(let bindingId) where bindingId == selectedBinding.id:
            return .success(bindingId: bindingId)
        case .failure(let bindingId) where bindingId == selectedBinding.id:
            return .failure(bindingId: bindingId)
        case .syncing(let bindingId) where bindingId == selectedBinding.id:
            return .syncing(bindingId: bindingId)
        default:
            return .idle
        }
    }

    private var isSyncing: Bool {
        if case .syncing = model.syncState { return true }
        return false
    }

    private func bindingLabel(for binding: RPCGatekeeperBindingSummary, index: Int) -> String {
        let mode = binding.mode == "allVisible" ? "All visible calendars" : "Selected calendar"
        return "Calendar \(index + 1) · \(mode)"
    }

    private func selectDefaultBinding() {
        guard let selectedBindingId,
              model.bindings.contains(where: { $0.id == selectedBindingId })
        else {
            self.selectedBindingId = model.bindings.first?.id
            return
        }
    }

    private var isLoadingEvents: Bool {
        CalendarDayRefreshPresentation.isLoading(
            isModelLoading: model.isLoading,
            isRefreshInFlight: isRefreshInFlight
        )
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
        guard CalendarDayRefreshPresentation.canStartRefresh(
            isRefreshInFlight: isRefreshInFlight
        ) else {
            return false
        }
        isRefreshInFlight = true
        return true
    }

    private func completeRefresh() async {
        defer { isRefreshInFlight = false }
        await model.refresh()
        await model.refreshBindings()
    }
}
