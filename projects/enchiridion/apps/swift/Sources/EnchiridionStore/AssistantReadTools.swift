// AssistantReadTools.swift
// EnchiridionStore
//
// Task #66 ("Assistant read tools") — the SQL-backed executors for the
// assistant's local read tools (plan §Assistant (P5): "`searchPages`,
// `searchTasks`, `findCalendarEvents`, `meetingBrief` query through
// `EnchiridionStore`'s on-device bounded SQL executor (P1, task #30) over
// the local GRDB projections"). See
// `EnchiridionCore/AssistantReadToolModels.swift`'s header for why these
// four executors live HERE (this module can see `GraphSQLExecutor`) rather
// than in `EnchiridionCore` (which cannot, without a circular dependency) —
// the result/evidence-fact TYPES live there, shared with `searchEmailThreads`;
// only the "reach into SQLite" part lives here, as `LocalGraphStore`
// extension methods (matching that actor's own `query(...)` — `nonisolated`,
// since the bounded executor opens its own dedicated connection and needs
// no actor-serialized access — see `LocalGraphStore.swift`'s header).
//
// *** SCHEMA REALITY THIS WAS BUILT AGAINST (not the old app's) ***
//
// Confirmed by reading `LocalGraphSchema.swift`/`LocalGraphStore.swift`
// before writing a line here, per the task brief's explicit instruction —
// none of the old app's `AssistantDataAccess.swift` table names exist in
// this package:
//   - No `calendar_events`/`event_page_map`/`series_page_map` tables.
//     Calendar events are pages (plan §Google gatekeeper:
//     `PageKind.calendarMaterializedEvent`), carrying the
//     `dev.rawkode.enchiridion.core.event` supertag
//     (`EnchiridionSchema.CoreEventFieldIDs`) — `findCalendarEvents`/
//     `meetingBrief` below query `graph_nodes`/`graph_facts`/`graph_edges`
//     like any other supertagged page, not a separate calendar table.
//   - No `pages`/`page_references`/`page_property_values` tables — the
//     equivalents are `graph_nodes`/`graph_edges` (inline `[[page]]`
//     references materialize as `system-relation:mentions` edges,
//     `LocalGraphStore.mentionsRelationID`; entityReference fields like
//     `event.attendees` materialize as `property-relation:...` edges,
//     `EnchiridionCore.BuiltInRelations.relationID(for:)` — see
//     `PageModels.swift`'s "property/edge duality").
//   - No `TaskQuery`/smart-list scheduling helper exists yet anywhere in
//     this package (`EnchiridionCore/TaskSemantics.swift`'s header is
//     explicit: it carries only enough vocabulary for one CRDT mutation
//     today, not the old app's ~600-line recurrence/smart-list engine).
//     `searchTasks` below therefore implements `AssistantTaskScope`'s
//     seven scopes' semantics directly against
//     `EnchiridionSchema.CoreTaskFieldIDs`' fields (`status`/`placement`/
//     `scheduled`/`deadline`/`due`/`completedAt`/`priority`) — a genuine
//     new design decision, not a port, documented scope-by-scope below.
//   - No `person_visibility` column existed on `graph_nodes` before this
//     task either — see `LocalGraphSchema.swift`'s
//     "v2-assistant-person-visibility" migration, added by this task
//     specifically so `searchPages`' privacy-gate exclusion below has a
//     real column to filter on (mirrors
//     `workers/gadget-host/src/graph-query-views.ts`'s server-side
//     `personVisibility === "other"` exclusion for the exact same reason —
//     calendar-attendee-derived Person pages must not leak into
//     assistant-grounding surfaces by default, plan §Google gatekeeper).
//
// *** PRE-FLIGHT AUTHORIZATION ENFORCEMENT SHAPE ***
//
// Every function below takes both a pre-flight `authorization` (constructed
// before the model ever runs — see `AssistantTurnRetrievalAuthorization`'s
// header) and a `candidate...` argument standing in for what a model's
// tool-call claims to want. The ONLY thing a candidate argument can ever be
// is a member of what the authorization already, immutably, contains:
//   - `candidateQuery` must equal one of `authorization.query`'s
//     pre-approved terms (`AssistantApprovedQuery.permits(_:)` — exact
//     match after normalization, never fuzzy).
//   - `candidateScope` (`searchTasks`) must equal
//     `authorization.scope` exactly.
//   - `candidateSourceID` (`meetingBrief`) must be a member of
//     `authorization.allowedSourceIDs`.
// There is deliberately NO way to pass a wider date range or a higher
// result cap as a "candidate" argument at all — `AssistantCalendarSearchAuthorization`'s
// `start`/`end`/`maximumResults` and every other authorization's
// `maximumResults` are used directly from `authorization` itself, never
// accepted as a second, model-suppliable value to validate against the
// first. This is a stronger property than a runtime check: a caller
// physically cannot construct a call that asks for more, because the
// function signatures below have no parameter for it — see
// `AssistantReadToolsTests.swift` for the adversarial-shaped tests
// confirming the one axis that IS a runtime check (query/scope/source-ID
// membership) actually rejects out-of-scope values.

