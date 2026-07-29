import AppIntents
import EnchiridionCore
import Foundation

struct EnchiridionTaskEntity: AppEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Task")
  static let defaultQuery = EnchiridionTaskEntityQuery()

  let id: String

  @Property(title: "Title")
  var title: String

  @Property(title: "Completed")
  var isCompleted: Bool

  @Property(title: "Deadline")
  var deadline: Date?

  @Property(title: "Priority")
  var priority: String

  @Property(title: "Tags")
  var tags: [String]

  var displayRepresentation: DisplayRepresentation {
    if isCompleted {
      return DisplayRepresentation(title: "\(title)", subtitle: "Completed")
    }
    if let deadline {
      return DisplayRepresentation(
        title: "\(title)",
        subtitle: "Due \(deadline.formatted(date: .abbreviated, time: .omitted))"
      )
    }
    return DisplayRepresentation(title: "\(title)")
  }

  init(page: PageSnapshot) {
    id = page.id.rawValue
    title = page.displayTitle
    isCompleted = page.taskData?.state == .completed
    deadline = page.taskData?.deadline
    priority = page.taskData?.priority.rawValue ?? TaskPriority.none.rawValue
    tags = page.taskData?.tags ?? []
  }
}

struct EnchiridionTaskEntityQuery: EntityStringQuery, EnumerableEntityQuery {
  func entities(for identifiers: [String]) async throws -> [EnchiridionTaskEntity] {
    let repository = try intentRepository()
    var entities: [EnchiridionTaskEntity] = []
    for identifier in identifiers {
      if let page = try await repository.page(id: PageID(rawValue: identifier)), page.taskData != nil {
        entities.append(.init(page: page))
      }
    }
    return entities
  }

  func entities(matching string: String) async throws -> [EnchiridionTaskEntity] {
    let repository = try intentRepository()
    return try await repository.pages(with: BuiltInSupertags.task)
      .filter {
        $0.displayTitle.localizedStandardContains(string)
          || $0.plainText.localizedStandardContains(string)
      }
      .prefix(30)
      .map(EnchiridionTaskEntity.init(page:))
  }

  func suggestedEntities() async throws -> [EnchiridionTaskEntity] {
    let repository = try intentRepository()
    let pages = try await repository.pages(with: BuiltInSupertags.task)
    return TaskQuery.items(from: pages, selection: .smart(.today))
      .map(\.page)
      .prefix(20)
      .map(EnchiridionTaskEntity.init(page:))
  }

  func allEntities() async throws -> [EnchiridionTaskEntity] {
    let repository = try intentRepository()
    return try await repository.pages(with: BuiltInSupertags.task)
      .filter { $0.taskData?.state == .active }
      .map(EnchiridionTaskEntity.init(page:))
  }
}

enum EnchiridionIntentTaskPriority: String, AppEnum {
  case none
  case low
  case medium
  case high
  case urgent

  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Priority")
  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
    .none: "No Priority",
    .low: "Low",
    .medium: "Medium",
    .high: "High",
    .urgent: "Urgent",
  ]

  var taskPriority: TaskPriority { TaskPriority(rawValue: rawValue) ?? .none }
}

enum EnchiridionIntentTaskList: String, AppEnum {
  case inbox
  case today
  case upcoming
  case anytime
  case someday
  case logbook

  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Task List")
  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
    .inbox: "Inbox",
    .today: "Today",
    .upcoming: "Upcoming",
    .anytime: "Anytime",
    .someday: "Someday",
    .logbook: "Logbook",
  ]

  var smartList: TaskSmartList { TaskSmartList(rawValue: rawValue) ?? .inbox }
}

