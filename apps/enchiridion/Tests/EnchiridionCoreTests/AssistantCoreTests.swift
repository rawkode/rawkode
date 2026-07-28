import Foundation
import XCTest
@testable import EnchiridionCore

final class AssistantCoreTests: XCTestCase {
  func testCalendarSearchReturnsExactNextEventAndClampsOutput() async throws {
    let fixture = try AssistantRepositoryFixture()
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let later = event(id: "later", title: "Later review", start: now.addingTimeInterval(7_200))
    let next = event(id: "next", title: "Design review", start: now.addingTimeInterval(1_800))
    try await fixture.repository.replaceCalendarProjection([later, next], provider: "eventkit", refreshedAt: now)

    let result = try await fixture.repository.findCalendarEvents(
      from: now,
      through: now.addingTimeInterval(24 * 60 * 60),
      limit: 100,
      now: now
    )

    XCTAssertEqual(result.events.map(\.source.title), ["Design review", "Later review"])
    XCTAssertEqual(result.events.first?.startDate, next.startDate)
    XCTAssertFalse(result.containsStaleProjection)
    XCTAssertTrue(result.events.allSatisfy { $0.source.id.hasPrefix("calendar:") })
  }

  func testCalendarSearchFindsAttendeeWithoutExposingFullEventNotes() async throws {
    let fixture = try AssistantRepositoryFixture()
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    var meeting = event(id: "medical", title: "Consultation", start: now.addingTimeInterval(1_800))
    meeting.notes = String(repeating: "private detail ", count: 100)
    meeting.attendees = [
      CalendarAttendeeIdentity(
        email: "rossbottom@example.com",
        displayName: "Dr. Rossbottom",
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      )
    ]
    try await fixture.repository.replaceCalendarProjection([meeting], provider: "eventkit", refreshedAt: now)

    let results = try await fixture.repository.findCalendarEvents(
      matching: "Rossbottom",
      from: now,
      through: now.addingTimeInterval(24 * 60 * 60),
      now: now
    )

    XCTAssertEqual(results.events.first?.source.title, "Consultation")
    XCTAssertEqual(results.events.first?.attendees, ["Dr. Rossbottom"])
    XCTAssertNil(results.events.first?.source.excerpt)
  }

  func testCalendarSearchRejectsUnboundedDateRanges() async throws {
    let fixture = try AssistantRepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_900_000_000)

