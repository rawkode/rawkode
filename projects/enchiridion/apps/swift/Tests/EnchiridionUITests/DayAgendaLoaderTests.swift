// DayAgendaLoaderTests.swift
// EnchiridionUITests
//
// Task #81. Exercises `DayAgendaLoader.loadEvents` (the day-page screen's
// agenda component) against a REAL temporary `LocalGraphStore` — real
// `writeProjection` writes, real bounded-SQL reads through
// `findCalendarEvents` underneath, nothing mocked. Required coverage per
// the task brief:
//   1. Correctly lists events for a given day (time/title/location) and
//      excludes events outside that day (before it starts, after it ends).
//   2. `personVisibility == .other` attendee exclusion, matching the
//      established pattern in
//      `EnchiridionStoreTests/AssistantReadToolsTests.swift`'s
//      `testFindCalendarEventsExcludesPersonVisibilityOtherAttendees`.

import EnchiridionCore
import EnchiridionSchema
import EnchiridionStore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionUI

final class DayAgendaLoaderTests: XCTestCase {
  private func makeStore() throws -> LocalGraphStore {
    try LocalGraphStore.openTemporary()
  }

  private func page(_ n: Int) -> PageID {
    PageID.free(UUID(uuidString: String(format: "00000000-0000-0000-0000-%012d", n))!)
  }

  private func eventProjection(
    title: String, start: Date, end: Date, location: String? = nil, isAllDay: Bool = false,
    graphEdges: [KnowledgeEdge] = []
  ) -> PageDocumentProjection {
    var properties: [SupertagPropertyKey: [SupertagValue]] = [
      .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.start): [.dateTime(start)],
      .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.end): [.dateTime(end)],
      .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.allDay): [.boolean(isAllDay)],
    ]
    if let location {
      properties[.init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.location)] = [
        .text(location)
      ]
    }
    return .init(
      title: title, plainText: title, deletedAt: nil, isPinned: false, references: [],
      graphEdges: graphEdges,
      objectMetadata: .init(supertagIDs: [CoreEventFieldIDs.supertagID], properties: properties))
  }

  // MARK: - Listing + day-boundary exclusion

  func testLoadEventsListsThatDaysEventsWithTimeTitleAndLocationAndExcludesEventsOutsideTheDay()
    async throws
  {
    let store = try makeStore()
    let day = DayKey(rawValue: "2026-08-06")
    let dayStart = try XCTUnwrap(DayNavigation.dayStart(for: day))

    // In range: starts and ends within the day.
    try await store.writeProjection(
      pageID: page(1), kind: .calendarMaterializedEvent(.init(uidDigest: "d1", occurrenceToken: "1")),
      createdAt: Date(), modifiedAt: Date(),
      projection: eventProjection(
        title: "Standup", start: dayStart.addingTimeInterval(9 * 3600),
        end: dayStart.addingTimeInterval(9.5 * 3600), location: "Zoom"))

    // Out of range: entirely before the day starts (ends before dayStart).
    try await store.writeProjection(
      pageID: page(2), kind: .calendarMaterializedEvent(.init(uidDigest: "d2", occurrenceToken: "1")),
      createdAt: Date(), modifiedAt: Date(),
      projection: eventProjection(
        title: "Yesterday's meeting", start: dayStart.addingTimeInterval(-3600),
        end: dayStart.addingTimeInterval(-1800)))

    // Out of range: starts on the following day.
    try await store.writeProjection(
      pageID: page(3), kind: .calendarMaterializedEvent(.init(uidDigest: "d3", occurrenceToken: "1")),
      createdAt: Date(), modifiedAt: Date(),
      projection: eventProjection(
        title: "Tomorrow's meeting", start: dayStart.addingTimeInterval(25 * 3600),
        end: dayStart.addingTimeInterval(26 * 3600)))

    let events = try DayAgendaLoader.loadEvents(for: day, store: store)

    XCTAssertEqual(events.map(\.source.title), ["Standup"])
    XCTAssertEqual(events.first?.location, "Zoom")
    XCTAssertEqual(events.first?.startDate, dayStart.addingTimeInterval(9 * 3600))
    XCTAssertFalse(events.first?.isAllDay ?? true)
  }

  func testLoadEventsIncludesAnEventThatStartedTheDayBeforeButIsStillOngoing() async throws {
    // Matches `findCalendarEvents(includeOngoing: true)`'s semantics,
    // reused by this loader — an overnight/multi-hour event that started
    // before this day's start but hasn't ended yet still belongs on this
    // day's agenda.
    let store = try makeStore()
    let day = DayKey(rawValue: "2026-08-06")
    let dayStart = try XCTUnwrap(DayNavigation.dayStart(for: day))

    try await store.writeProjection(
      pageID: page(1), kind: .calendarMaterializedEvent(.init(uidDigest: "overnight", occurrenceToken: "1")),
      createdAt: Date(), modifiedAt: Date(),
      projection: eventProjection(
        title: "Overnight on-call", start: dayStart.addingTimeInterval(-3600),
        end: dayStart.addingTimeInterval(3600)))

    let events = try DayAgendaLoader.loadEvents(for: day, store: store)

    XCTAssertEqual(events.map(\.source.title), ["Overnight on-call"])
  }

  func testLoadEventsReturnsEmptyForADayWithNoEvents() async throws {
    let store = try makeStore()
    let events = try DayAgendaLoader.loadEvents(for: DayKey(rawValue: "2026-08-06"), store: store)
    XCTAssertEqual(events, [])
  }

  // MARK: - personVisibility exclusion (matching AssistantReadToolsTests' established pattern)

  func testLoadEventsExcludesPersonVisibilityOtherAttendeesFromTheAgenda() async throws {
    let store = try makeStore()
    let day = DayKey(rawValue: "2026-08-06")
    let dayStart = try XCTUnwrap(DayNavigation.dayStart(for: day))
    let eventID = page(10)
    let visibleAttendeeID = page(11)
    let hiddenAttendeeID = page(12)

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
    try await store.writeProjection(
      pageID: eventID, kind: .calendarMaterializedEvent(.init(uidDigest: "withAttendees", occurrenceToken: "1")),
      createdAt: Date(), modifiedAt: Date(),
      projection: eventProjection(
        title: "Roadmap sync", start: dayStart.addingTimeInterval(3600),
        end: dayStart.addingTimeInterval(7200),
        graphEdges: [
          KnowledgeEdge(relationID: attendeesRelation, sourceNodeID: eventID, targetNodeID: visibleAttendeeID),
          KnowledgeEdge(relationID: attendeesRelation, sourceNodeID: eventID, targetNodeID: hiddenAttendeeID),
        ]))

    let events = try DayAgendaLoader.loadEvents(for: day, store: store)

    XCTAssertEqual(events.count, 1)
    let event = try XCTUnwrap(events.first)
    XCTAssertEqual(event.attendees, ["Visible Attendee"])
    XCTAssertFalse(
      event.attendees.contains("Hidden Attendee"),
      "a calendar-attendee-derived Person page (personVisibility \"other\") must never leak into the day agenda")
  }
}
