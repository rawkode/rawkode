// AssistantReadToolsTests.swift
// EnchiridionStoreTests
//
// Task #66 ("Assistant read tools"). Exercises `searchPages`/`searchTasks`/
// `findCalendarEvents`/`meetingBrief` (`AssistantReadTools.swift`) against a
// REAL temporary `LocalGraphStore` — real `writeProjection` writes, real
// bounded-SQL reads through `GraphSQLExecutor`, not mocked at any layer.
// Required coverage per the task brief:
//   1. Each tool: a normal search returns correct results + evidence facts.
//   2. `personVisibility` exclusion: a page seeded with `person_visibility
//      == "other"` must never appear in `searchPages` results, even when it
//      matches the query.
//   3. Pre-flight authorization enforcement AT THE TOOL-EXECUTION BOUNDARY:
//      a candidate argument outside what the authorization permits
//      (a query term never approved, a task scope that doesn't match, a
//      calendar source ID outside the allowlist) must be rejected.

import EnchiridionCore
import EnchiridionSchema
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionStore

final class AssistantReadToolsTests: XCTestCase {
  private func makeStore() throws -> LocalGraphStore {
    try LocalGraphStore.openTemporary()
  }

  private func page(_ n: Int) -> PageID {
    PageID.free(UUID(uuidString: String(format: "00000000-0000-0000-0000-%012d", n))!)
  }

  // MARK: - searchPages

