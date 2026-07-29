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

  @Property(title: "Vault")
  var vaultName: String

  var displayRepresentation: DisplayRepresentation {
    if isCompleted {
      return DisplayRepresentation(title: "\(title)", subtitle: "Completed · \(vaultName)")
    }
    if let deadline {
      return DisplayRepresentation(
        title: "\(title)",
        subtitle: "Due \(deadline.formatted(date: .abbreviated, time: .omitted)) · \(vaultName)"
      )
    }
    return DisplayRepresentation(title: "\(title)", subtitle: "\(vaultName)")
  }

  init(page: PageSnapshot, vault: VaultDescriptor) {
    id = VaultScopedNodeID(vaultID: vault.id, nodeID: page.id).id
    title = page.displayTitle
    isCompleted = page.taskData?.state == .completed
    deadline = page.taskData?.deadline
    priority = page.taskData?.priority.rawValue ?? TaskPriority.none.rawValue
    tags = page.taskData?.tags ?? []
    vaultName = vault.name
  }
}

struct EnchiridionTaskEntityQuery: EntityStringQuery, EnumerableEntityQuery {
  func entities(for identifiers: [String]) async throws -> [EnchiridionTaskEntity] {
    let requested = Set(identifiers)
    return try await intentTaskPages(in: .active).compactMap { item in
      let entity = EnchiridionTaskEntity(page: item.page, vault: item.vault)
      return requested.contains(entity.id) ? entity : nil
    }
  }

  func entities(matching string: String) async throws -> [EnchiridionTaskEntity] {
    return try await intentTaskPages(in: .active)
      .filter {
        $0.page.displayTitle.localizedStandardContains(string)
          || $0.page.plainText.localizedStandardContains(string)
      }
      .prefix(30)
      .map { EnchiridionTaskEntity(page: $0.page, vault: $0.vault) }
  }

  func suggestedEntities() async throws -> [EnchiridionTaskEntity] {
    let contexts = try VaultRepositoryContext.openAll()
    let items = try await contexts.asyncFlatMap { context in
      let pages = try await context.repository.tasks(in: .active)
      return TaskQuery.items(from: pages, selection: .smart(.today)).map {
        IntentTaskPage(vault: context.vault, page: $0.page)
      }
    }
    return items
      .prefix(20)
      .map { EnchiridionTaskEntity(page: $0.page, vault: $0.vault) }
  }

  func allEntities() async throws -> [EnchiridionTaskEntity] {
    try await intentTaskPages(in: .active)
      .map { EnchiridionTaskEntity(page: $0.page, vault: $0.vault) }
  }
}

struct ClosedEnchiridionTaskEntity: AppEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Closed Task")
  static let defaultQuery = ClosedEnchiridionTaskEntityQuery()

  let id: String

  @Property(title: "Title")
  var title: String

  @Property(title: "Status")
  var status: String

  @Property(title: "Vault")
  var vaultName: String

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(title)", subtitle: "\(status) · \(vaultName)")
  }

  init(page: PageSnapshot, vault: VaultDescriptor) {
    id = VaultScopedNodeID(vaultID: vault.id, nodeID: page.id).id
    title = page.displayTitle
    status = page.taskData?.state == .completed ? "Completed" : "Canceled"
    vaultName = vault.name
  }
}

struct ClosedEnchiridionTaskEntityQuery: EntityStringQuery, EnumerableEntityQuery {
  func entities(for identifiers: [String]) async throws -> [ClosedEnchiridionTaskEntity] {
    let requested = Set(identifiers)
    return try await intentTaskPages(in: .closed).compactMap { item in
      let entity = ClosedEnchiridionTaskEntity(page: item.page, vault: item.vault)
      return requested.contains(entity.id) ? entity : nil
    }
  }

  func entities(matching string: String) async throws -> [ClosedEnchiridionTaskEntity] {
    return try await intentTaskPages(in: .closed)
      .filter {
        $0.page.displayTitle.localizedStandardContains(string)
          || $0.page.plainText.localizedStandardContains(string)
      }
      .prefix(30)
      .map { ClosedEnchiridionTaskEntity(page: $0.page, vault: $0.vault) }
  }

