import SwiftUI

private enum TaskCollection: String, CaseIterable, Identifiable {
    case inbox = "Inbox", today = "Today", upcoming = "Upcoming", completed = "Completed"
    var id: String { rawValue }
    var symbol: String { switch self { case .inbox: "tray"; case .today: "sun.max"; case .upcoming: "calendar"; case .completed: "checkmark.circle" } }

}

struct TasksView: View {
    @ObservedObject var workspace: WorkspaceStore
    @ObservedObject var tasks: TasksStore
    @ObservedObject var session: NativeSession
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var collection: TaskCollection = .today
    @State private var query = ""
    @State private var editing: PendingTaskEdit?
    @AppStorage("enchiridionTheme", store: EnchiridionPreferences.store) private var theme: EnchiridionTheme = .dawn
    init(workspace: WorkspaceStore) { self.workspace = workspace; tasks = workspace.tasks; session = workspace.session }
    private var today: String { TaskDay.key(.now) }
    private var displayedTasks: [GraphTask] { projectTaskList(tasks: tasks.tasks, pending: tasks.pending) }
    private func pendingEdit(for task: GraphTask) -> PendingTaskEdit? {
        taskEdit(for: task, pending: tasks.pending)
    }
    private var visible: [GraphTask] {
        displayedTasks.filter { task in
            let matches = query.isEmpty || task.title.localizedCaseInsensitiveContains(query) || (pendingEdit(for: task)?.title.localizedCaseInsensitiveContains(query) == true)
            guard matches else { return false }
            if !query.isEmpty || pendingEdit(for: task)?.conflict == true { return true }
            switch collection {
            case .inbox: return task.status == "open" && task.dueDate == nil
            case .today: return task.status == "open" && (task.dueDate.map { $0 <= today } ?? false)
            case .upcoming: return task.status == "open" && (task.dueDate.map { $0 > today } ?? false)
            case .completed: return task.status == "completed"
            }
        }.sorted {
            let priority = ["high": 0, "medium": 1, "low": 2, "none": 3]
            return ($0.dueDate ?? "9999", priority[$0.priority] ?? 3, $0.title, $0.id) < ($1.dueDate ?? "9999", priority[$1.priority] ?? 3, $1.title, $1.id)
        }
    }
    var body: some View {
        List {
            if let error = tasks.error {
                Section {
                    Text(error).font(.callout).foregroundStyle(theme.secondary)
                    Button("Try again") { Task { await tasks.sync(); await tasks.refresh() } }.disabled(tasks.sending || tasks.loading)
                }
            }
            if tasks.loading && !tasks.hasLoaded && displayedTasks.isEmpty {
                ProgressView("Loading tasks…").listRowBackground(Color.clear)
            } else if visible.isEmpty {
                Section {
                    ContentUnavailableView {
                        Label(query.isEmpty ? (session.isConnected && tasks.hasLoaded ? "\(collection.rawValue) is clear" : "No saved tasks") : "No matching tasks", systemImage: collection.symbol)
                    } description: {
                        Text(query.isEmpty ? (tasks.canCreate ? "Add a task when you’re ready." : "Connect your account to add tasks.") : "Try another word. Search includes all task collections.")
                    }
                }.listRowBackground(Color.clear)
            } else {
                Section(query.isEmpty ? (collection == .today ? "Today & overdue" : collection.rawValue) : "Search results") {
                    ForEach(visible) { task in taskRow(task) }
                }
            }
            if !session.isConnected {
                Section {
                    Button("Account settings") { workspace.settingsPresented = true }
                } footer: {
                    Text(tasks.canCreate ? "Your tasks are saved on this device. Reconnect to sync changes." : "Connect your account to add and sync tasks.")
                }
            }
        }
        .scrollContentBackground(.hidden).background(theme.canvas).foregroundStyle(.primary).tint(theme.accent)
        .safeAreaInset(edge: .top, spacing: 0) {
            collectionPicker.padding(.horizontal, 16).padding(.vertical, 10)
                .background(theme.canvas)
        }
        .navigationTitle("Tasks")
        .searchable(text: $query, prompt: "Find a task")
        .toolbar {
            ToolbarItem { Button { editing = PendingTaskEdit(title: "", dueDate: collection == .today ? today : nil, priority: "none", status: "open") } label: { Label("New task", systemImage: "plus") }.accessibilityIdentifier("newTask").disabled(!tasks.canCreate) }
            ToolbarItem { if tasks.loading || tasks.sending { ProgressView() } }
        }
        .sheet(item: $editing) { edit in TaskEditor(tasks: tasks, initial: edit) }
        .task(id: session.accountID ?? workspace.vault.accountID) {
            tasks.bind(accountID: session.accountID ?? workspace.vault.accountID ?? (workspace.demo ? "tasks-demo" : nil))
            if workspace.demo { tasks.seedDemo() }
            await tasks.refresh()
        }
        .refreshable { await tasks.sync(); await tasks.refresh() }
    }
    @ViewBuilder private var collectionPicker: some View {
        if typeSize.isAccessibilitySize {
            Picker("Collection", selection: $collection) { ForEach(TaskCollection.allCases) { Text($0.rawValue).tag($0) } }.pickerStyle(.menu)
        } else {
            Picker("Collection", selection: $collection) { ForEach(TaskCollection.allCases) { Text($0.rawValue).tag($0) } }.pickerStyle(.segmented)
        }
    }
    private func displayDay(_ key: String) -> String {
        if key == today { return "Today" }
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        guard let date = formatter.date(from: key) else { return key }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
    private func taskRow(_ task: GraphTask) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 14) {
                Button {
                    var edit = editFor(task); edit.status = task.status == "completed" ? "open" : "completed"
                    let scope = tasks.scopeID
                    Task { _ = await tasks.save(edit, expectedScope: scope) }
                } label: {
                    Image(systemName: task.status == "completed" ? "checkmark.circle.fill" : "circle")
                        .font(.title2).frame(width: 44, height: 44)
                }.buttonStyle(.plain).disabled(pendingEdit(for: task) != nil)
                    .accessibilityLabel(task.status == "completed" ? "Reopen \(task.title)" : "Complete \(task.title)")
                Button { editing = editFor(task) } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(task.title).font(.body).foregroundStyle(.primary).strikethrough(task.status == "completed").multilineTextAlignment(.leading)
                        HStack {
                            if let due = task.dueDate { Text(due < today && task.status == "open" ? "Overdue · \(displayDay(due))" : displayDay(due)) }
                            if task.priority != "none" { Label(task.priority.capitalized, systemImage: "flag.fill") }
                        }.font(.caption).foregroundStyle(theme.secondary)
                    }.frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(pendingEdit(for: task) != nil)
            }
            if let edit = pendingEdit(for: task) {
                if edit.conflict {
                    DisclosureGroup("Couldn’t apply your changes") {
                        Text("Your changes: \(edit.title)")
                        Text("\(edit.dueDate.map(displayDay) ?? "No due date") · \(edit.priority.capitalized) priority · \(edit.status.capitalized)")
                        Button("Discard my changes", role: .destructive) { tasks.discard(edit.id) }
                    }.font(.callout)
                } else {
                    Label("Waiting to sync", systemImage: "clock")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
    private func editFor(_ task: GraphTask) -> PendingTaskEdit {
        PendingTaskEdit(taskID: task.id, expectedRevision: task.revision, title: task.title, dueDate: task.dueDate, priority: task.priority, status: task.status)
    }
}

private struct TaskEditor: View {
    @ObservedObject var tasks: TasksStore
    @Environment(\.dismiss) private var dismiss
    @State private var scope: UUID
    @State private var edit: PendingTaskEdit
    @State private var date: Date
    @State private var hasDate: Bool
    @State private var saving = false
    @State private var saveError: String?
    @FocusState private var titleFocused: Bool
    @AppStorage("enchiridionTheme", store: EnchiridionPreferences.store) private var theme: EnchiridionTheme = .dawn
    init(tasks: TasksStore, initial: PendingTaskEdit) {
        self.tasks = tasks; _scope = State(initialValue: tasks.scopeID); _edit = State(initialValue: initial)
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        _date = State(initialValue: initial.dueDate.flatMap { formatter.date(from: $0) } ?? .now)
        _hasDate = State(initialValue: initial.dueDate != nil)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section { TextField("What needs doing?", text: $edit.title, axis: .vertical).font(.title3).lineLimit(2...5).accessibilityIdentifier("taskTitle").focused($titleFocused) }
                if edit.title.utf16.count > 500 { Text("Keep the title under 500 characters.").font(.caption) }
                Section("Plan") {
                    Toggle("Due date", isOn: $hasDate)
                    if hasDate { DatePicker("Due", selection: $date, displayedComponents: .date) }
                    Picker("Priority", selection: $edit.priority) {
                        Text("None").tag("none"); Text("Low").tag("low"); Text("Medium").tag("medium"); Text("High").tag("high")
                    }
                }
                if let error = saveError { Text(error).font(.caption).foregroundStyle(theme.secondary) }
            }.scrollContentBackground(.hidden).background(theme.canvas)
                .navigationTitle(edit.taskID == nil ? "New task" : "Edit task")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saving ? "Saving…" : "Save") {
                            edit.dueDate = hasDate ? TaskDay.key(date) : nil
                            edit.title = edit.title.trimmingCharacters(in: .whitespacesAndNewlines)
                            saving = true
                            Task { let saved = await tasks.save(edit, expectedScope: scope); saving = false; if saved { dismiss() } else { saveError = tasks.error } }
                        }.disabled(saving || edit.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || edit.title.utf16.count > 500).accessibilityIdentifier("saveTask")
                    }
                }
        }.tint(theme.accent).foregroundStyle(theme.ink).interactiveDismissDisabled(saving)
            .task { if edit.taskID == nil { titleFocused = true } }
    }
}
