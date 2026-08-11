// TaskBrowserModels.swift
// EnchiridionUI
//
// Task #82 (plan §"Core Product UI (P7)", track 3: "Task list + kanban").
// Pure, SwiftUI-free domain types for the task list/kanban screens:
// `TaskListItem` (one Task-supertagged page, decoded from the local
// projection — see `TaskBrowserQuery.swift`) and `TaskBoardColumn` (the
// kanban column vocabulary + the deterministic column<->task mapping in
// both directions). Kept separate from the query/write/view files so the
// column-assignment and move-mutation logic — the part with real behavior
// worth testing precisely — has no SwiftUI or GRDB dependency at all.
//
// *** WHY A NEW COLUMN VOCABULARY, NOT A DIRECT REUSE OF
// `AssistantTaskScope` OR `CoreTaskPlacement` ***
//
// The task brief explicitly allows either "reusing the scope groupings" or
// landing on a new mapping, as long as it's documented. Neither existing
// vocabulary fits a kanban board's requirement of exactly one column per
// task unchanged:
//   - `EnchiridionCore.AssistantTaskScope` (7 scopes + `.all`) is a set of
//     independent, overlapping SEARCH filters for the assistant's
//     `searchTasks` tool — a task can legitimately match more than one
//     scope in the same turn (e.g. `.today` and `.all`), which is fine for
//     "answer a spoken question" but wrong for "assign this card to
//     exactly one column." It also has `.tomorrow` and `.logbook`/`.all`,
//     which don't correspond to anything a kanban board needs as a
//     distinct lane.
//   - `EnchiridionSchema.CoreTaskPlacement` (the raw supertag field) has
//     only 3 cases (`inbox`/`anytime`/`someday`) and carries no completion
//     or date information at all — a `.anytime`-placed task that's already
//     `done`, or one that's been scheduled for today, would show in the
//     wrong (or no) lane if columns were a raw 1:1 mirror of this field.
//
// `TaskBoardColumn` below is therefore a NEW six-case enum
// (inbox/today/upcoming/anytime/someday/done) that reuses
// `AssistantTaskScope`'s *semantics* for the four columns that overlap
// (`.today`/`.upcoming`/`.anytime`/`.someday`/`.inbox` — same date/placement
// logic as `EnchiridionStore/AssistantReadTools.swift`'s
// `taskMatches(scope:row:today:calendar:)`, not reinvented), collapses
// `AssistantTaskScope`'s `.logbook` into one `.done` column (a kanban
// board's natural "finished" lane, covering both `.done` and `.cancelled`
// task status — matching `TaskListItem.isActive`'s existing
// done-or-cancelled-counts-as-inactive convention), and drops
// `.tomorrow`/`.all` (neither is a lane a card can sit in on its own).
//
// *** COLUMN <-> TASK ASSIGNMENT (READ DIRECTION): `assigned(to:today:calendar:)` ***
//
// Exactly one column per task, by precedence (matches
// `AssistantReadTools.taskMatches`'s own per-scope date/placement checks,
// just resolved to a single winner instead of an independent yes/no per
// scope):
//   1. `status` is `.done`/`.cancelled` (task is not "active") -> `.done`,
//      unconditionally — a finished task shows as finished regardless of
//      whatever stale `scheduled`/`deadline`/`placement` value it still
//      carries from before it was completed.
//   2. Active AND (`scheduled` or `deadline` is today-or-earlier) -> `.today`.
//   3. Active AND (`scheduled` or `deadline` is after today) -> `.upcoming`.
//   4. Otherwise, `placement` decides directly: `.inbox`/`.someday` map
//      1:1; `.anytime` (and, permissively, no placement at all — a task
//      created by a path that hasn't set one yet) both fall to `.anytime`.
//
// *** COLUMN -> WRITE MAPPING (DRAG DIRECTION): `propertyUpdates(now:calendar:currentStatus:) ***
//
// A drag-and-drop move into a column writes exactly the fields that make
// `assigned(to:today:calendar:)` resolve the moved task back into that same
// column next time it's read — so the board is never "lying" about where a
// card visually is right after a drop:
//   - `.today`: sets `scheduled` to the start of today, clears `deadline`
//     (a stale future/overdue deadline would otherwise outrank the new
//     `scheduled` value in the read-direction precedence above and put the
//     card back in the wrong lane).
//   - `.upcoming`: sets `scheduled` to the start of tomorrow (the nearest
//     day that still reads as "upcoming," in the absence of a real
//     date-picker UI on the card itself — a defensible default, not a
//     precise date choice), clears `deadline` for the same reason as
//     `.today`.
//   - `.inbox`/`.anytime`/`.someday`: sets `placement` to the matching
//     `CoreTaskPlacement` case, clears BOTH `scheduled` and `deadline` (so
//     the task doesn't stay pinned to `.today`/`.upcoming` by a leftover
//     date despite the user visibly moving it to a placement-only lane).
//   - `.done`: sets `status = .done` and `completedAt = now`.
//   - Moving OUT of `.done` into any other column (i.e. `currentStatus` was
//     `.done`/`.cancelled`) additionally resets `status` back to `.toDo`
//     and clears `completedAt` — otherwise rule 1 above would keep
//     resolving the card back into `.done` no matter which other column it
//     was just dropped into.
//
// Clearing a field uses the empty-array convention
// `EnchiridionSync.AssistantTaskMutationApplier.propertyUpdates` already
// establishes for optional properties (`notes.isEmpty ? [] : [.text(notes)]`)
// — an empty `[SupertagValue]` for a key removes that property.

