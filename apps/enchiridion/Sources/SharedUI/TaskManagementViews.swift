import EnchiridionCore
import SwiftUI

struct MobileTaskHomeScreen: View {
  let store: LibraryStore
  @Binding var requestedSelection: TaskListSelection?

  @State private var query = ""
  @State private var path: [MobileTaskDestination] = []
  @State private var showsQuickCapture = false
  @State private var collectionDraft: TaskCollectionDraft?
  @State private var editingPerspective: LiveQueryDefinition?

  var body: some View {
    NavigationStack(path: $path) {
      List {
        Section {
          ForEach(TaskSmartList.allCases) { list in
            NavigationLink(value: MobileTaskDestination.list(.smart(list))) {
              TaskNavigationLabel(
                title: list.title,
                systemImage: list.systemImage,
                count: badgeCount(for: list)
              )
            }
          }
        }

        if !openProjects.isEmpty {
          Section("Open Projects") {
            ForEach(openProjects) { project in
              NavigationLink(value: MobileTaskDestination.list(.project(project.id))) {
                TaskNavigationLabel(
                  title: project.displayTitle,
                  systemImage: "folder",
                  count: store.tasks(in: .project(project.id)).count
                )
              }
            }
          }
        }

        if !store.taskAreas.isEmpty {
          Section("Areas") {
            ForEach(store.taskAreas) { area in
              NavigationLink(value: MobileTaskDestination.list(.area(area.id))) {
                TaskNavigationLabel(
                  title: area.displayTitle,
                  systemImage: "square.grid.2x2",
                  count: store.tasks(in: .area(area.id)).count
                )
              }
            }
          }
        }

        if !store.taskPeople.isEmpty {
          Section("People") {
            ForEach(store.taskPeople) { person in
              NavigationLink(value: MobileTaskDestination.list(.person(person.id))) {
                TaskNavigationLabel(
                  title: store.personDisplayName(for: person),
                  systemImage: "person",
                  count: store.tasks(in: .person(person.id)).count
                )
              }
            }
          }
        }

        if !store.taskTags.isEmpty {
          Section("Tags") {
            ForEach(store.taskTags, id: \.self) { tag in
              NavigationLink(value: MobileTaskDestination.list(.tag(tag))) {
                TaskNavigationLabel(
                  title: tag,
                  systemImage: "tag",
                  count: store.tasks(in: .tag(tag)).count
                )
              }
            }
          }
        }

        Section("Perspectives") {
          ForEach(taskPerspectives) { perspective in
            NavigationLink(value: MobileTaskDestination.perspective(perspective.id)) {
              TaskNavigationLabel(
                title: perspective.name,
                systemImage: perspective.viewKind.systemImage,
                count: taskPerspectiveItems(perspective).count
              )
            }
          }
          Button {
            editingPerspective = .taskPerspectiveDraft()
          } label: {
            Label("New Perspective", systemImage: "plus")
          }
          .accessibilityHint("Creates a reusable filtered task list.")
        }
      }
      .navigationTitle("Tasks")
      .searchable(text: $query, prompt: "Search tasks")
      .overlay {
        if !query.isEmpty {
          TaskSearchOverlay(store: store, query: query)
        }
      }
      .navigationDestination(for: MobileTaskDestination.self) { destination in
        switch destination {
        case .list(let selection):
          TaskListScreen(store: store, selection: selection)
        case .perspective(let viewID):
          if let perspective = taskPerspectives.first(where: { $0.id == viewID }) {
            TaskPerspectiveScreen(store: store, definition: perspective)
          } else {
            ContentUnavailableView(
              "Perspective Unavailable",
              systemImage: "list.bullet.rectangle",
              description: Text("This saved task perspective is no longer available.")
            )
          }
        }
      }
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Button {
            showsQuickCapture = true
          } label: {
            Label("New Task", systemImage: "plus")
          }
          .accessibilityHint("Opens on-device task interpretation with a confirmation preview.")
        }
        ToolbarItem {
          Menu {
            Button("New Project", systemImage: "folder.badge.plus") {
              collectionDraft = .init(kind: .project)
            }
            Button("New Area", systemImage: "square.grid.2x2") {
              collectionDraft = .init(kind: .area)
            }
          } label: {
            Label("Organize", systemImage: "ellipsis.circle")
          }
        }
      }
      .sheet(isPresented: $showsQuickCapture) {
        TaskQuickCaptureSheet(store: store, selection: .smart(.inbox))
      }
      .sheet(item: $collectionDraft) { draft in
        TaskCollectionCreator(store: store, draft: draft)
      }
      .sheet(item: $editingPerspective) { perspective in
        LiveViewEditor(
          store: store,
          definition: perspective,
          purpose: .taskPerspective
        )
      }
      .onChange(of: requestedSelection) { _, selection in
        guard let selection else { return }
        path = [.list(selection)]
        requestedSelection = nil
      }
    }
  }

  private func badgeCount(for list: TaskSmartList) -> Int? {
    switch list {
    case .logbook, .anytime, .someday, .review: nil
    case .inbox, .today, .upcoming: store.taskCount(list)
    }
  }

  private var taskPerspectives: [LiveQueryDefinition] {
    store.savedViews.filter(\.isTaskListPerspective)
  }

  private var openProjects: [PageSnapshot] {
    store.taskProjects.filter { $0.projectData?.status.isOpen == true }
  }

  private func taskPerspectiveItems(_ perspective: LiveQueryDefinition) -> [TaskItem] {
    (store.liveViewItems[perspective.id] ?? []).compactMap { item in
      guard case .page(let page) = item else { return nil }
      return TaskItem(page: page)
    }
  }
}

private enum MobileTaskDestination: Hashable {
  case list(TaskListSelection)
  case perspective(LiveQueryID)
}

struct TaskListScreen: View {
  let store: LibraryStore
  let selection: TaskListSelection

  @State private var query = ""
  @State private var showsQuickCapture = false
  @State private var editingTaskID: PageID?

  var body: some View {
    TaskListContent(
      store: store,
      selection: selection,
      query: query,
      openTask: { editingTaskID = $0 }
    )
    .navigationTitle(title)
    .searchable(text: $query, prompt: "Filter this list")
    .toolbar {
      if allowsTaskCreation {
        ToolbarItem(placement: .primaryAction) {
          Button {
            showsQuickCapture = true
          } label: {
            Label("New Task", systemImage: "plus")
          }
        }
      }
    }
    .sheet(isPresented: $showsQuickCapture) {
      TaskQuickCaptureSheet(store: store, selection: selection)
    }
    .sheet(item: $editingTaskID) { pageID in
      NavigationStack {
        TaskDetailScreen(store: store, pageID: pageID)
      }
    }
  }

  private var title: String { taskSelectionTitle(selection, store: store) }

  private var allowsTaskCreation: Bool {
    switch selection {
    case .smart(.review), .smart(.logbook):
      false
    case .project(let projectID):
      store.page(id: projectID)?.projectData?.status.isOpen == true
    default:
      true
    }
  }
}

struct TaskPerspectiveScreen: View {
  let store: LibraryStore
  let definition: LiveQueryDefinition

  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var editingTaskID: PageID?
  @State private var editingPerspective: LiveQueryDefinition?
  @State private var showsDeleteConfirmation = false

