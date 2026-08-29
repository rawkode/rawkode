import SwiftUI
import AthenaeumDomain
import AthenaeumRPC

// Phase 5 native stage — the native mirror of `web/src/CalendarDayView.tsx`: lists today's synced
// `calendarEvents` (`listCalendarEvents`) inside a real local-day `[from, to)` window, sorted
// chronologically, same shape as the web-stage's verified slice. Read-only: this stage does not
// ship a "Connect Google Calendar" affordance in the app UI (see `WorkspaceRPCClient+Calendar.swift`'s
// top doc comment for why — no real Google OAuth client/account in this environment; the OAuth
// connect/callback/sync RPC methods are real and proven via `Phase5Driver`, just not wired into
// this view). If no `GatekeeperBinding` exists yet for this workspace, `listCalendarEvents` simply
// returns an empty list (`calendar-service-live.ts`'s `listEvents` doesn't require one to answer
// a read) — this view renders that as "No events today," not an error.
@MainActor
final class CalendarDayViewModel: ObservableObject {
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

    /// Calendar read failures can contain provider or credential-adjacent detail. The existing
    /// refresh control is the safe recovery path without presenting an unavailable day as empty.
    static func calendarLoadFailureMessage(for _: Error) -> String {
        "Calendar events couldn’t be loaded. Nothing has been changed. Refresh to check today again."
    }

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
        .task { await refreshOnAppear() }
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
    }
}
