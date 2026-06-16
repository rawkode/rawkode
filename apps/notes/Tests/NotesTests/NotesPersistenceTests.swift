import XCTest
@testable import Notes

final class NotesPersistenceTests: XCTestCase {
    func testDailyNoteCreationIsUniqueForDate() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let first = try repository.createDailyNote(date: "2026-06-16")
        let second = try repository.createDailyNote(date: "2026-06-16")

        XCTAssertEqual(first.id, second.id)
        XCTAssertEqual(try repository.fetchDocuments(kind: .daily).count, 1)
    }

    func testDocumentContentPersistsAcrossRepositoryInstances() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        var document = try repository.createStandaloneNote()
        document.title = "Persisted note"
        document.tiptapJSON = #"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Saved body"}]}]}"#
        document.plainText = "Saved body"
        try repository.upsertDocument(document)

        let reopenedRepository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let fetched = try XCTUnwrap(reopenedRepository.fetchDocument(id: document.id))

        XCTAssertEqual(fetched.title, "Persisted note")
        XCTAssertEqual(fetched.tiptapJSON, document.tiptapJSON)
        XCTAssertEqual(fetched.plainText, "Saved body")
    }

    @MainActor
    func testDailyNotesCannotBeDeletedFromStore() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let store = NotesStore(repository: repository)

        store.load()
        let dailyNote = try XCTUnwrap(store.dailyNotes.first)
        store.deleteDocument(id: dailyNote.id)

        XCTAssertEqual(store.dailyNotes.count, 1)
        XCTAssertEqual(store.dailyNotes.first?.id, dailyNote.id)
        XCTAssertEqual(store.lastErrorMessage, "Daily notes are calendar-backed and cannot be deleted.")
    }

    private func temporaryDatabaseURL() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotesTests-\(UUID().uuidString)", isDirectory: true)

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("notes.sqlite")
    }

    private func removeTemporaryDatabase(at databaseURL: URL) {
        try? FileManager.default.removeItem(at: databaseURL.deletingLastPathComponent())
    }
}
