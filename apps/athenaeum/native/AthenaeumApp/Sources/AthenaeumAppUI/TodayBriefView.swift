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
    let activeIndexes: [Int]
    let past: [RPCTodayBriefEvent]
    let pastIndexes: [Int]
    let upcoming: [RPCTodayBriefEvent]
    let upcomingIndexes: [Int]
    let next: [RPCTodayBriefEvent]
    let nextIndexes: [Int]
    let later: [RPCTodayBriefEvent]
    let laterIndexes: [Int]

    /// Classifies every server event exactly once. Only a valid half-open interval can
    /// be active. Otherwise the parsed start decides past versus upcoming; a start that
    /// cannot be parsed stays visible in Past rather than being promoted to Up next.
    static func project(_ events: [RPCTodayBriefEvent], now: Date) -> TodayBriefSchedule {
        let timestamp = now.timeIntervalSince1970
        var active: [RPCTodayBriefEvent] = []
        var activeIndexes: [Int] = []
        var past: [RPCTodayBriefEvent] = []
        var pastIndexes: [Int] = []
        var upcoming: [RPCTodayBriefEvent] = []
        var upcomingIndexes: [Int] = []

        for (index, event) in events.enumerated() {
            let start = date(from: event.start.rawValue)?.timeIntervalSince1970
            let end = date(from: event.end.rawValue)?.timeIntervalSince1970
            if let start, let end, start < end, start <= timestamp, timestamp < end {
                active.append(event)
                activeIndexes.append(index)
            } else if let start, start >= timestamp {
                upcoming.append(event)
                upcomingIndexes.append(index)
            } else {
                past.append(event)
                pastIndexes.append(index)
            }
        }

        // Keep the minimum-start ties in source order. Unparseable starts are in Past,
        // so only actual upcoming timestamps can participate in the tie.
        let upcomingWithStart = upcoming.enumerated().compactMap { position, event in
            date(from: event.start.rawValue).map { (upcomingIndexes[position], event, $0.timeIntervalSince1970) }
        }
        let earliest = upcomingWithStart.map(\.2).min()
        let nextIndexes = earliest.map { minimum in
            upcomingWithStart.filter { $0.2 == minimum }.map(\.0)
        } ?? []
        let next = upcoming.enumerated().compactMap { index, event in
            nextIndexes.contains(upcomingIndexes[index]) ? event : nil
        }
        let later = upcoming.enumerated().compactMap { index, event in
            nextIndexes.contains(upcomingIndexes[index]) ? nil : event
        }
        let laterIndexes = upcomingIndexes.filter { !nextIndexes.contains($0) }
        return TodayBriefSchedule(
            active: active,
            activeIndexes: activeIndexes,
            past: past,
            pastIndexes: pastIndexes,
            upcoming: upcoming,
            upcomingIndexes: upcomingIndexes,
            next: next,
            nextIndexes: nextIndexes,
            later: later,
            laterIndexes: laterIndexes
        )
    }

    /// Membership is occurrence-indexed: duplicate provider ids must never collapse.
    func membershipSignature(in events: [RPCTodayBriefEvent]) -> String {
        // The source indexes are carried alongside every bucket, so two identical provider
        // occurrences remain distinct without reconstructing identity from mutable fields.
        _ = events
        func signature(_ indexes: [Int]) -> String { indexes.map(String.init).joined(separator: ",") }
        return "active:\(signature(activeIndexes))|next:\(signature(nextIndexes))|later:\(signature(laterIndexes))|past:\(signature(pastIndexes))"
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

enum TodayBriefSectionKind: String, Equatable, Hashable {
    case active
    case next
    case later
    case earlier
    case schedule
}

struct TodayBriefSectionDescriptor: Identifiable, Equatable {
    let kind: TodayBriefSectionKind
    let label: String
    let count: Int
    let deferred: Bool
    let offersPreparation: Bool

    var id: TodayBriefSectionKind { kind }
}

/// Keeps the current-day brief focused on work that needs attention while preserving every event
/// behind native disclosures. Historical notes intentionally use one unclassified schedule so a
/// past note is never projected through the live clock and mislabeled as "Past".
enum TodayBriefSectionPresentation {
    static func sections(
        isToday: Bool,
        events: [RPCTodayBriefEvent],
        schedule: TodayBriefSchedule?
    ) -> [TodayBriefSectionDescriptor] {
        if !isToday {
            return [
                .init(kind: .schedule, label: "Schedule", count: events.count, deferred: false, offersPreparation: false)
            ]
        }
        guard let schedule else { return [] }
        return [
            .init(kind: .active, label: "Active", count: schedule.active.count, deferred: false, offersPreparation: true),
            .init(kind: .next, label: "Up next", count: schedule.next.count, deferred: false, offersPreparation: true),
            .init(kind: .later, label: "Later", count: schedule.later.count, deferred: true, offersPreparation: true),
            .init(kind: .earlier, label: "Earlier today", count: schedule.past.count, deferred: true, offersPreparation: false)
        ].filter { $0.count > 0 }
    }
}

struct TodayBriefFocusDescriptor: Equatable {
    let kind: TodayBriefSectionKind
    let label: String
    let events: [RPCTodayBriefEvent]
    let sourceIndexes: [Int]
}

/// The collapsed Today brief is deliberately one commitment, not a second agenda. Active
/// occurrences win; otherwise every valid occurrence tied at the earliest upcoming start is kept
/// in source order. Malformed timestamps remain visible only in Full schedule.
enum TodayBriefFocusPresentation {
    static func focus(
        schedule: TodayBriefSchedule,
        events: [RPCTodayBriefEvent]
    ) -> TodayBriefFocusDescriptor? {
        if !schedule.active.isEmpty {
            return .init(kind: .active, label: "Now", events: schedule.active, sourceIndexes: schedule.activeIndexes)
        }

        let validUpcoming = zip(schedule.upcoming, schedule.upcomingIndexes).compactMap { event, sourceIndex -> (event: RPCTodayBriefEvent, sourceIndex: Int, start: TimeInterval)? in
            guard let start = TodayBriefSchedule.date(from: event.start.rawValue)?.timeIntervalSince1970,
                  let end = TodayBriefSchedule.date(from: event.end.rawValue)?.timeIntervalSince1970,
                  start < end else { return nil }
            return (event, sourceIndex, start)
        }
        guard let earliest = validUpcoming.map(\.start).min() else { return nil }
        let focused = validUpcoming.filter { $0.start == earliest }
        _ = events
        return .init(
            kind: .next,
            label: "Up next",
            events: focused.map(\.event),
            sourceIndexes: focused.map(\.sourceIndex)
        )
    }

    static func signature(schedule: TodayBriefSchedule, events: [RPCTodayBriefEvent]) -> String {
        guard let focus = focus(schedule: schedule, events: events) else { return "none" }
        return "\(focus.kind.rawValue):\(focus.sourceIndexes.map(String.init).joined(separator: ","))"
    }

    static func isPreparationEligible(sourceIndex: Int, schedule: TodayBriefSchedule) -> Bool {
        // Preserve the existing live policy: active/upcoming source indexes can be prepared. A
        // malformed future occurrence may still be offered in Full schedule because the server's
        // classifier already placed it in the upcoming bucket; it never affects collapsed focus.
        schedule.activeIndexes.contains(sourceIndex) || schedule.upcomingIndexes.contains(sourceIndex)
    }
}

/// Preparation state belongs to the brief, not to a renderer row. That keeps a meeting's
/// preparing/prepared status intact when Focus swaps for Full schedule and back again.
struct TodayBriefPreparationStore: Equatable {
    let presentationKey: String
    private(set) var inFlightOccurrenceKeys: Set<String> = []
    private(set) var preparedOccurrenceKeys: Set<String> = []
    private(set) var failedOccurrenceKeys: Set<String> = []

    func isPreparing(for occurrenceKey: String) -> Bool { inFlightOccurrenceKeys.contains(occurrenceKey) }
    func isPrepared(for occurrenceKey: String) -> Bool { preparedOccurrenceKeys.contains(occurrenceKey) }
    func didFail(for occurrenceKey: String) -> Bool { failedOccurrenceKeys.contains(occurrenceKey) }

    mutating func begin(for occurrenceKey: String, presentationKey: String) -> Bool {
        guard presentationKey == self.presentationKey,
              !inFlightOccurrenceKeys.contains(occurrenceKey),
              !preparedOccurrenceKeys.contains(occurrenceKey) else { return false }
        inFlightOccurrenceKeys.insert(occurrenceKey)
        failedOccurrenceKeys.remove(occurrenceKey)
        return true
    }

    mutating func complete(
        for occurrenceKey: String,
        succeeded: Bool,
        presentationKey: String
    ) {
        guard presentationKey == self.presentationKey,
              inFlightOccurrenceKeys.contains(occurrenceKey) else { return }
        inFlightOccurrenceKeys.remove(occurrenceKey)
        if succeeded {
            preparedOccurrenceKeys.insert(occurrenceKey)
            failedOccurrenceKeys.remove(occurrenceKey)
        } else {
            failedOccurrenceKeys.insert(occurrenceKey)
        }
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
    /// A brief beside a selected historical note is pinned to that note and must not follow the
    /// current day's event boundaries. Standalone briefs retain the live-day behavior.
    private let tracksLiveDay: Bool
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
        externalPreparer: TodayBriefPreparer? = nil,
        referenceDate: Date? = nil,
        tracksLiveDay: Bool? = nil
    ) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        let client = WorkspaceRPCClient(
            baseURL: workspaceURL,
            workspaceId: workspaceId.rawValue,
            bearerCredential: bearerCredential
        )
        let followsLiveDay = tracksLiveDay ?? (referenceDate == nil)
        self.tracksLiveDay = followsLiveDay
        self.loader = { [client, calendar, now, referenceDate] in
            guard let localDate = Self.requestedLocalDate(referenceDate: referenceDate, now: now(), calendar: calendar) else {
                throw LoaderError.invalidDate
            }
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

    init(loader: @escaping TodayBriefLoader, preparer: @escaping TodayBriefPreparer = { _, _ in throw LoaderError.invalidPreparation }, calendar: Calendar = .current, now: @escaping () -> Date = Date.init, sleeper: @escaping TodayBriefSleeper = defaultTodayBriefSleeper, tracksLiveDay: Bool = true) {
        self.loader = loader
        self.preparer = preparer
        self.calendar = calendar
        self.now = now
        self.sleeper = sleeper
        self.tracksLiveDay = tracksLiveDay
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
        guard isVisible, tracksLiveDay else { return }
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

    nonisolated static func requestedLocalDate(referenceDate: Date?, now: Date, calendar: Calendar) -> String? {
        localDate(from: calendar.dateComponents([.year, .month, .day], from: referenceDate ?? now))
    }

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

    static func progressTitle(isRefreshInFlight: Bool, isToday: Bool = true) -> String {
        let brief = isToday ? "today’s brief" : "daily brief"
        return isRefreshInFlight ? "Refreshing \(brief)…" : "Loading \(brief)…"
    }
}

public struct TodayBriefView: View {
    @StateObject private var model: TodayBriefViewModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var isRefreshInFlight = false
    private let showsToday: Bool
    private let presentationKey: String
    private let onOpenDailyNote: ((LocalDate) -> Void)?
    private let onOpenPerson: ((EntityId) -> Void)?

    public init(
        backendURL: URL,
        workspaceId: EntityId,
        bearerCredential: String?,
        preparer: TodayBriefPreparer? = nil,
        onOpenDailyNote: ((LocalDate) -> Void)? = nil,
        onOpenPerson: ((EntityId) -> Void)? = nil,
        referenceDate: Date? = nil,
        isToday: Bool? = nil,
        presentationKey: String = "today-brief"
    ) {
        let liveDay = isToday ?? (referenceDate == nil)
        self.showsToday = liveDay
        self.presentationKey = presentationKey
        self.onOpenDailyNote = onOpenDailyNote
        self.onOpenPerson = onOpenPerson
        _model = StateObject(
            wrappedValue: TodayBriefViewModel(
                backendURL: backendURL,
                workspaceId: workspaceId,
                bearerCredential: bearerCredential,
                externalPreparer: preparer,
                referenceDate: referenceDate,
                tracksLiveDay: liveDay
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
                    Text(showsToday ? "Today’s brief" : "Daily brief")
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
                .help("Refresh \(showsToday ? "today’s" : "daily") brief")
            }

            switch model.state {
            case .idle, .loading:
                ProgressView(
                    TodayBriefRefreshPresentation.progressTitle(
                        isRefreshInFlight: isRefreshInFlight,
                        isToday: showsToday
                    )
                )
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.updatesFrequently)
            case .failed:
                VStack(alignment: .leading, spacing: 10) {
                    Label(
                        TodayBriefFailurePresentation.title(isToday: showsToday),
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.headline)
                    .foregroundStyle(.primary)
                    Text(TodayBriefFailurePresentation.message(isToday: showsToday))
                        .foregroundStyle(.secondary)
                    Button(
                        isRefreshInFlight
                            ? TodayBriefFailurePresentation.retryingLabel(isToday: showsToday)
                            : TodayBriefFailurePresentation.retryLabel(isToday: showsToday)
                    ) { startRefresh() }
                    .buttonStyle(.borderedProminent)
                    .disabled(isRefreshInFlight)
                    .accessibilityHint(TodayBriefFailurePresentation.retryHint(isToday: showsToday))
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(.orange.opacity(0.35), lineWidth: 1)
                )
                .accessibilityElement(children: .contain)
                .accessibilityLabel(TodayBriefFailurePresentation.accessibilityLabel(isToday: showsToday))
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
                    isToday: showsToday,
                    presentationKey: presentationKey,
                    isPreparationReady: onOpenDailyNote != nil,
                    onOpenPerson: onOpenPerson,
                    onPrepareMeeting: { event in
                        guard await model.prepare(event, in: brief) else { return false }
                        onOpenDailyNote?(brief.localDate)
                        return true
                    }
                )
                .id("\(presentationKey):\(brief.localDate.rawValue):\(showsToday)")
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
    let isToday: Bool
    let presentationKey: String
    let isPreparationReady: Bool
    let onOpenPerson: ((EntityId) -> Void)?
    let onPrepareMeeting: (RPCTodayBriefEvent) async -> Bool
    @State private var isFullScheduleOpen: Bool
    @State private var preparationStore: TodayBriefPreparationStore
    @State private var viewAnnouncement: String?

    init(
        brief: RPCTodayBrief,
        now: Date,
        isToday: Bool,
        presentationKey: String = "today-brief",
        isPreparationReady: Bool,
        onOpenPerson: ((EntityId) -> Void)?,
        onPrepareMeeting: @escaping (RPCTodayBriefEvent) async -> Bool
    ) {
        self.brief = brief
        self.now = now
        self.isToday = isToday
        self.isPreparationReady = isPreparationReady
        self.onOpenPerson = onOpenPerson
        self.onPrepareMeeting = onPrepareMeeting
        let key = "\(presentationKey):\(brief.localDate.rawValue):\(isToday)"
        self.presentationKey = key
        _isFullScheduleOpen = State(initialValue: !isToday)
        _preparationStore = State(initialValue: TodayBriefPreparationStore(presentationKey: key))
        _viewAnnouncement = State(initialValue: nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            let schedule = isToday ? TodayBriefSchedule.project(brief.events, now: now) : nil
            let focus = schedule.flatMap { TodayBriefFocusPresentation.focus(schedule: $0, events: brief.events) }

            if !isToday {
                TodayBriefSection(
                    title: "Schedule",
                    events: brief.events,
                    brief: brief,
                    offersPreparation: false,
                    isPreparationReady: false,
                    onOpenPerson: onOpenPerson,
                    onPrepareMeeting: onPrepareMeeting,
                    sourceIndexes: Array(brief.events.indices),
                    preparationStore: $preparationStore
                )
            } else if brief.events.isEmpty {
                Text("Nothing scheduled in the retained calendar projection. Use your daily note to set priorities.")
                    .foregroundStyle(.secondary)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(isFullScheduleOpen ? "Full schedule" : (focus?.label ?? "Today"))
                        .font(.caption.weight(.semibold))
                        .textCase(.uppercase)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button(isFullScheduleOpen ? "Show focus" : "Full schedule") {
                        let next = !isFullScheduleOpen
                        isFullScheduleOpen = next
                        viewAnnouncement = next ? "Full schedule shown" : "Focused schedule shown"
                    }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .accessibilityLabel(isFullScheduleOpen ? "Show focused schedule" : "Show full schedule")
                    .accessibilityValue(isFullScheduleOpen ? "Expanded" : "Collapsed")
                    .accessibilityHint("Switches between the immediate commitment and every retained event.")
                }
                .accessibilityElement(children: .contain)

                if isFullScheduleOpen {
                    TodayBriefSection(
                        title: "Full schedule",
                        events: brief.events,
                        brief: brief,
                        offersPreparation: true,
                        isPreparationReady: isPreparationReady,
                        onOpenPerson: onOpenPerson,
                        onPrepareMeeting: onPrepareMeeting,
                        sourceIndexes: Array(brief.events.indices),
                        preparationEligibility: { sourceIndex, _ in
                            guard let schedule else { return false }
                            return TodayBriefFocusPresentation.isPreparationEligible(sourceIndex: sourceIndex, schedule: schedule)
                        },
                        preparationStore: $preparationStore
                    )
                } else if let focus {
                    TodayBriefSection(
                        title: focus.label,
                        events: focus.events,
                        brief: brief,
                        offersPreparation: true,
                        isPreparationReady: isPreparationReady,
                        onOpenPerson: onOpenPerson,
                        onPrepareMeeting: onPrepareMeeting,
                        sourceIndexes: focus.sourceIndexes,
                        preparationStore: $preparationStore
                    )
                } else if schedule?.past.isEmpty == false {
                    Text("No more events today. Your schedule is clear.")
                        .foregroundStyle(.secondary)
                } else {
                    Text("No current or upcoming timed events. Open the full schedule to inspect retained entries.")
                        .foregroundStyle(.secondary)
                }
            }

            if let viewAnnouncement {
                Text(viewAnnouncement)
                    .font(.caption)
                    .accessibilityAddTraits(.updatesFrequently)
                    .accessibilityLabel(viewAnnouncement)
                    .frame(width: 1, height: 1)
                    .clipped()
            }

            historyView
        }
    }

    @ViewBuilder
    private var historyView: some View {
        switch TodayBriefHistoryPresentation.make(status: brief.calendarHistory.status) {
        case .warning(let message):
            Label {
                Text(message)
            } icon: {
                Image(systemName: "exclamationmark.triangle")
            }
            .font(.caption)
            .foregroundStyle(.orange)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Calendar history unavailable")
        case .disclosure(let message):
            DisclosureGroup {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } label: {
                Label("Calendar history", systemImage: "clock.arrow.circlepath")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Calendar history")
            .accessibilityValue(message)
        }
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

enum TodayBriefHistoryPresentation: Equatable {
    case disclosure(message: String)
    case warning(message: String)

    static func make(status: RPCTodayBriefHistoryStatus) -> Self {
        let message = TodayBriefHistoryLabel.text(for: status)
        switch status {
        case .unavailable:
            return .warning(message: message)
        case .found, .noneInRetainedData:
            return .disclosure(message: message)
        }
    }
}

/// The brief keeps provider and credential diagnostics in the model, but the native surface
/// presents a stable recovery contract. This mirrors the daily-note warning card so a missing
/// projection reads as a recoverable state rather than a red transport error.
enum TodayBriefFailurePresentation {
    static func title(isToday: Bool) -> String {
        isToday ? "Today’s brief is unavailable" : "Daily brief is unavailable"
    }

    static func message(isToday: Bool) -> String {
        isToday
            ? "We couldn’t resolve today’s calendar context. Retry to load it safely."
            : "We couldn’t resolve this calendar context. Retry to load it safely."
    }

    static func retryLabel(isToday: Bool) -> String {
        isToday ? "Retry today’s brief" : "Retry daily brief"
    }

    static func retryingLabel(isToday: Bool) -> String {
        isToday ? "Retrying today’s brief…" : "Retrying daily brief…"
    }

    static func retryHint(isToday: Bool) -> String {
        isToday ? "Retries loading today’s calendar context." : "Retries loading this calendar context."
    }

    static func accessibilityLabel(isToday: Bool) -> String {
        title(isToday: isToday) + ". " + message(isToday: isToday)
    }
}

private struct TodayBriefSection: View {
    let title: String
    let events: [RPCTodayBriefEvent]
    let brief: RPCTodayBrief
    let offersPreparation: Bool
    let isPreparationReady: Bool
    let onOpenPerson: ((EntityId) -> Void)?
    let onPrepareMeeting: (RPCTodayBriefEvent) async -> Bool
    let showsHeader: Bool
    let sourceIndexes: [Int]
    let preparationEligibility: ((Int, RPCTodayBriefEvent) -> Bool)?
    @Binding var preparationStore: TodayBriefPreparationStore

    init(
        title: String,
        events: [RPCTodayBriefEvent],
        brief: RPCTodayBrief,
        offersPreparation: Bool,
        isPreparationReady: Bool,
        onOpenPerson: ((EntityId) -> Void)?,
        onPrepareMeeting: @escaping (RPCTodayBriefEvent) async -> Bool,
        showsHeader: Bool = true,
        sourceIndexes: [Int] = [],
        preparationEligibility: ((Int, RPCTodayBriefEvent) -> Bool)? = nil,
        preparationStore: Binding<TodayBriefPreparationStore>
    ) {
        self.title = title
        self.events = events
        self.brief = brief
        self.offersPreparation = offersPreparation
        self.isPreparationReady = isPreparationReady
        self.onOpenPerson = onOpenPerson
        self.onPrepareMeeting = onPrepareMeeting
        self.showsHeader = showsHeader
        self.sourceIndexes = sourceIndexes.count == events.count ? sourceIndexes : Array(events.indices)
        self.preparationEligibility = preparationEligibility
        _preparationStore = preparationStore
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsHeader {
                Text(title)
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
            }
            if events.isEmpty {
                Text("No events.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(events.enumerated()), id: \.offset) { position, event in
                    let sourceIndex = sourceIndexes[position]
                    let offersPreparation = self.offersPreparation && (preparationEligibility?(sourceIndex, event) ?? true)
                    TodayBriefEventRow(
                        event: event,
                        sourceIndex: sourceIndex,
                        timeZone: brief.timeZone.rawValue,
                        offersPreparation: offersPreparation,
                        onOpenPerson: onOpenPerson,
                        onPrepareMeeting: isPreparationReady ? { await onPrepareMeeting(event) } : nil,
                        presentationKey: preparationStore.presentationKey,
                        preparationStore: $preparationStore
                    )
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }
}

/// Keeps the server's attendee order while exposing only its safe projection.  The opaque
/// `EntityId` is retained only as a callback value; it is never a visible or accessibility label.
enum TodayBriefPersonNavigationPresentation {
    enum Destination: Equatable {
        case staticText
        case person(EntityId)
    }

    struct Item: Equatable {
        let title: String
        let destination: Destination

        var accessibilityLabel: String? {
            guard case .person = destination else { return nil }
            return "Open \(title)"
        }

        var accessibilityHint: String? {
            guard case .person = destination else { return nil }
            return "Opens this person in the workspace."
        }
    }

    static func items(
        people: [RPCTodayBriefPerson],
        canOpenPerson: Bool
    ) -> [Item] {
        people.compactMap { person in
            switch (person.displayName, person.personNodeId) {
            case let (.some(displayName), .some(personNodeId)) where canOpenPerson:
                return Item(title: displayName, destination: .person(personNodeId))
            case let (.some(displayName), _):
                return Item(title: displayName, destination: .staticText)
            case let (.none, .some(personNodeId)) where canOpenPerson:
                return Item(title: "Person", destination: .person(personNodeId))
            case (.none, .none), (.none, .some):
                return nil
            }
        }
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
    let sourceIndex: Int
    let timeZone: String
    let offersPreparation: Bool
    let onOpenPerson: ((EntityId) -> Void)?
    let onPrepareMeeting: (() async -> Bool)?
    let presentationKey: String
    @Binding var preparationStore: TodayBriefPreparationStore

    var body: some View {
        let occurrenceIdentity = "\(sourceIndex):\(event.occurrenceKey)"
        let people = TodayBriefPersonNavigationPresentation.items(
            people: event.people,
            canOpenPerson: onOpenPerson != nil
        )
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 12) {
                Text(timeLabel)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .frame(width: 72, alignment: .leading)
                Text(event.title).bold()
            }
            .accessibilityElement(children: .combine)

            if !people.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(people.enumerated()), id: \.offset) { _, person in
                        switch person.destination {
                        case .staticText:
                            Text(person.title)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        case .person(let personNodeId):
                            Button(person.title) {
                                onOpenPerson?(personNodeId)
                            }
                            #if os(macOS)
                                .buttonStyle(.link)
                            #else
                                .buttonStyle(.borderless)
                            #endif
                                .font(.caption)
                                .accessibilityLabel(person.accessibilityLabel ?? person.title)
                                .accessibilityHint(person.accessibilityHint ?? "")
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("People")
            }

            if let preparation = TodayBriefPreparationPresentation.action(
                    offersPreparation: offersPreparation,
                    isReady: onPrepareMeeting != nil,
                    isPreparing: preparationStore.isPreparing(for: occurrenceIdentity),
                    isPrepared: preparationStore.isPrepared(for: occurrenceIdentity)
                ) {
                Button(preparation.title) {
                    guard let onPrepareMeeting,
                          preparationStore.begin(for: occurrenceIdentity, presentationKey: presentationKey) else { return }
                    Task { @MainActor in
                        let succeeded = await onPrepareMeeting()
                        preparationStore.complete(
                            for: occurrenceIdentity,
                            succeeded: succeeded,
                            presentationKey: presentationKey
                        )
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
                if preparationStore.didFail(for: occurrenceIdentity) {
                    Text("Couldn’t prepare — try again.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .contain)
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