  var body: some View {
    TaskListContent(
      store: store,
      perspective: definition,
      query: query,
      openTask: { editingTaskID = $0 }
    )
    .navigationTitle(definition.name)
    .searchable(text: $query, prompt: "Filter this perspective")
    .toolbar {
      ToolbarItem {
        Menu {
          Button("Edit Perspective", systemImage: "slider.horizontal.3") {
            editingPerspective = definition
          }
          Button("Duplicate Perspective", systemImage: "plus.square.on.square") {
            store.duplicateView(definition)
          }
          Divider()
          Button("Delete Perspective", systemImage: "trash", role: .destructive) {
            showsDeleteConfirmation = true
          }
        } label: {
          Label("Perspective Options", systemImage: "ellipsis.circle")
        }
        .accessibilityHint("Edit, duplicate, or delete this perspective.")
      }
    }
    .sheet(item: $editingTaskID) { pageID in
      NavigationStack {
        TaskDetailScreen(store: store, pageID: pageID)
      }
    }
    .sheet(item: $editingPerspective) { perspective in
      LiveViewEditor(
        store: store,
        definition: perspective,
        purpose: .taskPerspective
      )
    }
    .confirmationDialog(
      "Delete \(definition.name)?",
      isPresented: $showsDeleteConfirmation,
      titleVisibility: .visible
    ) {
      Button("Delete Perspective", role: .destructive) {
        store.deleteView(definition.id)
        dismiss()
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("The perspective will disappear on every synced device. Your tasks are not deleted.")
    }
  }
}

struct TaskListContent: View {
  let store: LibraryStore
  let source: TaskListContentSource
  var query = ""
  let openTask: (PageID) -> Void

  @State private var workbench = TaskWorkbenchSelection()

  init(
    store: LibraryStore,
    selection: TaskListSelection,
    query: String = "",
    openTask: @escaping (PageID) -> Void
  ) {
    self.store = store
    source = .list(selection)
    self.query = query
    self.openTask = openTask
  }

  init(
    store: LibraryStore,
    perspective: LiveQueryDefinition,
    query: String = "",
    openTask: @escaping (PageID) -> Void
  ) {
    self.store = store
    source = .perspective(perspective.id)
    self.query = query
    self.openTask = openTask
  }

  var body: some View {
    if case .list(.smart(.review)) = source {
      WeeklyReviewContent(store: store)
    } else {
      workbenchContent
        .taskWorkbenchChrome(
          selection: $workbench,
          visibleTaskIDs: visibleTaskIDs,
          actions: .live(store: store)
        )
        .safeAreaInset(edge: .bottom, spacing: 0) {
          if workbench.presentsActions {
            TaskWorkbenchActionBar(
              selection: $workbench,
              store: store,
              selectedTasks: visibleTasks.filter { workbench.selectedTaskIDs.contains($0.id) },
              actions: .live(store: store)
            )
          } else if let selection = source.listSelection, allowsQuickEntry(for: selection) {
            TaskQuickEntryBar(store: store, selection: selection)
          }
        }
        .onChange(of: source) { _, _ in
          workbench.cancelSelection()
        }
        #if os(macOS)
          .onChange(of: workbench.selectedTaskIDs) { oldSelection, newSelection in
            guard newSelection.count == 1,
              newSelection != oldSelection,
              let pageID = newSelection.first
            else { return }
            openTask(pageID)
          }
        #endif
    }
  }

  @ViewBuilder
  private var workbenchContent: some View {
    if case .list(.project(let projectID)) = source {
      ProjectTaskListContent(
        store: store,
        projectID: projectID,
        query: query,
        openTask: openTask,
        workbench: $workbench
      )
    } else {
      let tasks = visibleTasks
      TaskWorkbenchList(selection: $workbench) {
        if isLogbook, !closedProjects.isEmpty {
          Section("Closed Projects") {
            ForEach(closedProjects) { project in
              ClosedProjectRow(store: store, project: project)
            }
          }
        }

        if tasks.isEmpty, closedProjects.isEmpty {
          ContentUnavailableView(
            emptyTitle,
            systemImage: emptySymbol,
            description: Text(emptyDescription)
          )
          .listRowSeparator(.hidden)
        } else if case .list(.smart(.upcoming)) = source {
          ForEach(groupedUpcoming, id: \.day) { group in
            Section(group.day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())) {
              taskRows(group.tasks)
            }
          }
        } else if isLogbook, !tasks.isEmpty {
          Section("Task History") {
            taskRows(tasks)
          }
        } else if !tasks.isEmpty {
          taskRows(tasks)
        }
      }
      .listStyle(.inset)
    }
  }

  @ViewBuilder
  private func taskRows(_ tasks: [TaskItem]) -> some View {
    ForEach(tasks) { task in
      TaskRow(
        store: store,
        task: task,
        open: { openTask(task.id) },
        usesListSelection: usesNativeTaskSelection
      )
      .tag(task.id)
      .padding(.leading, task.data.parentTaskID == nil ? 0 : 18)
      .swipeActions(edge: .trailing, allowsFullSwipe: true) {
        if !workbench.isSelecting {
          if task.data.state == .active {
            Button {
              Task { await store.completeTaskOfferingUndo(task.id) }
            } label: {
              Label("Complete", systemImage: "checkmark")
            }
            .tint(.green)
          } else {
            Button {
              Task { await store.reopenTask(task.id) }
            } label: {
              Label("Reopen", systemImage: "arrow.uturn.backward")
            }
            .tint(.blue)
          }
        }
      }
      .contextMenu {
        if !workbench.isSelecting {
          if task.data.state == .active {
            Button("Complete", systemImage: "checkmark.circle") {
              Task { await store.completeTaskOfferingUndo(task.id) }
            }
            Button("Move to Someday", systemImage: "archivebox") {
              var data = task.data
              data.placement = .someday
              data.scheduledAt = nil
              Task { await store.updateTask(pageID: task.id, data: data) }
            }
            Button("Cancel", systemImage: "xmark.circle", role: .destructive) {
              Task { await store.cancelTask(task.id) }
            }
          } else {
            Button("Reopen", systemImage: "arrow.uturn.backward") {
              Task { await store.reopenTask(task.id) }
            }
          }
          Divider()
          Button("Move to Trash", systemImage: "trash", role: .destructive) {
            store.moveToTrash(pageID: task.id)
          }
        }
      }
    }
  }

