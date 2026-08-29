import Foundation
import SwiftUI
import AthenaeumDomain
import AthenaeumRPC

/// The native Today Brief renders only the privacy-safe projection returned by
/// `getTodayBrief`. The server owns local-day boundaries, filtering, and person-name
/// projection; this view preserves the server order while projecting a local run of show.
typealias TodayBriefLoader = @Sendable () async throws -> RPCTodayBrief
typealias TodayBriefSleeper = @Sendable (TimeInterval) async -> Void
public typealias TodayBriefPreparer = @MainActor @Sendable (RPCTodayBrief, RPCTodayBriefEvent) async throws -> PrepareMeetingInDailyNoteOutput

enum TodayBriefEventState {
    case active
    case past
    case upcoming
}

struct TodayBriefSchedule {
    let active: [RPCTodayBriefEvent]
    let past: [RPCTodayBriefEvent]
    let upcoming: [RPCTodayBriefEvent]
    let next: [RPCTodayBriefEvent]
    let later: [RPCTodayBriefEvent]

    /// Classifies every server event exactly once. Only a valid half-open interval can
    /// be active. Otherwise the parsed start decides past versus upcoming; a start that
    /// cannot be parsed stays visible in Past rather than being promoted to Up next.
    static func project(_ events: [RPCTodayBriefEvent], now: Date) -> TodayBriefSchedule {
        let timestamp = now.timeIntervalSince1970
        var active: [RPCTodayBriefEvent] = []
        var past: [RPCTodayBriefEvent] = []
        var upcoming: [RPCTodayBriefEvent] = []

        for event in events {
            let start = date(from: event.start.rawValue)?.timeIntervalSince1970
            let end = date(from: event.end.rawValue)?.timeIntervalSince1970
            if let start, let end, start < end, start <= timestamp, timestamp < end {
                active.append(event)
            } else if let start, start >= timestamp {
                upcoming.append(event)
            } else {
                past.append(event)
            }
        }

        // Keep the minimum-start ties in source order. Unparseable starts are in Past,
        // so only actual upcoming timestamps can participate in the tie.
        let upcomingWithStart = upcoming.enumerated().compactMap { index, event in
            date(from: event.start.rawValue).map { (index, event, $0.timeIntervalSince1970) }
        }
        let earliest = upcomingWithStart.map(\.2).min()
        let nextIndexes = Set(earliest.map { minimum in
            upcomingWithStart.filter { $0.2 == minimum }.map(\.0)
        } ?? [])
        let next = upcoming.enumerated().compactMap { index, event in
            nextIndexes.contains(index) ? event : nil
        }
        let later = upcoming.enumerated().compactMap { index, event in
            nextIndexes.contains(index) ? nil : event
        }
        return TodayBriefSchedule(active: active, past: past, upcoming: upcoming, next: next, later: later)
    }

    /// Membership is occurrence-indexed: duplicate provider ids must never collapse.
    func membershipSignature(in events: [RPCTodayBriefEvent]) -> String {
        var claimed: Set<Int> = []
        func indexes(_ values: [RPCTodayBriefEvent]) -> String {
            return values.compactMap { value in
                let index = events.indices.first { !claimed.contains($0) && events[$0].id == value.id && events[$0].title == value.title && events[$0].start == value.start && events[$0].end == value.end }
                if let index { claimed.insert(index) }
                return index.map(String.init)
            }.joined(separator: ",")
        }
        return "active:\(indexes(active))|next:\(indexes(next))|later:\(indexes(later))|past:\(indexes(past))"
    }

    static func date(from value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? {
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: value)
        }()
    }
}

@MainActor
final class TodayBriefViewModel: ObservableObject {
    enum State: Equatable {
        case idle
        case loading
        case loaded(RPCTodayBrief)
        case stale(RPCTodayBrief)
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var scheduleAnnouncement: String?
    @Published private(set) var preparationError: String?

