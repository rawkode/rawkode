import EnchiridionCore
import SwiftUI

struct TaskWorkbenchSelection: Equatable {
  var isSelecting = false
  var selectedTaskIDs: Set<PageID> = []
  var isApplying = false
  var selectionLimitReached = false
  var undoPresentation: TaskWorkbenchUndoPresentation?
  var errorMessage: String?

  var selectedCount: Int { selectedTaskIDs.count }

  var presentsActions: Bool {
    #if os(iOS)
      isSelecting
    #else
      !selectedTaskIDs.isEmpty
    #endif
  }

  mutating func beginSelection() {
    isSelecting = true
  }

  mutating func cancelSelection() {
    isSelecting = false
    selectedTaskIDs.removeAll()
    selectionLimitReached = false
  }

  mutating func selectAll(_ taskIDs: some Sequence<PageID>) {
    let ordered = Array(taskIDs)
    selectedTaskIDs = Set(ordered.prefix(LibraryRepository.maximumTaskBatchSize))
    selectionLimitReached = ordered.count > LibraryRepository.maximumTaskBatchSize
  }

  mutating func updateSelection(_ proposed: Set<PageID>) {
    guard proposed.count > LibraryRepository.maximumTaskBatchSize else {
      selectedTaskIDs = proposed
      selectionLimitReached = false
      return
    }
    let retained = selectedTaskIDs.intersection(proposed)
    let capacity = LibraryRepository.maximumTaskBatchSize - retained.count
    let additions = proposed.subtracting(retained).sorted { $0.rawValue < $1.rawValue }
    selectedTaskIDs = retained.union(additions.prefix(max(0, capacity)))
    selectionLimitReached = true
  }

  mutating func reconcile(visibleTaskIDs: Set<PageID>) {
    selectedTaskIDs.formIntersection(visibleTaskIDs)
    if selectedTaskIDs.count < LibraryRepository.maximumTaskBatchSize {
      selectionLimitReached = false
    }
  }
}

struct TaskWorkbenchUndoPresentation: Identifiable, Equatable {
  let id = UUID()
  let receipt: TaskBatchUndoReceipt
  let taskCount: Int

  var message: String {
    if receipt.entries.allSatisfy({ $0.operation == .trash }) {
      return taskCount == 1 ? "Task moved to Trash" : "\(taskCount) tasks moved to Trash"
    }
    return taskCount == 1 ? "Task updated" : "\(taskCount) tasks updated"
  }
}

@MainActor
struct TaskWorkbenchActions {
  var complete: ([PageID]) async -> TaskBatchMutationResult?
  var reopen: ([PageID]) async -> TaskBatchMutationResult?
  var cancel: ([PageID]) async -> TaskBatchMutationResult?
  var trash: ([PageID]) async -> TaskBatchMutationResult?
  var patch: ([PageID], TaskMetadataPatch) async -> TaskBatchMutationResult?
  var undo: (TaskBatchUndoReceipt) async -> TaskBatchUndoResult?
  var failureMessage: () -> String?

  init(
    complete: @escaping ([PageID]) async -> TaskBatchMutationResult?,
    reopen: @escaping ([PageID]) async -> TaskBatchMutationResult?,
    cancel: @escaping ([PageID]) async -> TaskBatchMutationResult?,
    trash: @escaping ([PageID]) async -> TaskBatchMutationResult?,
    patch: @escaping ([PageID], TaskMetadataPatch) async -> TaskBatchMutationResult?,
    undo: @escaping (TaskBatchUndoReceipt) async -> TaskBatchUndoResult?,
    failureMessage: @escaping () -> String? = { nil }
  ) {
    self.complete = complete
    self.reopen = reopen
    self.cancel = cancel
    self.trash = trash
    self.patch = patch
    self.undo = undo
    self.failureMessage = failureMessage
  }

