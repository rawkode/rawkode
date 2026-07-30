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
        Button("Dismiss Error") { selection.errorMessage = nil }
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
        .taskWorkbenchActionControl("Complete selected tasks")
      } else if allSelectedTasksAreClosed {
        Button {
          perform { await actions.reopen($0) }
        } label: {
          Label("Reopen", systemImage: "arrow.uturn.backward.circle")
        }
        .taskWorkbenchActionControl("Reopen selected tasks")
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
      .taskWorkbenchActionControl("Opens scheduling options for selected tasks")

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
        Menu("Tags", systemImage: "tag") {
          Button("Add Tags…", systemImage: "plus") {
            editor = .tags(
              operation: .add,
              initialValues: selectedTagIntersection,
              candidates: selectedTagUnion,
              hasMixedValues: commonTags == nil
            )
          }
          Button("Remove Tags…", systemImage: "minus") {
            editor = .tags(
              operation: .remove,
              initialValues: [],
              candidates: selectedTagUnion,
              hasMixedValues: commonTags == nil
            )
          }
          .disabled(selectedTagUnion.isEmpty)
          Button("Replace All Tags…", systemImage: "arrow.triangle.2.circlepath") {
            editor = .tags(
              operation: .replaceAll,
              initialValues: commonTags ?? [],
              candidates: selectedTagUnion,
              hasMixedValues: commonTags == nil
            )
          }
        }
        Menu("Assignees", systemImage: "person.2") {
          Button("Add Assignees…", systemImage: "person.badge.plus") {
            editor = .assignees(
              operation: .add,
              initialValues: selectedAssigneeIDIntersection,
              candidates: selectedAssigneeIDUnion,
              hasMixedValues: commonAssigneeIDs == nil
            )
          }
          Button("Remove Assignees…", systemImage: "person.badge.minus") {
            editor = .assignees(
              operation: .remove,
              initialValues: [],
              candidates: selectedAssigneeIDUnion,
              hasMixedValues: commonAssigneeIDs == nil
            )
          }
          .disabled(selectedAssigneeIDUnion.isEmpty)
          Button("Replace All Assignees…", systemImage: "arrow.triangle.2.circlepath") {
            editor = .assignees(
              operation: .replaceAll,
              initialValues: commonAssigneeIDs ?? [],
              candidates: selectedAssigneeIDUnion,
              hasMixedValues: commonAssigneeIDs == nil
            )
          }
        }
      } label: {
        Label("Edit", systemImage: "slider.horizontal.3")
      }
      .taskWorkbenchActionControl("Opens editing options for selected tasks")

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
      .taskWorkbenchActionControl("Opens more actions for selected tasks")

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
          taskCount: selection.selectedCount,
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

  private var selectedTagUnion: [String] {
    TaskData.normalizedTags(selectedTasks.flatMap(\.data.tags))
  }

  private var selectedTagIntersection: [String] {
    guard let first = selectedTasks.first else { return [] }
    let shared = selectedTasks.dropFirst().reduce(into: Set(first.data.tags)) { result, task in
      result.formIntersection(task.data.tags)
    }
    return TaskData.normalizedTags(Array(shared))
  }

  private var commonAssigneeIDs: Set<PageID>? {
    guard let first = selectedTasks.first.map({ Set($0.data.assigneeIDs) }),
      selectedTasks.dropFirst().allSatisfy({ Set($0.data.assigneeIDs) == first })
    else { return nil }
    return first
  }

  private var selectedAssigneeIDUnion: Set<PageID> {
    Set(selectedTasks.flatMap(\.data.assigneeIDs))
  }

  private var selectedAssigneeIDIntersection: Set<PageID> {
    guard let first = selectedTasks.first else { return [] }
    return selectedTasks.dropFirst().reduce(into: Set(first.data.assigneeIDs)) { result, task in
      result.formIntersection(task.data.assigneeIDs)
    }
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

private struct TaskWorkbenchActionControlModifier: ViewModifier {
  let helpText: String

  func body(content: Content) -> some View {
    #if os(macOS)
      content.help(helpText)
    #else
      content
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityHint(helpText)
    #endif
  }
}

extension View {
  fileprivate func taskWorkbenchActionControl(_ helpText: String) -> some View {
    modifier(TaskWorkbenchActionControlModifier(helpText: helpText))
  }
}

private enum TaskWorkbenchMetadataOperation: String {
  case add
  case remove
  case replaceAll

  var title: String {
    switch self {
    case .add: "Add"
    case .remove: "Remove"
    case .replaceAll: "Replace All"
    }
  }
}

private enum TaskWorkbenchEditor: Identifiable {
  case schedule(Date?, includesTime: Bool, isMixed: Bool)
  case deadline(Date?, isMixed: Bool)
  case tags(
    operation: TaskWorkbenchMetadataOperation,
    initialValues: [String],
    candidates: [String],
    hasMixedValues: Bool
  )
  case assignees(
    operation: TaskWorkbenchMetadataOperation,
    initialValues: Set<PageID>,
    candidates: Set<PageID>,
    hasMixedValues: Bool
  )

  var id: String {
    switch self {
    case .schedule: "schedule"
    case .deadline: "deadline"
    case .tags(let operation, _, _, _): "tags-\(operation.rawValue)"
    case .assignees(let operation, _, _, _): "assignees-\(operation.rawValue)"
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
  let taskCount: Int
  let apply: (TaskMetadataPatch) -> Void

  @State private var tagsText: String
  @State private var selectedTags: Set<String>
  @State private var assigneeIDs: Set<PageID>
  @State private var replacementConfirmed = false
  @State private var includesOtherPeople = false
  private let operation: TaskWorkbenchMetadataOperation
  private let initialTags: [String]
  private let initialAssigneeIDs: Set<PageID>
  private let tagCandidates: [String]
  private let assigneeCandidates: Set<PageID>
  private let hadMixedValues: Bool

  init(
    editor: TaskWorkbenchEditor,
    store: LibraryStore,
    taskCount: Int,
    apply: @escaping (TaskMetadataPatch) -> Void
  ) {
    self.editor = editor
    self.store = store
    self.taskCount = taskCount
    self.apply = apply
    switch editor {
    case .tags(let operation, let initialValues, let candidates, let hasMixedValues):
      self.operation = operation
      initialTags = TaskData.normalizedTags(initialValues)
      initialAssigneeIDs = []
      tagCandidates = TaskData.normalizedTags(candidates)
      assigneeCandidates = []
      _tagsText = State(
        initialValue: operation == .replaceAll ? initialTags.joined(separator: ", ") : ""
      )
      _selectedTags = State(initialValue: [])
      _assigneeIDs = State(initialValue: [])
      hadMixedValues = hasMixedValues
    case .assignees(let operation, let initialValues, let candidates, let hasMixedValues):
      self.operation = operation
      initialTags = []
      initialAssigneeIDs = initialValues
      tagCandidates = []
      assigneeCandidates = candidates
      _tagsText = State(initialValue: "")
      _selectedTags = State(initialValue: [])
      _assigneeIDs = State(initialValue: operation == .replaceAll ? initialValues : [])
      hadMixedValues = hasMixedValues
    case .schedule, .deadline:
      operation = .add
      initialTags = []
      initialAssigneeIDs = []
      tagCandidates = []
      assigneeCandidates = []
      _tagsText = State(initialValue: "")
      _selectedTags = State(initialValue: [])
      _assigneeIDs = State(initialValue: [])
      hadMixedValues = false
    }
  }

  var body: some View {
    NavigationStack {
      Form {
        switch editor {
        case .tags:
          if operation == .remove {
            if tagCandidates.isEmpty {
              ContentUnavailableView(
                "No Tags to Remove",
                systemImage: "tag.slash",
                description: Text("The selected tasks do not have any tags.")
              )
            } else {
              Section("Tags on Selected Tasks") {
                ForEach(tagCandidates, id: \.self) { tag in
                  Toggle(tag, isOn: tagBinding(tag))
                }
              }
            }
          } else {
            Section {
              TextField("Tags, separated by commas", text: $tagsText)
            } footer: {
              Text(tagOperationExplanation)
            }
          }
          replacementWarning(for: "tags")
        case .assignees:
          if operation != .remove, !store.otherPeople.isEmpty {
            Section {
              Toggle("Include Other People", isOn: $includesOtherPeople)
            } footer: {
              Text(
                "Other people remain hidden from normal views and mentions until promoted, but can still be assigned here."
              )
            }
          }
          if people.isEmpty {
            ContentUnavailableView(
              operation == .remove ? "No Assignees to Remove" : "No People Available",
              systemImage: "person.2",
              description: Text(peopleUnavailableDescription)
            )
          } else {
            Section(operation == .remove ? "Assigned People" : "People") {
              ForEach(people) { person in
                Toggle(isOn: assigneeBinding(person.id)) {
                  HStack(alignment: .firstTextBaseline, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                      Text(store.personDisplayName(for: person))
                      if let detail = personDetail(person) {
                        Text(detail)
                          .font(.caption)
                          .foregroundStyle(.secondary)
                          .lineLimit(1)
                      }
                    }
                    Spacer(minLength: 8)
                    if person.isOtherPerson {
                      Text("Other")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                    }
                  }
                }
                .accessibilityLabel(personAccessibilityLabel(person))
              }
            }
          }
          replacementWarning(for: "assignees")
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
          Button(confirmationTitle) {
            apply(patch)
            dismiss()
          }
          .disabled(!canApply)
          .accessibilityLabel(confirmationAccessibilityLabel)
        }
      }
    }
    .presentationDetents([.medium, .large])
    .onChange(of: includesOtherPeople) { _, includesOthers in
      guard !includesOthers else { return }
      let requiredIDs = operation == .add ? Set<PageID>() : assigneeCandidates
      let hiddenOtherIDs = Set(store.otherPeople.map(\.id)).subtracting(requiredIDs)
      assigneeIDs.subtract(hiddenOtherIDs)
    }
  }

  private var title: String {
    if case .tags = editor { return "\(operation.title) Tags" }
    return "\(operation.title) Assignees"
  }

  private var people: [PageSnapshot] {
    var seen: Set<PageID> = []
    let requiredIDs = operation == .add ? Set<PageID>() : assigneeCandidates
    let candidates =
      store.taskPeople(includingOtherPeople: includesOtherPeople)
      + requiredIDs.compactMap { store.page(id: $0) }
    return candidates.filter {
      seen.insert($0.id).inserted && (operation != .add || !initialAssigneeIDs.contains($0.id))
    }.sorted {
      let leftName = store.personDisplayName(for: $0)
      let rightName = store.personDisplayName(for: $1)
      let nameComparison = leftName.localizedStandardCompare(rightName)
      if nameComparison != .orderedSame { return nameComparison == .orderedAscending }
      let detailComparison =
        (personDetail($0) ?? "").localizedStandardCompare(personDetail($1) ?? "")
      if detailComparison != .orderedSame { return detailComparison == .orderedAscending }
      return $0.id.rawValue < $1.id.rawValue
    }
  }

  private var normalizedTags: [String] {
    TaskData.normalizedTags(
      tagsText.split(separator: ",").map {
        String($0).trimmingCharacters(in: .whitespacesAndNewlines)
      }
    )
  }

  private var tagOperand: [String] {
    operation == .add
      ? normalizedTags.filter { !initialTags.contains($0) }
      : normalizedTags
  }

  private var canApply: Bool {
    switch operation {
    case .add:
      return isTagEditor
        ? !tagOperand.isEmpty
        : !assigneeIDs.subtracting(initialAssigneeIDs).isEmpty
    case .remove:
      return isTagEditor ? !selectedTags.isEmpty : !assigneeIDs.isEmpty
    case .replaceAll:
      if hadMixedValues { return replacementConfirmed }
      return isTagEditor
        ? normalizedTags != initialTags
        : assigneeIDs != initialAssigneeIDs
    }
  }

  private var isTagEditor: Bool {
    if case .tags = editor { return true }
    return false
  }

  private var tagOperationExplanation: String {
    switch operation {
    case .add: "These tags are added without removing tags already on a task."
    case .remove: ""
    case .replaceAll: "This becomes the complete tag list for every selected task."
    }
  }

  private var peopleUnavailableDescription: String {
    switch operation {
    case .add:
      "Promote or include someone who is not already assigned to every selected task."
    case .replaceAll: "Promote a person or include Other People to assign them."
    case .remove: "The selected tasks do not have any assignees."
    }
  }

  private var confirmationTitle: String {
    operation == .replaceAll ? "Replace All" : "Apply"
  }

  private var confirmationAccessibilityLabel: String {
    let values = isTagEditor ? "tags" : "assignees"
    let tasks = taskCount == 1 ? "1 task" : "\(taskCount) tasks"
    return switch operation {
    case .add: "Add \(values) to \(tasks)"
    case .remove: "Remove \(values) from \(tasks)"
    case .replaceAll: "Replace all \(values) on \(tasks)"
    }
  }

  @ViewBuilder
  private func replacementWarning(for valueName: String) -> some View {
    if operation == .replaceAll, hadMixedValues {
      Section {
        Toggle("Confirm Replace All", isOn: $replacementConfirmed)
      } footer: {
        let taskScope =
          taskCount == 1 ? "This task has" : "These \(taskCount) tasks have"
        Text(
          "\(taskScope) different \(valueName). Replace All removes every existing value before applying this selection."
        )
      }
    }
  }

  private func personAccessibilityLabel(_ person: PageSnapshot) -> String {
    var parts = [store.personDisplayName(for: person)]
    if let detail = personDetail(person) { parts.append(detail) }
    if person.isOtherPerson { parts.append("Other person") }
    return parts.joined(separator: ", ")
  }

  private func personDetail(_ person: PageSnapshot) -> String? {
    if let contact = store.contactLinks[person.id]?.record {
      let role = [nonBlank(contact.jobTitle), nonBlank(contact.organizationName)]
        .compactMap { $0 }
        .joined(separator: " at ")
      let email = contact.emails.lazy.compactMap(nonBlank).first ?? personEmail(person)
      let details = [nonBlank(role), email].compactMap { $0 }
      return details.isEmpty ? nil : details.joined(separator: " · ")
    }
    return personEmail(person)
  }

  private func personEmail(_ person: PageSnapshot) -> String? {
    for (key, values) in person.objectMetadata.properties
    where key.supertagID == BuiltInSupertags.person && key.fieldID.rawValue == "email" {
      for value in values {
        if case .email(let email) = value, let email = nonBlank(email) { return email }
      }
    }
    return nil
  }

  private func nonBlank(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private func tagBinding(_ tag: String) -> Binding<Bool> {
    Binding(
      get: { selectedTags.contains(tag) },
      set: { isSelected in
        if isSelected { selectedTags.insert(tag) } else { selectedTags.remove(tag) }
      }
    )
  }

  private func assigneeBinding(_ pageID: PageID) -> Binding<Bool> {
    Binding(
      get: { assigneeIDs.contains(pageID) },
      set: { isSelected in
        if isSelected { assigneeIDs.insert(pageID) } else { assigneeIDs.remove(pageID) }
      }
    )
  }

  private var patch: TaskMetadataPatch {
    switch editor {
    case .tags:
      let tags = operation == .remove ? Array(selectedTags) : tagOperand
      let tagPatch: TaskTagCollectionPatch =
        switch operation {
        case .add: .add(tags)
        case .remove: .remove(tags)
        case .replaceAll: .replace(tags)
        }
      return .init(tagPatch: tagPatch)
    case .assignees:
      let operand =
        operation == .add ? assigneeIDs.subtracting(initialAssigneeIDs) : assigneeIDs
      let values = operand.sorted { $0.rawValue < $1.rawValue }
      let assigneePatch: TaskAssigneeCollectionPatch =
        switch operation {
        case .add: .add(values)
        case .remove: .remove(values)
        case .replaceAll: .replace(values)
        }
      return .init(assigneePatch: assigneePatch)
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