    private let loader: TodayBriefLoader
    private let preparer: TodayBriefPreparer
    private let calendar: Calendar
    private let now: () -> Date
    private let sleeper: TodayBriefSleeper
    private var lifecycleTask: Task<Void, Never>?
    private var lifecycleGeneration = 0
    private var isVisible = true
    private var previousScheduleSignature: String?

    init(
        backendURL: URL,
        workspaceId: EntityId,
        bearerCredential: String?,
        calendar: Calendar = .current,
        now: @escaping () -> Date = Date.init,
        sleeper: @escaping TodayBriefSleeper = defaultTodayBriefSleeper,
        externalPreparer: TodayBriefPreparer? = nil
    ) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        let client = WorkspaceRPCClient(
            baseURL: workspaceURL,
            workspaceId: workspaceId.rawValue,
            bearerCredential: bearerCredential
        )
        self.loader = { [client, calendar, now] in
            let date = calendar.dateComponents([.year, .month, .day], from: now())
            guard let localDate = Self.localDate(from: date) else { throw LoaderError.invalidDate }
            return try await client.getTodayBrief(localDate: localDate, timeZone: calendar.timeZone.identifier)
        }
        // Meeting preparation is deliberately not available on a standalone Today Brief. The
        // command center injects the Loro-aware AthenaeumViewModel route; leaving this fallback
        // fail-closed prevents a future surface from mutating a daily note beside its editor.
        self.preparer = externalPreparer ?? { _, _ in throw LoaderError.invalidPreparation }
        self.calendar = calendar
        self.now = now
        self.sleeper = sleeper
    }

    init(loader: @escaping TodayBriefLoader, preparer: @escaping TodayBriefPreparer = { _, _ in throw LoaderError.invalidPreparation }, calendar: Calendar = .current, now: @escaping () -> Date = Date.init, sleeper: @escaping TodayBriefSleeper = defaultTodayBriefSleeper) {
        self.loader = loader
        self.preparer = preparer
        self.calendar = calendar
        self.now = now
        self.sleeper = sleeper
    }

    func refresh() async {
        cancelLifecycle()
        state = .loading
        do {
            let brief = try await loader()
            state = .loaded(brief)
            previousScheduleSignature = Self.scheduleSignature(brief, now: now())
            scheduleAnnouncement = nil
            scheduleLifecycle(for: brief)
        } catch {
            state = .failed(Self.safeErrorMessage)
        }
    }

    func currentDate() -> Date { now() }

    func prepare(_ event: RPCTodayBriefEvent, in brief: RPCTodayBrief) async -> Bool {
        preparationError = nil
        do {
            let output = try await preparer(brief, event)
            guard output.dailyNoteId == dailyNoteIdForLocalDate(brief.localDate),
                  output.localDate == brief.localDate,
                  output.occurrenceKey == event.occurrenceKey else {
                throw LoaderError.invalidPreparation
            }
            return true
        } catch {
            preparationError = "Unable to prepare this meeting. Please try again."
            return false
        }
    }

    func setVisible(_ visible: Bool) {
        isVisible = visible
        guard visible else { cancelLifecycle(); return }
        if case .loaded(let brief) = state { scheduleLifecycle(for: brief) }
    }

    private func scheduleLifecycle(for brief: RPCTodayBrief) {
        cancelLifecycle()
        guard isVisible else { return }
        let current = now()
        guard Self.isCurrent(brief, now: current), let boundary = Self.nextBoundary(brief, now: current, calendar: calendar) else {
            if !Self.isCurrent(brief, now: current) { state = .stale(brief) }
            return
        }
        lifecycleGeneration += 1
        let generation = lifecycleGeneration
        let delay = max(0, boundary.timeIntervalSince(current))
        lifecycleTask = Task { [weak self] in
            guard let self else { return }
            await self.sleeper(delay)
            guard !Task.isCancelled, self.lifecycleGeneration == generation, self.isVisible, case .loaded(let loaded) = self.state else { return }
            let updatedNow = self.now()
            guard Self.isCurrent(loaded, now: updatedNow) else {
                self.cancelLifecycle()
                self.state = .stale(loaded)
                return
            }
            let signature = Self.scheduleSignature(loaded, now: updatedNow)
            if let previous = self.previousScheduleSignature, previous != signature { self.scheduleAnnouncement = "Schedule updated" }
            self.previousScheduleSignature = signature
            self.scheduleLifecycle(for: loaded)
        }
    }

