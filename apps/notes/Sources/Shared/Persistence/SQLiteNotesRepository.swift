import Foundation
import SQLite3

let queryDocumentIDMetadataKey = "__notes.document_id"

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

    func fetchSavedQueryViews() throws -> [SavedQueryView] {
        try prepare(
            """
            SELECT id, name, query, view, group_by, created_at, updated_at
            FROM saved_query_views
            ORDER BY name COLLATE NOCASE ASC;
            """
        ) { statement in
            var views: [SavedQueryView] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                views.append(try savedQueryView(from: statement))
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return views
        }
    }

    func fetchSavedQueryView(id: UUID) throws -> SavedQueryView? {
        try prepare(
            """
            SELECT id, name, query, view, group_by, created_at, updated_at
            FROM saved_query_views
            WHERE id = ?
            LIMIT 1;
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, id.uuidString, -1, sqliteTransient)
            let result = sqlite3_step(statement)

            if result == SQLITE_DONE {
                return nil
            }

            guard result == SQLITE_ROW else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return try savedQueryView(from: statement)
        }
    }

    @discardableResult
    func saveSavedQueryView(
        named rawName: String,
        query rawQuery: String,
        view rawView: String = "table",
        groupBy rawGroupBy: String? = nil
    ) throws -> SavedQueryView {
        let name = normalizedName(rawName)
        guard !name.isEmpty else {
            throw SQLiteNotesError.validationFailed("Saved view name cannot be empty.")
        }

        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = try LocalQuery(query)

        let view = try normalizedSavedQueryViewMode(rawView)
        let groupBy = view == "board" ? normalizedOptionalField(rawGroupBy) : nil
        let now = Date()
        let existing = try fetchSavedQueryView(name: name)
        let savedView = SavedQueryView(
            id: existing?.id ?? UUID(),
            name: name,
            query: query,
            view: view,
            groupBy: groupBy,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now
        )

        try upsert(savedView)
        return savedView
    }

    func deleteSavedQueryView(id: UUID) throws {
        try prepare("DELETE FROM saved_query_views WHERE id = ?;") { statement in
            sqlite3_bind_text(statement, 1, id.uuidString, -1, sqliteTransient)
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    func fetchSupertagFieldDefinitions(supertagName rawSupertagName: String? = nil) throws -> [SupertagFieldDefinition] {
        if let rawSupertagName {
            guard let supertagName = normalizedSupertagName(rawSupertagName) else {
                return []
            }

            return try querySupertagFieldDefinitions(
                whereClause: "WHERE supertags.slug = ?",
                bind: { statement in
                    sqlite3_bind_text(statement, 1, slugified(supertagName), -1, sqliteTransient)
                }
            )
        }

        return try querySupertagFieldDefinitions()
    }

    @discardableResult
    func saveSupertagFieldDefinition(
        supertagName rawSupertagName: String,
        field rawLabel: String,
        valueType rawValueType: String = "text",
        defaultValue rawDefaultValue: String? = nil,
        isRequired: Bool = false,
        sortOrder: Int = 0
    ) throws -> SupertagFieldDefinition {
        guard let supertagName = normalizedSupertagName(rawSupertagName) else {
            throw SQLiteNotesError.validationFailed("Supertag name cannot be empty.")
        }

        let label = normalizedName(rawLabel)
        guard !label.isEmpty else {
            throw SQLiteNotesError.validationFailed("Supertag field label cannot be empty.")
        }

        let key = normalizedEntityPropertyKey(label)
        guard !key.isEmpty else {
            throw SQLiteNotesError.validationFailed("Supertag field key cannot be empty.")
        }

        let valueType = try normalizedSupertagFieldValueType(rawValueType)
        guard sortOrder >= 0 else {
            throw SQLiteNotesError.validationFailed("Supertag field sort order cannot be negative.")
        }

        let defaultValue = normalizedDefaultValue(rawDefaultValue)
        if let defaultValue {
            try validateSupertagFieldDefaultValue(
                defaultValue,
                valueType: valueType,
                supertagName: supertagName,
                label: label
            )
        }

        return try withTransaction {
            let now = Date()
            let supertagID = try upsertSupertag(named: supertagName, updatedAt: now)
            let existing = try fetchSupertagFieldDefinition(supertagID: supertagID, key: key)
            let definition = SupertagFieldDefinition(
                id: existing?.id ?? UUID(),
                supertagID: supertagID,
                supertagName: supertagName,
                supertagSlug: slugified(supertagName),
                key: key,
                label: label,
                valueType: valueType,
                defaultValue: defaultValue,
                isRequired: isRequired,
                sortOrder: sortOrder,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now
            )

            try upsert(definition)
            return definition
        }
    }

    func deleteSupertagFieldDefinition(id: UUID) throws {
        try prepare("DELETE FROM supertag_field_definitions WHERE id = ?;") { statement in
            sqlite3_bind_text(statement, 1, id.uuidString, -1, sqliteTransient)
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    func exportVault(exportedAt: Date = .now) throws -> NotesVaultSnapshot {
        NotesVaultSnapshot(
            exportedAt: exportedAt,
            documents: try fetchVaultDocuments(),
            entities: try fetchVaultEntities(),
            supertags: try fetchVaultSupertags(),
            entitySupertags: try fetchVaultEntitySupertags(),
            entityProperties: try fetchVaultEntityProperties(),
            supertagFieldDefinitions: try fetchVaultSupertagFields(),
            savedQueryViews: try fetchVaultSavedViews()
        )
    }

    func exportVaultJSON(exportedAt: Date = .now) throws -> Data {
        try Self.vaultJSONEncoder().encode(exportVault(exportedAt: exportedAt))
    }

    func importVault(_ snapshot: NotesVaultSnapshot) throws {
        guard snapshot.version == NotesVaultSnapshot.currentVersion else {
            throw SQLiteNotesError.validationFailed("Unsupported notes vault snapshot version \(snapshot.version).")
        }

        try withTransaction {
            try clearVaultTables()

            for document in snapshot.documents {
                try insertImportedDocument(document)
            }
            for entity in snapshot.entities {
                try insertImportedEntity(entity)
            }
            for supertag in snapshot.supertags {
                try insertImportedSupertag(supertag)
            }
            for link in snapshot.entitySupertags {
                try insertImportedEntitySupertag(link)
            }
            for definition in snapshot.supertagFieldDefinitions {
                try insertImportedSupertagField(definition)
            }
            for property in snapshot.entityProperties {
                try insertImportedEntityProperty(property)
            }
            for savedView in snapshot.savedQueryViews {
                try insertImportedSavedView(savedView)
            }

            try rebuildImportedDocumentEntityReferenceIndex()
        }
    }

    func importVaultJSON(_ data: Data) throws {
        let snapshot = try Self.vaultJSONDecoder().decode(NotesVaultSnapshot.self, from: data)
        try importVault(snapshot)
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

            let schemaProperties = try schemaConformingEntityProperties(
                entityID: entityID,
                entityName: canonicalName,
                rawProperties: rawProperties ?? [:],
                mode: rawProperties == nil ? .patch : .replace,
                updatedAt: now
            )

            if rawProperties == nil {
                try upsertEntityProperties(entityID: entityID, properties: schemaProperties, updatedAt: now)
            } else {
                try syncEntityProperties(entityID: entityID, properties: schemaProperties, updatedAt: now)
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

        case "saved_views", "saved_query_views":
            result = try fetchSavedQueryViewQueryResult()

        case "supertag_fields", "tag_fields", "supertag_schema", "tag_schema":
            result = try fetchSupertagFieldDefinitionQueryResult()

        default:
            result = try fetchEntityQueryResult(supertagSlugCandidates: sourceSlugCandidates(query.source))
        }

        return try materialized(result, using: query, relativeDate: relativeDate)
    }

    func fetchDocumentBacklinks(documentID: UUID) throws -> [DocumentBacklink] {
        try fetchDocumentBacklinks(
            whereClause: "WHERE documents.id = ?",
            bind: { statement in
                sqlite3_bind_text(statement, 1, documentID.uuidString, -1, sqliteTransient)
            }
        )
    }

    func fetchEntityRelationships(sourceEntityIDs: [UUID]) throws -> [EntityRelationship] {
        try fetchEntityRelationships(entityIDs: sourceEntityIDs, column: "source_entities.id")
    }

    func fetchEntityRelationships(targetEntityIDs: [UUID]) throws -> [EntityRelationship] {
        try fetchEntityRelationships(entityIDs: targetEntityIDs, column: "target_entities.id")
    }

    func fetchDocumentContext(documentID: UUID) throws -> DocumentContext {
        let backlinks = try fetchDocumentBacklinks(documentID: documentID)
        let entityIDs = backlinks.map(\.entityID)
        return DocumentContext(
            backlinks: backlinks,
            outgoingRelationships: try fetchEntityRelationships(sourceEntityIDs: entityIDs),
            incomingRelationships: try fetchEntityRelationships(targetEntityIDs: entityIDs)
        )
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

            CREATE TABLE IF NOT EXISTS supertag_field_definitions (
                id TEXT PRIMARY KEY,
                supertag_id TEXT NOT NULL,
                field_key TEXT NOT NULL,
                label TEXT NOT NULL,
                value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'date', 'entity', 'boolean')),
                default_value TEXT,
                is_required INTEGER NOT NULL CHECK (is_required IN (0, 1)),
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(supertag_id, field_key),
                FOREIGN KEY(supertag_id) REFERENCES supertags(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_supertag_field_definitions_supertag
            ON supertag_field_definitions(supertag_id, sort_order, label);

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

            CREATE TABLE IF NOT EXISTS saved_query_views (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                query TEXT NOT NULL,
                view TEXT NOT NULL CHECK (view IN ('table', 'list', 'board')),
                group_by TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
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

    private static func vaultJSONEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(date.ISO8601Format())
        }
        return encoder
    }

    private static func vaultJSONDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = Date(iso8601String: value) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Invalid ISO8601 date: \(value)"
                )
            }
            return date
        }
        return decoder
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

    private func fetchVaultDocuments() throws -> [NotesVaultSnapshot.Document] {
        try prepare(
            """
            SELECT id, kind, date, title, tiptap_json, plain_text, created_at, updated_at
            FROM documents
            ORDER BY kind ASC, COALESCE(date, title) ASC, id ASC;
            """
        ) { statement in
            var documents: [NotesVaultSnapshot.Document] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                guard let id = UUID(uuidString: textColumn(statement, 0)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported document id")
                }
                guard let kind = NoteDocumentKind(rawValue: textColumn(statement, 1)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported document kind")
                }
                guard let createdAt = Date(iso8601String: textColumn(statement, 6)),
                      let updatedAt = Date(iso8601String: textColumn(statement, 7)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported document timestamp")
                }

                documents.append(
                    NotesVaultSnapshot.Document(
                        id: id,
                        kind: kind,
                        date: nullableTextColumn(statement, 2),
                        title: textColumn(statement, 3),
                        tiptapJSON: textColumn(statement, 4),
                        plainText: textColumn(statement, 5),
                        createdAt: createdAt,
                        updatedAt: updatedAt
                    )
                )
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return documents
        }
    }

    private func fetchVaultEntities() throws -> [NotesVaultSnapshot.Entity] {
        try prepare(
            """
            SELECT id, canonical_name, created_at, updated_at
            FROM entities
            ORDER BY canonical_name COLLATE NOCASE ASC, id ASC;
            """
        ) { statement in
            var entities: [NotesVaultSnapshot.Entity] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                guard let id = UUID(uuidString: textColumn(statement, 0)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported entity id")
                }
                guard let createdAt = Date(iso8601String: textColumn(statement, 2)),
                      let updatedAt = Date(iso8601String: textColumn(statement, 3)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported entity timestamp")
                }

                entities.append(
                    NotesVaultSnapshot.Entity(
                        id: id,
                        name: textColumn(statement, 1),
                        createdAt: createdAt,
                        updatedAt: updatedAt
                    )
                )
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return entities
        }
    }

    private func fetchVaultSupertags() throws -> [NotesVaultSnapshot.Supertag] {
        try prepare(
            """
            SELECT id, name, slug, created_at, updated_at
            FROM supertags
            ORDER BY name COLLATE NOCASE ASC, id ASC;
            """
        ) { statement in
            var supertags: [NotesVaultSnapshot.Supertag] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                guard let id = UUID(uuidString: textColumn(statement, 0)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported supertag id")
                }
                guard let createdAt = Date(iso8601String: textColumn(statement, 3)),
                      let updatedAt = Date(iso8601String: textColumn(statement, 4)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported supertag timestamp")
                }

                supertags.append(
                    NotesVaultSnapshot.Supertag(
                        id: id,
                        name: textColumn(statement, 1),
                        slug: textColumn(statement, 2),
                        createdAt: createdAt,
                        updatedAt: updatedAt
                    )
                )
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return supertags
        }
    }

    private func fetchVaultEntitySupertags() throws -> [NotesVaultSnapshot.EntitySupertag] {
        try prepare(
            """
            SELECT entity_id, supertag_id, created_at
            FROM entity_supertags
            ORDER BY entity_id ASC, supertag_id ASC;
            """
        ) { statement in
            var links: [NotesVaultSnapshot.EntitySupertag] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                guard let entityID = UUID(uuidString: textColumn(statement, 0)),
                      let supertagID = UUID(uuidString: textColumn(statement, 1)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported entity supertag id")
                }
                guard let createdAt = Date(iso8601String: textColumn(statement, 2)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported entity supertag timestamp")
                }

                links.append(
                    NotesVaultSnapshot.EntitySupertag(
                        entityID: entityID,
                        supertagID: supertagID,
                        createdAt: createdAt
                    )
                )
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return links
        }
    }

    private func fetchVaultEntityProperties() throws -> [NotesVaultSnapshot.EntityProperty] {
        try prepare(
            """
            SELECT entity_id, property_key, property_value, value_entity_id, updated_at
            FROM entity_properties
            ORDER BY entity_id ASC, property_key COLLATE NOCASE ASC;
            """
        ) { statement in
            var properties: [NotesVaultSnapshot.EntityProperty] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                guard let entityID = UUID(uuidString: textColumn(statement, 0)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported entity property entity id")
                }
                let valueEntityID: UUID?
                if sqlite3_column_type(statement, 3) == SQLITE_NULL {
                    valueEntityID = nil
                } else {
                    guard let decodedID = UUID(uuidString: textColumn(statement, 3)) else {
                        throw SQLiteNotesError.rowDecodeFailed("invalid exported entity property value entity id")
                    }
                    valueEntityID = decodedID
                }
                guard let updatedAt = Date(iso8601String: textColumn(statement, 4)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported entity property timestamp")
                }

                properties.append(
                    NotesVaultSnapshot.EntityProperty(
                        entityID: entityID,
                        key: textColumn(statement, 1),
                        value: textColumn(statement, 2),
                        valueEntityID: valueEntityID,
                        updatedAt: updatedAt
                    )
                )
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return properties
        }
    }

    private func fetchVaultSupertagFields() throws -> [NotesVaultSnapshot.SupertagField] {
        try prepare(
            """
            SELECT id, supertag_id, field_key, label, value_type, default_value, is_required, sort_order, created_at, updated_at
            FROM supertag_field_definitions
            ORDER BY supertag_id ASC, sort_order ASC, label COLLATE NOCASE ASC;
            """
        ) { statement in
            var definitions: [NotesVaultSnapshot.SupertagField] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                guard let id = UUID(uuidString: textColumn(statement, 0)),
                      let supertagID = UUID(uuidString: textColumn(statement, 1)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported supertag field id")
                }
                guard let createdAt = Date(iso8601String: textColumn(statement, 8)),
                      let updatedAt = Date(iso8601String: textColumn(statement, 9)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported supertag field timestamp")
                }

                definitions.append(
                    NotesVaultSnapshot.SupertagField(
                        id: id,
                        supertagID: supertagID,
                        key: textColumn(statement, 2),
                        label: textColumn(statement, 3),
                        valueType: textColumn(statement, 4),
                        defaultValue: nullableTextColumn(statement, 5),
                        isRequired: sqlite3_column_int(statement, 6) != 0,
                        sortOrder: Int(sqlite3_column_int64(statement, 7)),
                        createdAt: createdAt,
                        updatedAt: updatedAt
                    )
                )
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return definitions
        }
    }

    private func fetchVaultSavedViews() throws -> [NotesVaultSnapshot.SavedView] {
        try prepare(
            """
            SELECT id, name, query, view, group_by, created_at, updated_at
            FROM saved_query_views
            ORDER BY name COLLATE NOCASE ASC, id ASC;
            """
        ) { statement in
            var savedViews: [NotesVaultSnapshot.SavedView] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                guard let id = UUID(uuidString: textColumn(statement, 0)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported saved view id")
                }
                guard let createdAt = Date(iso8601String: textColumn(statement, 5)),
                      let updatedAt = Date(iso8601String: textColumn(statement, 6)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid exported saved view timestamp")
                }

                savedViews.append(
                    NotesVaultSnapshot.SavedView(
                        id: id,
                        name: textColumn(statement, 1),
                        query: textColumn(statement, 2),
                        view: textColumn(statement, 3),
                        groupBy: nullableTextColumn(statement, 4),
                        createdAt: createdAt,
                        updatedAt: updatedAt
                    )
                )
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return savedViews
        }
    }

    private func clearVaultTables() throws {
        try prepare("DELETE FROM document_entity_references;") { statement in
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
        try prepare("DELETE FROM entity_properties;") { statement in
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
        try prepare("DELETE FROM entity_supertags;") { statement in
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
        try prepare("DELETE FROM supertag_field_definitions;") { statement in
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
        try prepare("DELETE FROM saved_query_views;") { statement in
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
        try prepare("DELETE FROM documents;") { statement in
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
        try prepare("DELETE FROM entities;") { statement in
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
        try prepare("DELETE FROM supertags;") { statement in
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    private func insertImportedDocument(_ document: NotesVaultSnapshot.Document) throws {
        try prepare(
            """
            INSERT INTO documents (
                id, kind, date, title, tiptap_json, plain_text, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?);
            """
        ) { statement in
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

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    private func insertImportedEntity(_ entity: NotesVaultSnapshot.Entity) throws {
        try prepare(
            """
            INSERT INTO entities (id, canonical_name, created_at, updated_at)
            VALUES (?, ?, ?, ?);
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, entity.id.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, entity.name, -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, entity.createdAt.ISO8601Format(), -1, sqliteTransient)
            sqlite3_bind_text(statement, 4, entity.updatedAt.ISO8601Format(), -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    private func insertImportedSupertag(_ supertag: NotesVaultSnapshot.Supertag) throws {
        try prepare(
            """
            INSERT INTO supertags (id, name, slug, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?);
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, supertag.id.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, supertag.name, -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, supertag.slug, -1, sqliteTransient)
            sqlite3_bind_text(statement, 4, supertag.createdAt.ISO8601Format(), -1, sqliteTransient)
            sqlite3_bind_text(statement, 5, supertag.updatedAt.ISO8601Format(), -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    private func insertImportedEntitySupertag(_ link: NotesVaultSnapshot.EntitySupertag) throws {
        try prepare(
            """
            INSERT INTO entity_supertags (entity_id, supertag_id, created_at)
            VALUES (?, ?, ?);
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, link.entityID.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, link.supertagID.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, link.createdAt.ISO8601Format(), -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    private func insertImportedSupertagField(_ definition: NotesVaultSnapshot.SupertagField) throws {
        try prepare(
            """
            INSERT INTO supertag_field_definitions (
                id, supertag_id, field_key, label, value_type, default_value, is_required, sort_order, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, definition.id.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, definition.supertagID.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, definition.key, -1, sqliteTransient)
            sqlite3_bind_text(statement, 4, definition.label, -1, sqliteTransient)
            sqlite3_bind_text(statement, 5, definition.valueType, -1, sqliteTransient)
            if let defaultValue = definition.defaultValue {
                sqlite3_bind_text(statement, 6, defaultValue, -1, sqliteTransient)
            } else {
                sqlite3_bind_null(statement, 6)
            }
            sqlite3_bind_int(statement, 7, definition.isRequired ? 1 : 0)
            sqlite3_bind_int64(statement, 8, Int64(definition.sortOrder))
            sqlite3_bind_text(statement, 9, definition.createdAt.ISO8601Format(), -1, sqliteTransient)
            sqlite3_bind_text(statement, 10, definition.updatedAt.ISO8601Format(), -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    private func insertImportedEntityProperty(_ property: NotesVaultSnapshot.EntityProperty) throws {
        try prepare(
            """
            INSERT INTO entity_properties (
                entity_id, property_key, property_value, value_entity_id, updated_at
            )
            VALUES (?, ?, ?, ?, ?);
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, property.entityID.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, property.key, -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, property.value, -1, sqliteTransient)
            if let valueEntityID = property.valueEntityID {
                sqlite3_bind_text(statement, 4, valueEntityID.uuidString, -1, sqliteTransient)
            } else {
                sqlite3_bind_null(statement, 4)
            }
            sqlite3_bind_text(statement, 5, property.updatedAt.ISO8601Format(), -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    private func insertImportedSavedView(_ savedView: NotesVaultSnapshot.SavedView) throws {
        try prepare(
            """
            INSERT INTO saved_query_views (
                id, name, query, view, group_by, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?);
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, savedView.id.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, savedView.name, -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, savedView.query, -1, sqliteTransient)
            sqlite3_bind_text(statement, 4, savedView.view, -1, sqliteTransient)
            if let groupBy = savedView.groupBy {
                sqlite3_bind_text(statement, 5, groupBy, -1, sqliteTransient)
            } else {
                sqlite3_bind_null(statement, 5)
            }
            sqlite3_bind_text(statement, 6, savedView.createdAt.ISO8601Format(), -1, sqliteTransient)
            sqlite3_bind_text(statement, 7, savedView.updatedAt.ISO8601Format(), -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
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

    private func fetchEntityName(id entityID: UUID) throws -> String? {
        try prepare(
            """
            SELECT canonical_name
            FROM entities
            WHERE id = ?
            LIMIT 1;
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, entityID.uuidString, -1, sqliteTransient)
            let result = sqlite3_step(statement)

            if result == SQLITE_DONE {
                return nil
            }

            guard result == SQLITE_ROW else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return textColumn(statement, 0)
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

    private func ensureEntityRecord(named canonicalName: String, createdAt: Date) throws -> UUID {
        if let existingID = try fetchEntityID(named: canonicalName) {
            return existingID
        }

        let entityID = UUID()
        try insertEntity(id: entityID, canonicalName: canonicalName, createdAt: createdAt, updatedAt: createdAt)
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

    private func ensureSupertagRecord(named name: String, createdAt: Date) throws -> UUID {
        let slug = slugified(name)
        if let existingID = try fetchSupertagID(slug: slug) {
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
            sqlite3_bind_text(statement, 4, createdAt.ISO8601Format(), -1, sqliteTransient)
            sqlite3_bind_text(statement, 5, createdAt.ISO8601Format(), -1, sqliteTransient)

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
        try syncEntityProperties(
            entityID: entityID,
            properties: normalizedProperties(rawProperties),
            updatedAt: updatedAt
        )
    }

    private func syncEntityProperties(
        entityID: UUID,
        properties: [NormalizedEntityProperty],
        updatedAt: Date
    ) throws {
        try prepare("DELETE FROM entity_properties WHERE entity_id = ?;") { statement in
            sqlite3_bind_text(statement, 1, entityID.uuidString, -1, sqliteTransient)
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }

        try insertEntityProperties(entityID: entityID, properties: properties, updatedAt: updatedAt)
    }

    private func upsertEntityProperties(
        entityID: UUID,
        properties rawProperties: [String: String],
        updatedAt: Date
    ) throws {
        try upsertEntityProperties(
            entityID: entityID,
            properties: normalizedProperties(rawProperties),
            updatedAt: updatedAt
        )
    }

    private func upsertEntityProperties(
        entityID: UUID,
        properties: [NormalizedEntityProperty],
        updatedAt: Date
    ) throws {
        try insertEntityProperties(
            entityID: entityID,
            properties: properties,
            updatedAt: updatedAt,
            onConflict: """
            ON CONFLICT(entity_id, property_key) DO UPDATE SET
                property_value = excluded.property_value,
                value_entity_id = excluded.value_entity_id,
                updated_at = excluded.updated_at
            """
        )
    }

    private func insertEntityProperties(
        entityID: UUID,
        properties: [NormalizedEntityProperty],
        updatedAt: Date,
        onConflict: String = ""
    ) throws {
        for property in properties {
            let storage = try storageValue(for: property, updatedAt: updatedAt)

            try prepare(
                """
                INSERT INTO entity_properties (
                    entity_id, property_key, property_value, value_entity_id, updated_at
                )
                VALUES (?, ?, ?, ?, ?)
                \(onConflict);
                """
            ) { statement in
                sqlite3_bind_text(statement, 1, entityID.uuidString, -1, sqliteTransient)
                sqlite3_bind_text(statement, 2, property.key, -1, sqliteTransient)
                sqlite3_bind_text(statement, 3, storage.value, -1, sqliteTransient)
                if let valueEntityID = storage.valueEntityID {
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

    private func storageValue(
        for property: NormalizedEntityProperty,
        updatedAt: Date
    ) throws -> (value: String, valueEntityID: UUID?) {
        guard let referencedEntityName = property.referencedEntityName else {
            if let valueEntityID = property.valueEntityID.flatMap(UUID.init(uuidString:)),
               let entityName = try fetchEntityName(id: valueEntityID) {
                return (entityName, valueEntityID)
            }

            return (property.value, nil)
        }

        let valueEntityID = try ensureEntityRecord(named: referencedEntityName, createdAt: updatedAt)
        let propertyValue = try fetchEntityName(id: valueEntityID) ?? referencedEntityName
        return (propertyValue, valueEntityID)
    }

    private func schemaConformingEntityProperties(
        entityID: UUID,
        entityName: String,
        rawProperties: [String: String],
        mode: EntityPropertySchemaMode,
        updatedAt: Date
    ) throws -> [NormalizedEntityProperty] {
        let incomingProperties = normalizedPropertyMap(rawProperties)
        var effectiveProperties: [String: NormalizedEntityProperty]
        var writableProperties: [String: NormalizedEntityProperty]

        switch mode {
        case .replace:
            effectiveProperties = incomingProperties
            writableProperties = incomingProperties
        case .patch:
            effectiveProperties = try fetchStoredNormalizedEntityProperties(forEntityID: entityID)
            for (key, property) in incomingProperties {
                effectiveProperties[key] = property
            }
            writableProperties = incomingProperties
        }

        for definition in try fetchSupertagFieldDefinitions(entityID: entityID) {
            if isMissingSchemaProperty(effectiveProperties[definition.key]),
               let defaultValue = definition.defaultValue,
               let defaultProperty = normalizedProperty(key: definition.key, value: defaultValue) {
                effectiveProperties[definition.key] = defaultProperty
                writableProperties[definition.key] = defaultProperty
            }

            guard !definition.isRequired || !isMissingSchemaProperty(effectiveProperties[definition.key]) else {
                throw SQLiteNotesError.validationFailed(
                    "\(definition.supertagName) requires \(definition.label) for \(entityName)."
                )
            }

            if let property = effectiveProperties[definition.key] {
                try validateSupertagFieldValue(property, definition: definition, entityName: entityName)
            }
        }

        return sortedProperties(writableProperties)
    }

    private func fetchStoredNormalizedEntityProperties(
        forEntityID entityID: UUID
    ) throws -> [String: NormalizedEntityProperty] {
        let grouped = try fetchStoredEntityProperties(entityIDs: [entityID.uuidString])
        let storedProperties = grouped[entityID.uuidString] ?? [:]
        return storedProperties.reduce(into: [:]) { result, item in
            result[item.key] = NormalizedEntityProperty(
                key: item.key,
                value: item.value.value,
                referencedEntityName: nil,
                valueEntityID: item.value.valueEntityID
            )
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

    private func rebuildImportedDocumentEntityReferenceIndex() throws {
        try prepare("DELETE FROM document_entity_references;") { statement in
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }

        let documents = try fetchDocuments()
        let indexedAt = Date()
        for document in documents {
            for entityID in entityReferenceIDs(in: document.tiptapJSON) {
                try insertExistingDocumentEntityReference(
                    documentID: document.id,
                    entityID: entityID,
                    indexedAt: indexedAt
                )
            }

            for mention in entityMentions(in: document.plainText) {
                if let entityID = try fetchEntityID(named: mention.name) {
                    try insertDocumentEntityReference(
                        documentID: document.id,
                        entityID: entityID,
                        indexedAt: indexedAt
                    )
                }
            }
        }
    }

    private func insertEntityReferences(for document: NoteDocument) throws {
        let now = Date()

        for entityID in entityReferenceIDs(in: document.tiptapJSON) {
            try insertExistingDocumentEntityReference(documentID: document.id, entityID: entityID, indexedAt: now)
        }

        for mention in entityMentions(in: document.plainText) {
            let entityID = try ensureEntityRecord(named: mention.name, createdAt: now)
            for supertagName in mention.supertagNames {
                let supertagID = try ensureSupertagRecord(named: supertagName, createdAt: now)
                try link(entityID: entityID, toSupertagID: supertagID)
            }
            let schemaProperties = try schemaConformingEntityProperties(
                entityID: entityID,
                entityName: mention.name,
                rawProperties: mention.properties,
                mode: .patch,
                updatedAt: now
            )
            try upsertEntityProperties(entityID: entityID, properties: schemaProperties, updatedAt: now)
            try insertDocumentEntityReference(documentID: document.id, entityID: entityID, indexedAt: now)
        }
    }

    private func insertExistingDocumentEntityReference(
        documentID: UUID,
        entityID: UUID,
        indexedAt: Date
    ) throws {
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
            sqlite3_bind_text(statement, 1, documentID.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, entityID.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, indexedAt.ISO8601Format(), -1, sqliteTransient)
            sqlite3_bind_text(statement, 4, entityID.uuidString, -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    private func insertDocumentEntityReference(
        documentID: UUID,
        entityID: UUID,
        indexedAt: Date
    ) throws {
        try prepare(
            """
            INSERT OR IGNORE INTO document_entity_references (document_id, entity_id, indexed_at)
            VALUES (?, ?, ?);
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, documentID.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, entityID.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, indexedAt.ISO8601Format(), -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
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
        let rows = try fetchDocumentBacklinks().map { backlink in
            [
                "entity_id": backlink.entityID.uuidString,
                "entity": backlink.entityName,
                "document_id": backlink.documentID.uuidString,
                "document": backlink.documentTitle,
                "document_kind": backlink.documentKind.rawValue,
                "date": backlink.documentDate ?? "",
                "name": "\(backlink.entityName) -> \(backlink.documentTitle)",
                queryDocumentIDMetadataKey: backlink.documentID.uuidString,
            ]
        }

        return QueryResult(
            columns: ["name", "entity", "document", "document_kind", "date", "entity_id", "document_id"],
            rows: rows
        )
    }

    private func fetchDocumentBacklinks(
        whereClause: String = "",
        bind: (OpaquePointer?) throws -> Void = { _ in }
    ) throws -> [DocumentBacklink] {
        try prepare(
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
            \(whereClause)
            ORDER BY entities.canonical_name COLLATE NOCASE ASC, documents.updated_at DESC;
            """
        ) { statement in
            try bind(statement)
            var backlinks: [DocumentBacklink] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                guard let entityID = UUID(uuidString: textColumn(statement, 0)),
                      let documentID = UUID(uuidString: textColumn(statement, 2)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid document backlink id")
                }

                guard let documentKind = NoteDocumentKind(rawValue: textColumn(statement, 4)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid document backlink kind")
                }

                let documentDate = textColumn(statement, 5)
                backlinks.append(
                    DocumentBacklink(
                        entityID: entityID,
                        entityName: textColumn(statement, 1),
                        documentID: documentID,
                        documentTitle: textColumn(statement, 3),
                        documentKind: documentKind,
                        documentDate: documentDate.isEmpty ? nil : documentDate
                    )
                )
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return backlinks
        }
    }

    private func fetchEntityRelationshipQueryResult() throws -> QueryResult {
        let rows = try fetchEntityRelationships().map { relationship in
            [
                "name": "\(relationship.sourceName) \(relationship.property) -> \(relationship.targetName)",
                "source": relationship.sourceName,
                "property": relationship.property,
                "target": relationship.targetName,
                "source_id": relationship.sourceEntityID.uuidString,
                "target_id": relationship.targetEntityID.uuidString,
                "updated_at": relationship.updatedAt.ISO8601Format(),
            ]
        }

        return QueryResult(
            columns: ["name", "source", "property", "target", "source_id", "target_id", "updated_at"],
            rows: rows
        )
    }

    private func fetchEntityRelationships(
        entityIDs: [UUID],
        column: String
    ) throws -> [EntityRelationship] {
        let uniqueIDs = Array(Set(entityIDs)).sorted { $0.uuidString < $1.uuidString }
        guard !uniqueIDs.isEmpty else {
            return []
        }

        let placeholders = uniqueIDs.map { _ in "?" }.joined(separator: ", ")
        return try fetchEntityRelationships(
            whereClause: "WHERE \(column) IN (\(placeholders))",
            bind: { statement in
                for (index, id) in uniqueIDs.enumerated() {
                    sqlite3_bind_text(statement, Int32(index + 1), id.uuidString, -1, sqliteTransient)
                }
            }
        )
    }

    private func fetchEntityRelationships(
        whereClause: String = "",
        bind: (OpaquePointer?) throws -> Void = { _ in }
    ) throws -> [EntityRelationship] {
        try prepare(
            """
            SELECT
                source_entities.id,
                source_entities.canonical_name,
                entity_properties.property_key,
                target_entities.id,
                target_entities.canonical_name,
                entity_properties.updated_at
            FROM entity_properties
            INNER JOIN entities source_entities
                ON source_entities.id = entity_properties.entity_id
            INNER JOIN entities target_entities
                ON target_entities.id = entity_properties.value_entity_id
            \(whereClause)
            ORDER BY target_entities.canonical_name COLLATE NOCASE ASC,
                entity_properties.property_key COLLATE NOCASE ASC,
                source_entities.canonical_name COLLATE NOCASE ASC;
            """
        ) { statement in
            try bind(statement)
            var relationships: [EntityRelationship] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                guard let sourceEntityID = UUID(uuidString: textColumn(statement, 0)),
                      let targetEntityID = UUID(uuidString: textColumn(statement, 3)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid entity relationship id")
                }

                guard let updatedAt = Date(iso8601String: textColumn(statement, 5)) else {
                    throw SQLiteNotesError.rowDecodeFailed("invalid entity relationship timestamp")
                }

                relationships.append(
                    EntityRelationship(
                        sourceEntityID: sourceEntityID,
                        sourceName: textColumn(statement, 1),
                        property: textColumn(statement, 2),
                        targetEntityID: targetEntityID,
                        targetName: textColumn(statement, 4),
                        updatedAt: updatedAt
                    )
                )
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return relationships
        }
    }

    private func fetchSavedQueryViewQueryResult() throws -> QueryResult {
        QueryResult(
            columns: ["id", "name", "query", "view", "group_by", "updated_at"],
            rows: try fetchSavedQueryViews().map(savedQueryViewQueryRow)
        )
    }

    private func fetchSupertagFieldDefinitionQueryResult() throws -> QueryResult {
        QueryResult(
            columns: [
                "id",
                "supertag",
                "supertag_slug",
                "field",
                "label",
                "type",
                "default_value",
                "required",
                "sort_order",
                "updated_at",
            ],
            rows: try fetchSupertagFieldDefinitions().map(supertagFieldDefinitionQueryRow)
        )
    }

    private func querySupertagFieldDefinitions(
        whereClause: String = "",
        bind: (OpaquePointer?) throws -> Void = { _ in }
    ) throws -> [SupertagFieldDefinition] {
        try prepare(
            """
            SELECT
                supertag_field_definitions.id,
                supertags.id,
                supertags.name,
                supertags.slug,
                supertag_field_definitions.field_key,
                supertag_field_definitions.label,
                supertag_field_definitions.value_type,
                supertag_field_definitions.default_value,
                supertag_field_definitions.is_required,
                supertag_field_definitions.sort_order,
                supertag_field_definitions.created_at,
                supertag_field_definitions.updated_at
            FROM supertag_field_definitions
            INNER JOIN supertags ON supertags.id = supertag_field_definitions.supertag_id
            \(whereClause)
            ORDER BY supertags.name COLLATE NOCASE ASC,
                     supertag_field_definitions.sort_order ASC,
                     supertag_field_definitions.label COLLATE NOCASE ASC;
            """
        ) { statement in
            try bind(statement)
            var definitions: [SupertagFieldDefinition] = []
            var result = sqlite3_step(statement)

            while result == SQLITE_ROW {
                definitions.append(try supertagFieldDefinition(from: statement))
                result = sqlite3_step(statement)
            }

            guard result == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return definitions
        }
    }

    private func fetchSupertagFieldDefinition(supertagID: UUID, key: String) throws -> SupertagFieldDefinition? {
        try querySupertagFieldDefinitions(
            whereClause: "WHERE supertag_field_definitions.supertag_id = ? AND supertag_field_definitions.field_key = ?",
            bind: { statement in
                sqlite3_bind_text(statement, 1, supertagID.uuidString, -1, sqliteTransient)
                sqlite3_bind_text(statement, 2, key, -1, sqliteTransient)
            }
        )
        .first
    }

    private func fetchSupertagFieldDefinitions(entityID: UUID) throws -> [SupertagFieldDefinition] {
        try querySupertagFieldDefinitions(
            whereClause: """
            WHERE EXISTS (
                SELECT 1
                FROM entity_supertags
                WHERE entity_supertags.entity_id = ?
                  AND entity_supertags.supertag_id = supertags.id
            )
            """,
            bind: { statement in
                sqlite3_bind_text(statement, 1, entityID.uuidString, -1, sqliteTransient)
            }
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

    private func savedQueryView(from statement: OpaquePointer?) throws -> SavedQueryView {
        guard let id = UUID(uuidString: textColumn(statement, 0)) else {
            throw SQLiteNotesError.rowDecodeFailed("invalid saved query view id")
        }

        guard let createdAt = Date(iso8601String: textColumn(statement, 5)) else {
            throw SQLiteNotesError.rowDecodeFailed("invalid saved query view created_at timestamp")
        }

        guard let updatedAt = Date(iso8601String: textColumn(statement, 6)) else {
            throw SQLiteNotesError.rowDecodeFailed("invalid saved query view updated_at timestamp")
        }

        return SavedQueryView(
            id: id,
            name: textColumn(statement, 1),
            query: textColumn(statement, 2),
            view: textColumn(statement, 3),
            groupBy: nullableTextColumn(statement, 4),
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }

    private func supertagFieldDefinition(from statement: OpaquePointer?) throws -> SupertagFieldDefinition {
        guard let id = UUID(uuidString: textColumn(statement, 0)) else {
            throw SQLiteNotesError.rowDecodeFailed("invalid supertag field definition id")
        }

        guard let supertagID = UUID(uuidString: textColumn(statement, 1)) else {
            throw SQLiteNotesError.rowDecodeFailed("invalid supertag field definition supertag id")
        }

        guard let createdAt = Date(iso8601String: textColumn(statement, 10)) else {
            throw SQLiteNotesError.rowDecodeFailed("invalid supertag field definition created_at timestamp")
        }

        guard let updatedAt = Date(iso8601String: textColumn(statement, 11)) else {
            throw SQLiteNotesError.rowDecodeFailed("invalid supertag field definition updated_at timestamp")
        }

        return SupertagFieldDefinition(
            id: id,
            supertagID: supertagID,
            supertagName: textColumn(statement, 2),
            supertagSlug: textColumn(statement, 3),
            key: textColumn(statement, 4),
            label: textColumn(statement, 5),
            valueType: textColumn(statement, 6),
            defaultValue: nullableTextColumn(statement, 7),
            isRequired: sqlite3_column_int(statement, 8) != 0,
            sortOrder: Int(sqlite3_column_int64(statement, 9)),
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }

    private func fetchSavedQueryView(name: String) throws -> SavedQueryView? {
        try prepare(
            """
            SELECT id, name, query, view, group_by, created_at, updated_at
            FROM saved_query_views
            WHERE name = ?
            LIMIT 1;
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, name, -1, sqliteTransient)
            let result = sqlite3_step(statement)

            if result == SQLITE_DONE {
                return nil
            }

            guard result == SQLITE_ROW else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }

            return try savedQueryView(from: statement)
        }
    }

    private func upsert(_ savedView: SavedQueryView) throws {
        try prepare(
            """
            INSERT INTO saved_query_views (
                id, name, query, view, group_by, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                query = excluded.query,
                view = excluded.view,
                group_by = excluded.group_by,
                updated_at = excluded.updated_at;
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, savedView.id.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, savedView.name, -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, savedView.query, -1, sqliteTransient)
            sqlite3_bind_text(statement, 4, savedView.view, -1, sqliteTransient)
            if let groupBy = savedView.groupBy {
                sqlite3_bind_text(statement, 5, groupBy, -1, sqliteTransient)
            } else {
                sqlite3_bind_null(statement, 5)
            }
            sqlite3_bind_text(statement, 6, savedView.createdAt.ISO8601Format(), -1, sqliteTransient)
            sqlite3_bind_text(statement, 7, savedView.updatedAt.ISO8601Format(), -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
    }

    private func upsert(_ definition: SupertagFieldDefinition) throws {
        try prepare(
            """
            INSERT INTO supertag_field_definitions (
                id, supertag_id, field_key, label, value_type, default_value, is_required, sort_order, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                supertag_id = excluded.supertag_id,
                field_key = excluded.field_key,
                label = excluded.label,
                value_type = excluded.value_type,
                default_value = excluded.default_value,
                is_required = excluded.is_required,
                sort_order = excluded.sort_order,
                updated_at = excluded.updated_at;
            """
        ) { statement in
            sqlite3_bind_text(statement, 1, definition.id.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 2, definition.supertagID.uuidString, -1, sqliteTransient)
            sqlite3_bind_text(statement, 3, definition.key, -1, sqliteTransient)
            sqlite3_bind_text(statement, 4, definition.label, -1, sqliteTransient)
            sqlite3_bind_text(statement, 5, definition.valueType, -1, sqliteTransient)
            if let defaultValue = definition.defaultValue {
                sqlite3_bind_text(statement, 6, defaultValue, -1, sqliteTransient)
            } else {
                sqlite3_bind_null(statement, 6)
            }
            sqlite3_bind_int(statement, 7, definition.isRequired ? 1 : 0)
            sqlite3_bind_int64(statement, 8, Int64(definition.sortOrder))
            sqlite3_bind_text(statement, 9, definition.createdAt.ISO8601Format(), -1, sqliteTransient)
            sqlite3_bind_text(statement, 10, definition.updatedAt.ISO8601Format(), -1, sqliteTransient)

            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw SQLiteNotesError.stepFailed(lastErrorMessage)
            }
        }
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

private func normalizedSupertagName(_ value: String) -> String? {
    normalizedUniqueNames([value]).first
}

private func normalizedSavedQueryViewMode(_ value: String) throws -> String {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    switch normalized {
    case "table", "list", "board":
        return normalized
    default:
        throw SQLiteNotesError.validationFailed("Saved view mode must be table, list, or board.")
    }
}

private func normalizedOptionalField(_ value: String?) -> String? {
    let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    return normalized.isEmpty ? nil : normalized
}

private func normalizedSupertagFieldValueType(_ value: String) throws -> String {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    switch normalized {
    case "text", "string":
        return "text"
    case "number", "numeric":
        return "number"
    case "date":
        return "date"
    case "entity", "reference":
        return "entity"
    case "boolean", "bool", "checkbox":
        return "boolean"
    default:
        throw SQLiteNotesError.validationFailed("Supertag field type must be text, number, date, entity, or boolean.")
    }
}

private func normalizedDefaultValue(_ value: String?) -> String? {
    let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return normalized.isEmpty ? nil : normalized
}

private enum EntityPropertySchemaMode {
    case replace
    case patch
}

private struct NormalizedEntityProperty {
    var key: String
    var value: String
    var referencedEntityName: String?
    var valueEntityID: String? = nil
}

private struct StoredEntityProperty {
    var value: String
    var valueEntityID: String?
}

private struct PlainTextEntityMention {
    var name: String
    var supertagNames: [String]
    var properties: [String: String] = [:]
}

private func normalizedProperties(_ properties: [String: String]) -> [NormalizedEntityProperty] {
    sortedProperties(normalizedPropertyMap(properties))
}

private func normalizedPropertyMap(_ properties: [String: String]) -> [String: NormalizedEntityProperty] {
    var normalized: [String: NormalizedEntityProperty] = [:]

    for (rawKey, rawValue) in properties {
        if let property = normalizedProperty(key: rawKey, value: rawValue) {
            normalized[property.key] = property
        }
    }

    return normalized
}

private func normalizedProperty(key rawKey: String, value rawValue: String) -> NormalizedEntityProperty? {
    let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else {
        return nil
    }

    let key = normalizedEntityPropertyKey(rawKey)
    guard !key.isEmpty else {
        return nil
    }

    let referencedEntityName = entityReferencePropertyValue(value)
    return NormalizedEntityProperty(
        key: key,
        value: referencedEntityName ?? value,
        referencedEntityName: referencedEntityName
    )
}

private func sortedProperties(_ properties: [String: NormalizedEntityProperty]) -> [NormalizedEntityProperty] {
    properties
        .map { $0.value }
        .sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
}

private func isMissingSchemaProperty(_ property: NormalizedEntityProperty?) -> Bool {
    property?.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true
}

private func validateSupertagFieldDefaultValue(
    _ value: String,
    valueType: String,
    supertagName: String,
    label: String
) throws {
    let referencedEntityName = entityReferencePropertyValue(value)
    guard isValidSupertagFieldValue(
        value: referencedEntityName ?? value,
        valueType: valueType,
        referencedEntityName: referencedEntityName,
        valueEntityID: nil
    ) else {
        throw SQLiteNotesError.validationFailed(
            "Default value for \(supertagName).\(label) must be \(supertagFieldTypeDescription(valueType))."
        )
    }
}

private func validateSupertagFieldValue(
    _ property: NormalizedEntityProperty,
    definition: SupertagFieldDefinition,
    entityName: String
) throws {
    guard isValidSupertagFieldValue(
        value: property.value,
        valueType: definition.valueType,
        referencedEntityName: property.referencedEntityName,
        valueEntityID: property.valueEntityID
    ) else {
        throw SQLiteNotesError.validationFailed(
            "\(definition.supertagName).\(definition.label) for \(entityName) must be \(supertagFieldTypeDescription(definition.valueType))."
        )
    }
}

private func isValidSupertagFieldValue(
    value: String,
    valueType: String,
    referencedEntityName: String?,
    valueEntityID: String?
) -> Bool {
    switch valueType {
    case "text":
        return true
    case "number":
        guard let number = Double(value.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return false
        }
        return number.isFinite
    case "date":
        return isValidSupertagDateValue(value)
    case "entity":
        return referencedEntityName != nil || valueEntityID != nil
    case "boolean":
        return isValidSupertagBooleanValue(value)
    default:
        return false
    }
}

private func supertagFieldTypeDescription(_ valueType: String) -> String {
    switch valueType {
    case "text":
        return "text"
    case "number":
        return "a number"
    case "date":
        return "a date"
    case "entity":
        return "an entity reference"
    case "boolean":
        return "a boolean"
    default:
        return "a valid value"
    }
}

private func isValidSupertagDateValue(_ value: String) -> Bool {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if Date(iso8601String: trimmed) != nil {
        return true
    }

    guard let date = DailyNoteDateFormatter.date(from: trimmed) else {
        return false
    }

    return DailyNoteDateFormatter.storageString(from: date) == trimmed
}

private func isValidSupertagBooleanValue(_ value: String) -> Bool {
    switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "true", "false", "yes", "no", "on", "off", "1", "0":
        return true
    default:
        return false
    }
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

private func normalizedEntityPropertyKey(_ value: String) -> String {
    let reservedColumns: Set<String> = ["id", "name", "supertags", "updated_at"]
    let key = normalizedPropertyKey(value)
    return reservedColumns.contains(key) ? "property_\(key)" : key
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
        queryDocumentIDMetadataKey: document.id.uuidString,
    ]
}

private func dailyNoteQueryRow(_ document: NoteDocument) -> [String: String] {
    [
        "id": document.id.uuidString,
        "date": document.date ?? "",
        "title": document.title,
        "updated_at": document.updatedAt.ISO8601Format(),
        queryDocumentIDMetadataKey: document.id.uuidString,
    ]
}

private func savedQueryViewQueryRow(_ view: SavedQueryView) -> [String: String] {
    [
        "id": view.id.uuidString,
        "name": view.name,
        "query": view.query,
        "view": view.view,
        "group_by": view.groupBy ?? "",
        "updated_at": view.updatedAt.ISO8601Format(),
    ]
}

private func supertagFieldDefinitionQueryRow(_ definition: SupertagFieldDefinition) -> [String: String] {
    [
        "id": definition.id.uuidString,
        "supertag": definition.supertagName,
        "supertag_slug": definition.supertagSlug,
        "field": definition.key,
        "label": definition.label,
        "type": definition.valueType,
        "default_value": definition.defaultValue ?? "",
        "required": definition.isRequired ? "true" : "false",
        "sort_order": String(definition.sortOrder),
        "updated_at": definition.updatedAt.ISO8601Format(),
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

private func entityMentions(in plainText: String) -> [PlainTextEntityMention] {
    var mentionsByKey: [String: PlainTextEntityMention] = [:]
    var orderedKeys: [String] = []
    var currentEntityKey: String?

    for line in plainText.components(separatedBy: .newlines) {
        if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            currentEntityKey = nil
            continue
        }

        if let currentEntityKey,
           let property = entityPropertyAnnotation(in: line),
           var mention = mentionsByKey[currentEntityKey] {
            mention.properties[property.key] = property.value
            mentionsByKey[currentEntityKey] = mention
            continue
        }

        var searchStart = line.startIndex
        var foundMention = false

        while let openRange = line[searchStart...].range(of: "[[") {
            let nameStart = openRange.upperBound
            guard let closeRange = line[nameStart...].range(of: "]]") else {
                break
            }

            let rawName = String(line[nameStart..<closeRange.lowerBound])
            searchStart = closeRange.upperBound

            guard !rawName.contains("["),
                  !rawName.contains("]") else {
                continue
            }

            let normalized = normalizedName(rawName)
            let key = normalized.lowercased()
            guard !normalized.isEmpty else {
                continue
            }

            let tagSegmentEnd = line[closeRange.upperBound...].range(of: "[[")?.lowerBound ?? line.endIndex
            let sameLineTags = supertagNames(in: String(line[closeRange.upperBound..<tagSegmentEnd]))
            if var mention = mentionsByKey[key] {
                mention.supertagNames = normalizedUniqueNames(mention.supertagNames + sameLineTags)
                mentionsByKey[key] = mention
            } else {
                mentionsByKey[key] = PlainTextEntityMention(
                    name: normalized,
                    supertagNames: normalizedUniqueNames(sameLineTags)
                )
                orderedKeys.append(key)
            }
            currentEntityKey = key
            foundMention = true
        }

        if !foundMention {
            currentEntityKey = nil
        }
    }

    return orderedKeys.compactMap { mentionsByKey[$0] }
}

private func entityPropertyAnnotation(in line: String) -> (key: String, value: String)? {
    let pattern = #"^\s*([A-Za-z_][A-Za-z0-9 _-]*)::\s*(.+?)\s*$"#
    guard let match = line.firstMatch(pattern: pattern),
          let rawKey = match[1],
          let rawValue = match[2] else {
        return nil
    }

    let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
    let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty, !value.isEmpty else {
        return nil
    }

    return (key, value)
}

private func supertagNames(in text: String) -> [String] {
    guard let expression = try? NSRegularExpression(pattern: #"(^|\s)#([A-Za-z0-9][A-Za-z0-9_-]*)"#) else {
        return []
    }

    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    let matches = expression.matches(in: text, range: range)
    let names = matches.compactMap { match -> String? in
        guard let tagRange = Range(match.range(at: 2), in: text) else {
            return nil
        }

        let normalized = normalizedName(String(text[tagRange]))
        return normalized.isEmpty ? nil : normalized
    }

    return normalizedUniqueNames(names)
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
        let predicateGroups = try resolvedPredicateGroups(query.predicateGroups, relativeDate: relativeDate)
        rows = filterQueryRows(rows, using: predicateGroups)
    }

    if let group = query.group {
        return try materializedGroupedAggregate(
            rows: rows,
            sourceResult: result,
            group: group,
            query: query,
            relativeDate: relativeDate
        )
    }

    if let aggregate = query.aggregate {
        switch aggregate.kind {
        case .countAll:
            return QueryResult(
                columns: [aggregate.outputName],
                rows: [[aggregate.outputName: String(rows.count)]]
            )
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
        var projectedRow = Dictionary(uniqueKeysWithValues: projection.map { item in
            (item.outputName, row[item.field] ?? "")
        })
        projectedRow[queryDocumentIDMetadataKey] = row[queryDocumentIDMetadataKey]
        return projectedRow
    }

    return QueryResult(columns: projection.map { $0.outputName }, rows: projectedRows)
}

private func materializedGroupedAggregate(
    rows: [[String: String]],
    sourceResult: QueryResult,
    group: LocalQueryGroup,
    query: LocalQuery,
    relativeDate: Date
) throws -> QueryResult {
    guard let aggregate = query.aggregate else {
        throw SQLiteNotesError.validationFailed("GROUP BY currently supports COUNT(*) queries only.")
    }

    guard let projection = query.projection, !projection.isEmpty else {
        throw SQLiteNotesError.validationFailed("Grouped COUNT(*) queries must select their GROUP BY fields.")
    }

    for field in group.fields {
        try requireQueryField(field, in: sourceResult)
    }

    for item in projection {
        try requireQueryField(item.field, in: sourceResult)
    }

    struct GroupBucket {
        var valuesByField: [String: String]
        var count: Int
        var firstIndex: Int
    }

    var buckets: [[String]: GroupBucket] = [:]
    for (index, row) in rows.enumerated() {
        let key = group.fields.map { row[$0] ?? "" }
        if var bucket = buckets[key] {
            bucket.count += 1
            buckets[key] = bucket
        } else {
            buckets[key] = GroupBucket(
                valuesByField: Dictionary(uniqueKeysWithValues: zip(group.fields, key)),
                count: 1,
                firstIndex: index
            )
        }
    }

    let columns = projection.map { $0.outputName } + [aggregate.outputName]
    var groupedRows = buckets.values
        .sorted { left, right in
            left.firstIndex < right.firstIndex
        }
        .map { bucket in
            var row = Dictionary(uniqueKeysWithValues: projection.map { item in
                (item.outputName, bucket.valuesByField[item.field] ?? "")
            })
            row[aggregate.outputName] = String(bucket.count)
            return row
        }

    if !query.havingPredicates.isEmpty {
        let groupedResult = QueryResult(columns: columns, rows: groupedRows)
        for predicate in query.havingPredicates {
            try requireQueryField(predicate.field, in: groupedResult)
        }
        let havingPredicateGroups = try resolvedPredicateGroups(
            query.havingPredicateGroups,
            relativeDate: relativeDate
        )
        groupedRows = filterQueryRows(groupedRows, using: havingPredicateGroups)
    }

    if let order = query.order {
        let groupedResult = QueryResult(columns: columns, rows: groupedRows)
        try requireQueryField(order.field, in: groupedResult)
        groupedRows = groupedRows
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
        groupedRows = Array(groupedRows.prefix(limit))
    }

    return QueryResult(columns: columns, rows: groupedRows)
}

private func filterQueryRows(
    _ rows: [[String: String]],
    using predicateGroups: [[ResolvedLocalQueryPredicate]]
) -> [[String: String]] {
    var filteredRows: [[String: String]] = []
    for row in rows {
        var matchesAnyPredicateGroup = false
        for predicates in predicateGroups {
            var matchesAllPredicates = true
            for predicate in predicates {
                let value = row[predicate.field] ?? ""
                let matchesPredicate: Bool
                switch predicate.operation {
                case .equals:
                    matchesPredicate = value.localizedCaseInsensitiveCompare(predicate.values[0]) == .orderedSame
                case .notEquals:
                    matchesPredicate = value.localizedCaseInsensitiveCompare(predicate.values[0]) != .orderedSame
                case .contains:
                    matchesPredicate = value.localizedCaseInsensitiveContains(predicate.values[0])
                case .notContains:
                    matchesPredicate = !value.localizedCaseInsensitiveContains(predicate.values[0])
                case .oneOf:
                    matchesPredicate = predicate.values.contains {
                        value.localizedCaseInsensitiveCompare($0) == .orderedSame
                    }
                case .notOneOf:
                    matchesPredicate = !predicate.values.contains {
                        value.localizedCaseInsensitiveCompare($0) == .orderedSame
                    }
                case .between:
                    let lowerComparison = value.localizedStandardCompare(predicate.values[0])
                    let upperComparison = value.localizedStandardCompare(predicate.values[1])
                    matchesPredicate = (lowerComparison == .orderedDescending || lowerComparison == .orderedSame) &&
                        (upperComparison == .orderedAscending || upperComparison == .orderedSame)
                case .notBetween:
                    let lowerComparison = value.localizedStandardCompare(predicate.values[0])
                    let upperComparison = value.localizedStandardCompare(predicate.values[1])
                    matchesPredicate = lowerComparison == .orderedAscending || upperComparison == .orderedDescending
                case .isEmpty:
                    matchesPredicate = value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                case .isNotEmpty:
                    matchesPredicate = !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                case .greaterThan:
                    matchesPredicate = value.localizedStandardCompare(predicate.values[0]) == .orderedDescending
                case .greaterThanOrEqual:
                    let comparison = value.localizedStandardCompare(predicate.values[0])
                    matchesPredicate = comparison == .orderedDescending || comparison == .orderedSame
                case .lessThan:
                    matchesPredicate = value.localizedStandardCompare(predicate.values[0]) == .orderedAscending
                case .lessThanOrEqual:
                    let comparison = value.localizedStandardCompare(predicate.values[0])
                    matchesPredicate = comparison == .orderedAscending || comparison == .orderedSame
                }

                if !matchesPredicate {
                    matchesAllPredicates = false
                    break
                }
            }

            if matchesAllPredicates {
                matchesAnyPredicateGroup = true
                break
            }
        }

        if matchesAnyPredicateGroup {
            filteredRows.append(row)
        }
    }

    return filteredRows
}

private func resolvedPredicateGroups(
    _ predicateGroups: [[LocalQueryPredicate]],
    relativeDate: Date
) throws -> [[ResolvedLocalQueryPredicate]] {
    try predicateGroups.map { predicates in
        try predicates.map { predicate in
            ResolvedLocalQueryPredicate(
                field: predicate.field,
                operation: predicate.operation,
                values: try queryComparisonValues(for: predicate, relativeDate: relativeDate)
            )
        }
    }
}

private func queryComparisonValues(for predicate: LocalQueryPredicate, relativeDate: Date) throws -> [String] {
    try predicate.values.map { value in
        guard predicate.field == "date" else {
            return value
        }

        if let relativeDateValue = DailyNoteDateFormatter.relativeStorageString(
            for: value,
            relativeTo: relativeDate
        ) {
            return relativeDateValue
        }

        if DailyNoteDateFormatter.isRelativeDateLiteral(value) {
            throw SQLiteNotesError.validationFailed("Invalid relative date literal '\(value)'.")
        }

        return value
    }
}

private struct ResolvedLocalQueryPredicate {
    var field: String
    var operation: LocalQueryPredicate.Operation
    var values: [String]
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

private struct LocalQueryAggregate {
    enum Kind {
        case countAll
    }

    var kind: Kind
    var outputName: String
}

private struct LocalQueryGroup {
    var fields: [String]
}

private struct LocalQuery {
    var projection: [LocalQueryProjection]?
    var aggregate: LocalQueryAggregate?
    var source: String
    var predicateGroups: [[LocalQueryPredicate]] = []
    var predicates: [LocalQueryPredicate] {
        predicateGroups.flatMap { $0 }
    }
    var group: LocalQueryGroup?
    var havingPredicateGroups: [[LocalQueryPredicate]] = []
    var havingPredicates: [LocalQueryPredicate] {
        havingPredicateGroups.flatMap { $0 }
    }
    var order: LocalQueryOrder?
    var limit: Int?

    init(_ rawQuery: String) throws {
        let trimmed = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw SQLiteNotesError.validationFailed("Query cannot be empty.")
        }

        let pattern = #"(?is)^\s*SELECT\s+(.+?)\s+FROM\s+([A-Za-z_][A-Za-z0-9_-]*)(?:\s+WHERE\s+(.+?))?(?:\s+GROUP\s+BY\s+(.+?))?(?:\s+HAVING\s+(.+?))?(?:\s+ORDER\s+BY\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+([0-9]+))?\s*;?\s*$"#
        guard let match = trimmed.firstMatch(pattern: pattern) else {
            throw SQLiteNotesError.validationFailed("Only SELECT * or SELECT <field[, ...]> FROM <source> queries are supported.")
        }

        guard let rawProjection = match[1], let sourceName = match[2] else {
            throw SQLiteNotesError.validationFailed("Query source is missing.")
        }

        let selection = try Self.parseSelection(rawProjection)
        projection = selection.projection
        aggregate = selection.aggregate
        source = sourceName.lowercased()
        if match.indices.contains(3), let whereClause = match[3], !whereClause.isEmpty {
            predicateGroups = try Self.parsePredicateGroups(whereClause)
        }

        if match.indices.contains(4), let groupClause = match[4], !groupClause.isEmpty {
            group = LocalQueryGroup(fields: try Self.parseGroupFields(groupClause))
        }

        if match.indices.contains(5), let havingClause = match[5], !havingClause.isEmpty {
            havingPredicateGroups = try Self.parsePredicateGroups(havingClause)
        }

        if match.indices.contains(6), let orderField = match[6], !orderField.isEmpty {
            let direction: LocalQueryOrder.Direction = (match[7] ?? "")
                .caseInsensitiveCompare("DESC") == .orderedSame ? .descending : .ascending
            order = LocalQueryOrder(field: orderField.lowercased(), direction: direction)
        }

        if match.indices.contains(8), let rawLimit = match[8], !rawLimit.isEmpty {
            guard let parsedLimit = Int(rawLimit), parsedLimit >= 0 else {
                throw SQLiteNotesError.validationFailed("Query limit must be a non-negative integer.")
            }
            limit = parsedLimit
        }

        if let group {
            guard aggregate != nil else {
                throw SQLiteNotesError.validationFailed("GROUP BY currently supports COUNT(*) queries only.")
            }
            guard let projection, !projection.isEmpty else {
                throw SQLiteNotesError.validationFailed("Grouped COUNT(*) queries must select their GROUP BY fields.")
            }

            let projectionFields = Set(projection.map(\.field))
            let groupFields = Set(group.fields)
            guard projectionFields == groupFields, projectionFields.count == projection.count else {
                throw SQLiteNotesError.validationFailed(
                    "Grouped COUNT(*) query projections must match GROUP BY fields."
                )
            }
        } else if !havingPredicates.isEmpty {
            throw SQLiteNotesError.validationFailed("HAVING is only supported with grouped COUNT(*) queries.")
        }

        if aggregate != nil, group == nil, projection != nil {
            throw SQLiteNotesError.validationFailed("COUNT(*) with selected fields requires GROUP BY.")
        }

        if aggregate != nil, group == nil, order != nil || limit != nil {
            throw SQLiteNotesError.validationFailed("ORDER BY and LIMIT are not supported with COUNT(*) queries.")
        }
    }

    private static func parseSelection(
        _ rawSelection: String
    ) throws -> (projection: [LocalQueryProjection]?, aggregate: LocalQueryAggregate?) {
        let trimmed = rawSelection.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw SQLiteNotesError.validationFailed("Query projection is missing.")
        }

        if trimmed == "*" {
            return (nil, nil)
        }

        let rawFields = trimmed
            .split(separator: ",", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }

        var projection: [LocalQueryProjection] = []
        var aggregate: LocalQueryAggregate?
        var seenOutputNames: Set<String> = []
        for (index, rawField) in rawFields.enumerated() {
            if let item = try parseAggregate(rawField) {
                guard index == rawFields.count - 1 else {
                    throw SQLiteNotesError.validationFailed("COUNT(*) must be the final selected field.")
                }
                guard aggregate == nil else {
                    throw SQLiteNotesError.validationFailed("Only one COUNT(*) aggregate is supported.")
                }
                guard seenOutputNames.insert(item.outputName).inserted else {
                    throw SQLiteNotesError.validationFailed(
                        "Query projection contains duplicate output field '\(item.outputName)'."
                    )
                }
                aggregate = item
                continue
            }

            let item = try parseProjectionItem(rawField)
            guard seenOutputNames.insert(item.outputName).inserted else {
                throw SQLiteNotesError.validationFailed(
                    "Query projection contains duplicate output field '\(item.outputName)'."
                )
            }
            projection.append(item)
        }

        return (projection.isEmpty ? nil : projection, aggregate)
    }

    private static func parseAggregate(_ rawSelection: String) throws -> LocalQueryAggregate? {
        guard rawSelection.firstMatch(pattern: #"(?is)^\s*COUNT\s*\("#) != nil else {
            return nil
        }

        let pattern = #"(?is)^\s*COUNT\s*\(\s*\*\s*\)(?:\s+AS\s+([A-Za-z_][A-Za-z0-9_]*))?\s*$"#
        guard let match = rawSelection.firstMatch(pattern: pattern) else {
            throw SQLiteNotesError.validationFailed("Only COUNT(*) with an optional AS alias is supported.")
        }

        return LocalQueryAggregate(
            kind: .countAll,
            outputName: (match[1] ?? "count").lowercased()
        )
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

    private static func parseGroupFields(_ rawGroupClause: String) throws -> [String] {
        let rawFields = rawGroupClause
            .split(separator: ",", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }

        var fields: [String] = []
        var seenFields: Set<String> = []
        for rawField in rawFields {
            let pattern = #"(?is)^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$"#
            guard let match = rawField.firstMatch(pattern: pattern),
                  let field = match[1] else {
                throw SQLiteNotesError.validationFailed(
                    "Only comma-separated GROUP BY field names are supported."
                )
            }

            let normalizedField = field.lowercased()
            guard seenFields.insert(normalizedField).inserted else {
                throw SQLiteNotesError.validationFailed(
                    "GROUP BY contains duplicate field '\(normalizedField)'."
                )
            }
            fields.append(normalizedField)
        }

        guard !fields.isEmpty else {
            throw SQLiteNotesError.validationFailed("GROUP BY field is missing.")
        }

        return fields
    }

    private static func parsePredicateGroups(_ rawWhereClause: String) throws -> [[LocalQueryPredicate]] {
        let disjunctions = try splitLogicalClauses(in: rawWhereClause, keyword: "OR")
        guard !disjunctions.isEmpty else {
            throw SQLiteNotesError.validationFailed("Query filter is missing.")
        }

        return try disjunctions.map { disjunction in
            let conjunctions = try splitLogicalClauses(in: disjunction, keyword: "AND")
            guard !conjunctions.isEmpty else {
                throw SQLiteNotesError.validationFailed("Query filter is missing.")
            }

            return try conjunctions.map { try LocalQueryPredicate($0) }
        }
    }

    private static func splitLogicalClauses(in text: String, keyword: String) throws -> [String] {
        var clauses: [String] = []
        var current = ""
        var quotedBy: Character?
        var parenthesisDepth = 0
        var index = text.startIndex

        while index < text.endIndex {
            let character = text[index]

            if character == "'" || character == "\"" {
                if quotedBy == nil {
                    quotedBy = character
                } else if quotedBy == character {
                    quotedBy = nil
                }
                current.append(character)
                index = text.index(after: index)
                continue
            }

            if quotedBy == nil {
                if character == "(" {
                    parenthesisDepth += 1
                    current.append(character)
                    index = text.index(after: index)
                    continue
                }

                if character == ")" {
                    parenthesisDepth -= 1
                    guard parenthesisDepth >= 0 else {
                        throw SQLiteNotesError.validationFailed("Query filter contains unbalanced parentheses.")
                    }
                    current.append(character)
                    index = text.index(after: index)
                    continue
                }
            }

            if quotedBy == nil, parenthesisDepth == 0, isStandaloneKeyword(keyword, in: text, at: index) {
                if keyword.caseInsensitiveCompare("AND") == .orderedSame,
                   isBetweenLowerBoundPrefix(current) {
                    current.append(contentsOf: text[index..<text.index(index, offsetBy: keyword.count)])
                    index = text.index(index, offsetBy: keyword.count)
                    continue
                }

                let clause = current.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !clause.isEmpty else {
                    throw SQLiteNotesError.validationFailed("Query filter is incomplete.")
                }
                clauses.append(clause)
                current = ""
                index = text.index(index, offsetBy: keyword.count)
                continue
            }

            current.append(character)
            index = text.index(after: index)
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

    private static func isBetweenLowerBoundPrefix(_ text: String) -> Bool {
        let valuePattern = #"('([^']*)'|"([^"]*)"|[A-Za-z0-9_.:+-]+)"#
        let pattern = #"(?is)^\s*[A-Za-z_][A-Za-z0-9_]*\s+(?:NOT\s+)?BETWEEN\s+\#(valuePattern)\s*$"#
        return text.firstMatch(pattern: pattern) != nil
    }

    private static func isQueryWordCharacter(_ character: Character) -> Bool {
        "_-.:+".contains(character) || character.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0)
        }
    }
}

private struct LocalQueryPredicate {
    enum Operation {
        case equals
        case notEquals
        case contains
        case notContains
        case oneOf
        case notOneOf
        case between
        case notBetween
        case isEmpty
        case isNotEmpty
        case greaterThan
        case greaterThanOrEqual
        case lessThan
        case lessThanOrEqual
    }

    var field: String
    var operation: Operation
    var values: [String]

    init(_ whereClause: String) throws {
        let betweenPattern = #"(?is)^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(NOT\s+BETWEEN|BETWEEN)\s+(.+)\s*$"#
        if let match = whereClause.firstMatch(pattern: betweenPattern),
           let fieldName = match[1],
           let operationName = match[2],
           let rawBounds = match[3] {
            let (lowerBound, upperBound) = try Self.splitBetweenBounds(in: rawBounds)
            field = fieldName.lowercased()
            operation = try Self.parseOperation(operationName)
            values = [try Self.parseValue(lowerBound), try Self.parseValue(upperBound)]
            return
        }

        let emptyPattern = #"(?is)^\s*([A-Za-z_][A-Za-z0-9_]*)\s+IS\s+(NOT\s+)?EMPTY\s*$"#
        if let match = whereClause.firstMatch(pattern: emptyPattern),
           let fieldName = match[1] {
            field = fieldName.lowercased()
            operation = try Self.parseOperation(match[2] == nil ? "IS EMPTY" : "IS NOT EMPTY")
            values = []
            return
        }

        let inPattern = #"(?is)^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(NOT\s+IN|IN)\s*\((.*)\)\s*$"#
        if let match = whereClause.firstMatch(pattern: inPattern),
           let fieldName = match[1],
           let operationName = match[2] {
            field = fieldName.lowercased()
            operation = try Self.parseOperation(operationName)
            values = try Self.parseValueList(match[3] ?? "")
            return
        }

        let pattern = #"(?is)^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|!=|=|>|<|NOT\s+CONTAINS|CONTAINS)\s*(.+)\s*$"#
        guard let match = whereClause.firstMatch(pattern: pattern),
              let fieldName = match[1],
              let operationName = match[2],
              let rawValue = match[3] else {
            throw SQLiteNotesError.validationFailed(
                "Only WHERE <field> = value, negated filters, WHERE <field> CONTAINS value, WHERE <field> IN (value, ...), BETWEEN ranges, empty checks, and ordered comparisons are supported."
            )
        }

        field = fieldName.lowercased()
        operation = try Self.parseOperation(operationName)
        values = [try Self.parseValue(rawValue)]
    }

    private static func parseOperation(_ rawOperation: String) throws -> Operation {
        let normalizedOperation = rawOperation
            .uppercased()
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")

        switch normalizedOperation {
        case "=":
            return .equals
        case "!=":
            return .notEquals
        case "CONTAINS":
            return .contains
        case "NOT CONTAINS":
            return .notContains
        case "IN":
            return .oneOf
        case "NOT IN":
            return .notOneOf
        case "BETWEEN":
            return .between
        case "NOT BETWEEN":
            return .notBetween
        case "IS EMPTY":
            return .isEmpty
        case "IS NOT EMPTY":
            return .isNotEmpty
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
        let pattern = #"(?is)^\s*('([^']*)'|"([^"]*)"|([A-Za-z0-9_.:+-]+))\s*$"#
        guard let match = rawValue.firstMatch(pattern: pattern) else {
            throw SQLiteNotesError.validationFailed("Query filter value is invalid.")
        }

        let value = (match[2] ?? match[3] ?? match[4] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            throw SQLiteNotesError.validationFailed("Query filter value cannot be empty.")
        }

        return value
    }

    private static func splitBetweenBounds(in rawBounds: String) throws -> (String, String) {
        var quotedBy: Character?
        var index = rawBounds.startIndex

        while index < rawBounds.endIndex {
            let character = rawBounds[index]

            if character == "'" || character == "\"" {
                if quotedBy == nil {
                    quotedBy = character
                } else if quotedBy == character {
                    quotedBy = nil
                }
                index = rawBounds.index(after: index)
                continue
            }

            if quotedBy == nil, isStandaloneKeyword("AND", in: rawBounds, at: index) {
                let lowerBound = rawBounds[..<index].trimmingCharacters(in: .whitespacesAndNewlines)
                let upperStart = rawBounds.index(index, offsetBy: "AND".count)
                let upperBound = rawBounds[upperStart...].trimmingCharacters(in: .whitespacesAndNewlines)
                guard !lowerBound.isEmpty, !upperBound.isEmpty else {
                    throw SQLiteNotesError.validationFailed("Query BETWEEN bounds cannot be empty.")
                }
                return (lowerBound, upperBound)
            }

            index = rawBounds.index(after: index)
        }

        guard quotedBy == nil else {
            throw SQLiteNotesError.validationFailed("Query filter contains an unterminated quoted value.")
        }

        throw SQLiteNotesError.validationFailed("Query BETWEEN filter must include lower and upper bounds.")
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
        "_-.:+".contains(character) || character.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0)
        }
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
