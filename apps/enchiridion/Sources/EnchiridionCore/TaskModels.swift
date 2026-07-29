import Foundation

public enum TaskState: String, Codable, CaseIterable, Hashable, Sendable {
  case active
  case completed
  case canceled
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
    let candidate: Date?
    if !weekdays.isEmpty {
      candidate = nextSelectedWeekday(after: date, calendar: calendar)
    } else {
      let component: Calendar.Component = switch unit {
      case .day: .day
      case .week: .weekOfYear
      case .month: .month
      case .year: .year
      }
      candidate = calendar.date(byAdding: component, value: interval, to: date)
    }
    guard let candidate, endDate.map({ candidate <= $0 }) ?? true else { return nil }
    return candidate
  }

  private func nextSelectedWeekday(after date: Date, calendar: Calendar) -> Date? {
    let start = calendar.startOfDay(for: date)
    let currentWeek = calendar.dateInterval(of: .weekOfYear, for: start)?.start ?? start
    let allowed = Set(weekdays.map(\.rawValue))
    let maximumDays = max(14, interval * 7 + 7)
    for offset in 1...maximumDays {
      guard let candidate = calendar.date(byAdding: .day, value: offset, to: start) else { continue }
      guard allowed.contains(calendar.component(.weekday, from: candidate)) else { continue }
      let candidateWeek = calendar.dateInterval(of: .weekOfYear, for: candidate)?.start ?? candidate
      let weeks = calendar.dateComponents([.weekOfYear], from: currentWeek, to: candidateWeek).weekOfYear ?? 0
      if weeks % interval == 0 { return candidate }
    }
    return nil
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
  public var estimatedMinutes: Int?

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

public struct TaskCompletionResult: Hashable, Sendable {
  public var completed: PageSnapshot
  public var successor: PageSnapshot?

  public init(completed: PageSnapshot, successor: PageSnapshot?) {
    self.completed = completed
    self.successor = successor
  }

  public var changedPageIDs: [PageID] {
    [completed.id] + (successor.map { [$0.id] } ?? [])
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
        isMatch = task.page.displayTitle.localizedStandardContains(value)
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
      return (lhs.data.completedAt ?? lhs.page.modifiedAt) > (rhs.data.completedAt ?? rhs.page.modifiedAt)
    }
    if lhs.data.priority != rhs.data.priority { return lhs.data.priority > rhs.data.priority }
    let lhsDate = lhs.data.scheduledAt ?? lhs.data.deadline ?? .distantFuture
    let rhsDate = rhs.data.scheduledAt ?? rhs.data.deadline ?? .distantFuture
    if lhsDate != rhsDate { return lhsDate < rhsDate }
    if lhs.page.createdAt != rhs.page.createdAt { return lhs.page.createdAt < rhs.page.createdAt }
    return lhs.page.displayTitle.localizedStandardCompare(rhs.page.displayTitle) == .orderedAscending
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
    let state: TaskState = switch rawStatus {
    case "done", "completed": .completed
    case "cancelled", "canceled": .canceled
    default: .active
    }
    let rawPlacement = values[TaskFields.placement]?.first.flatMap(\.selectValue)
    let placement = rawPlacement.flatMap(TaskPlacement.init(rawValue:)) ?? .inbox
    let rawScheduleGranularity = values[TaskFields.scheduleGranularity]?.first.flatMap(\.selectValue)
    let scheduleGranularity = rawScheduleGranularity.flatMap(TaskScheduleGranularity.init(rawValue:))
      ?? .dateTime
    let rawPriority = values[TaskFields.priority]?.first.flatMap(\.selectValue)
    let priority = rawPriority.flatMap(TaskPriority.init(rawValue:)) ?? .none
    let recurrence = values[TaskFields.recurrence]?.first.flatMap(\.textValue).flatMap { value in
      value.data(using: .utf8).flatMap { try? JSONDecoder.enchiridion.decode(TaskRecurrenceRule.self, from: $0) }
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
      estimatedMinutes: values[TaskFields.estimatedMinutes]?.first.flatMap(\.numberValue).map(Int.init)
    )
  }
}

private extension SupertagValue {
  var selectValue: String? {
    guard case .select(let value) = self else { return nil }
    return value
  }

  var textValue: String? {
    guard case .text(let value) = self else { return nil }
    return value
  }

  var dateValue: Date? {
    switch self {
    case .date(let value), .dateTime(let value): value
    default: nil
    }
  }

  var pageValue: PageID? {
    guard case .page(let value) = self else { return nil }
    return value
  }

  var numberValue: Double? {
    guard case .number(let value) = self else { return nil }
    return value
  }
}

extension String {
  fileprivate func trimmingPrefix(_ prefix: Character) -> String {
    first == prefix ? String(dropFirst()) : self
  }
}
