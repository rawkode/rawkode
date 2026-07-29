import EnchiridionCore
import SwiftUI

struct MacDailyTaskContext: View {
  let store: LibraryStore
  let day: Date
  let openTask: (PageID) -> Void
  let flushBeforeChange: @MainActor () async -> Bool

  @State private var isExpanded = true
  @State private var captureDay: Date?
  @State private var draftTitle = ""
  @State private var captureError: String?
  @State private var isCreating = false
  @State private var deferSelection: MacDailyTaskDeferSelection?
  @State private var showsAllTasks = false
  @State private var allTasksPath: [PageID] = []
  @FocusState private var isCaptureFocused: Bool

  private let calendar = Calendar.current
  private let visibleLimit = 4

  var body: some View {
    let includesOverdue = calendar.isDateInToday(day)
    let tasks = store.tasks(on: day, includingOverdue: includesOverdue)
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Button {
          withAnimation(.easeInOut(duration: 0.15)) { isExpanded.toggle() }
        } label: {
          Label("Tasks", systemImage: "checkmark.circle")
            .font(.subheadline.weight(.semibold))
        }
        .buttonStyle(.plain)

        if !tasks.isEmpty {
          Text(tasks.count, format: .number)
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }

        Spacer(minLength: 8)

        if !tasks.isEmpty {
          Button("View All") { showsAllTasks = true }
            .buttonStyle(.link)
            .font(.caption)
        }

        Menu {
          Button(addForSelectedDayTitle, systemImage: "calendar.badge.plus") {
            beginCapture(on: day)
          }
          if !calendar.isDate(day, inSameDayAs: tomorrow) {
            Button("Plan Tomorrow", systemImage: "sunrise") {
              beginCapture(on: tomorrow)
            }
          }
        } label: {
          Label("Add Task", systemImage: "plus")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)

      if let captureDay {
        Divider()
        HStack(spacing: 8) {
          TextField(capturePrompt(for: captureDay), text: $draftTitle)
            .textFieldStyle(.plain)
            .focused($isCaptureFocused)
            .onSubmit(createTask)
          if isCreating {
            ProgressView().controlSize(.small)
          } else {
            Button("Add", systemImage: "arrow.up.circle.fill") { createTask() }
              .labelStyle(.iconOnly)
              .buttonStyle(.plain)
              .disabled(draftTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
          Button("Cancel", systemImage: "xmark") { cancelCapture() }
            .labelStyle(.iconOnly)
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)

        if let captureError {
          Text(captureError)
            .font(.caption)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
        }
      }

      if isExpanded, !tasks.isEmpty {
        Divider()
        ForEach(Array(tasks.prefix(visibleLimit))) { task in
          MacDailyTaskRow(
            task: task,
            selectedDay: day,
            open: { openTask(task.id) },
            complete: { complete(task) },
            deferToTomorrow: { deferToTomorrow(task) },
            chooseDate: {
              deferSelection = .init(task: task, initialDate: task.data.scheduledAt ?? day)
            }
          )
          if task.id != tasks.prefix(visibleLimit).last?.id { Divider().padding(.leading, 38) }
        }
      }
    }
    .background(.bar)
    .overlay(alignment: .bottom) { Divider() }
    .sheet(item: $deferSelection) { selection in
      MacDailyTaskDeferPicker(
        taskTitle: selection.task.page.displayTitle,
        initialDate: selection.initialDate,
        schedule: { date in deferTask(selection.task, to: date) }
      )
    }
    .sheet(isPresented: $showsAllTasks) {
      NavigationStack(path: $allTasksPath) {
        let tasks = store.tasks(on: day, includingOverdue: calendar.isDateInToday(day))
        List(tasks) { task in
          TaskRow(store: store, task: task, open: { allTasksPath.append(task.id) })
        }
        .navigationTitle(
          calendar.isDateInToday(day) ? "Today" : day.formatted(date: .long, time: .omitted)
        )
        .frame(minWidth: 480, minHeight: 420)
        .navigationDestination(for: PageID.self) { pageID in
          TaskDetailScreen(store: store, pageID: pageID)
        }
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") { showsAllTasks = false }
          }
        }
      }
    }
    .onChange(of: captureDay) { _, value in
      if value != nil { isCaptureFocused = true }
    }
  }

  private var tomorrow: Date {
    calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date())) ?? Date()
  }

  private var addForSelectedDayTitle: String {
    calendar.isDateInToday(day)
      ? "Add for Today"
      : "Add for \(day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))"
  }

  private func capturePrompt(for date: Date) -> String {
    calendar.isDateInTomorrow(date) ? "Task for tomorrow" : "Task for this day"
  }

  private func beginCapture(on date: Date) {
    draftTitle = ""
    captureError = nil
    captureDay = date
  }

  private func cancelCapture() {
    draftTitle = ""
    captureError = nil
    captureDay = nil
  }

  private func createTask() {
    guard let captureDay else { return }
    let draft = DailyTaskActions.draft(title: draftTitle, on: captureDay, calendar: calendar)
    guard !draft.title.isEmpty else { return }
    isCreating = true
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
      await store.completeTask(task.id)
    }
  }

  private func deferToTomorrow(_ task: TaskItem) {
    update(task, data: DailyTaskActions.deferredToTomorrow(task.data, calendar: calendar))
  }

  private func deferTask(_ task: TaskItem, to date: Date) {
    update(task, data: DailyTaskActions.deferred(task.data, to: date, calendar: calendar))
  }

  private func update(_ task: TaskItem, data: TaskData) {
    Task { @MainActor in
      guard await flushBeforeChange() else { return }
      await store.updateTask(pageID: task.id, data: data)
    }
  }
}