import EnchiridionCore
import EnchiridionSchema
import Foundation

/// One Task-supertagged page, decoded from the local graph projection —
/// see `LocalGraphStore.fetchAllTasks(now:calendar:)` in
/// `TaskBrowserQuery.swift` for the query that produces these.
public struct TaskListItem: Identifiable, Hashable, Sendable {
  public var pageID: PageID
  public var title: String
  public var status: CoreTaskStatus?
  public var placement: CoreTaskPlacement?
  public var priority: CoreTaskPriority?
  public var scheduledAt: Date?
  public var deadlineAt: Date?
  public var dueAt: Date?
  public var completedAt: Date?
  public var modifiedAt: Date?

  public var id: PageID { pageID }

  /// Matches `EnchiridionStore/AssistantReadTools.swift`'s
  /// `TaskRow.isActive` exactly: a task with no `status` fact at all
  /// (shouldn't normally happen, but handled the same permissive way the
  /// assistant's own read tool does) counts as active.
  public var isActive: Bool { status != .done && status != .cancelled }

  public init(
    pageID: PageID,
    title: String,
    status: CoreTaskStatus?,
    placement: CoreTaskPlacement?,
    priority: CoreTaskPriority?,
    scheduledAt: Date?,
    deadlineAt: Date?,
    dueAt: Date?,
    completedAt: Date?,
    modifiedAt: Date?
  ) {
    self.pageID = pageID
    self.title = title
    self.status = status
    self.placement = placement
    self.priority = priority
    self.scheduledAt = scheduledAt
    self.deadlineAt = deadlineAt
    self.dueAt = dueAt
    self.completedAt = completedAt
    self.modifiedAt = modifiedAt
  }
}

/// The task board's six kanban lanes. See this file's header for why these
/// six (not a direct reuse of `AssistantTaskScope` or `CoreTaskPlacement`)
/// and the full read/write mapping rationale.
public enum TaskBoardColumn: String, CaseIterable, Identifiable, Hashable, Sendable {
  case inbox
  case today
  case upcoming
  case anytime
  case someday
  case done

  public var id: String { rawValue }

  public var displayName: String {
    switch self {
    case .inbox: "Inbox"
    case .today: "Today"
    case .upcoming: "Upcoming"
    case .anytime: "Anytime"
    case .someday: "Someday"
    case .done: "Done"
    }
  }