  func suggestedEntities() async throws -> [ClosedEnchiridionTaskEntity] {
    let contexts = try VaultRepositoryContext.openAll()
    let items = try await contexts.asyncFlatMap { context in
      let pages = try await context.repository.tasks(in: .closed)
      return TaskQuery.items(from: pages, selection: .smart(.logbook)).map {
        IntentTaskPage(vault: context.vault, page: $0.page)
      }
    }
    return items
      .prefix(20)
      .map { ClosedEnchiridionTaskEntity(page: $0.page, vault: $0.vault) }
  }

  func allEntities() async throws -> [ClosedEnchiridionTaskEntity] {
    try await intentTaskPages(in: .closed)
      .map { ClosedEnchiridionTaskEntity(page: $0.page, vault: $0.vault) }
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

  func perform() async throws -> some IntentResult & ReturnsValue<EnchiridionTaskEntity>
    & ProvidesDialog
  {
    let normalizedTitle = taskTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedTitle.isEmpty else {
      throw EnchiridionTaskIntentError.invalidTitle
    }
    let context = try intentCreationContext(.defaultCapture)
    let page = try intentMutationValue(
      await context.mutations.create(
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
    )
    return .result(
      value: EnchiridionTaskEntity(page: page, vault: context.vault),
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

  func perform() async throws -> some IntentResult & ReturnsValue<EnchiridionTaskEntity>
    & ProvidesDialog
  {
    let normalizedCapture = capture.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedCapture.isEmpty else { throw EnchiridionTaskIntentError.invalidTitle }
    let context = try intentCreationContext(.defaultCapture)
    let parsed = QuickTaskParser.parse(normalizedCapture)
    let page = try intentMutationValue(await context.mutations.create(parsed.draft))
    return .result(
      value: EnchiridionTaskEntity(page: page, vault: context.vault),
      dialog: "Captured \(page.displayTitle)."
    )
  }
}

struct CompleteEnchiridionTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Complete Task"
  static let description = IntentDescription(
    "Completes a task and creates its next occurrence if it repeats.")

  @Parameter(title: "Task")
  var task: EnchiridionTaskEntity

  static var parameterSummary: some ParameterSummary {
    Summary("Complete \(\.$task)")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<EnchiridionTaskEntity>
    & ProvidesDialog
  {
    let context = try intentMutationContext(for: task.id)
    let result = try intentMutationValue(
      await context.mutations.complete(context.identity.nodeID)
    )
    return .result(
      value: EnchiridionTaskEntity(page: result.completed, vault: context.vault),
      dialog: "Completed \(result.completed.displayTitle)."
    )
  }
}

struct ReopenEnchiridionTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Reopen Task"
  static let description = IntentDescription(
    "Returns a completed or canceled task to its active list.")

  @Parameter(title: "Task")
  var task: ClosedEnchiridionTaskEntity

  static var parameterSummary: some ParameterSummary {
    Summary("Reopen \(\.$task)")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<EnchiridionTaskEntity>
    & ProvidesDialog
  {
    let context = try intentMutationContext(for: task.id)
    let page = try intentMutationValue(
      await context.mutations.reopen(context.identity.nodeID)
    )
    return .result(
      value: EnchiridionTaskEntity(page: page, vault: context.vault),
      dialog: "Reopened \(page.displayTitle)."
    )
  }
}

struct ScheduleEnchiridionTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Schedule Task"
  static let description = IntentDescription(
    "Schedules an active Enchiridion task for a day, with an optional exact time."
  )

  @Parameter(title: "Task")
  var task: EnchiridionTaskEntity

  @Parameter(title: "When")
  var scheduledAt: Date

  @Parameter(title: "Include Time", default: false)
  var includesTime: Bool

  static var parameterSummary: some ParameterSummary {
    Summary("Schedule \(\.$task) for \(\.$scheduledAt)") {
      \.$includesTime
    }
  }

  func perform() async throws -> some IntentResult & ReturnsValue<EnchiridionTaskEntity>
    & ProvidesDialog
  {
    let schedule: TaskSchedulePatch =
      includesTime
      ? .dateTime(scheduledAt) : .dateOnly(Calendar.current.startOfDay(for: scheduledAt))
    let context = try intentMutationContext(for: task.id)
    let result = try intentMutationValue(
      await context.mutations.patchTasks(
        [context.identity.nodeID],
        patch: TaskMetadataPatch(schedule: schedule, placement: .anytime)
      )
    )
    guard let page = result.tasks.first else { throw EnchiridionTaskIntentError.taskNotActive }
    let spokenDate = scheduledAt.formatted(
      date: .abbreviated,
      time: includesTime ? .shortened : .omitted
    )
    return .result(
      value: EnchiridionTaskEntity(page: page, vault: context.vault),
      dialog: "Scheduled \(page.displayTitle) for \(spokenDate)."
    )
  }
}

struct SetEnchiridionTaskDeadlineIntent: AppIntent {
  static let title: LocalizedStringResource = "Set Task Deadline"
  static let description = IntentDescription(
    "Sets a date-only deadline on an active Enchiridion task.")

  @Parameter(title: "Task")
  var task: EnchiridionTaskEntity

  @Parameter(title: "Deadline")
  var deadline: Date

  static var parameterSummary: some ParameterSummary {
    Summary("Set the deadline for \(\.$task) to \(\.$deadline)")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<EnchiridionTaskEntity>
    & ProvidesDialog
  {
    let normalizedDeadline = Calendar.current.startOfDay(for: deadline)
    let context = try intentMutationContext(for: task.id)
    let result = try intentMutationValue(
      await context.mutations.patchTasks(
        [context.identity.nodeID],
        patch: TaskMetadataPatch(deadline: .set(normalizedDeadline))
      )
    )
    guard let page = result.tasks.first else { throw EnchiridionTaskIntentError.taskNotActive }
    return .result(
      value: EnchiridionTaskEntity(page: page, vault: context.vault),
      dialog:
        "Set the deadline for \(page.displayTitle) to \(deadline.formatted(date: .abbreviated, time: .omitted))."
    )
  }
}

struct CancelEnchiridionTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Cancel Task"
  static let description = IntentDescription(
    "Cancels an active Enchiridion task without marking it complete."
  )

  @Parameter(title: "Task")
  var task: EnchiridionTaskEntity

  static var parameterSummary: some ParameterSummary {
    Summary("Cancel \(\.$task)")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<ClosedEnchiridionTaskEntity>
    & ProvidesDialog
  {
    let context = try intentMutationContext(for: task.id)
    let page = try intentMutationValue(
      await context.mutations.cancel(context.identity.nodeID)
    )
    return .result(
      value: ClosedEnchiridionTaskEntity(page: page, vault: context.vault),
      dialog: "Canceled \(page.displayTitle)."
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

  func perform() async throws -> some IntentResult & ReturnsValue<[EnchiridionTaskEntity]>
    & ProvidesDialog
  {
    let contexts = try VaultRepositoryContext.openAll()
    let tasks = try await contexts.asyncFlatMap { context in
      let pages = try await context.repository.pages(with: BuiltInSupertags.task)
      return TaskQuery.items(from: pages, selection: .smart(list.smartList))
        .map { EnchiridionTaskEntity(page: $0.page, vault: context.vault) }
    }
    await TaskSpotlightIndex.index(tasks)
    return .result(
      value: tasks,
      dialog: tasks.isEmpty
        ? "There are no tasks in \(list.rawValue)." : "Found \(tasks.count) tasks."
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
    let context = try VaultRepositoryContext.open(.selected)
    let url = TaskDeepLinkRoute.url(vaultID: context.vault.id, list: list.smartList)!
    return .result(opensIntent: OpenURLIntent(url))
  }
}

struct EnchiridionTaskShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskEnchiridionIntent(),
      phrases: [
        "Ask \(.applicationName)"
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
    AppShortcut(
      intent: ScheduleEnchiridionTaskIntent(),
      phrases: [
        "Schedule \(\.$task) in \(.applicationName)",
        "Plan \(\.$task) in \(.applicationName)",
      ],
      shortTitle: "Schedule Task",
      systemImageName: "calendar"
    )
    AppShortcut(
      intent: SetEnchiridionTaskDeadlineIntent(),
      phrases: [
        "Set the deadline for \(\.$task) in \(.applicationName)"
      ],
      shortTitle: "Set Deadline",
      systemImageName: "flag"
    )
    AppShortcut(
      intent: CancelEnchiridionTaskIntent(),
      phrases: [
        "Cancel \(\.$task) in \(.applicationName)"
      ],
      shortTitle: "Cancel Task",
      systemImageName: "xmark.circle"
    )
  }
}

private enum EnchiridionTaskIntentError: Error, CustomLocalizedStringResourceConvertible {
  case invalidTitle
  case taskNotActive
  case taskNotClosed

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .invalidTitle: "A task needs a title."
    case .taskNotActive: "Only active tasks can be completed."
    case .taskNotClosed: "Only completed or canceled tasks can be reopened."
    }
  }
}

private struct IntentTaskPage: Sendable {
  let vault: VaultDescriptor
  let page: PageSnapshot
}

private struct IntentMutationContext {
  let vault: VaultDescriptor
  let identity: VaultScopedNodeID
  let mutations: TaskMutationCoordinator
}

private struct IntentCreationContext {
  let vault: VaultDescriptor
  let mutations: TaskMutationCoordinator
}

private func intentTaskPages(in lifecycle: TaskLifecycleScope) async throws -> [IntentTaskPage] {
  try await VaultRepositoryContext.openAll().asyncFlatMap { context in
    try await context.repository.tasks(in: lifecycle).map {
      IntentTaskPage(vault: context.vault, page: $0)
    }
  }
}

private func intentCreationContext(_ selection: VaultSelection) throws -> IntentCreationContext {
  let context = try VaultRepositoryContext.open(selection)
  return .init(
    vault: context.vault,
    mutations: TaskMutationCoordinator(
      repository: context.repository,
      effects: .live(surface: .appIntent, vaultID: context.vault.id)
    )
  )
}

private func intentMutationContext(for serializedIdentity: String) throws -> IntentMutationContext {
  guard let identity = VaultScopedNodeID(serialized: serializedIdentity) else {
    throw EnchiridionTaskIntentError.taskNotActive
  }
  let context = try VaultRepositoryContext.open(.vault(identity.vaultID))
  return .init(
    vault: context.vault,
    identity: identity,
    mutations: TaskMutationCoordinator(
      repository: context.repository,
      effects: .live(surface: .appIntent, vaultID: identity.vaultID)
    )
  )
}

private func intentMutationValue<Value: Sendable>(
  _ result: TaskMutationResult<Value>
) throws -> Value {
  switch result {
  case .success(let success): return success.value
  case .failure(let failure):
    switch failure.reason {
    case .taskNotActive: throw EnchiridionTaskIntentError.taskNotActive
    case .taskNotClosed: throw EnchiridionTaskIntentError.taskNotClosed
    default: throw failure
    }
  }
}

private enum TaskSpotlightIndex {
  static func index(_ entities: [EnchiridionTaskEntity]) async {
    for entity in entities {
      guard let identity = VaultScopedNodeID(serialized: entity.id),
        let context = try? VaultRepositoryContext.open(.vault(identity.vaultID)),
        let page = try? await context.repository.page(id: identity.nodeID)
      else { continue }
      await TaskSystemSpotlight.index(page, vaultID: identity.vaultID)
    }
  }
}

private extension Sequence {
  func asyncFlatMap<Result>(
    _ transform: (Element) async throws -> [Result]
  ) async rethrows -> [Result] {
    var result: [Result] = []
    for element in self { result += try await transform(element) }
    return result
  }
}
