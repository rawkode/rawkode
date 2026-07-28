import Foundation
import XCTest
@testable import EnchiridionCore

final class LibraryRepositoryTests: XCTestCase {
  func testCloudSyncRequiresTheConfiguredContainerEntitlement() {
    XCTAssertFalse(CloudSyncCoordinator.hasRequiredEntitlement(in: nil))
    XCTAssertFalse(CloudSyncCoordinator.hasRequiredEntitlement(in: []))
    XCTAssertFalse(
      CloudSyncCoordinator.hasRequiredEntitlement(in: ["iCloud.dev.rawkode.somewhere-else"])
    )
    XCTAssertTrue(
      CloudSyncCoordinator.hasRequiredEntitlement(
        in: [CloudSyncCoordinator.containerIdentifier]
      )
    )
  }

  func testCloudSyncRequiresADeclaredEntitlementsFileOnIOS() {
    XCTAssertFalse(CloudSyncCoordinator.hasDeclaredEntitlements(nil))
    XCTAssertFalse(CloudSyncCoordinator.hasDeclaredEntitlements(""))
    XCTAssertFalse(CloudSyncCoordinator.hasDeclaredEntitlements("  \n"))
    XCTAssertTrue(
      CloudSyncCoordinator.hasDeclaredEntitlements(
        "Configuration/EnchiridionMobile.entitlements"
      )
    )
  }

  func testDailyPageIdentityIsDeterministicAndDurable() async throws {
    let fixture = try RepositoryFixture()
    let day = DayKey(rawValue: "2026-07-28")
    let first = try await fixture.repository.dailyPage(for: day)
    let second = try await fixture.repository.dailyPage(for: day)

    XCTAssertEqual(first.id, .daily(day))
    XCTAssertEqual(second.id, first.id)

    let reopened = try LibraryRepository(path: fixture.path)
    let persisted = try await reopened.page(id: first.id)
    XCTAssertEqual(persisted?.title, first.title)
    XCTAssertEqual(persisted?.heads, first.heads)
  }

  func testEditorCommitIsAtomicAndIdempotent() async throws {
    let fixture = try RepositoryFixture()
    let page = try await fixture.repository.createFreePage(title: "Atomic")
    let pinned = try PageDocument.setPinned(true, in: page.document)
    let changes = try PageDocument.encodedChanges(from: pinned.document, since: page.heads)
    let commit = EditorCommit(
      pageID: page.id,
      loadGeneration: 1,
      journalID: "journal-1",
      encodedChanges: changes,
      advertisedHeads: pinned.heads
    )

    let first = try await fixture.repository.persistEditorCommit(commit)
    let duplicate = try await fixture.repository.persistEditorCommit(commit)
    let persisted = try await fixture.repository.page(id: page.id)

    XCTAssertFalse(first.duplicate)
    XCTAssertTrue(duplicate.duplicate)
    XCTAssertEqual(first.dirtyGeneration, duplicate.dirtyGeneration)
    XCTAssertEqual(persisted?.isPinned, true)
    XCTAssertEqual(persisted?.heads, pinned.heads)
  }

  func testConcurrentAutomergeChangesMergeWithoutDroppingEitherIntent() throws {
    let id = PageID.free()
    let original = try PageDocument.create(id: id, kind: .free, title: "Merge", createdAt: Date())
    let pinned = try PageDocument.setPinned(true, in: original.document)
    let deletedAt = Date(timeIntervalSince1970: 2_000)
    let deleted = try PageDocument.setDeleted(deletedAt, in: original.document)

    let merged = try PageDocument.merge(local: pinned.document, remote: deleted.document, pageID: id)

    XCTAssertTrue(merged.projection.isPinned)
    XCTAssertEqual(merged.projection.deletedAt, deletedAt)
  }

  func testSupertagAndTypedPropertiesLiveInThePageDocument() throws {
    let id = PageID.free()
    let created = try PageDocument.create(id: id, kind: .free, title: "Alice", createdAt: Date())
    let tagged = try PageDocument.addSupertag(BuiltInSupertags.person, in: created.document)
    let key = SupertagPropertyKey(
      supertagID: BuiltInSupertags.person,
      fieldID: .init(rawValue: "email")
    )
    let valued = try PageDocument.setProperty(
      key: key,
      values: [.email("alice@example.com")],
      in: tagged.document
    )

    XCTAssertEqual(valued.projection.objectMetadata.supertagIDs, [BuiltInSupertags.person])
    XCTAssertEqual(valued.projection.objectMetadata.properties[key], [.email("alice@example.com")])
    XCTAssertTrue(valued.projection.objectMetadata.conflicts.isEmpty)
  }

