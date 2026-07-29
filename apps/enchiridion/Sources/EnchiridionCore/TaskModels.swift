import Foundation

public enum TaskState: String, Codable, CaseIterable, Hashable, Sendable {
  case active
  case completed
  case canceled
}

public enum TaskLifecycleScope: String, Codable, CaseIterable, Hashable, Sendable {
  case active
  case closed

  public func contains(_ state: TaskState) -> Bool {
    switch self {
    case .active:
      state == .active
    case .closed:
      state == .completed || state == .canceled
    }
  }
}

public enum TaskPlacement: String, Codable, CaseIterable, Hashable, Sendable {
  case inbox
  case anytime
  case someday

  public var title: String {
    switch self {
    case .inbox: "Inbox"
    case .anytime: "Anytime"
    case .someday: "Someday"
    }
  }
}

public enum TaskPriority: String, Codable, CaseIterable, Hashable, Sendable, Comparable {
  case none
  case low
  case medium
  case high
  case urgent

  public static func < (lhs: Self, rhs: Self) -> Bool {
    lhs.rank < rhs.rank
  }

  public var title: String {
    rawValue.capitalized
  }

  public var rank: Int {
    switch self {
    case .none: 0
    case .low: 1
    case .medium: 2
    case .high: 3
    case .urgent: 4
    }
  }
}

public enum TaskScheduleGranularity: String, Codable, CaseIterable, Hashable, Sendable {
  case dateOnly = "date-only"
  case dateTime = "date-time"

  public var title: String {
    switch self {
    case .dateOnly: "Date Only"
    case .dateTime: "Date & Time"
    }
  }
}

public enum TaskRecurrenceMode: String, Codable, CaseIterable, Hashable, Sendable {
  case fixedSchedule
  case afterCompletion

  public var title: String {
    switch self {
    case .fixedSchedule: "On schedule"
    case .afterCompletion: "After completion"
    }
  }
}

public enum TaskRecurrenceUnit: String, Codable, CaseIterable, Hashable, Sendable {
  case day
  case week
  case month
  case year

  public var title: String { rawValue.capitalized }
}

public enum TaskWeekday: Int, Codable, CaseIterable, Hashable, Sendable, Comparable {
  case sunday = 1
  case monday
  case tuesday
  case wednesday
  case thursday
  case friday
  case saturday

  public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }

  public var shortTitle: String {
    switch self {
    case .sunday: "Sun"
    case .monday: "Mon"
    case .tuesday: "Tue"
    case .wednesday: "Wed"
    case .thursday: "Thu"
    case .friday: "Fri"
    case .saturday: "Sat"
    }
  }
}

public struct TaskRecurrenceRule: Codable, Hashable, Sendable {
  public var mode: TaskRecurrenceMode
  public var interval: Int
  public var unit: TaskRecurrenceUnit
  public var weekdays: Set<TaskWeekday>
  public var endDate: Date?

  public init(
    mode: TaskRecurrenceMode = .fixedSchedule,
    interval: Int = 1,
    unit: TaskRecurrenceUnit = .week,
    weekdays: Set<TaskWeekday> = [],
    endDate: Date? = nil
  ) {
    self.mode = mode
    self.interval = max(1, interval)
    self.unit = unit
    self.weekdays = weekdays
    self.endDate = endDate
  }

  public func nextDate(
    after date: Date,
    calendar: Calendar = .current
  ) -> Date? {
    TaskTemporalPolicy.nextDate(for: self, after: date, calendar: calendar)
  }
}

public struct TaskRecurrenceTiming: Codable, Hashable, Sendable {
  public var scheduledAt: Date?
  public var scheduleGranularity: TaskScheduleGranularity
  public var deadline: Date?
  public var reminder: Date?

  public init(
    scheduledAt: Date?,
    scheduleGranularity: TaskScheduleGranularity,
    deadline: Date?,
    reminder: Date?
  ) {
    self.scheduledAt = scheduledAt
    self.scheduleGranularity = scheduleGranularity
    self.deadline = deadline
    self.reminder = reminder
  }

  public init(data: TaskData) {
    self.init(
      scheduledAt: data.scheduledAt,
      scheduleGranularity: data.scheduleGranularity,
      deadline: data.deadline,
      reminder: data.reminder
    )
  }
}

/// Provenance shared by an occurrence completed with an after-completion recurrence and the
/// successor generated from that completion. Sync uses this atomic bundle to distinguish
/// completion-derived timing conflicts from ordinary concurrent edits.
public struct TaskCompletionSuccessorGeneration: Codable, Hashable, Sendable {
  public enum Trigger: String, Codable, Hashable, Sendable {
    case afterCompletion = "after-completion"
  }

