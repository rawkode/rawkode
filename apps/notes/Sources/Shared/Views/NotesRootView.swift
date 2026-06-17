import SwiftUI
import UniformTypeIdentifiers

private enum NotesSidebarSelection: Hashable {
    case document(UUID)
    case savedQueryView(UUID)
    case supertagSchemas
}

struct NotesRootView: View {
    let store: NotesStore

    @State private var dailyNoteDate = Date.now
    @State private var sidebarSelection: NotesSidebarSelection?
    @State private var isPresentingSavedViewEditor = false
    @State private var savedViewDraftName = ""
    @State private var savedViewDraftQuery = "SELECT * FROM daily_notes"
    @State private var savedViewDraftMode = "table"
    @State private var savedViewDraftGroupBy = ""
    @State private var vaultExportDocument: NotesVaultFileDocument?
    @State private var isPresentingVaultExporter = false
    @State private var isConfirmingVaultImport = false
    @State private var isPresentingVaultImporter = false
    @State private var vaultNotice: VaultNotice?

    private var selectedSavedQueryView: SavedQueryView? {
        guard case .savedQueryView(let selectedID) = sidebarSelection else {
            return nil
        }

        return store.savedQueryViews.first { $0.id == selectedID }
    }

    private var isSupertagSchemaSelected: Bool {
        if case .supertagSchemas = sidebarSelection {
            return true
        }

        return false
    }

