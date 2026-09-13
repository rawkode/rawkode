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
    @State private var collection: TaskCollection = .today
    @State private var query = ""
    @State private var editing: PendingTaskEdit?
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    init(workspace: WorkspaceStore) { self.workspace = workspace; tasks = workspace.tasks; session = workspace.session }
    private var today: String { TaskDay.key(.now) }
    private var visible: [GraphTask] {
        tasks.tasks.filter { task in
            let matches = query.isEmpty || task.title.localizedCaseInsensitiveContains(query)
            guard matches else { return false }
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
            Section {
                Text("\(visible.count) \(visible.count == 1 ? "task" : "tasks")\(collection == .today ? " · \(visible.filter { ($0.dueDate ?? today) < today }.count) overdue" : "")").font(.title3).foregroundStyle(theme.secondary)
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
                Picker("Collection", selection: $collection) {
                    ForEach(TaskCollection.allCases) { value in Text(value.rawValue).tag(value) }
                }.pickerStyle(.segmented).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            if let error = tasks.error {
                Section {
                    Text(error).font(.callout).foregroundStyle(theme.secondary)
                    Button("Try again") { Task { await tasks.sync(); await tasks.refresh() } }.disabled(tasks.sending || tasks.loading)
                }
            }
            if !tasks.pending.isEmpty {
                Section("Saved on this device · \(tasks.pending.count) waiting") {
                    Button("Sync pending changes") { Task { await tasks.sync() } }.disabled(tasks.sending || !session.isConnected)
                    ForEach(tasks.pending) { edit in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(edit.title).font(.headline)
                            Text(edit.conflict ? "Changed elsewhere · your edit needs review" : "Waiting to sync")
                                .font(.caption).foregroundStyle(theme.secondary)
                            if edit.conflict {
                                Text("Your version: \(edit.dueDate ?? "No date") · \(edit.priority) priority · \(edit.status)").font(.caption)
                                Button("Discard my pending edit", role: .destructive) { tasks.discard(edit.id) }
                            }
                        }
                    }
                }
            }
            if visible.isEmpty {
                Section {
                    ContentUnavailableView {
                        Label(query.isEmpty ? "\(collection.rawValue) is clear" : "No matching tasks", systemImage: collection.symbol)
                    } description: {
                        Text(tasks.loading ? "Loading your tasks…" : (query.isEmpty ? "Capture a task, then give it a day when you’re ready." : "Try another word."))
                    }
                }.listRowBackground(Color.clear)
            } else {
                Section(collection == .today ? "Today & overdue" : collection.rawValue) {
                    ForEach(visible) { task in taskRow(task) }
                }
            }
            if !session.isConnected {
                Section { Text("Saved tasks remain available offline. Connect your account to sync changes.").font(.caption).foregroundStyle(theme.secondary)
                    Button("Account settings") { workspace.settingsPresented = true }
                }
            }
        }
        .scrollContentBackground(.hidden).background(theme.canvas).foregroundStyle(theme.ink).tint(theme.accent)
        .navigationTitle("Tasks")
        .searchable(text: $query, prompt: "Find a task")
        .toolbar {
            ToolbarItem { Button { editing = PendingTaskEdit(title: "", dueDate: collection == .today ? today : nil, priority: "none", status: "open") } label: { Label("New task", systemImage: "plus") }.accessibilityIdentifier("newTask") }
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
    private func taskRow(_ task: GraphTask) -> some View {
        HStack(spacing: 14) {
            Button {
                var edit = editFor(task); edit.status = task.status == "completed" ? "open" : "completed"
                let scope = tasks.scopeID
                Task { _ = await tasks.save(edit, expectedScope: scope) }
            } label: {
                Image(systemName: task.status == "completed" ? "checkmark.circle.fill" : "circle")
                    .font(.title2).frame(width: 44, height: 44)
            }.buttonStyle(.plain).accessibilityLabel(task.status == "completed" ? "Reopen \(task.title)" : "Complete \(task.title)")
            Button { editing = editFor(task) } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Text(task.title).font(.body.weight(.medium)).strikethrough(task.status == "completed").multilineTextAlignment(.leading)
                    HStack {
                        if let due = task.dueDate { Text(due == today ? "Today" : (due < today && task.status == "open" ? "Overdue · \(due)" : due)) }
                        if task.priority != "none" { Label(task.priority.capitalized, systemImage: "flag.fill") }
                    }.font(.caption).foregroundStyle(theme.secondary)
                }.frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain)
        }.disabled(tasks.pending.contains { $0.taskID == task.id })
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
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    init(tasks: TasksStore, initial: PendingTaskEdit) {
        self.tasks = tasks; _scope = State(initialValue: tasks.scopeID); _edit = State(initialValue: initial)
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        _date = State(initialValue: initial.dueDate.flatMap { formatter.date(from: $0) } ?? .now)
        _hasDate = State(initialValue: initial.dueDate != nil)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section { TextField("What needs doing?", text: $edit.title, axis: .vertical).font(.title3).lineLimit(2...5).accessibilityIdentifier("taskTitle") }
                if edit.title.utf16.count > 500 { Text("Keep the title under 500 characters.").font(.caption) }
                Section("Plan") {
                    Toggle("Give it a day", isOn: $hasDate)
                    if hasDate { DatePicker("Due", selection: $date, displayedComponents: .date) }
                    Picker("Priority", selection: $edit.priority) {
                        Text("None").tag("none"); Text("Low").tag("low"); Text("Medium").tag("medium"); Text("High").tag("high")
                    }
                }
                if let error = tasks.error { Text(error).font(.caption).foregroundStyle(theme.secondary) }
            }.scrollContentBackground(.hidden).background(theme.canvas)
                .navigationTitle(edit.taskID == nil ? "New task" : "Edit task")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saving ? "Saving…" : "Save") {
                            edit.dueDate = hasDate ? TaskDay.key(date) : nil
                            edit.title = edit.title.trimmingCharacters(in: .whitespacesAndNewlines)
                            saving = true
                            Task { let saved = await tasks.save(edit, expectedScope: scope); saving = false; if saved { dismiss() } }
                        }.disabled(saving || edit.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || edit.title.utf16.count > 500).accessibilityIdentifier("saveTask")
                    }
                }
        }.tint(theme.accent).foregroundStyle(theme.ink).interactiveDismissDisabled(saving)
    }
}