  public var trigger: Trigger
  public var seriesID: TaskRecurrenceSeriesID
  public var sourceSequence: Int
  public var successorSequence: Int
  public var recurrence: TaskRecurrenceRule
  public var sourceTiming: TaskRecurrenceTiming
  public var completedAt: Date
  public var successorTiming: TaskRecurrenceTiming

  public init(
    trigger: Trigger = .afterCompletion,
    seriesID: TaskRecurrenceSeriesID,
    sourceSequence: Int,
    successorSequence: Int,
    recurrence: TaskRecurrenceRule,
    sourceTiming: TaskRecurrenceTiming,
    completedAt: Date,
    successorTiming: TaskRecurrenceTiming
  ) {
    self.trigger = trigger
    self.seriesID = seriesID
    self.sourceSequence = sourceSequence
    self.successorSequence = successorSequence
    self.recurrence = recurrence
    self.sourceTiming = sourceTiming
    self.completedAt = completedAt
    self.successorTiming = successorTiming
  }
}

public struct TaskTemporalProvenance: Codable, Hashable, Sendable {
  public enum Kind: String, Codable, Hashable, Sendable {
    case completionSuccessor = "completion-successor"
    case manualMutation = "manual-mutation"
  }

  public var kind: Kind
  public var generation: TaskCompletionSuccessorGeneration?

  public init(completionSuccessorGeneration generation: TaskCompletionSuccessorGeneration) {
    kind = .completionSuccessor
    self.generation = generation
  }

  public static var manualMutation: Self {
    Self(kind: .manualMutation, generation: nil)
  }

  private init(kind: Kind, generation: TaskCompletionSuccessorGeneration?) {
    self.kind = kind
    self.generation = generation
  }
}

public struct TaskData: Codable, Hashable, Sendable {
  public var state: TaskState
  public var placement: TaskPlacement
  public var scheduledAt: Date?
  public var scheduleGranularity: TaskScheduleGranularity
  public var deadline: Date?
  public var reminder: Date?
  public var priority: TaskPriority
  public var projectID: PageID?
  public var areaID: PageID?
  public var parentTaskID: PageID?
  public var assigneeIDs: [PageID]
  public var tags: [String]
  public var recurrence: TaskRecurrenceRule?
  public var recurrenceSeriesID: TaskRecurrenceSeriesID?
  public var recurrenceSequence: Int?
  public var completedAt: Date?
  public var temporalProvenance: TaskTemporalProvenance?
  public var estimatedMinutes: Int?

  public var completionSuccessorGeneration: TaskCompletionSuccessorGeneration? {
    get {
      guard temporalProvenance?.kind == .completionSuccessor else { return nil }
      return temporalProvenance?.generation
    }
    set {
      temporalProvenance = newValue.map(
        TaskTemporalProvenance.init(completionSuccessorGeneration:)
      )
    }
  }

  public init(
    state: TaskState = .active,
    placement: TaskPlacement = .inbox,
    scheduledAt: Date? = nil,
    scheduleGranularity: TaskScheduleGranularity = .dateTime,
    deadline: Date? = nil,
    reminder: Date? = nil,
    priority: TaskPriority = .none,
    projectID: PageID? = nil,
    areaID: PageID? = nil,
    parentTaskID: PageID? = nil,
    assigneeIDs: [PageID] = [],
    tags: [String] = [],
    recurrence: TaskRecurrenceRule? = nil,
    recurrenceSeriesID: TaskRecurrenceSeriesID? = nil,
    recurrenceSequence: Int? = nil,
    completedAt: Date? = nil,
    temporalProvenance: TaskTemporalProvenance? = nil,
    estimatedMinutes: Int? = nil
  ) {
    self.state = state
    self.placement = placement
    self.scheduledAt = scheduledAt
    self.scheduleGranularity = scheduleGranularity
    self.deadline = deadline
    self.reminder = reminder
    self.priority = priority
    self.projectID = projectID
    self.areaID = areaID
    self.parentTaskID = parentTaskID
    self.assigneeIDs = Self.normalizedPageIDs(assigneeIDs)
    self.tags = Self.normalizedTags(tags)
    self.recurrence = recurrence
    self.recurrenceSeriesID = recurrenceSeriesID
    self.recurrenceSequence = recurrenceSequence.map { max(0, $0) }
    self.completedAt = completedAt
    self.temporalProvenance = temporalProvenance
    self.estimatedMinutes = estimatedMinutes
  }