  static func live(store: LibraryStore) -> Self {
    Self(
      complete: { await store.completeTasks($0) },
      reopen: { await store.reopenTasks($0) },
      cancel: { await store.cancelTasks($0) },
      trash: { await store.trashTasks($0) },
      patch: { await store.patchTasks($0, patch: $1) },
      undo: { await store.undoTaskBatch($0) },
      failureMessage: { store.startupError }
    )
  }
}

enum TaskListContentSource: Hashable {
  case list(TaskListSelection)
  case perspective(LiveQueryID)

  var listSelection: TaskListSelection? {
    guard case .list(let selection) = self else { return nil }
    return selection
  }
}

struct TaskWorkbenchList<Content: View>: View {
  @Binding var selection: TaskWorkbenchSelection
  @ViewBuilder let content: Content

  init(
    selection: Binding<TaskWorkbenchSelection>,
    @ViewBuilder content: () -> Content
  ) {
    _selection = selection
    self.content = content()
  }

  var body: some View {
    List(selection: listSelection) {
      content
    }
    #if os(iOS)
      .environment(\.editMode, editMode)
    #endif
  }

  private var listSelection: Binding<Set<PageID>>? {
    let bounded = Binding(
      get: { selection.selectedTaskIDs },
      set: { selection.updateSelection($0) }
    )
    #if os(iOS)
      return selection.isSelecting ? bounded : nil
    #else
      return bounded
    #endif
  }

  #if os(iOS)
    private var editMode: Binding<EditMode> {
      Binding(
        get: { selection.isSelecting ? .active : .inactive },
        set: { mode in
          if mode.isEditing {
            selection.beginSelection()
          } else {
            selection.cancelSelection()
          }
        }
      )
    }
  #endif
}

struct TaskWorkbenchChrome: ViewModifier {
  @Binding var selection: TaskWorkbenchSelection
  let visibleTaskIDs: [PageID]
  let actions: TaskWorkbenchActions

  func body(content: Content) -> some View {
    content
      .toolbar { selectionToolbar }
      .safeAreaInset(edge: .bottom, spacing: 8) {
        if let undo = selection.undoPresentation {
          TaskWorkbenchUndoBanner(
            presentation: undo,
            isApplying: selection.isApplying,
            undo: { performUndo(undo) },
            dismiss: { selection.undoPresentation = nil }
          )
          .padding(.horizontal)
          .transition(.move(edge: .bottom).combined(with: .opacity))
        }
      }
      .alert(
        "Couldn’t Update Tasks",
        isPresented: Binding(
          get: { selection.errorMessage != nil },
          set: { isPresented in
            if !isPresented { selection.errorMessage = nil }
          }
        )
      ) {
        Button("OK") { selection.errorMessage = nil }
      } message: {
        Text(selection.errorMessage ?? "The selected tasks were not changed.")
      }
      .onChange(of: Set(visibleTaskIDs)) { _, visibleIDs in
        selection.reconcile(visibleTaskIDs: visibleIDs)
      }
  }