    private func cancelLifecycle() { lifecycleGeneration += 1; lifecycleTask?.cancel(); lifecycleTask = nil }

    static func isCurrent(_ brief: RPCTodayBrief, now: Date) -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: brief.timeZone.rawValue) ?? .current
        return localDate(from: calendar.dateComponents([.year, .month, .day], from: now)) == brief.localDate.rawValue
    }

    static func nextBoundary(_ brief: RPCTodayBrief, now: Date, calendar sourceCalendar: Calendar) -> Date? {
        guard isCurrent(brief, now: now) else { return nil }
        var calendar = sourceCalendar
        calendar.timeZone = TimeZone(identifier: brief.timeZone.rawValue) ?? sourceCalendar.timeZone
        let eventBoundaries = brief.events.flatMap { [TodayBriefSchedule.date(from: $0.start.rawValue), TodayBriefSchedule.date(from: $0.end.rawValue)] }.compactMap { $0 }.filter { $0 > now }
        guard let midnight = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) else { return eventBoundaries.min() }
        return (eventBoundaries + [midnight]).min()
    }

    static func scheduleSignature(_ brief: RPCTodayBrief, now: Date) -> String { TodayBriefSchedule.project(brief.events, now: now).membershipSignature(in: brief.events) }

    private enum LoaderError: Error { case invalidDate, invalidPreparation }

    nonisolated static func localDate(from components: DateComponents) -> String? {
        guard let year = components.year, let month = components.month, let day = components.day else {
            return nil
        }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    static let safeErrorMessage = "Unable to load today’s brief. Please try again."
}

private let defaultTodayBriefSleeper: TodayBriefSleeper = { delay in
    try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
}

enum TodayBriefRefreshPresentation {
    static func canStartRefresh(isRefreshInFlight: Bool) -> Bool {
        !isRefreshInFlight
    }

    static func actionTitle(isRefreshing: Bool) -> String {
        isRefreshing ? "Refreshing…" : "Refresh"
    }

    static func progressTitle(isRefreshInFlight: Bool) -> String {
        isRefreshInFlight ? "Refreshing today’s brief…" : "Loading today’s brief…"
    }
}

public struct TodayBriefView: View {
    @StateObject private var model: TodayBriefViewModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var isRefreshInFlight = false
    private let onOpenDailyNote: ((LocalDate) -> Void)?

