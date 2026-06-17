import SwiftUI
import UniformTypeIdentifiers

private enum NotesSidebarSelection: Hashable {
    case document(UUID)
    case entity(UUID)
    case savedQueryView(UUID)
    case databaseEditor
}

private enum SavedQueryViewMoveDirection {
    case up
    case down
}

struct NotesRootView: View {
    let store: NotesStore

    @State private var dailyNoteDate = Date.now
    @State private var sidebarSelection: NotesSidebarSelection?
    @State private var isPresentingSavedViewEditor = false
    @State private var savedViewDraftEditingID: UUID?
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

    private var isDatabaseEditorSelected: Bool {
        if case .databaseEditor = sidebarSelection {
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

                Section {
                    Button(action: presentSavedViewCreator) {
                        Label("New Saved View", systemImage: "plus")
                    }

                    ForEach(Array(store.savedQueryViews.enumerated()), id: \.element.id) { index, savedView in
                        NavigationLink(value: NotesSidebarSelection.savedQueryView(savedView.id)) {
                            SavedQueryViewRow(savedView: savedView)
                        }
                        .contextMenu {
                            Button {
                                presentSavedViewEditor(savedView)
                            } label: {
                                Label("Edit Saved View", systemImage: "square.and.pencil")
                            }

                            Button {
                                duplicateSavedView(savedView)
                            } label: {
                                Label("Duplicate Saved View", systemImage: "plus.square.on.square")
                            }

                            Divider()

                            Button {
                                moveSavedView(savedView, direction: .up)
                            } label: {
                                Label("Move Up", systemImage: "arrow.up")
                            }
                            .disabled(index == 0)

                            Button {
                                moveSavedView(savedView, direction: .down)
                            } label: {
                                Label("Move Down", systemImage: "arrow.down")
                            }
                            .disabled(index >= store.savedQueryViews.count - 1)

                            Divider()

                            Button(role: .destructive) {
                                deleteSavedView(savedView)
                            } label: {
                                Label("Delete Saved View", systemImage: "trash")
                            }
                        }
                    }
                    .onMove(perform: moveSavedQueryViews)
                    .onDelete(perform: deleteSavedQueryViews)
                } header: {
                    HStack {
                        Text("Saved Views")
#if os(iOS)
                        Spacer()
                        EditButton()
                            .font(.caption)
#endif
                    }
                }

                Section("Database") {
                    NavigationLink(value: NotesSidebarSelection.databaseEditor) {
                        Label("Database", systemImage: "cylinder.split.1x2")
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
            if isDatabaseEditorSelected {
                DatabaseEditorView(
                    schemas: store.supertagSchemas,
                    onSave: saveSupertagSchemaDraft,
                    onPreview: previewSupertagSchemaDraft,
                    onDelete: { id in
                        store.deleteSupertagFieldDefinition(id: id)
                    }
                )
            } else if let selectedSavedQueryView {
                SavedQueryViewDetailView(
                    savedView: selectedSavedQueryView,
                    onEdit: {
                        presentSavedViewEditor(selectedSavedQueryView)
                    },
                    onDuplicate: {
                        duplicateSavedView(selectedSavedQueryView)
                    },
                    onDelete: {
                        deleteSavedView(selectedSavedQueryView)
                    },
                    onOpenDocument: { documentID in
                        openDocument(documentID)
                    },
                    onOpenEntity: { entityID in
                        openEntity(entityID)
                    },
                    runQuery: { query in
                        try store.runQuery(query)
                    }
                )
            } else if let selectedEntityDetail = store.selectedEntityDetail {
                EntityDetailView(
                    detail: selectedEntityDetail,
                    schemas: store.supertagSchemas,
                    onSaveSchemaField: saveEntitySchemaField,
                    onOpenDocument: openDocument,
                    onOpenEntity: openEntity
                )
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
                    onSavedQueryViewCreate: { name, query, view, groupBy in
                        try store.createSavedQueryView(
                            named: name,
                            query: query,
                            view: view,
                            groupBy: groupBy
                        )
                    },
                    onOpenDocument: { documentID in
                        openDocument(documentID)
                    },
                    onOpenEntity: { entityID in
                        openEntity(entityID)
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
                isEditing: savedViewDraftEditingID != nil,
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

    private func deleteSavedView(_ savedView: SavedQueryView) {
        if sidebarSelection == .savedQueryView(savedView.id) {
            sidebarSelection = nil
        }

        store.deleteSavedQueryView(id: savedView.id)
    }

    private func moveSavedQueryViews(from source: IndexSet, to destination: Int) {
        var orderedViews = store.savedQueryViews
        orderedViews.move(fromOffsets: source, toOffset: destination)
        store.reorderSavedQueryViews(ids: orderedViews.map(\.id))
    }

    private func moveSavedView(_ savedView: SavedQueryView, direction: SavedQueryViewMoveDirection) {
        guard let currentIndex = store.savedQueryViews.firstIndex(where: { $0.id == savedView.id }) else {
            return
        }

        let targetIndex = direction == .up ? currentIndex - 1 : currentIndex + 1
        guard store.savedQueryViews.indices.contains(targetIndex) else {
            return
        }

        var orderedViews = store.savedQueryViews
        orderedViews.swapAt(currentIndex, targetIndex)
        store.reorderSavedQueryViews(ids: orderedViews.map(\.id))
    }

    private func presentSavedViewCreator() {
        savedViewDraftEditingID = nil
        savedViewDraftName = ""
        savedViewDraftQuery = "SELECT * FROM daily_notes"
        savedViewDraftMode = "table"
        savedViewDraftGroupBy = ""
        isPresentingSavedViewEditor = true
    }

    private func presentSavedViewEditor(_ savedView: SavedQueryView) {
        savedViewDraftEditingID = savedView.id
        savedViewDraftName = savedView.name
        savedViewDraftQuery = savedView.query
        savedViewDraftMode = savedView.view
        savedViewDraftGroupBy = savedView.groupBy ?? ""
        isPresentingSavedViewEditor = true
    }

    private func duplicateSavedView(_ savedView: SavedQueryView) {
        do {
            let duplicate = try store.duplicateSavedQueryView(id: savedView.id)
            sidebarSelection = .savedQueryView(duplicate.id)
            store.selectDocument(id: nil)
        } catch {
            // NotesStore already exposes the validation failure through lastErrorMessage.
        }
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
            let savedView: SavedQueryView
            if let savedViewDraftEditingID {
                savedView = try store.updateSavedQueryView(
                    id: savedViewDraftEditingID,
                    named: savedViewDraftName,
                    query: savedViewDraftQuery,
                    view: savedViewDraftMode,
                    groupBy: savedViewDraftGroupBy
                )
            } else {
                savedView = try store.saveSavedQueryView(
                    named: savedViewDraftName,
                    query: savedViewDraftQuery,
                    view: savedViewDraftMode,
                    groupBy: savedViewDraftGroupBy
                )
            }
            sidebarSelection = .savedQueryView(savedView.id)
            store.selectDocument(id: nil)
            isPresentingSavedViewEditor = false
            savedViewDraftEditingID = nil
        } catch {
            // NotesStore already exposes the validation failure through lastErrorMessage.
        }
    }

    private func openDocument(_ documentID: UUID) {
        store.openDocument(id: documentID)
        if store.selectedDocument?.id == documentID {
            sidebarSelection = .document(documentID)
        }
    }

    private func openEntity(_ entityID: UUID) {
        store.openEntity(id: entityID)
        if store.selectedEntityDetail?.id == entityID {
            sidebarSelection = .entity(entityID)
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

    private func saveSupertagSchemaDraft(_ draft: SupertagSchemaDraft) throws -> SupertagFieldDefinition {
        if let editingID = draft.editingID {
            return try store.updateSupertagFieldDefinition(
                id: editingID,
                field: draft.fieldLabel,
                valueType: draft.valueType,
                defaultValue: draft.normalizedDefaultValue,
                isRequired: draft.isRequired,
                sortOrder: draft.sortOrder
            )
        }

        return try store.saveSupertagFieldDefinition(
            supertagName: draft.supertagName,
            field: draft.fieldLabel,
            valueType: draft.valueType,
            defaultValue: draft.normalizedDefaultValue,
            isRequired: draft.isRequired,
            sortOrder: draft.sortOrder
        )
    }

    private func previewSupertagSchemaDraft(_ draft: SupertagSchemaDraft) throws -> SupertagSchemaImpactPreview {
        try store.previewSupertagFieldDefinitionChange(
            id: draft.editingID,
            supertagName: draft.supertagName,
            field: draft.fieldLabel,
            valueType: draft.valueType,
            defaultValue: draft.normalizedDefaultValue,
            isRequired: draft.isRequired
        )
    }

    private func saveEntitySchemaField(
        entityID: UUID,
        field: SupertagFieldDefinition,
        value: String
    ) throws {
        try store.updateEntityProperty(
            entityID: entityID,
            key: field.key,
            value: normalizedEntitySchemaValue(value, for: field)
        )
    }

    private func normalizedEntitySchemaValue(_ value: String, for field: SupertagFieldDefinition) -> String {
        let trimmedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard field.valueType == .entity, !trimmedValue.isEmpty else {
            return trimmedValue
        }

        if trimmedValue.hasPrefix("[["), trimmedValue.hasSuffix("]]") {
            return trimmedValue
        }

        return "[[\(trimmedValue)]]"
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
        case .entity(let id):
            store.openEntity(id: id)
        case .savedQueryView, .databaseEditor, nil:
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

private struct EntityDetailView: View {
    let detail: EntityDetail
    let schemas: [SupertagSchema]
    let onSaveSchemaField: (_ entityID: UUID, _ field: SupertagFieldDefinition, _ value: String) throws -> Void
    let onOpenDocument: (_ documentID: UUID) -> Void
    let onOpenEntity: (_ entityID: UUID) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()

            List {
                Section("Supertags") {
                    if detail.supertags.isEmpty {
                        Text("No supertags")
                            .foregroundStyle(.secondary)
                    } else {
                        FlowTagList(tags: detail.supertags)
                    }
                }

                if appliedSchemas.isEmpty {
                    Section("Typed Fields") {
                        Text("No typed fields for applied supertags")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(appliedSchemas) { schema in
                        Section("\(schema.name) Fields") {
                            if schema.fields.isEmpty {
                                Text("No typed fields")
                                    .foregroundStyle(.secondary)
                            } else {
                                ForEach(schema.fields) { field in
                                    EntitySchemaPropertyRow(
                                        entityID: detail.id,
                                        field: field,
                                        value: detail.properties[field.key],
                                        onSave: onSaveSchemaField
                                    )
                                    .id("\(detail.id.uuidString)-\(field.id.uuidString)")
                                }
                            }
                        }
                    }
                }

                Section("Other Properties") {
                    if otherProperties.isEmpty {
                        Text("No extra properties")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(otherProperties, id: \.key) { property in
                            EntityPropertyRow(property: property)
                        }
                    }
                }

                Section("Backlinks") {
                    if detail.backlinks.isEmpty {
                        Text("No document mentions")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(detail.backlinks) { backlink in
                            EntityBacklinkRow(backlink: backlink) {
                                onOpenDocument(backlink.documentID)
                            }
                        }
                    }
                }

                Section("Outgoing Relationships") {
                    if detail.outgoingRelationships.isEmpty {
                        Text("No outgoing relationships")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(detail.outgoingRelationships) { relationship in
                            EntityRelationshipDetailRow(
                                relationship: relationship,
                                direction: .outgoing,
                                onOpenEntity: onOpenEntity
                            )
                        }
                    }
                }

                Section("Incoming Relationships") {
                    if detail.incomingRelationships.isEmpty {
                        Text("No incoming relationships")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(detail.incomingRelationships) { relationship in
                            EntityRelationshipDetailRow(
                                relationship: relationship,
                                direction: .incoming,
                                onOpenEntity: onOpenEntity
                            )
                        }
                    }
                }
            }
            .listStyle(.inset)
        }
        .navigationTitle(detail.name)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(detail.name, systemImage: "at")
                .font(.title.weight(.semibold))
                .lineLimit(2)

            HStack(spacing: 12) {
                Label("\(detail.supertags.count)", systemImage: "tag")
                    .accessibilityLabel("\(detail.supertags.count) supertags")

                Label("\(detail.properties.count)", systemImage: "slider.horizontal.3")
                    .accessibilityLabel("\(detail.properties.count) properties")

                Label("\(detail.backlinks.count)", systemImage: "link")
                    .accessibilityLabel("\(detail.backlinks.count) backlinks")

                Label("\(detail.relationshipCount)", systemImage: "arrow.left.and.right")
                    .accessibilityLabel("\(detail.relationshipCount) relationships")

                Text(detail.updatedAt, format: .dateTime.month().day().hour().minute())
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var appliedSchemas: [SupertagSchema] {
        let appliedTags = Set(detail.supertags.map(normalizedSupertagName))
        return schemas
            .filter { schema in
                appliedTags.contains(normalizedSupertagName(schema.name))
                    || appliedTags.contains(normalizedSupertagName(schema.slug))
            }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    private var typedFieldKeys: Set<String> {
        Set(appliedSchemas.flatMap { schema in schema.fields.map(\.key) })
    }

    private var otherProperties: [(key: String, value: String)] {
        detail.sortedProperties.filter { property in
            !typedFieldKeys.contains(property.key)
        }
    }
}

private struct EntitySchemaPropertyRow: View {
    let entityID: UUID
    let field: SupertagFieldDefinition
    let value: String?
    let onSave: (_ entityID: UUID, _ field: SupertagFieldDefinition, _ value: String) throws -> Void

    @State private var draft: String
    @State private var errorMessage: String?

    init(
        entityID: UUID,
        field: SupertagFieldDefinition,
        value: String?,
        onSave: @escaping (_ entityID: UUID, _ field: SupertagFieldDefinition, _ value: String) throws -> Void
    ) {
        self.entityID = entityID
        self.field = field
        self.value = value
        self.onSave = onSave
        _draft = State(initialValue: value ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(field.label, systemImage: field.valueType.systemImage)
                    .font(.callout.weight(.semibold))

                if field.isRequired {
                    Label("Required", systemImage: "asterisk")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                Text(field.key)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }

            HStack(alignment: .firstTextBaseline, spacing: 10) {
                valueEditor

                Button(action: saveDraft) {
                    Label("Save", systemImage: "checkmark")
                }
                .labelStyle(.iconOnly)
                .disabled(!hasChanges)

                Button(action: resetDraft) {
                    Label("Reset", systemImage: "arrow.counterclockwise")
                }
                .labelStyle(.iconOnly)
                .disabled(!hasChanges)
            }

            HStack(spacing: 8) {
                Text(field.valueType.label)

                if let defaultValue = field.defaultValue {
                    Text("Default: \(defaultValue)")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .onChange(of: value ?? "") { _, newValue in
            draft = newValue
        }
        .alert("Property Could Not Be Saved", isPresented: errorBinding) {
            Button("OK", role: .cancel) {}
        } message: {
            if let errorMessage {
                Text(errorMessage)
            }
        }
    }

    @ViewBuilder
    private var valueEditor: some View {
        switch field.valueType {
        case .boolean:
            Picker("Value", selection: $draft) {
                Text("Unset").tag("")
                Text("True").tag("true")
                Text("False").tag("false")
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 280)
        default:
            TextField(field.valueType.defaultValuePlaceholder, text: $draft)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 360)
        }
    }

    private var hasChanges: Bool {
        normalizedDraft != normalizedValue
    }

    private var normalizedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var normalizedValue: String {
        (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
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

    private func saveDraft() {
        do {
            try onSave(entityID, field, draft)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resetDraft() {
        draft = value ?? ""
    }
}

private struct FlowTagList: View {
    let tags: [String]

    var body: some View {
        HStack {
            ForEach(tags, id: \.self) { tag in
                Text(tag)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.secondary.opacity(0.12), in: Capsule())
            }
        }
    }
}

private struct EntityPropertyRow: View {
    let property: (key: String, value: String)

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(propertyLabel)
                .font(.callout.weight(.semibold))

            Text(property.value)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .padding(.vertical, 3)
    }

    private var propertyLabel: String {
        property.key
            .split(separator: "_")
            .map { $0.capitalized }
            .joined(separator: " ")
    }
}

private struct EntityBacklinkRow: View {
    let backlink: DocumentBacklink
    let onOpenDocument: () -> Void

    var body: some View {
        Button(action: onOpenDocument) {
            Label {
                VStack(alignment: .leading, spacing: 4) {
                    Text(documentLabel)
                        .font(.callout.weight(.semibold))

                    Text(backlink.documentKind == .daily ? "Daily Note" : "Note")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: backlink.documentKind == .daily ? "calendar" : "note.text")
            }
        }
        .buttonStyle(.plain)
        .padding(.vertical, 3)
    }

    private var documentLabel: String {
        if backlink.documentKind == .daily, let documentDate = backlink.documentDate {
            return DailyNoteDateFormatter.displayTitle(for: documentDate)
        }

        return backlink.documentTitle
    }
}

private struct EntityRelationshipDetailRow: View {
    let relationship: EntityRelationship
    let direction: EntityRelationshipDetailDirection
    let onOpenEntity: (_ entityID: UUID) -> Void

    var body: some View {
        Button {
            onOpenEntity(relatedEntityID)
        } label: {
            Label {
                VStack(alignment: .leading, spacing: 4) {
                    Text(relatedName)
                        .font(.callout.weight(.semibold))

                    HStack(spacing: 6) {
                        Text(propertyLabel)
                        Text(relationship.updatedAt, format: .dateTime.month().day().hour().minute())
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: direction == .outgoing ? "arrow.right" : "arrow.left")
            }
        }
        .buttonStyle(.plain)
        .padding(.vertical, 3)
    }

    private var relatedEntityID: UUID {
        switch direction {
        case .outgoing:
            relationship.targetEntityID
        case .incoming:
            relationship.sourceEntityID
        }
    }

    private var relatedName: String {
        switch direction {
        case .outgoing:
            relationship.targetName
        case .incoming:
            relationship.sourceName
        }
    }

    private var propertyLabel: String {
        relationship.property
            .split(separator: "_")
            .map { $0.capitalized }
            .joined(separator: " ")
    }
}

private enum EntityRelationshipDetailDirection {
    case outgoing
    case incoming
}

private struct SavedQueryViewEditorSheet: View {
    @Binding var name: String
    @Binding var query: String
    @Binding var view: String
    @Binding var groupBy: String

    let isEditing: Bool
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
                    TextField("Group By", text: $groupBy)
                }

                Text("Query")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                TextEditor(text: $query)
                    .font(.system(.body, design: .monospaced))
                    .frame(minHeight: 160)
            }
            .navigationTitle(isEditing ? "Edit Saved View" : "New Saved View")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button(isEditing ? "Save Changes" : "Create View", action: onSave)
                        .disabled(!canSave)
                }
            }
        }
        .frame(minWidth: 460, minHeight: 360)
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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

    var fieldKeyPreview: String {
        schemaEditorFieldKey(for: fieldLabel)
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

    static func addingField(to schema: SupertagSchema) -> SupertagSchemaDraft {
        SupertagSchemaDraft(
            supertagName: schema.name,
            sortOrder: (schema.fields.map(\.sortOrder).max() ?? -1) + 1
        )
    }
}

private struct DatabaseEditorView: View {
    let schemas: [SupertagSchema]
    let onSave: (_ draft: SupertagSchemaDraft) throws -> SupertagFieldDefinition
    let onPreview: (_ draft: SupertagSchemaDraft) throws -> SupertagSchemaImpactPreview
    let onDelete: (_ id: UUID) -> Void

    @State private var selectedSchemaID: UUID?
    @State private var draft = SupertagSchemaDraft()
    @State private var deletionCandidate: SupertagFieldDefinition?
    @State private var deletionImpactPreview: SupertagSchemaImpactPreview?
    @State private var impactPreview: SupertagSchemaImpactPreview?
    @State private var impactPreviewError: String?
    @State private var saveConfirmation: SchemaSaveConfirmation?
    @State private var errorMessage: String?

    private var fieldCount: Int {
        schemas.reduce(0) { $0 + $1.fieldCount }
    }

    private var requiredFieldCount: Int {
        schemas.reduce(0) { $0 + $1.requiredFieldCount }
    }

    private var selectedSchema: SupertagSchema? {
        guard let selectedSchemaID else {
            return nil
        }

        return schemas.first { $0.id == selectedSchemaID }
    }

    var body: some View {
        editorLayout
            .navigationTitle("Database")
            .onAppear {
                selectDefaultSchemaIfNeeded()
                refreshImpactPreview()
            }
            .onChange(of: selectedSchemaID) { _, id in
                syncDraftWithSelectedSchema(id: id)
            }
            .onChange(of: draft) { _, _ in
                refreshImpactPreview()
            }
            .onChange(of: schemas) { _, _ in
                selectDefaultSchemaIfNeeded()
                refreshImpactPreview()
            }
            .alert("Database Schema", isPresented: errorBinding) {
                Button("OK") {
                    errorMessage = nil
                }
            } message: {
                Text(errorMessage ?? "Unknown schema error.")
            }
            .confirmationDialog(
                "Delete property?",
                isPresented: deletionBinding,
                presenting: deletionCandidate
            ) { definition in
                Button("Delete \(definition.label)", role: .destructive) {
                    onDelete(definition.id)
                    if draft.editingID == definition.id {
                        resetDraft()
                    }
                    deletionCandidate = nil
                    deletionImpactPreview = nil
                }
            } message: { definition in
                if let deletionImpactPreview {
                    Text(schemaDeleteConfirmationSummary(for: definition, impact: deletionImpactPreview))
                } else {
                    Text("This removes \(definition.label) from the schema.")
                }
            }
            .confirmationDialog(
                "Apply schema change?",
                isPresented: saveConfirmationBinding,
                presenting: saveConfirmation
            ) { confirmation in
                Button("Apply Schema Change") {
                    performSave(confirmation.draft)
                    saveConfirmation = nil
                }

                Button("Cancel", role: .cancel) {
                    saveConfirmation = nil
                }
            } message: { confirmation in
                Text(schemaSaveConfirmationSummary(for: confirmation.impact))
            }
    }

    @ViewBuilder
    private var editorLayout: some View {
#if os(macOS)
        HSplitView {
            schemaSidebar
                .frame(minWidth: 220, idealWidth: 260, maxWidth: 320)

            schemaDetail
                .frame(minWidth: 520, maxWidth: .infinity, maxHeight: .infinity)
        }
#else
        schemaDetail
#endif
    }

    private var schemaSidebar: some View {
        VStack(spacing: 0) {
            List(selection: $selectedSchemaID) {
                Section("Supertags") {
                    ForEach(schemas) { schema in
                        DatabaseSchemaRow(schema: schema)
                            .tag(Optional(schema.id))
                    }
                }
            }

            Divider()

            Button {
                startNewSupertag()
            } label: {
                Label("New Supertag", systemImage: "plus")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderless)
            .padding(12)
        }
    }

    private var schemaDetail: some View {
        Form {
            databaseOverviewSection
            typeSelectorSection
            propertyEditorSection
            propertiesSection
        }
        .formStyle(.grouped)
    }

    @ViewBuilder
    private var databaseOverviewSection: some View {
        Section("Overview") {
            LabeledContent("Supertag Types", value: "\(schemas.count)")
            LabeledContent("Properties", value: "\(fieldCount)")
            LabeledContent("Required Properties", value: "\(requiredFieldCount)")
        }
    }

    @ViewBuilder
    private var typeSelectorSection: some View {
        if schemas.isEmpty {
            Section("Supertag Type") {
                ContentUnavailableView(
                    "No Supertag Types",
                    systemImage: "cylinder.split.1x2",
                    description: Text("Create the first type and add its first property below.")
                )
            }
        } else {
            Section("Supertag Type") {
                Picker("Type", selection: selectedSchemaBinding) {
                    ForEach(schemas) { schema in
                        Text(schema.name).tag(Optional(schema.id))
                    }
                }

                if let selectedSchema {
                    LabeledContent("Slug", value: "#\(selectedSchema.slug)")
                    LabeledContent("Properties", value: "\(selectedSchema.fieldCount)")
                    LabeledContent("Required", value: "\(selectedSchema.requiredFieldCount)")
                }

                Button(action: startNewSupertag) {
                    Label("Create New Type", systemImage: "plus")
                }
            }
        }
    }

    @ViewBuilder
    private var propertiesSection: some View {
        Section {
            if let selectedSchema {
                if selectedSchema.fields.isEmpty {
                    ContentUnavailableView(
                        "No Properties",
                        systemImage: "list.bullet.rectangle",
                        description: Text("Add a property to make \(selectedSchema.name) queryable as structured data.")
                    )
                } else {
                    ForEach(selectedSchema.fields) { definition in
                        SupertagSchemaFieldRow(
                            definition: definition,
                            isSelected: draft.editingID == definition.id,
                            onSelect: {
                                selectField(definition)
                            },
                            onDelete: {
                                prepareDelete(definition)
                            }
                        )
                    }
                }

                Button {
                    startAddingProperty(to: selectedSchema)
                } label: {
                    Label("Add Property to \(selectedSchema.name)", systemImage: "plus")
                }
            } else {
                Text("The first saved property will create this supertag type.")
                    .foregroundStyle(.secondary)
            }
        } header: {
            HStack {
                Text("Properties")

                Spacer()

                if let selectedSchema {
                    Text(selectedSchema.name)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var propertyEditorSection: some View {
        Section(propertyEditorTitle) {
            TextField("Supertag Type", text: $draft.supertagName)
                .disabled(isSupertagNameLocked)

            TextField("Property Name", text: $draft.fieldLabel)

            LabeledContent("Stored Key", value: draft.fieldKeyPreview.isEmpty ? "Not set" : draft.fieldKeyPreview)

            FieldTypePicker(selection: valueTypeBinding)

            defaultValueEditor

            Toggle("Required", isOn: $draft.isRequired)

            Stepper(value: $draft.sortOrder, in: 0...999) {
                Text("Sort Order: \(draft.sortOrder)")
            }

            schemaImpactPreview

            HStack {
                Button(action: saveDraft) {
                    Label(draft.isEditing ? "Save Property" : "Create Property", systemImage: "checkmark")
                }
                .disabled(!canSaveDraft)

                Button(action: resetDraft) {
                    Label(draft.isEditing ? "Cancel Edit" : "Reset", systemImage: "arrow.counterclockwise")
                }
                .disabled(!draft.isEditing && draft == SupertagSchemaDraft())
            }
        }
    }

    private var propertyEditorTitle: String {
        if draft.isEditing {
            return "Property Inspector"
        }

        if selectedSchema == nil {
            return "New Supertag Type"
        }

        return "New Property"
    }

    private var isSupertagNameLocked: Bool {
        draft.isEditing || selectedSchema != nil
    }

    @ViewBuilder
    private var schemaImpactPreview: some View {
        if let impactPreview {
            SchemaImpactPreviewView(impact: impactPreview)
        } else if let impactPreviewError {
            Label(impactPreviewError, systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.red)
        }
    }

    private var canSaveDraft: Bool {
        draft.canSave
            && impactPreviewError == nil
            && impactPreview?.hasBlockingIssues != true
    }

    private var selectedSchemaBinding: Binding<UUID?> {
        Binding {
            selectedSchemaID
        } set: { id in
            selectSchema(id: id)
        }
    }

    private func selectDefaultSchemaIfNeeded() {
        if let selectedSchemaID, schemas.contains(where: { $0.id == selectedSchemaID }) {
            return
        }

        let nextSchema = schemas.first
        selectSchema(id: nextSchema?.id)
    }

    private func selectSchema(id: UUID?) {
        selectedSchemaID = id
        syncDraftWithSelectedSchema(id: id)
    }

    private func syncDraftWithSelectedSchema(id: UUID?) {
        guard let id, let schema = schemas.first(where: { $0.id == id }) else {
            if selectedSchemaID == nil {
                draft = SupertagSchemaDraft()
            }
            return
        }

        if let editingID = draft.editingID, schema.fields.contains(where: { $0.id == editingID }) {
            return
        }

        if let firstField = schema.fields.first {
            draft = .editing(firstField)
        } else {
            draft = .addingField(to: schema)
        }
    }

    private func selectField(_ definition: SupertagFieldDefinition) {
        selectedSchemaID = definition.supertagID
        draft = .editing(definition)
    }

    private func startAddingProperty(to schema: SupertagSchema) {
        selectedSchemaID = schema.id
        draft = .addingField(to: schema)
    }

    private func startNewSupertag() {
        selectedSchemaID = nil
        draft = SupertagSchemaDraft()
    }

    private var valueTypeBinding: Binding<SupertagFieldValueType> {
        Binding {
            draft.valueType
        } set: { valueType in
            if draft.valueType != valueType {
                draft.valueType = valueType
                draft.defaultValue = ""
            }
        }
    }

    @ViewBuilder
    private var defaultValueEditor: some View {
        switch draft.valueType {
        case .boolean:
            Picker("Default", selection: $draft.defaultValue) {
                Text("None").tag("")
                Text("True").tag("true")
                Text("False").tag("false")
            }
        default:
            TextField(draft.valueType.defaultValuePlaceholder, text: $draft.defaultValue)
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
                deletionImpactPreview = nil
            }
        }
    }

    private var saveConfirmationBinding: Binding<Bool> {
        Binding {
            saveConfirmation != nil
        } set: { isPresented in
            if !isPresented {
                saveConfirmation = nil
            }
        }
    }

    private func saveDraft() {
        let impact: SupertagSchemaImpactPreview?
        do {
            impact = try loadImpactPreview(for: draft)
        } catch {
            errorMessage = error.localizedDescription
            return
        }

        if let impact, impact.hasBlockingIssues {
            impactPreview = impact
            impactPreviewError = nil
            errorMessage = schemaBlockingSummary(for: impact)
            return
        }

        if let impact, impact.needsSaveConfirmation {
            saveConfirmation = SchemaSaveConfirmation(draft: draft, impact: impact)
            return
        }

        performSave(draft)
    }

    private func performSave(_ draft: SupertagSchemaDraft) {
        do {
            let definition = try onSave(draft)
            selectedSchemaID = definition.supertagID
            self.draft = .editing(definition)
            refreshImpactPreview()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resetDraft() {
        if let selectedSchema {
            draft = .addingField(to: selectedSchema)
        } else {
            draft = SupertagSchemaDraft()
        }
    }

    private func prepareDelete(_ definition: SupertagFieldDefinition) {
        do {
            deletionImpactPreview = try onPreview(.editing(definition))
        } catch {
            deletionImpactPreview = nil
            errorMessage = error.localizedDescription
        }
        deletionCandidate = definition
    }

    private func refreshImpactPreview() {
        do {
            impactPreview = try loadImpactPreview(for: draft)
            impactPreviewError = nil
        } catch {
            impactPreview = nil
            impactPreviewError = error.localizedDescription
        }
    }

    private func loadImpactPreview(for draft: SupertagSchemaDraft) throws -> SupertagSchemaImpactPreview? {
        guard draft.canSave else {
            return nil
        }

        return try onPreview(draft)
    }
}

private struct SchemaSaveConfirmation: Identifiable {
    let id = UUID()
    var draft: SupertagSchemaDraft
    var impact: SupertagSchemaImpactPreview
}

private struct SchemaImpactPreviewView: View {
    let impact: SupertagSchemaImpactPreview

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(
                impact.hasBlockingIssues ? "Schema Change Blocked" : "Schema Impact Preview",
                systemImage: impact.hasBlockingIssues ? "exclamationmark.octagon" : "checklist"
            )
            .font(.caption.weight(.semibold))
            .foregroundStyle(impact.hasBlockingIssues ? .red : .secondary)

            VStack(alignment: .leading, spacing: 4) {
                LabeledContent("Tagged Entities", value: "\(impact.taggedEntityCount)")
                LabeledContent("Stored Values", value: "\(impact.storedValueCount)")
                LabeledContent("Missing Values", value: "\(impact.missingValueCount)")

                if impact.defaultBackfillCount > 0 {
                    LabeledContent("Default Backfills", value: "\(impact.defaultBackfillCount)")
                }

                if impact.renamedValueCount > 0 {
                    LabeledContent("Renamed Values", value: "\(impact.renamedValueCount)")
                }
            }

            let messages = schemaImpactMessages(for: impact)
            if !messages.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(messages, id: \.self) { message in
                        Text(message)
                    }
                }
                .foregroundStyle(impact.hasBlockingIssues ? .red : .secondary)
            }
        }
        .font(.caption)
    }
}

private func schemaImpactMessages(for impact: SupertagSchemaImpactPreview) -> [String] {
    var messages: [String] = []

    if let currentFieldKey = impact.currentFieldKey,
       currentFieldKey != impact.proposedFieldKey {
        if impact.renamedValueCount > 0 {
            messages.append(
                "\(schemaCountPhrase(impact.renamedValueCount, singular: "stored value")) will move from \(currentFieldKey) to \(impact.proposedFieldKey)."
            )
        } else {
            messages.append("Future values will use \(impact.proposedFieldKey).")
        }
    }

    if impact.currentValueType != nil,
       impact.currentValueType != impact.proposedValueType,
       impact.storedValueCount > 0,
       impact.incompatibleValueCount == 0 {
        messages.append(
            "\(schemaCountPhrase(impact.storedValueCount, singular: "stored value")) already match \(impact.proposedValueType.label)."
        )
    }

    if impact.defaultBackfillCount > 0 {
        messages.append(
            "\(schemaCountPhrase(impact.defaultBackfillCount, singular: "tagged entity", plural: "tagged entities")) will receive the default value."
        )
    }

    messages.append(contentsOf: schemaBlockingMessages(for: impact))

    if messages.isEmpty, impact.taggedEntityCount == 0 {
        messages.append("No existing entities are affected.")
    }

    return messages
}

private func schemaBlockingMessages(for impact: SupertagSchemaImpactPreview) -> [String] {
    var messages: [String] = []

    if impact.requiredMissingValueCount > 0 {
        messages.append(
            "\(schemaCountPhrase(impact.requiredMissingValueCount, singular: "tagged entity", plural: "tagged entities")) \(schemaVerb(impact.requiredMissingValueCount, singular: "is", plural: "are")) missing a required value."
        )
    }

    if impact.incompatibleValueCount > 0 {
        messages.append(
            "\(schemaCountPhrase(impact.incompatibleValueCount, singular: "stored value")) \(schemaVerb(impact.incompatibleValueCount, singular: "does", plural: "do")) not match \(impact.proposedValueType.label)."
        )
    }

    if impact.keyConflictCount > 0 {
        messages.append(
            "\(schemaCountPhrase(impact.keyConflictCount, singular: "property key conflict")) must be resolved before saving."
        )
    }

    if impact.sharedKeyConflictCount > 0 {
        messages.append(
            "\(schemaCountPhrase(impact.sharedKeyConflictCount, singular: "tagged entity", plural: "tagged entities")) \(schemaVerb(impact.sharedKeyConflictCount, singular: "shares", plural: "share")) this property through another supertag."
        )
    }

    return messages
}

private func schemaBlockingSummary(for impact: SupertagSchemaImpactPreview) -> String {
    let messages = schemaBlockingMessages(for: impact)
    guard !messages.isEmpty else {
        return "Resolve the schema impact warnings before saving."
    }

    return "Resolve before saving: \(messages.joined(separator: " "))"
}

private func schemaSaveConfirmationSummary(for impact: SupertagSchemaImpactPreview) -> String {
    var parts = [
        "This change affects \(schemaCountPhrase(impact.taggedEntityCount, singular: "tagged entity", plural: "tagged entities"))."
    ]

    if impact.renamedValueCount > 0 {
        parts.append("\(schemaCountPhrase(impact.renamedValueCount, singular: "stored value")) will be renamed.")
    }

    if impact.defaultBackfillCount > 0 {
        parts.append("\(schemaCountPhrase(impact.defaultBackfillCount, singular: "missing value")) will receive the default.")
    }

    return parts.joined(separator: " ")
}

private func schemaDeleteConfirmationSummary(
    for definition: SupertagFieldDefinition,
    impact: SupertagSchemaImpactPreview
) -> String {
    let entityPhrase = schemaCountPhrase(
        impact.taggedEntityCount,
        singular: "tagged entity",
        plural: "tagged entities"
    )
    let valuePhrase = schemaCountPhrase(impact.storedValueCount, singular: "stored value")

    return "This removes \(definition.label) from the \(definition.supertagName) schema. \(entityPhrase) \(schemaVerb(impact.taggedEntityCount, singular: "is", plural: "are")) affected. \(valuePhrase) \(schemaVerb(impact.storedValueCount, singular: "stays", plural: "stay")) as extra properties and will no longer be schema-managed."
}

private func schemaCountPhrase(_ count: Int, singular: String, plural: String? = nil) -> String {
    let plural = plural ?? "\(singular)s"
    return "\(count) \(count == 1 ? singular : plural)"
}

private func schemaVerb(_ count: Int, singular: String, plural: String) -> String {
    count == 1 ? singular : plural
}

private struct DatabaseSchemaRow: View {
    let schema: SupertagSchema

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(schema.name, systemImage: "tag")
                .font(.headline)

            HStack(spacing: 8) {
                Text("\(schema.fieldCount) properties")

                if schema.requiredFieldCount > 0 {
                    Text("\(schema.requiredFieldCount) required")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
    }
}

private struct SupertagSchemaFieldRow: View {
    let definition: SupertagFieldDefinition
    let isSelected: Bool
    let onSelect: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Button(action: onSelect) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Label(definition.label, systemImage: definition.valueType.systemImage)
                        .font(.headline)
                        .frame(minWidth: 140, alignment: .leading)

                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(definition.valueType.label)
                                .foregroundStyle(isSelected ? .primary : .secondary)

                            if definition.isRequired {
                                Label("Required", systemImage: "asterisk")
                                    .labelStyle(.titleAndIcon)
                            }
                        }
                        .font(.subheadline)

                        if let defaultValue = definition.defaultValue {
                            Text("Default: \(defaultValue)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        Text(definition.key)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }

                    Spacer(minLength: 12)

                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(Color.accentColor)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(definition.label) property")
            .accessibilityValue(isSelected ? "Selected" : "\(definition.valueType.label), key \(definition.key)")
            .accessibilityAddTraits(isSelected ? .isSelected : [])

            Button(role: .destructive, action: onDelete) {
                Label("Delete", systemImage: "trash")
            }
            .labelStyle(.iconOnly)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .background {
            if isSelected {
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color.accentColor.opacity(0.12))
            }
        }
    }
}

private struct FieldTypePicker: View {
    @Binding var selection: SupertagFieldValueType

    private let columns = [
        GridItem(.adaptive(minimum: 118), spacing: 8)
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Type")
                .font(.subheadline.weight(.semibold))

            LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
                ForEach(SupertagFieldValueType.allCases) { valueType in
                    Button {
                        selection = valueType
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: valueType.systemImage)
                                .frame(width: 18)

                            Text(valueType.label)
                                .lineLimit(1)

                            Spacer(minLength: 0)

                            if selection == valueType {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(selection == valueType ? Color.accentColor.opacity(0.14) : Color.clear)
                        }
                        .overlay {
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(
                                    selection == valueType ? Color.accentColor : Color.secondary.opacity(0.24),
                                    lineWidth: 1
                                )
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(valueType.label) field type")
                    .accessibilityValue(selection == valueType ? "Selected" : "Not selected")
                    .accessibilityAddTraits(selection == valueType ? .isSelected : [])
                }
            }
        }
        .padding(.vertical, 4)
    }
}

private struct SavedQueryViewDetailView: View {
    let savedView: SavedQueryView
    let onEdit: () -> Void
    let onDuplicate: () -> Void
    let onDelete: () -> Void
    let onOpenDocument: (UUID) -> Void
    let onOpenEntity: (UUID) -> Void
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
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: savedViewIconName(savedView.view))
                    .foregroundStyle(.secondary)

                Text(savedView.name)
                    .font(.title.weight(.semibold))
                    .lineLimit(2)
                    .textSelection(.enabled)
            }

            HStack(spacing: 8) {
                Button(action: refresh) {
                    Label("Refresh Results", systemImage: "arrow.clockwise")
                }
                .help("Refresh results")

                Button(action: onEdit) {
                    Label("Edit Saved View", systemImage: "square.and.pencil")
                }
                .help("Edit saved view")

                Button(action: onDuplicate) {
                    Label("Duplicate Saved View", systemImage: "plus.square.on.square")
                }
                .help("Duplicate saved view")

                Button(role: .destructive, action: onDelete) {
                    Label("Delete Saved View", systemImage: "trash")
                }
                .help("Delete saved view")
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.bordered)
            .controlSize(.small)

            HStack(spacing: 10) {
                Label(savedView.view.capitalized, systemImage: "rectangle.grid.1x2")

                if let groupBy = savedView.groupBy, !groupBy.isEmpty {
                    Label(groupBy, systemImage: "rectangle.3.group")
                }

                Label("Order \(savedView.sortOrder + 1)", systemImage: "arrow.up.arrow.down")

                Label {
                    Text(savedView.updatedAt, format: .dateTime.month().day().hour().minute())
                } icon: {
                    Image(systemName: "clock")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
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

                QueryResultView(
                    result: result,
                    view: normalizedQueryViewMode(savedView.view),
                    groupBy: savedView.groupBy,
                    onOpenDocument: onOpenDocument,
                    onOpenEntity: onOpenEntity
                )
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

private struct QueryResultView: View {
    let result: QueryResult
    let view: String
    let groupBy: String?
    let onOpenDocument: (UUID) -> Void
    let onOpenEntity: (UUID) -> Void

    var body: some View {
        switch view {
        case "list":
            QueryResultList(
                result: result,
                onOpenDocument: onOpenDocument,
                onOpenEntity: onOpenEntity
            )

        case "board":
            QueryResultBoard(
                result: result,
                groupBy: groupBy,
                onOpenDocument: onOpenDocument,
                onOpenEntity: onOpenEntity
            )

        default:
            QueryResultGrid(
                result: result,
                onOpenDocument: onOpenDocument,
                onOpenEntity: onOpenEntity
            )
        }
    }
}

private struct QueryResultGrid: View {
    let result: QueryResult
    let onOpenDocument: (UUID) -> Void
    let onOpenEntity: (UUID) -> Void

    var body: some View {
        if result.rows.isEmpty {
            ContentUnavailableView("No Results", systemImage: "tablecells")
        } else {
            let hasActions = result.rows.contains { row in
                queryDocumentID(row: row, columns: result.columns) != nil
                    || queryEntityID(row: row, columns: result.columns) != nil
            }

            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                    GridRow {
                        ForEach(result.columns, id: \.self) { column in
                            Text(column)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }

                        if hasActions {
                            Text("Action")
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

                            if hasActions {
                                QueryResultRowActions(
                                    row: row,
                                    columns: result.columns,
                                    onOpenDocument: onOpenDocument,
                                    onOpenEntity: onOpenEntity
                                )
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

private struct QueryResultList: View {
    let result: QueryResult
    let onOpenDocument: (UUID) -> Void
    let onOpenEntity: (UUID) -> Void

    var body: some View {
        if result.rows.isEmpty {
            ContentUnavailableView("No Results", systemImage: "list.bullet")
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(result.rows.enumerated()), id: \.offset) { _, row in
                    QueryResultCard(
                        row: row,
                        columns: result.columns,
                        excludedColumns: [],
                        onOpenDocument: onOpenDocument,
                        onOpenEntity: onOpenEntity
                    )
                }
            }
        }
    }
}

private struct QueryResultBoard: View {
    let result: QueryResult
    let groupBy: String?
    let onOpenDocument: (UUID) -> Void
    let onOpenEntity: (UUID) -> Void

    var body: some View {
        let groups = queryResultBoardGroups(result: result, groupBy: groupBy)

        if groups.isEmpty {
            ContentUnavailableView("No Results", systemImage: "rectangle.3.group")
        } else {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(groups, id: \.title) { group in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(group.title)
                                    .font(.caption.weight(.semibold))
                                    .lineLimit(1)

                                Spacer(minLength: 8)

                                Text("\(group.rows.count)")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                            }

                            ForEach(Array(group.rows.enumerated()), id: \.offset) { _, row in
                                QueryResultCard(
                                    row: row,
                                    columns: result.columns,
                                    excludedColumns: [group.column],
                                    onOpenDocument: onOpenDocument,
                                    onOpenEntity: onOpenEntity
                                )
                            }
                        }
                        .padding(10)
                        .frame(width: 260, alignment: .topLeading)
                        .background(.background, in: RoundedRectangle(cornerRadius: 8))
                        .overlay {
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(.secondary.opacity(0.16))
                        }
                    }
                }
                .padding(.bottom, 2)
            }
        }
    }
}

private struct QueryResultCard: View {
    let row: [String: String]
    let columns: [String]
    let excludedColumns: [String?]
    let onOpenDocument: (UUID) -> Void
    let onOpenEntity: (UUID) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(queryPrimaryValue(row: row, columns: columns))
                .font(.callout.weight(.semibold))
                .lineLimit(2)
                .textSelection(.enabled)

            ForEach(querySecondaryValues(row: row, columns: columns, excluding: excludedColumns), id: \.column) { item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(item.column)
                        .foregroundStyle(.secondary)
                    Text(item.value)
                        .textSelection(.enabled)
                }
                .font(.caption)
                .lineLimit(2)
            }

            QueryResultRowActions(
                row: row,
                columns: columns,
                onOpenDocument: onOpenDocument,
                onOpenEntity: onOpenEntity
            )
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .stroke(.secondary.opacity(0.16))
        }
    }
}

private struct QueryResultRowActions: View {
    let row: [String: String]
    let columns: [String]
    let onOpenDocument: (UUID) -> Void
    let onOpenEntity: (UUID) -> Void

    var body: some View {
        let documentID = queryDocumentID(row: row, columns: columns)
        let entityID = queryEntityID(row: row, columns: columns)

        if documentID != nil || entityID != nil {
            HStack(spacing: 6) {
                if let documentID {
                    Button {
                        onOpenDocument(documentID)
                    } label: {
                        Label("Open Note", systemImage: "doc.text")
                    }
                }

                if let entityID {
                    Button {
                        onOpenEntity(entityID)
                    } label: {
                        Label("Open Entity", systemImage: "at")
                    }
                }
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.bordered)
            .controlSize(.small)
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

                    Text("#\(savedView.sortOrder + 1)")
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

private func normalizedSupertagName(_ value: String) -> String {
    value
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        .lowercased()
}

private func schemaEditorFieldKey(for value: String) -> String {
    let lowercased = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    var result = ""
    var previousWasSeparator = false

    for scalar in lowercased.unicodeScalars {
        switch scalar.value {
        case 48...57, 65...90, 97...122:
            result.unicodeScalars.append(scalar)
            previousWasSeparator = false
        default:
            if !previousWasSeparator {
                result.append("_")
                previousWasSeparator = true
            }
        }
    }

    result = result.trimmingCharacters(in: CharacterSet(charactersIn: "_"))
    if let first = result.unicodeScalars.first, (48...57).contains(first.value) {
        result = "_\(result)"
    }

    let reservedColumns: Set<String> = ["id", "name", "supertags", "updated_at"]
    return reservedColumns.contains(result) ? "property_\(result)" : result
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