  private enum CodingKeys: String, CodingKey {
    case state
    case placement
    case scheduledAt
    case scheduleGranularity
    case deadline
    case reminder
    case priority
    case projectID
    case areaID
    case parentTaskID
    case assigneeIDs
    case tags
    case recurrence
    case recurrenceSeriesID
    case recurrenceSequence
    case completedAt
    case temporalProvenance
    case estimatedMinutes
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      state: try values.decode(TaskState.self, forKey: .state),
      placement: try values.decode(TaskPlacement.self, forKey: .placement),
      scheduledAt: try values.decodeIfPresent(Date.self, forKey: .scheduledAt),
      scheduleGranularity: try values.decodeIfPresent(
        TaskScheduleGranularity.self,
        forKey: .scheduleGranularity
      ) ?? .dateTime,
      deadline: try values.decodeIfPresent(Date.self, forKey: .deadline),
      reminder: try values.decodeIfPresent(Date.self, forKey: .reminder),
      priority: try values.decode(TaskPriority.self, forKey: .priority),
      projectID: try values.decodeIfPresent(PageID.self, forKey: .projectID),
      areaID: try values.decodeIfPresent(PageID.self, forKey: .areaID),
      parentTaskID: try values.decodeIfPresent(PageID.self, forKey: .parentTaskID),
      assigneeIDs: try values.decodeIfPresent([PageID].self, forKey: .assigneeIDs) ?? [],
      tags: try values.decode([String].self, forKey: .tags),
      recurrence: try values.decodeIfPresent(TaskRecurrenceRule.self, forKey: .recurrence),
      recurrenceSeriesID: try values.decodeIfPresent(
        TaskRecurrenceSeriesID.self,
        forKey: .recurrenceSeriesID
      ),
      recurrenceSequence: try values.decodeIfPresent(Int.self, forKey: .recurrenceSequence),
      completedAt: try values.decodeIfPresent(Date.self, forKey: .completedAt),
      temporalProvenance: try values.decodeIfPresent(
        TaskTemporalProvenance.self,
        forKey: .temporalProvenance
      ),
      estimatedMinutes: try values.decodeIfPresent(Int.self, forKey: .estimatedMinutes)
    )
  }

  public var isActive: Bool { state == .active }

  public static func normalizedTags(_ tags: [String]) -> [String] {
    Array(
      Set(
        tags.compactMap { value -> String? in
          let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingPrefix("#")
            .lowercased()
          return normalized.isEmpty ? nil : normalized
        }
      )
    ).sorted()
  }

  public static func normalizedPageIDs(_ pageIDs: [PageID]) -> [PageID] {
    var seen: Set<PageID> = []
    return pageIDs.filter { seen.insert($0).inserted }
  }

  public mutating func setScheduleEnabled(
    _ isEnabled: Bool,
    defaultDate: Date = Date()
  ) {
    scheduledAt = isEnabled ? scheduledAt ?? defaultDate : nil
  }

  public mutating func setDeadlineEnabled(
    _ isEnabled: Bool,
    defaultDate: Date = Date()
  ) {
    deadline = isEnabled ? deadline ?? defaultDate : nil
  }

  public mutating func setReminderEnabled(
    _ isEnabled: Bool,
    defaultDate: Date = Date()
  ) {
    reminder = isEnabled ? reminder ?? defaultDate : nil
  }

  public mutating func setRecurrenceEnabled(_ isEnabled: Bool) {
    recurrence = isEnabled ? recurrence ?? TaskRecurrenceRule() : nil
  }
}

public struct TaskDraft: Codable, Hashable, Sendable {
  public var title: String
  public var notes: String
  public var data: TaskData

  public init(title: String, notes: String = "", data: TaskData = .init()) {
    self.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
    self.notes = notes
    self.data = data
  }
}

public struct TaskItem: Identifiable, Hashable, Sendable {
  public var page: PageSnapshot
  public var data: TaskData
  public var id: PageID { page.id }

  public init?(page: PageSnapshot) {
    guard page.deletedAt == nil, let data = page.taskData else { return nil }
    self.page = page
    self.data = data
  }
}

public struct TaskPageVersion: Codable, Hashable, Sendable {
  public var id: PageID
  public var heads: AutomergeHeads
  public var dirtyGeneration: Int64

  public init(id: PageID, heads: AutomergeHeads, dirtyGeneration: Int64) {
    self.id = id
    self.heads = heads
    self.dirtyGeneration = dirtyGeneration
  }

  public init(_ page: PageSnapshot) {
    self.init(id: page.id, heads: page.heads, dirtyGeneration: page.dirtyGeneration)
  }
}

