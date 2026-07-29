import EnchiridionCore
import SwiftUI

struct MobileTaskHomeScreen: View {
  let store: LibraryStore
  @Binding var requestedSelection: TaskListSelection?

  @State private var query = ""
  @State private var path: [TaskListSelection] = []
  @State private var showsQuickCapture = false
  @State private var collectionDraft: TaskCollectionDraft?

  var body: some View {
    NavigationStack(path: $path) {
      List {
        Section {
          ForEach(TaskSmartList.allCases) { list in
            NavigationLink(value: TaskListSelection.smart(list)) {
              TaskNavigationLabel(
                title: list.title,
                systemImage: list.systemImage,
                count: badgeCount(for: list)
              )
            }
          }
        }

        if !store.taskProjects.isEmpty {
          Section("Projects") {
            ForEach(store.taskProjects) { project in
              NavigationLink(value: TaskListSelection.project(project.id)) {
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
              NavigationLink(value: TaskListSelection.area(area.id)) {
                TaskNavigationLabel(
                  title: area.displayTitle,
                  systemImage: "square.grid.2x2",
                  count: store.tasks(in: .area(area.id)).count
                )
              }
            }
          }
        }

        if !store.taskTags.isEmpty {
          Section("Tags") {
            ForEach(store.taskTags, id: \.self) { tag in
              NavigationLink(value: TaskListSelection.tag(tag)) {
                TaskNavigationLabel(
                  title: tag,
                  systemImage: "tag",
                  count: store.tasks(in: .tag(tag)).count
                )
              }
            }
          }
        }
      }
      .navigationTitle("Tasks")
      .searchable(text: $query, prompt: "Search tasks")
      .overlay {
        if !query.isEmpty {
          TaskSearchOverlay(store: store, query: query)
        }
      }
      .navigationDestination(for: TaskListSelection.self) { selection in
        TaskListScreen(store: store, selection: selection)
      }
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Button { showsQuickCapture = true } label: {
            Label("New Task", systemImage: "plus")
          }
          .accessibilityHint("Opens quick entry with natural date, priority, repeat, and tag syntax.")
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
      .onChange(of: requestedSelection) { _, selection in
        guard let selection else { return }
        path = [selection]
        requestedSelection = nil
      }
    }
  }

  private func badgeCount(for list: TaskSmartList) -> Int? {
    switch list {
    case .logbook, .anytime, .someday: nil
    case .inbox, .today, .upcoming: store.taskCount(list)
    }
  }
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
    .safeAreaInset(edge: .bottom, spacing: 0) {
      TaskQuickEntryBar(store: store, selection: selection)
    }
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button { showsQuickCapture = true } label: {
          Label("New Task", systemImage: "plus")
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
}

struct TaskListContent: View {
  let store: LibraryStore
  let selection: TaskListSelection
  var query = ""
  let openTask: (PageID) -> Void

  var body: some View {
    let tasks = visibleTasks
    List {
      if tasks.isEmpty {
        ContentUnavailableView(
          emptyTitle,
          systemImage: emptySymbol,
          description: Text(emptyDescription)
        )
        .listRowSeparator(.hidden)
      } else if case .smart(.upcoming) = selection {
        ForEach(groupedUpcoming, id: \.day) { group in
          Section(group.day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())) {
            taskRows(group.tasks)
          }
        }
      } else {
        taskRows(tasks)
      }
    }
    .listStyle(.inset)
  }

  @ViewBuilder
  private func taskRows(_ tasks: [TaskItem]) -> some View {
    ForEach(tasks) { task in
      TaskRow(store: store, task: task, open: { openTask(task.id) })
        .padding(.leading, task.data.parentTaskID == nil ? 0 : 18)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
          if task.data.state == .active {
            Button {
              Task { await store.completeTask(task.id) }
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
        .contextMenu {
          if task.data.state == .active {
            Button("Complete", systemImage: "checkmark.circle") {
              Task { await store.completeTask(task.id) }
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

  private var visibleTasks: [TaskItem] {
    let tasks = store.tasks(in: selection)
    let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return tasks }
    return tasks.filter {
      $0.page.displayTitle.localizedStandardContains(value)
        || $0.page.plainText.localizedStandardContains(value)
        || $0.data.tags.contains { $0.localizedStandardContains(value) }
    }
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
    if case .smart(.logbook) = selection { return "No completed tasks" }
    return "All clear"
  }

  private var emptySymbol: String {
    if case .smart(.inbox) = selection { return "tray" }
    return "checkmark.circle"
  }

  private var emptyDescription: String {
    if case .smart(.inbox) = selection { return "Capture something as soon as it crosses your mind." }
    if case .smart(.today) = selection { return "Nothing is scheduled or due today." }
    return "No tasks match this list."
  }
}

private struct TaskRow: View {
  let store: LibraryStore
  let task: TaskItem
  let open: () -> Void

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 11) {
      Button {
        Task {
          if task.data.state == .active {
            await store.completeTask(task.id)
          } else {
            await store.reopenTask(task.id)
          }
        }
      } label: {
        Image(systemName: completionSymbol)
          .font(.title3)
          .foregroundStyle(completionColor)
          .contentTransition(.symbolEffect(.replace))
      }
      .buttonStyle(.plain)
      .accessibilityLabel(task.data.state == .active ? "Complete \(task.page.displayTitle)" : "Reopen \(task.page.displayTitle)")

      Button(action: open) {
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
      .buttonStyle(.plain)
    }
    .padding(.vertical, 4)
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
      || !task.data.tags.isEmpty
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

  @Environment(\.dismiss) private var dismiss
  @State private var showsDetails = false

  var body: some View {
    PageEditorView(store: store, pageID: pageID)
      .toolbar {
        ToolbarItemGroup(placement: .primaryAction) {
          Button { showsDetails = true } label: {
            Label("Task Details", systemImage: "checklist")
          }
          if let data = store.page(id: pageID)?.taskData {
            Button {
              Task {
                if data.state == .active {
                  await store.completeTask(pageID)
                } else {
                  await store.reopenTask(pageID)
                }
              }
            } label: {
              Label(data.state == .active ? "Complete" : "Reopen", systemImage: data.state == .active ? "checkmark.circle" : "arrow.uturn.backward")
            }
          }
        }
      }
      .sheet(isPresented: $showsDetails) {
        if let page = store.page(id: pageID), let data = page.taskData {
          TaskMetadataEditor(store: store, page: page, initialData: data)
        }
      }
  }
}

private struct TaskMetadataEditor: View {
  let store: LibraryStore
  let page: PageSnapshot

  @Environment(\.dismiss) private var dismiss
  @State private var data: TaskData
  @State private var hasScheduledDate: Bool
  @State private var hasDeadline: Bool
  @State private var hasReminder: Bool
  @State private var hasRecurrence: Bool
  @State private var tags: String
  @State private var estimate: String
  @State private var isSaving = false

  init(store: LibraryStore, page: PageSnapshot, initialData: TaskData) {
    self.store = store
    self.page = page
    _data = State(initialValue: initialData)
    _hasScheduledDate = State(initialValue: initialData.scheduledAt != nil)
    _hasDeadline = State(initialValue: initialData.deadline != nil)
    _hasReminder = State(initialValue: initialData.reminder != nil)
    _hasRecurrence = State(initialValue: initialData.recurrence != nil)
    _tags = State(initialValue: initialData.tags.joined(separator: ", "))
    _estimate = State(initialValue: initialData.estimatedMinutes.map(String.init) ?? "")
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("Status", selection: $data.state) {
            Text("Open").tag(TaskState.active)
            Text("Completed").tag(TaskState.completed)
            Text("Canceled").tag(TaskState.canceled)
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

        Section("Dates") {
          Toggle("Schedule", isOn: $hasScheduledDate)
          if hasScheduledDate {
            DatePicker(
              "When",
              selection: scheduledBinding,
              displayedComponents: [.date, .hourAndMinute]
            )
          }
          Toggle("Deadline", isOn: $hasDeadline)
          if hasDeadline {
            DatePicker("Deadline", selection: deadlineBinding, displayedComponents: .date)
          }
          Toggle("Reminder", isOn: $hasReminder)
          if hasReminder {
            DatePicker(
              "Remind me",
              selection: reminderBinding,
              displayedComponents: [.date, .hourAndMinute]
            )
          }
        }

        Section("Organize") {
          Picker("Project", selection: $data.projectID) {
            Text("None").tag(PageID?.none)
            ForEach(store.taskProjects) { project in
              Text(project.displayTitle).tag(PageID?.some(project.id))
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
          TextField("Estimate in minutes", text: $estimate)
        }

        Section("Repeat") {
          Toggle("Repeats", isOn: $hasRecurrence)
          if hasRecurrence {
            TaskRecurrenceEditor(rule: recurrenceBinding)
          }
        }
      }
      .navigationTitle("Task Details")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { save() }
            .disabled(isSaving)
        }
      }
    }
    .frame(minWidth: 340, minHeight: 480)
  }

  private var scheduledBinding: Binding<Date> {
    Binding(get: { data.scheduledAt ?? Date() }, set: { data.scheduledAt = $0 })
  }

  private var deadlineBinding: Binding<Date> {
    Binding(get: { data.deadline ?? Date() }, set: { data.deadline = $0 })
  }

  private var reminderBinding: Binding<Date> {
    Binding(get: { data.reminder ?? Date() }, set: { data.reminder = $0 })
  }

  private var recurrenceBinding: Binding<TaskRecurrenceRule> {
    Binding(
      get: { data.recurrence ?? TaskRecurrenceRule() },
      set: { data.recurrence = $0 }
    )
  }

  private var parentCandidates: [TaskItem] {
    store.pages.compactMap(TaskItem.init(page:)).filter {
      $0.id != page.id && $0.data.state == .active
    }
  }

  private func save() {
    isSaving = true
    if !hasScheduledDate { data.scheduledAt = nil }
    if !hasDeadline { data.deadline = nil }
    if !hasReminder { data.reminder = nil }
    if !hasRecurrence { data.recurrence = nil }
    data.tags = TaskData.normalizedTags(tags.split(separator: ",").map(String.init))
    data.estimatedMinutes = Int(estimate).flatMap { $0 > 0 ? $0 : nil }
    if data.state == .active {
      data.completedAt = nil
    } else if data.completedAt == nil {
      data.completedAt = Date()
    }
    Task {
      await store.updateTask(pageID: page.id, data: data)
      isSaving = false
      dismiss()
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
    Picker("Unit", selection: $rule.unit) {
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
}

struct TaskQuickEntryBar: View {
  let store: LibraryStore
  let selection: TaskListSelection

  @State private var entry = ""
  @FocusState private var isFocused: Bool
  @State private var isSaving = false

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "plus.circle.fill")
        .foregroundStyle(.tint)
        .accessibilityHidden(true)
      TextField("New task", text: $entry)
        .textFieldStyle(.plain)
        .focused($isFocused)
        .submitLabel(.done)
        .onSubmit(save)
        .accessibilityHint("Try tomorrow, by tomorrow, every weekday, hash tags, or exclamation high.")
      if isSaving { ProgressView().controlSize(.small) }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(.bar)
  }

  private func save() {
    guard !entry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !isSaving else { return }
    isSaving = true
    let value = entry
    Task {
      var draft = QuickTaskParser.parse(value).draft
      apply(selection, to: &draft.data)
      if await store.createTask(draft) != nil { entry = "" }
      isSaving = false
      isFocused = true
    }
  }
}

struct TaskQuickCaptureSheet: View {
  let store: LibraryStore
  let selection: TaskListSelection

  @Environment(\.dismiss) private var dismiss
  @State private var entry = ""
  @State private var isSaving = false
  @FocusState private var isFocused: Bool

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("What needs doing?", text: $entry, axis: .vertical)
            .lineLimit(2...5)
            .focused($isFocused)
            .submitLabel(.done)
            .onSubmit(save)
        } footer: {
          Text("Try “Prepare brief tomorrow #work !high every weekday”.")
        }

        if !preview.recognizedTokens.isEmpty {
          Section("Recognized") {
            ScrollView(.horizontal) {
              HStack {
                ForEach(preview.recognizedTokens, id: \.self) { token in
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
      }
      .navigationTitle("New Task")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Add") { save() }
            .disabled(entry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
        }
      }
    }
    .frame(minWidth: 360, minHeight: 260)
    .onAppear { isFocused = true }
  }

  private var preview: QuickTaskParseResult { QuickTaskParser.parse(entry) }

  private func save() {
    guard !entry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !isSaving else { return }
    isSaving = true
    var draft = preview.draft
    apply(selection, to: &draft.data)
    Task {
      if await store.createTask(draft) != nil { dismiss() }
      isSaving = false
    }
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
    var supertagID: SupertagID { self == .project ? BuiltInSupertags.project : BuiltInSupertags.area }
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
      _ = await store.createTaggedPage(title: title, supertagID: draft.kind.supertagID)
      dismiss()
    }
  }
}

private func apply(_ selection: TaskListSelection, to data: inout TaskData) {
  switch selection {
  case .smart(.today):
    if data.scheduledAt == nil { data.scheduledAt = Calendar.current.startOfDay(for: Date()) }
    data.placement = .anytime
  case .smart(.anytime), .smart(.upcoming):
    data.placement = .anytime
  case .smart(.someday):
    data.placement = .someday
    data.scheduledAt = nil
  case .smart(.inbox), .smart(.logbook):
    break
  case .project(let id):
    data.projectID = id
    data.placement = .anytime
  case .area(let id):
    data.areaID = id
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