  @ToolbarContentBuilder
  private var selectionToolbar: some ToolbarContent {
    #if os(iOS)
      ToolbarItem(placement: .secondaryAction) {
        Button(selection.isSelecting ? "Cancel" : "Select") {
          if selection.isSelecting {
            selection.cancelSelection()
          } else {
            selection.beginSelection()
          }
        }
        .disabled(visibleTaskIDs.isEmpty || selection.isApplying)
        .accessibilityHint(
          selection.isSelecting
            ? "Leaves task selection mode" : "Selects multiple tasks for batch actions"
        )
      }
      if selection.isSelecting {
        ToolbarItem(placement: .secondaryAction) {
          Button(
            visibleTaskIDs.count > LibraryRepository.maximumTaskBatchSize
              ? "Select First \(LibraryRepository.maximumTaskBatchSize)" : "Select All"
          ) {
            selection.selectAll(visibleTaskIDs)
          }
          .disabled(visibleTaskIDs.isEmpty || selection.isApplying)
          .accessibilityHint("Selects visible tasks for batch actions")
        }
      }
    #else
      ToolbarItem(placement: .secondaryAction) {
        Menu {
          Button(
            visibleTaskIDs.count > LibraryRepository.maximumTaskBatchSize
              ? "Select First \(LibraryRepository.maximumTaskBatchSize)" : "Select All",
            systemImage: "checkmark.circle"
          ) {
            selection.selectAll(visibleTaskIDs)
          }
          .disabled(visibleTaskIDs.isEmpty)
          Button("Clear Selection", systemImage: "xmark.circle") {
            selection.cancelSelection()
          }
          .disabled(selection.selectedTaskIDs.isEmpty)
        } label: {
          Label("Task Selection", systemImage: "checkmark.circle")
        }
        .help("Select tasks for batch actions")
        .disabled(selection.isApplying)
      }
    #endif

    if selection.presentsActions {
      ToolbarItem(placement: .status) {
        VStack(alignment: .trailing, spacing: 1) {
          Text(selection.selectedCount, format: .number)
            .monospacedDigit()
          if selection.selectionLimitReached {
            Text("100 task limit")
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
          selection.selectionLimitReached
            ? "\(selection.selectedCount) tasks selected, maximum 100"
            : "\(selection.selectedCount) tasks selected"
        )
      }
    }
  }

  private func performUndo(_ presentation: TaskWorkbenchUndoPresentation) {
    guard !selection.isApplying else { return }
    selection.isApplying = true
    Task { @MainActor in
      let result = await actions.undo(presentation.receipt)
      selection.isApplying = false
      if result != nil {
        withAnimation { selection.undoPresentation = nil }
      } else {
        selection.errorMessage =
          actions.failureMessage()
          ?? "The tasks changed after this action, so Undo was not applied."
      }
    }
  }
}

extension View {
  func taskWorkbenchChrome(
    selection: Binding<TaskWorkbenchSelection>,
    visibleTaskIDs: [PageID],
    actions: TaskWorkbenchActions
  ) -> some View {
    modifier(
      TaskWorkbenchChrome(
        selection: selection,
        visibleTaskIDs: visibleTaskIDs,
        actions: actions
      )
    )
  }
}

struct TaskWorkbenchActionBar: View {
  @Binding var selection: TaskWorkbenchSelection
  let store: LibraryStore
  let selectedTasks: [TaskItem]
  let actions: TaskWorkbenchActions