    await XCTAssertThrowsErrorAsync(
      try await fixture.repository.findCalendarEvents(
        from: start,
        through: start.addingTimeInterval(32 * 24 * 60 * 60)
      )
    ) { error in
      XCTAssertEqual(error as? AssistantDataAccessError, .dateRangeTooLarge)
    }
  }

  func testNoteSearchReturnsOnlyBoundedLocalExcerpts() async throws {
    let fixture = try AssistantRepositoryFixture()
    let page = try await fixture.repository.createFreePage(title: "Gavin follow-up")
    try await fixture.setBody(
      String(repeating: "context ", count: 80) + "Decision: ship the local-only assistant. " + String(repeating: "tail ", count: 80),
      on: page
    )

    let result = try await fixture.repository.searchNotes(matching: "local-only", limit: 50)

    XCTAssertEqual(result.sources.count, 1)
    XCTAssertEqual(result.sources.first?.title, "Gavin follow-up")
    XCTAssertTrue(result.sources.first?.excerpt?.contains("local-only") == true)
    XCTAssertLessThanOrEqual(result.sources.first?.excerpt?.count ?? .max, 402)
    XCTAssertTrue(result.sources.first?.id.hasPrefix("page:") == true)
  }

  func testEmptyResultsProduceSafeNonFactualResponse() async throws {
    let fixture = try AssistantRepositoryFixture()
    let results = try await fixture.repository.searchNotes(matching: "missing topic")
    let response = AssistantGroundingPolicy.noResults()

    XCTAssertTrue(results.sources.isEmpty)
    XCTAssertEqual(response.status, .noResults)
    XCTAssertTrue(response.sources.isEmpty)
  }

  func testAmbiguousPeopleAreSurfaced() async throws {
    let fixture = try AssistantRepositoryFixture()
    _ = try await fixture.repository.createTaggedPage(title: "Gavin", supertagID: BuiltInSupertags.person)
    _ = try await fixture.repository.createTaggedPage(title: "Gavin", supertagID: BuiltInSupertags.person)

    let results = try await fixture.repository.searchNotes(matching: "Gavin")
    let response = try AssistantGroundingPolicy.groundedResponse(
      answer: "I found two local pages named Gavin.",
      citedSourceIDs: results.sources.map(\.id),
      availableSources: results.sources
    )

    XCTAssertEqual(results.ambiguousTitles, ["Gavin"])
    XCTAssertEqual(response.status, .ambiguous)
  }

  func testConflictingNotesCannotBePresentedAsSettled() throws {
    let source = AssistantSource(
      id: "page:decision",
      kind: .page,
      title: "Launch decision",
      excerpt: "Ship Tuesday; another value says Thursday.",
      hasConflicts: true
    )

    let response = try AssistantGroundingPolicy.groundedResponse(
      answer: "Your local note contains conflicting launch dates.",
      citedSourceIDs: [source.id],
      availableSources: [source]
    )

    XCTAssertEqual(response.status, .conflicting)
  }

  func testStaleCalendarProjectionIsExplicit() async throws {
    let fixture = try AssistantRepositoryFixture()
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let meeting = event(id: "stale", title: "Old projection", start: now.addingTimeInterval(3_600))
    let refreshedAt = now.addingTimeInterval(-LibraryRepository.assistantProjectionFreshnessInterval - 1)
    try await fixture.repository.replaceCalendarProjection(
      [meeting], provider: "eventkit", refreshedAt: refreshedAt)

    let results = try await fixture.repository.findCalendarEvents(
      from: now,
      through: now.addingTimeInterval(24 * 60 * 60),
      now: now
    )
    let response = try AssistantGroundingPolicy.groundedResponse(
      answer: "The projection lists Old projection, but the projection is stale.",
      citedSourceIDs: results.sources.map(\.id),
      availableSources: results.sources
    )

    XCTAssertTrue(results.containsStaleProjection)
    XCTAssertEqual(response.status, .stale)
  }

  func testRecurringEventRetainsOccurrenceTimeAndRecurringSignal() async throws {
    let fixture = try AssistantRepositoryFixture()
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let start = now.addingTimeInterval(3_600)
    let series = CalendarSeriesIdentity(
      provider: "eventkit",
      externalIdentifier: "weekly",
      crossProviderIdentifier: "weekly"
    )
    let recurring = CalendarEventSnapshot(
      identity: CalendarEventIdentity(
        externalIdentifier: "weekly",
        occurrenceStart: start,
        series: series
      ),
      title: "Weekly session",
      startDate: start,
      endDate: start.addingTimeInterval(3_600),
      isAllDay: false,
      location: nil,
      notes: nil,
      url: nil,
      calendarTitle: "Work"
    )
    try await fixture.repository.replaceCalendarProjection([recurring], provider: "eventkit", refreshedAt: now)

    let results = try await fixture.repository.findCalendarEvents(
      matching: "Weekly",
      from: now,
      through: now.addingTimeInterval(24 * 60 * 60),
      now: now
    )

    XCTAssertEqual(results.events.first?.startDate, start)
    XCTAssertEqual(results.events.first?.isRecurring, true)
  }

  func testHallucinatedSourceIDIsRejected() {
    let source = AssistantSource(id: "page:known", kind: .page, title: "Known")

    XCTAssertThrowsError(
      try AssistantGroundingPolicy.groundedResponse(
        answer: "Invented claim",
        citedSourceIDs: ["page:invented"],
        availableSources: [source]
      )
    ) { error in
      XCTAssertEqual(error as? AssistantGroundingError, .unknownSource("page:invented"))
    }
  }

  private func event(id: String, title: String, start: Date) -> CalendarEventSnapshot {
    CalendarEventSnapshot(
      identity: CalendarEventIdentity(externalIdentifier: id, occurrenceStart: start),
      title: title,
      startDate: start,
      endDate: start.addingTimeInterval(3_600),
      isAllDay: false,
      location: nil,
      notes: nil,
      url: nil,
      calendarTitle: "Work"
    )
  }
}

private final class AssistantRepositoryFixture {
  let repository: LibraryRepository

  init() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-assistant-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    repository = try LibraryRepository(path: directory.appendingPathComponent("library.sqlite").path)
  }

  func setBody(_ body: String, on page: PageSnapshot) async throws {
    let updated = try PageDocument.replaceBody(with: body, in: page.document)
    let changes = try PageDocument.encodedChanges(from: updated.document, since: page.heads)
    _ = try await repository.persistEditorCommit(
      EditorCommit(
        pageID: page.id,
        loadGeneration: 1,
        journalID: UUID().uuidString,
        encodedChanges: changes,
        advertisedHeads: updated.heads
      )
    )
  }
}

private func XCTAssertThrowsErrorAsync<T>(
  _ expression: @autoclosure () async throws -> T,
  _ errorHandler: (Error) -> Void
) async {
  do {
    _ = try await expression()
    XCTFail("Expected expression to throw")
  } catch {
    errorHandler(error)
  }
}