import EnchiridionCore
import EnchiridionSchema
import Foundation

extension LocalGraphStore {
  // MARK: - searchPages

  public nonisolated func searchPages(
    authorization: AssistantPageSearchAuthorization,
    candidateQuery: String
  ) throws -> AssistantPageResults {
    guard authorization.query.permits(candidateQuery) else {
      throw AssistantTurnRetrievalAuthorizationError.invalidQuery
    }
    let normalizedQuery = authorization.query.originalQuery
    let limit = authorization.maximumResults

    var sql = """
      SELECT node_id, title, plain_text, modified_at
      FROM graph_nodes
      WHERE deleted_at IS NULL
        AND COALESCE(person_visibility, 'promoted') <> 'other'
      """
    var arguments: [String: GraphSQLValue] = [:]
    if !normalizedQuery.isEmpty {
      sql += """
         AND (title LIKE :pattern ESCAPE '\\' COLLATE NOCASE
              OR plain_text LIKE :pattern ESCAPE '\\' COLLATE NOCASE)
        """
      arguments[":pattern"] = .text("%\(Self.escapeLike(normalizedQuery))%")
    }
    sql += """
       ORDER BY CASE WHEN title LIKE :titlePattern ESCAPE '\\' COLLATE NOCASE THEN 0 ELSE 1 END,
                modified_at DESC
      LIMIT :limit
      """
    arguments[":titlePattern"] =
      normalizedQuery.isEmpty ? .text("%") : .text("%\(Self.escapeLike(normalizedQuery))%")
    arguments[":limit"] = .integer(Int64(limit + 1))

    let result = try query(sql: sql, arguments: arguments)
    let dictionaries = result.dictionaries()
    let selected = dictionaries.prefix(limit)

    var sources: [AssistantSource] = []
    for row in selected {
      guard let nodeID = row["node_id"]?.stringValue, let title = row["title"]?.stringValue else {
        continue
      }
      let plainText = row["plain_text"]?.stringValue ?? ""
      let modifiedAt = row["modified_at"]?.int64Value.map(Date.init(millisecondsSince1970:))
      sources.append(
        AssistantSource(
          id: "page:\(nodeID)",
          kind: .page,
          title: AssistantReadToolSupport.bounded(title, maximum: 120),
          excerpt: AssistantReadToolSupport.excerpt(plainText, matching: normalizedQuery),
          modifiedAt: modifiedAt
        ))
    }
    return AssistantPageResults(
      sources: sources,
      evidence: sources.flatMap(AssistantReadToolSupport.pageEvidence),
      truncated: dictionaries.count > limit,
      ambiguousTitles: AssistantReadToolSupport.ambiguousTitles(among: sources)
    )
  }