  @State private var editor: TaskWorkbenchEditor?
  @State private var isConfirmingTrash = false

  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 1) {
        Text(selection.selectedCount, format: .number)
          .font(.headline.monospacedDigit())
          .contentTransition(.numericText())
        if selection.selectionLimitReached {
          Text("Maximum 100")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel(
        selection.selectionLimitReached
          ? "\(selection.selectedCount) tasks selected, maximum 100"
          : "\(selection.selectedCount) tasks selected"
      )

      Divider().frame(height: 24)

      if allSelectedTasksAreActive {
        Button {
          perform { await actions.complete($0) }
        } label: {
          Label("Complete", systemImage: "checkmark.circle")
        }
      } else if allSelectedTasksAreClosed {
        Button {
          perform { await actions.reopen($0) }
        } label: {
          Label("Reopen", systemImage: "arrow.uturn.backward.circle")
        }
      }

      Menu {
        Button("Today", systemImage: "sun.max") {
          applyPatch(
            .init(
              schedule: .dateOnly(Calendar.current.startOfDay(for: Date())),
              placement: .anytime
            )
          )
        }
        Button("Tomorrow", systemImage: "sunrise") {
          let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
          applyPatch(
            .init(
              schedule: .dateOnly(Calendar.current.startOfDay(for: tomorrow)),
              placement: .anytime
            )
          )
        }
        Button("Choose Date…", systemImage: "calendar") {
          editor = .schedule(
            commonScheduledAt,
            includesTime: commonScheduleIncludesTime,
            isMixed: selectedScheduleValuesAreMixed
          )
        }
        Divider()
        Button("Clear Schedule", systemImage: "calendar.badge.minus") {
          applyPatch(.init(schedule: .clear))
        }
      } label: {
        Label("Schedule", systemImage: "calendar")
      }

      Menu {
        Menu("Deadline", systemImage: "flag") {
          Button("Choose Deadline…", systemImage: "calendar") {
            editor = .deadline(commonDeadline, isMixed: selectedDeadlinesAreMixed)
          }
          Button("Clear Deadline", systemImage: "flag.slash") {
            applyPatch(.init(deadline: .clear))
          }
        }

        Menu("Priority", systemImage: "exclamationmark") {
          ForEach(TaskPriority.allCases, id: \.self) { priority in
            Button(priority.title) {
              applyPatch(.init(priority: priority))
            }
          }
        }

        Menu("List", systemImage: "tray") {
          ForEach(TaskPlacement.allCases, id: \.self) { placement in
            Button(placement.title) {
              applyPatch(
                .init(
                  schedule: placement == .someday ? .clear : .unchanged,
                  placement: placement
                )
              )
            }
          }
        }

        Menu("Project", systemImage: "folder") {
          Button("No Project", systemImage: "xmark") {
            applyPatch(.init(project: .clear))
          }
          if !openProjects.isEmpty { Divider() }
          ForEach(openProjects) { project in
            Button(projectMenuTitle(project)) {
              applyPatch(
                .init(
                  placement: .anytime,
                  project: .set(project.id),
                  area: project.projectData?.areaID.map(TaskPageReferencePatch.set)
                    ?? .unchanged
                )
              )
            }
          }
        }

        Menu("Area", systemImage: "square.grid.2x2") {
          Button("No Area", systemImage: "xmark") {
            applyPatch(.init(area: .clear))
          }
          .disabled(selectedTasksRequireProjectArea)
          if !store.taskAreas.isEmpty { Divider() }
          ForEach(store.taskAreas) { area in
            if areaConflictsWithSelectedProjects(area.id) {
              Button("\(area.displayTitle) — conflicts with project") {}
                .disabled(true)
            } else {
              Button(area.displayTitle) {
                applyPatch(.init(placement: .anytime, area: .set(area.id)))
              }
            }
          }
        }

        Divider()
        Button("Edit Tags…", systemImage: "tag") {
          editor = .tags(commonTags)
        }
        Button("Clear Tags", systemImage: "tag.slash") {
          applyPatch(.init(tags: []))
        }
        Button("Edit Assignees…", systemImage: "person.2") {
          editor = .assignees(commonAssigneeIDs)
        }
        Button("Clear Assignees", systemImage: "person.2.slash") {
          applyPatch(.init(assigneeIDs: []))
        }
      } label: {
        Label("Edit", systemImage: "slider.horizontal.3")
      }

      Menu {
        if !allSelectedTasksAreActive && !allSelectedTasksAreClosed {
          Text("Select only active or only closed tasks for a status change.")
        }
        if allSelectedTasksAreActive {
          Button("Cancel Tasks", systemImage: "xmark.circle", role: .destructive) {
            perform { await actions.cancel($0) }
          }
        }
        Button("Move to Trash", systemImage: "trash", role: .destructive) {
          isConfirmingTrash = true
        }
        Button("Clear Selection", systemImage: "xmark") {
          selection.cancelSelection()
        }
      } label: {
        Label("More", systemImage: "ellipsis.circle")
      }

      if selection.isApplying {
        ProgressView()
          .controlSize(.small)
          .accessibilityLabel("Updating selected tasks")
      }
    }
    .labelStyle(.iconOnly)
    .buttonStyle(.borderless)
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity)
    .background(.bar)
    .overlay(alignment: .top) { Divider() }
    .disabled(selection.selectedTaskIDs.isEmpty || selection.isApplying)
    .sheet(item: $editor) { editor in
      switch editor {
      case .schedule, .deadline:
        TaskWorkbenchDateSheet(editor: editor) { patch in
          applyPatch(patch)
        }
      case .tags, .assignees:
        TaskWorkbenchMetadataSheet(
          editor: editor,
          store: store,
          apply: applyPatch
        )
      }
    }
    .confirmationDialog(
      trashConfirmationTitle,
      isPresented: $isConfirmingTrash,
      titleVisibility: .visible
    ) {
      Button("Move to Trash", role: .destructive) {
        perform { await actions.trash($0) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("You can undo this action immediately.")
    }
  }

  private var allSelectedTasksAreActive: Bool {
    !selectedTasks.isEmpty && selectedTasks.allSatisfy { $0.data.state == .active }
  }

  private var allSelectedTasksAreClosed: Bool {
    !selectedTasks.isEmpty
      && selectedTasks.allSatisfy { TaskLifecycleScope.closed.contains($0.data.state) }
  }

  private var trashConfirmationTitle: String {
    selection.selectedCount == 1
      ? "Move this task to Trash?"
      : "Move \(selection.selectedCount) tasks to Trash?"
  }

  private var commonTags: [String]? {
    guard let first = selectedTasks.first?.data.tags,
      selectedTasks.dropFirst().allSatisfy({ $0.data.tags == first })
    else { return nil }
    return first
  }

  private var commonAssigneeIDs: Set<PageID>? {
    guard let first = selectedTasks.first.map({ Set($0.data.assigneeIDs) }),
      selectedTasks.dropFirst().allSatisfy({ Set($0.data.assigneeIDs) == first })
    else { return nil }
    return first
  }

  private var commonScheduledAt: Date? {
    guard let first = selectedTasks.first?.data.scheduledAt,
      selectedTasks.dropFirst().allSatisfy({ $0.data.scheduledAt == first })
    else { return nil }
    return first
  }

  private var commonScheduleIncludesTime: Bool {
    !selectedTasks.isEmpty
      && selectedTasks.allSatisfy { $0.data.scheduleGranularity == .dateTime }
  }

  private var selectedScheduleValuesAreMixed: Bool {
    guard let first = selectedTasks.first else { return false }
    return selectedTasks.dropFirst().contains {
      $0.data.scheduledAt != first.data.scheduledAt
        || $0.data.scheduleGranularity != first.data.scheduleGranularity
    }
  }

  private var commonDeadline: Date? {
    guard let first = selectedTasks.first?.data.deadline,
      selectedTasks.dropFirst().allSatisfy({ $0.data.deadline == first })
    else { return nil }
    return first
  }

  private var selectedDeadlinesAreMixed: Bool {
    guard let first = selectedTasks.first?.data.deadline else {
      return selectedTasks.dropFirst().contains { $0.data.deadline != nil }
    }
    return selectedTasks.dropFirst().contains { $0.data.deadline != first }
  }

  private var openProjects: [PageSnapshot] {
    store.taskProjects.filter { $0.projectData?.status.isOpen == true }
  }

  private var selectedProjectAreaIDs: Set<PageID> {
    Set(
      selectedTasks.compactMap { task in
        guard let projectID = task.data.projectID else { return nil }
        return store.page(id: projectID)?.projectData?.areaID
      }
    )
  }

  private var selectedTasksRequireProjectArea: Bool {
    !selectedProjectAreaIDs.isEmpty
  }

  private func areaConflictsWithSelectedProjects(_ areaID: PageID) -> Bool {
    selectedProjectAreaIDs.contains { $0 != areaID }
  }

  private func projectMenuTitle(_ project: PageSnapshot) -> String {
    guard let areaID = project.projectData?.areaID,
      let area = store.page(id: areaID)
    else { return project.displayTitle }
    return "\(project.displayTitle) — sets area to \(area.displayTitle)"
  }

  private func applyPatch(_ patch: TaskMetadataPatch) {
    perform { await actions.patch($0, patch) }
  }

  private func perform(
    _ mutation: @escaping ([PageID]) async -> TaskBatchMutationResult?
  ) {
    let taskIDs = selection.selectedTaskIDs.sorted { $0.rawValue < $1.rawValue }
    guard !taskIDs.isEmpty, !selection.isApplying else { return }
    selection.isApplying = true
    Task { @MainActor in
      let result = await mutation(taskIDs)
      selection.isApplying = false
      guard let result else {
        selection.errorMessage =
          actions.failureMessage() ?? "The selected tasks were not changed. Please try again."
        return
      }
      withAnimation {
        selection.undoPresentation = .init(
          receipt: result.undoReceipt,
          taskCount: result.tasks.count
        )
        selection.cancelSelection()
      }
    }
  }
}

private enum TaskWorkbenchEditor: Identifiable {
  case schedule(Date?, includesTime: Bool, isMixed: Bool)
  case deadline(Date?, isMixed: Bool)
  case tags([String]?)
  case assignees(Set<PageID>?)

