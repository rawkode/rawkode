import EnchiridionCore
import SwiftUI

struct ProjectTaskListContent: View {
  let store: LibraryStore
  let projectID: PageID
  var query = ""
  let openTask: (PageID) -> Void

  @State private var planningDraft: ProjectPlanningDraft?
  @State private var subtaskParent: TaskItem?

  var body: some View {
    List {
      if let project, let data = project.projectData {
        Section("Outcome") {
          Button {
            planningDraft = .init(project: project, data: data)
          } label: {
            VStack(alignment: .leading, spacing: 8) {
              if data.outcome.isEmpty {
                Label("Define the result this project should produce", systemImage: "scope")
                  .foregroundStyle(.secondary)
              } else {
                Text(data.outcome)
                  .foregroundStyle(.primary)
              }
              ProjectPlanMetadata(data: data)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .accessibilityHint("Edits this project's outcome, status, and dates")
        }
      }

      Section("Tasks") {
        if rows.isEmpty {
          ContentUnavailableView(
            query.isEmpty ? "No next actions" : "No matching tasks",
            systemImage: "checklist",
            description: Text(
              query.isEmpty
                ? "Add a task, then use Add Subtask to break work into smaller actions."
                : "Try a different search."
            )
          )
          .listRowSeparator(.hidden)
        } else {
          ForEach(rows) { row in
            TaskRow(store: store, task: row.task, open: { openTask(row.id) })
              .padding(.leading, CGFloat(row.depth) * 18)
              .accessibilityValue(
                row.depth == 0 ? "Top-level task" : "Subtask level \(row.depth)"
              )
              .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button {
                  Task { await store.completeTask(row.id) }
                } label: {
                  Label("Complete", systemImage: "checkmark")
                }
                .tint(.green)
              }
              .contextMenu {
                Button("Add Subtask", systemImage: "arrow.turn.down.right") {
                  subtaskParent = row.task
                }
                Button("Complete", systemImage: "checkmark.circle") {
                  Task { await store.completeTask(row.id) }
                }
                Button("Cancel", systemImage: "xmark.circle", role: .destructive) {
                  Task { await store.cancelTask(row.id) }
                }
              }
          }
        }
      }
    }
    .listStyle(.inset)
    .sheet(item: $planningDraft) { draft in
      ProjectPlanningEditor(store: store, draft: draft)
    }
    .sheet(item: $subtaskParent) { parent in
      ProjectSubtaskCreator(store: store, projectID: projectID, parent: parent)
    }
  }

  private var project: PageSnapshot? {
    store.page(id: projectID)
  }

  private var rows: [TaskHierarchyRow] {
    let tasks = store.tasks(in: .project(projectID))
    let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let visible =
      value.isEmpty
      ? tasks
      : tasks.filter {
        $0.page.displayTitle.localizedStandardContains(value)
          || $0.page.plainText.localizedStandardContains(value)
          || $0.data.tags.contains { $0.localizedStandardContains(value) }
      }
    return TaskHierarchy.rows(from: visible)
  }
}

struct WeeklyReviewContent: View {
  let store: LibraryStore

  @State private var planningDraft: ProjectPlanningDraft?

  var body: some View {
    let review = store.weeklyReview()
    List {
      Section("Clear the decks") {
        LabeledContent("Inbox", value: "\(review.inboxTaskCount) tasks")
        LabeledContent("Overdue", value: "\(review.overdueTaskCount) tasks")
        Text("Clarify the inbox and reschedule or complete overdue work before reviewing projects.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Section("Projects") {
        if review.projects.isEmpty {
          ContentUnavailableView(
            "No open projects",
            systemImage: "folder",
            description: Text("Create a project when a result needs more than one action.")
          )
          .listRowSeparator(.hidden)
        } else {
          ForEach(review.projects) { item in
            HStack(alignment: .center, spacing: 12) {
              Button {
                planningDraft = .init(
                  project: item.project,
                  data: item.data,
                  marksReviewedOnSave: true
                )
              } label: {
                ProjectReviewRow(item: item)
                  .contentShape(.rect)
              }
              .buttonStyle(.plain)

              Button {
                markReviewed(item)
              } label: {
                Label("Mark \(item.project.displayTitle) reviewed", systemImage: "checkmark.circle")
                  .labelStyle(.iconOnly)
              }
              .buttonStyle(.borderless)
              .accessibilityHint("Records this project as reviewed today")
            }
          }
        }
      }
    }
    .listStyle(.inset)
    .sheet(item: $planningDraft) { draft in
      ProjectPlanningEditor(store: store, draft: draft)
    }
  }

  private func markReviewed(_ item: ProjectReviewItem) {
    var data = item.data
    data.lastReviewedAt = Date()
    Task { await store.updateProject(pageID: item.id, data: data) }
  }
}

private struct ProjectReviewRow: View {
  let item: ProjectReviewItem

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Text(item.project.displayTitle)
          .font(.headline)
        Text(item.data.status.title)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Text(item.data.outcome.isEmpty ? "Outcome not defined" : item.data.outcome)
        .foregroundStyle(item.data.outcome.isEmpty ? .secondary : .primary)
        .lineLimit(2)