struct AddEnchiridionTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Add Task"
  static let description = IntentDescription(
    "Adds a task to Enchiridion with an optional schedule, deadline, priority, tags, and notes."
  )

  @Parameter(title: "Title")
  var taskTitle: String

  @Parameter(title: "When")
  var scheduledAt: Date?

  @Parameter(title: "Deadline")
  var deadline: Date?

  @Parameter(title: "Reminder")
  var reminder: Date?

  @Parameter(title: "Priority", default: EnchiridionIntentTaskPriority.none)
  var priority: EnchiridionIntentTaskPriority

  @Parameter(title: "Tags")
  var tags: [String]?

  @Parameter(title: "Notes")
  var notes: String?

  static var parameterSummary: some ParameterSummary {
    Summary("Add \(\.$taskTitle)") {
      \.$scheduledAt
      \.$deadline
      \.$reminder
      \.$priority
      \.$tags
      \.$notes
    }
  }

  func perform() async throws -> some IntentResult & ReturnsValue<EnchiridionTaskEntity> & ProvidesDialog {
    let normalizedTitle = taskTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedTitle.isEmpty else {
      throw EnchiridionTaskIntentError.invalidTitle
    }
    let repository = try intentRepository()
    let page = try await repository.createTask(
      TaskDraft(
        title: normalizedTitle,
        notes: notes ?? "",
        data: TaskData(
          placement: scheduledAt == nil ? .inbox : .anytime,
          scheduledAt: scheduledAt,
          deadline: deadline,
          reminder: reminder,
          priority: priority.taskPriority,
          tags: tags ?? []
        )
      )
    )
    await TaskReminderScheduler.shared.schedule(
      page,
      requestingAuthorization: reminder != nil
    )
    await TaskSpotlightIndex.index(page)
    return .result(
      value: EnchiridionTaskEntity(page: page),
      dialog: "Added \(page.displayTitle) to Enchiridion."
    )
  }
}

struct QuickAddEnchiridionTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Quick Add Task"
  static let description = IntentDescription(
    "Captures one line as an Inbox task without opening Enchiridion."
  )
  static let openAppWhenRun = false

  @Parameter(
    title: "Task",
    inputConnectionBehavior: .connectToPreviousIntentResult
  )
  var capture: String

  static var parameterSummary: some ParameterSummary {
    Summary("Quick add \(\.$capture)")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<EnchiridionTaskEntity> & ProvidesDialog {
    let normalizedCapture = capture.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedCapture.isEmpty else { throw EnchiridionTaskIntentError.invalidTitle }
    let repository = try intentRepository()
    let parsed = QuickTaskParser.parse(normalizedCapture)
    let page = try await repository.createTask(parsed.draft)
    await TaskReminderScheduler.shared.schedule(
      page,
      requestingAuthorization: parsed.draft.data.reminder != nil
    )
    await TaskSpotlightIndex.index(page)
    return .result(
      value: EnchiridionTaskEntity(page: page),
      dialog: "Captured \(page.displayTitle)."
    )
  }
}

struct CompleteEnchiridionTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Complete Task"
  static let description = IntentDescription("Completes a task and creates its next occurrence if it repeats.")

  @Parameter(title: "Task")
  var task: EnchiridionTaskEntity

  static var parameterSummary: some ParameterSummary {
    Summary("Complete \(\.$task)")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<EnchiridionTaskEntity> & ProvidesDialog {
    let repository = try intentRepository()
    let result = try await repository.completeTask(pageID: PageID(rawValue: task.id))
    await TaskReminderScheduler.shared.cancel(result.completed.id)
    if let successor = result.successor {
      await TaskReminderScheduler.shared.schedule(successor)
      await TaskSpotlightIndex.index(successor)
    }
    await TaskSpotlightIndex.remove(result.completed.id)
    return .result(
      value: EnchiridionTaskEntity(page: result.completed),
      dialog: "Completed \(result.completed.displayTitle)."
    )
  }
}

struct ReopenEnchiridionTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Reopen Task"
  static let description = IntentDescription("Returns a completed or canceled task to its active list.")

  @Parameter(title: "Task")
  var task: EnchiridionTaskEntity

  static var parameterSummary: some ParameterSummary {
    Summary("Reopen \(\.$task)")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<EnchiridionTaskEntity> & ProvidesDialog {
    let repository = try intentRepository()
    let page = try await repository.reopenTask(pageID: PageID(rawValue: task.id))
    await TaskReminderScheduler.shared.schedule(page)
    await TaskSpotlightIndex.index(page)
    return .result(
      value: EnchiridionTaskEntity(page: page),
      dialog: "Reopened \(page.displayTitle)."
    )
  }
}

struct FindEnchiridionTasksIntent: AppIntent {
  static let title: LocalizedStringResource = "Find Tasks"
  static let description = IntentDescription("Returns tasks from an Enchiridion smart list.")