  var id: String {
    switch self {
    case .schedule: "schedule"
    case .deadline: "deadline"
    case .tags: "tags"
    case .assignees: "assignees"
    }
  }

  var hasMixedDateValues: Bool {
    switch self {
    case .schedule(_, _, let isMixed), .deadline(_, let isMixed): isMixed
    case .tags, .assignees: false
    }
  }
}

private struct TaskWorkbenchDateSheet: View {
  @Environment(\.dismiss) private var dismiss

  let editor: TaskWorkbenchEditor
  let apply: (TaskMetadataPatch) -> Void

  @State private var date: Date
  @State private var includesTime: Bool

  init(
    editor: TaskWorkbenchEditor,
    apply: @escaping (TaskMetadataPatch) -> Void
  ) {
    self.editor = editor
    self.apply = apply
    switch editor {
    case .schedule(let date, let includesTime, _):
      _date = State(initialValue: date ?? Date())
      _includesTime = State(initialValue: includesTime)
    case .deadline(let date, _):
      _date = State(initialValue: date ?? Date())
      _includesTime = State(initialValue: false)
    case .tags, .assignees:
      _date = State(initialValue: Date())
      _includesTime = State(initialValue: false)
    }
  }

  var body: some View {
    NavigationStack {
      Form {
        if editor.hasMixedDateValues {
          Label(
            "Selected tasks have different values. Applying replaces them all.",
            systemImage: "exclamationmark.triangle"
          )
          .foregroundStyle(.secondary)
        }
        if case .schedule = editor {
          Toggle("Include Time", isOn: $includesTime)
        }
        DatePicker(
          dateTitle,
          selection: $date,
          displayedComponents: displayedComponents
        )
      }
      .navigationTitle(navigationTitle)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Apply") {
            apply(patch)
            dismiss()
          }
        }
      }
    }
    .presentationDetents([.medium])
  }

  private var patch: TaskMetadataPatch {
    switch editor {
    case .schedule:
      .init(
        schedule: includesTime
          ? .dateTime(date) : .dateOnly(Calendar.current.startOfDay(for: date)),
        placement: .anytime
      )
    case .deadline:
      .init(deadline: .set(Calendar.current.startOfDay(for: date)))
    case .tags, .assignees:
      .init()
    }
  }

  private var navigationTitle: String {
    if case .schedule = editor { return "Schedule Tasks" }
    return "Set Deadline"
  }

  private var dateTitle: String {
    if case .schedule = editor { return "Start" }
    return "Deadline"
  }

  private var displayedComponents: DatePickerComponents {
    if case .schedule = editor, includesTime { return [.date, .hourAndMinute] }
    return .date
  }
}

