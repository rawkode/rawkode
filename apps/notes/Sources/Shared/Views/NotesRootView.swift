import SwiftUI

struct NotesRootView: View {
    let store: NotesStore

    @State private var dailyNoteDate = Date.now
    @State private var selectedSavedQueryViewID: SavedQueryView.ID?
    @State private var isPresentingSavedViewEditor = false
    @State private var savedViewDraftName = ""
    @State private var savedViewDraftQuery = "SELECT * FROM daily_notes"
    @State private var savedViewDraftMode = "table"
    @State private var savedViewDraftGroupBy = ""

    private var selectedDocumentID: Binding<UUID?> {
        Binding {
            guard selectedSavedQueryViewID == nil else {
                return nil
            }
            return store.selectedDocument?.id
        } set: { newValue in
            selectedSavedQueryViewID = nil
            store.selectDocument(id: newValue)
        }
    }

    private var selectedSavedQueryView: SavedQueryView? {
        selectedSavedQueryViewID.flatMap { selectedID in
            store.savedQueryViews.first { $0.id == selectedID }
        }
    }

    var body: some View {
        NavigationSplitView {
            List(selection: selectedDocumentID) {
                Section("Daily Notes") {
                    Button {
                        openToday()
                    } label: {
                        Label("Today", systemImage: "calendar")
                    }

                    Button {
                        openTomorrow()
                    } label: {
                        Label("Tomorrow", systemImage: "calendar.badge.plus")
                    }

                    DailyNoteDatePicker(date: $dailyNoteDate) {
                        openSelectedDailyNoteDate()
                    }

                    ForEach(store.dailyNotes) { document in
                        NavigationLink(value: document.id) {
                            NoteRow(document: document)
                        }
                    }
                }

                Section("Notes") {
                    ForEach(store.standaloneNotes) { document in
                        NavigationLink(value: document.id) {
                            NoteRow(document: document)
                        }
                    }
                    .onDelete(perform: deleteStandaloneNotes)
                }

                Section("Saved Views") {
                    Button(action: presentSavedViewCreator) {
                        Label("New Saved View", systemImage: "plus")
                    }

                    ForEach(store.savedQueryViews) { savedView in
                        Button {
                            selectedSavedQueryViewID = savedView.id
                            store.selectDocument(id: nil)
                        } label: {
                            SavedQueryViewRow(savedView: savedView)
                        }
                        .buttonStyle(.plain)
                    }
                    .onDelete(perform: deleteSavedQueryViews)
                }
            }
            .navigationTitle("Notes")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: openToday) {
                        Label("Today", systemImage: "calendar.badge.clock")
                    }
                    .keyboardShortcut("t", modifiers: [.command])
                }

