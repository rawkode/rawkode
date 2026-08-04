import Foundation

public enum ProjectStatus: String, Codable, CaseIterable, Hashable, Sendable {
  // Raw values are the stable IDs generated for the built-in select options.
  case idea
  case planned
  case active
  case onHold = "on-hold"
  case completed
  case cancelled

  public var title: String {
    switch self {
    case .idea: "Idea"
    case .planned: "Planned"
    case .active: "Active"
    case .onHold: "On Hold"
    case .completed: "Completed"
    case .cancelled: "Cancelled"
    }
  }

  public var isOpen: Bool {
    self != .completed && self != .cancelled
  }
}

public enum ProjectClosureResolution: String, Codable, CaseIterable, Hashable, Sendable {
  case strict
  case detachActiveTasks
  case cancelActiveTasks
}

public struct ProjectClosureUndoReceipt: Codable, Hashable, Sendable {
  public var resolution: ProjectClosureResolution
  public var projectAfterClosure: TaskPageVersion
  public var projectBeforeData: ProjectData
  public var taskReceipt: TaskBatchUndoReceipt

  public init(
    resolution: ProjectClosureResolution,
    projectAfterClosure: TaskPageVersion,
    projectBeforeData: ProjectData,
    taskReceipt: TaskBatchUndoReceipt
  ) {
    self.resolution = resolution
    self.projectAfterClosure = projectAfterClosure
    self.projectBeforeData = projectBeforeData
    self.taskReceipt = taskReceipt
  }
}

public struct ProjectClosureOutcome: Hashable, Sendable {
  public var project: PageSnapshot
  public var affectedTasks: [PageSnapshot]
  public var undoReceipt: ProjectClosureUndoReceipt?

  public init(
    project: PageSnapshot,
    affectedTasks: [PageSnapshot],
    undoReceipt: ProjectClosureUndoReceipt?
  ) {
    self.project = project
    self.affectedTasks = affectedTasks
    self.undoReceipt = undoReceipt
  }

  public var changedPageIDs: [PageID] {
    [project.id] + affectedTasks.map(\.id)
  }
}

public struct ProjectClosureUndoResult: Hashable, Sendable {
  public var project: PageSnapshot
  public var restoredTasks: [PageSnapshot]

  public init(project: PageSnapshot, restoredTasks: [PageSnapshot]) {
    self.project = project
    self.restoredTasks = restoredTasks
  }

  public var changedPageIDs: [PageID] {
    [project.id] + restoredTasks.map(\.id)
  }
}

public enum ProjectCloseResult: Hashable, Sendable {
  case closed(ProjectClosureOutcome)
  case blocked(activeTaskCount: Int)
  case failed(message: String)
}

public struct ProjectData: Codable, Hashable, Sendable {
  public var status: ProjectStatus
  public var outcome: String
  public var areaID: PageID?
  public var startDate: Date?
  public var dueDate: Date?
  public var lastReviewedAt: Date?
  public var closedAt: Date?

  public init(
    status: ProjectStatus = .active,
    outcome: String = "",
    areaID: PageID? = nil,
    startDate: Date? = nil,
    dueDate: Date? = nil,
    lastReviewedAt: Date? = nil,
    closedAt: Date? = nil
  ) {
    self.status = status
    self.outcome = outcome.trimmingCharacters(in: .whitespacesAndNewlines)
    self.areaID = areaID
    self.startDate = startDate
    self.dueDate = dueDate
    self.lastReviewedAt = lastReviewedAt
    self.closedAt = closedAt
  }
}

public enum ProjectFields {
  public static let status = key("status")
  public static let outcome = key("outcome")
  public static let area = key("area")
  public static let startDate = key("start-date")
  public static let dueDate = key("due-date")
  public static let lastReviewedAt = key("last-reviewed-at")
  public static let closedAt = key("closed-at")

  public static func properties(for data: ProjectData) -> [SupertagPropertyKey: [SupertagValue]] {
    [
      status: [.select(data.status.rawValue)],
      outcome: data.outcome.isEmpty ? [] : [.text(data.outcome)],
      area: data.areaID.map { [.page($0)] } ?? [],
      startDate: data.startDate.map { [.date($0)] } ?? [],
      dueDate: data.dueDate.map { [.date($0)] } ?? [],
      lastReviewedAt: data.lastReviewedAt.map { [.dateTime($0)] } ?? [],
      closedAt: data.closedAt.map { [.dateTime($0)] } ?? [],
    ]
  }

