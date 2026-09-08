import Foundation
import AthenaeumCore
import AthenaeumDomain

/// The identity/session pair for one daily note. A session belongs to a node for the lifetime of
/// the view model; navigating away must not make a second session for a date we have already seen.
struct DailyNoteSelection {
    let date: Date
    let nodeId: EntityId
    let title: String
    let session: SyncSessionHandle
    let generation: Int
}

/// Records a navigation-away intent while the departing note's local commit is still in flight.
/// A successful commit can schedule a debounce as part of its completion, so the intent remains
/// active until the selection actually changes; that closes the cancellation-after-commit race.
struct DailyNoteNavigationIntent {
    private(set) var departingNodeId: String? = nil

    mutating func begin(departingNodeId: String) {
        self.departingNodeId = departingNodeId
    }

    func suppressesSync(for nodeId: String) -> Bool {
        departingNodeId == nodeId
    }

    mutating func cancel() {
        departingNodeId = nil
    }
}

/// Pure selection state for the native daily-note surface. Keeping this separate from the network
/// loader makes the two important invariants directly testable: civil-day identity is deterministic
/// and A → B → A reuses the same two session handles.
struct DailyNoteNavigator {
    let calendar: Calendar
    private(set) var selectedDate: Date
    private(set) var generation = 0
    private var sessions: [String: SyncSessionHandle] = [:]

    init(date: Date = Date(), calendar: Calendar = .current) {
        self.calendar = calendar
        self.selectedDate = calendar.startOfDay(for: date)
    }

    mutating func currentSelection() -> DailyNoteSelection {
        selection(for: selectedDate, generation: generation)
    }

    mutating func request(date: Date) -> DailyNoteSelection {
        selectedDate = calendar.startOfDay(for: date)
        generation += 1
        return selection(for: selectedDate, generation: generation)
    }

    func isCurrent(_ selection: DailyNoteSelection, activeNodeId: EntityId) -> Bool {
        selection.generation == generation && selection.nodeId == activeNodeId
    }

    func isLatest(_ selection: DailyNoteSelection) -> Bool {
        selection.generation == generation
            && selection.nodeId == dailyNoteIdForDate(selectedDate, calendar: calendar)
    }

    private mutating func selection(for date: Date, generation: Int) -> DailyNoteSelection {
        let nodeId = dailyNoteIdForDate(date, calendar: calendar)
        let session = sessions[nodeId.rawValue] ?? {
            let fresh = SyncSessionHandle()
            sessions[nodeId.rawValue] = fresh
            return fresh
        }()
        return DailyNoteSelection(
            date: date,
            nodeId: nodeId,
            title: dailyNoteTitleForDate(date, calendar: calendar),
            session: session,
            generation: generation
        )
    }
}

/// Serializes local page commits without making a failed commit disappear behind navigation. Once
/// one commit fails, dependent edits stay blocked until the caller explicitly clears the queue
/// after reloading the durable snapshot; this prevents a later optimistic edit from masking the
/// failed write that a navigation boundary must surface.
struct DailyNoteCommitQueue {
    private(set) var tail: Task<Bool, Never>?

    var pending: Task<Bool, Never>? { tail }

    mutating func enqueue(_ operation: @escaping @MainActor () async -> Bool) -> Task<Bool, Never> {
        let previous = tail
        let next = Task<Bool, Never> { @MainActor in
            let previousSucceeded = await previous?.value ?? true
            guard previousSucceeded else { return false }
            return await operation()
        }
        tail = next
        return next
    }

    mutating func cancel() {
        tail?.cancel()
    }

    mutating func clear() {
        tail = nil
    }
}