public struct TaskCreatedSuccessorReceipt: Codable, Hashable, Sendable {
  public var version: TaskPageVersion
  public var seriesID: TaskRecurrenceSeriesID
  public var sequence: Int

  public init(
    version: TaskPageVersion,
    seriesID: TaskRecurrenceSeriesID,
    sequence: Int
  ) {
    self.version = version
    self.seriesID = seriesID
    self.sequence = sequence
  }
}

public struct TaskCompletionUndoReceipt: Codable, Hashable, Sendable {
  public var sourceAfterCompletion: TaskPageVersion
  public var sourceBeforeTaskData: TaskData
  public var createdSuccessor: TaskCreatedSuccessorReceipt?

  public init(
    sourceAfterCompletion: TaskPageVersion,
    sourceBeforeTaskData: TaskData,
    createdSuccessor: TaskCreatedSuccessorReceipt?
  ) {
    self.sourceAfterCompletion = sourceAfterCompletion
    self.sourceBeforeTaskData = sourceBeforeTaskData
    self.createdSuccessor = createdSuccessor
  }
}

public struct TaskCompletionResult: Hashable, Sendable {
  public var completed: PageSnapshot
  public var successor: PageSnapshot?
  public var undoReceipt: TaskCompletionUndoReceipt?

  public init(
    completed: PageSnapshot,
    successor: PageSnapshot?,
    undoReceipt: TaskCompletionUndoReceipt? = nil
  ) {
    self.completed = completed
    self.successor = successor
    self.undoReceipt = undoReceipt
  }

  public var changedPageIDs: [PageID] {
    [completed.id] + (successor.map { [$0.id] } ?? [])
  }
}

public struct TaskCompletionUndoResult: Hashable, Sendable {
  public var reopened: PageSnapshot
  public var removedSuccessorID: PageID?

  public init(reopened: PageSnapshot, removedSuccessorID: PageID?) {
    self.reopened = reopened
    self.removedSuccessorID = removedSuccessorID
  }

  public var changedPageIDs: [PageID] {
    [reopened.id] + (removedSuccessorID.map { [$0] } ?? [])
  }
}

public enum TaskSchedulePatch: Codable, Hashable, Sendable {
  case unchanged
  case clear
  case dateOnly(Date)
  case dateTime(Date)
}

public enum TaskDatePatch: Codable, Hashable, Sendable {
  case unchanged
  case clear
  case set(Date)
}

public enum TaskPageReferencePatch: Codable, Hashable, Sendable {
  case unchanged
  case clear
  case set(PageID)
}

public enum TaskTagCollectionPatch: Codable, Hashable, Sendable {
  case unchanged
  case replace([String])
  case add([String])
  case remove([String])

  fileprivate func applying(to existing: [String]) -> [String] {
    switch self {
    case .unchanged:
      return existing
    case .replace(let tags):
      return TaskData.normalizedTags(tags)
    case .add(let tags):
      return TaskData.normalizedTags(existing + tags)
    case .remove(let tags):
      let removed = Set(TaskData.normalizedTags(tags))
      return existing.filter { !removed.contains($0) }
    }
  }
}

public enum TaskAssigneeCollectionPatch: Codable, Hashable, Sendable {
  case unchanged
  case replace([PageID])
  case add([PageID])
  case remove([PageID])

  fileprivate func applying(to existing: [PageID]) -> [PageID] {
    switch self {
    case .unchanged:
      return existing
    case .replace(let pageIDs):
      return TaskData.normalizedPageIDs(pageIDs)
    case .add(let pageIDs):
      return TaskData.normalizedPageIDs(existing + pageIDs)
    case .remove(let pageIDs):
      let removed = Set(pageIDs)
      return existing.filter { !removed.contains($0) }
    }
  }
}

/// A partial task-data edit used by the atomic Task Workbench APIs.
///
/// Optional scalar values use `nil` to mean "leave unchanged". Reference, date, and collection
/// values have explicit patch enums because clearing, adding or removing, and leaving them
/// unchanged are all meaningful operations. The `tags:` and `assigneeIDs:` initializer arguments
/// remain explicit replacement conveniences for homogeneous selections; mixed selections should
/// use `tagPatch:` and `assigneePatch:` to preserve values that are not visible across every task.
public struct TaskMetadataPatch: Codable, Hashable, Sendable {
  public var schedule: TaskSchedulePatch
  public var deadline: TaskDatePatch
  public var priority: TaskPriority?
  public var placement: TaskPlacement?
  public var project: TaskPageReferencePatch
  public var area: TaskPageReferencePatch
  public var tagPatch: TaskTagCollectionPatch
  public var assigneePatch: TaskAssigneeCollectionPatch