  // MARK: - findCalendarEvents

  public nonisolated func findCalendarEvents(
    authorization: AssistantCalendarSearchAuthorization,
    candidateQuery: String = ""
  ) throws -> AssistantCalendarResults {
    guard authorization.query.permits(candidateQuery) else {
      throw AssistantTurnRetrievalAuthorizationError.invalidQuery
    }
    let normalizedQuery = authorization.query.originalQuery
    let eventTag = CoreEventFieldIDs.supertagID.rawValue

    let result = try query(
      sql: """
        SELECT n.node_id AS node_id, n.title AS title, n.modified_at AS modified_at,
          MAX(CASE WHEN f.field_id = :fStart THEN f.date_time_value END) AS start_at,
          MAX(CASE WHEN f.field_id = :fEnd THEN f.date_time_value END) AS end_at,
          MAX(CASE WHEN f.field_id = :fAllDay THEN f.boolean_value END) AS all_day,
          MAX(CASE WHEN f.field_id = :fLocation THEN f.text_value END) AS location
        FROM graph_nodes n
        JOIN graph_node_tags t ON t.node_id = n.node_id AND t.tag_id = :eventTag
        LEFT JOIN graph_facts f ON f.node_id = n.node_id AND f.tag_id = :eventTag
        WHERE n.deleted_at IS NULL
        GROUP BY n.node_id, n.title, n.modified_at
        """,
      arguments: [
        ":eventTag": .text(eventTag),
        ":fStart": .text(CoreEventFieldIDs.start.rawValue),
        ":fEnd": .text(CoreEventFieldIDs.end.rawValue),
        ":fAllDay": .text(CoreEventFieldIDs.allDay.rawValue),
        ":fLocation": .text(CoreEventFieldIDs.location.rawValue),
      ]
    )

    let attendeesByEvent = try attendeeNamesByEvent()

    let startMillis = Int64(authorization.start.millisecondsSince1970)
    let endMillis = Int64(authorization.end.millisecondsSince1970)
    var candidates: [(row: EventFactRow, attendees: [String])] = []
    for dict in result.dictionaries() {
      guard let row = Self.decodeEventRow(dict) else { continue }
      guard let startAt = row.startAt else { continue }
      let startMS = Int64(startAt.millisecondsSince1970)
      guard startMS < endMillis else { continue }
      if authorization.includeOngoing {
        let endMS = row.endAt.map { Int64($0.millisecondsSince1970) } ?? startMS
        guard endMS > startMillis else { continue }
      } else {
        guard startMS >= startMillis else { continue }
      }
      let attendees = attendeesByEvent[row.nodeID] ?? []
      if !normalizedQuery.isEmpty {
        let matchesTitle = row.title.localizedCaseInsensitiveContains(normalizedQuery)
        let matchesLocation = row.location?.localizedCaseInsensitiveContains(normalizedQuery) ?? false
        let matchesAttendee = attendees.contains {
          $0.localizedCaseInsensitiveContains(normalizedQuery)
        }
        guard matchesTitle || matchesLocation || matchesAttendee else { continue }
      }
      candidates.append((row, attendees))
    }
    candidates.sort { $0.row.startAt! < $1.row.startAt! }

    let limit = authorization.maximumResults
    let events = candidates.prefix(limit).map { Self.buildCalendarEvent(row: $0.row, attendeeNames: $0.attendees) }
    return AssistantCalendarResults(events: Array(events), truncated: candidates.count > limit)
  }

  // MARK: - meetingBrief