    private var selectedDocument: NoteDocument? {
        guard case .document(let selectedID) = sidebarSelection else {
            return nil
        }

        return (store.dailyNotes + store.standaloneNotes).first { $0.id == selectedID }
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $sidebarSelection) {
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
                        NavigationLink(value: NotesSidebarSelection.document(document.id)) {
                            NoteRow(document: document)
                        }
                    }
                }

                Section("Notes") {
                    ForEach(store.standaloneNotes) { document in
                        NavigationLink(value: NotesSidebarSelection.document(document.id)) {
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
                        NavigationLink(value: NotesSidebarSelection.savedQueryView(savedView.id)) {
                            SavedQueryViewRow(savedView: savedView)
                        }
                    }
                    .onDelete(perform: deleteSavedQueryViews)
                }

                Section("Database") {
                    NavigationLink(value: NotesSidebarSelection.supertagSchemas) {
                        Label("Supertag Schemas", systemImage: "tag")
                    }
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

                        Divider()

                        Button(action: exportVault) {
                            Label("Export Vault", systemImage: "square.and.arrow.up")
                        }

                        Button {
                            isConfirmingVaultImport = true
                        } label: {
                            Label("Replace Vault...", systemImage: "square.and.arrow.down")
                        }
                    } label: {
                        Label("Create", systemImage: "plus")
                    }
                }
            }
        } detail: {
            if isSupertagSchemaSelected {
                SupertagSchemaEditorView(
                    definitions: store.supertagFieldDefinitions,
                    onSave: saveSupertagSchemaDraft,
                    onDelete: { id in
                        store.deleteSupertagFieldDefinition(id: id)
                    }
                )
            } else if let selectedSavedQueryView {
                SavedQueryViewDetailView(savedView: selectedSavedQueryView) { query in
                    try store.runQuery(query)
                }
            } else if let selectedDocument {
                NoteEditorView(
                    document: selectedDocument,
                    savedQueryViews: store.savedQueryViews,
                    documentContext: store.selectedDocumentContext,
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
                        if store.selectedDocument?.id == documentID {
                            sidebarSelection = .document(documentID)
                        }
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
            if sidebarSelection == nil, let selectedDocument = store.selectedDocument {
                sidebarSelection = .document(selectedDocument.id)
            }
        }
        .onChange(of: sidebarSelection) { _, selection in
            syncSidebarSelection(selection)
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
        .fileExporter(
            isPresented: $isPresentingVaultExporter,
            document: vaultExportDocument,
            contentType: .json,
            defaultFilename: vaultExportFilename,
            onCompletion: handleVaultExportCompletion
        )
        .fileImporter(
            isPresented: $isPresentingVaultImporter,
            allowedContentTypes: [.json],
            allowsMultipleSelection: false,
            onCompletion: importVault
        )
        .confirmationDialog(
            "Replace local vault?",
            isPresented: $isConfirmingVaultImport,
            titleVisibility: .visible
        ) {
            Button("Choose Vault File", role: .destructive) {
                isPresentingVaultImporter = true
            }

            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Importing a vault replaces all local notes, entities, saved views, and schema fields with the selected JSON snapshot.")
        }
        .alert(vaultNotice?.title ?? "Vault", isPresented: vaultNoticeBinding) {
            Button("OK") {
                vaultNotice = nil
            }
        } message: {
            Text(vaultNotice?.message ?? "")
        }
        .alert("Notes Database", isPresented: errorBinding) {
            Button("OK") {
                store.clearError()
            }
        } message: {
            Text(store.lastErrorMessage ?? "Unknown database error.")
        }
    }

    private var vaultNoticeBinding: Binding<Bool> {
        Binding {
            vaultNotice != nil
        } set: { isPresented in
            if !isPresented {
                vaultNotice = nil
            }
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

        if case .savedQueryView(let selectedSavedQueryViewID) = sidebarSelection,
           deletedIDs.contains(selectedSavedQueryViewID) {
            sidebarSelection = nil
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
        store.selectToday()
        selectCurrentDocument()
    }

    private func openTomorrow() {
        store.selectTomorrow()
        selectCurrentDocument()
    }

    private func openSelectedDailyNoteDate() {
        store.createDailyNote(for: dailyNoteDate)
        selectCurrentDocument()
    }

    private func openDailyNote(movingByDays dayOffset: Int) {
        store.openDailyNote(movingByDays: dayOffset)
        selectCurrentDocument()
    }

    private func createStandaloneNote() {
        store.createStandaloneNote()
        selectCurrentDocument()
    }

    private func saveSavedViewDraft() {
        do {
            let savedView = try store.saveSavedQueryView(
                named: savedViewDraftName,
                query: savedViewDraftQuery,
                view: savedViewDraftMode,
                groupBy: savedViewDraftGroupBy
            )
            sidebarSelection = .savedQueryView(savedView.id)
            store.selectDocument(id: nil)
            isPresentingSavedViewEditor = false
        } catch {
            // NotesStore already exposes the validation failure through lastErrorMessage.
        }
    }

    private func exportVault() {
        do {
            vaultExportDocument = NotesVaultFileDocument(data: try store.exportVaultJSON())
            isPresentingVaultExporter = true
        } catch {
            // NotesStore already exposes repository errors through lastErrorMessage.
        }
    }

    private func handleVaultExportCompletion(_ result: Result<URL, Error>) {
        vaultExportDocument = nil

        switch result {
        case .success(let url):
            vaultNotice = VaultNotice(
                title: "Vault Exported",
                message: "Saved \(url.lastPathComponent)."
            )
        case .failure(let error):
            vaultNotice = VaultNotice(
                title: "Vault Export Failed",
                message: error.localizedDescription
            )
        }
    }

    private func importVault(_ result: Result<[URL], Error>) {
        do {
            guard let url = try result.get().first else {
                return
            }

            let didAccessSecurityScope = url.startAccessingSecurityScopedResource()
            defer {
                if didAccessSecurityScope {
                    url.stopAccessingSecurityScopedResource()
                }
            }

            try store.importVaultJSON(Data(contentsOf: url))
            selectCurrentDocument()
            vaultNotice = VaultNotice(
                title: "Vault Imported",
                message: "Loaded \(url.lastPathComponent)."
            )
        } catch {
            vaultNotice = VaultNotice(
                title: "Vault Import Failed",
                message: error.localizedDescription
            )
        }
    }

    private func saveSupertagSchemaDraft(_ draft: SupertagSchemaDraft) throws {
        try store.saveSupertagFieldDefinition(
            supertagName: draft.supertagName,
            field: draft.fieldLabel,
            valueType: draft.valueType,
            defaultValue: draft.normalizedDefaultValue,
            isRequired: draft.isRequired,
            sortOrder: draft.sortOrder
        )
    }

    private func deleteDocuments(_ documents: [NoteDocument], at offsets: IndexSet) {
        for offset in offsets {
            store.deleteDocument(id: documents[offset].id)
        }

        selectCurrentDocument()
    }

    private func syncSidebarSelection(_ selection: NotesSidebarSelection?) {
        switch selection {
        case .document(let id):
            store.selectDocument(id: id)
        case .savedQueryView, .supertagSchemas, nil:
            store.selectDocument(id: nil)
        }
    }

    private func selectCurrentDocument() {
        if let selectedDocument = store.selectedDocument {
            sidebarSelection = .document(selectedDocument.id)
        } else {
            sidebarSelection = nil
        }
    }

    private var vaultExportFilename: String {
        "notes-vault-\(DailyNoteDateFormatter.storageString(from: .now))"
    }
}

private struct VaultNotice: Identifiable {
    let id = UUID()
    var title: String
    var message: String
}

private struct NotesVaultFileDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    static var writableContentTypes: [UTType] { [.json] }

    var data: Data

    init(data: Data = Data()) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
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

private struct SupertagSchemaDraft: Equatable {
    var editingID: UUID?
    var supertagName = ""
    var fieldLabel = ""
    var valueType: SupertagFieldValueType = .text
    var defaultValue = ""
    var isRequired = false
    var sortOrder = 0

    var normalizedDefaultValue: String? {
        let trimmed = defaultValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    var isEditing: Bool {
        editingID != nil
    }

    var canSave: Bool {
        !supertagName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !fieldLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func editing(_ definition: SupertagFieldDefinition) -> SupertagSchemaDraft {
        SupertagSchemaDraft(
            editingID: definition.id,
            supertagName: definition.supertagName,
            fieldLabel: definition.label,
            valueType: definition.valueType,
            defaultValue: definition.defaultValue ?? "",
            isRequired: definition.isRequired,
            sortOrder: definition.sortOrder
        )
    }
}

private struct SupertagSchemaEditorView: View {
    let definitions: [SupertagFieldDefinition]
    let onSave: (_ draft: SupertagSchemaDraft) throws -> Void
    let onDelete: (_ id: UUID) -> Void

    @State private var draft = SupertagSchemaDraft()
    @State private var deletionCandidate: SupertagFieldDefinition?
    @State private var errorMessage: String?

    private var definitionsBySupertag: [(supertag: String, definitions: [SupertagFieldDefinition])] {
        Dictionary(grouping: definitions, by: \.supertagName)
            .map { supertag, definitions in
                (
                    supertag,
                    definitions.sorted {
                        if $0.sortOrder == $1.sortOrder {
                            return $0.label.localizedStandardCompare($1.label) == .orderedAscending
                        }

                        return $0.sortOrder < $1.sortOrder
                    }
                )
            }
            .sorted { $0.supertag.localizedStandardCompare($1.supertag) == .orderedAscending }
    }

    var body: some View {
        Form {
            Section(draft.isEditing ? "Edit Field" : "New Field") {
                TextField("Supertag", text: $draft.supertagName)
                    .disabled(draft.isEditing)

                TextField("Field", text: $draft.fieldLabel)
                    .disabled(draft.isEditing)

                Picker("Type", selection: $draft.valueType) {
                    ForEach(SupertagFieldValueType.allCases) { valueType in
                        Label(valueType.label, systemImage: valueType.systemImage)
                            .tag(valueType)
                    }
                }

                TextField(draft.valueType.defaultValuePlaceholder, text: $draft.defaultValue)

                Toggle("Required", isOn: $draft.isRequired)

                Stepper(value: $draft.sortOrder, in: 0...999) {
                    Text("Sort Order: \(draft.sortOrder)")
                }

                HStack {
                    Button(draft.isEditing ? "Save changes" : "Create field", action: saveDraft)
                        .disabled(!draft.canSave)

                    if draft.isEditing {
                        Button("Cancel edit", action: resetDraft)
                    }
                }
            }

            if definitions.isEmpty {
                Section {
                    ContentUnavailableView("No Supertag Fields", systemImage: "tag")
                }
            } else {
                ForEach(definitionsBySupertag, id: \.supertag) { group in
                    Section(group.supertag) {
                        ForEach(group.definitions) { definition in
                            SupertagSchemaFieldRow(
                                definition: definition,
                                onEdit: {
                                    draft = .editing(definition)
                                },
                                onDelete: {
                                    deletionCandidate = definition
                                }
                            )
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Supertag Schemas")
        .alert("Supertag Schema", isPresented: errorBinding) {
            Button("OK") {
                errorMessage = nil
            }
        } message: {
            Text(errorMessage ?? "Unknown schema error.")
        }
        .confirmationDialog(
            "Delete field?",
            isPresented: deletionBinding,
            presenting: deletionCandidate
        ) { definition in
            Button("Delete \(definition.label)", role: .destructive) {
                onDelete(definition.id)
                if draft.editingID == definition.id {
                    resetDraft()
                }
                deletionCandidate = nil
            }
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding {
            errorMessage != nil
        } set: { isPresented in
            if !isPresented {
                errorMessage = nil
            }
        }
    }

    private var deletionBinding: Binding<Bool> {
        Binding {
            deletionCandidate != nil
        } set: { isPresented in
            if !isPresented {
                deletionCandidate = nil
            }
        }
    }

    private func saveDraft() {
        do {
            try onSave(draft)
            resetDraft()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resetDraft() {
        draft = SupertagSchemaDraft()
    }
}

private struct SupertagSchemaFieldRow: View {
    let definition: SupertagFieldDefinition
    let onEdit: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Label(definition.label, systemImage: definition.valueType.systemImage)
                .font(.headline)
                .frame(minWidth: 140, alignment: .leading)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(definition.valueType.label)

                    if definition.isRequired {
                        Text("Required")
                    }

                    if let defaultValue = definition.defaultValue {
                        Text("Default: \(defaultValue)")
                    }
                }
                .font(.subheadline)

                Text(definition.key)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 12)

            Button(action: onEdit) {
                Label("Edit", systemImage: "pencil")
            }
            .labelStyle(.iconOnly)

            Button(role: .destructive, action: onDelete) {
                Label("Delete", systemImage: "trash")
            }
            .labelStyle(.iconOnly)
        }
        .padding(.vertical, 4)
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