      HStack(spacing: 12) {
        Label("\(item.activeTaskCount) active", systemImage: "checklist")
        if item.overdueTaskCount > 0 {
          Label("\(item.overdueTaskCount) overdue", systemImage: "exclamationmark.circle")
            .foregroundStyle(.orange)
        }
        if item.needsReview {
          Label("Review needed", systemImage: "clock.arrow.circlepath")
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 3)
    .accessibilityElement(children: .combine)
  }
}

private struct ProjectPlanMetadata: View {
  let data: ProjectData

  var body: some View {
    HStack(spacing: 12) {
      Label(data.status.title, systemImage: "circle.dotted")
      if let dueDate = data.dueDate {
        Label(dueDate.formatted(date: .abbreviated, time: .omitted), systemImage: "flag")
      }
      if let lastReviewedAt = data.lastReviewedAt {
        Label(
          lastReviewedAt.formatted(.relative(presentation: .named)), systemImage: "checkmark.circle"
        )
      }
    }
    .font(.caption)
    .foregroundStyle(.secondary)
  }
}

struct ProjectPlanningDraft: Identifiable {
  var project: PageSnapshot
  var data: ProjectData
  var marksReviewedOnSave = false
  var id: PageID { project.id }
}

private struct ProjectPlanningEditor: View {
  let store: LibraryStore
  let draft: ProjectPlanningDraft

  @Environment(\.dismiss) private var dismiss
  @State private var data: ProjectData
  @State private var hasStartDate: Bool
  @State private var hasDueDate: Bool
  @State private var isSaving = false

  init(store: LibraryStore, draft: ProjectPlanningDraft) {
    self.store = store
    self.draft = draft
    _data = State(initialValue: draft.data)
    _hasStartDate = State(initialValue: draft.data.startDate != nil)
    _hasDueDate = State(initialValue: draft.data.dueDate != nil)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("Plan") {
          TextField("Outcome", text: $data.outcome, axis: .vertical)
            .lineLimit(2...6)
          Picker("Status", selection: $data.status) {
            ForEach(ProjectStatus.allCases, id: \.self) { status in
              Text(status.title).tag(status)
            }
          }
          Picker("Area", selection: $data.areaID) {
            Text("None").tag(PageID?.none)
            ForEach(store.taskAreas) { area in
              Text(area.displayTitle).tag(PageID?.some(area.id))
            }
          }
        }

        Section("Dates") {
          Toggle("Start date", isOn: $hasStartDate)
          if hasStartDate {
            DatePicker("Start", selection: startDateBinding, displayedComponents: .date)
          }
          Toggle("Due date", isOn: $hasDueDate)
          if hasDueDate {
            DatePicker("Due", selection: dueDateBinding, displayedComponents: .date)
          }
        }

        if let lastReviewedAt = data.lastReviewedAt {
          Section("Review") {
            LabeledContent(
              "Last reviewed",
              value: lastReviewedAt.formatted(date: .abbreviated, time: .shortened)
            )
          }
        }
      }
      .navigationTitle(draft.project.displayTitle)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save Project") { save() }
            .disabled(isSaving)
        }
      }
    }
    .frame(minWidth: 360, minHeight: 420)
  }

  private var startDateBinding: Binding<Date> {
    Binding(get: { data.startDate ?? Date() }, set: { data.startDate = $0 })
  }

  private var dueDateBinding: Binding<Date> {
    Binding(get: { data.dueDate ?? Date() }, set: { data.dueDate = $0 })
  }

  private func save() {
    if !hasStartDate { data.startDate = nil }
    if !hasDueDate { data.dueDate = nil }
    if draft.marksReviewedOnSave { data.lastReviewedAt = Date() }
    isSaving = true
    Task {
      await store.updateProject(pageID: draft.project.id, data: data)
      isSaving = false
      dismiss()
    }
  }
}

private struct ProjectSubtaskCreator: View {
  let store: LibraryStore
  let projectID: PageID
  let parent: TaskItem

  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var notes = ""
  @State private var isSaving = false
  @FocusState private var isFocused: Bool

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Subtask", text: $title)
            .focused($isFocused)
            .onSubmit(save)
          TextField("Notes", text: $notes, axis: .vertical)
            .lineLimit(2...6)
        } footer: {
          Text("Added beneath \(parent.page.displayTitle).")
        }
      }
      .navigationTitle("New Subtask")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Add Subtask") { save() }
            .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
        }
      }
    }
    .frame(minWidth: 340, minHeight: 240)
    .onAppear { isFocused = true }
  }

  private func save() {
    let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedTitle.isEmpty else { return }
    isSaving = true
    let data = TaskData(
      placement: parent.data.placement,
      projectID: projectID,
      areaID: parent.data.areaID,
      parentTaskID: parent.id
    )
    Task {
      _ = await store.createTask(TaskDraft(title: normalizedTitle, notes: notes, data: data))
      isSaving = false
      dismiss()
    }
  }
}
