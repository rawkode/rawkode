import Automerge
import Foundation
import GRDB

public enum LibraryRepositoryError: Error, LocalizedError {
  case pageNotFound
  case pagePurged
  case invalidRecord
  case databaseUnavailable(String)

  public var errorDescription: String? {
    switch self {
    case .pageNotFound: "The page is no longer available."
    case .pagePurged: "This page was permanently removed."
    case .invalidRecord: "The local page record is invalid."
    case .databaseUnavailable(let message): "The local library could not be opened: \(message)"
    }
  }
}

public struct EditorCommit: Codable, Hashable, Sendable {
  public var pageID: PageID
  public var loadGeneration: Int
  public var journalID: String
  public var encodedChanges: Data
  public var advertisedHeads: AutomergeHeads

  public init(
    pageID: PageID,
    loadGeneration: Int,
    journalID: String,
    encodedChanges: Data,
    advertisedHeads: AutomergeHeads
  ) {
    self.pageID = pageID
    self.loadGeneration = loadGeneration
    self.journalID = journalID
    self.encodedChanges = encodedChanges
    self.advertisedHeads = advertisedHeads
  }
}

public struct EditorCommitReceipt: Codable, Hashable, Sendable {
  public var pageID: PageID
  public var journalID: String
  public var heads: AutomergeHeads
  public var dirtyGeneration: Int64
  public var duplicate: Bool
}

public struct PageSuggestion: Codable, Hashable, Sendable, Identifiable {
  public var id: PageID
  public var title: String
  public var kind: PageKind

  public var displaySubtitle: String? {
    switch kind {
    case .calendarEvent(let identity):
      return identity.occurrenceStart.formatted(date: .abbreviated, time: .shortened)
    case .calendarSeries:
      return "Series notes"
    case .daily, .free:
      return nil
    }
  }
}

public struct PurgeMarker: Codable, Hashable, Sendable {
  public var pageID: PageID
  public var generation: Int64
  public var purgedAt: Date
  public var cloudRecord: Data?
}

public struct SavedViewCloudRecord: Sendable {
  public var id: LiveQueryID
  public var definition: LiveQueryDefinition
  public var isDeleted: Bool
  public var sortOrder: Int
  public var modifiedAt: Date
  public var dirtyGeneration: Int64
  public var cloudRecord: Data?
}

