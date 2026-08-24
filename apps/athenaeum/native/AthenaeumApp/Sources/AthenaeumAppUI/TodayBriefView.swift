import Foundation
import SwiftUI
import AthenaeumDomain
import AthenaeumRPC

/// The native Today Brief renders only the privacy-safe projection returned by
/// `getTodayBrief`. The server owns local-day boundaries, filtering, ordering, and
/// person-name projection; this view does not join raw calendar data or sort events.
@MainActor
final class TodayBriefViewModel: ObservableObject {
    enum State: Equatable {
        case idle
        case loading
        case loaded(RPCTodayBrief)
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    private let client: WorkspaceRPCClient
    private let calendar: Calendar
    private let now: () -> Date

    init(
        backendURL: URL,
        workspaceId: EntityId,
        bearerCredential: String?,
        calendar: Calendar = .current,
        now: @escaping () -> Date = Date.init
    ) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.client = WorkspaceRPCClient(
            baseURL: workspaceURL,
            workspaceId: workspaceId.rawValue,
            bearerCredential: bearerCredential
        )
        self.calendar = calendar
        self.now = now
    }

    func refresh() async {
        state = .loading
        let date = calendar.dateComponents([.year, .month, .day], from: now())
        guard let localDate = Self.localDate(from: date) else {
            state = .failed("Unable to determine today’s local date.")
            return
        }
        let timeZone = calendar.timeZone.identifier

        do {
            state = .loaded(try await client.getTodayBrief(localDate: localDate, timeZone: timeZone))
        } catch {
            state = .failed(Self.safeErrorMessage)
        }
    }

    static func localDate(from components: DateComponents) -> String? {
        guard let year = components.year, let month = components.month, let day = components.day else {
            return nil
        }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    static let safeErrorMessage = "Unable to load today’s brief. Please try again."
}

public struct TodayBriefView: View {
    @StateObject private var model: TodayBriefViewModel

    public init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        _model = StateObject(
            wrappedValue: TodayBriefViewModel(
                backendURL: backendURL,
                workspaceId: workspaceId,
                bearerCredential: bearerCredential
            )
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Daily context")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Today’s brief")
                        .font(.title2.bold())
                }
                Spacer()
                if case .loaded(let brief) = model.state {
                    Text(brief.localDate.rawValue)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }

            switch model.state {
            case .idle, .loading:
                ProgressView("Loading today’s brief…")
                    .frame(maxWidth: .infinity, alignment: .leading)
            case .failed(let message):
                VStack(alignment: .leading, spacing: 8) {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                    Button("Retry") { Task { await model.refresh() } }
                }
            case .loaded(let brief):
                TodayBriefContent(brief: brief)
            }
        }
        .padding()
        .task { await model.refresh() }
    }
}

private struct TodayBriefContent: View {
    let brief: RPCTodayBrief

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(historyLabel)
                .font(.caption)
                .foregroundStyle(.secondary)

            if brief.events.isEmpty {
                Text("Nothing scheduled in the retained calendar projection.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(brief.events, id: \.id) { event in
                    HStack(alignment: .top, spacing: 12) {
                            Text(Self.timeFormatter(timeZone: brief.timeZone.rawValue).string(from: Self.date(from: event.start.rawValue) ?? .distantPast))
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .frame(width: 72, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(event.title).bold()
                            let names = event.people.compactMap(\.displayName).joined(separator: ", ")
                            if !names.isEmpty {
                                Text(names)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    private var historyLabel: String {
        switch brief.calendarHistory.status {
        case .found: return "Calendar history available"
        case .noneInRetainedData: return "No calendar history retained for this day"
        case .unavailable: return "Calendar history unavailable"
        }
    }

    private static func date(from value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? {
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: value)
        }()
    }

    private static func timeFormatter(timeZone identifier: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        formatter.timeZone = TimeZone(identifier: identifier) ?? .current
        return formatter
    }
}