    public init(
        backendURL: URL,
        workspaceId: EntityId,
        bearerCredential: String?,
        preparer: TodayBriefPreparer? = nil,
        onOpenDailyNote: ((LocalDate) -> Void)? = nil
    ) {
        self.onOpenDailyNote = onOpenDailyNote
        _model = StateObject(
            wrappedValue: TodayBriefViewModel(
                backendURL: backendURL,
                workspaceId: workspaceId,
                bearerCredential: bearerCredential,
                externalPreparer: preparer
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
                Button {
                    startRefresh()
                } label: {
                    Label(
                        TodayBriefRefreshPresentation.actionTitle(isRefreshing: isRefreshing),
                        systemImage: "arrow.clockwise"
                    )
                }
                .buttonStyle(.borderless)
                .disabled(isRefreshing)
                .help("Refresh today’s brief")
            }

            switch model.state {
            case .idle, .loading:
                ProgressView(
                    TodayBriefRefreshPresentation.progressTitle(
                        isRefreshInFlight: isRefreshInFlight
                    )
                )
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.updatesFrequently)
            case .failed(let message):
                VStack(alignment: .leading, spacing: 8) {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityAddTraits(.isStaticText)
                    Button(isRefreshInFlight ? "Retrying…" : "Retry") { startRefresh() }
                        .disabled(isRefreshInFlight)
                }
                .accessibilityElement(children: .contain)
            case .stale:
                VStack(alignment: .leading, spacing: 8) {
                    Text("This brief is no longer current. Refresh to load today’s brief.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button(
                        TodayBriefRefreshPresentation.actionTitle(isRefreshing: isRefreshInFlight)
                    ) { startRefresh() }
                    .disabled(isRefreshInFlight)
                }
                .accessibilityElement(children: .contain)
            case .loaded(let brief):
                TodayBriefContent(
                    brief: brief,
                    now: model.currentDate(),
                    isPreparationReady: onOpenDailyNote != nil,
                    onPrepareMeeting: { event in
                        guard await model.prepare(event, in: brief) else { return false }
                        onOpenDailyNote?(brief.localDate)
                        return true
                    }
                )
            }
            if let preparationError = model.preparationError {
                Text(preparationError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            if let announcement = model.scheduleAnnouncement {
                Text(announcement)
                    .accessibilityAddTraits(.updatesFrequently)
                    .accessibilityLabel(announcement)
            }
        }
        .padding()
        .task { await refreshOnAppear() }
        .onChange(of: scenePhase) { phase in model.setVisible(phase == .active) }
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
        guard TodayBriefRefreshPresentation.canStartRefresh(isRefreshInFlight: isRefreshInFlight) else {
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

private struct TodayBriefContent: View {
    let brief: RPCTodayBrief
    let now: Date
    let isPreparationReady: Bool
    let onPrepareMeeting: (RPCTodayBriefEvent) async -> Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(historyLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Calendar history")

            if brief.events.isEmpty {
                Text("Nothing scheduled in the retained calendar projection.")
                    .foregroundStyle(.secondary)
            } else {
                let schedule = TodayBriefSchedule.project(brief.events, now: now)
                TodayBriefSection(title: "Active", events: schedule.active, brief: brief, offersPreparation: true, isPreparationReady: isPreparationReady, onPrepareMeeting: onPrepareMeeting)
                TodayBriefSection(title: "Up next", events: schedule.next, brief: brief, offersPreparation: true, isPreparationReady: isPreparationReady, onPrepareMeeting: onPrepareMeeting)
                TodayBriefSection(title: "Later", events: schedule.later, brief: brief, offersPreparation: true, isPreparationReady: isPreparationReady, onPrepareMeeting: onPrepareMeeting)
                TodayBriefSection(title: "Past", events: schedule.past, brief: brief, offersPreparation: false, isPreparationReady: false, onPrepareMeeting: onPrepareMeeting)
            }
        }
    }

    private var historyLabel: String {
        TodayBriefHistoryLabel.text(for: brief.calendarHistory.status)
    }

}

enum TodayBriefHistoryLabel {
    static func text(for status: RPCTodayBriefHistoryStatus) -> String {
        switch status {
        case .found: return "Calendar history available"
        case .noneInRetainedData: return "No calendar history retained for this day"
        case .unavailable: return "Calendar history unavailable"
        }
    }
}

private struct TodayBriefSection: View {
    let title: String
    let events: [RPCTodayBriefEvent]
    let brief: RPCTodayBrief
    let offersPreparation: Bool
    let isPreparationReady: Bool
    let onPrepareMeeting: (RPCTodayBriefEvent) async -> Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            if events.isEmpty {
                Text("No events.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                    TodayBriefEventRow(
                        event: event,
                        timeZone: brief.timeZone.rawValue,
                        offersPreparation: offersPreparation,
                        onPrepareMeeting: isPreparationReady ? { await onPrepareMeeting(event) } : nil
                    )
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }
}

enum TodayBriefPreparationPresentation {
    struct Action: Equatable {
        let title: String
        let isDisabled: Bool
        let readinessMessage: String?
        let accessibilityHint: String
    }

    static func action(
        offersPreparation: Bool,
        isReady: Bool,
        isPreparing: Bool,
        isPrepared: Bool
    ) -> Action? {
        guard offersPreparation else { return nil }
        if isPreparing {
            return Action(
                title: "Preparing…",
                isDisabled: true,
                readinessMessage: nil,
                accessibilityHint: "Prepares this meeting in its daily note"
            )
        }
        if isPrepared {
            return Action(
                title: "Prepared in daily note",
                isDisabled: true,
                readinessMessage: "This meeting is already prepared in its daily note.",
                accessibilityHint: "This meeting is already prepared in its daily note."
            )
        }
        if isReady {
            return Action(
                title: "Prepare in daily note",
                isDisabled: false,
                readinessMessage: nil,
                accessibilityHint: "Prepares this meeting in its daily note"
            )
        }
        return Action(
            title: "Daily note not ready",
            isDisabled: true,
            readinessMessage: "This daily note is not ready for meeting preparation.",
            accessibilityHint: "This daily note is not ready for meeting preparation."
        )
    }

    static func canStartPreparation(isPreparing: Bool, isPrepared: Bool) -> Bool {
        !isPreparing && !isPrepared
    }
}

struct TodayBriefPreparationState: Equatable {
    private(set) var inFlightOccurrenceKey: String?
    private(set) var preparedOccurrenceKey: String?

    var isPreparing: Bool {
        inFlightOccurrenceKey != nil
    }

    func isPrepared(for occurrenceKey: String) -> Bool {
        preparedOccurrenceKey == occurrenceKey
    }

    mutating func begin(for occurrenceKey: String) -> Bool {
        guard inFlightOccurrenceKey == nil, !isPrepared(for: occurrenceKey) else {
            return false
        }
        inFlightOccurrenceKey = occurrenceKey
        return true
    }

    mutating func complete(for occurrenceKey: String, succeeded: Bool) {
        guard inFlightOccurrenceKey == occurrenceKey else { return }
        inFlightOccurrenceKey = nil
        if succeeded {
            preparedOccurrenceKey = occurrenceKey
        }
    }
}

private struct TodayBriefEventRow: View {
    let event: RPCTodayBriefEvent
    let timeZone: String
    let offersPreparation: Bool
    let onPrepareMeeting: (() async -> Bool)?
    @State private var preparationState = TodayBriefPreparationState()

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(timeLabel)
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
                if let preparation = TodayBriefPreparationPresentation.action(
                    offersPreparation: offersPreparation,
                    isReady: onPrepareMeeting != nil,
                    isPreparing: preparationState.isPreparing,
                    isPrepared: preparationState.isPrepared(for: event.occurrenceKey)
                ) {
                    Button(preparation.title) {
                        let occurrenceKey = event.occurrenceKey
                        guard let onPrepareMeeting, preparationState.begin(for: occurrenceKey) else { return }
                        Task { @MainActor in
                            let succeeded = await onPrepareMeeting()
                            preparationState.complete(for: occurrenceKey, succeeded: succeeded)
                        }
                    }
                    #if os(macOS)
                        .buttonStyle(.link)
                    #else
                        .buttonStyle(.borderless)
                    #endif
                        .font(.caption)
                        .disabled(preparation.isDisabled)
                        .accessibilityHint(preparation.accessibilityHint)
                    if let readinessMessage = preparation.readinessMessage {
                        Text(readinessMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var timeLabel: String {
        guard let start = Self.date(from: event.start.rawValue) else { return "Time unavailable" }
        return Self.timeFormatter(timeZone: timeZone).string(from: start)
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