  func testTaggedPageIsProjectedIntoCollection() async throws {
    let fixture = try RepositoryFixture()
    let page = try await fixture.repository.createTaggedPage(
      title: "Launch Enchiridion",
      supertagID: BuiltInSupertags.project
    )
    let projects = try await fixture.repository.pages(with: BuiltInSupertags.project)

    XCTAssertEqual(projects.map(\.id), [page.id])
    XCTAssertTrue(projects[0].hasSupertag(BuiltInSupertags.project))
  }

  func testBuiltInLiveViewsAreSeeded() async throws {
    let fixture = try RepositoryFixture()
    let views = try await fixture.repository.savedViews()

    XCTAssertEqual(Set(views.map(\.id)), Set(BuiltInLiveQueries.all.map(\.id)))
    XCTAssertEqual(views.first(where: { $0.id.rawValue == "view_people" })?.viewKind, .table)
    XCTAssertEqual(views.first(where: { $0.id.rawValue == "view_work_calendar" })?.source, .workCalendar)
    XCTAssertEqual(
      views.first(where: { $0.id.rawValue == "view_work_calendar" })?.sorts,
      [.init(systemField: "start")]
    )
  }

  func testCustomSupertagSchemaPersists() async throws {
    let fixture = try RepositoryFixture()
    var definition = SupertagDefinition.draft(name: "Book")
    definition.symbol = "book"
    definition.fields = [
      .init(id: .init(rawValue: "author"), name: "Author", type: .text)
    ]

    try await fixture.repository.saveSupertag(definition)
    let schemas = try await fixture.repository.supertags()

    XCTAssertEqual(schemas.first(where: { $0.id == definition.id }), definition)
  }

  func testDomainQueryRoundTripsAndRejectsRawSQL() throws {
    let original = BuiltInLiveQueries.all[2]
    let parsed = try DomainQueryCodec.parse(original.domainSQL, id: original.id, name: original.name)

    XCTAssertEqual(parsed.source, original.source)
    XCTAssertEqual(parsed.viewKind, original.viewKind)
    XCTAssertEqual(parsed.limit, original.limit)
    XCTAssertThrowsError(try DomainQueryCodec.parse("SELECT * FROM pages JOIN page_supertags"))
    XCTAssertThrowsError(try DomainQueryCodec.parse("DELETE FROM pages"))
    XCTAssertThrowsError(try DomainQueryCodec.parse("SELECT * FROM pages LIMIT 5001"))
  }

  func testDomainQueryRoundTripsFiltersDisplayGroupingDatesAndMultipleSorts() throws {
    let date = Date(timeIntervalSince1970: 1_817_000_000)
    let original = LiveQueryDefinition(
      id: .init(rawValue: "view_complete"),
      name: "Active projects",
      source: .supertag(BuiltInSupertags.project),
      filters: [
        .init(fieldID: .init(rawValue: "status"), operation: .equals, value: .select("active")),
        .init(systemField: "title", operation: .contains, value: .text("launch")),
        .init(fieldID: .init(rawValue: "due-date"), operation: .before, value: .date(date)),
      ],
      sorts: [
        .init(fieldID: .init(rawValue: "due-date"), ascending: false),
        .init(systemField: "title"),
      ],
      viewKind: .board,
      visibleFieldIDs: [.init(rawValue: "status"), .init(rawValue: "owner")],
      groupFieldID: .init(rawValue: "status"),
      startFieldID: .init(rawValue: "start-date"),
      endFieldID: .init(rawValue: "due-date"),
      limit: 275
    )

    let parsed = try DomainQueryCodec.parse(original.domainSQL, id: original.id, name: original.name)

    XCTAssertEqual(parsed.id, original.id)
    XCTAssertEqual(parsed.name, original.name)
    XCTAssertEqual(parsed.source, original.source)
    XCTAssertEqual(parsed.filters.map { [$0.fieldID?.rawValue, $0.systemField, $0.operation.rawValue, $0.value?.id] },
      original.filters.map { [$0.fieldID?.rawValue, $0.systemField, $0.operation.rawValue, $0.value?.id] })
    XCTAssertEqual(parsed.sorts, original.sorts)
    XCTAssertEqual(parsed.viewKind, original.viewKind)
    XCTAssertEqual(parsed.visibleFieldIDs, original.visibleFieldIDs)
    XCTAssertEqual(parsed.groupFieldID, original.groupFieldID)
    XCTAssertEqual(parsed.startFieldID, original.startFieldID)
    XCTAssertEqual(parsed.endFieldID, original.endFieldID)
    XCTAssertEqual(parsed.limit, original.limit)
  }

