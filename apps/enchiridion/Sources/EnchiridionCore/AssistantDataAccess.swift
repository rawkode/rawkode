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
        WHERE e.active = 1 AND e.start_at < ? AND e.end_at > ?
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
        return AssistantCalendarEvent(
          source: source,
          startDate: event.startDate,
          endDate: event.endDate,
          isAllDay: event.isAllDay,
          location: event.location.map { Self.assistantBounded($0, maximum: 160) },
          attendees: attendeeNames.prefix(12).map { Self.assistantBounded($0, maximum: 120) },
          isRecurring: event.identity.series != nil
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
        ambiguousTitles: ambiguousTitles
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

  private static func assistantEventSourceID(_ stableKey: String) -> String {
    "calendar:\(Data(stableKey.utf8).base64EncodedString())"
  }

  private static func assistantPageSourceID(_ pageID: PageID) -> String {
    "page:\(pageID.rawValue)"
  }

  private static func assistantOccurrenceDate(_ kind: PageKind) -> Date? {
    guard case .calendarEvent(let identity) = kind else { return nil }
    return identity.occurrenceStart
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