                ToolbarItem {
                    Menu {
                        Button(action: openToday) {
                            Label("Open Today", systemImage: "calendar")
                        }

                        Button(action: openTomorrow) {
                            Label("Open Tomorrow", systemImage: "calendar.badge.plus")
                        }
                        .keyboardShortcut("t", modifiers: [.command, .shift])

                        Button(action: createStandaloneNote) {
                            Label("New Note", systemImage: "square.and.pencil")
                        }
                        .keyboardShortcut("n", modifiers: [.command])

                        Button(action: presentSavedViewCreator) {
                            Label("New Saved View", systemImage: "rectangle.grid.1x2")
                        }
                    } label: {
                        Label("Create", systemImage: "plus")
                    }
                }
            }
        } detail: {
            if let selectedSavedQueryView {
                SavedQueryViewDetailView(savedView: selectedSavedQueryView) { query in
                    try store.runQuery(query)
                }
            } else if let selectedDocument = store.selectedDocument {
                NoteEditorView(
                    document: selectedDocument,
                    savedQueryViews: store.savedQueryViews,
                    onOpenPreviousDailyNote: {
                        openDailyNote(movingByDays: -1)
                    },
                    onOpenToday: {
                        openToday()
                    },
                    onOpenNextDailyNote: {
                        openDailyNote(movingByDays: 1)
                    },
                    onChange: { documentID, title, contentJSON, plainText in
                        store.saveEditorChange(
                            documentID: documentID,
                            title: title,
                            contentJSON: contentJSON,
                            plainText: plainText
                        )
                    },
                    onEntityUpsert: { name, supertagNames, properties in
                        try store.upsertEntity(named: name, supertagNames: supertagNames, properties: properties)
                    },
                    onQueryRun: { query in
                        try store.runQuery(query)
                    },
                    onOpenDocument: { documentID in
                        store.openDocument(id: documentID)
                    }
                )
            } else {
                ContentUnavailableView(
                    "No Daily Note Selected",
                    systemImage: "calendar",
                    description: Text("Open today or select an earlier daily note.")
                )
            }
        }
        .task {
            store.load()
        }
        .sheet(isPresented: $isPresentingSavedViewEditor) {
            SavedQueryViewEditorSheet(
                name: $savedViewDraftName,
                query: $savedViewDraftQuery,
                view: $savedViewDraftMode,
                groupBy: $savedViewDraftGroupBy,
                onCancel: {
                    isPresentingSavedViewEditor = false
                },
                onSave: saveSavedViewDraft
            )
        }
        .alert("Notes Database", isPresented: errorBinding) {
            Button("OK") {
                store.clearError()
            }
        } message: {
            Text(store.lastErrorMessage ?? "Unknown database error.")
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding {
            store.lastErrorMessage != nil
        } set: { isPresented in
            if !isPresented {
                store.clearError()
            }
        }
    }

    private func deleteStandaloneNotes(at offsets: IndexSet) {
        deleteDocuments(store.standaloneNotes, at: offsets)
    }

    private func deleteSavedQueryViews(at offsets: IndexSet) {
        let savedViews = store.savedQueryViews
        let deletedIDs = offsets.map { savedViews[$0].id }

        if let selectedSavedQueryViewID, deletedIDs.contains(selectedSavedQueryViewID) {
            self.selectedSavedQueryViewID = nil
        }

        for id in deletedIDs {
            store.deleteSavedQueryView(id: id)
        }
    }

    private func presentSavedViewCreator() {
        savedViewDraftName = ""
        savedViewDraftQuery = "SELECT * FROM daily_notes"
        savedViewDraftMode = "table"
        savedViewDraftGroupBy = ""
        isPresentingSavedViewEditor = true
    }

    private func openToday() {
        selectedSavedQueryViewID = nil
        store.selectToday()
    }

    private func openTomorrow() {
        selectedSavedQueryViewID = nil
        store.selectTomorrow()
    }

    private func openSelectedDailyNoteDate() {
        selectedSavedQueryViewID = nil
        store.createDailyNote(for: dailyNoteDate)
    }

    private func openDailyNote(movingByDays dayOffset: Int) {
        selectedSavedQueryViewID = nil
        store.openDailyNote(movingByDays: dayOffset)
    }

    private func createStandaloneNote() {
        selectedSavedQueryViewID = nil
        store.createStandaloneNote()
    }

    private func saveSavedViewDraft() {
        do {
            let savedView = try store.saveSavedQueryView(
                named: savedViewDraftName,
                query: savedViewDraftQuery,
                view: savedViewDraftMode,
                groupBy: savedViewDraftGroupBy
            )
            selectedSavedQueryViewID = savedView.id
            store.selectDocument(id: nil)
            isPresentingSavedViewEditor = false
        } catch {
            // NotesStore already exposes the validation failure through lastErrorMessage.
        }
    }

    private func deleteDocuments(_ documents: [NoteDocument], at offsets: IndexSet) {
        for offset in offsets {
            store.deleteDocument(id: documents[offset].id)
        }
    }
}

private struct SavedQueryViewEditorSheet: View {
    @Binding var name: String
    @Binding var query: String
    @Binding var view: String
    @Binding var groupBy: String

    let onCancel: () -> Void
    let onSave: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)

                Picker("View", selection: $view) {
                    Text("Table").tag("table")
                    Text("List").tag("list")
                    Text("Board").tag("board")
                }
                .pickerStyle(.segmented)

                if view == "board" {
                    TextField("Group", text: $groupBy)
                }

                TextEditor(text: $query)
                    .font(.system(.body, design: .monospaced))
                    .frame(minHeight: 160)
            }
            .navigationTitle("Saved View")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: onSave)
                }
            }
        }
        .frame(minWidth: 460, minHeight: 360)
    }
}