  private var visibleTasks: [TaskItem] {
    let tasks: [TaskItem]
    switch source {
    case .list(let selection):
      tasks = store.tasks(in: selection)
    case .perspective(let viewID):
      tasks = (store.liveViewItems[viewID] ?? []).compactMap { item in
        guard case .page(let page) = item else { return nil }
        return TaskItem(page: page)
      }
    }
    let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return tasks }
    return tasks.filter {
      $0.page.displayTitle.localizedStandardContains(value)
        || $0.page.plainText.localizedStandardContains(value)
        || $0.data.tags.contains { $0.localizedStandardContains(value) }
    }
  }

  private var isLogbook: Bool {
    if case .list(.smart(.logbook)) = source { return true }
    return false
  }

  private var closedProjects: [PageSnapshot] {
    guard isLogbook else { return [] }
    return store.taskProjects.filter { $0.projectData?.status.isOpen == false }
  }

  private func allowsQuickEntry(for selection: TaskListSelection) -> Bool {
    switch selection {
    case .smart(.logbook), .smart(.review):
      false
    case .project(let projectID):
      store.page(id: projectID)?.projectData?.status.isOpen == true
    default:
      true
    }
  }

  private var usesNativeTaskSelection: Bool {
    #if os(iOS)
      workbench.isSelecting
    #else
      true
    #endif
  }

  private var visibleTaskIDs: [PageID] {
    if case .list(.project(_)) = source {
      return TaskHierarchy.rows(from: visibleTasks).map(\.id)
    }
    return visibleTasks.map(\.id)
  }

  private var groupedUpcoming: [(day: Date, tasks: [TaskItem])] {
    let calendar = Calendar.current
    return Dictionary(grouping: visibleTasks) { task in
      calendar.startOfDay(for: task.data.scheduledAt ?? task.data.deadline ?? .distantFuture)
    }
    .map { (day: $0.key, tasks: $0.value) }
    .sorted { $0.day < $1.day }
  }

  private var emptyTitle: String {
    if isLogbook { return "Nothing in Logbook" }
    if case .perspective = source { return "No matching tasks" }
    return "All clear"
  }

  private var emptySymbol: String {
    if case .list(.smart(.inbox)) = source { return "tray" }
    if case .perspective = source { return "list.bullet.rectangle" }
    return "checkmark.circle"
  }

  private var emptyDescription: String {
    if case .list(.smart(.inbox)) = source {
      return "Capture something as soon as it crosses your mind."
    }
    if case .list(.smart(.today)) = source { return "Nothing is scheduled or due today." }
    if isLogbook { return "Completed or cancelled tasks and closed projects appear here." }
    if case .perspective = source { return "No tasks match this saved perspective." }
    return "No tasks match this list."
  }
}

private struct ClosedProjectRow: View {
  let store: LibraryStore
  let project: PageSnapshot

  @State private var isReopening = false
  @State private var failureMessage: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .center, spacing: 12) {
        VStack(alignment: .leading, spacing: 4) {
          Text(project.displayTitle)
            .font(.body.weight(.medium))
            .lineLimit(2)

          Label(status.title, systemImage: statusSystemImage)
            .font(.caption)
            .foregroundStyle(.secondary)

          if let outcome = project.projectData?.outcome, !outcome.isEmpty {
            Text(outcome)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(2)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)

        Button(action: reopen) {
          if isReopening {
            ProgressView()
              .controlSize(.small)
              .frame(minWidth: 72)
          } else {
            Label("Reopen", systemImage: "arrow.uturn.backward")
              .fixedSize()
          }
        }
        .buttonStyle(.borderless)
        .frame(minHeight: 44)
        .disabled(isReopening)
        .accessibilityLabel("Reopen \(project.displayTitle)")
        .accessibilityHint("Returns this project to Open Projects")
      }

      if let failureMessage {
        Label(failureMessage, systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.vertical, 2)
  }

  private var status: ProjectStatus {
    project.projectData?.status ?? .completed
  }

  private var statusSystemImage: String {
    status == .cancelled ? "xmark.circle" : "checkmark.circle"
  }

  private func reopen() {
    guard !isReopening else { return }
    failureMessage = nil
    isReopening = true
    Task {
      if await store.reopenProject(pageID: project.id) == nil {
        failureMessage = store.startupError ?? "The project could not be reopened."
      }
      isReopening = false
    }
  }
}

struct TaskRow: View {
  let store: LibraryStore
  let task: TaskItem
  let open: () -> Void
  var usesListSelection = false

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 11) {
      #if os(iOS)
        if usesListSelection {
          completionImage
        } else {
          completionButton
        }
      #else
        completionButton
      #endif

      if usesListSelection {
        taskLabel
      } else {
        Button(action: open) { taskLabel }
          .buttonStyle(.plain)
      }
    }
    .padding(.vertical, 4)
    .accessibilityHint(
      usesListSelection ? "Selects this task for batch actions" : "Opens task details"
    )
  }

  private var completionButton: some View {
    Button {
      Task {
        if task.data.state == .active {
          await store.completeTaskOfferingUndo(task.id)
        } else {
          await store.reopenTask(task.id)
        }
      }
    } label: {
      completionImage
    }
    .buttonStyle(.plain)
    .accessibilityLabel(
      task.data.state == .active
        ? "Complete \(task.page.displayTitle)" : "Reopen \(task.page.displayTitle)")
  }

  private var completionImage: some View {
    Image(systemName: completionSymbol)
      .font(.title3)
      .foregroundStyle(completionColor)
      .contentTransition(.symbolEffect(.replace))
      .accessibilityHidden(usesListSelection)
  }

  private var taskLabel: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 6) {
        if task.data.priority != .none {
          Image(systemName: "exclamationmark")
            .font(.caption.weight(.bold))
            .foregroundStyle(priorityColor)
            .accessibilityLabel("\(task.data.priority.title) priority")
        }
        Text(task.page.displayTitle)
          .strikethrough(task.data.state != .active)
          .foregroundStyle(task.data.state == .active ? .primary : .secondary)
          .lineLimit(2)
        if task.data.recurrence != nil {
          Image(systemName: "repeat")
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Repeating")
        }
      }

      if hasMetadata {
        HStack(spacing: 9) {
          if let scheduledAt = task.data.scheduledAt {
            Label(taskDateLabel(scheduledAt), systemImage: "calendar")
              .foregroundStyle(scheduledColor(scheduledAt))
          }
          if let deadline = task.data.deadline {
            Label(taskDateLabel(deadline), systemImage: "flag")
              .foregroundStyle(deadlineColor(deadline))
          }
          if let projectID = task.data.projectID,
            let project = store.page(id: projectID)
          {
            Label(project.displayTitle, systemImage: "folder")
          }
          if let assigneeLabel {
            Label(assigneeLabel, systemImage: "person.2")
          }
          if let firstTag = task.data.tags.first {
            Label(firstTag, systemImage: "tag")
          }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(.rect)
  }

  private var completionSymbol: String {
    switch task.data.state {
    case .active: "circle"
    case .completed: "checkmark.circle.fill"
    case .canceled: "xmark.circle.fill"
    }
  }

  private var completionColor: Color {
    switch task.data.state {
    case .active: .secondary
    case .completed: .green
    case .canceled: .secondary
    }
  }

  private var priorityColor: Color {
    switch task.data.priority {
    case .none, .low: .secondary
    case .medium: .blue
    case .high: .orange
    case .urgent: .red
    }
  }

  private var hasMetadata: Bool {
    task.data.scheduledAt != nil || task.data.deadline != nil || task.data.projectID != nil
      || !task.data.assigneeIDs.isEmpty || !task.data.tags.isEmpty
  }

  private var assigneeLabel: String? {
    let names = task.data.assigneeIDs.compactMap { store.personDisplayName(for: $0) }
    guard !names.isEmpty else { return nil }
    let visibleNames = names.prefix(2).joined(separator: ", ")
    let remaining = names.count - min(names.count, 2)
    return remaining > 0 ? "\(visibleNames) +\(remaining)" : visibleNames
  }

  private func scheduledColor(_ date: Date) -> Color {
    date < Calendar.current.startOfDay(for: Date()) ? .orange : .secondary
  }

  private func deadlineColor(_ date: Date) -> Color {
    date < Calendar.current.startOfDay(for: Date()) ? .red : .secondary
  }
}

