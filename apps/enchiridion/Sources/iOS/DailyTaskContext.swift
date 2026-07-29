import EnchiridionCore
import SwiftUI

/// A small task affordance above the daily editor. The note remains the main
/// workspace; this context only carries work that belongs to the selected day.
struct DailyTaskContext: View {
  let store: LibraryStore
  let day: Date
  let includingOverdue: Bool
  let openTask: (PageID) -> Void
  let viewAll: () -> Void
  let flushBeforeChange: @MainActor () async -> Bool

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var isExpanded = true
  @State private var captureDay: Date?
  @State private var draftTitle = ""
  @State private var captureError: String?
  @State private var isCreating = false
  @State private var deferSelection: DailyTaskDeferSelection?
  @FocusState private var isCaptureFocused: Bool

  private let visibleLimit = 3
  private let calendar = Calendar.current

  var body: some View {
    let tasks = store.tasks(on: day, includingOverdue: includingOverdue)
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        if tasks.isEmpty {
          Label("Tasks", systemImage: "checkmark.circle")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
        } else {
          Button {
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.18)) {
              isExpanded.toggle()
            }
          } label: {
            HStack(spacing: 8) {
              Image(systemName: "checkmark.circle")
                .foregroundStyle(.tint)
              Text("Tasks")
                .font(.subheadline.weight(.semibold))
              Text(tasks.count, format: .number)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
              Image(systemName: "chevron.down")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .rotationEffect(isExpanded ? .zero : .degrees(-90))
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(isExpanded ? "Collapse daily tasks" : "Expand daily tasks")
        }

        Spacer(minLength: 8)

        Menu {
          Button {
            beginCapture(on: day)
          } label: {
            Label(addForSelectedDayTitle, systemImage: "calendar.badge.plus")
          }
          if !calendar.isDate(day, inSameDayAs: tomorrow) {
            Button {
              beginCapture(on: tomorrow)
            } label: {
              Label("Plan tomorrow", systemImage: "sunrise")
            }
          }
          if !tasks.isEmpty {
            Divider()
            Button("View All Tasks", systemImage: "list.bullet", action: viewAll)
          }
        } label: {
          Label("Task actions", systemImage: "plus")
            .frame(width: 44, height: 44)
            .contentShape(.rect)
        }
        .labelStyle(.iconOnly)
        .accessibilityHint("Add for this daily page, plan tomorrow, or view all tasks")
      }
      .padding(.horizontal, 16)

      if let captureDay {
        Divider().padding(.leading, 16)
        VStack(alignment: .leading, spacing: 5) {
          HStack(spacing: 8) {
            TextField(capturePrompt(for: captureDay), text: $draftTitle)
              .textFieldStyle(.plain)
              .submitLabel(.done)
              .focused($isCaptureFocused)
              .onSubmit(createTask)
            if isCreating {
              ProgressView().controlSize(.small)
            } else {
              Button("Add", systemImage: "arrow.up.circle.fill") { createTask() }
                .labelStyle(.iconOnly)
                .foregroundStyle(.tint)
                .frame(width: 44, height: 44)
                .contentShape(.rect)
                .disabled(draftTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Button("Cancel", systemImage: "xmark") { cancelCapture() }
              .labelStyle(.iconOnly)
              .foregroundStyle(.secondary)
              .frame(width: 44, height: 44)
              .contentShape(.rect)
          }
          if let captureError {
            Text(captureError)
              .font(.caption)
              .foregroundStyle(.red)
          }
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .padding(.vertical, 4)
      }

      if isExpanded, !tasks.isEmpty {
        Divider().padding(.leading, 16)
        VStack(spacing: 0) {
          ForEach(Array(tasks.prefix(visibleLimit))) { task in
            DailyTaskContextRow(
              store: store,
              task: task,
              selectedDay: day,
              open: { openTask(task.id) },
              complete: { complete(task) },
              deferToTomorrow: { deferTaskToTomorrow(task) },
              chooseDate: {
                deferSelection = DailyTaskDeferSelection(
                  task: task,
                  initialDate: task.data.scheduledAt ?? day
                )
              }
            )
            if task.id != tasks.prefix(visibleLimit).last?.id {
              Divider().padding(.leading, 50)
            }
          }
        }
        .transition(.opacity)

        if tasks.count > visibleLimit {
          Button("View \(tasks.count - visibleLimit) more") { viewAll() }
            .font(.caption.weight(.medium))
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.leading, 50)
            .buttonStyle(.plain)
            .foregroundStyle(.tint)
        }
      }
    }
    .overlay(alignment: .bottom) { Divider() }
    .accessibilityElement(children: .contain)
    .sheet(item: $deferSelection) { selection in
      DailyTaskDeferPicker(
        taskTitle: selection.task.page.displayTitle,
        initialDate: selection.initialDate,
        deferTask: { date in deferTask(selection.task, to: date) }
      )
    }
    .onChange(of: captureDay) { _, value in
      if value != nil { isCaptureFocused = true }
    }
    .onChange(of: tasks.isEmpty) { _, isEmpty in
      if isEmpty { isExpanded = false }
    }
  }