  func testLiveQueryExecutesTypedFiltersAndAllSortKeysBeforeLimit() async throws {
    let fixture = try RepositoryFixture()
    let first = try await fixture.repository.createTaggedPage(
      title: "Launch Alpha", supertagID: BuiltInSupertags.project)
    let second = try await fixture.repository.createTaggedPage(
      title: "Launch Beta", supertagID: BuiltInSupertags.project)
    let ignored = try await fixture.repository.createTaggedPage(
      title: "Archive", supertagID: BuiltInSupertags.project)
    let status = SupertagPropertyKey(
      supertagID: BuiltInSupertags.project, fieldID: .init(rawValue: "status"))
    let due = SupertagPropertyKey(
      supertagID: BuiltInSupertags.project, fieldID: .init(rawValue: "due-date"))
    for page in [first, second, ignored] {
      try await fixture.repository.setProperty(pageID: page.id, key: status, values: [.select("active")])
    }
    try await fixture.repository.setProperty(
      pageID: first.id, key: due, values: [.date(Date(timeIntervalSince1970: 2_000))])
    try await fixture.repository.setProperty(
      pageID: second.id, key: due, values: [.date(Date(timeIntervalSince1970: 3_000))])
    try await fixture.repository.setProperty(
      pageID: ignored.id, key: due, values: [.date(Date(timeIntervalSince1970: 4_000))])
    let definition = LiveQueryDefinition(
      name: "Next launch",
      source: .supertag(BuiltInSupertags.project),
      filters: [
        .init(fieldID: status.fieldID, operation: .equals, value: .select("active")),
        .init(systemField: "title", operation: .contains, value: .text("launch")),
      ],
      sorts: [
        .init(fieldID: due.fieldID, ascending: false),
        .init(systemField: "title"),
      ],
      limit: 1
    )

    let items = try await fixture.repository.run(definition)

    XCTAssertEqual(items.map(\.id), ["page:\(second.id.rawValue)"])
  }

  func testLiveQueryExecutesEmptyAndTemporalOperators() async throws {
    let fixture = try RepositoryFixture()
    let early = try await fixture.repository.createTaggedPage(
      title: "Early", supertagID: BuiltInSupertags.project)
    let late = try await fixture.repository.createTaggedPage(
      title: "Late", supertagID: BuiltInSupertags.project)
    let status = SupertagPropertyKey(
      supertagID: BuiltInSupertags.project, fieldID: .init(rawValue: "status"))
    let due = SupertagPropertyKey(
      supertagID: BuiltInSupertags.project, fieldID: .init(rawValue: "due-date"))
    try await fixture.repository.setProperty(
      pageID: early.id, key: status, values: [.select("active")])
    try await fixture.repository.setProperty(
      pageID: early.id, key: due, values: [.date(Date(timeIntervalSince1970: 2_000))])
    try await fixture.repository.setProperty(
      pageID: late.id, key: due, values: [.date(Date(timeIntervalSince1970: 4_000))])

    func IDs(for filter: LiveQueryFilter) async throws -> Set<String> {
      let definition = LiveQueryDefinition(
        name: "Operator", source: .supertag(BuiltInSupertags.project), filters: [filter])
      return Set(try await fixture.repository.run(definition).map(\.id))
    }

    let empty = try await IDs(for: .init(fieldID: status.fieldID, operation: .isEmpty))
    let notEmpty = try await IDs(for: .init(fieldID: status.fieldID, operation: .isNotEmpty))
    let before = try await IDs(for: .init(
      fieldID: due.fieldID, operation: .before, value: .date(Date(timeIntervalSince1970: 3_000))))
    let after = try await IDs(for: .init(
      fieldID: due.fieldID, operation: .after, value: .date(Date(timeIntervalSince1970: 3_000))))

    XCTAssertEqual(empty, ["page:\(late.id.rawValue)"])
    XCTAssertEqual(notEmpty, ["page:\(early.id.rawValue)"])
    XCTAssertEqual(before, ["page:\(early.id.rawValue)"])
    XCTAssertEqual(after, ["page:\(late.id.rawValue)"])
  }