struct TaskDetailScreen: View {
  let store: LibraryStore
  let pageID: PageID

  var body: some View {
    PageDestinationView(store: store, pageID: pageID)
  }
}

struct TaskPropertiesView: View {
  let store: LibraryStore
  let page: PageSnapshot

  @State private var data: TaskData
  @State private var tags: String
  @State private var estimate: String
  @State private var isSaving = false
  @State private var isChangingState = false
  @State private var saveError: String?

  init(store: LibraryStore, page: PageSnapshot, initialData: TaskData) {
    self.store = store
    self.page = page
    _data = State(initialValue: initialData)
    _tags = State(initialValue: initialData.tags.joined(separator: ", "))
    _estimate = State(initialValue: initialData.estimatedMinutes.map(String.init) ?? "")
  }

  var body: some View {
    Form {
      Section("Execution") {
        Picker("State", selection: stateBinding) {
          ForEach(TaskState.allCases, id: \.self) { state in
            Text(stateTitle(state)).tag(state)
          }
        }
        .disabled(isWorking)
        if isChangingState {
          HStack(spacing: 10) {
            ProgressView()
              .controlSize(.small)
            Text("Updating task state…")
              .foregroundStyle(.secondary)
          }
          .accessibilityElement(children: .combine)
        }

        Picker("List", selection: $data.placement) {
          ForEach(TaskPlacement.allCases, id: \.self) { placement in
            Text(placement.title).tag(placement)
          }
        }
        Picker("Priority", selection: $data.priority) {
          ForEach(TaskPriority.allCases, id: \.self) { priority in
            Text(priority.title).tag(priority)
          }
        }
      }

      Section("Planning") {
        Toggle("Schedule", isOn: hasScheduledDateBinding)
        if data.scheduledAt != nil {
          Picker("Schedule precision", selection: $data.scheduleGranularity) {
            Text("Date only").tag(TaskScheduleGranularity.dateOnly)
            Text("Date and time").tag(TaskScheduleGranularity.dateTime)
          }
          DatePicker(
            "When",
            selection: scheduledBinding,
            displayedComponents: data.scheduleGranularity == .dateOnly
              ? [.date]
              : [.date, .hourAndMinute]
          )
        }
        Toggle("Deadline", isOn: hasDeadlineBinding)
        if data.deadline != nil {
          DatePicker("Deadline", selection: deadlineBinding, displayedComponents: .date)
        }
        Toggle("Reminder", isOn: hasReminderBinding)
        if data.reminder != nil {
          DatePicker(
            "Remind me",
            selection: reminderBinding,
            displayedComponents: [.date, .hourAndMinute]
          )
        }
      }

      Section("Organization") {
        Picker("Project", selection: $data.projectID) {
          Text("None").tag(PageID?.none)
          ForEach(assignableProjects) { project in
            Text(projectPickerTitle(project)).tag(PageID?.some(project.id))
          }
        }
        Picker("Area", selection: $data.areaID) {
          Text("None").tag(PageID?.none)
          ForEach(store.taskAreas) { area in
            Text(area.displayTitle).tag(PageID?.some(area.id))
          }
        }
        Picker("Parent Task", selection: $data.parentTaskID) {
          Text("None").tag(PageID?.none)
          ForEach(parentCandidates) { task in
            Text(task.page.displayTitle).tag(PageID?.some(task.id))
          }
        }
        TextField("Tags, separated by commas", text: $tags)
      }

      TaskAssigneesSection(store: store, assigneeIDs: $data.assigneeIDs)

      Section("Repeat & Estimate") {
        Toggle("Repeats", isOn: hasRecurrenceBinding)
        if data.recurrence != nil {
          TaskRecurrenceEditor(rule: recurrenceBinding)
        }
        TextField("Estimate in minutes", text: $estimate)
      }

      Section {
        if let saveError {
          Label(saveError, systemImage: "exclamationmark.triangle")
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
        }

        Button {
          Task { await save() }
        } label: {
          HStack(spacing: 10) {
            Label("Save Changes", systemImage: "checkmark")
            Spacer()
            if isSaving {
              ProgressView()
                .controlSize(.small)
                .accessibilityLabel("Saving task properties")
            }
          }
          .frame(minHeight: 44)
          .contentShape(.rect)
        }
        .disabled(!hasUnsavedChanges || isWorking)
      } footer: {
        Text(
          hasUnsavedChanges
            ? "Save to apply these task properties."
            : "All task properties are saved."
        )
      }
    }
    .formStyle(.grouped)
    .disabled(isChangingState)
    #if os(macOS)
    .frame(minWidth: 340, minHeight: 480)
    #endif
  }

  private var isWorking: Bool { isSaving || isChangingState }

  private var currentData: TaskData? {
    store.page(id: page.id)?.taskData
  }

  private var hasUnsavedChanges: Bool {
    guard let currentData else { return false }
    return !isEstimateValid || preparedData(preservingLifecycleFrom: currentData) != currentData
  }

