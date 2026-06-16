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

    func testEntityPropertiesAreQueryableAsDynamicColumns() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let entity = try repository.upsertEntity(
            named: "Rawkode Academy",
            supertagNames: ["bookmark", "company"],
            properties: [
                "URL": "https://rawkode.academy",
                "Status": "active",
                "Updated At": "weekly",
            ]
        )

        XCTAssertEqual(entity.properties["url"], "https://rawkode.academy")
        XCTAssertEqual(entity.properties["status"], "active")
        XCTAssertEqual(entity.properties["updated_at"], nil)
        XCTAssertEqual(entity.properties["property_updated_at"], "weekly")

        let preserved = try repository.upsertEntity(named: "Rawkode Academy", supertagNames: ["project"])
        XCTAssertEqual(preserved.properties["url"], "https://rawkode.academy")

        let bookmarks = try repository.runQuery("SELECT * FROM bookmarks WHERE url CONTAINS rawkode")
        XCTAssertTrue(bookmarks.columns.contains("url"))
        XCTAssertTrue(bookmarks.columns.contains("status"))
        XCTAssertTrue(bookmarks.columns.contains("property_updated_at"))
        XCTAssertEqual(bookmarks.rows.count, 1)
        XCTAssertEqual(bookmarks.rows.first?["name"], "Rawkode Academy")
        XCTAssertEqual(bookmarks.rows.first?["url"], "https://rawkode.academy")
        XCTAssertEqual(bookmarks.rows.first?["status"], "active")
        XCTAssertEqual(bookmarks.rows.first?["supertags"], "bookmark, company, project")
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

    func testRunQueryOrdersAndLimitsDynamicViews() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(named: "Alpha Resource", supertagNames: ["bookmark"])
        _ = try repository.upsertEntity(named: "Beta Resource", supertagNames: ["bookmark"])
        _ = try repository.upsertEntity(named: "Gamma Resource", supertagNames: ["bookmark"])

        let result = try repository.runQuery(
            "SELECT * FROM bookmarks WHERE name CONTAINS resource ORDER BY name DESC LIMIT 2"
        )

        XCTAssertEqual(result.rows.map { $0["name"] }, ["Gamma Resource", "Beta Resource"])
    }

    func testRunQueryRejectsUnsupportedStatements() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        XCTAssertThrowsError(try repository.runQuery("DELETE FROM entities"))
        XCTAssertThrowsError(try repository.runQuery("SELECT * FROM entities ORDER BY missing"))

        let entities = try repository.runQuery("SELECT * FROM entities")
        XCTAssertEqual(entities.columns, ["id", "name", "supertags", "updated_at"])
        XCTAssertTrue(entities.rows.isEmpty)
    }

    func testEntityReferenceIndexTracksSavedDocumentContent() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let entity = try repository.upsertEntity(named: "Rawkode Academy", supertagNames: ["company"])
        var document = try repository.createStandaloneNote()
        document.title = "Meeting note"
        document.tiptapJSON = """
        {"type":"doc","content":[{"type":"paragraph","content":[{"type":"entityReference","attrs":{"entityId":"\(entity.id.uuidString)","label":"Rawkode Academy","tags":["company"]}}]}]}
        """
        try repository.upsertDocument(document)

        let references = try repository.runQuery("SELECT * FROM entity_references WHERE entity CONTAINS academy")
        XCTAssertEqual(references.columns, ["name", "entity", "document", "document_kind", "date", "entity_id", "document_id"])
        XCTAssertEqual(references.rows.count, 1)
        XCTAssertEqual(references.rows.first?["name"], "Rawkode Academy -> Meeting note")
        XCTAssertEqual(references.rows.first?["entity_id"], entity.id.uuidString)
        XCTAssertEqual(references.rows.first?["document"], "Meeting note")

        document.tiptapJSON = #"{"type":"doc","content":[{"type":"paragraph"}]}"#
        try repository.upsertDocument(document)

        XCTAssertTrue(try repository.runQuery("SELECT * FROM backlinks").rows.isEmpty)
    }

    func testEntityReferenceIndexBackfillsExistingDocumentsDuringMigration() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let entityID = UUID()
        let documentID = UUID()
        let now = Date().ISO8601Format()
        try executeRawSQL(
            """
            CREATE TABLE documents (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK (kind IN ('daily', 'note')),
                date TEXT,
                title TEXT NOT NULL,
                tiptap_json TEXT NOT NULL,
                plain_text TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE entities (
                id TEXT PRIMARY KEY,
                canonical_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            INSERT INTO entities (id, canonical_name, created_at, updated_at)
            VALUES ('\(entityID.uuidString)', 'Rawkode Academy', '\(now)', '\(now)');

            INSERT INTO documents (id, kind, date, title, tiptap_json, plain_text, created_at, updated_at)
            VALUES (
                '\(documentID.uuidString)',
                'daily',
                '2026-06-16',
                'Legacy daily note',
                '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"entityReference","attrs":{"entityId":"\(entityID.uuidString)","label":"Rawkode Academy","tags":[]}}]}]}',
                '',
                '\(now)',
                '\(now)'
            );
            """,
            databaseURL: databaseURL,
            createIfNeeded: true
        )

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let references = try repository.runQuery("SELECT * FROM backlinks WHERE document CONTAINS legacy")

        XCTAssertEqual(references.rows.count, 1)
        XCTAssertEqual(references.rows.first?["name"], "Rawkode Academy -> Legacy daily note")
        XCTAssertEqual(references.rows.first?["entity"], "Rawkode Academy")
        XCTAssertEqual(references.rows.first?["document_id"], documentID.uuidString)
        XCTAssertEqual(references.rows.first?["date"], "2026-06-16")
    }

    @MainActor
    func testStoreCanOpenDailyNoteForSelectedDate() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let store = NotesStore(repository: repository)
        let selectedDate = try XCTUnwrap(
            Calendar(identifier: .gregorian).date(from: DateComponents(year: 2026, month: 1, day: 5, hour: 12))
        )
        let storageDate = DailyNoteDateFormatter.storageString(from: selectedDate)

        store.load()
        store.createDailyNote(for: selectedDate)

        XCTAssertEqual(store.selectedDocument?.kind, .daily)
        XCTAssertEqual(store.selectedDocument?.date, storageDate)
        XCTAssertTrue(store.dailyNotes.contains { $0.date == storageDate })

        store.createDailyNote(for: selectedDate)

        XCTAssertEqual(store.dailyNotes.filter { $0.date == storageDate }.count, 1)
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

    private func executeRawSQL(_ sql: String, databaseURL: URL, createIfNeeded: Bool = false) throws {
        let db = try openRawDatabase(at: databaseURL, createIfNeeded: createIfNeeded)
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

    private func openRawDatabase(at databaseURL: URL, createIfNeeded: Bool = false) throws -> OpaquePointer? {
        var db: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | (createIfNeeded ? SQLITE_OPEN_CREATE : 0)
        guard sqlite3_open_v2(databaseURL.path, &db, flags, nil) == SQLITE_OK else {
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
