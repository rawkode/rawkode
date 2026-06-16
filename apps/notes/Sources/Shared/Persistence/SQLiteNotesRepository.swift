import Foundation
import SQLite3

enum SQLiteNotesError: LocalizedError {
    case openFailed(String)
    case prepareFailed(String)
    case stepFailed(String)
    case rowDecodeFailed(String)
    case missingDatabase

    var errorDescription: String? {
        switch self {
        case .openFailed(let message):
            "Could not open notes database: \(message)"
        case .prepareFailed(let message):
            "Could not prepare notes database statement: \(message)"
        case .stepFailed(let message):
            "Could not execute notes database statement: \(message)"
        case .rowDecodeFailed(let message):
            "Could not read notes database row: \(message)"
        case .missingDatabase:
            "Notes database has not been opened."
        }
    }
}

final class SQLiteNotesRepository {
    private var db: OpaquePointer?

    init(databaseURL: URL? = nil) throws {
        let url = try databaseURL ?? Self.defaultDatabaseURL()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        var connection: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(url.path, &connection, flags, nil) == SQLITE_OK else {
            let message = connection.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown error"
            sqlite3_close(connection)
            throw SQLiteNotesError.openFailed(message)
        }

        db = connection
        try execute("PRAGMA foreign_keys = ON;")
        try execute("PRAGMA journal_mode = WAL;")
        try migrate()
    }

    deinit {
        sqlite3_close(db)
    }

    func fetchDocuments(kind: NoteDocumentKind? = nil) throws -> [NoteDocument] {
        if let kind {
            return try query(
                """
                SELECT id, kind, date, title, tiptap_json, plain_text, created_at, updated_at
                FROM documents
                WHERE kind = ?
                ORDER BY COALESCE(date, updated_at) DESC, updated_at DESC;
                """,
                bind: { statement in
                    sqlite3_bind_text(statement, 1, kind.rawValue, -1, sqliteTransient)
                }
            )
        }

        return try query(
            """
            SELECT id, kind, date, title, tiptap_json, plain_text, created_at, updated_at
            FROM documents
            ORDER BY updated_at DESC;
            """
        )
    }

    func fetchDocument(id: UUID) throws -> NoteDocument? {
        try query(
            """
            SELECT id, kind, date, title, tiptap_json, plain_text, created_at, updated_at
            FROM documents
            WHERE id = ?
            LIMIT 1;
            """,
            bind: { statement in
                sqlite3_bind_text(statement, 1, id.uuidString, -1, sqliteTransient)
            }
        )
        .first
    }

    func fetchDailyNote(date storageDate: String) throws -> NoteDocument? {
        try query(
            """
            SELECT id, kind, date, title, tiptap_json, plain_text, created_at, updated_at
            FROM documents
            WHERE kind = ? AND date = ?
            LIMIT 1;
            """,
            bind: { statement in
                sqlite3_bind_text(statement, 1, NoteDocumentKind.daily.rawValue, -1, sqliteTransient)
                sqlite3_bind_text(statement, 2, storageDate, -1, sqliteTransient)
            }
        )
        .first
    }