  /// Read direction: which single column `item` belongs in right now. See
  /// this file's header, "COLUMN <-> TASK ASSIGNMENT (READ DIRECTION)."
  public static func assigned(to item: TaskListItem, today: Date, calendar: Calendar) -> TaskBoardColumn {
    guard item.isActive else { return .done }
    if let scheduled = item.scheduledAt, calendar.startOfDay(for: scheduled) <= today { return .today }
    if let deadline = item.deadlineAt, calendar.startOfDay(for: deadline) <= today { return .today }
    if let scheduled = item.scheduledAt, calendar.startOfDay(for: scheduled) > today { return .upcoming }
    if let deadline = item.deadlineAt, calendar.startOfDay(for: deadline) > today { return .upcoming }
    switch item.placement {
    case .inbox: return .inbox
    case .someday: return .someday
    case .anytime, nil: return .anytime
    }
  }

  /// Write direction: the property updates a drag-and-drop move into this
  /// column performs. See this file's header, "COLUMN -> WRITE MAPPING
  /// (DRAG DIRECTION)." `currentStatus` is the task's status BEFORE the
  /// move, needed only to decide whether moving out of `.done` must also
  /// reset `status`/`completedAt`.
  public func propertyUpdates(
    now: Date, calendar: Calendar, currentStatus: CoreTaskStatus?
  ) -> [SupertagPropertyKey: [SupertagValue]] {
    var updates: [SupertagPropertyKey: [SupertagValue]] = [:]
    let wasFinished = currentStatus == .done || currentStatus == .cancelled

    func resetFinishedStatusIfNeeded() {
      guard wasFinished else { return }
      updates[Self.key(CoreTaskFieldIDs.status)] = [.select(CoreTaskStatus.toDo.rawValue)]
      updates[Self.key(CoreTaskFieldIDs.completedAt)] = []
    }

    switch self {
    case .today:
      updates[Self.key(CoreTaskFieldIDs.scheduled)] = [.dateTime(calendar.startOfDay(for: now))]
      updates[Self.key(CoreTaskFieldIDs.deadline)] = []
      resetFinishedStatusIfNeeded()
    case .upcoming:
      let startOfToday = calendar.startOfDay(for: now)
      let tomorrow = calendar.date(byAdding: .day, value: 1, to: startOfToday) ?? startOfToday
      updates[Self.key(CoreTaskFieldIDs.scheduled)] = [.dateTime(tomorrow)]
      updates[Self.key(CoreTaskFieldIDs.deadline)] = []
      resetFinishedStatusIfNeeded()
    case .inbox:
      updates[Self.key(CoreTaskFieldIDs.placement)] = [.select(CoreTaskPlacement.inbox.rawValue)]
      updates[Self.key(CoreTaskFieldIDs.scheduled)] = []
      updates[Self.key(CoreTaskFieldIDs.deadline)] = []
      resetFinishedStatusIfNeeded()
    case .anytime:
      updates[Self.key(CoreTaskFieldIDs.placement)] = [.select(CoreTaskPlacement.anytime.rawValue)]
      updates[Self.key(CoreTaskFieldIDs.scheduled)] = []
      updates[Self.key(CoreTaskFieldIDs.deadline)] = []
      resetFinishedStatusIfNeeded()
    case .someday:
      updates[Self.key(CoreTaskFieldIDs.placement)] = [.select(CoreTaskPlacement.someday.rawValue)]
      updates[Self.key(CoreTaskFieldIDs.scheduled)] = []
      updates[Self.key(CoreTaskFieldIDs.deadline)] = []
      resetFinishedStatusIfNeeded()
    case .done:
      updates[Self.key(CoreTaskFieldIDs.status)] = [.select(CoreTaskStatus.done.rawValue)]
      updates[Self.key(CoreTaskFieldIDs.completedAt)] = [.dateTime(now)]
    }
    return updates
  }

  private static func key(_ fieldID: SupertagFieldID) -> SupertagPropertyKey {
    SupertagPropertyKey(supertagID: CoreTaskFieldIDs.supertagID, fieldID: fieldID)
  }
}