  public var tags: [String]? {
    get {
      guard case .replace(let tags) = tagPatch else { return nil }
      return tags
    }
    set {
      tagPatch = newValue.map(TaskTagCollectionPatch.replace) ?? .unchanged
    }
  }

  public var assigneeIDs: [PageID]? {
    get {
      guard case .replace(let pageIDs) = assigneePatch else { return nil }
      return pageIDs
    }
    set {
      assigneePatch = newValue.map(TaskAssigneeCollectionPatch.replace) ?? .unchanged
    }
  }

  public init(
    schedule: TaskSchedulePatch = .unchanged,
    deadline: TaskDatePatch = .unchanged,
    priority: TaskPriority? = nil,
    placement: TaskPlacement? = nil,
    project: TaskPageReferencePatch = .unchanged,
    area: TaskPageReferencePatch = .unchanged,
    tags: [String]? = nil,
    assigneeIDs: [PageID]? = nil,
    tagPatch: TaskTagCollectionPatch = .unchanged,
    assigneePatch: TaskAssigneeCollectionPatch = .unchanged
  ) {
    self.schedule = schedule
    self.deadline = deadline
    self.priority = priority
    self.placement = placement
    self.project = project
    self.area = area
    self.tagPatch = tags.map(TaskTagCollectionPatch.replace) ?? tagPatch
    self.assigneePatch = assigneeIDs.map(TaskAssigneeCollectionPatch.replace) ?? assigneePatch
  }

  public var isEmpty: Bool {
    schedule == .unchanged
      && deadline == .unchanged
      && priority == nil
      && placement == nil
      && project == .unchanged
      && area == .unchanged
      && tagPatch == .unchanged
      && assigneePatch == .unchanged
  }

  public func applying(to data: TaskData) -> TaskData {
    var updated = data
    switch schedule {
    case .unchanged:
      break
    case .clear:
      updated.scheduledAt = nil
    case .dateOnly(let date):
      updated.scheduledAt = date
      updated.scheduleGranularity = .dateOnly
    case .dateTime(let date):
      updated.scheduledAt = date
      updated.scheduleGranularity = .dateTime
    }
    switch deadline {
    case .unchanged:
      break
    case .clear:
      updated.deadline = nil
    case .set(let date):
      updated.deadline = date
    }
    if let priority { updated.priority = priority }
    if let placement { updated.placement = placement }
    switch project {
    case .unchanged: break
    case .clear: updated.projectID = nil
    case .set(let pageID): updated.projectID = pageID
    }
    switch area {
    case .unchanged: break
    case .clear: updated.areaID = nil
    case .set(let pageID): updated.areaID = pageID
    }
    updated.tags = tagPatch.applying(to: updated.tags)
    updated.assigneeIDs = assigneePatch.applying(to: updated.assigneeIDs)
    return updated
  }
}

public enum TaskBatchOperation: String, Codable, Hashable, Sendable {
  case complete
  case reopen
  case cancel
  case patch
  case trash
}

public struct TaskBatchUndoEntry: Codable, Hashable, Sendable {
  public var operation: TaskBatchOperation
  public var sourceAfterMutation: TaskPageVersion
  public var sourceBeforeTaskData: TaskData
  public var createdSuccessor: TaskCreatedSuccessorReceipt?

  public init(
    operation: TaskBatchOperation,
    sourceAfterMutation: TaskPageVersion,
    sourceBeforeTaskData: TaskData,
    createdSuccessor: TaskCreatedSuccessorReceipt? = nil
  ) {
    self.operation = operation
    self.sourceAfterMutation = sourceAfterMutation
    self.sourceBeforeTaskData = sourceBeforeTaskData
    self.createdSuccessor = createdSuccessor
  }
}

public struct TaskBatchUndoReceipt: Codable, Hashable, Sendable {
  public var entries: [TaskBatchUndoEntry]

  public init(entries: [TaskBatchUndoEntry]) {
    self.entries = entries
  }
}

public struct TaskBatchMutationResult: Hashable, Sendable {
  public var tasks: [PageSnapshot]
  public var createdSuccessors: [PageSnapshot]
  public var undoReceipt: TaskBatchUndoReceipt

  public init(
    tasks: [PageSnapshot],
    createdSuccessors: [PageSnapshot] = [],
    undoReceipt: TaskBatchUndoReceipt
  ) {
    self.tasks = tasks
    self.createdSuccessors = createdSuccessors
    self.undoReceipt = undoReceipt
  }