    func upsertDocument(_ document: NoteDocument) throws {
        try prepare(
            """
            INSERT INTO documents (
                id, kind, date, title, tiptap_json, plain_text, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind,
                date = excluded.date,
                title = excluded.title,
                tiptap_json = excluded.tiptap_json,
                plain_text = excluded.plain_text,
                updated_at = excluded.updated_at;
            """
        ) { statement in
            bind(document, to: statement)
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    func createDailyNote(date storageDate: String) throws -> NoteDocument {
        if let existing = try fetchDailyNote(date: storageDate) {
            return existing
        }

        let now = Date()
        let document = NoteDocument(
            id: UUID(),
            kind: .daily,
            date: storageDate,
            title: DailyNoteDateFormatter.displayTitle(for: storageDate),
            tiptapJSON: Self.defaultDailyNoteJSON(title: DailyNoteDateFormatter.displayTitle(for: storageDate)),
            plainText: "",
            createdAt: now,
            updatedAt: now
        )

        try upsertDocument(document)
        return document
    }

    func createStandaloneNote() throws -> NoteDocument {
        let now = Date()
        let document = NoteDocument(
            id: UUID(),
            kind: .note,
            date: nil,
            title: "Untitled Note",
            tiptapJSON: Self.defaultNoteJSON,
            plainText: "",
            createdAt: now,
            updatedAt: now
        )

        try upsertDocument(document)
        return document
    }

    func deleteDocument(id: UUID) throws {
        try prepare("DELETE FROM documents WHERE id = ?;") { statement in
            sqlite3_bind_text(statement, 1, id.uuidString, -1, sqliteTransient)
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    static func defaultDailyNoteJSON(title: String) -> String {
        """
        {"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"\(escapeJSON(title))"}]},{"type":"paragraph","content":[{"type":"text","text":"Capture the day. Add sketches inline."}]}]}
        """
    }

    private static let defaultNoteJSON = """
    {"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Untitled Note"}]},{"type":"paragraph"}]}
    """

    private func migrate() throws {
        try execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK (kind IN ('daily', 'note')),
                date TEXT,
                title TEXT NOT NULL,
                tiptap_json TEXT NOT NULL,
                plain_text TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_daily_date
            ON documents(date)
            WHERE kind = 'daily';

            CREATE INDEX IF NOT EXISTS idx_documents_kind_updated_at
            ON documents(kind, updated_at DESC);
            """
        )
    }

    private static func defaultDatabaseURL() throws -> URL {
        let appSupport = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )

        return appSupport
            .appendingPathComponent("Notes", isDirectory: true)
            .appendingPathComponent("notes.sqlite")
    }

    private func execute(_ sql: String) throws {
        guard let db else {
            throw SQLiteNotesError.missingDatabase
        }

        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &error) == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? lastErrorMessage
            sqlite3_free(error)
            throw SQLiteNotesError.stepFailed(message)
        }
    }

    private func query(
        _ sql: String,
        bind: (OpaquePointer?) throws -> Void = { _ in }
    ) throws -> [NoteDocument] {
        try prepare(sql) { statement in
            try bind(statement)
            var documents: [NoteDocument] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                documents.append(try document(from: statement))
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return documents
        }
    }

    private func prepare<T>(
        _ sql: String,
        _ body: (OpaquePointer?) throws -> T
    ) throws -> T {
        guard let db else {
            throw SQLiteNotesError.missingDatabase
        }

        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw SQLiteNotesError.prepareFailed(lastErrorMessage)
        }

        defer {
            sqlite3_finalize(statement)
        }

        return try body(statement)
    }

    private func bind(_ document: NoteDocument, to statement: OpaquePointer?) {
        sqlite3_bind_text(statement, 1, document.id.uuidString, -1, sqliteTransient)
        sqlite3_bind_text(statement, 2, document.kind.rawValue, -1, sqliteTransient)

        if let date = document.date {
            sqlite3_bind_text(statement, 3, date, -1, sqliteTransient)
        } else {
            sqlite3_bind_null(statement, 3)
        }

        sqlite3_bind_text(statement, 4, document.title, -1, sqliteTransient)
        sqlite3_bind_text(statement, 5, document.tiptapJSON, -1, sqliteTransient)
        sqlite3_bind_text(statement, 6, document.plainText, -1, sqliteTransient)
        sqlite3_bind_text(statement, 7, document.createdAt.ISO8601Format(), -1, sqliteTransient)
        sqlite3_bind_text(statement, 8, document.updatedAt.ISO8601Format(), -1, sqliteTransient)
    }

    private func document(from statement: OpaquePointer?) throws -> NoteDocument {
        guard let id = UUID(uuidString: textColumn(statement, 0)) else {
            throw SQLiteNotesError.rowDecodeFailed("invalid document id")
        }

        guard let kind = NoteDocumentKind(rawValue: textColumn(statement, 1)) else {
            throw SQLiteNotesError.rowDecodeFailed("invalid document kind")
        }

        guard let createdAt = Date(iso8601String: textColumn(statement, 6)) else {
            throw SQLiteNotesError.rowDecodeFailed("invalid created_at timestamp")
        }

        guard let updatedAt = Date(iso8601String: textColumn(statement, 7)) else {
            throw SQLiteNotesError.rowDecodeFailed("invalid updated_at timestamp")
        }

        return NoteDocument(
            id: id,
            kind: kind,
            date: nullableTextColumn(statement, 2),
            title: textColumn(statement, 3),
            tiptapJSON: textColumn(statement, 4),
            plainText: textColumn(statement, 5),
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }

    private var lastErrorMessage: String {
        guard let db else {
            return "unknown error"
        }

        return String(cString: sqlite3_errmsg(db))
    }
}

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private func textColumn(_ statement: OpaquePointer?, _ index: Int32) -> String {
    guard let value = sqlite3_column_text(statement, index) else {
        return ""
    }

    return String(cString: value)
}

private func nullableTextColumn(_ statement: OpaquePointer?, _ index: Int32) -> String? {
    guard sqlite3_column_type(statement, index) != SQLITE_NULL else {
        return nil
    }

    return textColumn(statement, index)
}

private func escapeJSON(_ value: String) -> String {
    value
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
}

private extension Date {
    init?(iso8601String: String) {
        guard let date = try? Date(iso8601String, strategy: .iso8601) else {
            return nil
        }

        self = date
    }
}
