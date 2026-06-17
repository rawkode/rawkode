import Foundation
import Observation

@MainActor
@Observable
final class NotesStore {
    @ObservationIgnored
    private let repository: SQLiteNotesRepository?

    private(set) var dailyNotes: [NoteDocument] = []
    private(set) var standaloneNotes: [NoteDocument] = []
    private(set) var savedQueryViews: [SavedQueryView] = []
    private(set) var supertagFieldDefinitions: [SupertagFieldDefinition] = []
    private(set) var supertagSchemas: [SupertagSchema] = []
    private(set) var selectedDocument: NoteDocument?
    private(set) var selectedEntityDetail: EntityDetail?
    private(set) var selectedDocumentContext = DocumentContext.empty
    private(set) var lastErrorMessage: String?

    init(repository: SQLiteNotesRepository? = nil) {
        do {
            self.repository = try repository ?? SQLiteNotesRepository()
        } catch {
            self.repository = nil
            lastErrorMessage = error.localizedDescription
        }
    }

    func load() {
        guard let repository = requireRepository() else {
            return
        }

        do {
            let today = try repository.createDailyNote(date: DailyNoteDateFormatter.storageString(from: .now))
            try reloadDocuments(selecting: selectedDocument?.id ?? today.id)
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    func selectToday() {
        guard let repository = requireRepository() else {
            return
        }

        do {
            let today = try repository.createDailyNote(date: DailyNoteDateFormatter.storageString(from: .now))
            try reloadDocuments(selecting: today.id)
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    func selectTomorrow() {
        guard let repository = requireRepository() else {
            return
        }

        let tomorrowDate = DailyNoteDateFormatter.relativeStorageString(for: "tomorrow")
            ?? DailyNoteDateFormatter.storageString(from: fallbackDate(movingByDays: 1))

        do {
            let tomorrow = try repository.createDailyNote(date: tomorrowDate)
            try reloadDocuments(selecting: tomorrow.id)
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    func createDailyNote(for date: Date = .now) {
        guard let repository = requireRepository() else {
            return
        }

        do {
            let document = try repository.createDailyNote(date: DailyNoteDateFormatter.storageString(from: date))
            try reloadDocuments(selecting: document.id)
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    func openDailyNote(movingByDays dayOffset: Int) {
        guard let repository = requireRepository() else {
            return
        }

        let currentDailyDate = selectedDocument?.kind == .daily ? selectedDocument?.date : nil
        let targetDate = currentDailyDate
            .flatMap { DailyNoteDateFormatter.storageString(byAddingDays: dayOffset, to: $0) }
            ?? DailyNoteDateFormatter.storageString(from: fallbackDate(movingByDays: dayOffset))

        do {
            let document = try repository.createDailyNote(date: targetDate)
            try reloadDocuments(selecting: document.id)
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    func createStandaloneNote() {
        guard let repository = requireRepository() else {
            return
        }

        do {
            let document = try repository.createStandaloneNote()
            try reloadDocuments(selecting: document.id)
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    func selectDocument(id: NoteDocument.ID?) {
        guard let id else {
            selectedDocument = nil
            selectedEntityDetail = nil
            selectedDocumentContext = .empty
            return
        }

        selectedDocument = cachedDocument(id: id)
        selectedEntityDetail = nil
        refreshSelectedDocumentContext()
    }

    func openDocument(id: NoteDocument.ID) {
        guard let document = cachedDocument(id: id) else {
            return
        }

        selectedDocument = document
        selectedEntityDetail = nil
        refreshSelectedDocumentContext()
    }

    func openEntity(id: EntityDetail.ID) {
        guard let repository = requireRepository() else {
            return
        }

        do {
            guard let detail = try repository.fetchEntityDetail(entityID: id) else {
                lastErrorMessage = "Entity could not be found."
                return
            }

            selectedDocument = nil
            selectedDocumentContext = .empty
            selectedEntityDetail = detail
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    func saveEditorChange(documentID: UUID, title: String, contentJSON: String, plainText: String) {
        guard let repository = requireRepository() else {
            return
        }

        guard var document = (dailyNotes + standaloneNotes).first(where: { $0.id == documentID }) else {
            return
        }

        let isSelectedDocumentSave = selectedDocument?.id == documentID
        document.title = normalizedTitle(title, fallback: document.title)
        document.tiptapJSON = contentJSON
        document.plainText = plainText
        document.updatedAt = .now

        do {
            try repository.upsertDocument(document)
            replaceCached(document)
            try reloadSupertagSchemaCache()
            if isSelectedDocumentSave {
                selectedDocument = document
                refreshSelectedDocumentContext()
            }
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    func deleteSelectedDocument() {
        guard let selectedDocument else {
            return
        }

        deleteDocument(id: selectedDocument.id)
    }

    func deleteDocument(id: UUID) {
        guard let repository = requireRepository() else {
            return
        }

        guard let document = (dailyNotes + standaloneNotes).first(where: { $0.id == id }) else {
            return
        }

        guard document.kind != .daily else {
            lastErrorMessage = "Daily notes are calendar-backed and cannot be deleted."
            return
        }

        do {
            try repository.deleteDocument(id: id)
            let nextID = nextSelection(afterDeleting: id)
            try reloadDocuments(selecting: nextID)
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    func upsertEntity(
        named name: String,
        supertagNames: [String],
        properties: [String: String]? = nil
    ) throws -> EntityReference {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            let entity = try repository.upsertEntity(named: name, supertagNames: supertagNames, properties: properties)
            try reloadSupertagSchemaCache()
            if selectedEntityDetail?.id == entity.id {
                selectedEntityDetail = try repository.fetchEntityDetail(entityID: entity.id)
            }
            refreshSelectedDocumentContext()
            return entity
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    @discardableResult
    func updateEntityProperty(entityID: UUID, key: String, value: String) throws -> EntityDetail {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            guard let currentDetail = try repository.fetchEntityDetail(entityID: entityID) else {
                throw SQLiteNotesError.validationFailed("Entity could not be found.")
            }

            let entityReferenceFieldKeys = entityReferencePropertyKeys(for: currentDetail)
            var properties = editableProperties(from: currentDetail, entityReferenceFieldKeys: entityReferenceFieldKeys)
            let normalizedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if normalizedValue.isEmpty {
                properties.removeValue(forKey: key)
            } else if entityReferenceFieldKeys.contains(key), !isEntityReferenceSyntax(normalizedValue) {
                properties[key] = "[[\(normalizedValue)]]"
            } else {
                properties[key] = normalizedValue
            }

            _ = try repository.upsertEntity(
                named: currentDetail.name,
                supertagNames: currentDetail.supertags,
                properties: properties
            )

            guard let updatedDetail = try repository.fetchEntityDetail(entityID: entityID) else {
                throw SQLiteNotesError.validationFailed("Entity could not be found.")
            }

            if selectedEntityDetail?.id == entityID {
                selectedEntityDetail = updatedDetail
            }
            return updatedDetail
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    func runQuery(_ query: String) throws -> QueryResult {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            return try repository.runQuery(query)
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    func documentContext(for documentID: UUID) throws -> DocumentContext {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            return try repository.fetchDocumentContext(documentID: documentID)
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    @discardableResult
    func saveSavedQueryView(
        named name: String,
        query: String,
        view: String = "table",
        groupBy: String? = nil,
        visibleColumns: [String] = [],
        sortColumn: String? = nil,
        sortDescending: Bool = false,
        rowLimit: Int? = nil
    ) throws -> SavedQueryView {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            let savedView = try repository.saveSavedQueryView(
                named: name,
                query: query,
                view: view,
                groupBy: groupBy,
                visibleColumns: visibleColumns,
                sortColumn: sortColumn,
                sortDescending: sortDescending,
                rowLimit: rowLimit
            )
            savedQueryViews = try repository.fetchSavedQueryViews()
            return savedView
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    @discardableResult
    func createSavedQueryView(
        named name: String,
        query: String,
        view: String = "table",
        groupBy: String? = nil,
        visibleColumns: [String] = [],
        sortColumn: String? = nil,
        sortDescending: Bool = false,
        rowLimit: Int? = nil
    ) throws -> SavedQueryView {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            let savedView = try repository.createSavedQueryView(
                named: name,
                query: query,
                view: view,
                groupBy: groupBy,
                visibleColumns: visibleColumns,
                sortColumn: sortColumn,
                sortDescending: sortDescending,
                rowLimit: rowLimit
            )
            savedQueryViews = try repository.fetchSavedQueryViews()
            return savedView
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    func deleteSavedQueryView(id: UUID) {
        guard let repository = requireRepository() else {
            return
        }

        do {
            try repository.deleteSavedQueryView(id: id)
            savedQueryViews = try repository.fetchSavedQueryViews()
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    @discardableResult
    func updateSavedQueryView(
        id: UUID,
        named name: String,
        query: String,
        view: String = "table",
        groupBy: String? = nil,
        visibleColumns: [String] = [],
        sortColumn: String? = nil,
        sortDescending: Bool = false,
        rowLimit: Int? = nil
    ) throws -> SavedQueryView {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            let savedView = try repository.updateSavedQueryView(
                id: id,
                named: name,
                query: query,
                view: view,
                groupBy: groupBy,
                visibleColumns: visibleColumns,
                sortColumn: sortColumn,
                sortDescending: sortDescending,
                rowLimit: rowLimit
            )
            savedQueryViews = try repository.fetchSavedQueryViews()
            return savedView
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    @discardableResult
    func duplicateSavedQueryView(id: UUID) throws -> SavedQueryView {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            let savedView = try repository.duplicateSavedQueryView(id: id)
            savedQueryViews = try repository.fetchSavedQueryViews()
            return savedView
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    func reorderSavedQueryViews(ids orderedIDs: [UUID]) {
        guard let repository = requireRepository() else {
            return
        }

        do {
            try repository.reorderSavedQueryViews(ids: orderedIDs)
            savedQueryViews = try repository.fetchSavedQueryViews()
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    @discardableResult
    func saveSupertagFieldDefinition(
        supertagName: String,
        field: String,
        valueType: SupertagFieldValueType = .text,
        defaultValue: String? = nil,
        isRequired: Bool = false,
        sortOrder: Int = 0
    ) throws -> SupertagFieldDefinition {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            let definition = try repository.saveSupertagFieldDefinition(
                supertagName: supertagName,
                field: field,
                valueType: valueType,
                defaultValue: defaultValue,
                isRequired: isRequired,
                sortOrder: sortOrder
            )
            try reloadSupertagSchemaCache()
            return definition
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    @discardableResult
    func updateSupertagFieldDefinition(
        id: UUID,
        field: String,
        valueType: SupertagFieldValueType = .text,
        defaultValue: String? = nil,
        isRequired: Bool = false,
        sortOrder: Int = 0
    ) throws -> SupertagFieldDefinition {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            let definition = try repository.updateSupertagFieldDefinition(
                id: id,
                field: field,
                valueType: valueType,
                defaultValue: defaultValue,
                isRequired: isRequired,
                sortOrder: sortOrder
            )
            try reloadSupertagSchemaCache()
            return definition
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    func previewSupertagFieldDefinitionChange(
        id: UUID? = nil,
        supertagName: String,
        field: String,
        valueType: SupertagFieldValueType = .text,
        defaultValue: String? = nil,
        isRequired: Bool = false
    ) throws -> SupertagSchemaImpactPreview {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        return try repository.previewSupertagFieldDefinitionChange(
            id: id,
            supertagName: supertagName,
            field: field,
            valueType: valueType,
            defaultValue: defaultValue,
            isRequired: isRequired
        )
    }

    func deleteSupertagFieldDefinition(id: UUID) {
        guard let repository = requireRepository() else {
            return
        }

        do {
            try repository.deleteSupertagFieldDefinition(id: id)
            try reloadSupertagSchemaCache()
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    func exportVault() throws -> NotesVaultSnapshot {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            return try repository.exportVault()
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    func exportVaultJSON() throws -> Data {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            return try repository.exportVaultJSON()
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    func importVault(_ snapshot: NotesVaultSnapshot) throws {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            try repository.importVault(snapshot)
            try reloadDocuments(selecting: selectedDocument?.id)
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    func importVaultJSON(_ data: Data) throws {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            try repository.importVaultJSON(data)
            try reloadDocuments(selecting: selectedDocument?.id)
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    func clearError() {
        lastErrorMessage = nil
    }

    private func requireRepository() -> SQLiteNotesRepository? {
        if repository == nil {
            lastErrorMessage = "Notes database is unavailable."
        }

        return repository
    }

    private func reloadDocuments(selecting selectedID: UUID?) throws {
        guard let repository else {
            throw SQLiteNotesError.missingDatabase
        }

        dailyNotes = try repository.fetchDocuments(kind: .daily)
        standaloneNotes = try repository.fetchDocuments(kind: .note)
        savedQueryViews = try repository.fetchSavedQueryViews()
        try reloadSupertagSchemaCache()

        let allDocuments = dailyNotes + standaloneNotes
        if let selectedID, let selected = allDocuments.first(where: { $0.id == selectedID }) {
            selectedDocument = selected
            selectedEntityDetail = nil
        } else {
            selectedDocument = allDocuments.first
            selectedEntityDetail = nil
        }

        refreshSelectedDocumentContext()
    }

    private func replaceCached(_ document: NoteDocument) {
        switch document.kind {
        case .daily:
            if let index = dailyNotes.firstIndex(where: { $0.id == document.id }) {
                dailyNotes[index] = document
            }
        case .note:
            if let index = standaloneNotes.firstIndex(where: { $0.id == document.id }) {
                standaloneNotes[index] = document
            }
        }
    }

    private func cachedDocument(id: UUID) -> NoteDocument? {
        (dailyNotes + standaloneNotes).first { $0.id == id }
    }

    private func nextSelection(afterDeleting deletedID: UUID) -> UUID? {
        let remaining = (dailyNotes + standaloneNotes).filter { $0.id != deletedID }
        return remaining.first?.id
    }

    private func refreshSelectedDocumentContext() {
        guard let repository, let selectedDocument else {
            selectedDocumentContext = .empty
            return
        }

        do {
            selectedDocumentContext = try repository.fetchDocumentContext(documentID: selectedDocument.id)
        } catch {
            selectedDocumentContext = .empty
            lastErrorMessage = error.localizedDescription
        }
    }

    private func reloadSupertagSchemaCache() throws {
        guard let repository else {
            throw SQLiteNotesError.missingDatabase
        }

        supertagFieldDefinitions = try repository.fetchSupertagFieldDefinitions()
        supertagSchemas = try repository.fetchSupertagSchemas()
    }

    private func fallbackDate(movingByDays dayOffset: Int) -> Date {
        let calendar = Calendar(identifier: .gregorian)
        return calendar.date(byAdding: .day, value: dayOffset, to: .now) ?? .now
    }

    private func normalizedTitle(_ title: String, fallback: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }

    private func editableProperties(
        from detail: EntityDetail,
        entityReferenceFieldKeys: Set<String>
    ) -> [String: String] {
        var properties = detail.properties
        for key in entityReferenceFieldKeys {
            guard let value = properties[key]?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty,
                  !isEntityReferenceSyntax(value) else {
                continue
            }

            properties[key] = "[[\(value)]]"
        }

        return properties
    }

    private func entityReferencePropertyKeys(for detail: EntityDetail) -> Set<String> {
        let appliedTags = Set(detail.supertags.map(normalizedSupertagIdentifier))
        let fields = supertagSchemas
            .filter { schema in
                appliedTags.contains(normalizedSupertagIdentifier(schema.name))
                    || appliedTags.contains(normalizedSupertagIdentifier(schema.slug))
            }
            .flatMap(\.fields)

        var keys = Set(fields.filter { $0.valueType == .entity }.map(\.key))
        keys.formUnion(detail.outgoingRelationships.map(\.property))
        return keys
    }
}

private func normalizedSupertagIdentifier(_ value: String) -> String {
    value
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        .lowercased()
}

private func isEntityReferenceSyntax(_ value: String) -> Bool {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.hasPrefix("[[") && trimmed.hasSuffix("]]")
}