  public var changedPageIDs: [PageID] {
    tasks.map(\.id) + createdSuccessors.map(\.id)
  }
}

public struct TaskBatchUndoResult: Hashable, Sendable {
  public var restoredTasks: [PageSnapshot]
  public var removedSuccessorIDs: [PageID]

  public init(restoredTasks: [PageSnapshot], removedSuccessorIDs: [PageID] = []) {
    self.restoredTasks = restoredTasks
    self.removedSuccessorIDs = removedSuccessorIDs
  }

  public var changedPageIDs: [PageID] {
    restoredTasks.map(\.id) + removedSuccessorIDs
  }
}

public enum TaskSmartList: String, CaseIterable, Codable, Hashable, Sendable, Identifiable {
  case inbox
  case today
  case upcoming
  case anytime
  case someday
  case review
  case logbook

  public var id: Self { self }

  public var title: String {
    switch self {
    case .inbox: "Inbox"
    case .today: "Today"
    case .upcoming: "Upcoming"
    case .anytime: "Anytime"
    case .someday: "Someday"
    case .review: "Weekly Review"
    case .logbook: "Logbook"
    }
  }

  public var systemImage: String {
    switch self {
    case .inbox: "tray"
    case .today: "star"
    case .upcoming: "calendar"
    case .anytime: "square.stack.3d.up"
    case .someday: "archivebox"
    case .review: "checklist"
    case .logbook: "checkmark.circle"
    }
  }
}

public enum TaskListSelection: Hashable, Sendable, Identifiable {
  case smart(TaskSmartList)
  case project(PageID)
  case area(PageID)
  case person(PageID)
  case tag(String)
  case search(String)

  public var id: String {
    switch self {
    case .smart(let list): "smart:\(list.rawValue)"
    case .project(let id): "project:\(id.rawValue)"
    case .area(let id): "area:\(id.rawValue)"
    case .person(let id): "person:\(id.rawValue)"
    case .tag(let value): "tag:\(value)"
    case .search(let value): "search:\(value)"
    }
  }
}

public enum TaskQuery {
  public static func items(
    from pages: [PageSnapshot],
    selection: TaskListSelection,
    now: Date = Date(),
    calendar: Calendar = .current
  ) -> [TaskItem] {
    let tasks = pages.compactMap(TaskItem.init(page:))
    let filtered = tasks.filter { task in
      let isMatch: Bool
      switch selection {
      case .smart(let list):
        isMatch = matches(task, list: list, now: now, calendar: calendar)
      case .project(let id):
        isMatch = task.data.isActive && task.data.projectID == id
      case .area(let id):
        isMatch = task.data.isActive && task.data.areaID == id
      case .person(let id):
        isMatch = task.data.isActive && task.data.assigneeIDs.contains(id)
      case .tag(let value):
        isMatch = task.data.isActive && task.data.tags.contains(value.lowercased())
      case .search(let query):
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        isMatch =
          task.page.displayTitle.localizedStandardContains(value)
          || task.page.plainText.localizedStandardContains(value)
          || task.data.tags.contains { $0.localizedStandardContains(value) }
      }
      return isMatch
    }
    return filtered.sorted { orderedBefore($0, $1, selection: selection) }
  }

  public static func count(
    _ list: TaskSmartList,
    in pages: [PageSnapshot],
    now: Date = Date(),
    calendar: Calendar = .current
  ) -> Int {
    items(from: pages, selection: .smart(list), now: now, calendar: calendar).count
  }

  /// Active tasks that belong in a daily note's task context.
  ///
  /// When `includingOverdue` is true, tasks scheduled or due before the end of
  /// the selected day are included. This gives the actual Today page the same
  /// carry-forward behavior as the Today smart list. Historical and future
  /// daily notes pass false so only work scheduled or due on that exact day is
  /// shown.
  public static func items(
    from pages: [PageSnapshot],
    on day: Date,
    includingOverdue: Bool,
    calendar: Calendar = .current
  ) -> [TaskItem] {
    guard let interval = calendar.dateInterval(of: .day, for: day) else { return [] }
    return pages.compactMap(TaskItem.init(page:))
      .filter { task in
        guard task.data.isActive else { return false }
        let belongsOnDay: (Date) -> Bool = { date in
          if includingOverdue { return date < interval.end }
          // DateInterval.contains includes its end boundary. Daily buckets are
          // half-open so a date-only task at midnight never leaks into the
          // previous day.
          return date >= interval.start && date < interval.end
        }
        return task.data.scheduledAt.map(belongsOnDay) == true
          || task.data.deadline.map(belongsOnDay) == true
      }
      .sorted { orderedBefore($0, $1, selection: .smart(.today)) }
  }