  private var isEstimateValid: Bool {
    let value = estimate.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return true }
    return Int(value).map { $0 > 0 } ?? false
  }

  private var stateBinding: Binding<TaskState> {
    Binding(
      get: { currentData?.state ?? data.state },
      set: { changeState(to: $0) }
    )
  }

  private var scheduledBinding: Binding<Date> {
    Binding(get: { data.scheduledAt ?? Date() }, set: { data.scheduledAt = $0 })
  }

  private var hasScheduledDateBinding: Binding<Bool> {
    Binding(
      get: { data.scheduledAt != nil },
      set: { data.setScheduleEnabled($0) }
    )
  }

  private var deadlineBinding: Binding<Date> {
    Binding(get: { data.deadline ?? Date() }, set: { data.deadline = $0 })
  }

  private var hasDeadlineBinding: Binding<Bool> {
    Binding(
      get: { data.deadline != nil },
      set: { data.setDeadlineEnabled($0) }
    )
  }

  private var reminderBinding: Binding<Date> {
    Binding(get: { data.reminder ?? Date() }, set: { data.reminder = $0 })
  }

  private var hasReminderBinding: Binding<Bool> {
    Binding(
      get: { data.reminder != nil },
      set: { data.setReminderEnabled($0) }
    )
  }

  private var recurrenceBinding: Binding<TaskRecurrenceRule> {
    Binding(
      get: { data.recurrence ?? TaskRecurrenceRule() },
      set: { data.recurrence = TaskTemporalPolicy.normalized($0) }
    )
  }

  private var hasRecurrenceBinding: Binding<Bool> {
    Binding(
      get: { data.recurrence != nil },
      set: { data.setRecurrenceEnabled($0) }
    )
  }

  private var parentCandidates: [TaskItem] {
    store.pages.compactMap(TaskItem.init(page:)).filter {
      $0.id != page.id && $0.data.state == .active
    }
  }

  private var assignableProjects: [PageSnapshot] {
    var projects = store.taskProjects.filter { $0.projectData?.status.isOpen == true }
    if let projectID = data.projectID,
      let current = store.page(id: projectID),
      !projects.contains(where: { $0.id == projectID })
    {
      projects.append(current)
    }
    return projects
  }

  private func projectPickerTitle(_ project: PageSnapshot) -> String {
    project.projectData?.status.isOpen == false
      ? "\(project.displayTitle) (Closed)"
      : project.displayTitle
  }

  private func stateTitle(_ state: TaskState) -> String {
    switch state {
    case .active: "Active"
    case .completed: "Completed"
    case .canceled: "Canceled"
    }
  }

  private func preparedData(preservingLifecycleFrom current: TaskData) -> TaskData {
    var prepared = data
    prepared.tags = TaskData.normalizedTags(tags.split(separator: ",").map(String.init))
    prepared.estimatedMinutes = Int(estimate).flatMap { $0 > 0 ? $0 : nil }
    prepared.state = current.state
    prepared.completedAt = current.completedAt
    prepared.recurrenceSeriesID = current.recurrenceSeriesID
    prepared.recurrenceSequence = current.recurrenceSequence
    prepared.temporalProvenance = current.temporalProvenance
    return prepared
  }

  @discardableResult
  private func save() async -> Bool {
    guard !isSaving, let currentData else { return false }
    guard isEstimateValid else {
      saveError = "Estimate must be a whole number of minutes greater than zero."
      return false
    }
    let prepared = preparedData(preservingLifecycleFrom: currentData)
    guard prepared != currentData else {
      saveError = nil
      return true
    }

    isSaving = true
    saveError = nil
    defer { isSaving = false }

    guard let updatedPage = await store.updateTask(pageID: page.id, data: prepared),
      let updatedData = updatedPage.taskData
    else {
      saveError = store.startupError ?? "The task could not be saved."
      return false
    }

    hydrate(from: updatedData)
    return true
  }

  private func changeState(to targetState: TaskState) {
    guard let sourceState = currentData?.state,
      targetState != sourceState,
      !isWorking
    else { return }

    isChangingState = true
    saveError = nil
    Task { @MainActor in
      if hasUnsavedChanges, !(await save()) {
        isChangingState = false
        return
      }

      let didChange: Bool
      switch targetState {
      case .active:
        didChange = await store.reopenTask(page.id) != nil
      case .completed:
        if sourceState == .canceled, await store.reopenTask(page.id) == nil {
          didChange = false
        } else {
          didChange = await store.completeTaskOfferingUndo(page.id) != nil
        }
      case .canceled:
        didChange = await store.cancelTask(page.id) != nil
      }

      if didChange, let updatedData = currentData {
        hydrate(from: updatedData)
      } else if !didChange {
        saveError = store.startupError ?? "The task state could not be changed."
      }
      isChangingState = false
    }
  }

  private func hydrate(from updatedData: TaskData) {
    data = updatedData
    tags = updatedData.tags.joined(separator: ", ")
    estimate = updatedData.estimatedMinutes.map(String.init) ?? ""
  }
}

private struct TaskAssigneesSection: View {
  let store: LibraryStore
  @Binding var assigneeIDs: [PageID]

  @State private var includesOtherPeople: Bool

  init(store: LibraryStore, assigneeIDs: Binding<[PageID]>) {
    self.store = store
    _assigneeIDs = assigneeIDs
    let otherIDs = Set(store.otherPeople.map(\.id))
    _includesOtherPeople = State(
      initialValue: assigneeIDs.wrappedValue.contains(where: otherIDs.contains)
    )
  }

  var body: some View {
    Section {
      if store.taskPeople.isEmpty {
        Text("No promoted people")
          .foregroundStyle(.secondary)
      } else {
        ForEach(store.taskPeople) { person in
          TaskAssigneeRow(
            name: store.personDisplayName(for: person),
            isSelected: assigneeIDs.contains(person.id),
            toggle: { toggle(person.id) }
          )
        }
      }

      if !store.otherPeople.isEmpty {
        Toggle("Include Other People", isOn: $includesOtherPeople)
          .accessibilityHint(
            "Shows people discovered from calendar events who have not been promoted.")

        if includesOtherPeople {
          ForEach(store.otherPeople) { person in
            TaskAssigneeRow(
              name: store.personDisplayName(for: person),
              isSelected: assigneeIDs.contains(person.id),
              isOther: true,
              toggle: { toggle(person.id) },
              promote: { Task { await store.promotePerson(person.id) } }
            )
          }
        }
      }
    } header: {
      Text("People")
    } footer: {
      Text("Promoted people appear here and in task suggestions by default.")
    }
  }

  private func toggle(_ personID: PageID) {
    if assigneeIDs.contains(personID) {
      assigneeIDs.removeAll { $0 == personID }
    } else {
      assigneeIDs = TaskData.normalizedPageIDs(assigneeIDs + [personID])
    }
  }
}

private struct TaskAssigneeRow: View {
  let name: String
  let isSelected: Bool
  var isOther = false
  let toggle: () -> Void
  var promote: (() -> Void)? = nil

  var body: some View {
    HStack(spacing: 12) {
      Button(action: toggle) {
        Label(name, systemImage: isSelected ? "checkmark.circle.fill" : "circle")
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)

      if isOther, let promote {
        Button("Promote", action: promote)
          .buttonStyle(.borderless)
          .accessibilityHint("Adds this person to task navigation and suggestions.")
      }
    }
  }
}

private struct TaskRecurrenceEditor: View {
  @Binding var rule: TaskRecurrenceRule

  var body: some View {
    Picker("Repeat", selection: $rule.mode) {
      ForEach(TaskRecurrenceMode.allCases, id: \.self) { mode in
        Text(mode.title).tag(mode)
      }
    }
    Stepper("Every \(rule.interval) \(unitLabel)", value: $rule.interval, in: 1...99)
    Picker("Unit", selection: unitBinding) {
      ForEach(TaskRecurrenceUnit.allCases, id: \.self) { unit in
        Text(unit.title).tag(unit)
      }
    }
    if rule.unit == .week {
      LabeledContent("Days") {
        HStack(spacing: 5) {
          ForEach(TaskWeekday.allCases.sorted(), id: \.self) { weekday in
            Button(String(weekday.shortTitle.prefix(1))) {
              if rule.weekdays.contains(weekday) {
                rule.weekdays.remove(weekday)
              } else {
                rule.weekdays.insert(weekday)
              }
            }
            .buttonStyle(.bordered)
            .tint(rule.weekdays.contains(weekday) ? Color.accentColor : Color.gray)
            .accessibilityLabel(weekday.shortTitle)
            .accessibilityValue(rule.weekdays.contains(weekday) ? "Selected" : "Not selected")
          }
        }
      }
    }
  }

  private var unitLabel: String {
    rule.interval == 1 ? rule.unit.rawValue : "\(rule.unit.rawValue)s"
  }

  private var unitBinding: Binding<TaskRecurrenceUnit> {
    Binding(
      get: { rule.unit },
      set: { unit in
        rule.unit = unit
        rule = TaskTemporalPolicy.normalized(rule)
      }
    )
  }
}

struct TaskQuickEntryBar: View {
  let store: LibraryStore
  let selection: TaskListSelection