  public nonisolated func meetingBrief(
    authorization: AssistantMeetingBriefAuthorization,
    candidateSourceID: String
  ) throws -> AssistantMeetingBrief {
    guard authorization.allowedSourceIDs.contains(candidateSourceID) else {
      throw AssistantDataAccessError.invalidSource
    }
    guard let nodeID = AssistantReadToolSupport.pageID(fromCalendarSourceID: candidateSourceID) else {
      throw AssistantDataAccessError.invalidSource
    }
    let eventTag = CoreEventFieldIDs.supertagID.rawValue

    let result = try query(
      sql: """
        SELECT n.node_id AS node_id, n.title AS title, n.modified_at AS modified_at,
          MAX(CASE WHEN f.field_id = :fStart THEN f.date_time_value END) AS start_at,
          MAX(CASE WHEN f.field_id = :fEnd THEN f.date_time_value END) AS end_at,
          MAX(CASE WHEN f.field_id = :fAllDay THEN f.boolean_value END) AS all_day,
          MAX(CASE WHEN f.field_id = :fLocation THEN f.text_value END) AS location
        FROM graph_nodes n
        LEFT JOIN graph_facts f ON f.node_id = n.node_id AND f.tag_id = :eventTag
        WHERE n.node_id = :nodeID AND n.deleted_at IS NULL
        GROUP BY n.node_id, n.title, n.modified_at
        """,
      arguments: [
        ":nodeID": .text(nodeID),
        ":eventTag": .text(eventTag),
        ":fStart": .text(CoreEventFieldIDs.start.rawValue),
        ":fEnd": .text(CoreEventFieldIDs.end.rawValue),
        ":fAllDay": .text(CoreEventFieldIDs.allDay.rawValue),
        ":fLocation": .text(CoreEventFieldIDs.location.rawValue),
      ]
    )
    guard let dict = result.dictionaries().first, let row = Self.decodeEventRow(dict) else {
      throw AssistantDataAccessError.invalidSource
    }

    let attendeesRelation = Self.attendeesRelationID.rawValue
    let mentionsRelation = LocalGraphStore.mentionsRelationID.rawValue
    let personTag = CorePersonFieldIDs.supertagID.rawValue

    let attendeeRows = try query(
      sql: """
        SELECT p.node_id AS person_id, p.title AS person_title
        FROM graph_edges e
        JOIN graph_nodes p ON p.node_id = e.to_node_id
        WHERE e.relation_id = :relation AND e.direction = 'forward' AND e.canonical_source_node_id = :nodeID
          AND COALESCE(p.person_visibility, 'promoted') <> 'other'
        ORDER BY p.node_id
        """,
      arguments: [":relation": .text(attendeesRelation), ":nodeID": .text(nodeID)]
    )
    let mentionedRows = try query(
      sql: """
        SELECT p.node_id AS person_id, p.title AS person_title
        FROM graph_edges e
        JOIN graph_nodes p ON p.node_id = e.to_node_id
        JOIN graph_node_tags gt ON gt.node_id = p.node_id AND gt.tag_id = :personTag
        WHERE e.relation_id = :relation AND e.direction = 'forward' AND e.canonical_source_node_id = :nodeID
          AND COALESCE(p.person_visibility, 'promoted') <> 'other'
        ORDER BY p.node_id
        """,
      arguments: [
        ":relation": .text(mentionsRelation), ":nodeID": .text(nodeID), ":personTag": .text(personTag),
      ]
    )

    var seenPersonIDs = Set<String>()
    var people: [AssistantSource] = []
    var attendeeNames: [String] = []
    for dict in attendeeRows.dictionaries() {
      guard let personID = dict["person_id"]?.stringValue, seenPersonIDs.insert(personID).inserted
      else { continue }
      let title = dict["person_title"]?.stringValue ?? personID
      attendeeNames.append(title)
      people.append(
        AssistantSource(id: "page:\(personID)", kind: .page, title: AssistantReadToolSupport.bounded(title, maximum: 120)))
    }
    var mentionedTotal = 0
    for dict in mentionedRows.dictionaries() {
      guard let personID = dict["person_id"]?.stringValue else { continue }
      mentionedTotal += 1
      guard seenPersonIDs.insert(personID).inserted else { continue }
      let title = dict["person_title"]?.stringValue ?? personID
      people.append(
        AssistantSource(id: "page:\(personID)", kind: .page, title: AssistantReadToolSupport.bounded(title, maximum: 120)))
    }

    let limit = authorization.maximumPeople
    let truncated = people.count > limit
    let boundedPeople = Array(people.prefix(limit))
    let event = Self.buildCalendarEvent(row: row, attendeeNames: attendeeNames)
    let peopleEvidence = boundedPeople.flatMap(AssistantReadToolSupport.pageEvidence)
    return AssistantMeetingBrief(
      event: event,
      people: boundedPeople,
      evidence: event.evidence + peopleEvidence,
      peopleTruncated: truncated
    )
  }