  @Parameter(title: "List", default: EnchiridionIntentTaskList.today)
  var list: EnchiridionIntentTaskList

  static var parameterSummary: some ParameterSummary {
    Summary("Find tasks in \(\.$list)")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<[EnchiridionTaskEntity]> & ProvidesDialog {
    let repository = try intentRepository()
    let pages = try await repository.pages(with: BuiltInSupertags.task)
    let tasks = TaskQuery.items(from: pages, selection: .smart(list.smartList))
      .map { EnchiridionTaskEntity(page: $0.page) }
    await TaskSpotlightIndex.index(tasks)
    return .result(
      value: tasks,
      dialog: tasks.isEmpty ? "There are no tasks in \(list.rawValue)." : "Found \(tasks.count) tasks."
    )
  }
}

struct OpenEnchiridionTaskListIntent: AppIntent {
  static let title: LocalizedStringResource = "Open Task List"
  static let description = IntentDescription("Opens an Enchiridion smart list.")

  @Parameter(title: "List", default: EnchiridionIntentTaskList.today)
  var list: EnchiridionIntentTaskList

  static var parameterSummary: some ParameterSummary {
    Summary("Open \(\.$list) in Enchiridion")
  }

  func perform() async throws -> some IntentResult & OpensIntent {
    let url = URL(string: "enchiridion://tasks/\(list.rawValue)")!
    return .result(opensIntent: OpenURLIntent(url))
  }
}

struct EnchiridionTaskShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskEnchiridionIntent(),
      phrases: [
        "Ask \(.applicationName)",
      ],
      shortTitle: "Ask Enchiridion",
      systemImageName: "sparkles"
    )
    AppShortcut(
      intent: QuickAddEnchiridionTaskIntent(),
      phrases: [
        "Quick add a task in \(.applicationName)",
        "Capture a task in \(.applicationName)",
      ],
      shortTitle: "Quick Add Task",
      systemImageName: "bolt.fill"
    )
    AppShortcut(
      intent: AddEnchiridionTaskIntent(),
      phrases: [
        "Add a task in \(.applicationName)",
        "Create a task in \(.applicationName)",
        "Capture a task with \(.applicationName)",
      ],
      shortTitle: "Add Task",
      systemImageName: "plus.circle"
    )
    AppShortcut(
      intent: OpenEnchiridionTaskListIntent(),
      phrases: [
        "Open my tasks in \(.applicationName)",
        "Show my tasks in \(.applicationName)",
      ],
      shortTitle: "Open Tasks",
      systemImageName: "checkmark.circle"
    )
    AppShortcut(
      intent: FindEnchiridionTasksIntent(),
      phrases: [
        "Find my tasks in \(.applicationName)",
        "What's on my list in \(.applicationName)",
      ],
      shortTitle: "Find Tasks",
      systemImageName: "magnifyingglass"
    )
    AppShortcut(
      intent: CompleteEnchiridionTaskIntent(),
      phrases: [
        "Complete \(\.$task) in \(.applicationName)",
        "Mark \(\.$task) done in \(.applicationName)",
      ],
      shortTitle: "Complete Task",
      systemImageName: "checkmark.circle.fill"
    )
  }
}

private enum EnchiridionTaskIntentError: Error, CustomLocalizedStringResourceConvertible {
  case invalidTitle

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .invalidTitle: "A task needs a title."
    }
  }
}

private func intentRepository() throws -> LibraryRepository {
  try LibraryRepository(path: LibraryRepository.defaultLocalPath())
}

private enum TaskSpotlightIndex {
  static func index(_ page: PageSnapshot) async {
    await TaskSystemSpotlight.index(page)
  }

  static func index(_ entities: [EnchiridionTaskEntity]) async {
    guard !entities.isEmpty else { return }
    let repository = try? intentRepository()
    guard let repository else { return }
    for entity in entities {
      guard let page = try? await repository.page(id: PageID(rawValue: entity.id)) else { continue }
      await TaskSystemSpotlight.index(page)
    }
  }

  static func remove(_ pageID: PageID) async {
    await TaskSystemSpotlight.remove(pageID)
  }
}
