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
    private(set) var selectedDocument: NoteDocument?
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
            return
        }

        selectedDocument = cachedDocument(id: id)
    }

    func openDocument(id: NoteDocument.ID) {
        guard let document = cachedDocument(id: id) else {
            return
        }

        selectedDocument = document
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
            if isSelectedDocumentSave {
                selectedDocument = document
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
            return try repository.upsertEntity(named: name, supertagNames: supertagNames, properties: properties)
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

    @discardableResult
    func saveSavedQueryView(
        named name: String,
        query: String,
        view: String = "table",
        groupBy: String? = nil
    ) throws -> SavedQueryView {
        guard let repository = requireRepository() else {
            throw SQLiteNotesError.missingDatabase
        }

        do {
            let savedView = try repository.saveSavedQueryView(
                named: name,
                query: query,
                view: view,
                groupBy: groupBy
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
    func saveSupertagFieldDefinition(
        supertagName: String,
        field: String,
        valueType: String = "text",
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
            supertagFieldDefinitions = try repository.fetchSupertagFieldDefinitions()
            return definition
        } catch {
            lastErrorMessage = error.localizedDescription
            throw error
        }
    }

    func deleteSupertagFieldDefinition(id: UUID) {
        guard let repository = requireRepository() else {
            return
        }

        do {
            try repository.deleteSupertagFieldDefinition(id: id)
            supertagFieldDefinitions = try repository.fetchSupertagFieldDefinitions()
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
        supertagFieldDefinitions = try repository.fetchSupertagFieldDefinitions()

        let allDocuments = dailyNotes + standaloneNotes
        if let selectedID, let selected = allDocuments.first(where: { $0.id == selectedID }) {
            selectedDocument = selected
        } else {
            selectedDocument = allDocuments.first
        }
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

    private func fallbackDate(movingByDays dayOffset: Int) -> Date {
        let calendar = Calendar(identifier: .gregorian)
        return calendar.date(byAdding: .day, value: dayOffset, to: .now) ?? .now
    }

    private func normalizedTitle(_ title: String, fallback: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }
}