private struct MacDailyTaskRow: View {
  let task: TaskItem
  let selectedDay: Date
  let open: () -> Void
  let complete: () -> Void
  let deferToTomorrow: () -> Void
  let chooseDate: () -> Void

  var body: some View {
    HStack(spacing: 9) {
      Button("Complete \(task.page.displayTitle)", systemImage: "circle", action: complete)
        .labelStyle(.iconOnly)
        .buttonStyle(.plain)

      Button(action: open) {
        VStack(alignment: .leading, spacing: 2) {
          Text(task.page.displayTitle).lineLimit(1)
          Text(contextLabel)
            .font(.caption)
            .foregroundStyle(isOverdue ? .red : .secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)

      Menu {
        Button("Tomorrow", systemImage: "sunrise", action: deferToTomorrow)
        Button("Choose Date…", systemImage: "calendar", action: chooseDate)
      } label: {
        Label("Task Actions", systemImage: "ellipsis")
      }
      .menuStyle(.borderlessButton)
      .fixedSize()
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 7)
  }

  private var isOverdue: Bool {
    guard let deadline = task.data.deadline else { return false }
    return deadline < Calendar.current.startOfDay(for: selectedDay)
  }

  private var contextLabel: String {
    if isOverdue { return "Overdue" }
    if task.data.deadline != nil { return "Due" }
    if task.data.scheduleGranularity == .dateOnly { return "Scheduled" }
    return task.data.scheduledAt?.formatted(date: .omitted, time: .shortened) ?? "Scheduled"
  }
}

private struct MacDailyTaskDeferSelection: Identifiable {
  let task: TaskItem
  let initialDate: Date
  var id: PageID { task.id }
}

private struct MacDailyTaskDeferPicker: View {
  let taskTitle: String
  let schedule: (Date) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var date: Date

  init(taskTitle: String, initialDate: Date, schedule: @escaping (Date) -> Void) {
    self.taskTitle = taskTitle
    self.schedule = schedule
    _date = State(initialValue: initialDate)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Defer \(taskTitle)").font(.headline)
      DatePicker("Schedule Date", selection: $date, displayedComponents: .date)
        .datePickerStyle(.graphical)
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }
        Button("Schedule") {
          schedule(date)
          dismiss()
        }
        .keyboardShortcut(.defaultAction)
      }
    }
    .padding(18)
    .frame(width: 360)
  }
}