  // MARK: - searchTasks

  public nonisolated func searchTasks(
    authorization: AssistantTaskSearchAuthorization,
    candidateScope: AssistantTaskScope,
    candidateQuery: String = "",
    now: Date = Date(),
    calendar: Calendar = .current
  ) throws -> AssistantTaskResults {
    guard candidateScope == authorization.scope else { throw AssistantDataAccessError.invalidTaskScope }
    guard authorization.query.permits(candidateQuery) else {
      throw AssistantTurnRetrievalAuthorizationError.invalidQuery
    }
    let normalizedQuery = authorization.query.originalQuery
    let taskTag = CoreTaskFieldIDs.supertagID.rawValue

    let result = try query(
      sql: """
        SELECT n.node_id AS node_id, n.title AS title, n.modified_at AS modified_at,
          MAX(CASE WHEN f.field_id = :fStatus THEN f.text_value END) AS status,
          MAX(CASE WHEN f.field_id = :fPlacement THEN f.text_value END) AS placement,
          MAX(CASE WHEN f.field_id = :fScheduled THEN f.date_time_value END) AS scheduled_at,
          MAX(CASE WHEN f.field_id = :fDeadline THEN f.local_date_value END) AS deadline_at,
          MAX(CASE WHEN f.field_id = :fDue THEN f.date_time_value END) AS due_at,
          MAX(CASE WHEN f.field_id = :fCompletedAt THEN f.date_time_value END) AS completed_at,
          MAX(CASE WHEN f.field_id = :fPriority THEN f.text_value END) AS priority
        FROM graph_nodes n
        JOIN graph_node_tags t ON t.node_id = n.node_id AND t.tag_id = :taskTag
        LEFT JOIN graph_facts f ON f.node_id = n.node_id AND f.tag_id = :taskTag
        WHERE n.deleted_at IS NULL
        GROUP BY n.node_id, n.title, n.modified_at
        """,
      arguments: [
        ":taskTag": .text(taskTag),
        ":fStatus": .text(CoreTaskFieldIDs.status.rawValue),
        ":fPlacement": .text(CoreTaskFieldIDs.placement.rawValue),
        ":fScheduled": .text(CoreTaskFieldIDs.scheduled.rawValue),
        ":fDeadline": .text(CoreTaskFieldIDs.deadline.rawValue),
        ":fDue": .text(CoreTaskFieldIDs.due.rawValue),
        ":fCompletedAt": .text(CoreTaskFieldIDs.completedAt.rawValue),
        ":fPriority": .text(CoreTaskFieldIDs.priority.rawValue),
      ]
    )

    let rows = result.dictionaries().compactMap(Self.decodeTaskRow)
    let today = calendar.startOfDay(for: now)
    let scoped = rows.filter { Self.taskMatches(scope: candidateScope, row: $0, today: today, calendar: calendar) }
    let filtered = normalizedQuery.isEmpty
      ? scoped
      : scoped.filter { $0.title.localizedCaseInsensitiveContains(normalizedQuery) }
    let sorted = filtered.sorted { Self.taskOrder(scope: candidateScope, lhs: $0, rhs: $1) }

    let limit = authorization.maximumResults
    let selected = sorted.prefix(limit)
    var sources: [AssistantSource] = []
    var evidence: [AssistantEvidenceFact] = []
    for row in selected {
      let sourceID = "task:\(row.nodeID)"
      let title = AssistantReadToolSupport.bounded(row.title, maximum: 120)
      sources.append(AssistantSource(id: sourceID, kind: .page, title: title, modifiedAt: row.modifiedAt))
      evidence.append(
        AssistantEvidenceFact(
          id: "\(sourceID)#summary", sourceID: sourceID, kind: .taskSummary,
          spokenText: Self.taskSpokenText(
            title: title, scope: candidateScope, row: row, today: today, now: now, calendar: calendar)
        ))
    }
    return AssistantTaskResults(
      scope: candidateScope, sources: sources, evidence: evidence, truncated: sorted.count > limit)
  }