  func testSavedViewLifecycleCreatesCloudTombstone() async throws {
    let fixture = try RepositoryFixture()
    let view = LiveQueryDefinition(name: "My pages", source: .pages)
    try await fixture.repository.saveView(view, now: Date(timeIntervalSince1970: 100))

    let dirty = try await fixture.repository.dirtyViews().first { $0.id == view.id }
    XCTAssertEqual(dirty?.definition, view)
    XCTAssertEqual(dirty?.isDeleted, false)
    try await fixture.repository.markViewCloudSaved(
      id: view.id,
      sentGeneration: try XCTUnwrap(dirty?.dirtyGeneration),
      systemFields: Data([1, 2, 3])
    )
    let cleanViews = try await fixture.repository.dirtyViews()
    XCTAssertFalse(cleanViews.contains { $0.id == view.id })

    try await fixture.repository.deleteView(view.id, now: Date(timeIntervalSince1970: 200))

    let visibleViews = try await fixture.repository.savedViews()
    XCTAssertFalse(visibleViews.contains { $0.id == view.id })
    let tombstone = try await fixture.repository.dirtyViews().first { $0.id == view.id }
    XCTAssertEqual(tombstone?.isDeleted, true)
    XCTAssertEqual(tombstone?.dirtyGeneration, 2)
  }

  func testSavedViewCloudMergeKeepsNewerLocalAndAcceptsNewerRemote() async throws {
    let fixture = try RepositoryFixture()
    let local = LiveQueryDefinition(
      id: .init(rawValue: "view_merge"), name: "Local", source: .pages)
    let remote = LiveQueryDefinition(
      id: local.id, name: "Remote", source: .calendarEvents, viewKind: .calendar)
    try await fixture.repository.saveView(local, now: Date(timeIntervalSince1970: 200))

    let needsUpload = try await fixture.repository.mergeCloudView(
      id: local.id,
      definition: remote,
      isDeleted: false,
      sortOrder: 8,
      modifiedAt: Date(timeIntervalSince1970: 100),
      dirtyGeneration: 5,
      systemFields: Data([4])
    )
    XCTAssertTrue(needsUpload)
    let keptLocal = try await fixture.repository.savedViewCloudRecord(id: local.id)
    XCTAssertEqual(keptLocal?.definition.name, "Local")
    try await fixture.repository.markViewCloudSaved(
      id: local.id,
      sentGeneration: try XCTUnwrap(keptLocal?.dirtyGeneration),
      systemFields: Data([4])
    )

    let accepted = try await fixture.repository.mergeCloudView(
      id: local.id,
      definition: remote,
      isDeleted: false,
      sortOrder: 8,
      modifiedAt: Date(timeIntervalSince1970: 300),
      dirtyGeneration: 6,
      systemFields: Data([5])
    )
    XCTAssertFalse(accepted)
    let acceptedRemote = try await fixture.repository.savedViewCloudRecord(id: local.id)
    XCTAssertEqual(acceptedRemote?.definition, remote)
  }

  func testWorkCalendarCombinesReadOnlyEventsWithDatedSupertagPages() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    let event = calendarEvent(
      provider: "eventkit", id: "calendar-item", start: start,
      end: start.addingTimeInterval(3_600))
    try await fixture.repository.replaceCalendarProjection([event], provider: "eventkit")
    let task = try await fixture.repository.createTaggedPage(
      title: "Prepare brief", supertagID: BuiltInSupertags.task)
    try await fixture.repository.setProperty(
      pageID: task.id,
      key: .init(supertagID: BuiltInSupertags.task, fieldID: .init(rawValue: "due")),
      values: [.dateTime(start.addingTimeInterval(7_200))]
    )

    let definition = try XCTUnwrap(BuiltInLiveQueries.all.first { $0.source == .workCalendar })
    let items = try await fixture.repository.run(definition)