  private static func key(_ fieldID: String) -> SupertagPropertyKey {
    .init(supertagID: BuiltInSupertags.project, fieldID: .init(rawValue: fieldID))
  }
}

extension PageSnapshot {
  public var projectData: ProjectData? {
    guard hasSupertag(BuiltInSupertags.project) else { return nil }
    let values = objectMetadata.properties
    let status =
      values[ProjectFields.status]?.first?.projectSelectValue
      .flatMap(ProjectStatus.init(rawValue:)) ?? .active
    return ProjectData(
      status: status,
      outcome: values[ProjectFields.outcome]?.first?.projectTextValue ?? "",
      areaID: values[ProjectFields.area]?.first?.projectPageValue,
      startDate: values[ProjectFields.startDate]?.first?.projectDateValue,
      dueDate: values[ProjectFields.dueDate]?.first?.projectDateValue,
      lastReviewedAt: values[ProjectFields.lastReviewedAt]?.first?.projectDateValue,
      closedAt: values[ProjectFields.closedAt]?.first?.projectDateValue
    )
  }
}

public struct TaskHierarchyRow: Identifiable, Hashable, Sendable {
  public var task: TaskItem
  public var depth: Int
  public var directSubtaskCount: Int
  public var id: PageID { task.id }

  public init(task: TaskItem, depth: Int, directSubtaskCount: Int) {
    self.task = task
    self.depth = max(0, depth)
    self.directSubtaskCount = max(0, directSubtaskCount)
  }
}

public enum TaskHierarchy {
  /// Flattens the supplied task order into a stable parent-first tree.
  ///
  /// Missing parents are treated as roots. Corrupt parent cycles are broken deterministically,
  /// so every task remains reachable without allowing recursive rendering to loop.
  public static func rows(from tasks: [TaskItem]) -> [TaskHierarchyRow] {
    let taskIDs = Set(tasks.map(\.id))
    let tasksByID = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
    let childrenByParent = Dictionary(
      grouping: tasks.filter {
        $0.data.parentTaskID.map(taskIDs.contains) == true
      }
    ) { $0.data.parentTaskID! }
    var visited: Set<PageID> = []
    var result: [TaskHierarchyRow] = []

    func append(_ task: TaskItem, depth: Int) {
      guard visited.insert(task.id).inserted else { return }
      let children = childrenByParent[task.id] ?? []
      result.append(
        TaskHierarchyRow(task: task, depth: depth, directSubtaskCount: children.count)
      )
      for child in children {
        append(child, depth: depth + 1)
      }
    }

    for task in tasks where task.data.parentTaskID.flatMap({ tasksByID[$0] }) == nil {
      append(task, depth: 0)
    }
    for task in tasks where !visited.contains(task.id) {
      append(task, depth: 0)
    }
    return result
  }
}

public struct ProjectReviewItem: Identifiable, Hashable, Sendable {
  public var project: PageSnapshot
  public var data: ProjectData
  public var activeTaskCount: Int
  public var overdueTaskCount: Int
  public var needsReview: Bool
  public var id: PageID { project.id }

  public init(
    project: PageSnapshot,
    data: ProjectData,
    activeTaskCount: Int,
    overdueTaskCount: Int,
    needsReview: Bool
  ) {
    self.project = project
    self.data = data
    self.activeTaskCount = activeTaskCount
    self.overdueTaskCount = overdueTaskCount
    self.needsReview = needsReview
  }
}

public enum ProjectReviewBlocker: Hashable, Sendable {
  case missingOutcome
  case missingNextAction
  case unresolvedOverdue(count: Int)
}

public struct ProjectReviewReadiness: Hashable, Sendable {
  public var blockers: [ProjectReviewBlocker]

  public init(blockers: [ProjectReviewBlocker]) {
    self.blockers = blockers
  }

  public var canMarkReviewed: Bool { blockers.isEmpty }
}