private struct TaskWorkbenchMetadataSheet: View {
  @Environment(\.dismiss) private var dismiss

  let editor: TaskWorkbenchEditor
  let store: LibraryStore
  let apply: (TaskMetadataPatch) -> Void

  @State private var tagsText: String
  @State private var assigneeIDs: Set<PageID>
  @State private var hasEdits = false
  @State private var replacementConfirmed = false
  @State private var includesOtherPeople = false
  private let hadMixedValues: Bool

  init(
    editor: TaskWorkbenchEditor,
    store: LibraryStore,
    apply: @escaping (TaskMetadataPatch) -> Void
  ) {
    self.editor = editor
    self.store = store
    self.apply = apply
    switch editor {
    case .tags(let tags):
      _tagsText = State(initialValue: tags?.joined(separator: ", ") ?? "")
      _assigneeIDs = State(initialValue: [])
      hadMixedValues = tags == nil
    case .assignees(let ids):
      _tagsText = State(initialValue: "")
      _assigneeIDs = State(initialValue: ids ?? [])
      hadMixedValues = ids == nil
    case .schedule, .deadline:
      _tagsText = State(initialValue: "")
      _assigneeIDs = State(initialValue: [])
      hadMixedValues = false
    }
  }

  var body: some View {
    NavigationStack {
      Form {
        switch editor {
        case .tags:
          TextField("Tags, separated by commas", text: $tagsText)
            .onChange(of: tagsText) { _, _ in hasEdits = true }
          if hadMixedValues && !hasEdits {
            Label("Selected tasks have different tags", systemImage: "exclamationmark.triangle")
              .foregroundStyle(.secondary)
          }
          Text("Applying replaces the tags on every selected task.")
            .font(.caption)
            .foregroundStyle(.secondary)
        case .assignees:
          Toggle("Include Other People", isOn: $includesOtherPeople)
          Text("Other people stay hidden from normal task mentions until you include them here.")
            .font(.caption)
            .foregroundStyle(.secondary)
          if people.isEmpty {
            ContentUnavailableView(
              "No People Available",
              systemImage: "person.2",
              description: Text("Promote a person before assigning them to tasks.")
            )
          } else {
            if hadMixedValues {
              Toggle("Replace all assignees", isOn: $replacementConfirmed)
              Text(
                "Selected tasks have different assignees. Replacement removes each task's existing assignees."
              )
              .font(.caption)
              .foregroundStyle(.secondary)
            }
            ForEach(people) { person in
              Toggle(
                store.personDisplayName(for: person),
                isOn: Binding(
                  get: { assigneeIDs.contains(person.id) },
                  set: { isSelected in
                    hasEdits = true
                    if isSelected {
                      assigneeIDs.insert(person.id)
                    } else {
                      assigneeIDs.remove(person.id)
                    }
                  }
                )
              )
              .disabled(hadMixedValues && !replacementConfirmed)
            }
          }
        case .schedule, .deadline:
          EmptyView()
        }
      }
      .navigationTitle(title)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Apply") {
            apply(patch)
            dismiss()
          }
          .disabled(
            hadMixedValues
              && (!hasEdits || (isAssigneeEditor && !replacementConfirmed))
          )
        }
      }
    }
    .presentationDetents([.medium, .large])
  }

  private var title: String {
    if case .tags = editor { return "Edit Tags" }
    return "Edit Assignees"
  }

  private var people: [PageSnapshot] {
    store.taskPeople(includingOtherPeople: includesOtherPeople)
  }

  private var isAssigneeEditor: Bool {
    if case .assignees = editor { return true }
    return false
  }

  private var patch: TaskMetadataPatch {
    switch editor {
    case .tags:
      let tags = tagsText.split(separator: ",").map {
        String($0).trimmingCharacters(in: .whitespacesAndNewlines)
      }
      return .init(tags: tags)
    case .assignees:
      return .init(assigneeIDs: assigneeIDs.sorted { $0.rawValue < $1.rawValue })
    case .schedule, .deadline:
      return .init()
    }
  }
}

private struct TaskWorkbenchUndoBanner: View {
  let presentation: TaskWorkbenchUndoPresentation
  let isApplying: Bool
  let undo: () -> Void
  let dismiss: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "checkmark.circle.fill")
        .foregroundStyle(.green)
        .accessibilityHidden(true)
      Text(presentation.message)
      Spacer(minLength: 8)
      Button("Undo", action: undo)
        .disabled(isApplying)
      Button(action: dismiss) {
        Label("Dismiss", systemImage: "xmark")
      }
      .labelStyle(.iconOnly)
      .accessibilityHint("Dismisses the task update confirmation")
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(.regularMaterial, in: Capsule())
    .shadow(radius: 8, y: 3)
    .accessibilityElement(children: .contain)
  }
}