  // MARK: - Internals shared across the tools above

  fileprivate struct EventFactRow {
    var nodeID: String
    var title: String
    var modifiedAt: Date?
    var startAt: Date?
    var endAt: Date?
    var isAllDay: Bool
    var location: String?
  }

  fileprivate static func decodeEventRow(_ dict: [String: GraphSQLValue]) -> EventFactRow? {
    guard let nodeID = dict["node_id"]?.stringValue, let title = dict["title"]?.stringValue else {
      return nil
    }
    return EventFactRow(
      nodeID: nodeID,
      title: title,
      modifiedAt: dict["modified_at"]?.int64Value.map(Date.init(millisecondsSince1970:)),
      startAt: dict["start_at"]?.int64Value.map(Date.init(millisecondsSince1970:)),
      endAt: dict["end_at"]?.int64Value.map(Date.init(millisecondsSince1970:)),
      isAllDay: (dict["all_day"]?.boolValue) ?? false,
      location: dict["location"]?.stringValue
    )
  }

  fileprivate static let attendeesRelationID = BuiltInRelations.relationID(
    for: SupertagPropertyKey(
      supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.attendees))

  fileprivate nonisolated func attendeeNamesByEvent() throws -> [String: [String]] {
    let rows = try query(
      sql: """
        SELECT e.canonical_source_node_id AS event_node_id, p.title AS person_title
        FROM graph_edges e
        JOIN graph_nodes p ON p.node_id = e.to_node_id
        WHERE e.relation_id = :relation AND e.direction = 'forward'
          AND COALESCE(p.person_visibility, 'promoted') <> 'other'
        ORDER BY e.canonical_source_node_id, p.node_id
        """,
      arguments: [":relation": .text(Self.attendeesRelationID.rawValue)]
    )
    var result: [String: [String]] = [:]
    for dict in rows.dictionaries() {
      guard let eventID = dict["event_node_id"]?.stringValue, let name = dict["person_title"]?.stringValue
      else { continue }
      result[eventID, default: []].append(name)
    }
    return result
  }

  fileprivate static func buildCalendarEvent(row: EventFactRow, attendeeNames: [String]) -> AssistantCalendarEvent {
    let sourceID = AssistantReadToolSupport.calendarSourceID(pageID: row.nodeID)
    let title = AssistantReadToolSupport.bounded(row.title, maximum: 120)
    let boundedLocation = row.location.map { AssistantReadToolSupport.bounded($0, maximum: 160) }
    let boundedAttendees = attendeeNames.prefix(12).map { AssistantReadToolSupport.bounded($0, maximum: 120) }
    let source = AssistantSource(
      id: sourceID, kind: .calendarEvent, title: title, occurredAt: row.startAt, modifiedAt: row.modifiedAt)

    var evidence = [
      AssistantEvidenceFact(
        id: "\(sourceID)#schedule", sourceID: sourceID, kind: .eventSchedule,
        spokenText: row.startAt.map {
          "\(title) is scheduled for \($0.formatted(date: .abbreviated, time: row.isAllDay ? .omitted : .shortened))."
        } ?? "\(title) has no scheduled time.")
    ]
    if let location = boundedLocation, !location.isEmpty {
      evidence.append(
        AssistantEvidenceFact(
          id: "\(sourceID)#location", sourceID: sourceID, kind: .eventLocation,
          spokenText: "The location is \(location)."))
    }
    if !boundedAttendees.isEmpty {
      evidence.append(
        AssistantEvidenceFact(
          id: "\(sourceID)#attendees", sourceID: sourceID, kind: .eventAttendees,
          spokenText: "Attendees include \(boundedAttendees.joined(separator: ", "))."))
    }
    return AssistantCalendarEvent(
      source: source, startDate: row.startAt, endDate: row.endAt, isAllDay: row.isAllDay,
      location: boundedLocation, attendees: Array(boundedAttendees), evidence: evidence)
  }