  private var tomorrow: Date {
    calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date())) ?? Date()
  }

  private var addForSelectedDayTitle: String {
    if calendar.isDateInToday(day) { return "Add for today" }
    return "Add for \(day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))"
  }

  private func capturePrompt(for day: Date) -> String {
    calendar.isDateInTomorrow(day) ? "Task for tomorrow" : "Task for this day"
  }

  private func beginCapture(on day: Date) {
    captureError = nil
    draftTitle = ""
    captureDay = day
  }

  private func cancelCapture() {
    captureDay = nil
    draftTitle = ""
    captureError = nil
  }

  private func createTask() {
    guard let captureDay else { return }
    let draft = DailyTaskActions.draft(title: draftTitle, on: captureDay, calendar: calendar)
    guard !draft.title.isEmpty else { return }
    isCreating = true
    captureError = nil
    Task { @MainActor in
      guard await flushBeforeChange() else {
        isCreating = false
        captureError = "Finish the current edit before adding a task."
        return
      }
      if await store.createTask(draft) != nil {
        cancelCapture()
      } else {
        captureError = store.startupError ?? "The task could not be added."
      }
      isCreating = false
    }
  }

  private func complete(_ task: TaskItem) {
    Task { @MainActor in
      guard await flushBeforeChange() else { return }
      await store.completeTaskOfferingUndo(task.id)
    }
  }

  private func deferTaskToTomorrow(_ task: TaskItem) {
    let data = DailyTaskActions.deferredToTomorrow(task.data, calendar: calendar)
    update(task, with: data)
  }

  private func deferTask(_ task: TaskItem, to date: Date) {
    let data = DailyTaskActions.deferred(task.data, to: date, calendar: calendar)
    update(task, with: data)
  }

  private func update(_ task: TaskItem, with data: TaskData) {
    Task { @MainActor in
      guard await flushBeforeChange() else { return }
      await store.updateTask(pageID: task.id, data: data)
    }
  }
}

private struct DailyTaskContextRow: View {
  let store: LibraryStore
  let task: TaskItem
  let selectedDay: Date
  let open: () -> Void
  let complete: () -> Void
  let deferToTomorrow: () -> Void
  let chooseDate: () -> Void

  private let calendar = Calendar.current

