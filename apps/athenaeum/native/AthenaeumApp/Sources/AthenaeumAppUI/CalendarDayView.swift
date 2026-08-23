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
        let startSortKey: String
    }

    @Published private(set) var events: [EventRow] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private let client: WorkspaceRPCClient

    init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.client = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
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
                        startSortKey: event.start.isoString
                    )
                }
            errorMessage = nil
        } catch {
            errorMessage = "Failed to load calendar events: \(error)"
        }
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

public struct CalendarDayView: View {
    @StateObject private var model: CalendarDayViewModel

    public init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        _model = StateObject(
            wrappedValue: CalendarDayViewModel(backendURL: backendURL, workspaceId: workspaceId, bearerCredential: bearerCredential)
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Today").font(.title2.bold())
                Spacer()
                if model.isLoading {
                    ProgressView().controlSize(.small)
                } else {
                    Button("Refresh") { Task { await model.refresh() } }
                }
            }

            if model.events.isEmpty && !model.isLoading {
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
                    }
                    Spacer()
                    if row.status != "confirmed" {
                        Text(row.status).font(.caption2).foregroundStyle(.orange)
                    }
                }
            }

            if let error = model.errorMessage {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .padding()
        .task { await model.refresh() }
    }
}