    XCTAssertTrue(items.contains { if case .event(let value) = $0 { value.id == event.id } else { false } })
    XCTAssertTrue(items.contains { if case .page(let value) = $0 { value.id == task.id } else { false } })
  }

  func testCalendarAttendeesCreateDeterministicPeople() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(provider: "google", id: "planning", start: start, end: start.addingTimeInterval(3600))
    event.attendees = [
      CalendarAttendeeIdentity(
        email: "Alice@Example.com",
        displayName: "Alice Smith",
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      ),
      CalendarAttendeeIdentity(
        email: "me@example.com",
        displayName: "Me",
        role: "organizer",
        responseStatus: "accepted",
        isCurrentUser: true
      ),
    ]

    try await fixture.repository.replaceCalendarProjection([event], provider: "google")
    try await fixture.repository.replaceCalendarProjection([event], provider: "google")
    let people = try await fixture.repository.pages(with: BuiltInSupertags.person)

    XCTAssertEqual(people.count, 1)
    XCTAssertEqual(people[0].id, .person(email: "alice@example.com"))
    XCTAssertEqual(people[0].displayTitle, "Alice Smith")
  }

  func testCalendarProvidersRefreshIndependently() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_000)
    let end = start.addingTimeInterval(3_600)
    let eventKit = calendarEvent(provider: "eventkit", id: "local", start: start, end: end)
    let google = calendarEvent(provider: "google", id: "remote", start: start, end: end)

    try await fixture.repository.replaceCalendarProjection([eventKit], provider: "eventkit")
    try await fixture.repository.replaceCalendarProjection([google], provider: "google")
    try await fixture.repository.replaceCalendarProjection([], provider: "eventkit")
    let remaining = try await fixture.repository.calendarEvents(
      from: start.addingTimeInterval(-1), through: end.addingTimeInterval(1))

    XCTAssertEqual(remaining.map(\.identity.provider), ["google"])
  }

  func testCalendarSuggestionUsesOccurrenceDateInsteadOfInternalID() {
    let occurrence = Date(timeIntervalSince1970: 1_817_000_000)
    let identity = CalendarEventIdentity(
      externalIdentifier: "opaque-event-instance-id",
      occurrenceStart: occurrence
    )
    let suggestion = PageSuggestion(
      id: .calendarEvent(identity),
      title: "Personal training",
      kind: .calendarEvent(identity)
    )

    XCTAssertNotNil(suggestion.displaySubtitle)
    XCTAssertFalse(suggestion.displaySubtitle?.contains("event_") ?? true)
    XCTAssertFalse(suggestion.displaySubtitle?.contains("opaque-event-instance-id") ?? true)
  }

  func testRecurringOccurrencesShareOneSeriesPageAndKeepSeparateNotes() async throws {
    let fixture = try RepositoryFixture()
    let firstStart = Date(timeIntervalSince1970: 1_817_000_000)
    let secondStart = firstStart.addingTimeInterval(7 * 24 * 60 * 60)
    let series = CalendarSeriesIdentity(
      provider: "eventkit",
      externalIdentifier: "training-series",
      crossProviderIdentifier: "training-series"
    )
    let first = recurringEvent(
      provider: "eventkit", id: "training-series", start: firstStart, series: series)
    let second = recurringEvent(
      provider: "eventkit", id: "training-series", start: secondStart, series: series)

    try await fixture.repository.replaceCalendarProjection([first, second], provider: "eventkit")
    let firstPages = try await fixture.repository.calendarEventPages(for: first)
    let secondPages = try await fixture.repository.calendarEventPages(for: second)
    let contexts = try await fixture.repository.calendarPageContexts()

    XCTAssertNotEqual(firstPages.occurrence.id, secondPages.occurrence.id)
    XCTAssertEqual(firstPages.series?.id, secondPages.series?.id)
    XCTAssertEqual(contexts[firstPages.occurrence.id]?.seriesPageID, firstPages.series?.id)
    XCTAssertEqual(contexts[firstPages.series!.id]?.occurrences.count, 2)
  }

  func testEventKitAndGoogleLikelyDuplicatesShareOccurrenceAndSeriesPages() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    let eventKitSeries = CalendarSeriesIdentity(
      provider: "eventkit",
      externalIdentifier: "eventkit-series",
      crossProviderIdentifier: "eventkit-series"
    )
    let googleSeries = CalendarSeriesIdentity(
      provider: "google",
      externalIdentifier: "google-master",
      disambiguator: "primary",
      crossProviderIdentifier: "shared-uid@google.com"
    )
    let eventKit = recurringEvent(
      provider: "eventkit", id: "eventkit-instance", start: start, series: eventKitSeries)
    let google = recurringEvent(
      provider: "google", id: "google-instance", start: start, series: googleSeries)

    try await fixture.repository.replaceCalendarProjection([eventKit], provider: "eventkit")
    try await fixture.repository.replaceCalendarProjection([google], provider: "google")
    let projected = try await fixture.repository.calendarEvents(
      from: start.addingTimeInterval(-1),
      through: start.addingTimeInterval(3_601)
    )
    let opened = try await projected.asyncMap { try await fixture.repository.calendarEventPages(for: $0) }

    XCTAssertEqual(Set(projected.compactMap { $0.identity.series?.canonicalKey }).count, 1)
    XCTAssertEqual(Set(opened.map(\.occurrence.id)).count, 1)
    XCTAssertEqual(Set(opened.compactMap { $0.series?.id }).count, 1)
  }

  func testLegacyOccurrencePageIsReusedWhenSeriesMetadataArrives() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    let legacy = calendarEvent(provider: "eventkit", id: "legacy", start: start, end: start.addingTimeInterval(3_600))
    let legacyPage = try await fixture.repository.calendarEventPage(for: legacy)
    let enriched = recurringEvent(
      provider: "eventkit",
      id: "legacy",
      start: start,
      series: CalendarSeriesIdentity(
        provider: "eventkit",
        externalIdentifier: "legacy",
        crossProviderIdentifier: "legacy"
      )
    )

    try await fixture.repository.replaceCalendarProjection([enriched], provider: "eventkit")
    let reopened = try await fixture.repository.calendarEventPages(for: enriched)

    XCTAssertEqual(reopened.occurrence.id, legacyPage.id)
    XCTAssertNotNil(reopened.series)
  }

  func testMovedRecurringInstanceKeepsCanonicalOccurrenceIdentity() {
    let original = Date(timeIntervalSince1970: 1_817_000_000)
    let series = CalendarSeriesIdentity(
      provider: "google",
      externalIdentifier: "master",
      crossProviderIdentifier: "uid@google.com"
    )
    let before = CalendarEventIdentity(
      provider: "google",
      externalIdentifier: "instance",
      occurrenceStart: original,
      series: series
    )
    let after = CalendarEventIdentity(
      provider: "google",
      externalIdentifier: "instance",
      occurrenceStart: original,
      series: series
    )

    XCTAssertEqual(PageID.calendarOccurrence(before), PageID.calendarOccurrence(after))
  }

  func testTrashRestoreAndPurgeLifecycle() async throws {
    let fixture = try RepositoryFixture()
    let page = try await fixture.repository.createFreePage()

    try await fixture.repository.moveToTrash(pageID: page.id)
    let trashed = try await fixture.repository.page(id: page.id)
    XCTAssertNotNil(trashed?.deletedAt)
    try await fixture.repository.restore(pageID: page.id)
    let restored = try await fixture.repository.page(id: page.id)
    XCTAssertNil(restored?.deletedAt)
    try await fixture.repository.moveToTrash(pageID: page.id)
    try await fixture.repository.purge(pageID: page.id)

    let purged = try await fixture.repository.page(id: page.id)
    let marker = try await fixture.repository.purgeMarker(pageID: page.id)
    XCTAssertNil(purged)
    XCTAssertNotNil(marker)
  }

  private func calendarEvent(
    provider: String, id: String, start: Date, end: Date
  ) -> CalendarEventSnapshot {
    CalendarEventSnapshot(
      identity: CalendarEventIdentity(provider: provider, externalIdentifier: id, occurrenceStart: start),
      title: id,
      startDate: start,
      endDate: end,
      isAllDay: false,
      location: nil,
      notes: nil,
      url: nil,
      calendarTitle: provider
    )
  }

  private func recurringEvent(
    provider: String,
    id: String,
    start: Date,
    series: CalendarSeriesIdentity
  ) -> CalendarEventSnapshot {
    CalendarEventSnapshot(
      identity: CalendarEventIdentity(
        provider: provider,
        externalIdentifier: id,
        occurrenceStart: start,
        disambiguator: provider == "google" ? "primary" : nil,
        series: series
      ),
      title: "Personal training",
      startDate: start,
      endDate: start.addingTimeInterval(3_600),
      isAllDay: false,
      location: "Gym",
      notes: nil,
      url: nil,
      calendarTitle: provider
    )
  }
}

private extension Array {
  func asyncMap<T>(_ transform: (Element) async throws -> T) async rethrows -> [T] {
    var values: [T] = []
    for element in self { values.append(try await transform(element)) }
    return values
  }
}

private final class RepositoryFixture {
  let path: String
  let repository: LibraryRepository

  init() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    path = directory.appendingPathComponent("library.sqlite").path
    repository = try LibraryRepository(path: path)
  }

  deinit {
    try? FileManager.default.removeItem(at: URL(fileURLWithPath: path).deletingLastPathComponent())
  }
}