private struct SavedQueryViewDetailView: View {
    let savedView: SavedQueryView
    let runQuery: (_ query: String) throws -> QueryResult

    @State private var result: QueryResult?
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    queryText
                    queryResult
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(savedView.name)
        .task(id: refreshID) {
            refresh()
        }
    }

    private var refreshID: String {
        "\(savedView.id.uuidString):\(savedView.updatedAt.timeIntervalSinceReferenceDate):\(savedView.query)"
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: savedViewIconName(savedView.view))
                    .foregroundStyle(.secondary)

                Text(savedView.name)
                    .font(.title.weight(.semibold))
                    .lineLimit(2)
            }

            HStack(spacing: 10) {
                Label(savedView.view.capitalized, systemImage: "rectangle.grid.1x2")

                if let groupBy = savedView.groupBy, !groupBy.isEmpty {
                    Label(groupBy, systemImage: "rectangle.3.group")
                }

                Label {
                    Text(savedView.updatedAt, format: .dateTime.month().day().hour().minute())
                } icon: {
                    Image(systemName: "clock")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            Button(action: refresh) {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var queryText: some View {
        Text(savedView.query)
            .font(.system(.callout, design: .monospaced))
            .textSelection(.enabled)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .stroke(.secondary.opacity(0.16))
            }
    }

    @ViewBuilder
    private var queryResult: some View {
        if let errorMessage {
            ContentUnavailableView(
                "Query Failed",
                systemImage: "exclamationmark.triangle",
                description: Text(errorMessage)
            )
        } else if let result {
            VStack(alignment: .leading, spacing: 10) {
                Text("\(result.rows.count) rows")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                QueryResultGrid(result: result)
            }
        } else {
            ProgressView()
                .controlSize(.small)
        }
    }

    private func refresh() {
        do {
            result = try runQuery(savedView.query)
            errorMessage = nil
        } catch {
            result = nil
            errorMessage = error.localizedDescription
        }
    }
}

private struct QueryResultGrid: View {
    let result: QueryResult

    var body: some View {
        if result.rows.isEmpty {
            ContentUnavailableView("No Results", systemImage: "tablecells")
        } else {
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                    GridRow {
                        ForEach(result.columns, id: \.self) { column in
                            Text(column)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }

                    Divider()
                        .gridCellUnsizedAxes(.horizontal)

                    ForEach(Array(result.rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(result.columns, id: \.self) { column in
                                Text(row[column] ?? "")
                                    .font(.callout)
                                    .lineLimit(3)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }
                .padding(12)
            }
            .background(.background, in: RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .stroke(.secondary.opacity(0.16))
            }
        }
    }
}

private struct SavedQueryViewRow: View {
    let savedView: SavedQueryView

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: savedViewIconName(savedView.view))
                .foregroundStyle(.secondary)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 5) {
                Text(savedView.name)
                    .font(.headline)
                    .lineLimit(1)

                HStack(spacing: 6) {
                    Text(savedView.view.capitalized)

                    if let groupBy = savedView.groupBy, !groupBy.isEmpty {
                        Text(groupBy)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)

                Text(savedView.query)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }
}

private func savedViewIconName(_ view: String) -> String {
    switch view {
    case "board":
        "rectangle.3.group"
    case "list":
        "list.bullet"
    default:
        "tablecells"
    }
}

private struct DailyNoteDatePicker: View {
    @Binding var date: Date
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            DatePicker("Open Daily Note", selection: $date, displayedComponents: .date)
                .datePickerStyle(.compact)

            Button(action: onOpen) {
                Label("Open Date", systemImage: "calendar.badge.plus")
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
    }
}

private struct NoteRow: View {
    let document: NoteDocument

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(document.displayTitle)
                    .font(.headline)
                    .lineLimit(1)

                if document.isToday {
                    Image(systemName: "circle.fill")
                        .font(.system(size: 7))
                        .foregroundStyle(.green)
                }
            }

            if document.kind == .daily, let date = document.date {
                Text(DailyNoteDateFormatter.subtitle(for: date))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            if !document.previewText.isEmpty {
                Text(document.previewText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Text(document.updatedAt, format: .dateTime.month().day().hour().minute())
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }
}

#Preview {
    NotesRootView(store: NotesStore())
}