  var body: some View {
    HStack(alignment: .center, spacing: 6) {
      Button {
        complete()
      } label: {
        Image(systemName: "circle")
          .font(.title3)
          .foregroundStyle(.secondary)
          .frame(width: 44, height: 44)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Complete \(task.page.displayTitle)")

      Button(action: open) {
        VStack(alignment: .leading, spacing: 3) {
          Text(task.page.displayTitle)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.primary)
            .lineLimit(1)

          if !contextLabels.isEmpty {
            HStack(spacing: 8) {
              ForEach(contextLabels, id: \.text) { label in
                Label(label.text, systemImage: label.symbol)
                  .foregroundStyle(label.isUrgent ? Color.red : Color.secondary)
              }
            }
            .font(.caption)
            .lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityHint("Open task")

      Menu {
        Button("Tomorrow", systemImage: "sunrise", action: deferToTomorrow)
        Button("Choose date…", systemImage: "calendar", action: chooseDate)
      } label: {
        Label("Task actions", systemImage: "ellipsis")
          .frame(width: 44, height: 44)
          .contentShape(.rect)
      }
      .labelStyle(.iconOnly)
      .buttonStyle(.plain)
      .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 2)
  }

  private var contextLabels: [ContextLabel] {
    var labels: [ContextLabel] = []
    let selectedInterval = calendar.dateInterval(of: .day, for: selectedDay)

    if let scheduledAt = task.data.scheduledAt {
      let isEarlier = selectedInterval.map { scheduledAt < $0.start } == true
      if isEarlier {
        labels.append(ContextLabel(text: "Scheduled earlier", symbol: "calendar", isUrgent: false))
      } else if task.data.scheduleGranularity == .dateOnly {
        labels.append(ContextLabel(text: "Scheduled", symbol: "calendar", isUrgent: false))
      } else {
        labels.append(
          ContextLabel(
            text: scheduledAt.formatted(date: .omitted, time: .shortened),
            symbol: "calendar",
            isUrgent: false
          )
        )
      }
    }

    if let deadline = task.data.deadline {
      let isOverdue = selectedInterval.map { deadline < $0.start } == true
      labels.append(
        ContextLabel(
          text: isOverdue ? "Overdue" : "Due",
          symbol: "flag",
          isUrgent: isOverdue
        )
      )
    }
    let assigneeNames = task.data.assigneeIDs.compactMap { store.personDisplayName(for: $0) }
    if !assigneeNames.isEmpty {
      let visibleNames = assigneeNames.prefix(2).joined(separator: ", ")
      let remaining = assigneeNames.count - min(assigneeNames.count, 2)
      labels.append(
        ContextLabel(
          text: remaining > 0 ? "\(visibleNames) +\(remaining)" : visibleNames,
          symbol: "person.2",
          isUrgent: false
        )
      )
    }
    return labels
  }
}

private struct ContextLabel: Hashable {
  let text: String
  let symbol: String
  let isUrgent: Bool
}

private struct DailyTaskDeferSelection: Identifiable {
  let task: TaskItem
  let initialDate: Date

  var id: PageID { task.id }
}

private struct DailyTaskDeferPicker: View {
  let taskTitle: String
  let deferTask: (Date) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var date: Date

  init(taskTitle: String, initialDate: Date, deferTask: @escaping (Date) -> Void) {
    self.taskTitle = taskTitle
    self.deferTask = deferTask
    _date = State(initialValue: initialDate)
  }

  var body: some View {
    NavigationStack {
      DatePicker("Schedule date", selection: $date, displayedComponents: .date)
        .datePickerStyle(.graphical)
        .labelsHidden()
        .padding()
        .navigationTitle("Defer Task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { dismiss() }
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Schedule") {
              deferTask(date)
              dismiss()
            }
          }
        }
    }
    .presentationDetents([.medium])
    .accessibilityLabel("Choose a new date for \(taskTitle)")
  }
}

struct DailyTaskListScreen: View {
  let store: LibraryStore
  let day: Date
  let includingOverdue: Bool

  @State private var editingTaskID: PageID?

  var body: some View {
    let tasks = store.tasks(on: day, includingOverdue: includingOverdue)
    List {
      if tasks.isEmpty {
        ContentUnavailableView(
          "All clear",
          systemImage: "checkmark.circle",
          description: Text("Nothing is scheduled or due for this day.")
        )
        .listRowSeparator(.hidden)
      } else {
        ForEach(tasks) { task in
          TaskRow(store: store, task: task, open: { editingTaskID = task.id })
        }
      }
    }
    .listStyle(.inset)
    .navigationTitle(navigationTitle)
    .sheet(item: $editingTaskID) { pageID in
      NavigationStack { TaskDetailScreen(store: store, pageID: pageID) }
    }
  }

  private var navigationTitle: String {
    if Calendar.current.isDateInToday(day) { return "Today" }
    return day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
  }
}