  func testSearchPagesReturnsMatchingSourcesWithTitleAndExcerptEvidence() async throws {
    let store = try makeStore()
    let matchID = page(1)
    try await store.writeProjection(
      pageID: matchID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Grocery run", plainText: "Grocery run\nBuy milk and eggs.", deletedAt: nil,
        isPinned: false, references: [], graphEdges: [], objectMetadata: .init()))
    let unrelatedID = page(2)
    try await store.writeProjection(
      pageID: unrelatedID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Unrelated page", plainText: "Nothing to see here.", deletedAt: nil,
        isPinned: false, references: [], graphEdges: [], objectMetadata: .init()))

    let query = try AssistantApprovedQuery(originalQuery: "grocery")
    let authorization = try AssistantPageSearchAuthorization(query: query, maximumResults: 5)
    let result = try store.searchPages(authorization: authorization, candidateQuery: "grocery")

    XCTAssertEqual(result.sources.count, 1)
    XCTAssertEqual(result.sources.first?.title, "Grocery run")
    XCTAssertTrue(result.evidence.contains { $0.kind == .pageTitle })
    XCTAssertTrue(result.evidence.contains { $0.kind == .pageExcerpt })
    XCTAssertFalse(result.truncated)
  }

  func testSearchPagesExcludesPersonVisibilityOtherPages() async throws {
    let store = try makeStore()
    let visibleID = page(3)
    try await store.writeProjection(
      pageID: visibleID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Widget project notes", plainText: "Widget project notes body", deletedAt: nil,
        isPinned: false, references: [], graphEdges: [], objectMetadata: .init()))
    let attendeeID = page(4)
    try await store.writeProjection(
      pageID: attendeeID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Widget Attendee", plainText: "Widget Attendee calendar note", deletedAt: nil,
        isPinned: false, references: [], graphEdges: [],
        objectMetadata: .init(
          supertagIDs: [CorePersonFieldIDs.supertagID],
          personVisibility: .other,
          personOrigin: .calendarAttendee
        )))

    let query = try AssistantApprovedQuery(originalQuery: "widget")
    let authorization = try AssistantPageSearchAuthorization(query: query, maximumResults: 5)
    let result = try store.searchPages(authorization: authorization, candidateQuery: "widget")

    XCTAssertEqual(result.sources.map(\.title), ["Widget project notes"])
    XCTAssertFalse(
      result.sources.contains { $0.title.contains("Attendee") },
      "a calendar-attendee-derived Person page (personVisibility \"other\") must never leak into assistant results")
  }

  func testSearchPagesRejectsACandidateQueryOutsideTheApprovedSet() async throws {
    let store = try makeStore()
    let query = try AssistantApprovedQuery(originalQuery: "grocery")
    let authorization = try AssistantPageSearchAuthorization(query: query, maximumResults: 5)

    XCTAssertThrowsError(
      try store.searchPages(authorization: authorization, candidateQuery: "grocery OR salary details")
    ) { error in
      XCTAssertEqual(error as? AssistantTurnRetrievalAuthorizationError, .invalidQuery)
    }
  }

  // MARK: - findCalendarEvents

  private func eventProjection(
    id: PageID, title: String, start: Date, end: Date, location: String?, attendeeID: PageID?
  ) -> PageDocumentProjection {
    var properties: [SupertagPropertyKey: [SupertagValue]] = [
      .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.start): [.dateTime(start)],
      .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.end): [.dateTime(end)],
      .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.allDay): [.boolean(false)],
    ]
    if let location {
      properties[.init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.location)] = [
        .text(location)
      ]
    }
    var edges: [KnowledgeEdge] = []
    if let attendeeID {
      edges.append(
        KnowledgeEdge(
          relationID: BuiltInRelations.relationID(
            for: .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.attendees)),
          sourceNodeID: id, targetNodeID: attendeeID))
    }
    return .init(
      title: title, plainText: title, deletedAt: nil, isPinned: false, references: [],
      graphEdges: edges,
      objectMetadata: .init(supertagIDs: [CoreEventFieldIDs.supertagID], properties: properties))
  }

  func testFindCalendarEventsReturnsEventsInRangeWithScheduleAndAttendeeEvidence() async throws {
    let store = try makeStore()
    let eventID = page(10)
    let attendeeID = page(11)
    try await store.writeProjection(
      pageID: attendeeID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Alice Attendee", plainText: "", deletedAt: nil, isPinned: false, references: [],
        graphEdges: [], objectMetadata: .init(supertagIDs: [CorePersonFieldIDs.supertagID])))
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    let end = start.addingTimeInterval(3_600)
    let projection = eventProjection(
      id: eventID, title: "Roadmap sync", start: start, end: end, location: "Room 1",
      attendeeID: attendeeID)
    try await store.writeProjection(
      pageID: eventID, kind: .calendarMaterializedEvent(.init(uidDigest: "digest", occurrenceToken: "1")),
      createdAt: Date(), modifiedAt: Date(), projection: projection)

    let query = try AssistantApprovedQuery(originalQuery: "")
    let authorization = try AssistantCalendarSearchAuthorization(
      query: query, start: start.addingTimeInterval(-3_600), end: end.addingTimeInterval(3_600),
      maximumResults: 5, includeOngoing: false)
    let result = try store.findCalendarEvents(authorization: authorization, candidateQuery: "")

    XCTAssertEqual(result.events.count, 1)
    let event = try XCTUnwrap(result.events.first)
    XCTAssertEqual(event.source.title, "Roadmap sync")
    XCTAssertEqual(event.location, "Room 1")
    XCTAssertEqual(event.attendees, ["Alice Attendee"])
    XCTAssertTrue(event.evidence.contains { $0.kind == .eventSchedule })
    XCTAssertTrue(event.evidence.contains { $0.kind == .eventLocation })
    XCTAssertTrue(event.evidence.contains { $0.kind == .eventAttendees })
    XCTAssertEqual(event.source.kind, .calendarEvent)
  }

  func testFindCalendarEventsExcludesEventsOutsideTheAuthorizedRange() async throws {
    let store = try makeStore()
    let eventID = page(12)
    let farFuture = Date(timeIntervalSince1970: 2_000_000_000)
    let projection = eventProjection(
      id: eventID, title: "Far future event", start: farFuture, end: farFuture.addingTimeInterval(3_600),
      location: nil, attendeeID: nil)
    try await store.writeProjection(
      pageID: eventID, kind: .calendarMaterializedEvent(.init(uidDigest: "d2", occurrenceToken: "2")),
      createdAt: Date(), modifiedAt: Date(), projection: projection)

    let query = try AssistantApprovedQuery(originalQuery: "")
    let authorization = try AssistantCalendarSearchAuthorization(
      query: query, start: Date(timeIntervalSince1970: 1_800_000_000),
      end: Date(timeIntervalSince1970: 1_800_100_000), maximumResults: 5, includeOngoing: false)
    let result = try store.findCalendarEvents(authorization: authorization, candidateQuery: "")

    XCTAssertTrue(result.events.isEmpty)
  }

  func testFindCalendarEventsRejectsACandidateQueryOutsideTheApprovedSet() async throws {
    let store = try makeStore()
    let query = try AssistantApprovedQuery(originalQuery: "standup")
    let authorization = try AssistantCalendarSearchAuthorization(
      query: query, start: Date(), end: Date().addingTimeInterval(3_600), maximumResults: 5,
      includeOngoing: false)

    XCTAssertThrowsError(
      try store.findCalendarEvents(authorization: authorization, candidateQuery: "unapproved term")
    ) { error in
      XCTAssertEqual(error as? AssistantTurnRetrievalAuthorizationError, .invalidQuery)
    }
  }

  func testFindCalendarEventsExcludesPersonVisibilityOtherAttendees() async throws {
    let store = try makeStore()
    let eventID = page(13)
    let visibleAttendeeID = page(14)
    let hiddenAttendeeID = page(15)
    try await store.writeProjection(
      pageID: visibleAttendeeID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Visible Attendee", plainText: "", deletedAt: nil, isPinned: false, references: [],
        graphEdges: [], objectMetadata: .init(supertagIDs: [CorePersonFieldIDs.supertagID])))
    try await store.writeProjection(
      pageID: hiddenAttendeeID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Hidden Attendee", plainText: "", deletedAt: nil, isPinned: false, references: [],
        graphEdges: [],
        objectMetadata: .init(
          supertagIDs: [CorePersonFieldIDs.supertagID],
          personVisibility: .other,
          personOrigin: .calendarAttendee
        )))
    let attendeesRelation = BuiltInRelations.relationID(
      for: .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.attendees))
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    let end = start.addingTimeInterval(3_600)
    let projection = PageDocumentProjection(
      title: "Roadmap sync", plainText: "Roadmap sync", deletedAt: nil, isPinned: false, references: [],
      graphEdges: [
        KnowledgeEdge(relationID: attendeesRelation, sourceNodeID: eventID, targetNodeID: visibleAttendeeID),
        KnowledgeEdge(relationID: attendeesRelation, sourceNodeID: eventID, targetNodeID: hiddenAttendeeID),
      ],
      objectMetadata: .init(
        supertagIDs: [CoreEventFieldIDs.supertagID],
        properties: [
          .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.start): [.dateTime(start)],
          .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.end): [.dateTime(end)],
          .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.allDay): [.boolean(false)],
        ]))
    try await store.writeProjection(
      pageID: eventID, kind: .calendarMaterializedEvent(.init(uidDigest: "digestHidden", occurrenceToken: "1")),
      createdAt: Date(), modifiedAt: Date(), projection: projection)

    let query = try AssistantApprovedQuery(originalQuery: "")
    let authorization = try AssistantCalendarSearchAuthorization(
      query: query, start: start.addingTimeInterval(-3_600), end: end.addingTimeInterval(3_600),
      maximumResults: 5, includeOngoing: false)
    let result = try store.findCalendarEvents(authorization: authorization, candidateQuery: "")

    XCTAssertEqual(result.events.count, 1)
    let event = try XCTUnwrap(result.events.first)
    XCTAssertEqual(event.attendees, ["Visible Attendee"])
    XCTAssertFalse(
      event.attendees.contains("Hidden Attendee"),
      "a calendar-attendee-derived Person page (personVisibility \"other\") must never leak into findCalendarEvents attendees")
    let attendeesEvidence = event.evidence.first { $0.kind == .eventAttendees }
    XCTAssertTrue(attendeesEvidence?.spokenText.contains("Visible Attendee") ?? false)
    XCTAssertFalse(attendeesEvidence?.spokenText.contains("Hidden Attendee") ?? false)
  }

  // MARK: - meetingBrief

  func testMeetingBriefResolvesTheEventAndItsAttendees() async throws {
    let store = try makeStore()
    let eventID = page(20)
    let attendeeID = page(21)
    try await store.writeProjection(
      pageID: attendeeID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Bob Attendee", plainText: "", deletedAt: nil, isPinned: false, references: [],
        graphEdges: [], objectMetadata: .init(supertagIDs: [CorePersonFieldIDs.supertagID])))
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    let projection = eventProjection(
      id: eventID, title: "Design review", start: start, end: start.addingTimeInterval(1_800),
      location: "HQ", attendeeID: attendeeID)
    try await store.writeProjection(
      pageID: eventID, kind: .calendarMaterializedEvent(.init(uidDigest: "d3", occurrenceToken: "3")),
      createdAt: Date(), modifiedAt: Date(), projection: projection)

    let sourceID = AssistantReadToolSupport.calendarSourceID(pageID: eventID.rawValue)
    let authorization = try AssistantMeetingBriefAuthorization(
      allowedSourceIDs: [sourceID], maximumPeople: 5)
    let brief = try store.meetingBrief(authorization: authorization, candidateSourceID: sourceID)

    XCTAssertEqual(brief.event.source.title, "Design review")
    XCTAssertEqual(brief.people.map(\.title), ["Bob Attendee"])
    XCTAssertFalse(brief.peopleTruncated)
    XCTAssertFalse(brief.evidence.isEmpty)
  }

  func testMeetingBriefRejectsASourceIDOutsideTheAllowlist() async throws {
    let store = try makeStore()
    let allowedSourceID = AssistantReadToolSupport.calendarSourceID(pageID: page(30).rawValue)
    let otherSourceID = AssistantReadToolSupport.calendarSourceID(pageID: page(31).rawValue)
    let authorization = try AssistantMeetingBriefAuthorization(
      allowedSourceIDs: [allowedSourceID], maximumPeople: 5)

    XCTAssertThrowsError(
      try store.meetingBrief(authorization: authorization, candidateSourceID: otherSourceID)
    ) { error in
      XCTAssertEqual(error as? AssistantDataAccessError, .invalidSource)
    }
  }

  func testMeetingBriefExcludesPersonVisibilityOtherAttendeesAndMentions() async throws {
    let store = try makeStore()
    let eventID = page(22)
    let visibleAttendeeID = page(23)
    let hiddenAttendeeID = page(24)
    let visibleMentionedID = page(25)
    let hiddenMentionedID = page(26)

    try await store.writeProjection(
      pageID: visibleAttendeeID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Visible Attendee", plainText: "", deletedAt: nil, isPinned: false, references: [],
        graphEdges: [], objectMetadata: .init(supertagIDs: [CorePersonFieldIDs.supertagID])))
    try await store.writeProjection(
      pageID: hiddenAttendeeID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Hidden Attendee", plainText: "", deletedAt: nil, isPinned: false, references: [],
        graphEdges: [],
        objectMetadata: .init(
          supertagIDs: [CorePersonFieldIDs.supertagID],
          personVisibility: .other,
          personOrigin: .calendarAttendee
        )))
    try await store.writeProjection(
      pageID: visibleMentionedID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Visible Mentioned", plainText: "", deletedAt: nil, isPinned: false, references: [],
        graphEdges: [], objectMetadata: .init(supertagIDs: [CorePersonFieldIDs.supertagID])))
    try await store.writeProjection(
      pageID: hiddenMentionedID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Hidden Mentioned", plainText: "", deletedAt: nil, isPinned: false, references: [],
        graphEdges: [],
        objectMetadata: .init(
          supertagIDs: [CorePersonFieldIDs.supertagID],
          personVisibility: .other,
          personOrigin: .calendarAttendee
        )))

    let attendeesRelation = BuiltInRelations.relationID(
      for: .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.attendees))
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    let projection = PageDocumentProjection(
      title: "Design review", plainText: "Design review", deletedAt: nil, isPinned: false,
      references: [
        PageReference(sourcePageID: eventID, targetPageID: visibleMentionedID, fallbackLabel: "Visible Mentioned"),
        PageReference(sourcePageID: eventID, targetPageID: hiddenMentionedID, fallbackLabel: "Hidden Mentioned"),
      ],
      graphEdges: [
        KnowledgeEdge(relationID: attendeesRelation, sourceNodeID: eventID, targetNodeID: visibleAttendeeID),
        KnowledgeEdge(relationID: attendeesRelation, sourceNodeID: eventID, targetNodeID: hiddenAttendeeID),
      ],
      objectMetadata: .init(
        supertagIDs: [CoreEventFieldIDs.supertagID],
        properties: [
          .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.start): [.dateTime(start)],
          .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.end): [
            .dateTime(start.addingTimeInterval(1_800))
          ],
          .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.allDay): [.boolean(false)],
        ]))
    try await store.writeProjection(
      pageID: eventID, kind: .calendarMaterializedEvent(.init(uidDigest: "d4", occurrenceToken: "4")),
      createdAt: Date(), modifiedAt: Date(), projection: projection)

    let sourceID = AssistantReadToolSupport.calendarSourceID(pageID: eventID.rawValue)
    let authorization = try AssistantMeetingBriefAuthorization(
      allowedSourceIDs: [sourceID], maximumPeople: 8)
    let brief = try store.meetingBrief(authorization: authorization, candidateSourceID: sourceID)

    XCTAssertEqual(Set(brief.people.map(\.title)), ["Visible Attendee", "Visible Mentioned"])
    XCTAssertFalse(
      brief.people.contains { $0.title == "Hidden Attendee" },
      "a calendar-attendee-derived Person page (personVisibility \"other\") must never leak into meetingBrief attendees")
    XCTAssertFalse(
      brief.people.contains { $0.title == "Hidden Mentioned" },
      "a calendar-attendee-derived Person page (personVisibility \"other\") must never leak into meetingBrief mentions")
    XCTAssertFalse(brief.evidence.contains { $0.spokenText.contains("Hidden Attendee") })
    XCTAssertFalse(brief.evidence.contains { $0.spokenText.contains("Hidden Mentioned") })
  }

  // MARK: - searchTasks

  private func taskProjection(
    title: String, status: CoreTaskStatus, placement: CoreTaskPlacement?, scheduled: Date? = nil,
    deadline: Date? = nil, completedAt: Date? = nil, priority: CoreTaskPriority? = nil
  ) -> PageDocumentProjection {
    var properties: [SupertagPropertyKey: [SupertagValue]] = [
      .init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.status): [
        .select(status.rawValue)
      ]
    ]
    if let placement {
      properties[.init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.placement)] = [
        .select(placement.rawValue)
      ]
    }
    if let scheduled {
      properties[.init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.scheduled)] = [
        .dateTime(scheduled)
      ]
    }
    if let deadline {
      properties[.init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.deadline)] = [
        .date(deadline)
      ]
    }
    if let completedAt {
      properties[.init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.completedAt)] = [
        .dateTime(completedAt)
      ]
    }
    if let priority {
      properties[.init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.priority)] = [
        .select(priority.rawValue)
      ]
    }
    return .init(
      title: title, plainText: title, deletedAt: nil, isPinned: false, references: [], graphEdges: [],
      objectMetadata: .init(supertagIDs: [CoreTaskFieldIDs.supertagID], properties: properties))
  }

  func testSearchTasksTodayScopeIncludesOverdueAndTodayScheduledActiveTasks() async throws {
    let store = try makeStore()
    let calendar = Calendar(identifier: .gregorian)
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let today = calendar.startOfDay(for: now)
    let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
    let tomorrow = calendar.date(byAdding: .day, value: 1, to: today)!

    try await store.writeProjection(
      pageID: page(40), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Overdue task", status: .toDo, placement: nil, scheduled: yesterday))
    try await store.writeProjection(
      pageID: page(41), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Due today", status: .toDo, placement: nil, scheduled: today))
    try await store.writeProjection(
      pageID: page(42), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Due tomorrow", status: .toDo, placement: nil, scheduled: tomorrow))
    try await store.writeProjection(
      pageID: page(43), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Already done", status: .done, placement: nil, scheduled: today))

    let query = try AssistantApprovedQuery(originalQuery: "")
    let authorization = try AssistantTaskSearchAuthorization(scope: .today, query: query, maximumResults: 10)
    let result = try store.searchTasks(
      authorization: authorization, candidateScope: .today, now: now, calendar: calendar)

    XCTAssertEqual(Set(result.sources.map(\.title)), ["Overdue task", "Due today"])
    XCTAssertTrue(result.evidence.allSatisfy { $0.kind == .taskSummary })
  }

  func testSearchTasksInboxScopeReturnsOnlyInboxPlacedActiveTasks() async throws {
    let store = try makeStore()
    try await store.writeProjection(
      pageID: page(50), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Inbox item", status: .toDo, placement: .inbox))
    try await store.writeProjection(
      pageID: page(51), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Someday item", status: .toDo, placement: .someday))

    let query = try AssistantApprovedQuery(originalQuery: "")
    let authorization = try AssistantTaskSearchAuthorization(scope: .inbox, query: query, maximumResults: 10)
    let result = try store.searchTasks(authorization: authorization, candidateScope: .inbox)

    XCTAssertEqual(result.sources.map(\.title), ["Inbox item"])
  }

  func testSearchTasksLogbookScopeReturnsCompletedAndCancelledOrderedByCompletionDescending() async throws {
    let store = try makeStore()
    let older = Date(timeIntervalSince1970: 1_700_000_000)
    let newer = Date(timeIntervalSince1970: 1_800_000_000)
    try await store.writeProjection(
      pageID: page(60), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Older completion", status: .done, placement: nil, completedAt: older))
    try await store.writeProjection(
      pageID: page(61), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Newer completion", status: .cancelled, placement: nil, completedAt: newer))
    try await store.writeProjection(
      pageID: page(62), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Still active", status: .toDo, placement: .inbox))

    let query = try AssistantApprovedQuery(originalQuery: "")
    let authorization = try AssistantTaskSearchAuthorization(scope: .logbook, query: query, maximumResults: 10)
    let result = try store.searchTasks(authorization: authorization, candidateScope: .logbook)

    XCTAssertEqual(result.sources.map(\.title), ["Newer completion", "Older completion"])
  }

  func testSearchTasksAllScopeOrdersByPriorityThenTitle() async throws {
    let store = try makeStore()
    try await store.writeProjection(
      pageID: page(70), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Low priority", status: .toDo, placement: .anytime, priority: .low))
    try await store.writeProjection(
      pageID: page(71), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Urgent priority", status: .toDo, placement: .anytime, priority: .urgent))

    let query = try AssistantApprovedQuery(originalQuery: "")
    let authorization = try AssistantTaskSearchAuthorization(scope: .all, query: query, maximumResults: 10)
    let result = try store.searchTasks(authorization: authorization, candidateScope: .all)

    XCTAssertEqual(result.sources.map(\.title), ["Urgent priority", "Low priority"])
  }

  func testSearchTasksRejectsACandidateScopeThatDoesNotMatchTheAuthorization() async throws {
    let store = try makeStore()
    let query = try AssistantApprovedQuery(originalQuery: "")
    let authorization = try AssistantTaskSearchAuthorization(scope: .today, query: query, maximumResults: 10)

    XCTAssertThrowsError(
      try store.searchTasks(authorization: authorization, candidateScope: .all)
    ) { error in
      XCTAssertEqual(error as? AssistantDataAccessError, .invalidTaskScope)
    }
  }

  func testSearchTasksRejectsACandidateQueryOutsideTheApprovedSet() async throws {
    let store = try makeStore()
    let query = try AssistantApprovedQuery(originalQuery: "launch")
    let authorization = try AssistantTaskSearchAuthorization(scope: .all, query: query, maximumResults: 10)

    XCTAssertThrowsError(
      try store.searchTasks(authorization: authorization, candidateScope: .all, candidateQuery: "unapproved")
    ) { error in
      XCTAssertEqual(error as? AssistantTurnRetrievalAuthorizationError, .invalidQuery)
    }
  }
}