  private static func matches(
    _ task: TaskItem,
    list: TaskSmartList,
    now: Date,
    calendar: Calendar
  ) -> Bool {
    let day = calendar.dateInterval(of: .day, for: now)
    switch list {
    case .inbox:
      return task.data.isActive && task.data.placement == .inbox
    case .today:
      guard task.data.isActive, let day else { return false }
      return task.data.scheduledAt.map { $0 < day.end } == true
        || task.data.deadline.map { $0 < day.end } == true
    case .upcoming:
      guard task.data.isActive, let day else { return false }
      return task.data.scheduledAt.map { $0 >= day.end } == true
        || task.data.deadline.map { $0 >= day.end } == true
    case .anytime:
      return task.data.isActive
        && task.data.placement == .anytime
        && task.data.scheduledAt == nil
    case .someday:
      return task.data.isActive && task.data.placement == .someday
    case .review:
      return false
    case .logbook:
      return task.data.state != .active
    }
  }

  private static func orderedBefore(
    _ lhs: TaskItem,
    _ rhs: TaskItem,
    selection: TaskListSelection
  ) -> Bool {
    if case .smart(.logbook) = selection {
      return (lhs.data.completedAt ?? lhs.page.modifiedAt)
        > (rhs.data.completedAt ?? rhs.page.modifiedAt)
    }
    if lhs.data.priority != rhs.data.priority { return lhs.data.priority > rhs.data.priority }
    let lhsDate = lhs.data.scheduledAt ?? lhs.data.deadline ?? .distantFuture
    let rhsDate = rhs.data.scheduledAt ?? rhs.data.deadline ?? .distantFuture
    if lhsDate != rhsDate { return lhsDate < rhsDate }
    if lhs.page.createdAt != rhs.page.createdAt { return lhs.page.createdAt < rhs.page.createdAt }
    return lhs.page.displayTitle.localizedStandardCompare(rhs.page.displayTitle)
      == .orderedAscending
  }
}

public enum TaskFields {
  public static let status = key("status")
  public static let placement = key("placement")
  public static let scheduled = key("scheduled")
  public static let scheduleGranularity = key("schedule-granularity")
  public static let deadline = key("deadline")
  public static let reminder = key("reminder")
  public static let priority = key("priority")
  public static let project = key("project")
  public static let area = key("area")
  public static let parent = key("parent")
  public static let assignee = key("assignee")
  public static let tags = key("tags")
  public static let recurrence = key("recurrence")
  public static let recurrenceSeriesID = key("recurrence-series-id")
  public static let recurrenceSequence = key("recurrence-sequence")
  public static let completedAt = key("completed-at")
  public static let temporalProvenance = key("temporal-provenance")
  public static let estimatedMinutes = key("estimated-minutes")
  public static let legacyDue = key("due")

  public static func properties(for data: TaskData) -> [SupertagPropertyKey: [SupertagValue]] {
    var values: [SupertagPropertyKey: [SupertagValue]] = [
      status: [.select(statusValue(data.state))],
      placement: [.select(data.placement.rawValue)],
      tags: data.tags.map(SupertagValue.text),
    ]
    values[scheduled] = data.scheduledAt.map { [.dateTime($0)] } ?? []
    values[scheduleGranularity] = [.select(data.scheduleGranularity.rawValue)]
    values[deadline] = data.deadline.map { [.date($0)] } ?? []
    values[reminder] = data.reminder.map { [.dateTime($0)] } ?? []
    values[priority] = data.priority == .none ? [] : [.select(data.priority.rawValue)]
    values[project] = data.projectID.map { [.page($0)] } ?? []
    values[area] = data.areaID.map { [.page($0)] } ?? []
    values[parent] = data.parentTaskID.map { [.page($0)] } ?? []
    values[assignee] = data.assigneeIDs.map(SupertagValue.page)
    values[completedAt] = data.completedAt.map { [.dateTime($0)] } ?? []
    if let provenance = data.temporalProvenance,
      let encoded = try? JSONEncoder.enchiridion.encode(provenance)
    {
      values[temporalProvenance] = [
        .text(String(decoding: encoded, as: UTF8.self))
      ]
    } else {
      values[temporalProvenance] = []
    }
    values[estimatedMinutes] = data.estimatedMinutes.map { [.number(Double($0))] } ?? []
    values[recurrenceSeriesID] = data.recurrenceSeriesID.map { [.text($0.rawValue)] } ?? []
    values[recurrenceSequence] = data.recurrenceSequence.map { [.number(Double($0))] } ?? []
    if let recurrence = data.recurrence,
      let encoded = try? JSONEncoder.enchiridion.encode(recurrence)
    {
      values[self.recurrence] = [.text(String(decoding: encoded, as: UTF8.self))]
    } else {
      values[self.recurrence] = []
    }
    return values
  }

