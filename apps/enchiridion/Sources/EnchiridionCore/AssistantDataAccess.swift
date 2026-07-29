import Foundation
import GRDB

public extension LibraryRepository {
  static let assistantMaximumQueryLength = 160
  static let assistantMaximumCalendarDays: TimeInterval = 31 * 24 * 60 * 60
  static let assistantMaximumCalendarResults = 10
  static let assistantMaximumNoteResults = 8
  static let assistantMaximumExcerptCharacters = 400
  static let assistantProjectionFreshnessInterval: TimeInterval = 12 * 60 * 60

  /// Searches only the local calendar projection and returns at most ten compact records.
  func findCalendarEvents(
    matching query: String = "",
    from start: Date,
    through end: Date,
    limit requestedLimit: Int = 5,
    includeOngoing: Bool = false,
    now: Date = Date()
  ) throws -> AssistantCalendarResults {
    guard end > start else { throw AssistantDataAccessError.invalidDateRange }
    guard end.timeIntervalSince(start) <= Self.assistantMaximumCalendarDays else {
      throw AssistantDataAccessError.dateRangeTooLarge
    }
    let normalizedQuery = try Self.assistantQuery(query, allowsEmpty: true)
    let limit = min(max(requestedLimit, 1), Self.assistantMaximumCalendarResults)

    return try assistantRead { db in
      var sql = """
        SELECT e.event_json,e.refreshed_at
        FROM calendar_events e
        WHERE e.active = 1 AND e.start_at < ? AND \(includeOngoing ? "e.end_at > ?" : "e.start_at >= ?")
        """
      var arguments: StatementArguments = [end.timeIntervalSince1970, start.timeIntervalSince1970]
      if !normalizedQuery.isEmpty {
        sql += """
           AND (
             json_extract(e.event_json, '$.title') LIKE ? ESCAPE '\\' COLLATE NOCASE
             OR json_extract(e.event_json, '$.location') LIKE ? ESCAPE '\\' COLLATE NOCASE
             OR EXISTS (
               SELECT 1 FROM json_each(e.event_json, '$.attendees') attendee
               WHERE json_extract(attendee.value, '$.displayName') LIKE ? ESCAPE '\\' COLLATE NOCASE
                  OR json_extract(attendee.value, '$.email') LIKE ? ESCAPE '\\' COLLATE NOCASE
             )
           )
          """
        let pattern = "%\(Self.assistantEscapeLike(normalizedQuery))%"
        arguments += [pattern, pattern, pattern, pattern]
      }
      sql += " ORDER BY e.start_at, json_extract(e.event_json, '$.title') LIMIT ?"
      arguments += [limit + 1]

      let rows = try Row.fetchAll(db, sql: sql, arguments: arguments)
      let events = rows.prefix(limit).compactMap { row -> AssistantCalendarEvent? in
        guard let data: Data = row["event_json"],
          let event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data),
          let refreshedAt = (row["refreshed_at"] as Double?).map(Date.init(timeIntervalSince1970:))
        else { return nil }
        let isStale = now.timeIntervalSince(refreshedAt) > Self.assistantProjectionFreshnessInterval
        let attendeeNames = (event.attendees ?? []).compactMap { attendee in
          attendee.displayName ?? attendee.email
        }
        let source = AssistantSource(
          id: Self.assistantEventSourceID(event.identity.stableKey),
          kind: .calendarEvent,
          title: Self.assistantBounded(event.title, maximum: 120),
          occurredAt: event.startDate,
          modifiedAt: refreshedAt,
          isStale: isStale
        )
        let evidence = Self.assistantEventEvidence(event, source: source)
        return AssistantCalendarEvent(
          source: source,
          startDate: event.startDate,
          endDate: event.endDate,
          isAllDay: event.isAllDay,
          location: event.location.map { Self.assistantBounded($0, maximum: 160) },
          attendees: attendeeNames.prefix(12).map { Self.assistantBounded($0, maximum: 120) },
          isRecurring: event.identity.series != nil,
          evidence: evidence
        )
      }
      return AssistantCalendarResults(
        events: events,
        truncated: rows.count > limit,
        containsStaleProjection: events.contains { $0.source.isStale }
      )
    }
  }

  /// Searches live local pages. Only titles and short matching excerpts are returned.
  func searchNotes(
    matching query: String,
    limit requestedLimit: Int = 5
  ) throws -> AssistantNoteResults {
    let normalizedQuery = try Self.assistantQuery(query, allowsEmpty: false)
    let limit = min(max(requestedLimit, 1), Self.assistantMaximumNoteResults)
    let pattern = "%\(Self.assistantEscapeLike(normalizedQuery))%"

    return try assistantRead { db in
      let rows = try Row.fetchAll(
        db,
        sql: """
          SELECT * FROM pages
          WHERE deleted_at IS NULL
            AND COALESCE(person_visibility, 'promoted') <> 'other'
            AND (title LIKE ? ESCAPE '\\' COLLATE NOCASE OR plain_text LIKE ? ESCAPE '\\' COLLATE NOCASE)
          ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 0 ELSE 1 END,
                   modified_at DESC,
                   title COLLATE NOCASE
          LIMIT ?
          """,
        arguments: [pattern, pattern, pattern, limit + 1]
      )
      let pages = try rows.prefix(limit).map(Self.decodePage)
      let sources = pages.map { page in
        AssistantSource(
          id: Self.assistantPageSourceID(page.id),
          kind: .page,
          title: Self.assistantBounded(page.displayTitle, maximum: 120),
          excerpt: Self.assistantExcerpt(page.plainText, matching: normalizedQuery),
          occurredAt: Self.assistantOccurrenceDate(page.kind),
          modifiedAt: page.modifiedAt,
          hasConflicts: !page.objectMetadata.conflicts.isEmpty
        )
      }
      let titleGroups = Dictionary(grouping: sources) {
        $0.title.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
      }
      let ambiguousTitles = titleGroups.values.filter { $0.count > 1 }.compactMap { $0.first?.title }.sorted()
      return AssistantNoteResults(
        sources: sources,
        truncated: rows.count > limit,
        ambiguousTitles: ambiguousTitles,
        evidence: sources.flatMap(Self.assistantPageEvidence)
      )
    }
  }

  /// Returns a trusted, ordered projection of one task list for assistant use.
  /// Scope is explicit so temporal words never become accidental title searches.
  func searchTasks(
    scope: AssistantTaskScope,
    matching query: String = "",
    limit requestedLimit: Int = 5,
    now: Date = Date(),
    calendar: Calendar = .current
  ) throws -> AssistantTaskResults {
    let normalizedQuery = try Self.assistantQuery(query, allowsEmpty: true)
    let limit = min(max(requestedLimit, 1), 10)
    let pages = try pages(with: BuiltInSupertags.task)
    let tasks: [TaskItem]

    switch scope {
    case .today:
      tasks = TaskQuery.items(
        from: pages,
        selection: .smart(.today),
        now: now,
        calendar: calendar
      )
    case .tomorrow:
      let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
      tasks = TaskQuery.items(
        from: pages,
        on: tomorrow,
        includingOverdue: false,
        calendar: calendar
      )
    case .inbox:
      tasks = TaskQuery.items(from: pages, selection: .smart(.inbox), now: now, calendar: calendar)
    case .upcoming:
      tasks = TaskQuery.items(from: pages, selection: .smart(.upcoming), now: now, calendar: calendar)
    case .anytime:
      tasks = TaskQuery.items(from: pages, selection: .smart(.anytime), now: now, calendar: calendar)
    case .someday:
      tasks = TaskQuery.items(from: pages, selection: .smart(.someday), now: now, calendar: calendar)
    case .logbook:
      tasks = TaskQuery.items(from: pages, selection: .smart(.logbook), now: now, calendar: calendar)
    case .all:
      tasks = pages.compactMap(TaskItem.init(page:))
        .filter(\.data.isActive)
        .sorted(by: Self.assistantTaskOrder)
    }

    let filtered = normalizedQuery.isEmpty ? tasks : tasks.filter { task in
      task.page.displayTitle.localizedCaseInsensitiveContains(normalizedQuery)
        || task.data.tags.contains { $0.localizedCaseInsensitiveContains(normalizedQuery) }
    }
    let selected = Array(filtered.prefix(limit))
    let sourceFacts = selected.map { task in
      Self.assistantTaskSourceFact(task, scope: scope, now: now, calendar: calendar)
    }
    return AssistantTaskResults(
      scope: scope,
      sources: sourceFacts.map(\.source),
      evidence: sourceFacts.map(\.fact),
      truncated: filtered.count > limit
    )
  }

  /// Resolves one previously returned event source to its exact occurrence note,
  /// recurring-series note, and attendee or referenced Person pages.
  func meetingBrief(
    forEventSourceID sourceID: String,
    peopleLimit requestedPeopleLimit: Int = 6,
    now: Date = Date()
  ) throws -> AssistantMeetingBrief {
    guard let stableKey = Self.assistantStableEventKey(sourceID) else {
      throw AssistantDataAccessError.invalidSource
    }
    let eventKey = Self.assistantStorageKey(stableKey)
    let peopleLimit = min(max(requestedPeopleLimit, 1), 8)

    return try assistantRead { db in
      guard let eventRow = try Row.fetchOne(
        db,
        sql: "SELECT event_json,refreshed_at FROM calendar_events WHERE event_key = ? AND active = 1",
        arguments: [eventKey]
      ), let data: Data = eventRow["event_json"],
        let event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data),
        let refreshed = (eventRow["refreshed_at"] as Double?).map(Date.init(timeIntervalSince1970:))
      else { throw AssistantDataAccessError.invalidSource }

      let eventSource = AssistantSource(
        id: sourceID,
        kind: .calendarEvent,
        title: Self.assistantBounded(event.title, maximum: 120),
        occurredAt: event.startDate,
        modifiedAt: refreshed,
        isStale: now.timeIntervalSince(refreshed) > Self.assistantProjectionFreshnessInterval
      )
      let eventValue = AssistantCalendarEvent(
        source: eventSource,
        startDate: event.startDate,
        endDate: event.endDate,
        isAllDay: event.isAllDay,
        location: event.location.map { Self.assistantBounded($0, maximum: 160) },
        attendees: (event.attendees ?? []).compactMap { $0.displayName ?? $0.email }.prefix(12).map {
          Self.assistantBounded($0, maximum: 120)
        },
        isRecurring: event.identity.series != nil,
        evidence: Self.assistantEventEvidence(event, source: eventSource)
      )

      let occurrencePageID = try String.fetchOne(
        db,
        sql: """
          SELECT page_id FROM event_page_map
          WHERE event_key = ? OR occurrence_key = ?
          ORDER BY CASE WHEN event_key = ? THEN 0 ELSE 1 END
          LIMIT 1
          """,
        arguments: [eventKey, Self.assistantStorageKey(event.identity.canonicalOccurrenceKey), eventKey]
      )
      let seriesPageID = try event.identity.series.flatMap { series in
        try String.fetchOne(
          db,
          sql: "SELECT page_id FROM series_page_map WHERE series_key = ?",
          arguments: [Self.assistantStorageKey(series.canonicalKey)]
        )
      }
      let occurrencePage = try occurrencePageID.flatMap { try Self.assistantPage(db, id: $0) }
      let seriesPage = try seriesPageID.flatMap { try Self.assistantPage(db, id: $0) }
      let occurrenceSource = occurrencePage.map(Self.assistantPageSource)
      let seriesSource = seriesPage.map(Self.assistantPageSource)

      var personIDs = try String.fetchAll(
        db,
        sql: "SELECT person_page_id FROM calendar_event_attendees WHERE event_key = ? ORDER BY person_page_id",
        arguments: [eventKey]
      )
      let notePageIDs = [occurrencePageID, seriesPageID].compactMap { $0 }
      if !notePageIDs.isEmpty {
        let placeholders = Array(repeating: "?", count: notePageIDs.count).joined(separator: ",")
        let referencedIDs = try String.fetchAll(
          db,
          sql: """
            SELECT person_id FROM (
              SELECT r.target_page_id AS person_id
              FROM page_references r
              WHERE r.source_page_id IN (\(placeholders))
              UNION
              SELECT v.entity_page_id AS person_id
              FROM page_property_values v
              WHERE v.page_id IN (\(placeholders)) AND v.entity_page_id IS NOT NULL
            ) references_to_people
            JOIN page_supertags s ON s.page_id = person_id AND s.supertag_id = 'person'
            JOIN pages p ON p.id = person_id AND p.deleted_at IS NULL
            ORDER BY person_id
            """,
          arguments: StatementArguments(notePageIDs + notePageIDs)
        )
        personIDs.append(contentsOf: referencedIDs)
      }
      let uniquePersonIDs = personIDs.reduce(into: [String]()) { result, id in
        if !result.contains(id) { result.append(id) }
      }
      let people = try uniquePersonIDs.prefix(peopleLimit).compactMap {
        try Self.assistantPage(db, id: $0).map(Self.assistantPageSource)
      }
      let pageSources = [occurrenceSource, seriesSource].compactMap { $0 } + people
      let evidence = eventValue.evidence + pageSources.flatMap(Self.assistantPageEvidence)
      return AssistantMeetingBrief(
        event: eventValue,
        occurrenceNote: occurrenceSource,
        seriesNote: seriesSource,
        people: people,
        evidence: evidence,
        peopleTruncated: uniquePersonIDs.count > peopleLimit
      )
    }
  }

  private static func assistantQuery(_ query: String, allowsEmpty: Bool) throws -> String {
    let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.isEmpty && !allowsEmpty { throw AssistantDataAccessError.emptyQuery }
    if value.count > assistantMaximumQueryLength { throw AssistantDataAccessError.queryTooLong }
    return value
  }

  private static func assistantEscapeLike(_ value: String) -> String {
    value
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "%", with: "\\%")
      .replacingOccurrences(of: "_", with: "\\_")
  }

  private static func assistantTaskOrder(_ lhs: TaskItem, _ rhs: TaskItem) -> Bool {
    if lhs.data.priority != rhs.data.priority { return lhs.data.priority > rhs.data.priority }
    let lhsDate = lhs.data.scheduledAt ?? lhs.data.deadline ?? .distantFuture
    let rhsDate = rhs.data.scheduledAt ?? rhs.data.deadline ?? .distantFuture
    if lhsDate != rhsDate { return lhsDate < rhsDate }
    if lhs.page.createdAt != rhs.page.createdAt { return lhs.page.createdAt < rhs.page.createdAt }
    return lhs.page.displayTitle.localizedStandardCompare(rhs.page.displayTitle) == .orderedAscending
  }

  private static func assistantTaskSourceFact(
    _ task: TaskItem,
    scope: AssistantTaskScope,
    now: Date,
    calendar: Calendar
  ) -> (source: AssistantSource, fact: AssistantEvidenceFact) {
    let sourceID = "task:\(task.id.rawValue)"
    let title = assistantBounded(task.page.displayTitle, maximum: 120)
    let source = AssistantSource(
      id: sourceID,
      kind: .page,
      title: title,
      modifiedAt: task.page.modifiedAt,
      hasConflicts: !task.page.objectMetadata.conflicts.isEmpty
    )
    let today = calendar.startOfDay(for: now)
    var details: [String] = []

    if task.data.state != .active {
      details.append(task.data.state == .completed ? "completed" : "canceled")
    } else if let deadline = task.data.deadline {
      let deadlineDay = calendar.startOfDay(for: deadline)
      if deadlineDay < today {
        details.append("overdue, due \(deadline.formatted(date: .abbreviated, time: .omitted))")
      } else if calendar.isDate(deadline, inSameDayAs: now) {
        details.append("due today")
      } else {
        details.append("due \(deadline.formatted(date: .abbreviated, time: .omitted))")
      }
    }

    if let scheduledAt = task.data.scheduledAt {
      let scheduledDay = calendar.startOfDay(for: scheduledAt)
      if scheduledDay < today, !details.contains(where: { $0.hasPrefix("overdue") }) {
        details.append("overdue")
      }
      let scheduleText: String
      if task.data.scheduleGranularity == .dateOnly {
        if calendar.isDate(scheduledAt, inSameDayAs: now) {
          scheduleText = "scheduled for today"
        } else if scope == .tomorrow, scheduledDay > today {
          scheduleText = "scheduled for tomorrow"
        } else {
          scheduleText = "scheduled for \(scheduledAt.formatted(date: .abbreviated, time: .omitted))"
        }
      } else if calendar.isDate(scheduledAt, inSameDayAs: now) {
        scheduleText = "scheduled at \(scheduledAt.formatted(date: .omitted, time: .shortened))"
      } else {
        scheduleText = "scheduled \(scheduledAt.formatted(date: .abbreviated, time: .shortened))"
      }
      details.append(scheduleText)
    }
    if task.data.priority != .none { details.append("\(task.data.priority.title.lowercased()) priority") }

    let spokenText = details.isEmpty
      ? "\(title)."
      : "\(title) is \(details.joined(separator: ", "))."
    return (
      source,
      AssistantEvidenceFact(
        id: "\(sourceID)#summary",
        sourceID: sourceID,
        kind: .taskSummary,
        spokenText: spokenText
      )
    )
  }

  private static func assistantEventSourceID(_ stableKey: String) -> String {
    "calendar:\(Data(stableKey.utf8).base64EncodedString())"
  }

  private static func assistantStableEventKey(_ sourceID: String) -> String? {
    guard sourceID.hasPrefix("calendar:"),
      let data = Data(base64Encoded: String(sourceID.dropFirst("calendar:".count))),
      let value = String(data: data, encoding: .utf8)
    else { return nil }
    return value
  }

  private static func assistantStorageKey(_ value: String) -> String {
    Data(value.utf8).base64EncodedString()
  }

  private static func assistantPageSourceID(_ pageID: PageID) -> String {
    "page:\(pageID.rawValue)"
  }

  private static func assistantOccurrenceDate(_ kind: PageKind) -> Date? {
    guard case .calendarEvent(let identity) = kind else { return nil }
    return identity.occurrenceStart
  }

  private static func assistantPage(_ db: Database, id: String) throws -> PageSnapshot? {
    try Row.fetchOne(
      db,
      sql: "SELECT * FROM pages WHERE id = ? AND deleted_at IS NULL",
      arguments: [id]
    ).map(decodePage)
  }

  private static func assistantPageSource(_ page: PageSnapshot) -> AssistantSource {
    AssistantSource(
      id: assistantPageSourceID(page.id),
      kind: .page,
      title: assistantBounded(page.displayTitle, maximum: 120),
      excerpt: assistantExcerpt(page.plainText, matching: ""),
      occurredAt: assistantOccurrenceDate(page.kind),
      modifiedAt: page.modifiedAt,
      hasConflicts: !page.objectMetadata.conflicts.isEmpty
    )
  }

  private static func assistantPageEvidence(_ source: AssistantSource) -> [AssistantEvidenceFact] {
    var facts = [
      AssistantEvidenceFact(
        id: "\(source.id)#title",
        sourceID: source.id,
        kind: .pageTitle,
        spokenText: "A local page is titled \(source.title)."
      )
    ]
    if let excerpt = source.excerpt, !excerpt.isEmpty {
      facts.append(
        AssistantEvidenceFact(
          id: "\(source.id)#excerpt",
          sourceID: source.id,
          kind: .pageExcerpt,
          spokenText: "\(source.title) says: \(excerpt)"
        )
      )
    }
    return facts
  }

  private static func assistantEventEvidence(
    _ event: CalendarEventSnapshot,
    source: AssistantSource
  ) -> [AssistantEvidenceFact] {
    let date = event.startDate.formatted(
      date: .abbreviated,
      time: event.isAllDay ? .omitted : .shortened
    )
    var facts = [
      AssistantEvidenceFact(
        id: "\(source.id)#schedule",
        sourceID: source.id,
        kind: .eventSchedule,
        spokenText: "\(source.title) is scheduled for \(date)."
      )
    ]
    if let location = event.location?.trimmingCharacters(in: .whitespacesAndNewlines), !location.isEmpty {
      facts.append(
        AssistantEvidenceFact(
          id: "\(source.id)#location",
          sourceID: source.id,
          kind: .eventLocation,
          spokenText: "The location is \(assistantBounded(location, maximum: 160))."
        )
      )
    }
    let attendees = (event.attendees ?? []).compactMap { $0.displayName ?? $0.email }.prefix(12)
    if !attendees.isEmpty {
      facts.append(
        AssistantEvidenceFact(
          id: "\(source.id)#attendees",
          sourceID: source.id,
          kind: .eventAttendees,
          spokenText: "Attendees include \(attendees.joined(separator: ", "))."
        )
      )
    }
    return facts
  }

  private static func assistantExcerpt(_ text: String, matching query: String) -> String? {
    let compact = text
      .split(whereSeparator: { $0.isWhitespace })
      .joined(separator: " ")
    guard !compact.isEmpty else { return nil }
    let match = compact.range(of: query, options: [.caseInsensitive, .diacriticInsensitive])
    let center = match?.lowerBound ?? compact.startIndex
    let leading = compact.distance(from: compact.startIndex, to: center)
    let startOffset = max(0, leading - assistantMaximumExcerptCharacters / 3)
    let start = compact.index(compact.startIndex, offsetBy: startOffset)
    let end = compact.index(
      start,
      offsetBy: min(assistantMaximumExcerptCharacters, compact.distance(from: start, to: compact.endIndex))
    )
    var excerpt = String(compact[start..<end])
    if start != compact.startIndex { excerpt = "…\(excerpt)" }
    if end != compact.endIndex { excerpt += "…" }
    return excerpt
  }

  private static func assistantBounded(_ text: String, maximum: Int) -> String {
    guard text.count > maximum else { return text }
    return String(text.prefix(maximum - 1)) + "…"
  }
}
