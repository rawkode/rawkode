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

    func testDailyNoteDisplayTitleNamesTomorrow() throws {
        let tomorrow = try XCTUnwrap(
            Calendar(identifier: .gregorian).date(byAdding: .day, value: 1, to: .now)
        )
        let storageDate = DailyNoteDateFormatter.storageString(from: tomorrow)

        XCTAssertEqual(DailyNoteDateFormatter.displayTitle(for: storageDate), "Tomorrow")
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

    func testSavedQueryViewsPersistAcrossRepositoryInstances() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let savedView = try repository.saveSavedQueryView(
            named: "  Active Bookmarks  ",
            query: " SELECT name, status FROM bookmarks WHERE status = active ",
            view: "board",
            groupBy: " Status "
        )

        XCTAssertEqual(savedView.name, "Active Bookmarks")
        XCTAssertEqual(savedView.query, "SELECT name, status FROM bookmarks WHERE status = active")
        XCTAssertEqual(savedView.view, "board")
        XCTAssertEqual(savedView.groupBy, "status")
        XCTAssertEqual(savedView.sortOrder, 0)

        let updatedView = try repository.saveSavedQueryView(
            named: "active bookmarks",
            query: "SELECT name FROM bookmarks WHERE status = archived",
            view: "list"
        )

        XCTAssertEqual(updatedView.id, savedView.id)
        XCTAssertEqual(try repository.fetchSavedQueryViews().count, 1)

        let reopenedRepository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let reopenedView = try XCTUnwrap(reopenedRepository.fetchSavedQueryView(id: savedView.id))

        XCTAssertEqual(reopenedView.name, "active bookmarks")
        XCTAssertEqual(reopenedView.query, "SELECT name FROM bookmarks WHERE status = archived")
        XCTAssertEqual(reopenedView.view, "list")
        XCTAssertNil(reopenedView.groupBy)
        XCTAssertEqual(reopenedView.sortOrder, 0)
        XCTAssertLessThan(abs(reopenedView.createdAt.timeIntervalSince(savedView.createdAt)), 1)
    }

    func testSavedQueryViewsCanBeEditedDuplicatedAndReordered() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let dailyView = try repository.saveSavedQueryView(
            named: "Daily Notes",
            query: "SELECT date, title FROM daily_notes",
            view: "table"
        )
        let projectView = try repository.saveSavedQueryView(
            named: "Projects",
            query: "SELECT name FROM projects",
            view: "list"
        )

        let updatedProjectView = try repository.updateSavedQueryView(
            id: projectView.id,
            named: "Project Board",
            query: "SELECT name, status FROM projects WHERE status != archived",
            view: "board",
            groupBy: "status"
        )

        XCTAssertEqual(updatedProjectView.id, projectView.id)
        XCTAssertEqual(updatedProjectView.name, "Project Board")
        XCTAssertEqual(updatedProjectView.view, "board")
        XCTAssertEqual(updatedProjectView.groupBy, "status")
        XCTAssertEqual(updatedProjectView.sortOrder, 1)

        XCTAssertThrowsError(
            try repository.updateSavedQueryView(
                id: dailyView.id,
                named: "Project Board",
                query: "SELECT date FROM daily_notes",
                view: "table"
            )
        )

        let firstCopy = try repository.duplicateSavedQueryView(id: updatedProjectView.id)
        let secondCopy = try repository.duplicateSavedQueryView(id: updatedProjectView.id)

        XCTAssertNotEqual(firstCopy.id, updatedProjectView.id)
        XCTAssertEqual(firstCopy.name, "Project Board Copy")
        XCTAssertEqual(secondCopy.name, "Project Board Copy 2")
        XCTAssertEqual(firstCopy.query, updatedProjectView.query)
        XCTAssertEqual(firstCopy.view, updatedProjectView.view)
        XCTAssertEqual(firstCopy.groupBy, updatedProjectView.groupBy)

        XCTAssertThrowsError(
            try repository.reorderSavedQueryViews(ids: [
                secondCopy.id,
                dailyView.id,
                firstCopy.id,
            ])
        )
        XCTAssertThrowsError(
            try repository.reorderSavedQueryViews(ids: [
                secondCopy.id,
                dailyView.id,
                firstCopy.id,
                firstCopy.id,
            ])
        )

        try repository.reorderSavedQueryViews(ids: [
            secondCopy.id,
            dailyView.id,
            firstCopy.id,
            updatedProjectView.id,
        ])

        let reorderedViews = try repository.fetchSavedQueryViews()
        XCTAssertEqual(reorderedViews.map(\.id), [
            secondCopy.id,
            dailyView.id,
            firstCopy.id,
            updatedProjectView.id,
        ])
        XCTAssertEqual(reorderedViews.map(\.sortOrder), [0, 1, 2, 3])

        let reopenedRepository = try SQLiteNotesRepository(databaseURL: databaseURL)
        XCTAssertEqual(try reopenedRepository.fetchSavedQueryViews().map(\.id), [
            secondCopy.id,
            dailyView.id,
            firstCopy.id,
            updatedProjectView.id,
        ])

        try repository.deleteSavedQueryView(id: dailyView.id)
        let compactedViews = try repository.fetchSavedQueryViews()

        XCTAssertEqual(compactedViews.map(\.id), [
            secondCopy.id,
            firstCopy.id,
            updatedProjectView.id,
        ])
        XCTAssertEqual(compactedViews.map(\.sortOrder), [0, 1, 2])
    }

    func testSavedQueryViewSortOrderBackfillsLegacyRows() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let alphaID = UUID()
        let bravoID = UUID()
        let charlieID = UUID()
        let now = Date().ISO8601Format()
        try executeRawSQL(
            """
            CREATE TABLE saved_query_views (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                query TEXT NOT NULL,
                view TEXT NOT NULL CHECK (view IN ('table', 'list', 'board')),
                group_by TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            INSERT INTO saved_query_views (
                id, name, query, view, group_by, created_at, updated_at
            ) VALUES
                ('\(bravoID.uuidString)', 'Bravo', 'SELECT * FROM daily_notes', 'table', NULL, '\(now)', '\(now)'),
                ('\(charlieID.uuidString)', 'Charlie', 'SELECT * FROM daily_notes', 'table', NULL, '\(now)', '\(now)'),
                ('\(alphaID.uuidString)', 'Alpha', 'SELECT * FROM daily_notes', 'table', NULL, '\(now)', '\(now)');
            """,
            databaseURL: databaseURL,
            createIfNeeded: true
        )

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let migratedViews = try repository.fetchSavedQueryViews()

        XCTAssertEqual(migratedViews.map(\.id), [alphaID, bravoID, charlieID])
        XCTAssertEqual(migratedViews.map(\.sortOrder), [0, 1, 2])

        let duplicateView = try repository.duplicateSavedQueryView(id: alphaID)
        XCTAssertEqual(duplicateView.sortOrder, 3)

        let reopenedRepository = try SQLiteNotesRepository(databaseURL: databaseURL)
        XCTAssertEqual(try reopenedRepository.fetchSavedQueryViews().map(\.sortOrder), [0, 1, 2, 3])
    }

    func testSavedQueryViewsAreQueryable() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(named: "Visual Index", supertagNames: ["views"])
        _ = try repository.saveSavedQueryView(
            named: "Active Bookmarks",
            query: "SELECT name, status FROM bookmarks WHERE status = active",
            view: "board",
            groupBy: "status"
        )
        _ = try repository.saveSavedQueryView(
            named: "Recent Daily Notes",
            query: "SELECT date, title FROM daily_notes ORDER BY date DESC LIMIT 7",
            view: "table"
        )

        let result = try repository.runQuery(
            "SELECT name, view, group_by, sort_order FROM saved_views WHERE view = board"
        )

        XCTAssertEqual(result.columns, ["name", "view", "group_by", "sort_order"])
        XCTAssertEqual(result.rows, [
            [
                "name": "Active Bookmarks",
                "view": "board",
                "group_by": "status",
                "sort_order": "0",
            ],
        ])

        let supertagCollection = try repository.runQuery("SELECT name FROM views")
        XCTAssertEqual(visibleQueryRows(supertagCollection.rows), [["name": "Visual Index"]])
    }

    func testSavedQueryViewsRejectInvalidDefinitions() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)

        XCTAssertThrowsError(
            try repository.saveSavedQueryView(named: " ", query: "SELECT * FROM bookmarks")
        )
        XCTAssertThrowsError(
            try repository.saveSavedQueryView(named: "Broken", query: "DELETE FROM bookmarks")
        )
        XCTAssertThrowsError(
            try repository.saveSavedQueryView(
                named: "Broken Mode",
                query: "SELECT * FROM bookmarks",
                view: "calendar"
            )
        )
        XCTAssertTrue(try repository.fetchSavedQueryViews().isEmpty)
    }

    func testSupertagFieldDefinitionsPersistAcrossRepositoryInstances() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let status = try repository.saveSupertagFieldDefinition(
            supertagName: "  #Project  ",
            field: " Status ",
            valueType: try SupertagFieldValueType(normalizing: "String"),
            defaultValue: " active ",
            isRequired: true,
            sortOrder: 2
        )

        XCTAssertEqual(status.supertagName, "Project")
        XCTAssertEqual(status.supertagSlug, "project")
        XCTAssertEqual(status.key, "status")
        XCTAssertEqual(status.label, "Status")
        XCTAssertEqual(status.valueType, .text)
        XCTAssertEqual(status.defaultValue, "active")
        XCTAssertTrue(status.isRequired)
        XCTAssertEqual(status.sortOrder, 2)

        let updatedStatus = try repository.saveSupertagFieldDefinition(
            supertagName: "project",
            field: "status",
            valueType: try SupertagFieldValueType(normalizing: "checkbox"),
            isRequired: false,
            sortOrder: 1
        )

        XCTAssertEqual(updatedStatus.id, status.id)
        XCTAssertEqual(updatedStatus.valueType, .boolean)
        XCTAssertNil(updatedStatus.defaultValue)
        XCTAssertFalse(updatedStatus.isRequired)
        XCTAssertEqual(try repository.fetchSupertagFieldDefinitions(supertagName: "PROJECT").count, 1)

        let updatedAt = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Updated At",
            valueType: .date,
            sortOrder: 3
        )

        XCTAssertEqual(updatedAt.key, "property_updated_at")

        let largeSortOrder = Int(Int32.max) + 1
        let rank = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Rank",
            valueType: .number,
            sortOrder: largeSortOrder
        )

        XCTAssertEqual(rank.sortOrder, largeSortOrder)

        let reopenedRepository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let reopenedFields = try reopenedRepository.fetchSupertagFieldDefinitions(supertagName: "#project")

        XCTAssertEqual(reopenedFields.map(\.key), ["status", "property_updated_at", "rank"])
        XCTAssertEqual(reopenedFields.first?.id, status.id)
        XCTAssertEqual(reopenedFields.last?.sortOrder, largeSortOrder)
    }

    func testSupertagFieldDefinitionsAreQueryable() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Status",
            valueType: .text,
            defaultValue: "active",
            isRequired: true,
            sortOrder: 1
        )
        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Owner",
            valueType: .entity,
            sortOrder: 2
        )

        let result = try repository.runQuery(
            "SELECT supertag, field, type, default_value, required FROM supertag_fields WHERE supertag = project ORDER BY sort_order"
        )

        XCTAssertEqual(result.columns, ["supertag", "field", "type", "default_value", "required"])
        XCTAssertEqual(result.rows, [
            [
                "supertag": "Project",
                "field": "status",
                "type": "text",
                "default_value": "active",
                "required": "true",
            ],
            [
                "supertag": "Project",
                "field": "owner",
                "type": "entity",
                "default_value": "",
                "required": "false",
            ],
        ])
    }

    func testSupertagSchemasExposeTypedFieldsAndEmptyAppliedTags() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(
            named: "Swift Article",
            supertagNames: ["Bookmark"],
            properties: [:]
        )
        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Status",
            valueType: .text,
            defaultValue: "active",
            isRequired: true,
            sortOrder: 1
        )
        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Owner",
            valueType: .entity,
            sortOrder: 2
        )

        let schemas = try repository.fetchSupertagSchemas()

        XCTAssertEqual(schemas.map(\.name), ["Bookmark", "Project"])
        XCTAssertTrue(try XCTUnwrap(schemas.first { $0.name == "Bookmark" }).fields.isEmpty)

        let project = try XCTUnwrap(schemas.first { $0.name == "Project" })
        XCTAssertEqual(project.slug, "project")
        XCTAssertEqual(project.fieldCount, 2)
        XCTAssertEqual(project.requiredFieldCount, 1)
        XCTAssertEqual(project.fields.map(\.key), ["status", "owner"])
        XCTAssertEqual(project.fields.map(\.valueType), [.text, .entity])
        XCTAssertEqual(project.fields.first?.defaultValue, "active")
    }

    func testSupertagFieldDefinitionsCanBeUpdatedByID() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let status = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Status",
            valueType: .text,
            defaultValue: "active",
            isRequired: true,
            sortOrder: 1
        )
        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Owner",
            valueType: .entity,
            sortOrder: 2
        )

        let updated = try repository.updateSupertagFieldDefinition(
            id: status.id,
            field: "State",
            valueType: .boolean,
            defaultValue: "false",
            isRequired: false,
            sortOrder: 3
        )

        XCTAssertEqual(updated.id, status.id)
        XCTAssertEqual(updated.key, "state")
        XCTAssertEqual(updated.label, "State")
        XCTAssertEqual(updated.valueType, .boolean)
        XCTAssertEqual(updated.defaultValue, "false")
        XCTAssertFalse(updated.isRequired)
        XCTAssertEqual(
            updated.createdAt.timeIntervalSince1970,
            status.createdAt.timeIntervalSince1970,
            accuracy: 1
        )
        XCTAssertGreaterThan(updated.updatedAt, status.updatedAt)

        let fields = try repository.fetchSupertagFieldDefinitions(supertagName: "Project")
        XCTAssertEqual(fields.map(\.key), ["owner", "state"])

        XCTAssertThrowsError(
            try repository.updateSupertagFieldDefinition(
                id: status.id,
                field: "Owner",
                valueType: .text
            )
        )
    }

    func testSupertagFieldDefinitionUpdatesMigrateExistingPropertyKeys() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let status = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Status",
            valueType: .text
        )
        _ = try repository.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: ["Status": "active"]
        )

        let updated = try repository.updateSupertagFieldDefinition(
            id: status.id,
            field: "State",
            valueType: .text
        )

        XCTAssertEqual(updated.key, "state")
        XCTAssertEqual(updated.label, "State")

        let entity = try repository.upsertEntity(named: "Notes Roadmap", supertagNames: ["project"])
        XCTAssertEqual(entity.properties["state"], "active")
        XCTAssertNil(entity.properties["status"])
    }

    func testSupertagFieldDefinitionRenamesRejectSharedPropertyKeysAcrossSupertags() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let projectStatus = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Status",
            valueType: .text
        )
        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Bookmark",
            field: "Status",
            valueType: .text
        )
        _ = try repository.upsertEntity(
            named: "Swift Article",
            supertagNames: ["project", "bookmark"],
            properties: ["Status": "active"]
        )

        XCTAssertThrowsError(
            try repository.updateSupertagFieldDefinition(
                id: projectStatus.id,
                field: "State",
                valueType: .text
            )
        )

        let fields = try repository.fetchSupertagFieldDefinitions(supertagName: "Project")
        XCTAssertEqual(fields.map(\.key), ["status"])

        let entity = try repository.upsertEntity(named: "Swift Article", supertagNames: ["project", "bookmark"])
        XCTAssertEqual(entity.properties["status"], "active")
        XCTAssertNil(entity.properties["state"])
    }

    func testSupertagFieldDefinitionUpdatesRejectIncompatibleExistingValues() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let status = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Status",
            valueType: .text
        )
        _ = try repository.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: ["Status": "active"]
        )

        XCTAssertThrowsError(
            try repository.updateSupertagFieldDefinition(
                id: status.id,
                field: "Status",
                valueType: .number
            )
        )
        XCTAssertThrowsError(
            try repository.saveSupertagFieldDefinition(
                supertagName: "Project",
                field: "Status",
                valueType: .number
            )
        )

        let field = try XCTUnwrap(repository.fetchSupertagFieldDefinitions(supertagName: "Project").first)
        XCTAssertEqual(field.valueType, .text)

        let entity = try repository.upsertEntity(named: "Notes Roadmap", supertagNames: ["project"])
        XCTAssertEqual(entity.properties["status"], "active")
    }

    func testSupertagFieldDefinitionsValidateAndBackfillExistingTaggedEntities() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(named: "Notes Roadmap", supertagNames: ["project"])

        XCTAssertThrowsError(
            try repository.saveSupertagFieldDefinition(
                supertagName: "Project",
                field: "Rank",
                valueType: .number,
                isRequired: true
            )
        )

        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Rank",
            valueType: .number,
            defaultValue: "1",
            isRequired: true
        )

        let entity = try repository.upsertEntity(named: "Notes Roadmap", supertagNames: ["project"])
        XCTAssertEqual(entity.properties["rank"], "1")
    }

    func testSupertagFieldDefinitionsRejectInvalidDefinitions() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)

        XCTAssertThrowsError(
            try repository.saveSupertagFieldDefinition(supertagName: " ", field: "Status")
        )
        XCTAssertThrowsError(
            try repository.saveSupertagFieldDefinition(supertagName: "Project", field: " ")
        )
        XCTAssertThrowsError(try SupertagFieldValueType(normalizing: "money"))
        XCTAssertThrowsError(
            try repository.saveSupertagFieldDefinition(
                supertagName: "Project",
                field: "Status",
                sortOrder: -1
            )
        )
        XCTAssertThrowsError(
            try repository.saveSupertagFieldDefinition(
                supertagName: "Project",
                field: "Rank",
                valueType: .number,
                defaultValue: "high"
            )
        )
        XCTAssertThrowsError(
            try repository.saveSupertagFieldDefinition(
                supertagName: "Project",
                field: "Owner",
                valueType: .entity,
                defaultValue: "Rawkode Academy"
            )
        )
        XCTAssertTrue(try repository.fetchSupertagFieldDefinitions().isEmpty)
    }

    func testSupertagFieldDefinitionsApplyDefaultsAndValidateEntityUpserts() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Status",
            valueType: .text,
            defaultValue: "active",
            isRequired: true
        )
        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Rank",
            valueType: .number,
            isRequired: true
        )
        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Due Date",
            valueType: .date
        )
        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Owner",
            valueType: .entity
        )
        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Done",
            valueType: .boolean,
            defaultValue: "false"
        )

        let project = try repository.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: [
                "Rank": "7",
                "Due Date": "2026-06-17",
                "Owner": "[[Rawkode Academy]]",
            ]
        )

        XCTAssertEqual(project.properties["status"], "active")
        XCTAssertEqual(project.properties["rank"], "7")
        XCTAssertEqual(project.properties["due_date"], "2026-06-17")
        XCTAssertEqual(project.properties["owner"], "Rawkode Academy")
        XCTAssertEqual(project.properties["done"], "false")

        let projects = try repository.runQuery(
            "SELECT name, status, rank, due_date, owner, owner_entity_id, done FROM projects"
        )
        XCTAssertEqual(projects.rows.first?["name"], "Notes Roadmap")
        XCTAssertEqual(projects.rows.first?["status"], "active")
        XCTAssertEqual(projects.rows.first?["rank"], "7")
        XCTAssertEqual(projects.rows.first?["due_date"], "2026-06-17")
        XCTAssertEqual(projects.rows.first?["owner"], "Rawkode Academy")
        XCTAssertFalse(projects.rows.first?["owner_entity_id"]?.isEmpty ?? true)
        XCTAssertEqual(projects.rows.first?["done"], "false")

        XCTAssertThrowsError(
            try repository.upsertEntity(
                named: "Missing Rank",
                supertagNames: ["project"]
            )
        )
        XCTAssertEqual(
            try countRows("entities", matching: "canonical_name = 'Missing Rank'", databaseURL: databaseURL),
            0
        )

        XCTAssertThrowsError(
            try repository.upsertEntity(
                named: "Bad Rank",
                supertagNames: ["project"],
                properties: ["Rank": "high"]
            )
        )
        XCTAssertEqual(
            try countRows("entities", matching: "canonical_name = 'Bad Rank'", databaseURL: databaseURL),
            0
        )
    }

    func testPlainTextMentionsApplySupertagSchemaDefaults() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Status",
            valueType: .text,
            defaultValue: "active",
            isRequired: true
        )

        var document = try repository.createStandaloneNote()
        document.title = "Project capture"
        document.plainText = "[[Notes Roadmap]] #project"
        try repository.upsertDocument(document)

        let projects = try repository.runQuery("SELECT name, status FROM projects")
        XCTAssertEqual(visibleQueryRows(projects.rows), [
            ["name": "Notes Roadmap", "status": "active"],
        ])
    }

    func testPlainTextMentionsRejectSupertagSchemaViolations() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Rank",
            valueType: .number,
            isRequired: true
        )

        var document = try repository.createStandaloneNote()
        let originalTitle = document.title
        document.title = "Invalid project capture"
        document.plainText = """
        [[Notes Roadmap]] #project
        rank:: high
        """

        XCTAssertThrowsError(try repository.upsertDocument(document))

        let storedDocument = try XCTUnwrap(repository.fetchDocument(id: document.id))
        XCTAssertEqual(storedDocument.title, originalTitle)
        XCTAssertEqual(storedDocument.plainText, "")
        XCTAssertEqual(
            try countRows("entities", matching: "canonical_name = 'Notes Roadmap'", databaseURL: databaseURL),
            0
        )
    }

    func testVaultSnapshotJSONExportsAndImportsLocalData() throws {
        let sourceDatabaseURL = try temporaryDatabaseURL()
        let importedDatabaseURL = try temporaryDatabaseURL()
        defer {
            removeTemporaryDatabase(at: sourceDatabaseURL)
            removeTemporaryDatabase(at: importedDatabaseURL)
        }

        let sourceRepository = try SQLiteNotesRepository(databaseURL: sourceDatabaseURL)
        var dailyNote = try sourceRepository.createDailyNote(date: "2026-06-17")
        dailyNote.title = "Daily field notes"
        dailyNote.plainText = "Daily capture for [[Notes Roadmap]]."
        try sourceRepository.upsertDocument(dailyNote)

        _ = try sourceRepository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Status",
            valueType: .text,
            defaultValue: "active",
            isRequired: true,
            sortOrder: 1
        )
        _ = try sourceRepository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Owner",
            valueType: .entity,
            sortOrder: 2
        )
        _ = try sourceRepository.upsertEntity(named: "Rawkode Academy", supertagNames: ["company"])
        _ = try sourceRepository.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: ["Owner": "[[Rawkode Academy]]"]
        )

        var note = try sourceRepository.createStandaloneNote()
        note.title = "Project capture"
        note.plainText = """
        [[Notes Roadmap]] #project
        owner:: [[Rawkode Academy]]
        """
        try sourceRepository.upsertDocument(note)

        let openProjectsView = try sourceRepository.saveSavedQueryView(
            named: "Open Projects",
            query: "SELECT name, status, owner FROM projects WHERE status = active",
            view: "board",
            groupBy: "status"
        )
        let recentDailyNotesView = try sourceRepository.saveSavedQueryView(
            named: "Recent Daily Notes",
            query: "SELECT date, title FROM daily_notes ORDER BY date DESC LIMIT 7",
            view: "table"
        )
        try sourceRepository.reorderSavedQueryViews(ids: [
            recentDailyNotesView.id,
            openProjectsView.id,
        ])

        let exportedJSON = try sourceRepository.exportVaultJSON()
        XCTAssertGreaterThan(exportedJSON.count, 0)

        let importedRepository = try SQLiteNotesRepository(databaseURL: importedDatabaseURL)
        _ = try importedRepository.upsertEntity(named: "Junk Entity", supertagNames: ["junk"])
        try importedRepository.importVaultJSON(exportedJSON)

        XCTAssertEqual(try importedRepository.fetchDocuments(kind: .daily).map(\.title), ["Daily field notes"])
        XCTAssertEqual(try importedRepository.fetchDocuments(kind: .note).map(\.title), ["Project capture"])
        XCTAssertEqual(try importedRepository.fetchSavedQueryViews().map(\.name), [
            "Recent Daily Notes",
            "Open Projects",
        ])
        XCTAssertEqual(try importedRepository.fetchSavedQueryViews().map(\.sortOrder), [0, 1])
        XCTAssertEqual(try importedRepository.fetchSupertagFieldDefinitions(supertagName: "project").map(\.key), [
            "status",
            "owner",
        ])

        let projects = try importedRepository.runQuery(
            "SELECT name, status, owner, owner_entity_id FROM projects"
        )
        XCTAssertEqual(projects.rows.first?["name"], "Notes Roadmap")
        XCTAssertEqual(projects.rows.first?["status"], "active")
        XCTAssertEqual(projects.rows.first?["owner"], "Rawkode Academy")
        XCTAssertFalse(projects.rows.first?["owner_entity_id"]?.isEmpty ?? true)

        let backlinks = try importedRepository.runQuery(
            "SELECT entity, document FROM backlinks WHERE entity = 'Notes Roadmap' ORDER BY document ASC"
        )
        XCTAssertEqual(backlinks.rows.map { row in
            [
                "entity": row["entity"] ?? "",
                "document": row["document"] ?? "",
            ]
        }, [
            ["entity": "Notes Roadmap", "document": "Daily field notes"],
            ["entity": "Notes Roadmap", "document": "Project capture"],
        ])

        XCTAssertTrue(try importedRepository.runQuery("SELECT name FROM junk").rows.isEmpty)
    }

    func testVaultImportRejectsUnsupportedSnapshotVersionsWithoutReplacingData() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(named: "Existing Entity", supertagNames: ["project"])
        var snapshot = try repository.exportVault()
        snapshot.version = NotesVaultSnapshot.currentVersion + 1

        XCTAssertThrowsError(try repository.importVault(snapshot))

        let entities = try repository.runQuery("SELECT name FROM project")
        XCTAssertEqual(visibleQueryRows(entities.rows), [["name": "Existing Entity"]])
    }

    func testVaultImportNormalizesSupertagFieldValueTypes() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let sourceRepository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try sourceRepository.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Done",
            valueType: .boolean,
            defaultValue: "false"
        )
        var snapshot = try sourceRepository.exportVault()
        snapshot.supertagFieldDefinitions[0].valueType = "checkbox"

        let importedDatabaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: importedDatabaseURL) }

        let importedRepository = try SQLiteNotesRepository(databaseURL: importedDatabaseURL)
        try importedRepository.importVault(snapshot)

        let definition = try XCTUnwrap(importedRepository.fetchSupertagFieldDefinitions().first)
        XCTAssertEqual(definition.valueType, .boolean)

        let fields = try importedRepository.runQuery("SELECT field, type FROM supertag_fields")
        XCTAssertEqual(fields.rows, [["field": "done", "type": "boolean"]])
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
        XCTAssertFalse(bookmarks.columns.contains(queryEntityIDMetadataKey))
        XCTAssertEqual(bookmarks.rows.count, 1)
        XCTAssertEqual(bookmarks.rows.first?["name"], "Rawkode Academy")
        XCTAssertEqual(bookmarks.rows.first?["url"], "https://rawkode.academy")
        XCTAssertEqual(bookmarks.rows.first?["status"], "active")
        XCTAssertEqual(bookmarks.rows.first?["supertags"], "bookmark, company, project")
        XCTAssertEqual(bookmarks.rows.first?[queryEntityIDMetadataKey], entity.id.uuidString)
    }

    func testEntityPropertiesCanReferenceOtherEntities() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let project = try repository.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: [
                "Owner": "[[Rawkode Academy]]",
                "Status": "active",
            ]
        )

        XCTAssertEqual(project.properties["owner"], "Rawkode Academy")

        let owner = try repository.runQuery("SELECT id, name FROM entities WHERE name = 'Rawkode Academy'")
        let ownerID = try XCTUnwrap(owner.rows.first?["id"])
        XCTAssertEqual(owner.rows.first?["name"], "Rawkode Academy")

        let projects = try repository.runQuery(
            "SELECT name, owner, owner_entity_id FROM projects WHERE owner = 'Rawkode Academy'"
        )
        XCTAssertEqual(projects.columns, ["name", "owner", "owner_entity_id"])
        XCTAssertEqual(visibleQueryRows(projects.rows), [
            [
                "name": "Notes Roadmap",
                "owner": "Rawkode Academy",
                "owner_entity_id": ownerID,
            ],
        ])
    }

    func testRunQueryReadsEntityRelationships() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: [
                "Owner": "[[Rawkode Academy]]",
                "Status": "active",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Website",
            supertagNames: ["project"],
            properties: ["Owner": "[[Rawkode Academy]]"]
        )

        let relationships = try repository.runQuery(
            "SELECT source, property, target FROM relations WHERE target CONTAINS academy ORDER BY source ASC"
        )

        XCTAssertEqual(relationships.columns, ["source", "property", "target"])
        XCTAssertEqual(relationships.rows, [
            [
                "source": "Notes Roadmap",
                "property": "owner",
                "target": "Rawkode Academy",
            ],
            [
                "source": "Website",
                "property": "owner",
                "target": "Rawkode Academy",
            ],
        ])
    }

    func testFetchEntityDetailIncludesBacklinksPropertiesAndRelationships() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let project = try repository.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: [
                "Owner": "[[Rawkode Academy]]",
                "Status": "active",
            ]
        )
        let projectRow = try XCTUnwrap(repository.runQuery("SELECT owner_entity_id FROM projects").rows.first)
        var document = try repository.createStandaloneNote()
        document.title = "Roadmap note"
        document.plainText = "[[Notes Roadmap]] #project"
        try repository.upsertDocument(document)

        let detail = try XCTUnwrap(repository.fetchEntityDetail(entityID: project.id))

        XCTAssertEqual(detail.id, project.id)
        XCTAssertEqual(detail.name, "Notes Roadmap")
        XCTAssertEqual(detail.supertags, ["project"])
        XCTAssertEqual(detail.properties["status"], "active")
        XCTAssertEqual(detail.properties["owner"], "Rawkode Academy")
        XCTAssertEqual(detail.backlinks.map(\.documentTitle), ["Roadmap note"])
        XCTAssertEqual(detail.outgoingRelationships.map(\.targetName), ["Rawkode Academy"])
        XCTAssertTrue(detail.incomingRelationships.isEmpty)

        let ownerID = try XCTUnwrap(UUID(uuidString: try XCTUnwrap(projectRow["owner_entity_id"])))
        let ownerDetail = try XCTUnwrap(repository.fetchEntityDetail(entityID: ownerID))
        XCTAssertEqual(ownerDetail.incomingRelationships.map(\.sourceName), ["Notes Roadmap"])
    }

    func testFetchDocumentContextReadsBacklinksAndRelationships() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let roadmap = try repository.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: ["Owner": "[[Rawkode Academy]]"]
        )
        let academy = try repository.upsertEntity(
            named: "Rawkode Academy",
            supertagNames: ["company"]
        )
        _ = try repository.upsertEntity(
            named: "Website",
            supertagNames: ["project"],
            properties: ["Owner": "[[Rawkode Academy]]"]
        )

        var document = try repository.createStandaloneNote()
        document.title = "Planning note"
        document.plainText = "Discuss [[Notes Roadmap]] today."
        try repository.upsertDocument(document)

        var unrelatedDocument = try repository.createStandaloneNote()
        unrelatedDocument.title = "Company note"
        unrelatedDocument.plainText = "Discuss [[Rawkode Academy]] separately."
        try repository.upsertDocument(unrelatedDocument)

        let context = try repository.fetchDocumentContext(documentID: document.id)

        XCTAssertEqual(context.backlinks.map(\.entityName), ["Notes Roadmap"])
        XCTAssertEqual(context.backlinks.first?.entityID, roadmap.id)
        XCTAssertEqual(context.backlinks.first?.documentID, document.id)
        XCTAssertEqual(context.backlinks.first?.documentKind, .note)
        XCTAssertNil(context.backlinks.first?.documentDate)

        XCTAssertEqual(context.outgoingRelationships.map(\.sourceName), ["Notes Roadmap"])
        XCTAssertEqual(context.outgoingRelationships.first?.property, "owner")
        XCTAssertEqual(context.outgoingRelationships.first?.targetEntityID, academy.id)

        XCTAssertTrue(context.incomingRelationships.isEmpty)

        let academyContext = try repository.fetchDocumentContext(documentID: unrelatedDocument.id)
        XCTAssertEqual(academyContext.backlinks.map(\.entityName), ["Rawkode Academy"])
        XCTAssertEqual(
            Set(academyContext.incomingRelationships.map(\.sourceName)),
            Set(["Notes Roadmap", "Website"])
        )
        XCTAssertTrue(academyContext.outgoingRelationships.isEmpty)
    }

    func testEntityPropertyReferenceColumnIsAddedDuringMigration() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        try executeRawSQL(
            """
            CREATE TABLE entity_properties (
                entity_id TEXT NOT NULL,
                property_key TEXT NOT NULL,
                property_value TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(entity_id, property_key)
            );
            """,
            databaseURL: databaseURL,
            createIfNeeded: true
        )

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: ["Owner": "[[Rawkode Academy]]"]
        )

        let projects = try repository.runQuery("SELECT owner_entity_id FROM projects")
        XCTAssertFalse(projects.rows.first?["owner_entity_id"]?.isEmpty ?? true)
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
        XCTAssertEqual(dailyResult.rows.first?[queryDocumentIDMetadataKey], dailyNote.id.uuidString)

        let projectedDailyResult = try repository.runQuery(
            "SELECT id, title FROM daily_notes WHERE date = '2026-06-16'"
        )
        XCTAssertEqual(projectedDailyResult.columns, ["id", "title"])
        XCTAssertEqual(projectedDailyResult.rows.first?[queryDocumentIDMetadataKey], dailyNote.id.uuidString)

        let bookmarks = try repository.runQuery("SELECT * FROM bookmarks WHERE name CONTAINS academy")
        XCTAssertEqual(bookmarks.columns, ["id", "name", "supertags", "updated_at"])
        XCTAssertEqual(bookmarks.rows.count, 1)
        XCTAssertEqual(bookmarks.rows.first?["name"], "Rawkode Academy")
        XCTAssertEqual(bookmarks.rows.first?["supertags"], "bookmark, company")

        let aliasedEntityID = try repository.runQuery(
            "SELECT id AS document_id, name AS title, updated_at AS date FROM bookmarks WHERE name CONTAINS academy"
        )
        XCTAssertNil(aliasedEntityID.rows.first?[queryDocumentIDMetadataKey])
    }

    func testRunQuerySupportsRelativeDailyNoteDates() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let baseDate = try XCTUnwrap(
            Calendar(identifier: .gregorian).date(from: DateComponents(year: 2026, month: 6, day: 16, hour: 12))
        )
        let today = DailyNoteDateFormatter.storageString(from: baseDate)
        let yesterday = try XCTUnwrap(
            Calendar(identifier: .gregorian).date(byAdding: .day, value: -1, to: baseDate)
        )
        let yesterdayStorageDate = DailyNoteDateFormatter.storageString(from: yesterday)
        let twoDaysAgo = try XCTUnwrap(
            Calendar(identifier: .gregorian).date(byAdding: .day, value: -2, to: baseDate)
        )
        let twoDaysAgoStorageDate = DailyNoteDateFormatter.storageString(from: twoDaysAgo)
        let tomorrow = try XCTUnwrap(
            Calendar(identifier: .gregorian).date(byAdding: .day, value: 1, to: baseDate)
        )
        let tomorrowStorageDate = DailyNoteDateFormatter.storageString(from: tomorrow)

        _ = try repository.createDailyNote(date: today)
        _ = try repository.createDailyNote(date: yesterdayStorageDate)
        _ = try repository.createDailyNote(date: twoDaysAgoStorageDate)
        _ = try repository.createDailyNote(date: tomorrowStorageDate)

        let todayResult = try repository.runQuery(
            "SELECT date, title FROM daily_notes WHERE date = today",
            relativeDate: baseDate
        )
        XCTAssertEqual(todayResult.columns, ["date", "title"])
        XCTAssertEqual(todayResult.rows.count, 1)
        XCTAssertEqual(todayResult.rows.first?["date"], today)

        let yesterdayResult = try repository.runQuery(
            "SELECT date FROM daily_notes WHERE date = 'yesterday'",
            relativeDate: baseDate
        )
        XCTAssertEqual(yesterdayResult.rows.first?["date"], yesterdayStorageDate)

        let rangeResult = try repository.runQuery(
            "SELECT date FROM daily_notes WHERE date IN (today, yesterday) ORDER BY date ASC",
            relativeDate: baseDate
        )
        XCTAssertEqual(rangeResult.rows.map { $0["date"] }, [yesterdayStorageDate, today])

        let orderedRangeResult = try repository.runQuery(
            "SELECT date FROM daily_notes WHERE date >= yesterday AND date <= today ORDER BY date ASC",
            relativeDate: baseDate
        )
        XCTAssertEqual(orderedRangeResult.rows.map { $0["date"] }, [yesterdayStorageDate, today])

        let rollingWindowResult = try repository.runQuery(
            "SELECT date FROM daily_notes WHERE date >= 'today - 2d' AND date <= today ORDER BY date ASC",
            relativeDate: baseDate
        )
        XCTAssertEqual(rollingWindowResult.rows.map { $0["date"] }, [twoDaysAgoStorageDate, yesterdayStorageDate, today])

        let betweenResult = try repository.runQuery(
            "SELECT date FROM daily_notes WHERE date BETWEEN 'today - 2d' AND today ORDER BY date ASC",
            relativeDate: baseDate
        )
        XCTAssertEqual(betweenResult.rows.map { $0["date"] }, [twoDaysAgoStorageDate, yesterdayStorageDate, today])

        let betweenOrResult = try repository.runQuery(
            "SELECT date FROM daily_notes WHERE date BETWEEN yesterday AND today OR date = tomorrow ORDER BY date ASC",
            relativeDate: baseDate
        )
        XCTAssertEqual(betweenOrResult.rows.map { $0["date"] }, [yesterdayStorageDate, today, tomorrowStorageDate])

        let notBetweenResult = try repository.runQuery(
            "SELECT date FROM daily_notes WHERE date NOT BETWEEN yesterday AND today ORDER BY date ASC",
            relativeDate: baseDate
        )
        XCTAssertEqual(notBetweenResult.rows.map { $0["date"] }, [twoDaysAgoStorageDate, tomorrowStorageDate])

        let compactArithmeticResult = try repository.runQuery(
            "SELECT date FROM daily_notes WHERE date IN (today-2d, yesterday, today+1d) ORDER BY date ASC",
            relativeDate: baseDate
        )
        XCTAssertEqual(compactArithmeticResult.rows.map { $0["date"] }, [
            twoDaysAgoStorageDate,
            yesterdayStorageDate,
            tomorrowStorageDate,
        ])

        XCTAssertThrowsError(
            try repository.runQuery(
                "SELECT date FROM daily_notes WHERE date = today+999999999999999999999999d",
                relativeDate: baseDate
            )
        )
        XCTAssertThrowsError(
            try repository.runQuery(
                "SELECT date FROM daily_notes WHERE date <= today+999999999999999999999999d",
                relativeDate: baseDate
            )
        )
        XCTAssertThrowsError(
            try repository.runQuery(
                "SELECT date FROM daily_notes WHERE date = today OR date <= today+999999999999999999999999d",
                relativeDate: baseDate
            )
        )
        XCTAssertThrowsError(
            try repository.runQuery(
                "SELECT date FROM daily_notes WHERE date BETWEEN today AND today+999999999999999999999999d",
                relativeDate: baseDate
            )
        )
        XCTAssertThrowsError(
            try repository.runQuery(
                "SELECT date FROM daily_notes WHERE date = missing AND date <= today+999999999999999999999999d",
                relativeDate: baseDate
            )
        )
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

    func testRunQueryProjectsSelectedColumns() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(
            named: "Alpha Resource",
            supertagNames: ["bookmark"],
            properties: [
                "URL": "https://alpha.example",
                "Status": "active",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Beta Resource",
            supertagNames: ["bookmark"],
            properties: [
                "URL": "https://beta.example",
                "Status": "active",
                "Phase": "Research and notes",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Gamma Resource",
            supertagNames: ["bookmark"],
            properties: [
                "URL": "https://gamma.example",
                "Status": "archived",
            ]
        )

        let result = try repository.runQuery(
            "SELECT name, url FROM bookmarks WHERE status = active ORDER BY url DESC LIMIT 1"
        )

        XCTAssertEqual(result.columns, ["name", "url"])
        XCTAssertEqual(visibleQueryRows(result.rows), [
            [
                "name": "Beta Resource",
                "url": "https://beta.example",
            ],
        ])

        let quotedAndBetween = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE phase BETWEEN 'Research and notes' AND z"
        )
        XCTAssertEqual(quotedAndBetween.rows.map { $0["name"] }, ["Beta Resource"])
    }

    func testRunQuerySupportsProjectionAliases() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(
            named: "Rawkode Academy",
            supertagNames: ["bookmark"],
            properties: [
                "URL": "https://rawkode.academy",
                "Status": "active",
            ]
        )

        let result = try repository.runQuery(
            "SELECT name AS title, url AS link FROM bookmarks WHERE status = active"
        )

        XCTAssertEqual(result.columns, ["title", "link"])
        XCTAssertEqual(visibleQueryRows(result.rows), [
            [
                "title": "Rawkode Academy",
                "link": "https://rawkode.academy",
            ],
        ])
    }

    func testRunQuerySupportsMultipleWherePredicates() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(
            named: "Rawkode Academy",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Slug": "research-and-notes",
                "Status": "active",
                "Topic": "Research and notes",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Personal Archive",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Slug": "research-and-notes",
                "Status": "archived",
                "Topic": "Research and notes",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Team Notes",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Team",
                "Slug": "research-and-notes",
                "Status": "active",
                "Topic": "Research and notes",
            ]
        )

        let result = try repository.runQuery(
            "SELECT name AS title, owner FROM bookmarks WHERE slug = research-and-notes AND status = active AND owner = Rawkode AND topic = 'Research and notes'"
        )

        XCTAssertEqual(result.columns, ["title", "owner"])
        XCTAssertEqual(visibleQueryRows(result.rows), [
            [
                "title": "Rawkode Academy",
                "owner": "Rawkode",
            ],
        ])
    }

    func testRunQuerySupportsOrPredicates() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(
            named: "Rawkode Academy",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "active",
                "Stage": "draft+and+review",
                "Token": "alpha+or+beta",
                "Topic": "Research or notes",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Personal Archive",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "archived",
                "Topic": "Reference",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Team Draft",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Team",
                "Status": "draft",
                "Topic": "Reference",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Team Active",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Team",
                "Status": "active",
                "Topic": "Reference",
            ]
        )

        let disjunction = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE status = archived OR owner = Team ORDER BY name ASC"
        )
        XCTAssertEqual(disjunction.rows.map { $0["name"] }, ["Personal Archive", "Team Active", "Team Draft"])

        let precedence = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE status = active AND owner = Rawkode OR status = draft AND owner = Team ORDER BY name ASC"
        )
        XCTAssertEqual(precedence.rows.map { $0["name"] }, ["Rawkode Academy", "Team Draft"])

        let quotedOr = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE topic = 'Research or notes' OR owner = Missing"
        )
        XCTAssertEqual(quotedOr.rows.map { $0["name"] }, ["Rawkode Academy"])

        let barePlusOr = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE token = alpha+or+beta OR owner = Missing"
        )
        XCTAssertEqual(barePlusOr.rows.map { $0["name"] }, ["Rawkode Academy"])

        let barePlusAnd = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE stage = draft+and+review AND owner = Rawkode"
        )
        XCTAssertEqual(barePlusAnd.rows.map { $0["name"] }, ["Rawkode Academy"])
    }

    func testRunQuerySupportsInPredicates() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(
            named: "Alpha Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "active",
                "Topic": "Research, notes",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Beta Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "draft",
                "Topic": "Reference",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Gamma Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "archived",
                "Topic": "Reference",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Team Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Team",
                "Status": "active",
                "Topic": "Research, notes",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Paren Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "reference",
                "Topic": "Research (notes)",
            ]
        )

        let result = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE status IN (active, draft) AND owner = Rawkode ORDER BY name ASC"
        )
        XCTAssertEqual(result.rows.map { $0["name"] }, ["Alpha Resource", "Beta Resource"])

        let quotedCommaResult = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE topic IN ('Research, notes') AND owner = Rawkode"
        )
        XCTAssertEqual(quotedCommaResult.rows.map { $0["name"] }, ["Alpha Resource"])

        let quotedParenthesisResult = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE topic IN ('Research (notes)') AND owner = Rawkode"
        )
        XCTAssertEqual(quotedParenthesisResult.rows.map { $0["name"] }, ["Paren Resource"])
    }

    func testRunQuerySupportsNegatedPredicates() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(
            named: "Alpha Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "active",
                "Topic": "public",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Beta Archive",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "archived",
                "Topic": "public",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Gamma Draft",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "draft",
                "Topic": "internal",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Team Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Team",
                "Status": "active",
                "Topic": "public",
            ]
        )

        let notEqualResult = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE status != archived AND owner = Rawkode ORDER BY name ASC"
        )
        XCTAssertEqual(notEqualResult.rows.map { $0["name"] }, ["Alpha Resource", "Gamma Draft"])

        let notContainsResult = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE topic NOT CONTAINS internal AND owner = Rawkode ORDER BY name ASC"
        )
        XCTAssertEqual(notContainsResult.rows.map { $0["name"] }, ["Alpha Resource", "Beta Archive"])

        let notInResult = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE status NOT IN (archived, draft) AND owner IN (Rawkode, Team) ORDER BY name ASC"
        )
        XCTAssertEqual(notInResult.rows.map { $0["name"] }, ["Alpha Resource", "Team Resource"])
    }

    func testRunQuerySupportsEmptyPredicates() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(
            named: "Alpha Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Note": "Needs review",
                "Status": "active",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Beta Archive",
            supertagNames: ["bookmark"],
            properties: [
                "Status": "archived",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Gamma Draft",
            supertagNames: ["bookmark"],
            properties: [
                "Note": "   ",
                "Status": "draft",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Team Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Note": "Done",
                "Status": "active",
            ]
        )

        let emptyNotes = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE note IS EMPTY ORDER BY name ASC"
        )
        XCTAssertEqual(emptyNotes.rows.map { $0["name"] }, ["Beta Archive", "Gamma Draft"])

        let filledNotes = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE note IS NOT EMPTY ORDER BY name ASC"
        )
        XCTAssertEqual(filledNotes.rows.map { $0["name"] }, ["Alpha Resource", "Team Resource"])

        let emptyDrafts = try repository.runQuery(
            "SELECT name FROM bookmarks WHERE note IS EMPTY AND status = draft"
        )
        XCTAssertEqual(emptyDrafts.rows.map { $0["name"] }, ["Gamma Draft"])
    }

    func testRunQuerySupportsCountAggregate() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(
            named: "Alpha Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Account": "personal",
                "Count": "7",
                "Owner": "Rawkode",
                "Status": "active",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Beta Draft",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "draft",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Gamma Archive",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "archived",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Team Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Team",
                "Status": "active",
            ]
        )

        let active = try repository.runQuery(
            "SELECT COUNT(*) AS total FROM bookmarks WHERE status IN (active, draft) AND owner = Rawkode"
        )
        XCTAssertEqual(active.columns, ["total"])
        XCTAssertEqual(active.rows, [["total": "2"]])

        let missing = try repository.runQuery(
            "SELECT COUNT(*) FROM bookmarks WHERE status = missing"
        )
        XCTAssertEqual(missing.columns, ["count"])
        XCTAssertEqual(missing.rows, [["count": "0"]])

        let projectedProperty = try repository.runQuery(
            "SELECT account FROM bookmarks WHERE name = 'Alpha Resource'"
        )
        XCTAssertEqual(projectedProperty.columns, ["account"])
        XCTAssertEqual(visibleQueryRows(projectedProperty.rows), [["account": "personal"]])

        let projectedCountProperty = try repository.runQuery(
            "SELECT count FROM bookmarks WHERE name = 'Alpha Resource'"
        )
        XCTAssertEqual(projectedCountProperty.columns, ["count"])
        XCTAssertEqual(visibleQueryRows(projectedCountProperty.rows), [["count": "7"]])
    }

    func testRunQuerySupportsGroupedCountAggregate() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        _ = try repository.upsertEntity(
            named: "Alpha Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "active",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Archive Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "archived",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Beta Draft",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "draft",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Gamma Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Rawkode",
                "Status": "active",
            ]
        )
        _ = try repository.upsertEntity(
            named: "Team Resource",
            supertagNames: ["bookmark"],
            properties: [
                "Owner": "Team",
                "Status": "active",
            ]
        )

        let grouped = try repository.runQuery(
            "SELECT status AS lane, COUNT(*) AS total FROM bookmarks WHERE owner IN (Rawkode, Team) GROUP BY status ORDER BY lane ASC"
        )
        XCTAssertEqual(grouped.columns, ["lane", "total"])
        XCTAssertEqual(grouped.rows, [
            [
                "lane": "active",
                "total": "3",
            ],
            [
                "lane": "archived",
                "total": "1",
            ],
            [
                "lane": "draft",
                "total": "1",
            ],
        ])

        let largestGroup = try repository.runQuery(
            "SELECT status, COUNT(*) AS total FROM bookmarks GROUP BY status ORDER BY total DESC LIMIT 1"
        )
        XCTAssertEqual(largestGroup.columns, ["status", "total"])
        XCTAssertEqual(largestGroup.rows, [
            [
                "status": "active",
                "total": "3",
            ],
        ])

        let repeatedGroups = try repository.runQuery(
            "SELECT status AS lane, COUNT(*) AS total FROM bookmarks GROUP BY status HAVING total >= 2 ORDER BY total DESC"
        )
        XCTAssertEqual(repeatedGroups.columns, ["lane", "total"])
        XCTAssertEqual(repeatedGroups.rows, [
            [
                "lane": "active",
                "total": "3",
            ],
        ])

        let defaultCountHaving = try repository.runQuery(
            "SELECT status, COUNT(*) FROM bookmarks GROUP BY status HAVING count > 1 AND status = active"
        )
        XCTAssertEqual(defaultCountHaving.columns, ["status", "count"])
        XCTAssertEqual(defaultCountHaving.rows, [
            [
                "status": "active",
                "count": "3",
            ],
        ])

        let nonDraftGroups = try repository.runQuery(
            "SELECT status AS lane, COUNT(*) FROM bookmarks GROUP BY status HAVING lane != draft ORDER BY lane ASC"
        )
        XCTAssertEqual(nonDraftGroups.columns, ["lane", "count"])
        XCTAssertEqual(nonDraftGroups.rows, [
            [
                "lane": "active",
                "count": "3",
            ],
            [
                "lane": "archived",
                "count": "1",
            ],
        ])

        let disjunctiveHaving = try repository.runQuery(
            "SELECT status AS lane, COUNT(*) AS total FROM bookmarks GROUP BY status HAVING total > 2 OR lane = archived ORDER BY lane ASC"
        )
        XCTAssertEqual(disjunctiveHaving.columns, ["lane", "total"])
        XCTAssertEqual(disjunctiveHaving.rows, [
            [
                "lane": "active",
                "total": "3",
            ],
            [
                "lane": "archived",
                "total": "1",
            ],
        ])

        let multiFieldGroup = try repository.runQuery(
            "SELECT owner, status, COUNT(*) AS total FROM bookmarks GROUP BY owner, status ORDER BY total DESC"
        )
        XCTAssertEqual(multiFieldGroup.columns, ["owner", "status", "total"])
        XCTAssertEqual(
            Set(multiFieldGroup.rows.map { "\($0["owner"] ?? ""):\($0["status"] ?? ""):\($0["total"] ?? "")" }),
            Set([
                "Rawkode:active:2",
                "Rawkode:archived:1",
                "Rawkode:draft:1",
                "Team:active:1",
            ])
        )

        _ = try repository.createDailyNote(date: "2026-06-16")
        _ = try repository.createDailyNote(date: "2026-06-17")
        let dailyCounts = try repository.runQuery(
            "SELECT date, COUNT(*) AS notes FROM daily_notes GROUP BY date ORDER BY date ASC"
        )
        XCTAssertEqual(dailyCounts.columns, ["date", "notes"])
        XCTAssertEqual(dailyCounts.rows.map { $0["notes"] }, ["1", "1"])

        XCTAssertThrowsError(
            try repository.runQuery("SELECT status, COUNT(*) AS total FROM bookmarks GROUP BY status ORDER BY missing")
        )
        XCTAssertThrowsError(
            try repository.runQuery("SELECT owner, COUNT(*) FROM bookmarks GROUP BY status")
        )
        XCTAssertThrowsError(
            try repository.runQuery("SELECT COUNT(*) AS total, status FROM bookmarks GROUP BY status")
        )
        XCTAssertThrowsError(
            try repository.runQuery("SELECT status, COUNT(*) AS total FROM bookmarks GROUP BY status HAVING missing > 1")
        )
    }

    func testRunQueryRejectsUnsupportedStatements() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        XCTAssertThrowsError(try repository.runQuery("DELETE FROM entities"))
        XCTAssertThrowsError(try repository.runQuery("SELECT * FROM entities ORDER BY missing"))
        XCTAssertThrowsError(try repository.runQuery("SELECT missing FROM entities"))
        XCTAssertThrowsError(try repository.runQuery("SELECT name, name FROM entities"))
        XCTAssertThrowsError(try repository.runQuery("SELECT name AS label, id AS label FROM entities"))
        XCTAssertThrowsError(try repository.runQuery("SELECT * FROM entities WHERE name CONTAINS rawkode AND"))
        XCTAssertThrowsError(try repository.runQuery("SELECT * FROM entities WHERE name CONTAINS rawkode OR"))
        XCTAssertThrowsError(try repository.runQuery("SELECT * FROM entities WHERE name CONTAINS rawkode OR OR updated_at CONTAINS 2026"))
        XCTAssertThrowsError(try repository.runQuery("SELECT * FROM entities WHERE name IN ()"))
        XCTAssertThrowsError(try repository.runQuery("SELECT * FROM entities WHERE name IN (rawkode,)"))
        XCTAssertThrowsError(try repository.runQuery("SELECT * FROM entities WHERE name IS BLANK"))
        XCTAssertThrowsError(try repository.runQuery("SELECT * FROM entities WHERE name <> rawkode"))
        XCTAssertThrowsError(try repository.runQuery("SELECT COUNT(name) FROM entities"))
        XCTAssertThrowsError(try repository.runQuery("SELECT name, COUNT(*) FROM entities"))
        XCTAssertThrowsError(try repository.runQuery("SELECT COUNT(*) FROM entities ORDER BY name"))
        XCTAssertThrowsError(try repository.runQuery("SELECT COUNT(*) FROM entities LIMIT 1"))
        XCTAssertThrowsError(try repository.runQuery("SELECT name FROM entities GROUP BY name"))
        XCTAssertThrowsError(try repository.runQuery("SELECT COUNT(*) FROM entities GROUP BY name"))
        XCTAssertThrowsError(try repository.runQuery("SELECT name, COUNT(*) FROM entities GROUP BY updated_at"))
        XCTAssertThrowsError(try repository.runQuery("SELECT name, COUNT(*) FROM entities GROUP BY name, name"))
        XCTAssertThrowsError(try repository.runQuery("SELECT name, COUNT(*) AS name FROM entities GROUP BY name"))
        XCTAssertThrowsError(try repository.runQuery("SELECT * FROM entities HAVING name = Rawkode"))
        XCTAssertThrowsError(try repository.runQuery("SELECT COUNT(*) FROM entities HAVING count > 0"))
        XCTAssertThrowsError(try repository.runQuery("SELECT name, COUNT(*) FROM entities HAVING count > 0 GROUP BY name"))

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
        XCTAssertEqual(references.rows.first?[queryEntityIDMetadataKey], entity.id.uuidString)
        XCTAssertEqual(references.rows.first?[queryDocumentIDMetadataKey], document.id.uuidString)

        document.tiptapJSON = #"{"type":"doc","content":[{"type":"paragraph"}]}"#
        try repository.upsertDocument(document)

        XCTAssertTrue(try repository.runQuery("SELECT * FROM backlinks").rows.isEmpty)
    }

    func testEntityReferenceIndexCreatesEntitiesFromPlainTextMentions() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let existingEntity = try repository.upsertEntity(named: "Rawkode Academy", supertagNames: ["company"])
        var document = try repository.createStandaloneNote()
        document.title = "Meeting note"
        document.tiptapJSON = #"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Plain mentions"}]}]}"#
        document.plainText = "Discuss [[rawkode academy]], [[ Notes Roadmap ]], and [[rawkode academy]]."
        try repository.upsertDocument(document)

        let entities = try repository.runQuery("SELECT id, name, supertags FROM entities ORDER BY name ASC")
        let roadmapEntityID = try XCTUnwrap(entities.rows.first?["id"])
        XCTAssertEqual(visibleQueryRows(entities.rows), [
            ["id": roadmapEntityID, "name": "Notes Roadmap", "supertags": ""],
            ["id": existingEntity.id.uuidString, "name": "Rawkode Academy", "supertags": "company"],
        ])

        let references = try repository.runQuery(
            "SELECT entity, entity_id, document FROM backlinks WHERE document = 'Meeting note' ORDER BY entity ASC"
        )
        XCTAssertEqual(references.columns, ["entity", "entity_id", "document"])
        XCTAssertEqual(references.rows.map(visibleEntityReferenceRow), [
            [
                "entity": "Notes Roadmap",
                "entity_id": roadmapEntityID,
                "document": "Meeting note",
            ],
            [
                "entity": "Rawkode Academy",
                "entity_id": existingEntity.id.uuidString,
                "document": "Meeting note",
            ],
        ])
        XCTAssertEqual(
            Set(references.rows.compactMap { $0[queryDocumentIDMetadataKey] }),
            [document.id.uuidString]
        )

        document.plainText = "Only [[Notes Roadmap]] remains."
        try repository.upsertDocument(document)

        let refreshedReferences = try repository.runQuery(
            "SELECT entity, document FROM backlinks WHERE document = 'Meeting note' ORDER BY entity ASC"
        )
        XCTAssertEqual(refreshedReferences.rows.map { row in
            [
                "entity": row["entity"] ?? "",
                "document": row["document"] ?? "",
            ]
        }, [
            ["entity": "Notes Roadmap", "document": "Meeting note"],
        ])
        XCTAssertEqual(refreshedReferences.rows.first?[queryDocumentIDMetadataKey], document.id.uuidString)
    }

    func testPlainTextMentionsApplySameLineSupertags() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let existingEntity = try repository.upsertEntity(named: "Rawkode Academy", supertagNames: ["company"])
        var document = try repository.createStandaloneNote()
        document.title = "Typed database"
        document.tiptapJSON = #"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Typed database"}]}]}"#
        document.plainText = """
        [[rawkode academy]] #customer
        [[Notes Roadmap]] #project #active
        [[Notes Roadmap]] #bookmark and [[Launch Plan]] #project
        """
        try repository.upsertDocument(document)

        let customers = try repository.runQuery(
            "SELECT id, name, supertags FROM customers WHERE name = 'Rawkode Academy'"
        )
        XCTAssertEqual(visibleQueryRows(customers.rows), [
            [
                "id": existingEntity.id.uuidString,
                "name": "Rawkode Academy",
                "supertags": "company, customer",
            ],
        ])

        let projects = try repository.runQuery(
            "SELECT name, supertags FROM projects ORDER BY name ASC"
        )
        XCTAssertEqual(visibleQueryRows(projects.rows), [
            ["name": "Launch Plan", "supertags": "project"],
            ["name": "Notes Roadmap", "supertags": "active, bookmark, project"],
        ])

        let bookmarks = try repository.runQuery("SELECT name FROM bookmarks")
        XCTAssertEqual(visibleQueryRows(bookmarks.rows), [
            ["name": "Notes Roadmap"],
        ])
    }

    func testPlainTextMentionPropertyLinesCreateEntityRelationships() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let owner = try repository.upsertEntity(named: "Rawkode Academy", supertagNames: ["company"])
        var document = try repository.createStandaloneNote()
        document.title = "Project properties"
        document.tiptapJSON = #"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Project properties"}]}]}"#
        document.plainText = """
        [[Notes Roadmap]] #project
        owner:: [[rawkode academy]]
        status:: active

        This line does not belong to the entity block.
        ignored:: value
        """
        try repository.upsertDocument(document)

        let projects = try repository.runQuery(
            "SELECT name, supertags, owner, owner_entity_id, status FROM projects"
        )
        XCTAssertEqual(visibleQueryRows(projects.rows), [
            [
                "name": "Notes Roadmap",
                "supertags": "project",
                "owner": "Rawkode Academy",
                "owner_entity_id": owner.id.uuidString,
                "status": "active",
            ],
        ])

        let relationships = try repository.runQuery(
            "SELECT source, property, target, target_id FROM relations WHERE source = 'Notes Roadmap'"
        )
        XCTAssertEqual(relationships.rows, [
            [
                "source": "Notes Roadmap",
                "property": "owner",
                "target": "Rawkode Academy",
                "target_id": owner.id.uuidString,
            ],
        ])

        XCTAssertThrowsError(try repository.runQuery("SELECT ignored FROM projects"))

        document.plainText = """
        [[Notes Roadmap]] #project
        owner:: [[Launch Plan]]
        status:: paused
        """
        try repository.upsertDocument(document)

        let updatedProject = try repository.runQuery(
            "SELECT owner, status FROM projects WHERE name = 'Notes Roadmap'"
        )
        XCTAssertEqual(visibleQueryRows(updatedProject.rows), [
            ["owner": "Launch Plan", "status": "paused"],
        ])
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
    func testStoreCanNavigateAdjacentDailyNotes() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let store = NotesStore(repository: repository)
        let selectedDate = try XCTUnwrap(
            Calendar(identifier: .gregorian).date(from: DateComponents(year: 2026, month: 1, day: 5, hour: 12))
        )

        store.load()
        store.createDailyNote(for: selectedDate)
        store.openDailyNote(movingByDays: -1)

        XCTAssertEqual(store.selectedDocument?.kind, .daily)
        XCTAssertEqual(store.selectedDocument?.date, "2026-01-04")

        store.openDailyNote(movingByDays: 1)

        XCTAssertEqual(store.selectedDocument?.date, "2026-01-05")
        XCTAssertEqual(store.dailyNotes.filter { $0.date == "2026-01-05" }.count, 1)

        store.openDailyNote(movingByDays: 1)

        XCTAssertEqual(store.selectedDocument?.date, "2026-01-06")
        XCTAssertTrue(store.dailyNotes.contains { $0.date == "2026-01-04" })
        XCTAssertTrue(store.dailyNotes.contains { $0.date == "2026-01-06" })
    }

    @MainActor
    func testStoreCanSelectTomorrowDailyNote() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let store = NotesStore(repository: repository)
        let tomorrowDate = try XCTUnwrap(DailyNoteDateFormatter.relativeStorageString(for: "tomorrow"))

        store.load()
        store.selectTomorrow()

        XCTAssertEqual(store.selectedDocument?.kind, .daily)
        XCTAssertEqual(store.selectedDocument?.date, tomorrowDate)
        XCTAssertTrue(store.dailyNotes.contains { $0.date == tomorrowDate })

        store.selectTomorrow()

        XCTAssertEqual(store.dailyNotes.filter { $0.date == tomorrowDate }.count, 1)
    }

    @MainActor
    func testStaleDailyNoteSaveDoesNotReselectPriorDateAfterNavigation() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let store = NotesStore(repository: repository)
        let selectedDate = try XCTUnwrap(
            Calendar(identifier: .gregorian).date(from: DateComponents(year: 2026, month: 1, day: 5, hour: 12))
        )

        store.load()
        store.createDailyNote(for: selectedDate)
        let originalDailyNote = try XCTUnwrap(store.selectedDocument)

        store.openDailyNote(movingByDays: -1)
        let navigatedDailyNote = try XCTUnwrap(store.selectedDocument)

        store.saveEditorChange(
            documentID: originalDailyNote.id,
            title: originalDailyNote.title,
            contentJSON: SQLiteNotesRepository.defaultDailyNoteJSON(title: originalDailyNote.displayTitle),
            plainText: "Stale save from previous day"
        )

        XCTAssertEqual(store.selectedDocument?.id, navigatedDailyNote.id)
        XCTAssertEqual(store.selectedDocument?.date, "2026-01-04")
        XCTAssertEqual(
            store.dailyNotes.first { $0.id == originalDailyNote.id }?.plainText,
            "Stale save from previous day"
        )
    }

    @MainActor
    func testStoreOpenDocumentIgnoresEntityIDs() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let store = NotesStore(repository: repository)

        store.load()
        let initialDocument = try XCTUnwrap(store.selectedDocument)
        let entity = try repository.upsertEntity(named: "Aliased Entity", supertagNames: ["project"])

        store.openDocument(id: entity.id)

        XCTAssertEqual(store.selectedDocument?.id, initialDocument.id)

        store.createStandaloneNote()
        let standaloneNote = try XCTUnwrap(store.selectedDocument)

        store.selectToday()
        store.openDocument(id: standaloneNote.id)

        XCTAssertEqual(store.selectedDocument?.id, standaloneNote.id)
    }

    @MainActor
    func testStoreCanOpenEntityDetails() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let store = NotesStore(repository: repository)

        store.load()
        let entity = try store.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: ["Status": "active"]
        )

        store.openEntity(id: entity.id)

        XCTAssertNil(store.selectedDocument)
        XCTAssertEqual(store.selectedDocumentContext, .empty)
        XCTAssertEqual(store.selectedEntityDetail?.id, entity.id)
        XCTAssertEqual(store.selectedEntityDetail?.name, "Notes Roadmap")
        XCTAssertEqual(store.selectedEntityDetail?.properties["status"], "active")

        store.selectToday()

        XCTAssertNotNil(store.selectedDocument)
        XCTAssertNil(store.selectedEntityDetail)
    }

    @MainActor
    func testStoreUpdatesTypedEntityPropertiesFromSelectedEntityDetail() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let store = NotesStore(repository: repository)

        store.load()
        _ = try store.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Status",
            valueType: .text,
            isRequired: true
        )
        _ = try store.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Rank",
            valueType: .number
        )
        _ = try store.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Owner",
            valueType: .entity
        )
        _ = try store.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Done",
            valueType: .boolean
        )

        let entity = try store.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: [
                "Status": "draft",
                "Rank": "1",
            ]
        )
        store.openEntity(id: entity.id)

        try store.updateEntityProperty(entityID: entity.id, key: "status", value: "active")
        XCTAssertEqual(store.selectedEntityDetail?.properties["status"], "active")

        try store.updateEntityProperty(entityID: entity.id, key: "done", value: "true")
        XCTAssertEqual(store.selectedEntityDetail?.properties["done"], "true")

        try store.updateEntityProperty(entityID: entity.id, key: "owner", value: "[[Rawkode Academy]]")
        XCTAssertEqual(store.selectedEntityDetail?.properties["owner"], "Rawkode Academy")
        XCTAssertEqual(store.selectedEntityDetail?.outgoingRelationships.map(\.targetName), ["Rawkode Academy"])

        try store.updateEntityProperty(entityID: entity.id, key: "sponsor", value: "[[SQLite]]")
        XCTAssertEqual(store.selectedEntityDetail?.properties["sponsor"], "SQLite")
        XCTAssertTrue(store.selectedEntityDetail?.outgoingRelationships.contains { relationship in
            relationship.property == "sponsor" && relationship.targetName == "SQLite"
        } ?? false)

        try store.updateEntityProperty(entityID: entity.id, key: "status", value: "review")
        XCTAssertEqual(store.selectedEntityDetail?.properties["status"], "review")
        XCTAssertEqual(store.selectedEntityDetail?.properties["owner"], "Rawkode Academy")
        XCTAssertTrue(store.selectedEntityDetail?.outgoingRelationships.contains { relationship in
            relationship.property == "owner" && relationship.targetName == "Rawkode Academy"
        } ?? false)
        XCTAssertTrue(store.selectedEntityDetail?.outgoingRelationships.contains { relationship in
            relationship.property == "sponsor" && relationship.targetName == "SQLite"
        } ?? false)

        XCTAssertThrowsError(
            try store.updateEntityProperty(entityID: entity.id, key: "rank", value: "not a number")
        )
        XCTAssertEqual(store.selectedEntityDetail?.properties["rank"], "1")

        _ = try store.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: [
                "Status": "paused",
                "Rank": "2",
                "Done": "false",
            ]
        )
        XCTAssertEqual(store.selectedEntityDetail?.properties["status"], "paused")
        XCTAssertEqual(store.selectedEntityDetail?.properties["rank"], "2")
        XCTAssertEqual(store.selectedEntityDetail?.properties["done"], "false")
    }

    @MainActor
    func testStoreReadsSelectedDocumentContext() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let store = NotesStore(repository: repository)

        store.load()
        XCTAssertEqual(store.selectedDocumentContext, .empty)

        _ = try store.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: ["Owner": "[[Rawkode Academy]]"]
        )

        store.createStandaloneNote()
        let note = try XCTUnwrap(store.selectedDocument)
        store.saveEditorChange(
            documentID: note.id,
            title: "Planning note",
            contentJSON: note.tiptapJSON,
            plainText: "Discuss [[Notes Roadmap]]."
        )

        let context = try store.documentContext(for: note.id)

        XCTAssertEqual(context.backlinks.map(\.entityName), ["Notes Roadmap"])
        XCTAssertEqual(context.outgoingRelationships.map(\.targetName), ["Rawkode Academy"])
        XCTAssertTrue(context.incomingRelationships.isEmpty)
        XCTAssertEqual(store.selectedDocumentContext, context)

        _ = try store.upsertEntity(
            named: "Notes Roadmap",
            supertagNames: ["project"],
            properties: ["Owner": "[[New Owner]]"]
        )

        XCTAssertEqual(store.selectedDocumentContext.backlinks.map(\.entityName), ["Notes Roadmap"])
        XCTAssertEqual(store.selectedDocumentContext.outgoingRelationships.map(\.targetName), ["New Owner"])

        store.selectDocument(id: nil)
        XCTAssertNil(store.selectedDocument)
        XCTAssertEqual(store.selectedDocumentContext, .empty)

        store.selectDocument(id: note.id)
        XCTAssertEqual(store.selectedDocumentContext.backlinks.map(\.entityName), ["Notes Roadmap"])
        XCTAssertEqual(store.selectedDocumentContext.outgoingRelationships.map(\.targetName), ["New Owner"])
    }

    @MainActor
    func testStoreExportsAndImportsVaultJSON() throws {
        let sourceDatabaseURL = try temporaryDatabaseURL()
        let importedDatabaseURL = try temporaryDatabaseURL()
        defer {
            removeTemporaryDatabase(at: sourceDatabaseURL)
            removeTemporaryDatabase(at: importedDatabaseURL)
        }

        let sourceStore = NotesStore(repository: try SQLiteNotesRepository(databaseURL: sourceDatabaseURL))
        sourceStore.load()
        sourceStore.createStandaloneNote()
        let sourceNote = try XCTUnwrap(sourceStore.selectedDocument)
        sourceStore.saveEditorChange(
            documentID: sourceNote.id,
            title: "Portable project",
            contentJSON: sourceNote.tiptapJSON,
            plainText: """
            [[Notes Roadmap]] #project
            owner:: [[Rawkode Academy]]
            """
        )
        _ = try sourceStore.saveSavedQueryView(
            named: "Portable Projects",
            query: "SELECT name, owner FROM projects",
            view: "table"
        )

        let exportedJSON = try sourceStore.exportVaultJSON()

        let importedStore = NotesStore(repository: try SQLiteNotesRepository(databaseURL: importedDatabaseURL))
        importedStore.load()
        importedStore.createStandaloneNote()
        let junkNote = try XCTUnwrap(importedStore.selectedDocument)
        importedStore.saveEditorChange(
            documentID: junkNote.id,
            title: "Junk note",
            contentJSON: junkNote.tiptapJSON,
            plainText: "[[Junk Entity]] #junk"
        )

        try importedStore.importVaultJSON(exportedJSON)

        XCTAssertEqual(importedStore.standaloneNotes.map(\.title), ["Portable project"])
        XCTAssertFalse(importedStore.standaloneNotes.contains { $0.title == "Junk note" })
        XCTAssertEqual(importedStore.savedQueryViews.map(\.name), ["Portable Projects"])
        XCTAssertNotNil(importedStore.selectedDocument)

        let projects = try importedStore.runQuery("SELECT name, owner FROM projects")
        XCTAssertEqual(visibleQueryRows(projects.rows), [
            ["name": "Notes Roadmap", "owner": "Rawkode Academy"],
        ])
        XCTAssertTrue(try importedStore.runQuery("SELECT name FROM junk").rows.isEmpty)
    }

    @MainActor
    func testStoreRefreshesSupertagSchemasAfterEditorAndEntityWrites() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let store = NotesStore(repository: repository)

        store.load()
        let document = try XCTUnwrap(store.selectedDocument)
        XCTAssertTrue(store.supertagSchemas.isEmpty)

        store.saveEditorChange(
            documentID: document.id,
            title: "Tagged daily note",
            contentJSON: document.tiptapJSON,
            plainText: "[[Notes Roadmap]] #project"
        )

        XCTAssertEqual(store.supertagSchemas.map(\.name), ["project"])
        XCTAssertTrue(store.supertagSchemas.first?.fields.isEmpty ?? false)

        _ = try store.upsertEntity(named: "Swift Article", supertagNames: ["bookmark"])

        XCTAssertEqual(Set(store.supertagSchemas.map(\.name)), Set(["bookmark", "project"]))
        XCTAssertTrue(store.supertagSchemas.allSatisfy(\.fields.isEmpty))
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

    @MainActor
    func testStoreCanSaveAndDeleteSavedQueryViews() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let store = NotesStore(repository: repository)

        store.load()
        XCTAssertTrue(store.savedQueryViews.isEmpty)

        let savedView = try store.saveSavedQueryView(
            named: "Open Projects",
            query: "SELECT name FROM projects WHERE status != archived",
            view: "list"
        )

        XCTAssertEqual(store.savedQueryViews.count, 1)
        XCTAssertEqual(store.savedQueryViews.first?.id, savedView.id)
        XCTAssertEqual(store.savedQueryViews.first?.name, "Open Projects")
        XCTAssertEqual(store.savedQueryViews.first?.query, "SELECT name FROM projects WHERE status != archived")
        XCTAssertEqual(store.savedQueryViews.first?.view, "list")
        XCTAssertEqual(store.savedQueryViews.first?.sortOrder, 0)

        let recentView = try store.saveSavedQueryView(
            named: "Recent Daily Notes",
            query: "SELECT date, title FROM daily_notes",
            view: "table"
        )

        XCTAssertEqual(store.savedQueryViews.map(\.id), [savedView.id, recentView.id])

        let updatedView = try store.updateSavedQueryView(
            id: savedView.id,
            named: "Open Projects Board",
            query: "SELECT name, status FROM projects WHERE status != archived",
            view: "board",
            groupBy: "status"
        )

        XCTAssertEqual(updatedView.id, savedView.id)
        XCTAssertEqual(store.savedQueryViews.count, 2)
        XCTAssertEqual(store.savedQueryViews.first?.name, "Open Projects Board")
        XCTAssertEqual(store.savedQueryViews.first?.view, "board")
        XCTAssertEqual(store.savedQueryViews.first?.groupBy, "status")

        let duplicateView = try store.duplicateSavedQueryView(id: savedView.id)
        XCTAssertEqual(duplicateView.name, "Open Projects Board Copy")
        XCTAssertEqual(store.savedQueryViews.map(\.id), [savedView.id, recentView.id, duplicateView.id])

        store.reorderSavedQueryViews(ids: [
            duplicateView.id,
            recentView.id,
            savedView.id,
        ])

        XCTAssertEqual(store.savedQueryViews.map(\.id), [
            duplicateView.id,
            recentView.id,
            savedView.id,
        ])
        XCTAssertEqual(store.savedQueryViews.map(\.sortOrder), [0, 1, 2])

        store.deleteSavedQueryView(id: savedView.id)

        XCTAssertEqual(store.savedQueryViews.map(\.id), [duplicateView.id, recentView.id])
    }

    @MainActor
    func testStoreCanSaveAndDeleteSupertagFieldDefinitions() throws {
        let databaseURL = try temporaryDatabaseURL()
        defer { removeTemporaryDatabase(at: databaseURL) }

        let repository = try SQLiteNotesRepository(databaseURL: databaseURL)
        let store = NotesStore(repository: repository)

        store.load()
        XCTAssertTrue(store.supertagFieldDefinitions.isEmpty)
        XCTAssertTrue(store.supertagSchemas.isEmpty)

        let definition = try store.saveSupertagFieldDefinition(
            supertagName: "Project",
            field: "Status",
            valueType: .text,
            defaultValue: "active",
            isRequired: true
        )

        XCTAssertEqual(store.supertagFieldDefinitions.count, 1)
        XCTAssertEqual(store.supertagFieldDefinitions.first?.id, definition.id)
        XCTAssertEqual(store.supertagFieldDefinitions.first?.key, "status")
        XCTAssertEqual(store.supertagFieldDefinitions.first?.defaultValue, "active")
        XCTAssertEqual(store.supertagFieldDefinitions.first?.isRequired, true)
        XCTAssertEqual(store.supertagSchemas.count, 1)
        XCTAssertEqual(store.supertagSchemas.first?.name, "Project")
        XCTAssertEqual(store.supertagSchemas.first?.fields.map(\.id), [definition.id])

        let updated = try store.updateSupertagFieldDefinition(
            id: definition.id,
            field: "Done",
            valueType: .boolean
        )

        XCTAssertEqual(updated.id, definition.id)
        XCTAssertEqual(store.supertagFieldDefinitions.count, 1)
        XCTAssertEqual(store.supertagFieldDefinitions.first?.key, "done")
        XCTAssertEqual(store.supertagFieldDefinitions.first?.valueType, .boolean)
        XCTAssertNil(store.supertagFieldDefinitions.first?.defaultValue)
        XCTAssertEqual(store.supertagFieldDefinitions.first?.isRequired, false)
        XCTAssertEqual(store.supertagSchemas.first?.fields.first?.valueType, .boolean)

        store.deleteSupertagFieldDefinition(id: definition.id)

        XCTAssertTrue(store.supertagFieldDefinitions.isEmpty)
        XCTAssertEqual(store.supertagSchemas.count, 1)
        XCTAssertTrue(store.supertagSchemas.first?.fields.isEmpty ?? false)
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

    private func visibleEntityReferenceRow(_ row: [String: String]) -> [String: String] {
        [
            "entity": row["entity"] ?? "",
            "entity_id": row["entity_id"] ?? "",
            "document": row["document"] ?? "",
        ]
    }

    private func visibleQueryRows(_ rows: [[String: String]]) -> [[String: String]] {
        rows.map(visibleQueryRow)
    }

    private func visibleQueryRow(_ row: [String: String]) -> [String: String] {
        row.filter { key, _ in
            key != queryDocumentIDMetadataKey && key != queryEntityIDMetadataKey
        }
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