public enum WeeklyReviewPolicy {
  public static func readiness(
    for item: ProjectReviewItem,
    acceptsOverdueWork: Bool
  ) -> ProjectReviewReadiness {
    var blockers: [ProjectReviewBlocker] = []
    if item.data.outcome.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      blockers.append(.missingOutcome)
    }
    if item.activeTaskCount == 0 {
      blockers.append(.missingNextAction)
    }
    if item.overdueTaskCount > 0, !acceptsOverdueWork {
      blockers.append(.unresolvedOverdue(count: item.overdueTaskCount))
    }
    return ProjectReviewReadiness(blockers: blockers)
  }

  public static func overdueTasks(
    in pages: [PageSnapshot],
    now: Date = Date(),
    calendar: Calendar = .current
  ) -> [TaskItem] {
    overdueTasks(
      in: pages.compactMap(TaskItem.init(page:)),
      now: now,
      calendar: calendar
    )
  }

  public static func overdueTasks(
    in tasks: [TaskItem],
    now: Date = Date(),
    calendar: Calendar = .current
  ) -> [TaskItem] {
    let startOfToday = calendar.startOfDay(for: now)
    return tasks
      .filter { task in
        task.data.isActive
          && (task.data.deadline.map { $0 < startOfToday } == true
            || task.data.scheduledAt.map { $0 < startOfToday } == true)
      }
      .sorted { lhs, rhs in
        let lhsDate =
          [lhs.data.deadline, lhs.data.scheduledAt]
          .compactMap { $0 }
          .min() ?? .distantFuture
        let rhsDate =
          [rhs.data.deadline, rhs.data.scheduledAt]
          .compactMap { $0 }
          .min() ?? .distantFuture
        if lhsDate != rhsDate { return lhsDate < rhsDate }
        return lhs.page.displayTitle.localizedStandardCompare(rhs.page.displayTitle)
          == .orderedAscending
      }
  }
}

public struct WeeklyReviewSnapshot: Hashable, Sendable {
  public var inboxTaskCount: Int
  public var overdueTaskCount: Int
  public var projects: [ProjectReviewItem]

  public init(inboxTaskCount: Int, overdueTaskCount: Int, projects: [ProjectReviewItem]) {
    self.inboxTaskCount = inboxTaskCount
    self.overdueTaskCount = overdueTaskCount
    self.projects = projects
  }

  public static func make(
    pages: [PageSnapshot],
    now: Date = Date(),
    calendar: Calendar = .current
  ) -> Self {
    make(
      pages: pages,
      activeTasks: pages.compactMap(TaskItem.init(page:)).filter(\.data.isActive),
      now: now,
      calendar: calendar
    )
  }

  /// Builds a review snapshot from a caller-owned active-task projection. This
  /// lets task home avoid reconstructing and rescanning the same task set.
  public static func make(
    pages: [PageSnapshot],
    activeTasks tasks: [TaskItem],
    now: Date = Date(),
    calendar: Calendar = .current
  ) -> Self {
    let overdueTasks = WeeklyReviewPolicy.overdueTasks(in: tasks, now: now, calendar: calendar)
    let overdueTaskIDs = Set(overdueTasks.map(\.id))
    let reviewCutoff = calendar.date(byAdding: .day, value: -7, to: now) ?? now
    let tasksByProject = Dictionary(
      grouping: tasks.compactMap { task in
        task.data.projectID.map { ($0, task) }
      }, by: \.0)

    let projects = pages.compactMap { page -> ProjectReviewItem? in
      guard let data = page.projectData, data.status.isOpen, page.deletedAt == nil else {
        return nil
      }
      let projectTasks = tasksByProject[page.id, default: []].map(\.1)
      let overdue = projectTasks.filter { overdueTaskIDs.contains($0.id) }.count
      let needsReview =
        data.outcome.isEmpty
        || projectTasks.isEmpty
        || overdue > 0
        || data.lastReviewedAt.map { $0 < reviewCutoff } ?? true
      return ProjectReviewItem(
        project: page,
        data: data,
        activeTaskCount: projectTasks.count,
        overdueTaskCount: overdue,
        needsReview: needsReview
      )
    }.sorted { lhs, rhs in
      if lhs.needsReview != rhs.needsReview { return lhs.needsReview }
      let lhsDue = lhs.data.dueDate ?? .distantFuture
      let rhsDue = rhs.data.dueDate ?? .distantFuture
      if lhsDue != rhsDue { return lhsDue < rhsDue }
      return lhs.project.displayTitle.localizedStandardCompare(rhs.project.displayTitle)
        == .orderedAscending
    }

    return Self(
      inboxTaskCount: tasks.filter { $0.data.placement == .inbox }.count,
      overdueTaskCount: overdueTasks.count,
      projects: projects
    )
  }
}

extension SupertagValue {
  fileprivate var projectSelectValue: String? {
    guard case .select(let value) = self else { return nil }
    return value
  }

  fileprivate var projectTextValue: String? {
    guard case .text(let value) = self else { return nil }
    return value
  }

  fileprivate var projectPageValue: PageID? {
    guard case .page(let value) = self else { return nil }
    return value
  }

  fileprivate var projectDateValue: Date? {
    switch self {
    case .date(let value), .dateTime(let value): value
    default: nil
    }
  }
}