  private static func key(_ fieldID: String) -> SupertagPropertyKey {
    .init(supertagID: BuiltInSupertags.task, fieldID: .init(rawValue: fieldID))
  }

  private static func statusValue(_ state: TaskState) -> String {
    switch state {
    case .active: "to-do"
    case .completed: "done"
    case .canceled: "cancelled"
    }
  }
}

extension PageSnapshot {
  public var taskData: TaskData? {
    guard hasSupertag(BuiltInSupertags.task) else { return nil }
    let values = objectMetadata.properties
    let rawStatus = values[TaskFields.status]?.first.flatMap(\.selectValue) ?? "to-do"
    let state: TaskState =
      switch rawStatus {
      case "done", "completed": .completed
      case "cancelled", "canceled": .canceled
      default: .active
      }
    let rawPlacement = values[TaskFields.placement]?.first.flatMap(\.selectValue)
    let placement = rawPlacement.flatMap(TaskPlacement.init(rawValue:)) ?? .inbox
    let rawScheduleGranularity = values[TaskFields.scheduleGranularity]?.first.flatMap(
      \.selectValue)
    let scheduleGranularity =
      rawScheduleGranularity.flatMap(TaskScheduleGranularity.init(rawValue:))
      ?? .dateTime
    let rawPriority = values[TaskFields.priority]?.first.flatMap(\.selectValue)
    let priority = rawPriority.flatMap(TaskPriority.init(rawValue:)) ?? .none
    let recurrence = values[TaskFields.recurrence]?.first.flatMap(\.textValue).flatMap { value in
      value.data(using: .utf8).flatMap {
        try? JSONDecoder.enchiridion.decode(TaskRecurrenceRule.self, from: $0)
      }
    }
    return TaskData(
      state: state,
      placement: placement,
      scheduledAt: values[TaskFields.scheduled]?.first.flatMap(\.dateValue)
        ?? values[TaskFields.legacyDue]?.first.flatMap(\.dateValue),
      scheduleGranularity: scheduleGranularity,
      deadline: values[TaskFields.deadline]?.first.flatMap(\.dateValue),
      reminder: values[TaskFields.reminder]?.first.flatMap(\.dateValue),
      priority: priority,
      projectID: values[TaskFields.project]?.first.flatMap(\.pageValue),
      areaID: values[TaskFields.area]?.first.flatMap(\.pageValue),
      parentTaskID: values[TaskFields.parent]?.first.flatMap(\.pageValue),
      assigneeIDs: values[TaskFields.assignee, default: []].compactMap(\.pageValue),
      tags: values[TaskFields.tags, default: []].compactMap(\.textValue),
      recurrence: recurrence,
      recurrenceSeriesID: values[TaskFields.recurrenceSeriesID]?.first.flatMap(\.textValue)
        .map(TaskRecurrenceSeriesID.init(rawValue:)),
      recurrenceSequence: values[TaskFields.recurrenceSequence]?.first.flatMap(\.numberValue)
        .flatMap(Int.init(exactly:)),
      completedAt: values[TaskFields.completedAt]?.first.flatMap(\.dateValue),
      temporalProvenance: values[TaskFields.temporalProvenance]?.first
        .flatMap(\.textValue)
        .flatMap { encoded in
          encoded.data(using: .utf8).flatMap {
            try? JSONDecoder.enchiridion.decode(
              TaskTemporalProvenance.self,
              from: $0
            )
          }
        },
      estimatedMinutes: values[TaskFields.estimatedMinutes]?.first.flatMap(\.numberValue).map(
        Int.init)
    )
  }
}

extension SupertagValue {
  fileprivate var selectValue: String? {
    guard case .select(let value) = self else { return nil }
    return value
  }

  fileprivate var textValue: String? {
    guard case .text(let value) = self else { return nil }
    return value
  }

  fileprivate var dateValue: Date? {
    switch self {
    case .date(let value), .dateTime(let value): value
    default: nil
    }
  }

  fileprivate var pageValue: PageID? {
    guard case .page(let value) = self else { return nil }
    return value
  }

  fileprivate var numberValue: Double? {
    guard case .number(let value) = self else { return nil }
    return value
  }
}

extension String {
  fileprivate func trimmingPrefix(_ prefix: Character) -> String {
    first == prefix ? String(dropFirst()) : self
  }
}