  @State private var entry = ""
  @FocusState private var isFocused: Bool
  @State private var captureRequest: TaskQuickCaptureRequest?
  @State private var isSavingLiteral = false
  @State private var saveError: String?

  var body: some View {
    if selection != .smart(.review) {
      HStack(spacing: 10) {
        Image(systemName: "plus.circle.fill")
          .foregroundStyle(.tint)
          .accessibilityHidden(true)
        TextField("New task", text: $entry)
          .textFieldStyle(.plain)
          .focused($isFocused)
          .submitLabel(.done)
          .onSubmit(saveLiteral)
          .disabled(isSavingLiteral)
          .accessibilityHint(
            "Press Return to save literally to Inbox, or choose Interpret to review on-device suggestions."
          )
        if isSavingLiteral {
          ProgressView()
            .controlSize(.small)
            .accessibilityLabel("Saving task")
        }
        Button("Interpret", systemImage: "sparkles", action: reviewInterpretation)
          .buttonStyle(.plain)
          .foregroundStyle(.tint)
          .disabled(
            isSavingLiteral
              || TaskQuickEntryPolicy.command(for: entry, trigger: .interpret) == nil
          )
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .background(.bar)
      .alert("Couldn’t Save Task", isPresented: saveErrorBinding) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(saveError ?? "Try again.")
      }
      .sheet(item: $captureRequest) { request in
        TaskQuickCaptureSheet(
          store: store,
          selection: selection,
          initialEntry: request.entry,
          onSaved: {
            entry = ""
            isFocused = true
          }
        )
      }
    }
  }

  private var saveErrorBinding: Binding<Bool> {
    Binding(
      get: { saveError != nil },
      set: { if !$0 { saveError = nil } }
    )
  }

  private func saveLiteral() {
    guard !isSavingLiteral,
      case .saveLiteral(let draft) = TaskQuickEntryPolicy.command(
        for: entry,
        trigger: .submit
      )
    else { return }

    isSavingLiteral = true
    saveError = nil
    Task {
      if await store.createTask(draft) != nil {
        entry = ""
        isFocused = true
      } else {
        saveError = "Enchiridion couldn’t save this task. Your text is still here."
      }
      isSavingLiteral = false
    }
  }

  private func reviewInterpretation() {
    guard
      case .reviewInterpretation(let normalized) = TaskQuickEntryPolicy.command(
        for: entry,
        trigger: .interpret
      )
    else { return }
    captureRequest = TaskQuickCaptureRequest(entry: normalized)
  }
}

struct TaskQuickCaptureSheet: View {
  let store: LibraryStore
  let selection: TaskListSelection
  let interpreter: any TaskInputInterpreting
  let onSaved: () -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var entry: String
  @State private var interpretation: TaskInterpretation?
  @State private var workingDraft: TaskDraft
  @State private var hasModelInterpretation = false
  @State private var isInterpreting = false
  @State private var isSaving = false
  @State private var statusMessage: String?
  @State private var showsMetadataEditor = false
  @FocusState private var isFocused: Bool

  init(
    store: LibraryStore,
    selection: TaskListSelection,
    initialEntry: String = "",
    interpreter: any TaskInputInterpreting = FoundationTaskInterpreter(),
    onSaved: @escaping () -> Void = {}
  ) {
    self.store = store
    self.selection = selection
    self.interpreter = interpreter
    self.onSaved = onSaved
    _entry = State(initialValue: initialEntry)
    _workingDraft = State(initialValue: TaskInterpretation.literal(initialEntry).draft)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("What needs doing?", text: $entry, axis: .vertical)
            .lineLimit(2...5)
            .focused($isFocused)
        } footer: {
          Text("Interpretation stays on this device. Nothing is sent to a network service.")
        }

        if isInterpreting {
          Section {
            HStack(spacing: 10) {
              ProgressView().controlSize(.small)
              Text("Interpreting on device…")
            }
          }
        } else if let interpretation {
          TaskInterpretationPreview(
            interpretation: interpretation,
            draft: $workingDraft,
            hasModelInterpretation: hasModelInterpretation,
            editMetadata: { showsMetadataEditor = true }
          )
        }

        if let statusMessage, !isInterpreting {
          Section("Interpretation") {
            Label(statusMessage, systemImage: "exclamationmark.triangle")
              .foregroundStyle(.secondary)
          }
        }

        if !entry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          Section("Literal capture") {
            Button("Keep all text literally", systemImage: "text.quote") {
              saveLiteral()
            }
            .disabled(isSaving)
            Text("Keeps every word in the title and applies no interpreted metadata.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }
      .navigationTitle("New Task")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(hasModelInterpretation ? "Add Interpreted" : "Add Literally") {
            if hasModelInterpretation { saveInterpreted() } else { saveLiteral() }
          }
          .disabled(
            entry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || isSaving || isInterpreting || interpretation == nil
          )
        }
      }
    }
    .frame(minWidth: 390, minHeight: 520)
    .onAppear { isFocused = true }
    .task(id: entry) { await interpretEntry() }
    .sheet(isPresented: $showsMetadataEditor) {
      TaskDraftMetadataEditor(store: store, initialDraft: workingDraft) { updatedDraft in
        workingDraft = updatedDraft
      }
    }
  }

  @MainActor
  private func interpretEntry() async {
    let value = entry
    interpretation = nil
    hasModelInterpretation = false
    statusMessage = nil
    workingDraft = TaskInterpretation.literal(value).draft
    guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      isInterpreting = false
      return
    }

    isInterpreting = true
    do {
      try await Task.sleep(for: .milliseconds(300))
    } catch {
      return
    }
    guard !Task.isCancelled, value == entry else { return }

    let response = await interpreter.interpret(
      value,
      context: interpretationContext,
      now: Date(),
      calendar: .current,
      locale: .current
    )
    guard !Task.isCancelled, value == entry else { return }
    isInterpreting = false
    switch response {
    case .interpreted(let result):
      let resolved = resolvingLocalAssociations(in: result)
      interpretation = resolved
      workingDraft = resolved.draft
      hasModelInterpretation = true
    case .unavailable(let literal, let availability):
      interpretation = literal
      workingDraft = literal.draft
      statusMessage = "\(availability.message) Literal capture remains available."
    case .failed(let message):
      interpretation = TaskInterpretation.literal(value)
      workingDraft = TaskInterpretation.literal(value).draft
      statusMessage = message
    }
  }

  private var interpretationContext: TaskInterpretationContext {
    TaskInterpretationContext(
      projectNames: openProjects.map(\.displayTitle),
      areaNames: store.taskAreas.map(\.displayTitle),
      parentTaskTitles: store.pages.compactMap(TaskItem.init(page:)).filter {
        $0.data.state == .active
      }.map { $0.page.displayTitle },
      personNames: store.taskPeople.map { store.personDisplayName(for: $0) }
    )
  }

  private func resolvingLocalAssociations(in result: TaskInterpretation) -> TaskInterpretation {
    var resolved = result
    for index in resolved.suggestions.indices where resolved.suggestions[index].state == .unresolved
    {
      let suggestion = resolved.suggestions[index]
      let match: PageSnapshot?
      switch suggestion.field {
      case .project:
        match = exactMatch(suggestion.value, in: openProjects)
        if let match { resolved.draft.data.projectID = match.id }
      case .area:
        match = exactMatch(suggestion.value, in: store.taskAreas)
        if let match { resolved.draft.data.areaID = match.id }
      case .parentTask:
        let candidates = store.pages.compactMap(TaskItem.init(page:)).filter {
          $0.data.state == .active
        }
        .map(\.page)
        match = exactMatch(suggestion.value, in: candidates)
        if let match { resolved.draft.data.parentTaskID = match.id }
      case .person:
        match = exactPersonMatch(suggestion.value)
        if let match {
          resolved.draft.data.assigneeIDs = TaskData.normalizedPageIDs(
            resolved.draft.data.assigneeIDs + [match.id]
          )
        }
      case .title, .scheduledDate, .deadline, .reminder, .recurrence, .tag, .priority,
        .estimatedDuration:
        match = nil
      }
      if let match {
        resolved.suggestions[index].state = .applied
        resolved.suggestions[index].explanation =
          "Matched local \(suggestion.field.title.lowercased()) “\(match.displayTitle)”."
      }
    }
    return resolved
  }

  private var openProjects: [PageSnapshot] {
    store.taskProjects.filter { $0.projectData?.status.isOpen == true }
  }

  private func exactMatch(_ value: String, in candidates: [PageSnapshot]) -> PageSnapshot? {
    candidates.first {
      $0.displayTitle.compare(value, options: [.caseInsensitive, .diacriticInsensitive])
        == .orderedSame
    }
  }

  private func exactPersonMatch(_ value: String) -> PageSnapshot? {
    store.taskPeople.first { person in
      person.displayTitle.compare(value, options: [.caseInsensitive, .diacriticInsensitive])
        == .orderedSame
        || store.personDisplayName(for: person).compare(
          value,
          options: [.caseInsensitive, .diacriticInsensitive]
        ) == .orderedSame
    }
  }

  private func saveInterpreted() {
    guard !entry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !isSaving else { return }
    isSaving = true
    var draft = workingDraft
    apply(selection, to: &draft.data)
    Task {
      if await store.createTask(draft) != nil {
        onSaved()
        dismiss()
      }
      isSaving = false
    }
  }

  private func saveLiteral() {
    guard !entry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !isSaving else { return }
    isSaving = true
    var draft = TaskInterpretation.literal(entry).draft
    apply(selection, to: &draft.data)
    Task {
      if await store.createTask(draft) != nil {
        onSaved()
        dismiss()
      }
      isSaving = false
    }
  }
}

