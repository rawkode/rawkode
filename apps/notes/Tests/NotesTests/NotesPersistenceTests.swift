import XCTest
import SQLite3
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

    func testEntityUpsertReusesEntityAndLinksSupertags() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let first = try repository.upsertEntity(
            named: "  Rawkode Academy  ",
            supertagNames: ["person", "#customer", "person"]
        )
        let second = try repository.upsertEntity(
            named: "Rawkode Academy",
            supertagNames: ["company"]
        )

        XCTAssertEqual(first.id, second.id)
        XCTAssertEqual(first.label, "Rawkode Academy")
        XCTAssertEqual(first.supertags, ["customer", "person"])
        XCTAssertEqual(second.supertags, ["company", "customer", "person"])
    }

    func testEntityUpsertRollsBackPartialWritesAfterSupertagFailure() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        try executeRawSQL(
            """
            CREATE TRIGGER fail_blocked_supertag
            BEFORE INSERT ON supertags
            WHEN NEW.name = 'blocked'
            BEGIN
                SELECT RAISE(ABORT, 'blocked supertag');
            END;
            """,
            databaseURL: databaseURL
        )

        XCTAssertThrowsError(
            try repository.upsertEntity(named: "Atomic Entity", supertagNames: ["blocked"])
        )

        XCTAssertEqual(try countRows("entities", matching: "canonical_name = 'Atomic Entity'", databaseURL: databaseURL), 0)
        XCTAssertEqual(try countRows("supertags", matching: "name = 'blocked'", databaseURL: databaseURL), 0)
        XCTAssertEqual(try countRows("entity_supertags", databaseURL: databaseURL), 0)
    }

    func testRunQueryReadsDailyNotesAndSupertagCollections() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let dailyNote = try repository.createDailyNote(date: "2026-06-16")
        _ = try repository.upsertEntity(named: "Rawkode Academy", supertagNames: ["bookmark", "company"])

        let dailyResult = try repository.runQuery("SELECT * FROM daily_notes WHERE date = '2026-06-16'")
        XCTAssertEqual(dailyResult.columns, ["id", "date", "title", "updated_at"])
        XCTAssertEqual(dailyResult.rows.count, 1)
        XCTAssertEqual(dailyResult.rows.first?["id"], dailyNote.id.uuidString)

        let bookmarks = try repository.runQuery("SELECT * FROM bookmarks WHERE name CONTAINS academy")
        XCTAssertEqual(bookmarks.columns, ["id", "name", "supertags", "updated_at"])
        XCTAssertEqual(bookmarks.rows.count, 1)
        XCTAssertEqual(bookmarks.rows.first?["name"], "Rawkode Academy")
        XCTAssertEqual(bookmarks.rows.first?["supertags"], "bookmark, company")
    }

    func testRunQueryRejectsUnsupportedStatements() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        XCTAssertThrowsError(try repository.runQuery("DELETE FROM entities"))

        let entities = try repository.runQuery("SELECT * FROM entities")
        XCTAssertEqual(entities.columns, ["id", "name", "supertags", "updated_at"])
        XCTAssertTrue(entities.rows.isEmpty)
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

    private func executeRawSQL(_ sql: String, databaseURL: URL) throws {
        let db = try openRawDatabase(at: databaseURL)
        defer {
            sqlite3_close(db)
        }

        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &error) == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? "unknown SQLite error"
            sqlite3_free(error)
            throw SQLiteTestError.executionFailed(message)
        }
    }

    private func countRows(_ table: String, matching predicate: String? = nil, databaseURL: URL) throws -> Int {
        let db = try openRawDatabase(at: databaseURL)
        defer {
            sqlite3_close(db)
        }

        let sql = "SELECT COUNT(*) FROM \(table)\(predicate.map { " WHERE \($0)" } ?? "");"
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw SQLiteTestError.executionFailed(String(cString: sqlite3_errmsg(db)))
        }

        defer {
            sqlite3_finalize(statement)
        }

        guard sqlite3_step(statement) == SQLITE_ROW else {
            throw SQLiteTestError.executionFailed(String(cString: sqlite3_errmsg(db)))
        }

        return Int(sqlite3_column_int(statement, 0))
    }

    private func openRawDatabase(at databaseURL: URL) throws -> OpaquePointer? {
        var db: OpaquePointer?
        guard sqlite3_open_v2(databaseURL.path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown SQLite error"
            sqlite3_close(db)
            throw SQLiteTestError.executionFailed(message)
        }

        return db
    }
}

private enum SQLiteTestError: Error {
    case executionFailed(String)
}
