import Foundation
import XCTest
@testable import EnchiridionCore

final class AssistantCoreTests: XCTestCase {
  func testInjectedConversationalModelAnswersGreetingWithoutRetrievalRefusal() async throws {
    let fixture = try AssistantRepositoryFixture()
    let responder = ConversationalModelStub()
    let assistant = FoundationModelAssistant(
      repository: fixture.repository,
      modelResponder: responder
    )

    let greeting = await assistant.respond(to: "Hello")
    let generalChat = await assistant.respond(to: "Help me think of a name for my garden shed")

    XCTAssertEqual(greeting.status, .answered)
    XCTAssertEqual(greeting.answer, "Hello! How can I help?")
    XCTAssertEqual(generalChat.status, .answered)
    XCTAssertFalse(generalChat.answer.localizedCaseInsensitiveContains("couldn't find"))
    XCTAssertTrue(greeting.sources.isEmpty)
    XCTAssertTrue(generalChat.sources.isEmpty)
  }

  func testCalendarSearchReturnsExactNextEventAndClampsOutput() async throws {
    let fixture = try AssistantRepositoryFixture()
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let later = event(id: "later", title: "Later review", start: now.addingTimeInterval(7_200))
    let next = event(id: "next", title: "Design review", start: now.addingTimeInterval(1_800))
    let ongoing = event(id: "ongoing", title: "Already underway", start: now.addingTimeInterval(-1_800))
    try await fixture.repository.replaceCalendarProjection([later, ongoing, next], provider: "eventkit", refreshedAt: now)

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
      selectedFactIDs: [try XCTUnwrap(results.evidence.first?.id)],
      availableFacts: results.evidence,
      availableSources: results.sources,
      ambiguousTitles: results.ambiguousTitles
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
    let fact = AssistantEvidenceFact(
      id: "page:decision#excerpt",
      sourceID: source.id,
      kind: .pageExcerpt,
      spokenText: "Launch decision contains conflicting dates."
    )

    let response = try AssistantGroundingPolicy.groundedResponse(
      selectedFactIDs: [fact.id],
      availableFacts: [fact],
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
      selectedFactIDs: results.evidence.map(\.id),
      availableFacts: results.evidence,
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

  func testMeetingBriefBindsExactOccurrenceSeriesAttendeeAndReferencedPeople() async throws {
    let fixture = try AssistantRepositoryFixture()
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let start = now.addingTimeInterval(3_600)
    let series = CalendarSeriesIdentity(
      provider: "eventkit",
      externalIdentifier: "brief-series",
      crossProviderIdentifier: "brief-series"
    )
    var meeting = CalendarEventSnapshot(
      identity: CalendarEventIdentity(
        externalIdentifier: "brief-instance",
        occurrenceStart: start,
        series: series
      ),
      title: "Planning with Alice",
      startDate: start,
      endDate: start.addingTimeInterval(3_600),
      isAllDay: false,
      location: "Studio",
      notes: "Calendar notes must not be bulk-prompted.",
      url: nil,
      calendarTitle: "Work"
    )
    meeting.attendees = [
      CalendarAttendeeIdentity(
        email: "alice@example.com",
        displayName: "Alice",
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      )
    ]
    try await fixture.repository.replaceCalendarProjection([meeting], provider: "eventkit", refreshedAt: now)
    let pages = try await fixture.repository.calendarEventPages(for: meeting, now: now)
    try await fixture.setBody("Occurrence decision: demo the prototype.", on: pages.occurrence)
    try await fixture.setBody("Series context: focus on launch readiness.", on: pages.series!)

    let gavin = try await fixture.repository.createTaggedPage(
      title: "Gavin",
      supertagID: BuiltInSupertags.person,
      now: now
    )
    try await fixture.repository.addSupertag(BuiltInSupertags.project, to: pages.occurrence.id, now: now)
    try await fixture.repository.setProperty(
      pageID: pages.occurrence.id,
      key: SupertagPropertyKey(
        supertagID: BuiltInSupertags.project,
        fieldID: .init(rawValue: "owner")
      ),
      values: [.page(gavin.id)],
      now: now
    )

    let found = try await fixture.repository.findCalendarEvents(
      matching: "Planning",
      from: now,
      through: now.addingTimeInterval(24 * 60 * 60),
      now: now
    )
    let brief = try await fixture.repository.meetingBrief(
      forEventSourceID: try XCTUnwrap(found.events.first?.source.id),
      now: now
    )

    XCTAssertEqual(brief.occurrenceNote?.excerpt, "Occurrence decision: demo the prototype.")
    XCTAssertEqual(brief.seriesNote?.excerpt, "Series context: focus on launch readiness.")
    XCTAssertEqual(Set(brief.people.map(\.title)), ["Alice", "Gavin"])
    XCTAssertTrue(brief.evidence.contains { $0.spokenText.contains("demo the prototype") })
    XCTAssertTrue(brief.evidence.contains { $0.spokenText.contains("launch readiness") })
    XCTAssertFalse(brief.evidence.contains { $0.spokenText.contains("bulk-prompted") })
  }

  func testInventedFactIsRejectedEvenWhenItUsesAValidSource() {
    let source = AssistantSource(id: "page:known", kind: .page, title: "Known")
    let fact = AssistantEvidenceFact(
      id: "page:known#title",
      sourceID: source.id,
      kind: .pageTitle,
      spokenText: "A local page is titled Known."
    )

    XCTAssertThrowsError(
      try AssistantGroundingPolicy.groundedResponse(
        selectedFactIDs: ["page:known#invented-date"],
        availableFacts: [fact],
        availableSources: [source]
      )
    ) { error in
      XCTAssertEqual(error as? AssistantGroundingError, .unknownFact("page:known#invented-date"))
    }
  }

  func testGroundedSpeechRejectsTooManySelectedFacts() {
    let source = AssistantSource(id: "page:bounded", kind: .page, title: "Bounded")
    let facts = (0..<6).map {
      AssistantEvidenceFact(
        id: "page:bounded#\($0)",
        sourceID: source.id,
        kind: .pageExcerpt,
        spokenText: "Fact \($0)."
      )
    }

    XCTAssertThrowsError(
      try AssistantGroundingPolicy.groundedResponse(
        selectedFactIDs: facts.map(\.id),
        availableFacts: facts,
        availableSources: [source]
      )
    ) { error in
      XCTAssertEqual(error as? AssistantGroundingError, .tooManyFacts)
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

private actor ConversationalModelStub: AssistantConversationAnswering {
  func respond(to request: AssistantConversationRequest) -> GroundedAssistantResponse {
    if request.utterance.localizedCaseInsensitiveCompare("Hello") == .orderedSame {
      return GroundedAssistantResponse(answer: "Hello! How can I help?", status: .answered)
    }
    return GroundedAssistantResponse(
      answer: "How about The Green Room?",
      status: .answered
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