private struct TaskQuickCaptureRequest: Identifiable {
  let id = UUID()
  var entry: String
}

private struct TaskInterpretationPreview: View {
  let interpretation: TaskInterpretation
  @Binding var draft: TaskDraft
  let hasModelInterpretation: Bool
  let editMetadata: () -> Void

  var body: some View {
    Section("Preview") {
      TextField("Title", text: $draft.title, axis: .vertical)
        .lineLimit(1...4)
      Button("Edit title and metadata", systemImage: "slider.horizontal.3", action: editMetadata)
      if !hasModelInterpretation {
        Text("No model metadata will be applied.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }

    if !interpretation.suggestions.isEmpty {
      Section("Extracted fields") {
        ForEach(interpretation.suggestions) { suggestion in
          TaskInterpretationSuggestionRow(suggestion: suggestion)
        }
      }
    }

    if !interpretation.recognizedTokens.isEmpty {
      Section("Source tokens") {
        ScrollView(.horizontal) {
          HStack {
            ForEach(Array(interpretation.recognizedTokens.enumerated()), id: \.offset) { _, token in
              Text(token)
                .font(.caption)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(.quaternary, in: .capsule)
            }
          }
        }
        .scrollIndicators(.hidden)
      }
    }

    if interpretation.confirmation == .unresolvedHints {
      Section("Confirmation needed") {
        Label(
          "Some hints are not representable or did not match local metadata. Review them, edit the task, or keep the input literally.",
          systemImage: "exclamationmark.bubble"
        )
        .foregroundStyle(.secondary)
      }
    }
  }
}

private struct TaskInterpretationSuggestionRow: View {
  let suggestion: TaskInterpretationSuggestion

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(alignment: .firstTextBaseline) {
        Text(suggestion.field.title)
          .font(.subheadline.weight(.semibold))
        Spacer()
        Label(stateTitle, systemImage: stateSymbol)
          .font(.caption)
          .foregroundStyle(stateColor)
      }
      if !suggestion.value.isEmpty { Text(suggestion.value) }
      if !suggestion.sourceText.isEmpty {
        Text("From “\(suggestion.sourceText)”")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      if let explanation = suggestion.explanation {
        Text(explanation)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .accessibilityElement(children: .combine)
  }

  private var stateTitle: String {
    switch suggestion.state {
    case .applied: "Applied"
    case .unresolved: "Confirm"
    case .invalid: "Not applied"
    }
  }

  private var stateSymbol: String {
    switch suggestion.state {
    case .applied: "checkmark.circle"
    case .unresolved: "questionmark.circle"
    case .invalid: "exclamationmark.triangle"
    }
  }

  private var stateColor: Color {
    switch suggestion.state {
    case .applied: .green
    case .unresolved: .orange
    case .invalid: .red
    }
  }
}

private struct TaskDraftMetadataEditor: View {
  let store: LibraryStore
  let onSave: (TaskDraft) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var draft: TaskDraft
  @State private var tags: String
  @State private var estimate: String

  init(store: LibraryStore, initialDraft: TaskDraft, onSave: @escaping (TaskDraft) -> Void) {
    self.store = store
    self.onSave = onSave
    _draft = State(initialValue: initialDraft)
    _tags = State(initialValue: initialDraft.data.tags.joined(separator: ", "))
    _estimate = State(initialValue: initialDraft.data.estimatedMinutes.map(String.init) ?? "")
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("Task") {
          TextField("Title", text: $draft.title, axis: .vertical)
          TextField("Notes", text: $draft.notes, axis: .vertical)
          Picker("List", selection: $draft.data.placement) {
            ForEach(TaskPlacement.allCases, id: \.self) { Text($0.title).tag($0) }
          }
          Picker("Priority", selection: $draft.data.priority) {
            ForEach(TaskPriority.allCases, id: \.self) { Text($0.title).tag($0) }
          }
        }

        Section("Dates") {
          Toggle("Schedule", isOn: hasScheduledDateBinding)
          if draft.data.scheduledAt != nil {
            Picker("Schedule precision", selection: $draft.data.scheduleGranularity) {
              Text("Date only").tag(TaskScheduleGranularity.dateOnly)
              Text("Date and time").tag(TaskScheduleGranularity.dateTime)
            }
            DatePicker(
              "When",
              selection: scheduledBinding,
              displayedComponents: draft.data.scheduleGranularity == .dateOnly
                ? [.date] : [.date, .hourAndMinute]
            )
          }
          Toggle("Deadline", isOn: hasDeadlineBinding)
          if draft.data.deadline != nil {
            DatePicker("Deadline", selection: deadlineBinding, displayedComponents: .date)
          }
          Toggle("Reminder", isOn: hasReminderBinding)
          if draft.data.reminder != nil {
            DatePicker(
              "Remind me", selection: reminderBinding, displayedComponents: [.date, .hourAndMinute])
          }
        }

        Section("Organize") {
          Picker("Project", selection: $draft.data.projectID) {
            Text("None").tag(PageID?.none)
            ForEach(store.taskProjects.filter { $0.projectData?.status.isOpen == true }) {
              Text($0.displayTitle).tag(PageID?.some($0.id))
            }
          }
          Picker("Area", selection: $draft.data.areaID) {
            Text("None").tag(PageID?.none)
            ForEach(store.taskAreas) { Text($0.displayTitle).tag(PageID?.some($0.id)) }
          }
          Picker("Parent Task", selection: $draft.data.parentTaskID) {
            Text("None").tag(PageID?.none)
            ForEach(parentCandidates) { Text($0.page.displayTitle).tag(PageID?.some($0.id)) }
          }
          TextField("Tags, separated by commas", text: $tags)
          TextField("Estimate in minutes", text: $estimate)
        }

        TaskAssigneesSection(store: store, assigneeIDs: $draft.data.assigneeIDs)

        Section("Repeat") {
          Toggle("Repeats", isOn: hasRecurrenceBinding)
          if draft.data.recurrence != nil { TaskRecurrenceEditor(rule: recurrenceBinding) }
        }
      }
      .navigationTitle("Review Task")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { finish() }
            .disabled(draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
    .frame(minWidth: 360, minHeight: 540)
  }

  private var scheduledBinding: Binding<Date> {
    Binding(get: { draft.data.scheduledAt ?? Date() }, set: { draft.data.scheduledAt = $0 })
  }

  private var hasScheduledDateBinding: Binding<Bool> {
    Binding(
      get: { draft.data.scheduledAt != nil },
      set: { draft.data.setScheduleEnabled($0) }
    )
  }

  private var deadlineBinding: Binding<Date> {
    Binding(get: { draft.data.deadline ?? Date() }, set: { draft.data.deadline = $0 })
  }

  private var hasDeadlineBinding: Binding<Bool> {
    Binding(
      get: { draft.data.deadline != nil },
      set: { draft.data.setDeadlineEnabled($0) }
    )
  }

  private var reminderBinding: Binding<Date> {
    Binding(get: { draft.data.reminder ?? Date() }, set: { draft.data.reminder = $0 })
  }

  private var hasReminderBinding: Binding<Bool> {
    Binding(
      get: { draft.data.reminder != nil },
      set: { draft.data.setReminderEnabled($0) }
    )
  }

  private var recurrenceBinding: Binding<TaskRecurrenceRule> {
    Binding(
      get: { draft.data.recurrence ?? TaskRecurrenceRule() },
      set: { draft.data.recurrence = TaskTemporalPolicy.normalized($0) }
    )
  }

  private var hasRecurrenceBinding: Binding<Bool> {
    Binding(
      get: { draft.data.recurrence != nil },
      set: { draft.data.setRecurrenceEnabled($0) }
    )
  }

  private var parentCandidates: [TaskItem] {
    store.pages.compactMap(TaskItem.init(page:)).filter { $0.data.state == .active }
  }

  private func finish() {
    draft.data = TaskTemporalPolicy.normalized(draft.data)
    draft.data.tags = TaskData.normalizedTags(tags.split(separator: ",").map(String.init))
    draft.data.estimatedMinutes = Int(estimate).flatMap { $0 > 0 ? $0 : nil }
    onSave(draft)
    dismiss()
  }
}

private struct TaskSearchOverlay: View {
  let store: LibraryStore
  let query: String

  @State private var selectedTaskID: PageID?

  var body: some View {
    List(store.tasks(in: .search(query))) { task in
      TaskRow(store: store, task: task, open: { selectedTaskID = task.id })
    }
    .background(.background)
    .sheet(item: $selectedTaskID) { pageID in
      NavigationStack { TaskDetailScreen(store: store, pageID: pageID) }
    }
  }
}

private struct TaskNavigationLabel: View {
  let title: String
  let systemImage: String
  let count: Int?

  var body: some View {
    Label {
      HStack {
        Text(title)
        Spacer()
        if let count, count > 0 {
          Text(count, format: .number)
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
      }
    } icon: {
      Image(systemName: systemImage)
    }
  }
}

struct TaskCollectionDraft: Identifiable {
  enum Kind: Equatable {
    case project
    case area

    var title: String { self == .project ? "Project" : "Area" }
    var supertagID: SupertagID {
      self == .project ? BuiltInSupertags.project : BuiltInSupertags.area
    }
  }

  var id = UUID()
  var kind: Kind
}

struct TaskCollectionCreator: View {
  let store: LibraryStore
  let draft: TaskCollectionDraft

  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @FocusState private var isFocused: Bool

  var body: some View {
    NavigationStack {
      Form {
        TextField("\(draft.kind.title) name", text: $name)
          .focused($isFocused)
          .onSubmit(save)
      }
      .navigationTitle("New \(draft.kind.title)")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Create") { save() }
            .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
    .frame(minWidth: 320, minHeight: 180)
    .onAppear { isFocused = true }
  }

  private func save() {
    let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return }
    Task {
      if draft.kind == .project {
        _ = await store.createProject(title: title)
      } else {
        _ = await store.createTaggedPage(title: title, supertagID: draft.kind.supertagID)
      }
      dismiss()
    }
  }
}

private func apply(_ selection: TaskListSelection, to data: inout TaskData) {
  switch selection {
  case .smart(.today):
    if data.scheduledAt == nil {
      data.scheduledAt = Calendar.current.startOfDay(for: Date())
      data.scheduleGranularity = .dateOnly
    }
    data.placement = .anytime
  case .smart(.anytime), .smart(.upcoming):
    data.placement = .anytime
  case .smart(.someday):
    data.placement = .someday
    data.scheduledAt = nil
  case .smart(.inbox), .smart(.review), .smart(.logbook):
    break
  case .project(let id):
    data.projectID = id
    data.placement = .anytime
  case .area(let id):
    data.areaID = id
    data.placement = .anytime
  case .person(let id):
    data.assigneeIDs = TaskData.normalizedPageIDs(data.assigneeIDs + [id])
    data.placement = .anytime
  case .tag(let value):
    data.tags = TaskData.normalizedTags(data.tags + [value])
  case .search:
    break
  }
}

@MainActor
private func taskSelectionTitle(_ selection: TaskListSelection, store: LibraryStore) -> String {
  switch selection {
  case .smart(let list): list.title
  case .project(let id): store.page(id: id)?.displayTitle ?? "Project"
  case .area(let id): store.page(id: id)?.displayTitle ?? "Area"
  case .person(let id): store.personDisplayName(for: id) ?? "Person"
  case .tag(let value): value
  case .search: "Search"
  }
}

private func taskDateLabel(_ date: Date) -> String {
  let calendar = Calendar.current
  if calendar.isDateInToday(date) { return "Today" }
  if calendar.isDateInTomorrow(date) { return "Tomorrow" }
  if calendar.isDateInYesterday(date) { return "Yesterday" }
  return date.formatted(.dateTime.month(.abbreviated).day())
}
