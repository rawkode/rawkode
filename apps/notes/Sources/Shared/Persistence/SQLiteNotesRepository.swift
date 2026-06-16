import Foundation
import SQLite3

enum SQLiteNotesError: LocalizedError {
    case openFailed(String)
    case prepareFailed(String)
    case stepFailed(String)
    case rowDecodeFailed(String)
    case validationFailed(String)
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
        case .validationFailed(let message):
            message
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
        try withTransaction {
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

            try syncEntityReferences(for: document)
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

    func upsertEntity(
        named rawName: String,
        supertagNames rawSupertagNames: [String],
        properties rawProperties: [String: String]? = nil
    ) throws -> EntityReference {
        let canonicalName = normalizedName(rawName)
        guard !canonicalName.isEmpty else {
            throw SQLiteNotesError.validationFailed("Entity name cannot be empty.")
        }

        return try withTransaction {
            let now = Date()
            let entityID = try upsertEntityRecord(named: canonicalName, updatedAt: now)

            for supertagName in normalizedUniqueNames(rawSupertagNames) {
                let supertagID = try upsertSupertag(named: supertagName, updatedAt: now)
                try link(entityID: entityID, toSupertagID: supertagID)
            }

            if let rawProperties {
                try syncEntityProperties(entityID: entityID, properties: rawProperties, updatedAt: now)
            }

            return EntityReference(
                id: entityID,
                label: canonicalName,
                supertags: try fetchSupertagNames(forEntityID: entityID),
                properties: try fetchEntityProperties(forEntityID: entityID)
            )
        }
    }

    func runQuery(_ rawQuery: String, relativeDate: Date = .now) throws -> QueryResult {
        let query = try LocalQuery(rawQuery)
        let result: QueryResult

        switch query.source {
        case "documents", "notes":
            result = QueryResult(
                columns: ["id", "kind", "date", "title", "updated_at"],
                rows: try fetchDocuments().map(documentQueryRow)
            )

        case "daily_notes", "daily":
            result = QueryResult(
                columns: ["id", "date", "title", "updated_at"],
                rows: try fetchDocuments(kind: .daily).map(dailyNoteQueryRow)
            )

        case "entities":
            result = try fetchEntityQueryResult(supertagSlugCandidates: [])

        case "supertags", "tags":
            result = try fetchSupertagQueryResult()

        case "entity_references", "references", "backlinks":
            result = try fetchEntityReferenceQueryResult()

        case "entity_relationships", "entity_relations", "relationships", "relations":
            result = try fetchEntityRelationshipQueryResult()

        default:
            result = try fetchEntityQueryResult(supertagSlugCandidates: sourceSlugCandidates(query.source))
        }

        return try materialized(result, using: query, relativeDate: relativeDate)
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
        let hadEntityReferenceTable = try tableExists("document_entity_references")
        let hasIndexedAtColumn = hadEntityReferenceTable
            ? try table("document_entity_references", hasColumn: "indexed_at")
            : false
        let shouldRecreateEntityReferenceTable = hadEntityReferenceTable && !hasIndexedAtColumn

        if shouldRecreateEntityReferenceTable {
            try execute("DROP TABLE document_entity_references;")
        }

        let shouldBackfillEntityReferences = !hadEntityReferenceTable || shouldRecreateEntityReferenceTable

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

            CREATE TABLE IF NOT EXISTS entities (
                id TEXT PRIMARY KEY,
                canonical_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS supertags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS entity_supertags (
                entity_id TEXT NOT NULL,
                supertag_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY(entity_id, supertag_id),
                FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE,
                FOREIGN KEY(supertag_id) REFERENCES supertags(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_entity_supertags_supertag
            ON entity_supertags(supertag_id);

            CREATE TABLE IF NOT EXISTS entity_properties (
                entity_id TEXT NOT NULL,
                property_key TEXT NOT NULL,
                property_value TEXT NOT NULL,
                value_entity_id TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(entity_id, property_key),
                FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE,
                FOREIGN KEY(value_entity_id) REFERENCES entities(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_entity_properties_key
            ON entity_properties(property_key);

            CREATE TABLE IF NOT EXISTS document_entity_references (
                document_id TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                indexed_at TEXT NOT NULL,
                PRIMARY KEY(document_id, entity_id),
                FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
                FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_document_entity_references_entity
            ON document_entity_references(entity_id);
            """
        )

        if try !table("entity_properties", hasColumn: "value_entity_id") {
            try execute("ALTER TABLE entity_properties ADD COLUMN value_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL;")
        }

        if shouldBackfillEntityReferences {
            try rebuildEntityReferenceIndex()
        }
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

    private func tableExists(_ name: String) throws -> Bool {
        try prepare(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type = 'table' AND name = ?
            LIMIT 1;
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, name, -1, sqliteTransient)
            let result = sqlite3_step(statement)

            if result == SQLITE_ROW {
                return true
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return false
        }
    }

    private func table(_ tableName: String, hasColumn columnName: String) throws -> Bool {
        let escapedTableName = tableName.replacingOccurrences(of: "\"", with: "\"\"")

        return try prepare("PRAGMA table_info(\"\(escapedTableName)\");") { statement in
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                if textColumn(statement, 1) == columnName {
                    return true
                }
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return false
        }
    }

    private func withTransaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE TRANSACTION;")

        do {
            let result = try body()
            try execute("COMMIT;")
            return result
        } catch {
            try? execute("ROLLBACK;")
            throw error
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

    private func fetchEntityID(named canonicalName: String) throws -> UUID? {
        try prepare(
            """
            SELECT id
            FROM entities
            WHERE canonical_name = ?
            LIMIT 1;
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, canonicalName, -1, sqliteTransient)
            let result = sqlite3_step(statement)

            if result == SQLITE_DONE {
                return nil
            }

            guard result == SQLITE_ROW else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            guard let id = UUID(uuidString: textColumn(statement, 0)) else {
                throw SQLiteNotesError.rowDecodeFailed("invalid entity id")
            }

            return id
        }
    }

    private func insertEntity(id: UUID, canonicalName: String, createdAt: Date, updatedAt: Date) throws {
        try prepare(
            """
            INSERT INTO entities (id, canonical_name, created_at, updated_at)
            VALUES (?, ?, ?, ?);
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, id.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, canonicalName, -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, createdAt.ISO8601Format(), -1, sqliteTransient)
            sqlite3_bind_text(statement, 4, updatedAt.ISO8601Format(), -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    private func updateEntity(id: UUID, canonicalName: String, updatedAt: Date) throws {
        try prepare(
            """
            UPDATE entities
            SET canonical_name = ?, updated_at = ?
            WHERE id = ?;
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, canonicalName, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, updatedAt.ISO8601Format(), -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, id.uuidString, -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    private func upsertEntityRecord(named canonicalName: String, updatedAt: Date) throws -> UUID {
        if let existingID = try fetchEntityID(named: canonicalName) {
            try updateEntity(id: existingID, canonicalName: canonicalName, updatedAt: updatedAt)
            return existingID
        }

        let entityID = UUID()
        try insertEntity(id: entityID, canonicalName: canonicalName, createdAt: updatedAt, updatedAt: updatedAt)
        return entityID
    }

    private func upsertSupertag(named name: String, updatedAt: Date) throws -> UUID {
        let slug = slugified(name)
        if let existingID = try fetchSupertagID(slug: slug) {
            try prepare(
                """
                UPDATE supertags
                SET name = ?, updated_at = ?
                WHERE id = ?;
                """
            ) { statement in
                sqlite3_bind_text(statement, 1, name, -1, sqliteTransient)
                sqlite3_bind_text(statement, 2, updatedAt.ISO8601Format(), -1, sqliteTransient)
                sqlite3_bind_text(statement, 3, existingID.uuidString, -1, sqliteTransient)

                guard sqlite3_step(statement) == SQLITE_DONE else {
                    throw SQLiteNotesError.stepFailed(lastErrorMessage)
                }
            }
            return existingID
        }

        let id = UUID()
        try prepare(
            """
            INSERT INTO supertags (id, name, slug, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?);
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, id.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, name, -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, slug, -1, sqliteTransient)
            sqlite3_bind_text(statement, 4, updatedAt.ISO8601Format(), -1, sqliteTransient)
            sqlite3_bind_text(statement, 5, updatedAt.ISO8601Format(), -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }

        return id
    }

    private func fetchSupertagID(slug: String) throws -> UUID? {
        try prepare(
            """
            SELECT id
            FROM supertags
            WHERE slug = ?
            LIMIT 1;
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, slug, -1, sqliteTransient)
            let result = sqlite3_step(statement)

            if result == SQLITE_DONE {
                return nil
            }

            guard result == SQLITE_ROW else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            guard let id = UUID(uuidString: textColumn(statement, 0)) else {
                throw SQLiteNotesError.rowDecodeFailed("invalid supertag id")
            }

            return id
        }
    }

    private func link(entityID: UUID, toSupertagID supertagID: UUID) throws {
        try prepare(
            """
            INSERT OR IGNORE INTO entity_supertags (entity_id, supertag_id, created_at)
            VALUES (?, ?, ?);
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, entityID.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, supertagID.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, Date().ISO8601Format(), -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    private func syncEntityProperties(
        entityID: UUID,
        properties rawProperties: [String: String],
        updatedAt: Date
    ) throws {
        try prepare("DELETE FROM entity_properties WHERE entity_id = ?;") { statement in
            sqlite3_bind_text(statement, 1, entityID.uuidString, -1, sqliteTransient)
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }

        for property in normalizedProperties(rawProperties) {
            let valueEntityID: UUID?
            if let referencedEntityName = property.referencedEntityName {
                valueEntityID = try upsertEntityRecord(named: referencedEntityName, updatedAt: updatedAt)
            } else {
                valueEntityID = nil
            }

            try prepare(
                """
                INSERT INTO entity_properties (
                    entity_id, property_key, property_value, value_entity_id, updated_at
                )
                VALUES (?, ?, ?, ?, ?);
                """
            ) { statement in
                sqlite3_bind_text(statement, 1, entityID.uuidString, -1, sqliteTransient)
                sqlite3_bind_text(statement, 2, property.key, -1, sqliteTransient)
                sqlite3_bind_text(statement, 3, property.value, -1, sqliteTransient)
                if let valueEntityID {
                    sqlite3_bind_text(statement, 4, valueEntityID.uuidString, -1, sqliteTransient)
                } else {
                    sqlite3_bind_null(statement, 4)
                }
                sqlite3_bind_text(statement, 5, updatedAt.ISO8601Format(), -1, sqliteTransient)

                guard sqlite3_step(statement) == SQLITE_DONE else {
                    throw SQLiteNotesError.stepFailed(lastErrorMessage)
                }
            }
        }
    }

    private func syncEntityReferences(for document: NoteDocument) throws {
        try prepare("DELETE FROM document_entity_references WHERE document_id = ?;") { statement in
            sqlite3_bind_text(statement, 1, document.id.uuidString, -1, sqliteTransient)
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }

        try insertEntityReferences(for: document)
    }

    private func rebuildEntityReferenceIndex() throws {
        let documents = try fetchDocuments()
        guard !documents.isEmpty else {
            return
        }

        try withTransaction {
            try prepare("DELETE FROM document_entity_references;") { statement in
                guard sqlite3_step(statement) == SQLITE_DONE else {
                    throw SQLiteNotesError.stepFailed(lastErrorMessage)
                }
            }

            for document in documents {
                try insertEntityReferences(for: document)
            }
        }
    }

    private func insertEntityReferences(for document: NoteDocument) throws {
        for entityID in entityReferenceIDs(in: document.tiptapJSON) {
            try prepare(
                """
                INSERT OR IGNORE INTO document_entity_references (document_id, entity_id, indexed_at)
                SELECT ?, ?, ?
                WHERE EXISTS (
                    SELECT 1
                    FROM entities
                    WHERE id = ?
                );
                """
            ) { statement in
                sqlite3_bind_text(statement, 1, document.id.uuidString, -1, sqliteTransient)
                sqlite3_bind_text(statement, 2, entityID.uuidString, -1, sqliteTransient)
                sqlite3_bind_text(statement, 3, Date().ISO8601Format(), -1, sqliteTransient)
                sqlite3_bind_text(statement, 4, entityID.uuidString, -1, sqliteTransient)

                guard sqlite3_step(statement) == SQLITE_DONE else {
                    throw SQLiteNotesError.stepFailed(lastErrorMessage)
                }
            }
        }
    }

    private func fetchSupertagNames(forEntityID entityID: UUID) throws -> [String] {
        try prepare(
            """
            SELECT supertags.name
            FROM supertags
            INNER JOIN entity_supertags ON entity_supertags.supertag_id = supertags.id
            WHERE entity_supertags.entity_id = ?
            ORDER BY supertags.name COLLATE NOCASE ASC;
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, entityID.uuidString, -1, sqliteTransient)
            var names: [String] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                names.append(textColumn(statement, 0))
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return names
        }
    }

    private func fetchEntityProperties(forEntityID entityID: UUID) throws -> [String: String] {
        let grouped = try fetchStoredEntityProperties(entityIDs: [entityID.uuidString])
        return grouped[entityID.uuidString]?.mapValues(\.value) ?? [:]
    }

    private func fetchStoredEntityProperties(entityIDs: [String]) throws -> [String: [String: StoredEntityProperty]] {
        let requestedIDs = Set(entityIDs)
        guard !requestedIDs.isEmpty else {
            return [:]
        }

        return try prepare(
            """
            SELECT entity_id, property_key, property_value, value_entity_id
            FROM entity_properties
            ORDER BY property_key COLLATE NOCASE ASC;
            """
        ) { statement in
            var grouped: [String: [String: StoredEntityProperty]] = [:]
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                let entityID = textColumn(statement, 0)
                if requestedIDs.contains(entityID) {
                    let valueEntityID = sqlite3_column_type(statement, 3) == SQLITE_NULL
                        ? nil
                        : textColumn(statement, 3)
                    grouped[entityID, default: [:]][textColumn(statement, 1)] = StoredEntityProperty(
                        value: textColumn(statement, 2),
                        valueEntityID: valueEntityID
                    )
                }
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return grouped
        }
    }

    private func fetchEntityQueryResult(supertagSlugCandidates: [String]) throws -> QueryResult {
        let baseColumns = ["id", "name", "supertags", "updated_at"]
        let hasSupertagFilter = !supertagSlugCandidates.isEmpty
        let placeholders = supertagSlugCandidates.map { _ in "?" }.joined(separator: ", ")
        let whereClause = hasSupertagFilter
            ? """
              WHERE EXISTS (
                  SELECT 1
                  FROM entity_supertags filtered_link
                  INNER JOIN supertags filtered_tag ON filtered_tag.id = filtered_link.supertag_id
                  WHERE filtered_link.entity_id = entities.id
                    AND filtered_tag.slug IN (\(placeholders))
              )
              """
            : ""

        let rows = try prepare(
            """
            SELECT
                entities.id,
                entities.canonical_name,
                COALESCE((
                    SELECT GROUP_CONCAT(ordered_tags.name, ', ')
                    FROM (
                        SELECT supertags.name
                        FROM entity_supertags
                        INNER JOIN supertags ON supertags.id = entity_supertags.supertag_id
                        WHERE entity_supertags.entity_id = entities.id
                        ORDER BY supertags.name COLLATE NOCASE ASC
                    ) ordered_tags
                ), '') AS supertags,
                entities.updated_at
            FROM entities
            \(whereClause)
            ORDER BY entities.canonical_name COLLATE NOCASE ASC;
            """
        ) { statement in
            for (index, slug) in supertagSlugCandidates.enumerated() {
                sqlite3_bind_text(statement, Int32(index + 1), slug, -1, sqliteTransient)
            }

            var rows: [[String: String]] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                rows.append([
                    "id": textColumn(statement, 0),
                    "name": textColumn(statement, 1),
                    "supertags": textColumn(statement, 2),
                    "updated_at": textColumn(statement, 3),
                ])
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return rows
        }

        let propertiesByEntityID = try fetchStoredEntityProperties(entityIDs: rows.compactMap { $0["id"] })
        var seenPropertyColumns: Set<String> = []
        let propertyColumns = propertiesByEntityID.values
            .flatMap { $0.keys }
            .filter { !baseColumns.contains($0) }
            .filter { seenPropertyColumns.insert($0).inserted }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        let relationshipColumns = relationshipQueryColumns(
            baseColumns: baseColumns,
            propertyColumns: propertyColumns,
            propertiesByEntityID: propertiesByEntityID
        )
        let rowsWithProperties = rows.map { row in
            var result = row
            let properties = row["id"].flatMap { propertiesByEntityID[$0] } ?? [:]
            for column in propertyColumns {
                result[column] = properties[column]?.value ?? ""
            }
            for (propertyKey, column) in relationshipColumns {
                result[column] = properties[propertyKey]?.valueEntityID ?? ""
            }
            return result
        }

        return QueryResult(
            columns: baseColumns + propertyColumns + relationshipColumns.map { $0.column },
            rows: rowsWithProperties
        )
    }

    private func fetchSupertagQueryResult() throws -> QueryResult {
        let rows = try prepare(
            """
            SELECT
                supertags.name,
                supertags.slug,
                CAST(COUNT(entity_supertags.entity_id) AS TEXT) AS entities
            FROM supertags
            LEFT JOIN entity_supertags ON entity_supertags.supertag_id = supertags.id
            GROUP BY supertags.id
            ORDER BY supertags.name COLLATE NOCASE ASC;
            """
        ) { statement in
            var rows: [[String: String]] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                rows.append([
                    "name": textColumn(statement, 0),
                    "slug": textColumn(statement, 1),
                    "entities": textColumn(statement, 2),
                ])
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return rows
        }

        return QueryResult(columns: ["name", "slug", "entities"], rows: rows)
    }

    private func fetchEntityReferenceQueryResult() throws -> QueryResult {
        let rows = try prepare(
            """
            SELECT
                entities.id,
                entities.canonical_name,
                documents.id,
                documents.title,
                documents.kind,
                COALESCE(documents.date, '')
            FROM document_entity_references
            INNER JOIN entities ON entities.id = document_entity_references.entity_id
            INNER JOIN documents ON documents.id = document_entity_references.document_id
            ORDER BY entities.canonical_name COLLATE NOCASE ASC, documents.updated_at DESC;
            """
        ) { statement in
            var rows: [[String: String]] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                let entityName = textColumn(statement, 1)
                let documentTitle = textColumn(statement, 3)
                rows.append([
                    "entity_id": textColumn(statement, 0),
                    "entity": entityName,
                    "document_id": textColumn(statement, 2),
                    "document": documentTitle,
                    "document_kind": textColumn(statement, 4),
                    "date": textColumn(statement, 5),
                    "name": "\(entityName) -> \(documentTitle)",
                ])
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return rows
        }

        return QueryResult(
            columns: ["name", "entity", "document", "document_kind", "date", "entity_id", "document_id"],
            rows: rows
        )
    }

    private func fetchEntityRelationshipQueryResult() throws -> QueryResult {
        let rows = try prepare(
            """
            SELECT
                source_entities.canonical_name,
                entity_properties.property_key,
                target_entities.canonical_name,
                source_entities.id,
                target_entities.id,
                entity_properties.updated_at
            FROM entity_properties
            INNER JOIN entities source_entities
                ON source_entities.id = entity_properties.entity_id
            INNER JOIN entities target_entities
                ON target_entities.id = entity_properties.value_entity_id
            ORDER BY target_entities.canonical_name COLLATE NOCASE ASC,
                entity_properties.property_key COLLATE NOCASE ASC,
                source_entities.canonical_name COLLATE NOCASE ASC;
            """
        ) { statement in
            var rows: [[String: String]] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                let source = textColumn(statement, 0)
                let property = textColumn(statement, 1)
                let target = textColumn(statement, 2)
                rows.append([
                    "name": "\(source) \(property) -> \(target)",
                    "source": source,
                    "property": property,
                    "target": target,
                    "source_id": textColumn(statement, 3),
                    "target_id": textColumn(statement, 4),
                    "updated_at": textColumn(statement, 5),
                ])
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return rows
        }

        return QueryResult(
            columns: ["name", "source", "property", "target", "source_id", "target_id", "updated_at"],
            rows: rows
        )
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

private func normalizedName(_ value: String) -> String {
    value
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .split(whereSeparator: { $0.isWhitespace })
        .joined(separator: " ")
}

private func normalizedUniqueNames(_ values: [String]) -> [String] {
    var seen: Set<String> = []
    var result: [String] = []

    for value in values {
        var candidate = value.trimmingCharacters(in: .whitespacesAndNewlines)
        while candidate.first == "#" {
            candidate.removeFirst()
        }

        let normalized = normalizedName(candidate)
        let key = normalized.lowercased()
        guard !normalized.isEmpty, !seen.contains(key) else {
            continue
        }

        seen.insert(key)
        result.append(normalized)
    }

    return result
}

private struct NormalizedEntityProperty {
    var key: String
    var value: String
    var referencedEntityName: String?
}

private struct StoredEntityProperty {
    var value: String
    var valueEntityID: String?
}

private func normalizedProperties(_ properties: [String: String]) -> [NormalizedEntityProperty] {
    let reservedColumns: Set<String> = ["id", "name", "supertags", "updated_at"]
    var normalized: [String: NormalizedEntityProperty] = [:]

    for (rawKey, rawValue) in properties {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            continue
        }

        var key = normalizedPropertyKey(rawKey)
        guard !key.isEmpty else {
            continue
        }

        if reservedColumns.contains(key) {
            key = "property_\(key)"
        }

        let referencedEntityName = entityReferencePropertyValue(value)
        normalized[key] = NormalizedEntityProperty(
            key: key,
            value: referencedEntityName ?? value,
            referencedEntityName: referencedEntityName
        )
    }

    return normalized
        .map { $0.value }
        .sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
}

private func entityReferencePropertyValue(_ value: String) -> String? {
    let pattern = #"^\[\[([^\[\]\r\n]+)\]\]$"#
    guard let match = value.firstMatch(pattern: pattern),
          let rawName = match[1] else {
        return nil
    }

    let normalized = normalizedName(rawName)
    return normalized.isEmpty ? nil : normalized
}

private func normalizedPropertyKey(_ value: String) -> String {
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

    return result
}

private func slugified(_ value: String) -> String {
    let lowercased = normalizedName(value).lowercased()
    var slug = ""
    var previousWasSeparator = false

    for scalar in lowercased.unicodeScalars {
        if CharacterSet.alphanumerics.contains(scalar) {
            slug.unicodeScalars.append(scalar)
            previousWasSeparator = false
        } else if !previousWasSeparator {
            slug.append("-")
            previousWasSeparator = true
        }
    }

    let trimmed = slug.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    if !trimmed.isEmpty {
        return trimmed
    }

    return lowercased.isEmpty ? "tag" : lowercased
}

private func sourceSlugCandidates(_ source: String) -> [String] {
    let slug = slugified(source)
    var candidates = [slug]

    if slug.hasSuffix("s"), slug.count > 1 {
        candidates.append(String(slug.dropLast()))
    }

    var seen: Set<String> = []
    return candidates.filter { seen.insert($0).inserted }
}

private func relationshipQueryColumns(
    baseColumns: [String],
    propertyColumns: [String],
    propertiesByEntityID: [String: [String: StoredEntityProperty]]
) -> [(propertyKey: String, column: String)] {
    var relationshipKeys: Set<String> = []
    for properties in propertiesByEntityID.values {
        for (key, property) in properties where property.valueEntityID != nil {
            relationshipKeys.insert(key)
        }
    }

    var usedColumns = Set(baseColumns + propertyColumns)
    return relationshipKeys
        .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        .map { key in
            let baseColumn = "\(key)_entity_id"
            var column = usedColumns.contains(baseColumn) ? "property_\(baseColumn)" : baseColumn
            var suffix = 2
            while usedColumns.contains(column) {
                column = "property_\(baseColumn)_\(suffix)"
                suffix += 1
            }
            usedColumns.insert(column)
            return (propertyKey: key, column: column)
        }
}

private func documentQueryRow(_ document: NoteDocument) -> [String: String] {
    [
        "id": document.id.uuidString,
        "kind": document.kind.rawValue,
        "date": document.date ?? "",
        "title": document.title,
        "updated_at": document.updatedAt.ISO8601Format(),
    ]
}

private func dailyNoteQueryRow(_ document: NoteDocument) -> [String: String] {
    [
        "id": document.id.uuidString,
        "date": document.date ?? "",
        "title": document.title,
        "updated_at": document.updatedAt.ISO8601Format(),
    ]
}

private func entityReferenceIDs(in tiptapJSON: String) -> [UUID] {
    guard let data = tiptapJSON.data(using: .utf8),
          let value = try? JSONSerialization.jsonObject(with: data) else {
        return []
    }

    var ids: [UUID] = []
    var seen: Set<UUID> = []
    collectEntityReferenceIDs(from: value, into: &ids, seen: &seen)
    return ids
}

private func collectEntityReferenceIDs(from value: Any, into ids: inout [UUID], seen: inout Set<UUID>) {
    if let array = value as? [Any] {
        for item in array {
            collectEntityReferenceIDs(from: item, into: &ids, seen: &seen)
        }
        return
    }

    guard let object = value as? [String: Any] else {
        return
    }

    if object["type"] as? String == "entityReference",
       let attrs = object["attrs"] as? [String: Any],
       let entityIDString = attrs["entityId"] as? String,
       let entityID = UUID(uuidString: entityIDString),
       seen.insert(entityID).inserted {
        ids.append(entityID)
    }

    for child in object.values {
        collectEntityReferenceIDs(from: child, into: &ids, seen: &seen)
    }
}

private func materialized(_ result: QueryResult, using query: LocalQuery, relativeDate: Date) throws -> QueryResult {
    var rows = result.rows

    for predicate in query.predicates {
        try requireQueryField(predicate.field, in: result)
    }

    if !query.predicates.isEmpty {
        rows = rows.filter { row in
            query.predicates.allSatisfy { predicate in
                let comparisonValues = queryComparisonValues(for: predicate, relativeDate: relativeDate)
                let value = row[predicate.field] ?? ""
                switch predicate.operation {
                case .equals:
                    return value.localizedCaseInsensitiveCompare(comparisonValues[0]) == .orderedSame
                case .contains:
                    return value.localizedCaseInsensitiveContains(comparisonValues[0])
                case .oneOf:
                    return comparisonValues.contains {
                        value.localizedCaseInsensitiveCompare($0) == .orderedSame
                    }
                case .greaterThan:
                    return value.localizedStandardCompare(comparisonValues[0]) == .orderedDescending
                case .greaterThanOrEqual:
                    let comparison = value.localizedStandardCompare(comparisonValues[0])
                    return comparison == .orderedDescending || comparison == .orderedSame
                case .lessThan:
                    return value.localizedStandardCompare(comparisonValues[0]) == .orderedAscending
                case .lessThanOrEqual:
                    let comparison = value.localizedStandardCompare(comparisonValues[0])
                    return comparison == .orderedAscending || comparison == .orderedSame
                }
            }
        }
    }

    if let order = query.order {
        try requireQueryField(order.field, in: result)
        rows = rows
            .enumerated()
            .sorted { left, right in
                let comparison = (left.element[order.field] ?? "")
                    .localizedStandardCompare(right.element[order.field] ?? "")

                if comparison == .orderedSame {
                    return left.offset < right.offset
                }

                switch order.direction {
                case .ascending:
                    return comparison == .orderedAscending
                case .descending:
                    return comparison == .orderedDescending
                }
            }
            .map { $0.element }
    }

    if let limit = query.limit {
        rows = Array(rows.prefix(limit))
    }

    guard let projection = query.projection else {
        return QueryResult(columns: result.columns, rows: rows)
    }

    for item in projection {
        try requireQueryField(item.field, in: result)
    }

    let projectedRows = rows.map { row in
        Dictionary(uniqueKeysWithValues: projection.map { item in
            (item.outputName, row[item.field] ?? "")
        })
    }

    return QueryResult(columns: projection.map { $0.outputName }, rows: projectedRows)
}

private func queryComparisonValues(for predicate: LocalQueryPredicate, relativeDate: Date) -> [String] {
    predicate.values.map { value in
        guard predicate.field == "date",
              let relativeDateValue = DailyNoteDateFormatter.relativeStorageString(
                  for: value,
                  relativeTo: relativeDate
              ) else {
            return value
        }

        return relativeDateValue
    }
}

private func requireQueryField(_ field: String, in result: QueryResult) throws {
    guard result.columns.contains(field) else {
        throw SQLiteNotesError.validationFailed("Unknown query field '\(field)'.")
    }
}

private struct LocalQueryOrder {
    enum Direction {
        case ascending
        case descending
    }

    var field: String
    var direction: Direction
}

private struct LocalQueryProjection {
    var field: String
    var outputName: String
}

private struct LocalQuery {
    var projection: [LocalQueryProjection]?
    var source: String
    var predicates: [LocalQueryPredicate] = []
    var order: LocalQueryOrder?
    var limit: Int?

    init(_ rawQuery: String) throws {
        let trimmed = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw SQLiteNotesError.validationFailed("Query cannot be empty.")
        }

        let pattern = #"(?is)^\s*SELECT\s+(.+?)\s+FROM\s+([A-Za-z_][A-Za-z0-9_-]*)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+([0-9]+))?\s*;?\s*$"#
        guard let match = trimmed.firstMatch(pattern: pattern) else {
            throw SQLiteNotesError.validationFailed("Only SELECT * or SELECT <field[, ...]> FROM <source> queries are supported.")
        }

        guard let rawProjection = match[1], let sourceName = match[2] else {
            throw SQLiteNotesError.validationFailed("Query source is missing.")
        }

        projection = try Self.parseProjection(rawProjection)
        source = sourceName.lowercased()
        if match.indices.contains(3), let whereClause = match[3], !whereClause.isEmpty {
            predicates = try Self.parsePredicates(whereClause)
        }

        if match.indices.contains(4), let orderField = match[4], !orderField.isEmpty {
            let direction: LocalQueryOrder.Direction = (match[5] ?? "")
                .caseInsensitiveCompare("DESC") == .orderedSame ? .descending : .ascending
            order = LocalQueryOrder(field: orderField.lowercased(), direction: direction)
        }

        if match.indices.contains(6), let rawLimit = match[6], !rawLimit.isEmpty {
            guard let parsedLimit = Int(rawLimit), parsedLimit >= 0 else {
                throw SQLiteNotesError.validationFailed("Query limit must be a non-negative integer.")
            }
            limit = parsedLimit
        }
    }

    private static func parseProjection(_ rawProjection: String) throws -> [LocalQueryProjection]? {
        let trimmed = rawProjection.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw SQLiteNotesError.validationFailed("Query projection is missing.")
        }

        if trimmed == "*" {
            return nil
        }

        let rawFields = trimmed
            .split(separator: ",", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }

        var projection: [LocalQueryProjection] = []
        var seenOutputNames: Set<String> = []
        for rawField in rawFields {
            let item = try parseProjectionItem(rawField)
            guard seenOutputNames.insert(item.outputName).inserted else {
                throw SQLiteNotesError.validationFailed(
                    "Query projection contains duplicate output field '\(item.outputName)'."
                )
            }
            projection.append(item)
        }

        return projection
    }

    private static func parseProjectionItem(_ rawField: String) throws -> LocalQueryProjection {
        let pattern = #"(?is)^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+AS\s+([A-Za-z_][A-Za-z0-9_]*))?\s*$"#
        guard let match = rawField.firstMatch(pattern: pattern),
              let field = match[1] else {
            throw SQLiteNotesError.validationFailed(
                "Only comma-separated query field names with optional AS aliases are supported."
            )
        }

        return LocalQueryProjection(
            field: field.lowercased(),
            outputName: (match[2] ?? field).lowercased()
        )
    }

    private static func parsePredicates(_ rawWhereClause: String) throws -> [LocalQueryPredicate] {
        let clauses = try splitConjunctions(in: rawWhereClause)
        guard !clauses.isEmpty else {
            throw SQLiteNotesError.validationFailed("Query filter is missing.")
        }

        return try clauses.map { try LocalQueryPredicate($0) }
    }

    private static func splitConjunctions(in whereClause: String) throws -> [String] {
        var clauses: [String] = []
        var current = ""
        var quotedBy: Character?
        var parenthesisDepth = 0
        var index = whereClause.startIndex

        while index < whereClause.endIndex {
            let character = whereClause[index]

            if character == "'" || character == "\"" {
                if quotedBy == nil {
                    quotedBy = character
                } else if quotedBy == character {
                    quotedBy = nil
                }
                current.append(character)
                index = whereClause.index(after: index)
                continue
            }

            if quotedBy == nil {
                if character == "(" {
                    parenthesisDepth += 1
                    current.append(character)
                    index = whereClause.index(after: index)
                    continue
                }

                if character == ")" {
                    parenthesisDepth -= 1
                    guard parenthesisDepth >= 0 else {
                        throw SQLiteNotesError.validationFailed("Query filter contains unbalanced parentheses.")
                    }
                    current.append(character)
                    index = whereClause.index(after: index)
                    continue
                }
            }

            if quotedBy == nil, parenthesisDepth == 0, isStandaloneKeyword("AND", in: whereClause, at: index) {
                let clause = current.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !clause.isEmpty else {
                    throw SQLiteNotesError.validationFailed("Query filter is incomplete.")
                }
                clauses.append(clause)
                current = ""
                index = whereClause.index(index, offsetBy: 3)
                continue
            }

            current.append(character)
            index = whereClause.index(after: index)
        }

        guard quotedBy == nil else {
            throw SQLiteNotesError.validationFailed("Query filter contains an unterminated quoted value.")
        }

        guard parenthesisDepth == 0 else {
            throw SQLiteNotesError.validationFailed("Query filter contains unbalanced parentheses.")
        }

        let finalClause = current.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !finalClause.isEmpty else {
            throw SQLiteNotesError.validationFailed("Query filter is incomplete.")
        }

        clauses.append(finalClause)
        return clauses
    }

    private static func isStandaloneKeyword(_ keyword: String, in text: String, at index: String.Index) -> Bool {
        guard let endIndex = text.index(index, offsetBy: keyword.count, limitedBy: text.endIndex),
              String(text[index..<endIndex]).caseInsensitiveCompare(keyword) == .orderedSame else {
            return false
        }

        if index > text.startIndex {
            let previous = text[text.index(before: index)]
            guard !isQueryWordCharacter(previous) else {
                return false
            }
        }

        if endIndex < text.endIndex {
            let next = text[endIndex]
            guard !isQueryWordCharacter(next) else {
                return false
            }
        }

        return true
    }

    private static func isQueryWordCharacter(_ character: Character) -> Bool {
        "_-.:".contains(character) || character.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0)
        }
    }
}

private struct LocalQueryPredicate {
    enum Operation {
        case equals
        case contains
        case oneOf
        case greaterThan
        case greaterThanOrEqual
        case lessThan
        case lessThanOrEqual
    }

    var field: String
    var operation: Operation
    var values: [String]

    init(_ whereClause: String) throws {
        let inPattern = #"(?is)^\s*([A-Za-z_][A-Za-z0-9_]*)\s+IN\s*\((.*)\)\s*$"#
        if let match = whereClause.firstMatch(pattern: inPattern), let fieldName = match[1] {
            field = fieldName.lowercased()
            operation = .oneOf
            values = try Self.parseValueList(match[2] ?? "")
            return
        }

        let pattern = #"(?is)^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|=|>|<|CONTAINS)\s*(.+)\s*$"#
        guard let match = whereClause.firstMatch(pattern: pattern),
              let fieldName = match[1],
              let operationName = match[2],
              let rawValue = match[3] else {
            throw SQLiteNotesError.validationFailed(
                "Only WHERE <field> = value, WHERE <field> CONTAINS value, WHERE <field> IN (value, ...), and ordered comparisons are supported."
            )
        }

        field = fieldName.lowercased()
        operation = try Self.parseOperation(operationName)
        values = [try Self.parseValue(rawValue)]
    }

    private static func parseOperation(_ rawOperation: String) throws -> Operation {
        switch rawOperation.uppercased() {
        case "=":
            return .equals
        case "CONTAINS":
            return .contains
        case ">":
            return .greaterThan
        case ">=":
            return .greaterThanOrEqual
        case "<":
            return .lessThan
        case "<=":
            return .lessThanOrEqual
        default:
            throw SQLiteNotesError.validationFailed("Query filter operation is unsupported.")
        }
    }

    private static func parseValue(_ rawValue: String) throws -> String {
        let pattern = #"(?is)^\s*('([^']*)'|"([^"]*)"|([A-Za-z0-9_.:-]+))\s*$"#
        guard let match = rawValue.firstMatch(pattern: pattern) else {
            throw SQLiteNotesError.validationFailed("Query filter value is invalid.")
        }

        let value = (match[2] ?? match[3] ?? match[4] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            throw SQLiteNotesError.validationFailed("Query filter value cannot be empty.")
        }

        return value
    }

    private static func parseValueList(_ rawList: String) throws -> [String] {
        let rawValues = try splitValues(in: rawList)
        guard !rawValues.isEmpty else {
            throw SQLiteNotesError.validationFailed("Query filter IN list cannot be empty.")
        }

        return try rawValues.map { try parseValue($0) }
    }

    private static func splitValues(in rawList: String) throws -> [String] {
        var values: [String] = []
        var current = ""
        var quotedBy: Character?

        for character in rawList {
            if character == "'" || character == "\"" {
                if quotedBy == nil {
                    quotedBy = character
                } else if quotedBy == character {
                    quotedBy = nil
                }
                current.append(character)
                continue
            }

            if quotedBy == nil, character == "," {
                let value = current.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !value.isEmpty else {
                    throw SQLiteNotesError.validationFailed("Query filter IN list contains an empty value.")
                }
                values.append(value)
                current = ""
                continue
            }

            current.append(character)
        }

        guard quotedBy == nil else {
            throw SQLiteNotesError.validationFailed("Query filter contains an unterminated quoted value.")
        }

        let finalValue = current.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !finalValue.isEmpty else {
            throw SQLiteNotesError.validationFailed("Query filter IN list contains an empty value.")
        }

        values.append(finalValue)
        return values
    }
}

private extension String {
    func firstMatch(pattern: String) -> [String?]? {
        guard let expression = try? NSRegularExpression(pattern: pattern) else {
            return nil
        }

        let range = NSRange(startIndex..<endIndex, in: self)
        guard let match = expression.firstMatch(in: self, range: range) else {
            return nil
        }

        return (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            guard range.location != NSNotFound, let swiftRange = Range(range, in: self) else {
                return nil
            }

            return String(self[swiftRange])
        }
    }
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