  fileprivate struct TaskRow {
    var nodeID: String
    var title: String
    var modifiedAt: Date?
    var status: CoreTaskStatus?
    var placement: CoreTaskPlacement?
    var scheduledAt: Date?
    var deadlineAt: Date?
    var dueAt: Date?
    var completedAt: Date?
    var priority: CoreTaskPriority?

    var isActive: Bool { status != .done && status != .cancelled }
  }

  fileprivate static func decodeTaskRow(_ dict: [String: GraphSQLValue]) -> TaskRow? {
    guard let nodeID = dict["node_id"]?.stringValue, let title = dict["title"]?.stringValue else {
      return nil
    }
    return TaskRow(
      nodeID: nodeID,
      title: title,
      modifiedAt: dict["modified_at"]?.int64Value.map(Date.init(millisecondsSince1970:)),
      status: dict["status"]?.stringValue.flatMap(CoreTaskStatus.init(rawValue:)),
      placement: dict["placement"]?.stringValue.flatMap(CoreTaskPlacement.init(rawValue:)),
      scheduledAt: dict["scheduled_at"]?.int64Value.map(Date.init(millisecondsSince1970:)),
      deadlineAt: dict["deadline_at"]?.stringValue.flatMap(Date.fromEnchiridionISO8601),
      dueAt: dict["due_at"]?.int64Value.map(Date.init(millisecondsSince1970:)),
      completedAt: dict["completed_at"]?.int64Value.map(Date.init(millisecondsSince1970:)),
      priority: dict["priority"]?.stringValue.flatMap(CoreTaskPriority.init(rawValue:))
    )
  }

  /// `AssistantTaskScope` semantics — a genuine new design over this
  /// package's actual `CoreTaskFieldIDs` fields, NOT a port (see this
  /// file's header). `placement` only distinguishes inbox/anytime/someday
  /// here (unlike the old app's four-way `TaskPlacement`, which also had
  /// `.today`/`.scheduled` values) — "today" and date-scheduled tasks are
  /// derived from the `scheduled`/`deadline` fields instead.
  fileprivate static func taskMatches(
    scope: AssistantTaskScope, row: TaskRow, today: Date, calendar: Calendar
  ) -> Bool {
    switch scope {
    case .today:
      guard row.isActive else { return false }
      if let scheduled = row.scheduledAt { if calendar.startOfDay(for: scheduled) <= today { return true } }
      if let deadline = row.deadlineAt { if calendar.startOfDay(for: deadline) <= today { return true } }
      return false
    case .tomorrow:
      guard row.isActive, let tomorrow = calendar.date(byAdding: .day, value: 1, to: today) else {
        return false
      }
      if let scheduled = row.scheduledAt, calendar.isDate(scheduled, inSameDayAs: tomorrow) { return true }
      if let deadline = row.deadlineAt, calendar.isDate(deadline, inSameDayAs: tomorrow) { return true }
      return false
    case .inbox:
      return row.isActive && row.placement == .inbox
    case .upcoming:
      guard row.isActive else { return false }
      if let scheduled = row.scheduledAt, calendar.startOfDay(for: scheduled) > today { return true }
      if let deadline = row.deadlineAt, calendar.startOfDay(for: deadline) > today { return true }
      return false
    case .anytime:
      return row.isActive && row.placement == .anytime && row.scheduledAt == nil && row.deadlineAt == nil
    case .someday:
      return row.isActive && row.placement == .someday
    case .logbook:
      return row.status == .done || row.status == .cancelled
    case .all:
      return row.isActive
    }
  }