public actor LibraryRepository {
  public nonisolated let path: String
  private let database: DatabasePool

  func assistantRead<T: Sendable>(
    _ access: @Sendable (Database) throws -> T
  ) throws -> T {
    try database.read(access)
  }

  public init(path: String) throws {
    self.path = path
    do {
      database = try DatabasePool(path: path)
      try Self.migrator.migrate(database)
      try database.writeWithoutTransaction { db in
        try db.execute(sql: "PRAGMA journal_mode = WAL")
        try db.execute(sql: "PRAGMA synchronous = FULL")
        try db.execute(sql: "PRAGMA foreign_keys = ON")
      }
    } catch {
      throw LibraryRepositoryError.databaseUnavailable(error.localizedDescription)
    }
  }

  public static func defaultLocalPath() throws -> String {
    let manager = FileManager.default
    let base = try manager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let directory = base
      .appendingPathComponent("dev.rawkode.enchiridion", isDirectory: true)
      .appendingPathComponent("vaults", isDirectory: true)
      .appendingPathComponent("local", isDirectory: true)
    try manager.createDirectory(at: directory, withIntermediateDirectories: true)
#if os(iOS)
    try manager.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: directory.path
    )
#endif
    return directory.appendingPathComponent("library.sqlite").path
  }

  public func page(id: PageID) throws -> PageSnapshot? {
    try database.read { db in
      try Self.fetchPage(db, id: id)
    }
  }

  public func pages(
    in section: LibrarySection,
    matching query: String = "",
    now: Date = Date(),
    calendar: Calendar = .current
  ) throws -> [PageSnapshot] {
    try database.read { db in
      var predicates: [String] = []
      var arguments: StatementArguments = []
      switch section {
      case .today:
        let day = DayKey(date: now, calendar: calendar)
        predicates.append("kind_tag = 'daily' AND day_key = ? AND deleted_at IS NULL")
        arguments += [day.rawValue]
      case .calendar:
        predicates.append("0")
      case .allPages:
        predicates.append("deleted_at IS NULL")
      case .pinned:
        predicates.append("is_pinned = 1 AND deleted_at IS NULL")
      case .trash:
        predicates.append("deleted_at IS NOT NULL")
      }

      let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmedQuery.isEmpty {
        predicates.append("(title LIKE ? ESCAPE '\\' OR plain_text LIKE ? ESCAPE '\\')")
        let pattern = "%\(Self.escapeLike(trimmedQuery))%"
        arguments += [pattern, pattern]
      }
      let sql = "SELECT * FROM pages WHERE \(predicates.joined(separator: " AND ")) ORDER BY modified_at DESC"
      return try Row.fetchAll(db, sql: sql, arguments: arguments).map(Self.decodePage)
    }
  }

  @discardableResult
  public func createFreePage(title: String = "Untitled", now: Date = Date()) throws -> PageSnapshot {
    try createPage(id: .free(), kind: .free, title: title, now: now)
  }

  @discardableResult
  public func dailyPage(
    for day: DayKey,
    title: String? = nil,
    now: Date = Date()
  ) throws -> PageSnapshot {
    let id = PageID.daily(day)
    if let existing = try page(id: id) { return existing }
    let displayTitle = title ?? Self.dailyTitle(day)
    return try createPage(id: id, kind: .daily(day), title: displayTitle, now: now)
  }

  @discardableResult
  public func calendarEventPages(
    for event: CalendarEventSnapshot,
    now: Date = Date()
  ) throws -> CalendarEventPages {
    try database.write { db in
      var resolvedEvent = event
      if let series = event.identity.series {
        resolvedEvent.identity.series = try Self.canonicalSeries(db, series: series)
      }

      var createdPageIDs: [PageID] = []
      var seriesPage: PageSnapshot?
      if let series = resolvedEvent.identity.series {
        let result = try Self.ensureSeriesPage(db, series: series, title: event.title, now: now)
        seriesPage = result.page
        if result.created { createdPageIDs.append(result.page.id) }
      }

      let occurrenceKey = resolvedEvent.identity.canonicalOccurrenceKey
      let mappedID = try Self.mappedPageID(
        db,
        eventKeys: [resolvedEvent.identity.stableKey, occurrenceKey]
      )
      let occurrenceID = mappedID ?? PageID.calendarOccurrence(resolvedEvent.identity)
      let existed = try Self.fetchPage(db, id: occurrenceID) != nil
      let occurrence = try Self.createPage(
        db,
        id: occurrenceID,
        kind: .calendarEvent(resolvedEvent.identity),
        title: event.title,
        now: now
      )
      if !existed { createdPageIDs.append(occurrence.id) }
      try Self.mapOccurrencePage(
        db,
        pageID: occurrence.id,
        sourceEventKey: resolvedEvent.identity.stableKey,
        occurrenceKey: occurrenceKey,
        seriesKey: resolvedEvent.identity.series?.canonicalKey
      )
      return CalendarEventPages(
        occurrence: occurrence,
        series: seriesPage,
        createdPageIDs: createdPageIDs
      )
    }
  }

  @discardableResult
  public func calendarEventPage(
    for event: CalendarEventSnapshot,
    now: Date = Date()
  ) throws -> PageSnapshot {
    try calendarEventPages(for: event, now: now).occurrence
  }

  public func calendarSeriesPage(
    for event: CalendarEventSnapshot,
    now: Date = Date()
  ) throws -> PageSnapshot? {
    guard let series = event.identity.series else { return nil }
    return try database.write { db in
      let resolved = try Self.canonicalSeries(db, series: series)
      return try Self.ensureSeriesPage(db, series: resolved, title: event.title, now: now).page
    }
  }

  public func persistEditorCommit(_ commit: EditorCommit, now: Date = Date()) throws -> EditorCommitReceipt {
    try database.write { db in
      guard let current = try Self.fetchPage(db, id: commit.pageID) else {
        throw LibraryRepositoryError.pageNotFound
      }
      if let generation: Int64 = try Int64.fetchOne(
        db,
        sql: "SELECT dirty_generation FROM editor_receipts WHERE journal_id = ? AND page_id = ?",
        arguments: [commit.journalID, commit.pageID.rawValue]
      ) {
        return EditorCommitReceipt(
          pageID: commit.pageID,
          journalID: commit.journalID,
          heads: current.heads,
          dirtyGeneration: generation,
          duplicate: true
        )
      }

      let applied = try PageDocument.applyChanges(
        to: current.document,
        encodedChanges: commit.encodedChanges,
        advertisedHeads: commit.advertisedHeads
      )
      let generation = current.dirtyGeneration + 1
      let updated = PageSnapshot(
        id: current.id,
        kind: current.kind,
        title: applied.projection.title,
        plainText: applied.projection.plainText,
        document: applied.document,
        heads: applied.heads,
        createdAt: current.createdAt,
        modifiedAt: now,
        deletedAt: applied.projection.deletedAt,
        isPinned: applied.projection.isPinned,
        dirtyGeneration: generation,
        objectMetadata: applied.projection.objectMetadata
      )
      try Self.writePage(db, page: updated, cloudDirty: true)
      try Self.replaceReferences(db, pageID: updated.id, references: applied.projection.references)
      try db.execute(
        sql: "INSERT INTO editor_receipts (journal_id,page_id,dirty_generation,committed_at) VALUES (?,?,?,?)",
        arguments: [commit.journalID, commit.pageID.rawValue, generation, now.timeIntervalSince1970]
      )
      return EditorCommitReceipt(
        pageID: commit.pageID,
        journalID: commit.journalID,
        heads: applied.heads,
        dirtyGeneration: generation,
        duplicate: false
      )
    }
  }

  public func togglePinned(pageID: PageID, now: Date = Date()) throws {
    try mutateDocument(pageID: pageID, now: now) { current in
      try PageDocument.setPinned(!current.isPinned, in: current.document)
    }
  }

  public func moveToTrash(pageID: PageID, now: Date = Date()) throws {
    try mutateDocument(pageID: pageID, now: now) { current in
      try PageDocument.setDeleted(now, in: current.document)
    }
  }

  public func restore(pageID: PageID, now: Date = Date()) throws {
    try mutateDocument(pageID: pageID, now: now) { current in
      try PageDocument.setDeleted(nil, in: current.document)
    }
  }

  public func purge(pageID: PageID, now: Date = Date()) throws {
    try database.write { db in
      guard let page = try Self.fetchPage(db, id: pageID) else {
        throw LibraryRepositoryError.pageNotFound
      }
      guard page.deletedAt != nil else { return }
      try db.execute(
        sql: "INSERT OR REPLACE INTO purge_markers (page_id,generation,purged_at,cloud_dirty) VALUES (?,?,?,1)",
        arguments: [pageID.rawValue, page.dirtyGeneration + 1, now.timeIntervalSince1970]
      )
      try db.execute(sql: "DELETE FROM pages WHERE id = ?", arguments: [pageID.rawValue])
    }
  }

  public func suggestions(matching query: String, limit: Int = 8) throws -> [PageSuggestion] {
    try database.read { db in
      let pattern = "%\(Self.escapeLike(query.trimmingCharacters(in: .whitespacesAndNewlines)))%"
      return try Row.fetchAll(
        db,
        sql: "SELECT id,title,kind_json FROM pages WHERE deleted_at IS NULL AND title LIKE ? ESCAPE '\\' ORDER BY modified_at DESC LIMIT ?",
        arguments: [pattern, limit]
      ).compactMap { row in
        guard let id: String = row["id"], let title: String = row["title"],
          let kindData: Data = row["kind_json"],
          let kind = try? JSONDecoder.enchiridion.decode(PageKind.self, from: kindData)
        else { return nil }
        return PageSuggestion(id: PageID(rawValue: id), title: title, kind: kind)
      }
    }
  }

  public func backlinks(to pageID: PageID) throws -> [PageSnapshot] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: "SELECT p.* FROM pages p JOIN page_references r ON r.source_page_id = p.id WHERE r.target_page_id = ? AND p.deleted_at IS NULL ORDER BY p.modified_at DESC",
        arguments: [pageID.rawValue]
      ).map(Self.decodePage)
    }
  }

  public func supertags() throws -> [SupertagDefinition] {
    try database.read { db in
      try Row.fetchAll(db, sql: "SELECT definition_json FROM supertag_schemas WHERE deleted = 0 ORDER BY sort_order,name")
        .compactMap { row in
          guard let data: Data = row["definition_json"] else { return nil }
          return try? JSONDecoder.enchiridion.decode(SupertagDefinition.self, from: data)
        }
    }
  }

  public func pages(with supertagID: SupertagID) throws -> [PageSnapshot] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: """
          SELECT p.* FROM pages p
          JOIN page_supertags s ON s.page_id = p.id
          WHERE s.supertag_id = ? AND p.deleted_at IS NULL
          ORDER BY p.title COLLATE NOCASE, p.modified_at DESC
          """,
        arguments: [supertagID.rawValue]
      ).map(Self.decodePage)
    }
  }

  public func taggedSuggestions(
    matching query: String,
    supertagID: SupertagID,
    limit: Int = 8
  ) throws -> [PageSuggestion] {
    try database.read { db in
      let pattern = "%\(Self.escapeLike(query.trimmingCharacters(in: .whitespacesAndNewlines)))%"
      return try Row.fetchAll(
        db,
        sql: """
          SELECT p.id,p.title,p.kind_json FROM pages p
          JOIN page_supertags s ON s.page_id = p.id
          WHERE s.supertag_id = ? AND p.deleted_at IS NULL AND p.title LIKE ? ESCAPE '\\'
          ORDER BY p.modified_at DESC LIMIT ?
          """,
        arguments: [supertagID.rawValue, pattern, limit]
      ).compactMap(Self.decodeSuggestion)
    }
  }

  @discardableResult
  public func createTaggedPage(
    title: String,
    supertagID: SupertagID,
    id: PageID? = nil,
    now: Date = Date()
  ) throws -> PageSnapshot {
    let page = try createPage(id: id ?? .free(), kind: .free, title: title, now: now)
    try addSupertag(supertagID, to: page.id, now: now)
    guard let updated = try self.page(id: page.id) else { throw LibraryRepositoryError.pageNotFound }
    return updated
  }

  public func addSupertag(_ supertagID: SupertagID, to pageID: PageID, now: Date = Date()) throws {
    guard try supertags().contains(where: { $0.id == supertagID }) else {
      throw LibraryRepositoryError.invalidRecord
    }
    try mutateDocument(pageID: pageID, now: now) { current in
      try PageDocument.addSupertag(supertagID, in: current.document)
    }
  }

  public func removeSupertag(_ supertagID: SupertagID, from pageID: PageID, now: Date = Date()) throws {
    try mutateDocument(pageID: pageID, now: now) { current in
      try PageDocument.removeSupertag(supertagID, in: current.document)
    }
  }

  public func setProperty(
    pageID: PageID,
    key: SupertagPropertyKey,
    values: [SupertagValue],
    now: Date = Date()
  ) throws {
    guard let schema = try supertags().first(where: { $0.id == key.supertagID }),
      let field = schema.fields.first(where: { $0.id == key.fieldID && !$0.isDeleted })
    else { throw LibraryRepositoryError.invalidRecord }
    try Self.validate(values: values, for: field)
    try mutateDocument(pageID: pageID, now: now) { current in
      try PageDocument.setProperty(key: key, values: values, in: current.document)
    }
  }

  public func saveSupertag(_ definition: SupertagDefinition) throws {
    guard !definition.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw LibraryRepositoryError.invalidRecord
    }
    try database.write { db in
      if let data = try Data.fetchOne(
        db,
        sql: "SELECT definition_json FROM supertag_schemas WHERE id = ?",
        arguments: [definition.id.rawValue]
      ), let previous = try? JSONDecoder.enchiridion.decode(SupertagDefinition.self, from: data) {
        for field in definition.fields {
          guard let old = previous.fields.first(where: { $0.id == field.id }),
            old.type != field.type || old.allowsMultiple != field.allowsMultiple
          else { continue }
          let count = try Int.fetchOne(
            db,
            sql: "SELECT COUNT(*) FROM page_property_values WHERE supertag_id = ? AND field_id = ?",
            arguments: [definition.id.rawValue, field.id.rawValue]
          ) ?? 0
          guard count == 0 else { throw LibraryRepositoryError.invalidRecord }
        }
      }
      try db.execute(
        sql: """
          INSERT INTO supertag_schemas (id,name,definition_json,deleted,sort_order)
          VALUES (?,?,?,?,COALESCE((SELECT sort_order FROM supertag_schemas WHERE id = ?),999))
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,definition_json=excluded.definition_json,deleted=excluded.deleted
          """,
        arguments: [
          definition.id.rawValue,
          definition.name,
          try JSONEncoder.enchiridion.encode(definition),
          definition.isDeleted,
          definition.id.rawValue,
        ]
      )
    }
  }

  public func savedViews() throws -> [LiveQueryDefinition] {
    try database.read { db in
      try Row.fetchAll(db, sql: "SELECT definition_json FROM saved_query_views WHERE deleted = 0 ORDER BY sort_order,name")
        .compactMap { row in
          guard let data: Data = row["definition_json"] else { return nil }
          return try? JSONDecoder.enchiridion.decode(LiveQueryDefinition.self, from: data)
        }
    }
  }

  public func saveView(_ definition: LiveQueryDefinition, now: Date = Date()) throws {
    _ = try DomainQueryCodec.parse(definition.domainSQL, id: definition.id, name: definition.name)
    try database.write { db in
      try db.execute(
        sql: """
          INSERT INTO saved_query_views
            (id,name,definition_json,deleted,sort_order,modified_at,dirty_generation,cloud_dirty)
          VALUES (?,?,?,?,COALESCE((SELECT sort_order FROM saved_query_views WHERE id = ?),999),?,1,1)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            definition_json=excluded.definition_json,
            deleted=excluded.deleted,
            modified_at=excluded.modified_at,
            dirty_generation=saved_query_views.dirty_generation + 1,
            cloud_dirty=1
          """,
        arguments: [
          definition.id.rawValue,
          definition.name,
          try JSONEncoder.enchiridion.encode(definition),
          false,
          definition.id.rawValue,
          now.timeIntervalSince1970,
        ]
      )
    }
  }

  public func deleteView(_ id: LiveQueryID, now: Date = Date()) throws {
    try database.write { db in
      try db.execute(
        sql: """
          UPDATE saved_query_views
          SET deleted = 1, modified_at = ?, dirty_generation = dirty_generation + 1, cloud_dirty = 1
          WHERE id = ?
          """,
        arguments: [now.timeIntervalSince1970, id.rawValue]
      )
    }
  }

  public func dirtyViews() throws -> [SavedViewCloudRecord] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: "SELECT * FROM saved_query_views WHERE cloud_dirty = 1 ORDER BY modified_at"
      ).compactMap(Self.decodeSavedViewCloudRecord)
    }
  }

  public func savedViewCloudRecord(id: LiveQueryID) throws -> SavedViewCloudRecord? {
    try database.read { db in
      try Row.fetchOne(db, sql: "SELECT * FROM saved_query_views WHERE id = ?", arguments: [id.rawValue])
        .flatMap(Self.decodeSavedViewCloudRecord)
    }
  }

  public func markViewCloudSaved(id: LiveQueryID, systemFields: Data) throws {
    try database.write { db in
      try db.execute(
        sql: """
          UPDATE saved_query_views
          SET cloud_record = ?, cloud_dirty = 0, cloud_synced_generation = dirty_generation
          WHERE id = ?
          """,
        arguments: [systemFields, id.rawValue]
      )
    }
  }

  @discardableResult
  public func mergeCloudView(
    id: LiveQueryID,
    definition: LiveQueryDefinition,
    isDeleted: Bool,
    sortOrder: Int,
    modifiedAt: Date,
    dirtyGeneration: Int64,
    systemFields: Data
  ) throws -> Bool {
    try database.write { db in
      var normalizedDefinition = definition
      normalizedDefinition.id = id
      if let row = try Row.fetchOne(
        db, sql: "SELECT modified_at,dirty_generation FROM saved_query_views WHERE id = ?",
        arguments: [id.rawValue]
      ) {
        let localModified = Date(timeIntervalSince1970: row["modified_at"] ?? 0)
        let localGeneration: Int64 = row["dirty_generation"] ?? 0
        if localModified > modifiedAt || (localModified == modifiedAt && localGeneration > dirtyGeneration) {
          try db.execute(
            sql: "UPDATE saved_query_views SET cloud_record = ?, cloud_dirty = 1 WHERE id = ?",
            arguments: [systemFields, id.rawValue]
          )
          return true
        }
      }
      try db.execute(
        sql: """
          INSERT INTO saved_query_views
            (id,name,definition_json,deleted,sort_order,modified_at,dirty_generation,cloud_dirty,cloud_synced_generation,cloud_record)
          VALUES (?,?,?,?,?,?,?,0,?,?)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            definition_json=excluded.definition_json,
            deleted=excluded.deleted,
            sort_order=excluded.sort_order,
            modified_at=excluded.modified_at,
            dirty_generation=excluded.dirty_generation,
            cloud_dirty=0,
            cloud_synced_generation=excluded.dirty_generation,
            cloud_record=excluded.cloud_record
          """,
        arguments: [
          id.rawValue, normalizedDefinition.name, try JSONEncoder.enchiridion.encode(normalizedDefinition),
          isDeleted, sortOrder, modifiedAt.timeIntervalSince1970, dirtyGeneration,
          dirtyGeneration, systemFields,
        ]
      )
      return false
    }
  }

  public func run(_ definition: LiveQueryDefinition) throws -> [LiveQueryItem] {
    try database.read { db in
      var items: [LiveQueryItem] = []
      switch definition.source {
      case .pages:
        items = try Row.fetchAll(
          db,
          sql: "SELECT * FROM pages WHERE deleted_at IS NULL"
        ).map { .page(try Self.decodePage($0)) }
      case .supertag(let tagID):
        items = try Row.fetchAll(
          db,
          sql: """
            SELECT p.* FROM pages p JOIN page_supertags s ON s.page_id = p.id
            WHERE s.supertag_id = ? AND p.deleted_at IS NULL
            """,
          arguments: [tagID.rawValue]
        ).map { .page(try Self.decodePage($0)) }
      case .calendarEvents:
        items = try Self.liveCalendarItems(db, limit: 5_000)
      case .workCalendar:
        let startOfToday = Calendar.current.startOfDay(for: Date())
        items = try Self.liveCalendarItems(db, limit: 5_000, startingAt: startOfToday)
        let pages = try Row.fetchAll(
          db,
          sql: """
            SELECT DISTINCT p.*
            FROM pages p
            JOIN page_supertags s ON s.page_id = p.id
            JOIN page_property_values v
              ON v.page_id = p.id AND v.supertag_id = s.supertag_id
            WHERE p.deleted_at IS NULL AND v.date_value >= ? AND (
              (s.supertag_id = ? AND v.field_id = 'due') OR
              (s.supertag_id = ? AND v.field_id IN ('start-date','due-date'))
            )
            """,
          arguments: [
            startOfToday.timeIntervalSince1970,
            BuiltInSupertags.task.rawValue,
            BuiltInSupertags.project.rawValue,
          ]
        ).map { LiveQueryItem.page(try Self.decodePage($0)) }
        items.append(contentsOf: pages)
      }
      items = items.filter { item in
        definition.filters.allSatisfy { Self.matches($0, item: item, definition: definition) }
      }
      items.sort { Self.isOrderedBefore($0, $1, definition: definition) }
      return Array(items.prefix(definition.limit))
    }
  }

  public func replaceCalendarProjection(
    _ events: [CalendarEventSnapshot],
    provider: String,
    refreshedAt: Date = Date()
  ) throws {
    try database.write { db in
      try db.execute(sql: "UPDATE calendar_events SET active = 0 WHERE provider = ?", arguments: [provider])
      for sourceEvent in events {
        var event = sourceEvent
        if let series = event.identity.series {
          event.identity.series = try Self.resolveSeries(db, event: event, series: series)
        }
        try db.execute(
          sql: """
            INSERT INTO calendar_events
              (event_key,provider,event_json,start_at,end_at,active,refreshed_at,
               series_source_key,series_canonical_key)
            VALUES (?,?,?,?,?,1,?,?,?)
            ON CONFLICT(event_key) DO UPDATE SET
              event_json=excluded.event_json,
              start_at=excluded.start_at,
              end_at=excluded.end_at,
              active=1,
              refreshed_at=excluded.refreshed_at,
              series_source_key=excluded.series_source_key,
              series_canonical_key=excluded.series_canonical_key
            """,
          arguments: [
            Self.storageKey(event.identity.stableKey),
            provider,
            try JSONEncoder.enchiridion.encode(event),
            event.startDate.timeIntervalSince1970,
            event.endDate.timeIntervalSince1970,
            refreshedAt.timeIntervalSince1970,
            event.identity.series.map { Self.storageKey($0.sourceKey) },
            event.identity.series.map { Self.storageKey($0.canonicalKey) },
          ]
        )
        try Self.replaceAttendeeProjection(db, event: event, now: refreshedAt)
      }
      try db.execute(
        sql: "DELETE FROM calendar_events WHERE provider = ? AND active = 0 AND event_key NOT IN (SELECT event_key FROM event_page_map)",
        arguments: [provider]
      )
    }
  }

  public func calendarEvents(from start: Date, through end: Date) throws -> [CalendarEventSnapshot] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: """
          SELECT e.event_json,e.active,COALESCE(a.canonical_key,e.series_canonical_key) AS canonical_key
          FROM calendar_events e
          LEFT JOIN calendar_series_aliases a ON a.source_key = e.series_source_key
          WHERE e.start_at < ? AND e.end_at > ?
          ORDER BY e.start_at
          """,
        arguments: [end.timeIntervalSince1970, start.timeIntervalSince1970]
      ).compactMap { row in
        guard let data: Data = row["event_json"],
          var event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data)
        else { return nil }
        let active: Bool = row["active"] ?? false
        event.isDetached = event.isDetached || !active
        if let canonicalKey: String = row["canonical_key"], let series = event.identity.series {
          event.identity.series = series.resolved(to: Self.rawKey(canonicalKey))
        }
        return event
      }
    }
  }

  public func calendarPageContexts() throws -> [PageID: CalendarPageContext] {
    try database.read { db in
      let pages = try Row.fetchAll(
        db,
        sql: "SELECT * FROM pages WHERE kind_tag IN ('calendarEvent','calendarSeries')"
      ).map(Self.decodePage)
      var contexts: [PageID: CalendarPageContext] = [:]

      for page in pages {
        switch page.kind {
        case .calendarEvent(let identity):
          let event = try Self.eventForPage(db, pageID: page.id)
          let series = event?.identity.series ?? identity.series
          let seriesPageID = try series.flatMap {
            try String.fetchOne(
              db,
              sql: "SELECT page_id FROM series_page_map WHERE series_key = ?",
              arguments: [Self.storageKey($0.canonicalKey)]
            ).map { PageID(rawValue: $0) }
          }
          let fallbackEvent = CalendarEventSnapshot(
            identity: identity,
            title: page.displayTitle,
            startDate: identity.occurrenceStart,
            endDate: identity.occurrenceStart,
            isAllDay: false,
            location: nil,
            notes: nil,
            url: nil,
            calendarTitle: "Calendar",
            isDetached: true
          )
          contexts[page.id] = CalendarPageContext(
            kind: .occurrence,
            event: event ?? fallbackEvent,
            series: series,
            seriesPageID: seriesPageID,
            calendarTitle: event?.calendarTitle,
            sourceUnavailable: event == nil || event?.isDetached == true
          )

        case .calendarSeries(let series):
          let occurrences = try Self.occurrenceNotes(db, seriesKey: series.canonicalKey)
          let calendarTitle = try Self.calendarTitle(db, seriesKey: series.canonicalKey)
          contexts[page.id] = CalendarPageContext(
            kind: .series,
            series: series,
            seriesPageID: page.id,
            calendarTitle: calendarTitle,
            occurrences: occurrences,
            sourceUnavailable: calendarTitle == nil
          )

        case .daily, .free:
          break
        }
      }
      return contexts
    }
  }

  public func dirtyPages() throws -> [PageSnapshot] {
    try database.read { db in
      try Row.fetchAll(db, sql: "SELECT * FROM pages WHERE cloud_dirty = 1 ORDER BY modified_at")
        .map(Self.decodePage)
    }
  }

  public func cloudRecordMetadata(pageID: PageID) throws -> Data? {
    try database.read { db in
      try Data.fetchOne(
        db,
        sql: "SELECT cloud_record FROM pages WHERE id = ?",
        arguments: [pageID.rawValue]
      )
    }
  }

  public func cloudAccountID() throws -> String? {
    try database.read { db in
      guard let data = try Data.fetchOne(db, sql: "SELECT value FROM settings WHERE key = 'cloud.account-id'") else {
        return nil
      }
      return String(data: data, encoding: .utf8)
    }
  }

  public func bindCloudAccountID(_ accountID: String) throws {
    try database.write { db in
      if let data = try Data.fetchOne(db, sql: "SELECT value FROM settings WHERE key = 'cloud.account-id'"),
        String(data: data, encoding: .utf8) != accountID
      {
        throw LibraryRepositoryError.databaseUnavailable("This vault belongs to a different iCloud account.")
      }
      try db.execute(
        sql: "INSERT OR IGNORE INTO settings (key,value) VALUES ('cloud.account-id',?)",
        arguments: [Data(accountID.utf8)]
      )
    }
  }

  public func markCloudSaved(pageID: PageID, systemFields: Data) throws {
    try database.write { db in
      try db.execute(
        sql: "UPDATE pages SET cloud_record = ?, cloud_dirty = 0, cloud_synced_generation = dirty_generation WHERE id = ?",
        arguments: [systemFields, pageID.rawValue]
      )
    }
  }

  public func dirtyPurgeMarkers() throws -> [PurgeMarker] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: "SELECT page_id,generation,purged_at,cloud_record FROM purge_markers WHERE cloud_dirty = 1"
      ).compactMap { row in
        guard let pageID: String = row["page_id"],
          let generation: Int64 = row["generation"],
          let purgedAt: Double = row["purged_at"]
        else { return nil }
        return PurgeMarker(
          pageID: PageID(rawValue: pageID),
          generation: generation,
          purgedAt: Date(timeIntervalSince1970: purgedAt),
          cloudRecord: row["cloud_record"]
        )
      }
    }
  }

  public func purgeMarker(pageID: PageID) throws -> PurgeMarker? {
    try database.read { db in
      guard let row = try Row.fetchOne(
        db,
        sql: "SELECT page_id,generation,purged_at,cloud_record FROM purge_markers WHERE page_id = ?",
        arguments: [pageID.rawValue]
      ), let generation: Int64 = row["generation"], let purgedAt: Double = row["purged_at"] else {
        return nil
      }
      return PurgeMarker(
        pageID: pageID,
        generation: generation,
        purgedAt: Date(timeIntervalSince1970: purgedAt),
        cloudRecord: row["cloud_record"]
      )
    }
  }

  public func markPurgeCloudSaved(pageID: PageID, systemFields: Data) throws {
    try database.write { db in
      try db.execute(
        sql: "UPDATE purge_markers SET cloud_record = ?, cloud_dirty = 0 WHERE page_id = ?",
        arguments: [systemFields, pageID.rawValue]
      )
    }
  }

  public func applyCloudPurge(
    pageID: PageID,
    generation: Int64,
    purgedAt: Date,
    systemFields: Data
  ) throws {
    try database.write { db in
      let localGeneration: Int64 = try Int64.fetchOne(
        db,
        sql: "SELECT generation FROM purge_markers WHERE page_id = ?",
        arguments: [pageID.rawValue]
      ) ?? 0
      guard generation >= localGeneration else { return }
      try db.execute(sql: "DELETE FROM pages WHERE id = ?", arguments: [pageID.rawValue])
      try db.execute(
        sql: "INSERT OR REPLACE INTO purge_markers (page_id,generation,purged_at,cloud_dirty,cloud_record) VALUES (?,?,?,0,?)",
        arguments: [pageID.rawValue, generation, purgedAt.timeIntervalSince1970, systemFields]
      )
    }
  }

  public func mergeCloudPage(
    pageID: PageID,
    kind: PageKind,
    remoteDocument: Data,
    systemFields: Data,
    now: Date = Date()
  ) throws -> PageSnapshot {
    try database.write { db in
      let page: PageSnapshot
      if let local = try Self.fetchPage(db, id: pageID) {
        let merged = try PageDocument.merge(local: local.document, remote: remoteDocument, pageID: pageID)
        page = PageSnapshot(
          id: pageID,
          kind: local.kind,
          title: merged.projection.title,
          plainText: merged.projection.plainText,
          document: merged.document,
          heads: merged.heads,
          createdAt: local.createdAt,
          modifiedAt: now,
          deletedAt: merged.projection.deletedAt,
          isPinned: merged.projection.isPinned,
          dirtyGeneration: local.dirtyGeneration + (merged.document == remoteDocument ? 0 : 1),
          objectMetadata: merged.projection.objectMetadata
        )
        try Self.writePage(db, page: page, cloudDirty: merged.document != remoteDocument, cloudRecord: systemFields)
        try Self.replaceReferences(db, pageID: pageID, references: merged.projection.references)
      } else {
        let projection = try PageDocument.inspect(remoteDocument, pageID: pageID)
        page = PageSnapshot(
          id: pageID,
          kind: kind,
          title: projection.title,
          plainText: projection.plainText,
          document: remoteDocument,
          heads: try Self.documentHeads(remoteDocument),
          createdAt: now,
          modifiedAt: now,
          deletedAt: projection.deletedAt,
          isPinned: projection.isPinned,
          dirtyGeneration: 0,
          objectMetadata: projection.objectMetadata
        )
        try Self.writePage(db, page: page, cloudDirty: false, cloudRecord: systemFields)
        try Self.replaceReferences(db, pageID: pageID, references: projection.references)
      }
      return page
    }
  }

  public func cloudState() throws -> Data? {
    try setting(key: "cloudkit.state")
  }

  public func setCloudState(_ data: Data) throws {
    try setSetting(key: "cloudkit.state", value: data)
  }

  public func setting(key: String) throws -> Data? {
    try database.read { db in
      try Data.fetchOne(db, sql: "SELECT value FROM settings WHERE key = ?", arguments: [key])
    }
  }

  public func setSetting(key: String, value: Data) throws {
    try database.write { db in
      try db.execute(
        sql: "INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)",
        arguments: [key, value]
      )
    }
  }

  private static func resolveSeries(
    _ db: Database,
    event: CalendarEventSnapshot,
    series: CalendarSeriesIdentity
  ) throws -> CalendarSeriesIdentity {
    var canonical = try String.fetchOne(
      db,
      sql: "SELECT canonical_key FROM calendar_series_aliases WHERE source_key = ?",
      arguments: [storageKey(series.sourceKey)]
    ).map(rawKey) ?? series.preferredCanonicalKey

    let candidates = try Row.fetchAll(
      db,
      sql: """
        SELECT event_json,series_canonical_key
        FROM calendar_events
        WHERE active = 1 AND provider <> ? AND series_source_key IS NOT NULL
        ORDER BY start_at
        """,
      arguments: [event.identity.provider]
    )
    for row in candidates {
      guard let data: Data = row["event_json"],
        let candidate = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data),
        let candidateSeries = candidate.identity.series
      else { continue }
      let exactIdentifierMatch = series.preferredCanonicalKey == candidateSeries.preferredCanonicalKey
      guard exactIdentifierMatch || CalendarSeriesMatcher.likelyMatch(event, candidate) else { continue }

      let candidateCanonical = (row["series_canonical_key"] as String?).map(rawKey)
        ?? candidateSeries.canonicalKey
      if event.identity.provider == "google" {
        canonical = series.preferredCanonicalKey
      } else if candidate.identity.provider == "google" {
        canonical = candidateSeries.preferredCanonicalKey
      } else {
        canonical = min(canonical, candidateCanonical)
      }
      try db.execute(
        sql: "UPDATE calendar_series_aliases SET canonical_key = ? WHERE canonical_key IN (?,?)",
        arguments: [storageKey(canonical), storageKey(candidateCanonical), storageKey(series.preferredCanonicalKey)]
      )
      try db.execute(
        sql: "INSERT OR REPLACE INTO calendar_series_aliases (source_key,canonical_key) VALUES (?,?)",
        arguments: [storageKey(candidateSeries.sourceKey), storageKey(canonical)]
      )
      break
    }
    try db.execute(
      sql: "INSERT OR REPLACE INTO calendar_series_aliases (source_key,canonical_key) VALUES (?,?)",
      arguments: [storageKey(series.sourceKey), storageKey(canonical)]
    )
    return series.resolved(to: canonical)
  }

  private static func replaceAttendeeProjection(
    _ db: Database,
    event: CalendarEventSnapshot,
    now: Date
  ) throws {
    let eventKey = storageKey(event.identity.stableKey)
    try db.execute(sql: "DELETE FROM calendar_event_attendees WHERE event_key = ?", arguments: [eventKey])
    var identities = event.attendees ?? []
    if let organizer = event.organizer, !identities.contains(where: { $0.id == organizer.id }) {
      identities.append(organizer)
    }
    var seenEmails: Set<String> = []
    for identity in identities where !identity.isCurrentUser {
      guard let email = identity.email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
        email.contains("@"), seenEmails.insert(email).inserted
      else { continue }
      let pageID = PageID.person(email: email)
      let displayName = identity.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
      let title = (displayName?.isEmpty == false ? displayName : nil)
        ?? email.split(separator: "@").first.map(String.init) ?? email
      var page = try createPage(db, id: pageID, kind: .free, title: title, now: now)
      let emailKey = SupertagPropertyKey(
        supertagID: BuiltInSupertags.person,
        fieldID: .init(rawValue: "email")
      )
      let alreadyTagged = page.objectMetadata.supertagIDs.contains(BuiltInSupertags.person)
      let hasEmail = page.objectMetadata.properties[emailKey]?.contains(.email(email)) == true
      if !alreadyTagged || !hasEmail {
        var mutation = try PageDocument.addSupertag(BuiltInSupertags.person, in: page.document)
        if !hasEmail {
          var emails = mutation.projection.objectMetadata.properties[emailKey] ?? []
          emails.append(.email(email))
          mutation = try PageDocument.setProperty(key: emailKey, values: emails, in: mutation.document)
        }
        page = PageSnapshot(
          id: page.id,
          kind: page.kind,
          title: mutation.projection.title,
          plainText: mutation.projection.plainText,
          document: mutation.document,
          heads: mutation.heads,
          createdAt: page.createdAt,
          modifiedAt: now,
          deletedAt: page.deletedAt,
          isPinned: page.isPinned,
          dirtyGeneration: page.dirtyGeneration + 1,
          objectMetadata: mutation.projection.objectMetadata
        )
        try writePage(db, page: page, cloudDirty: true)
      }
      try db.execute(
        sql: """
          INSERT INTO calendar_event_attendees
            (event_key,person_page_id,email,role,response_status)
          VALUES (?,?,?,?,?)
          """,
        arguments: [eventKey, pageID.rawValue, email, identity.role, identity.responseStatus]
      )
    }
  }

  private static func canonicalSeries(
    _ db: Database,
    series: CalendarSeriesIdentity
  ) throws -> CalendarSeriesIdentity {
    let canonical = try String.fetchOne(
      db,
      sql: "SELECT canonical_key FROM calendar_series_aliases WHERE source_key = ?",
      arguments: [storageKey(series.sourceKey)]
    ).map(rawKey) ?? series.canonicalKey
    try db.execute(
      sql: "INSERT OR IGNORE INTO calendar_series_aliases (source_key,canonical_key) VALUES (?,?)",
      arguments: [storageKey(series.sourceKey), storageKey(canonical)]
    )
    return series.resolved(to: canonical)
  }

  private static func ensureSeriesPage(
    _ db: Database,
    series: CalendarSeriesIdentity,
    title: String,
    now: Date
  ) throws -> (page: PageSnapshot, created: Bool) {
    let mapped: String? = try String.fetchOne(
      db,
      sql: """
        SELECT page_id FROM series_page_map
        WHERE series_key = ?
           OR series_key IN (
             SELECT source_key FROM calendar_series_aliases WHERE canonical_key = ?
           )
        LIMIT 1
        """,
      arguments: [storageKey(series.canonicalKey), storageKey(series.canonicalKey)]
    )
    if let mapped, let page = try fetchPage(db, id: PageID(rawValue: mapped)) {
      try db.execute(
        sql: "INSERT OR REPLACE INTO series_page_map (series_key,page_id) VALUES (?,?)",
        arguments: [storageKey(series.canonicalKey), page.id.rawValue]
      )
      return (page, false)
    }
    let id = PageID.calendarSeries(series)
    let existed = try fetchPage(db, id: id) != nil
    let page = try createPage(db, id: id, kind: .calendarSeries(series), title: title, now: now)
    try db.execute(
      sql: "INSERT OR REPLACE INTO series_page_map (series_key,page_id) VALUES (?,?)",
      arguments: [storageKey(series.canonicalKey), page.id.rawValue]
    )
    return (page, !existed)
  }

  private static func mappedPageID(_ db: Database, eventKeys: [String]) throws -> PageID? {
    for key in Set(eventKeys) {
      if let value = try String.fetchOne(
        db,
        sql: "SELECT page_id FROM event_page_map WHERE event_key = ? OR occurrence_key = ? LIMIT 1",
        arguments: [storageKey(key), storageKey(key)]
      ) {
        return PageID(rawValue: value)
      }
    }
    return nil
  }

  private static func mapOccurrencePage(
    _ db: Database,
    pageID: PageID,
    sourceEventKey: String,
    occurrenceKey: String,
    seriesKey: String?
  ) throws {
    for eventKey in Set([sourceEventKey, occurrenceKey]) {
      try db.execute(
        sql: "INSERT OR REPLACE INTO event_page_map (event_key,occurrence_key,series_key,page_id) VALUES (?,?,?,?)",
        arguments: [
          storageKey(eventKey),
          storageKey(occurrenceKey),
          seriesKey.map(storageKey),
          pageID.rawValue,
        ]
      )
    }
  }

  private static func eventForPage(_ db: Database, pageID: PageID) throws -> CalendarEventSnapshot? {
    guard let row = try Row.fetchOne(
      db,
      sql: """
        SELECT e.event_json,e.active,COALESCE(a.canonical_key,e.series_canonical_key) AS canonical_key
        FROM event_page_map m
        JOIN calendar_events e ON e.event_key = m.event_key
        LEFT JOIN calendar_series_aliases a ON a.source_key = e.series_source_key
        WHERE m.page_id = ?
        ORDER BY e.active DESC, CASE e.provider WHEN 'google' THEN 0 ELSE 1 END
        LIMIT 1
        """,
      arguments: [pageID.rawValue]
    ), let data: Data = row["event_json"],
      var event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data)
    else { return nil }
    let active: Bool = row["active"] ?? false
    event.isDetached = event.isDetached || !active
    if let canonical: String = row["canonical_key"], let series = event.identity.series {
      event.identity.series = series.resolved(to: rawKey(canonical))
    }
    return event
  }

  private static func occurrenceNotes(
    _ db: Database,
    seriesKey: String
  ) throws -> [CalendarOccurrenceNote] {
    let pages = try Row.fetchAll(
      db,
      sql: """
        SELECT DISTINCT p.*
        FROM pages p
        JOIN event_page_map m ON m.page_id = p.id
        WHERE m.series_key = ? AND p.kind_tag = 'calendarEvent' AND p.deleted_at IS NULL
        """,
      arguments: [storageKey(seriesKey)]
    ).map(decodePage)
    return try pages.compactMap { page in
      guard case .calendarEvent(let identity) = page.kind else { return nil }
      let event = try eventForPage(db, pageID: page.id)
      return CalendarOccurrenceNote(
        pageID: page.id,
        title: page.displayTitle,
        preview: page.preview,
        startDate: event?.startDate ?? identity.occurrenceStart,
        endDate: event?.endDate,
        isAllDay: event?.isAllDay ?? false
      )
    }.sorted { $0.startDate > $1.startDate }
  }

  private static func calendarTitle(_ db: Database, seriesKey: String) throws -> String? {
    let rows = try Row.fetchAll(
      db,
      sql: """
        SELECT e.event_json
        FROM calendar_events e
        LEFT JOIN calendar_series_aliases a ON a.source_key = e.series_source_key
        WHERE COALESCE(a.canonical_key, e.series_canonical_key) = ? AND e.active = 1
        ORDER BY e.start_at
        LIMIT 1
        """,
      arguments: [storageKey(seriesKey)]
    )
    guard let data: Data = rows.first?["event_json"],
      let event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data)
    else { return nil }
    return event.calendarTitle
  }

  private static func storageKey(_ value: String) -> String {
    Data(value.utf8).base64EncodedString()
  }

  private static func rawKey(_ value: String) -> String {
    guard let data = Data(base64Encoded: value), let decoded = String(data: data, encoding: .utf8) else {
      return value
    }
    return decoded
  }

  private func createPage(
    id: PageID,
    kind: PageKind,
    title: String,
    now: Date
  ) throws -> PageSnapshot {
    try database.write { db in
      try Self.createPage(db, id: id, kind: kind, title: title, now: now)
    }
  }

  private static func createPage(
    _ db: Database,
    id: PageID,
    kind: PageKind,
    title: String,
    now: Date
  ) throws -> PageSnapshot {
    if try Bool.fetchOne(
      db,
      sql: "SELECT EXISTS(SELECT 1 FROM purge_markers WHERE page_id = ?)",
      arguments: [id.rawValue]
    ) == true {
      throw LibraryRepositoryError.pagePurged
    }
    if let existing = try fetchPage(db, id: id) { return existing }
    let created = try PageDocument.create(id: id, kind: kind, title: title, createdAt: now)
    let page = PageSnapshot(
      id: id,
      kind: kind,
      title: title,
      plainText: "",
      document: created.document,
      heads: created.heads,
      createdAt: now,
      modifiedAt: now,
      dirtyGeneration: 1,
      objectMetadata: .init()
    )
    try writePage(db, page: page, cloudDirty: true)
    return page
  }

  private func mutateDocument(
    pageID: PageID,
    now: Date,
    mutation: (PageSnapshot) throws -> (
      document: Data,
      heads: AutomergeHeads,
      projection: PageDocumentProjection
    )
  ) throws {
    try database.write { db in
      guard let current = try Self.fetchPage(db, id: pageID) else {
        throw LibraryRepositoryError.pageNotFound
      }
      let result = try mutation(current)
      let updated = PageSnapshot(
        id: current.id,
        kind: current.kind,
        title: result.projection.title,
        plainText: result.projection.plainText,
        document: result.document,
        heads: result.heads,
        createdAt: current.createdAt,
        modifiedAt: now,
        deletedAt: result.projection.deletedAt,
        isPinned: result.projection.isPinned,
        dirtyGeneration: current.dirtyGeneration + 1,
        objectMetadata: result.projection.objectMetadata
      )
      try Self.writePage(db, page: updated, cloudDirty: true)
      try Self.replaceReferences(db, pageID: pageID, references: result.projection.references)
    }
  }

  private static let migrator: DatabaseMigrator = {
    var migrator = DatabaseMigrator()
    migrator.registerMigration("v1-local-authority") { db in
      try db.create(table: "pages") { table in
        table.column("id", .text).primaryKey()
        table.column("kind_tag", .text).notNull()
        table.column("kind_json", .blob).notNull()
        table.column("day_key", .text)
        table.column("title", .text).notNull()
        table.column("plain_text", .text).notNull()
        table.column("document", .blob).notNull()
        table.column("heads_json", .blob).notNull()
        table.column("created_at", .double).notNull()
        table.column("modified_at", .double).notNull().indexed()
        table.column("deleted_at", .double).indexed()
        table.column("is_pinned", .boolean).notNull().defaults(to: false)
        table.column("dirty_generation", .integer).notNull().defaults(to: 0)
        table.column("cloud_dirty", .boolean).notNull().defaults(to: true).indexed()
        table.column("cloud_synced_generation", .integer).notNull().defaults(to: 0)
        table.column("cloud_record", .blob)
      }
      try db.create(table: "page_references") { table in
        table.column("source_page_id", .text).notNull()
          .references("pages", onDelete: .cascade)
        table.column("target_page_id", .text).notNull().indexed()
        table.column("fallback_label", .text).notNull()
        table.primaryKey(["source_page_id", "target_page_id"])
      }
      try db.create(table: "editor_receipts") { table in
        table.column("journal_id", .text).notNull()
        table.column("page_id", .text).notNull()
          .references("pages", onDelete: .cascade)
        table.column("dirty_generation", .integer).notNull()
        table.column("committed_at", .double).notNull()
        table.primaryKey(["journal_id", "page_id"])
      }
      try db.create(table: "purge_markers") { table in
        table.column("page_id", .text).primaryKey()
        table.column("generation", .integer).notNull()
        table.column("purged_at", .double).notNull()
        table.column("cloud_dirty", .boolean).notNull().defaults(to: true)
        table.column("cloud_record", .blob)
      }
      try db.create(table: "calendar_events") { table in
        table.column("event_key", .text).primaryKey()
        table.column("provider", .text).notNull().indexed()
        table.column("event_json", .blob).notNull()
        table.column("start_at", .double).notNull().indexed()
        table.column("end_at", .double).notNull().indexed()
        table.column("active", .boolean).notNull().defaults(to: true)
        table.column("refreshed_at", .double).notNull()
      }
      try db.create(table: "event_page_map") { table in
        table.column("event_key", .text).primaryKey()
        table.column("page_id", .text).notNull().unique()
          .references("pages", onDelete: .cascade)
      }
      try db.create(table: "link_metadata") { table in
        table.column("url", .text).primaryKey()
        table.column("metadata", .blob).notNull()
        table.column("refreshed_at", .double).notNull()
      }
      try db.create(table: "settings") { table in
        table.column("key", .text).primaryKey()
        table.column("value", .blob).notNull()
      }
    }
    migrator.registerMigration("v2-calendar-provider") { db in
      let columns = try db.columns(in: "calendar_events")
      if !columns.contains(where: { $0.name == "provider" }) {
        try db.alter(table: "calendar_events") { table in
          table.add(column: "provider", .text).notNull().defaults(to: "eventkit").indexed()
        }
      }
    }
    migrator.registerMigration("v3-calendar-series") { db in
      let eventColumns = try db.columns(in: "calendar_events")
      if !eventColumns.contains(where: { $0.name == "series_source_key" }) {
        try db.alter(table: "calendar_events") { table in
          table.add(column: "series_source_key", .text)
          table.add(column: "series_canonical_key", .text)
        }
        try db.create(index: "calendar_events_on_series_canonical_key", on: "calendar_events", columns: ["series_canonical_key"])
      }

      for row in try Row.fetchAll(db, sql: "SELECT rowid,event_json FROM calendar_events") {
        guard let rowID: Int64 = row["rowid"], let data: Data = row["event_json"],
          let event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data)
        else { continue }
        try db.execute(
          sql: "UPDATE calendar_events SET event_key = ? WHERE rowid = ?",
          arguments: [LibraryRepository.storageKey(event.identity.stableKey), rowID]
        )
      }

      try db.rename(table: "event_page_map", to: "event_page_map_v2")
      try db.create(table: "event_page_map") { table in
        table.column("event_key", .text).primaryKey()
        table.column("occurrence_key", .text).notNull().indexed()
        table.column("series_key", .text).indexed()
        table.column("page_id", .text).notNull().indexed()
          .references("pages", onDelete: .cascade)
      }
      for row in try Row.fetchAll(db, sql: "SELECT page_id,event_key FROM event_page_map_v2") {
        guard let pageID: String = row["page_id"] else { continue }
        let pageKindData = try Data.fetchOne(
          db,
          sql: "SELECT kind_json FROM pages WHERE id = ?",
          arguments: [pageID]
        )
        let identity = pageKindData
          .flatMap { try? JSONDecoder.enchiridion.decode(PageKind.self, from: $0) }
          .flatMap { kind -> CalendarEventIdentity? in
            guard case .calendarEvent(let identity) = kind else { return nil }
            return identity
          }
        let rawEventKey: String = identity?.stableKey ?? (row["event_key"] ?? pageID)
        let rawOccurrenceKey = identity?.canonicalOccurrenceKey ?? rawEventKey
        try db.execute(
          sql: "INSERT INTO event_page_map (event_key,occurrence_key,series_key,page_id) VALUES (?,?,?,?)",
          arguments: [
            LibraryRepository.storageKey(rawEventKey),
            LibraryRepository.storageKey(rawOccurrenceKey),
            identity?.series.map { LibraryRepository.storageKey($0.canonicalKey) },
            pageID,
          ]
        )
      }
      try db.drop(table: "event_page_map_v2")

      try db.create(table: "series_page_map") { table in
        table.column("series_key", .text).primaryKey()
        table.column("page_id", .text).notNull().indexed()
          .references("pages", onDelete: .cascade)
      }
      try db.create(table: "calendar_series_aliases") { table in
        table.column("source_key", .text).primaryKey()
        table.column("canonical_key", .text).notNull().indexed()
      }
    }
    migrator.registerMigration("v4-supertags") { db in
      try db.create(table: "supertag_schemas") { table in
        table.column("id", .text).primaryKey()
        table.column("name", .text).notNull().indexed()
        table.column("definition_json", .blob).notNull()
        table.column("deleted", .boolean).notNull().defaults(to: false)
        table.column("sort_order", .integer).notNull().defaults(to: 0)
      }
      try db.create(table: "page_supertags") { table in
        table.column("page_id", .text).notNull().references("pages", onDelete: .cascade)
        table.column("supertag_id", .text).notNull().indexed()
        table.primaryKey(["page_id", "supertag_id"])
      }
      try db.create(table: "page_property_values") { table in
        table.column("page_id", .text).notNull().references("pages", onDelete: .cascade)
        table.column("supertag_id", .text).notNull().indexed()
        table.column("field_id", .text).notNull().indexed()
        table.column("value_index", .integer).notNull()
        table.column("type", .text).notNull()
        table.column("text_value", .text)
        table.column("number_value", .double)
        table.column("boolean_value", .boolean)
        table.column("date_value", .double)
        table.column("entity_page_id", .text).indexed()
        table.primaryKey(["page_id", "supertag_id", "field_id", "value_index"])
      }
      try db.create(table: "calendar_event_attendees") { table in
        table.column("event_key", .text).notNull().indexed()
        table.column("person_page_id", .text).notNull().indexed().references("pages", onDelete: .cascade)
        table.column("email", .text).notNull().indexed()
        table.column("role", .text).notNull()
        table.column("response_status", .text).notNull()
        table.primaryKey(["event_key", "person_page_id"])
      }
      for (index, definition) in BuiltInSupertags.all.enumerated() {
        try db.execute(
          sql: "INSERT INTO supertag_schemas (id,name,definition_json,deleted,sort_order) VALUES (?,?,?,?,?)",
          arguments: [
            definition.id.rawValue,
            definition.name,
            try JSONEncoder.enchiridion.encode(definition),
            false,
            index,
          ]
        )
      }
      for row in try Row.fetchAll(db, sql: "SELECT id,document FROM pages") {
        guard let id: String = row["id"], let document: Data = row["document"],
          let projection = try? PageDocument.inspect(document, pageID: PageID(rawValue: id))
        else { continue }
        try LibraryRepository.replaceObjectProjection(db, pageID: PageID(rawValue: id), metadata: projection.objectMetadata)
      }
    }
    migrator.registerMigration("v5-live-views") { db in
      try db.create(table: "saved_query_views") { table in
        table.column("id", .text).primaryKey()
        table.column("name", .text).notNull().indexed()
        table.column("definition_json", .blob).notNull()
        table.column("deleted", .boolean).notNull().defaults(to: false)
        table.column("sort_order", .integer).notNull().defaults(to: 0)
      }
      for (index, definition) in BuiltInLiveQueries.all.enumerated() {
        try db.execute(
          sql: "INSERT INTO saved_query_views (id,name,definition_json,deleted,sort_order) VALUES (?,?,?,?,?)",
          arguments: [
            definition.id.rawValue,
            definition.name,
            try JSONEncoder.enchiridion.encode(definition),
            false,
            index,
          ]
        )
      }
    }
    migrator.registerMigration("v6-synced-live-views") { db in
      try db.alter(table: "saved_query_views") { table in
        table.add(column: "modified_at", .double).notNull().defaults(to: 0)
        table.add(column: "dirty_generation", .integer).notNull().defaults(to: 1)
        table.add(column: "cloud_dirty", .boolean).notNull().defaults(to: true).indexed()
        table.add(column: "cloud_synced_generation", .integer).notNull().defaults(to: 0)
        table.add(column: "cloud_record", .blob)
      }
      try db.execute(
        sql: "UPDATE saved_query_views SET modified_at = CAST(strftime('%s','now') AS REAL) WHERE modified_at = 0"
      )
    }
    migrator.registerMigration("v7-work-calendar-date-sort") { db in
      guard let data = try Data.fetchOne(
        db,
        sql: "SELECT definition_json FROM saved_query_views WHERE id = 'view_work_calendar'"
      ), let current = try? JSONDecoder.enchiridion.decode(LiveQueryDefinition.self, from: data),
        current.source == .workCalendar,
        current.filters.isEmpty,
        current.sorts == [.init(systemField: "title")],
        let replacement = BuiltInLiveQueries.all.first(where: { $0.id.rawValue == "view_work_calendar" })
      else { return }
      try db.execute(
        sql: """
          UPDATE saved_query_views
          SET definition_json = ?, modified_at = ?, dirty_generation = dirty_generation + 1, cloud_dirty = 1
          WHERE id = 'view_work_calendar'
          """,
        arguments: [try JSONEncoder.enchiridion.encode(replacement), Date().timeIntervalSince1970]
      )
    }
    return migrator
  }()

  private static func writePage(
    _ db: Database,
    page: PageSnapshot,
    cloudDirty: Bool,
    cloudRecord: Data? = nil
  ) throws {
    let kindTag: String
    let dayKey: String?
    switch page.kind {
    case .daily(let day):
      kindTag = "daily"
      dayKey = day.rawValue
    case .free:
      kindTag = "free"
      dayKey = nil
    case .calendarEvent:
      kindTag = "calendarEvent"
      dayKey = nil
    case .calendarSeries:
      kindTag = "calendarSeries"
      dayKey = nil
    }
    try db.execute(
      sql: """
        INSERT INTO pages
          (id,kind_tag,kind_json,day_key,title,plain_text,document,heads_json,
           created_at,modified_at,deleted_at,is_pinned,dirty_generation,cloud_dirty,cloud_record)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          kind_tag=excluded.kind_tag,
          kind_json=excluded.kind_json,
          day_key=excluded.day_key,
          title=excluded.title,
          plain_text=excluded.plain_text,
          document=excluded.document,
          heads_json=excluded.heads_json,
          modified_at=excluded.modified_at,
          deleted_at=excluded.deleted_at,
          is_pinned=excluded.is_pinned,
          dirty_generation=excluded.dirty_generation,
          cloud_dirty=excluded.cloud_dirty,
          cloud_record=COALESCE(excluded.cloud_record,pages.cloud_record)
        """,
      arguments: [
        page.id.rawValue,
        kindTag,
        try JSONEncoder.enchiridion.encode(page.kind),
        dayKey,
        page.title,
        page.plainText,
        page.document,
        try JSONEncoder.enchiridion.encode(page.heads),
        page.createdAt.timeIntervalSince1970,
        page.modifiedAt.timeIntervalSince1970,
        page.deletedAt?.timeIntervalSince1970,
        page.isPinned,
        page.dirtyGeneration,
        cloudDirty,
        cloudRecord,
      ]
    )
    try replaceObjectProjection(db, pageID: page.id, metadata: page.objectMetadata)
    switch page.kind {
    case .calendarEvent(let identity):
      try mapOccurrencePage(
        db,
        pageID: page.id,
        sourceEventKey: identity.stableKey,
        occurrenceKey: identity.canonicalOccurrenceKey,
        seriesKey: identity.series?.canonicalKey
      )
    case .calendarSeries(let series):
      try db.execute(
        sql: "INSERT OR REPLACE INTO series_page_map (series_key,page_id) VALUES (?,?)",
        arguments: [series.canonicalKey, page.id.rawValue]
      )
    case .daily, .free:
      break
    }
  }

  private static func replaceReferences(
    _ db: Database,
    pageID: PageID,
    references: [PageReference]
  ) throws {
    try db.execute(
      sql: "DELETE FROM page_references WHERE source_page_id = ?",
      arguments: [pageID.rawValue]
    )
    for reference in references {
      try db.execute(
        sql: "INSERT INTO page_references (source_page_id,target_page_id,fallback_label) VALUES (?,?,?)",
        arguments: [pageID.rawValue, reference.targetPageID.rawValue, reference.fallbackLabel]
      )
    }
  }

  private static func fetchPage(_ db: Database, id: PageID) throws -> PageSnapshot? {
    guard let row = try Row.fetchOne(db, sql: "SELECT * FROM pages WHERE id = ?", arguments: [id.rawValue]) else {
      return nil
    }
    return try Self.decodePage(row)
  }

  static func decodePage(_ row: Row) throws -> PageSnapshot {
    guard let id: String = row["id"],
      let kindData: Data = row["kind_json"],
      let title: String = row["title"],
      let plainText: String = row["plain_text"],
      let document: Data = row["document"],
      let headsData: Data = row["heads_json"],
      let createdAt: Double = row["created_at"],
      let modifiedAt: Double = row["modified_at"],
      let dirtyGeneration: Int64 = row["dirty_generation"]
    else { throw LibraryRepositoryError.invalidRecord }
    let idValue = PageID(rawValue: id)
    let metadata = (try? PageDocument.inspect(document, pageID: idValue).objectMetadata) ?? .init()
    return PageSnapshot(
      id: idValue,
      kind: try JSONDecoder.enchiridion.decode(PageKind.self, from: kindData),
      title: title,
      plainText: plainText,
      document: document,
      heads: try JSONDecoder.enchiridion.decode(AutomergeHeads.self, from: headsData),
      createdAt: Date(timeIntervalSince1970: createdAt),
      modifiedAt: Date(timeIntervalSince1970: modifiedAt),
      deletedAt: (row["deleted_at"] as Double?).map { Date(timeIntervalSince1970: $0) },
      isPinned: row["is_pinned"] ?? false,
      dirtyGeneration: dirtyGeneration,
      objectMetadata: metadata
    )
  }

  private static func decodeSuggestion(_ row: Row) -> PageSuggestion? {
    guard let id: String = row["id"], let title: String = row["title"],
      let kindData: Data = row["kind_json"],
      let kind = try? JSONDecoder.enchiridion.decode(PageKind.self, from: kindData)
    else { return nil }
    return PageSuggestion(id: PageID(rawValue: id), title: title, kind: kind)
  }

  private static func validate(values: [SupertagValue], for field: SupertagFieldDefinition) throws {
    if !field.allowsMultiple && values.count > 1 { throw LibraryRepositoryError.invalidRecord }
    for value in values {
      let valid: Bool
      switch (field.type, value) {
      case (.text, .text), (.number, .number), (.boolean, .boolean), (.date, .date),
        (.dateTime, .dateTime), (.url, .url), (.email, .email), (.phone, .phone),
        (.entityReference, .page):
        valid = true
      case (.select, .select(let option)):
        valid = field.options.contains { $0.id == option }
      default:
        valid = false
      }
      guard valid else { throw LibraryRepositoryError.invalidRecord }
    }
  }

  private static func replaceObjectProjection(
    _ db: Database,
    pageID: PageID,
    metadata: PageObjectMetadata
  ) throws {
    try db.execute(sql: "DELETE FROM page_supertags WHERE page_id = ?", arguments: [pageID.rawValue])
    try db.execute(sql: "DELETE FROM page_property_values WHERE page_id = ?", arguments: [pageID.rawValue])
    for tagID in metadata.supertagIDs {
      try db.execute(
        sql: "INSERT INTO page_supertags (page_id,supertag_id) VALUES (?,?)",
        arguments: [pageID.rawValue, tagID.rawValue]
      )
    }
    for (key, values) in metadata.properties {
      for (index, value) in values.enumerated() {
        var type = "text"
        var text: String?
        var number: Double?
        var boolean: Bool?
        var date: Double?
        var entity: String?
        switch value {
        case .text(let value): text = value
        case .number(let value): type = "number"; number = value
        case .boolean(let value): type = "boolean"; boolean = value
        case .date(let value): type = "date"; date = value.timeIntervalSince1970
        case .dateTime(let value): type = "dateTime"; date = value.timeIntervalSince1970
        case .select(let value): type = "select"; text = value
        case .url(let value): type = "url"; text = value
        case .email(let value): type = "email"; text = value
        case .phone(let value): type = "phone"; text = value
        case .page(let value): type = "entityReference"; entity = value.rawValue
        }
        try db.execute(
          sql: """
            INSERT INTO page_property_values
              (page_id,supertag_id,field_id,value_index,type,text_value,number_value,boolean_value,date_value,entity_page_id)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
          arguments: [
            pageID.rawValue, key.supertagID.rawValue, key.fieldID.rawValue, index,
            type, text, number, boolean, date, entity,
          ]
        )
      }
    }
  }

  private static func liveCalendarItems(
    _ db: Database,
    limit: Int,
    startingAt: Date? = nil
  ) throws -> [LiveQueryItem] {
    let rows: [Row]
    if let startingAt {
      rows = try Row.fetchAll(
        db,
        sql: "SELECT event_json FROM calendar_events WHERE active = 1 AND end_at >= ? ORDER BY start_at LIMIT ?",
        arguments: [startingAt.timeIntervalSince1970, limit]
      )
    } else {
      rows = try Row.fetchAll(
        db,
        sql: "SELECT event_json FROM calendar_events WHERE active = 1 ORDER BY start_at LIMIT ?",
        arguments: [limit]
      )
    }
    return rows.compactMap { row in
      guard let data: Data = row["event_json"],
        let event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data)
      else { return nil }
      return .event(event)
    }
  }

  private static func decodeSavedViewCloudRecord(_ row: Row) -> SavedViewCloudRecord? {
    guard let id: String = row["id"],
      let definitionData: Data = row["definition_json"],
      let definition = try? JSONDecoder.enchiridion.decode(LiveQueryDefinition.self, from: definitionData)
    else { return nil }
    let modified: Double = row["modified_at"] ?? 0
    return SavedViewCloudRecord(
      id: .init(rawValue: id),
      definition: definition,
      isDeleted: row["deleted"] ?? false,
      sortOrder: row["sort_order"] ?? 999,
      modifiedAt: Date(timeIntervalSince1970: modified),
      dirtyGeneration: row["dirty_generation"] ?? 0,
      cloudRecord: row["cloud_record"]
    )
  }

  private static func liveDate(for item: LiveQueryItem) -> Date? {
    switch item {
    case .event(let event):
      return event.startDate
    case .page(let page):
      return page.objectMetadata.properties.values.flatMap { $0 }.compactMap { value in
        switch value {
        case .date(let date), .dateTime(let date): date
        default: nil
        }
      }.min()
    }
  }

  private static func matches(
    _ filter: LiveQueryFilter,
    item: LiveQueryItem,
    definition: LiveQueryDefinition
  ) -> Bool {
    let values = queryValues(
      item: item,
      fieldID: filter.fieldID,
      systemField: filter.systemField,
      definition: definition
    )
    switch filter.operation {
    case .isEmpty:
      return values.isEmpty
    case .isNotEmpty:
      return !values.isEmpty
    case .equals:
      guard let expected = filter.value else { return false }
      return values.contains { queryEquals($0, expected) }
    case .notEquals:
      guard let expected = filter.value else { return false }
      return !values.contains { queryEquals($0, expected) }
    case .contains:
      guard let needle = filter.value.map(queryString), !needle.isEmpty else { return false }
      return values.contains { queryString($0).localizedCaseInsensitiveContains(needle) }
    case .before:
      guard let expected = filter.value.flatMap(queryDate) else { return false }
      return values.compactMap(queryDate).contains { $0 < expected }
    case .after:
      guard let expected = filter.value.flatMap(queryDate) else { return false }
      return values.compactMap(queryDate).contains { $0 > expected }
    }
  }

  private static func isOrderedBefore(
    _ lhs: LiveQueryItem,
    _ rhs: LiveQueryItem,
    definition: LiveQueryDefinition
  ) -> Bool {
    let sorts = definition.sorts.isEmpty
      ? [LiveQuerySort(systemField: definition.source == .workCalendar ? "start" : "title")]
      : definition.sorts
    for sort in sorts {
      let left = queryValues(
        item: lhs, fieldID: sort.fieldID, systemField: sort.systemField, definition: definition
      ).first
      let right = queryValues(
        item: rhs, fieldID: sort.fieldID, systemField: sort.systemField, definition: definition
      ).first
      let comparison = compare(left, right)
      if comparison != .orderedSame {
        return sort.ascending ? comparison == .orderedAscending : comparison == .orderedDescending
      }
    }
    return lhs.id < rhs.id
  }

  private static func queryValues(
    item: LiveQueryItem,
    fieldID: SupertagFieldID?,
    systemField: String?,
    definition: LiveQueryDefinition
  ) -> [SupertagValue] {
    if let systemField {
      switch (systemField.lowercased(), item) {
      case ("title", _): return [.text(item.title)]
      case ("created", .page(let page)): return [.dateTime(page.createdAt)]
      case ("modified", .page(let page)): return [.dateTime(page.modifiedAt)]
      case ("kind", .page(let page)): return [.text(pageKindName(page.kind))]
      case ("kind", .event): return [.text("calendar event")]
      case ("start", .event(let event)): return [.dateTime(event.startDate)]
      case ("end", .event(let event)): return [.dateTime(event.endDate)]
      case ("calendar", .event(let event)): return [.text(event.calendarTitle)]
      case ("source", .event(let event)): return [.text(event.identity.provider)]
      case ("source", .page): return [.text("page")]
      case ("start", .page(let page)):
        return pageDateValues(page, preferred: definition.startFieldID)
      case ("end", .page(let page)):
        return pageDateValues(page, preferred: definition.endFieldID)
      default: return []
      }
    }
    guard let fieldID, case .page(let page) = item else { return [] }
    if case .supertag(let tagID) = definition.source {
      return page.objectMetadata.properties[
        .init(supertagID: tagID, fieldID: fieldID)
      ] ?? []
    }
    return page.objectMetadata.properties
      .filter { $0.key.fieldID == fieldID }
      .flatMap(\.value)
  }

  private static func pageDateValues(
    _ page: PageSnapshot,
    preferred fieldID: SupertagFieldID?
  ) -> [SupertagValue] {
    if let fieldID {
      return page.objectMetadata.properties
        .filter { $0.key.fieldID == fieldID }
        .flatMap(\.value)
    }
    return page.objectMetadata.properties.values.flatMap { $0 }.filter { queryDate($0) != nil }
  }

  private static func pageKindName(_ kind: PageKind) -> String {
    switch kind {
    case .daily: "daily"
    case .free: "page"
    case .calendarEvent: "calendar event note"
    case .calendarSeries: "calendar series note"
    }
  }

  private static func queryEquals(_ lhs: SupertagValue, _ rhs: SupertagValue) -> Bool {
    if let left = queryDate(lhs), let right = queryDate(rhs) { return left == right }
    switch (lhs, rhs) {
    case (.number(let left), .number(let right)): return left == right
    case (.boolean(let left), .boolean(let right)): return left == right
    case (.page(let left), .page(let right)): return left == right
    default: return queryString(lhs).localizedCaseInsensitiveCompare(queryString(rhs)) == .orderedSame
    }
  }

  private static func queryString(_ value: SupertagValue) -> String {
    switch value {
    case .text(let value), .select(let value), .url(let value), .email(let value), .phone(let value): value
    case .number(let value): String(value)
    case .boolean(let value): value ? "true" : "false"
    case .date(let value), .dateTime(let value): String(value.timeIntervalSince1970)
    case .page(let value): value.rawValue
    }
  }

  private static func queryDate(_ value: SupertagValue) -> Date? {
    switch value {
    case .date(let value), .dateTime(let value): value
    default: nil
    }
  }

  private static func compare(_ lhs: SupertagValue?, _ rhs: SupertagValue?) -> ComparisonResult {
    switch (lhs, rhs) {
    case (nil, nil): return .orderedSame
    case (nil, _): return .orderedDescending
    case (_, nil): return .orderedAscending
    case (.some(let lhs), .some(let rhs)):
      if let left = queryDate(lhs), let right = queryDate(rhs) {
        if left == right { return .orderedSame }
        return left < right ? .orderedAscending : .orderedDescending
      }
      if case .number(let left) = lhs, case .number(let right) = rhs {
        if left == right { return .orderedSame }
        return left < right ? .orderedAscending : .orderedDescending
      }
      if case .boolean(let left) = lhs, case .boolean(let right) = rhs {
        if left == right { return .orderedSame }
        return left == false ? .orderedAscending : .orderedDescending
      }
      return queryString(lhs).localizedStandardCompare(queryString(rhs))
    }
  }

  private static func documentHeads(_ data: Data) throws -> AutomergeHeads {
    let document = try Document(data)
    return AutomergeHeads(document.heads().map(\.debugDescription))
  }

  private static func escapeLike(_ value: String) -> String {
    value
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "%", with: "\\%")
      .replacingOccurrences(of: "_", with: "\\_")
  }

  private static func dailyTitle(_ day: DayKey) -> String {
    let parts = day.rawValue.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3,
      let date = Calendar(identifier: .gregorian).date(
        from: DateComponents(year: parts[0], month: parts[1], day: parts[2])
      )
    else { return day.rawValue }
    return date.formatted(date: .complete, time: .omitted)
  }
}
