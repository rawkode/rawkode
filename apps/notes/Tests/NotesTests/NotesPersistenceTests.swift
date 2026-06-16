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
        XCTAssertEqual(projects.rows, [
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

        let bookmarks = try repository.runQuery("SELECT * FROM bookmarks WHERE name CONTAINS academy")
        XCTAssertEqual(bookmarks.columns, ["id", "name", "supertags", "updated_at"])
        XCTAssertEqual(bookmarks.rows.count, 1)
        XCTAssertEqual(bookmarks.rows.first?["name"], "Rawkode Academy")
        XCTAssertEqual(bookmarks.rows.first?["supertags"], "bookmark, company")
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

        _ = try repository.createDailyNote(date: today)
        _ = try repository.createDailyNote(date: yesterdayStorageDate)
        _ = try repository.createDailyNote(date: twoDaysAgoStorageDate)

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
        XCTAssertEqual(result.rows, [
            [
                "name": "Beta Resource",
                "url": "https://beta.example",
            ],
        ])
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
        XCTAssertEqual(result.rows, [
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
        XCTAssertEqual(result.rows, [
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
        XCTAssertEqual(projectedProperty.rows, [["account": "personal"]])

        let projectedCountProperty = try repository.runQuery(
            "SELECT count FROM bookmarks WHERE name = 'Alpha Resource'"
        )
        XCTAssertEqual(projectedCountProperty.columns, ["count"])
        XCTAssertEqual(projectedCountProperty.rows, [["count": "7"]])
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
        XCTAssertEqual(entities.rows, [
            ["id": roadmapEntityID, "name": "Notes Roadmap", "supertags": ""],
            ["id": existingEntity.id.uuidString, "name": "Rawkode Academy", "supertags": "company"],
        ])

        let references = try repository.runQuery(
            "SELECT entity, entity_id, document FROM backlinks WHERE document = 'Meeting note' ORDER BY entity ASC"
        )
        XCTAssertEqual(references.columns, ["entity", "entity_id", "document"])
        XCTAssertEqual(references.rows, [
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

        document.plainText = "Only [[Notes Roadmap]] remains."
        try repository.upsertDocument(document)

        let refreshedReferences = try repository.runQuery(
            "SELECT entity, document FROM backlinks WHERE document = 'Meeting note' ORDER BY entity ASC"
        )
        XCTAssertEqual(refreshedReferences.rows, [
            ["entity": "Notes Roadmap", "document": "Meeting note"],
        ])
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
        XCTAssertEqual(customers.rows, [
            [
                "id": existingEntity.id.uuidString,
                "name": "Rawkode Academy",
                "supertags": "company, customer",
            ],
        ])

        let projects = try repository.runQuery(
            "SELECT name, supertags FROM projects ORDER BY name ASC"
        )
        XCTAssertEqual(projects.rows, [
            ["name": "Launch Plan", "supertags": "project"],
            ["name": "Notes Roadmap", "supertags": "active, bookmark, project"],
        ])

        let bookmarks = try repository.runQuery("SELECT name FROM bookmarks")
        XCTAssertEqual(bookmarks.rows, [
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
        XCTAssertEqual(projects.rows, [
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
        XCTAssertEqual(updatedProject.rows, [
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