  fileprivate static func taskOrder(scope: AssistantTaskScope, lhs: TaskRow, rhs: TaskRow) -> Bool {
    if scope == .logbook {
      let lhsDate = lhs.completedAt ?? .distantPast
      let rhsDate = rhs.completedAt ?? .distantPast
      if lhsDate != rhsDate { return lhsDate > rhsDate }
      return lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
    }
    if scope == .today || scope == .tomorrow || scope == .upcoming {
      let lhsDate = lhs.scheduledAt ?? lhs.deadlineAt ?? .distantFuture
      let rhsDate = rhs.scheduledAt ?? rhs.deadlineAt ?? .distantFuture
      if lhsDate != rhsDate { return lhsDate < rhsDate }
    }
    let lhsPriority = lhs.priority?.sortRank ?? -1
    let rhsPriority = rhs.priority?.sortRank ?? -1
    if lhsPriority != rhsPriority { return lhsPriority > rhsPriority }
    return lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
  }

  fileprivate static func taskSpokenText(
    title: String, scope: AssistantTaskScope, row: TaskRow, today: Date, now: Date, calendar: Calendar
  ) -> String {
    var details: [String] = []
    if !row.isActive {
      details.append(row.status == .done ? "completed" : "cancelled")
    } else if let deadline = row.deadlineAt {
      let deadlineDay = calendar.startOfDay(for: deadline)
      if deadlineDay < today {
        details.append("overdue, due \(deadline.formatted(date: .abbreviated, time: .omitted))")
      } else if calendar.isDate(deadline, inSameDayAs: now) {
        details.append("due today")
      } else {
        details.append("due \(deadline.formatted(date: .abbreviated, time: .omitted))")
      }
    }
    if let scheduled = row.scheduledAt {
      let scheduledDay = calendar.startOfDay(for: scheduled)
      if scheduledDay < today, !details.contains(where: { $0.hasPrefix("overdue") }) {
        details.append("overdue")
      } else if calendar.isDate(scheduled, inSameDayAs: now) {
        details.append("scheduled for today")
      } else if scope == .tomorrow, scheduledDay > today {
        details.append("scheduled for tomorrow")
      } else {
        details.append("scheduled for \(scheduled.formatted(date: .abbreviated, time: .omitted))")
      }
    }
    if let priority = row.priority, priority != .low {
      details.append("\(priority.rawValue) priority")
    }
    return details.isEmpty ? "\(title)." : "\(title) is \(details.joined(separator: ", "))."
  }

  fileprivate static func escapeLike(_ value: String) -> String {
    value
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "%", with: "\\%")
      .replacingOccurrences(of: "_", with: "\\_")
  }
}

extension CoreTaskPriority {
  fileprivate var sortRank: Int {
    switch self {
    case .low: 0
    case .medium: 1
    case .high: 2
    case .urgent: 3
    }
  }
}

extension GraphQueryResult {
  fileprivate func dictionaries() -> [[String: GraphSQLValue]] {
    rows.map { row in Dictionary(uniqueKeysWithValues: zip(columns.map(\.name), row.values)) }
  }
}

extension GraphSQLValue {
  fileprivate var stringValue: String? {
    if case .text(let value) = self { value } else { nil }
  }

  fileprivate var int64Value: Int64? {
    if case .integer(let value) = self { value } else { nil }
  }

  fileprivate var boolValue: Bool? {
    if case .integer(let value) = self { value != 0 } else { nil }
  }
}
