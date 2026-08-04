import Automerge
import Foundation
import XCTest

@testable import EnchiridionCore

final class LibraryRepositoryTests: XCTestCase {
  func testTaskHomeSnapshotIncludesOnlyExplicitlyPromotedPeopleAndMatchesTaskQueries() async throws {
    let fixture = try RepositoryFixture()
    let now = Date(timeIntervalSince1970: 1_820_000_000)
    let project = try await fixture.repository.createProject(
      title: "Project Zebra",
      data: ProjectData(status: .active, outcome: "Ship Tasks home")
    )
    let closedProject = try await fixture.repository.createProject(
      title: "Closed Project",
      data: ProjectData(status: .completed, outcome: "Done")
    )
    let area = try await fixture.repository.createTaggedPage(
      title: "Area Alpha",
      supertagID: BuiltInSupertags.area
    )
    var promoted = try await fixture.repository.createTaggedPage(
      title: "Promoted Person",
      supertagID: BuiltInSupertags.person
    )
    var other = try await fixture.repository.createTaggedPage(
      title: "Other Person",
      supertagID: BuiltInSupertags.person
    )
    var legacy = try await fixture.repository.createTaggedPage(
      title: "Legacy Person",
      supertagID: BuiltInSupertags.person
    )
    promoted.objectMetadata.personVisibility = .promoted
    other.objectMetadata.personVisibility = .other
    legacy.objectMetadata.personVisibility = nil

    _ = try await fixture.repository.createTask(
      TaskDraft(
        title: "Today task",
        data: TaskData(
          placement: .inbox,
          scheduledAt: now,
          projectID: project.id,
          areaID: area.id,
          assigneeIDs: [promoted.id, promoted.id, other.id],
          tags: ["#alpha", " ALPHA ", "beta"]
        )
      )
    )
    _ = try await fixture.repository.createTask(
      TaskDraft(
        title: "Closed task",
        data: TaskData(
          state: .completed,
          projectID: closedProject.id,
          tags: ["inactive-only"]
        )
      )
    )
    _ = try await fixture.repository.createTask(
      TaskDraft(
        title: "Later task",
        data: TaskData(
          placement: .anytime,
          scheduledAt: now.addingTimeInterval(86_400),
          projectID: project.id,
          assigneeIDs: [promoted.id],
          tags: ["beta"]
        )
      )
    )
    let pages = try await fixture.repository.pages(in: .allPages)
    let nonPeople = pages.filter { ![promoted.id, other.id, legacy.id].contains($0.id) }
    let snapshot = TaskHomeSnapshot.make(
      pages: nonPeople + [promoted, other, legacy],
      now: now,
      calendar: Calendar(identifier: .gregorian)
    )

    XCTAssertEqual(snapshot.people.map(\.id), [promoted.id])
    XCTAssertEqual(snapshot.people.first?.activeTaskCount, 2)
    XCTAssertEqual(snapshot.projects.first?.activeTaskCount, 2)
    XCTAssertEqual(snapshot.projects.map(\.id), [project.id])
    XCTAssertEqual(snapshot.areas.first?.activeTaskCount, 1)
    XCTAssertEqual(snapshot.tags.first { $0.id == "alpha" }?.activeTaskCount, 1)
    XCTAssertEqual(snapshot.tags.first { $0.id == "beta" }?.activeTaskCount, 2)
    XCTAssertEqual(snapshot.tags.first { $0.id == "inactive-only" }?.activeTaskCount, 0)
    for list in TaskSmartList.allCases where list != .review {
      XCTAssertEqual(
        snapshot.focusCount(for: list),
        TaskQuery.count(list, in: pages, now: now, calendar: Calendar(identifier: .gregorian)),
        "Count parity for \(list)"
      )
    }
    XCTAssertEqual(
      snapshot.weeklyReviewProjectCount,
      WeeklyReviewSnapshot.make(pages: pages, now: now, calendar: Calendar(identifier: .gregorian))
        .projects.filter(\.needsReview).count
    )
  }

  func testTaskHomeSnapshotOnlyResolvesAssignedExplicitlyPromotedPeople() async throws {
    let fixture = try RepositoryFixture()
    let now = Date(timeIntervalSince1970: 1_820_000_000)
    var template = try await fixture.repository.createTaggedPage(
      title: "Template",
      supertagID: BuiltInSupertags.person
    )
    template.objectMetadata.personVisibility = .promoted

    var zed = template
    zed.id = .person(email: "zed@example.com")
    zed.title = "Zed"
    var amy = template
    amy.id = .person(email: "amy@example.com")
    amy.title = "Amy"
    var other = template
    other.id = .person(email: "other@example.com")
    other.title = "Other"
    other.objectMetadata.personVisibility = .other
    var legacy = template
    legacy.id = .person(email: "legacy@example.com")
    legacy.title = "Legacy"
    legacy.objectMetadata.personVisibility = nil
    var deleted = template
    deleted.id = .person(email: "deleted@example.com")
    deleted.title = "Deleted"
    deleted.deletedAt = now
    var completedOnly = template
    completedOnly.id = .person(email: "completed@example.com")
    completedOnly.title = "Completed only"
    let unassignedPromotedPeople = (0..<1_200).map { index -> PageSnapshot in
      var person = template
      person.id = .person(email: "promoted-\(index)@example.com")
      person.title = "Promoted \(index)"
      return person
    }

    _ = try await fixture.repository.createTask(
      TaskDraft(
        title: "Active",
        data: TaskData(
          assigneeIDs: [zed.id, zed.id, amy.id, other.id, legacy.id, deleted.id]
        )
      )
    )
    _ = try await fixture.repository.createTask(
      TaskDraft(
        title: "Completed",
        data: TaskData(state: .completed, assigneeIDs: [completedOnly.id])
      )
    )
    let taskPages = try await fixture.repository.pages(in: .allPages).filter {
      TaskItem(page: $0) != nil
    }
    var resolverCalls = 0
    let snapshot = TaskHomeSnapshot.make(
      pages: taskPages + [zed, amy, other, legacy, deleted, completedOnly] + unassignedPromotedPeople,
      personTitle: { person in
        resolverCalls += 1
        return "Resolved \(person.title)"
      },
      now: now,
      calendar: Calendar(identifier: .gregorian)
    )

    XCTAssertEqual(snapshot.people.map(\.id), [amy.id, zed.id])
    XCTAssertEqual(snapshot.people.map(\.title), ["Resolved Amy", "Resolved Zed"])
    XCTAssertEqual(snapshot.people.map(\.activeTaskCount), [1, 1])
    XCTAssertEqual(resolverCalls, snapshot.people.count)
  }

  func testCalendarMaterializationIsOptInStableAndCloudSafe() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(provider: "google", id: "raw-google-event", start: start, end: start.addingTimeInterval(3_600))
    event.iCalendarUID = "private-uid@example.test"
    event.originalStartDate = start
    event.timeZoneIdentifier = "Europe/London"

    let disabled = try await fixture.repository.materializeCalendarEvents([event], now: start)
    XCTAssertTrue(disabled.changedPageIDs.isEmpty)

    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let first = try await fixture.repository.materializeCalendarEvents([event], now: start)
    let pageID = try XCTUnwrap(first.changedPageIDs.first)
    let loadedPage = try await fixture.repository.page(id: pageID)
    let page = try XCTUnwrap(loadedPage)
    XCTAssertTrue(page.hasSupertag(BuiltInSupertags.event))
    XCTAssertFalse(pageID.rawValue.contains("raw-google-event"))
    XCTAssertFalse(String(decoding: try JSONEncoder.enchiridion.encode(page.kind), as: UTF8.self).contains("private-uid"))

    let second = try await fixture.repository.materializeCalendarEvents([event], now: start.addingTimeInterval(10))
    XCTAssertTrue(second.changedPageIDs.isEmpty)
    let loadedUnchanged = try await fixture.repository.page(id: pageID)
    let unchanged = try XCTUnwrap(loadedUnchanged)
    XCTAssertEqual(unchanged.dirtyGeneration, page.dirtyGeneration)
  }

  func testCalendarMaterializationScopesProvidersAndOmitsOtherPeople() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var google = calendarEvent(provider: "google", id: "g", start: start, end: start.addingTimeInterval(3_600))
    google.iCalendarUID = "mirror@example.test"
    google.originalStartDate = start
    google.timeZoneIdentifier = "UTC"
    google.attendees = [.init(email: "other@example.test", displayName: "Other", role: "attendee", responseStatus: "accepted", isCurrentUser: false)]
    var eventKit = google
    eventKit.identity.provider = "eventkit"
    eventKit.identity.externalIdentifier = "e"
    try await fixture.repository.replaceCalendarProjection([google], provider: "google")
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let g = try await fixture.repository.materializeCalendarEvents([google], now: start)
    let e = try await fixture.repository.materializeCalendarEvents([eventKit], now: start)
    XCTAssertNotEqual(g.changedPageIDs.first, e.changedPageIDs.first)
    let googlePageID = try XCTUnwrap(g.changedPageIDs.first)
    let loadedPage = try await fixture.repository.page(id: googlePageID)
    let page = try XCTUnwrap(loadedPage)
    let attendeeKey = SupertagPropertyKey(supertagID: BuiltInSupertags.event, fieldID: .init(rawValue: "attendees"))
    XCTAssertNil(page.objectMetadata.properties[attendeeKey])
  }

  func testCalendarMaterializationDoesNotReceiveOmittedProjectionEvents() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(provider: "google", id: "birthday", start: start, end: start.addingTimeInterval(3_600))
    event.iCalendarUID = "omitted@example.test"
    event.originalStartDate = start
    event.timeZoneIdentifier = "UTC"
    event.title = "Blocked: private"
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let accepted = try await fixture.repository.replaceCalendarProjection([event], provider: "google")
    XCTAssertTrue(accepted.isEmpty)
    let receipt = try await fixture.repository.materializeCalendarEvents(
      accepted, provider: "google", authoritativeInterval: .init(start: start, end: start.addingTimeInterval(3_600)), now: start
    )
    XCTAssertTrue(receipt.changedPageIDs.isEmpty)
  }

  func testCalendarMaterializationPromotedAttendeeIsAnIdempotentProviderReference() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(provider: "google", id: "event", start: start, end: start.addingTimeInterval(3_600))
    event.iCalendarUID = "attendee@example.test"
    event.originalStartDate = start
    event.timeZoneIdentifier = "UTC"
    event.attendees = [.init(email: "promoted@example.test", displayName: "Promoted", role: "attendee", responseStatus: "accepted", isCurrentUser: false)]
    try await fixture.repository.replaceCalendarProjection([event], provider: "google")
    _ = try await fixture.repository.promotePerson(pageID: .person(email: "promoted@example.test"))
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)

    let first = try await fixture.repository.materializeCalendarEvents([event], provider: "google", now: start)
    XCTAssertEqual(first.changedPageIDs.count, 1)
    let second = try await fixture.repository.materializeCalendarEvents([event], provider: "google", now: start.addingTimeInterval(1))
    XCTAssertTrue(second.changedPageIDs.isEmpty)
  }

  func testCalendarMaterializationUpdatesProviderTitleButPreservesUserTitleOverride() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(provider: "google", id: "event", start: start, end: start.addingTimeInterval(3_600))
    event.iCalendarUID = "title@example.test"
    event.originalStartDate = start
    event.timeZoneIdentifier = "UTC"
    event.title = "Provider title"
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let first = try await fixture.repository.materializeCalendarEvents([event], provider: "google", now: start)
    let pageID = try XCTUnwrap(first.changedPageIDs.first)

    event.title = "Updated provider title"
    let updated = try await fixture.repository.materializeCalendarEvents([event], provider: "google", now: start.addingTimeInterval(1))
    XCTAssertEqual(updated.changedPageIDs, [pageID])
    let afterProviderTitle = try await fixture.repository.page(id: pageID)
    XCTAssertEqual(afterProviderTitle?.title, "Updated provider title")

    _ = try await fixture.repository.renamePage(pageID: pageID, title: "My title", now: start.addingTimeInterval(2))
    event.title = "A later provider title"
    let detached = try await fixture.repository.materializeCalendarEvents([event], provider: "google", now: start.addingTimeInterval(3))
    XCTAssertTrue(detached.changedPageIDs.isEmpty)
    let afterUserTitle = try await fixture.repository.page(id: pageID)
    XCTAssertEqual(afterUserTitle?.title, "My title")
  }

  func testCalendarMaterializationPreservesProviderFieldOverrideAndAppliesAttendeeChanges() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(provider: "google", id: "fields", start: start, end: start.addingTimeInterval(3_600))
    event.iCalendarUID = "fields@example.test"
    event.originalStartDate = start
    event.timeZoneIdentifier = "UTC"
    event.location = "Provider room"
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let first = try await fixture.repository.materializeCalendarEvents([event], provider: "google", now: start)
    let pageID = try XCTUnwrap(first.changedPageIDs.first)
    let locationKey = SupertagPropertyKey(supertagID: BuiltInSupertags.event, fieldID: .init(rawValue: "location"))
    try await fixture.repository.setProperty(pageID: pageID, key: locationKey, values: [.text("My room")])
    event.location = "Changed provider room"
    let overridden = try await fixture.repository.materializeCalendarEvents(
      [event], provider: "google", now: start.addingTimeInterval(1)
    )
    XCTAssertTrue(overridden.changedPageIDs.isEmpty)
    let afterLocationOverride = try await fixture.repository.page(id: pageID)
    XCTAssertEqual(afterLocationOverride?.objectMetadata.properties[locationKey], [.text("My room")])

    var attendeeEvent = calendarEvent(provider: "google", id: "attendee-fields", start: start, end: start.addingTimeInterval(3_600))
    attendeeEvent.iCalendarUID = "attendee-fields@example.test"
    attendeeEvent.originalStartDate = start
    attendeeEvent.timeZoneIdentifier = "UTC"
    let attendee = CalendarAttendeeIdentity(email: "promoted-change@example.test", displayName: "Promoted", role: "attendee", responseStatus: "accepted", isCurrentUser: false)
    try await fixture.repository.replaceCalendarProjection([attendeeEvent], provider: "google")
    let attendeePage = try await fixture.repository.materializeCalendarEvents([attendeeEvent], provider: "google", now: start)
    attendeeEvent.attendees = [attendee]
    try await fixture.repository.replaceCalendarProjection([attendeeEvent], provider: "google")
    _ = try await fixture.repository.promotePerson(pageID: .person(email: try XCTUnwrap(attendee.email)))
    let attendeeAdded = try await fixture.repository.materializeCalendarEvents(
      [attendeeEvent], provider: "google", now: start.addingTimeInterval(1)
    )
    XCTAssertEqual(attendeeAdded.changedPageIDs.count, 1)
    attendeeEvent.attendees = []
    try await fixture.repository.replaceCalendarProjection([attendeeEvent], provider: "google")
    let attendeeRemoved = try await fixture.repository.materializeCalendarEvents(
      [attendeeEvent], provider: "google", now: start.addingTimeInterval(2)
    )
    XCTAssertEqual(attendeeRemoved.changedPageIDs.count, 1)
    let attendeeNoop = try await fixture.repository.materializeCalendarEvents(
      [attendeeEvent], provider: "google", now: start.addingTimeInterval(3)
    )
    XCTAssertTrue(attendeeNoop.changedPageIDs.isEmpty)
    XCTAssertFalse(attendeePage.changedPageIDs.isEmpty)
  }

  func testCalendarMaterializationMissingCurrentEventUsesGraceAndIncompleteRefreshDoesNotAdvance() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(provider: "google", id: "missing", start: start, end: start.addingTimeInterval(3_600))
    event.iCalendarUID = "missing@example.test"
    event.originalStartDate = start
    event.timeZoneIdentifier = "UTC"
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let first = try await fixture.repository.materializeCalendarEvents(
      [event], provider: "google", authoritativeInterval: .init(start: start.addingTimeInterval(-1), end: start.addingTimeInterval(7_200)), now: start
    )
    let pageID = try XCTUnwrap(first.changedPageIDs.first)
    let incomplete = try await fixture.repository.materializeCalendarEvents(
      [], provider: "google", now: start.addingTimeInterval(1)
    )
    XCTAssertTrue(incomplete.changedPageIDs.isEmpty)
    let completeWithinGrace = try await fixture.repository.materializeCalendarEvents(
      [], provider: "google", authoritativeInterval: .init(start: start.addingTimeInterval(-1), end: start.addingTimeInterval(7_200)), now: start.addingTimeInterval(2)
    )
    XCTAssertTrue(completeWithinGrace.changedPageIDs.isEmpty)
    let pruned = try await fixture.repository.materializeCalendarEvents(
      [], provider: "google", authoritativeInterval: .init(start: start.addingTimeInterval(-1), end: start.addingTimeInterval(7_200)), now: start.addingTimeInterval(31 * 24 * 60 * 60)
    )
    XCTAssertEqual(pruned.changedPageIDs, [pageID])
  }

  func testCalendarMaterializationAdoptsMatchingCloudPageWithoutLocalState() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(provider: "google", id: "cloud", start: start, end: start.addingTimeInterval(3_600))
    event.iCalendarUID = "cloud-import@example.test"
    event.originalStartDate = start
    event.timeZoneIdentifier = "UTC"
    event.title = "Cloud title"
    let identity = try XCTUnwrap(CalendarEventMaterialization.identity(for: event))
    let pageID = PageID.materializedCalendarEvent(identity)
    _ = try await fixture.repository.createTaggedPage(
      title: event.title, supertagID: BuiltInSupertags.event, id: pageID, now: start
    )
    for (key, values) in CalendarEventMaterialization.providerProperties(for: event) {
      try await fixture.repository.setProperty(pageID: pageID, key: key, values: values, now: start)
    }
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let adopted = try await fixture.repository.materializeCalendarEvents(
      [event], provider: "google", now: start.addingTimeInterval(1)
    )
    XCTAssertTrue(adopted.changedPageIDs.isEmpty)

    event.location = "Updated room"
    let updated = try await fixture.repository.materializeCalendarEvents(
      [event], provider: "google", now: start.addingTimeInterval(2)
    )
    XCTAssertEqual(updated.changedPageIDs, [pageID])
  }

  func testAuthoritativeCalendarApplyMaterializesNormalEventPageAndCompletes() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(provider: "google", id: "atomic", start: start, end: start.addingTimeInterval(3600))
    event.iCalendarUID = "atomic@example.test"
    event.originalStartDate = start
    event.timeZoneIdentifier = "UTC"
    let token = try await fixture.repository.beginAuthoritativeCalendarRefresh(provider: "google", now: start)
    let receipt = try await fixture.repository.applyAuthoritativeCalendarProjection(
      .init(provider: "google", interval: .init(start: start.addingTimeInterval(-1), end: start.addingTimeInterval(7200)), events: [event]), token: token, now: start
    )
    XCTAssertFalse(receipt.changedPageIDs.isEmpty)
    let pages = try await fixture.repository.pages(with: BuiltInSupertags.event)
    XCTAssertEqual(pages.map(\.id), receipt.changedPageIDs)
    let completed = try await fixture.repository.calendarEventMaterializationBackfillState(provider: "google")
    XCTAssertEqual(completed?.status, .completed)
  }

  func testAuthoritativeCalendarApplyRejectsStaleAndDeficientIdentityKeepsRunning() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    let first = try await fixture.repository.beginAuthoritativeCalendarRefresh(provider: "google", now: start)
    let current = try await fixture.repository.beginAuthoritativeCalendarRefresh(provider: "google", now: start)
    await XCTAssertThrowsErrorAsync {
      try await fixture.repository.applyAuthoritativeCalendarProjection(
        .init(provider: "google", interval: .init(start: start, end: start.addingTimeInterval(1)), events: []), token: first, now: start
      )
    }
    var deficient = calendarEvent(provider: "google", id: "missing", start: start, end: start.addingTimeInterval(3600))
    deficient.iCalendarUID = nil
    await XCTAssertThrowsErrorAsync {
      try await fixture.repository.applyAuthoritativeCalendarProjection(
        .init(provider: "google", interval: .init(start: start, end: start.addingTimeInterval(7200)), events: [deficient]), token: current, now: start
      )
    }
    let running = try await fixture.repository.calendarEventMaterializationBackfillState(provider: "google")
    XCTAssertEqual(running?.status, .running)
  }

  func testCalendarUpgradeBackfillsActiveProjectionAsEventPage() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(
      provider: "eventkit", id: "legacy-projection", start: start,
      end: start.addingTimeInterval(3_600)
    )
    event.iCalendarUID = "legacy-projection@example.test"
    event.originalStartDate = start
    event.timeZoneIdentifier = "UTC"
    _ = try await fixture.repository.replaceCalendarProjection([event], provider: "eventkit")

    let receipt = try await fixture.repository.materializeActiveCalendarProjectionForUpgrade(now: start)
    let eventPages = try await fixture.repository.pages(with: BuiltInSupertags.event)
    let enabled = try await fixture.repository.calendarEventMaterializationEnabled()

    XCTAssertEqual(eventPages.map(\.id), receipt.changedPageIDs)
    XCTAssertEqual(eventPages.first?.title, event.title)
    XCTAssertTrue(enabled)
  }

  func testCalendarMaterializationDetachesConflictingCloudPageWithoutLocalState() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(provider: "google", id: "conflict", start: start, end: start.addingTimeInterval(3_600))
    event.iCalendarUID = "cloud-conflict@example.test"
    event.originalStartDate = start
    event.timeZoneIdentifier = "UTC"
    let identity = try XCTUnwrap(CalendarEventMaterialization.identity(for: event))
    let pageID = PageID.materializedCalendarEvent(identity)
    _ = try await fixture.repository.createTaggedPage(
      title: "My Cloud Title", supertagID: BuiltInSupertags.event, id: pageID, now: start
    )
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let detached = try await fixture.repository.materializeCalendarEvents(
      [event], provider: "google", now: start.addingTimeInterval(1)
    )
    XCTAssertTrue(detached.changedPageIDs.isEmpty)
    let retained = try await fixture.repository.page(id: pageID)
    XCTAssertEqual(retained?.title, "My Cloud Title")
  }

  @MainActor
  func testContactLinkUIPresentationIgnoresRefreshTimestampButPublishesContentChanges() {
    let pageID = PageID.person(email: "contact@example.com")
    let record = DeviceContactRecord(
      identifier: "device-contact",
      displayName: "Contact",
      organizationName: "Example",
      jobTitle: "Engineer",
      emails: ["contact@example.com", "other@example.com"],
      phoneNumbers: ["+44 1", "+44 2"],
      birthday: .init(month: 7, day: 28),
      thumbnailData: Data([0x01, 0x02])
    )
    let original = PersonContactLink(
      pageID: pageID,
      contactIdentifier: record.identifier,
      matchedEmail: "contact@example.com",
      record: record,
      refreshedAt: Date(timeIntervalSince1970: 1)
    )
    var timestampOnlyRefresh = original
    timestampOnlyRefresh.refreshedAt = Date(timeIntervalSince1970: 2)
    timestampOnlyRefresh.record.emails.reverse()
    timestampOnlyRefresh.record.phoneNumbers.reverse()
    var contentRefresh = timestampOnlyRefresh
    contentRefresh.record.displayName = "Changed Contact"

    XCTAssertTrue(
      LibraryStore.contactLinksHaveSameUIPresentation(
        [pageID: original],
        [pageID: timestampOnlyRefresh]
      )
    )
    XCTAssertFalse(
      LibraryStore.contactLinksHaveSameUIPresentation(
        [pageID: original],
        [pageID: contentRefresh]
      )
    )
  }

  @MainActor
  func testAcknowledgementLeavesFailedReminderQueuedAndRetryDrainsOutbox() async throws {
    let fixture = try RepositoryFixture()
    let reminderEffects = TransientReminderEffects()
    let store = LibraryStore(
      repository: fixture.repository,
      startImmediately: false,
      taskMutationEffects: TaskMutationEffectExecutor { effect in
        await reminderEffects.apply(effect)
      }
    )

    let taskID = await store.createTask(
      TaskDraft(
        title: "Durable reminder",
        data: TaskData(reminder: Date(timeIntervalSince1970: 1_900_000_000))
      )
    )

    let pendingAfterFailure = try await fixture.repository.pendingTaskEffectOutboxCount()
    let initialPresentation = TaskMutationWarningPresentation.make(
      warnings: store.taskMutationWarnings
    )
    XCTAssertNotNil(taskID)
    XCTAssertEqual(store.taskMutationWarnings.count, 1)
    XCTAssertEqual(pendingAfterFailure, 1)

    store.acknowledgeTaskMutationWarnings()

    let pendingAfterAcknowledgement =
      try await fixture.repository.pendingTaskEffectOutboxCount()
    XCTAssertTrue(store.taskMutationWarnings.isEmpty)
    XCTAssertNil(TaskMutationWarningPresentation.make(warnings: store.taskMutationWarnings))
    XCTAssertEqual(pendingAfterAcknowledgement, 1)

    let firstRetrySucceeded = await store.retryPendingTaskEffects()
    let pendingAfterFailedRetry = try await fixture.repository.pendingTaskEffectOutboxCount()
    let retryPresentation = TaskMutationWarningPresentation.make(
      warnings: store.taskMutationWarnings
    )
    XCTAssertFalse(firstRetrySucceeded)
    XCTAssertEqual(retryPresentation, initialPresentation)
    XCTAssertEqual(pendingAfterFailedRetry, 1)

    let retrySucceeded = await store.retryPendingTaskEffects()
    let pendingAfterRetry = try await fixture.repository.pendingTaskEffectOutboxCount()
    let reminderAttemptCount = await reminderEffects.reminderAttempts()
    XCTAssertTrue(retrySucceeded)
    XCTAssertTrue(store.taskMutationWarnings.isEmpty)
    XCTAssertEqual(pendingAfterRetry, 0)
    XCTAssertEqual(reminderAttemptCount, 3)
  }

  @MainActor
  func testTaskMutationReloadSkipsFullSystemReconciliation() async throws {
    let fixture = try RepositoryFixture()
    let probe = StoreReconciliationProbe()
    let reconciliationCoordinator = TaskSystemReconciliationCoordinator { _, pages in
      await probe.record(pages)
    }
    let store = LibraryStore(
      repository: fixture.repository,
      startImmediately: false,
      taskSystemReconciliationCoordinator: reconciliationCoordinator
    )

    let taskID = await store.createTask(TaskDraft(title: "Mutation refresh"))
    await reconciliationCoordinator.waitUntilIdle()
    let submissions = await probe.submissions()

    XCTAssertNotNil(taskID)
    XCTAssertEqual(store.page(id: try XCTUnwrap(taskID))?.title, "Mutation refresh")
    XCTAssertTrue(submissions.isEmpty)
  }

  @MainActor
  func testOrdinaryReloadSubmitsFullSystemReconciliation() async throws {
    let fixture = try RepositoryFixture()
    let task = try await fixture.repository.createTask(TaskDraft(title: "Reconcile refresh"))
    let probe = StoreReconciliationProbe()
    let reconciliationCoordinator = TaskSystemReconciliationCoordinator { _, pages in
      await probe.record(pages)
    }
    let store = LibraryStore(
      repository: fixture.repository,
      startImmediately: false,
      taskSystemReconciliationCoordinator: reconciliationCoordinator
    )

    await store.reload()
    await reconciliationCoordinator.waitUntilIdle()
    let submissions = await probe.submissions()

    XCTAssertEqual(submissions, [[task.id]])
  }

  func testOnlyTaskSourceListsAreTaskPerspectives() {
    let taskList = LiveQueryDefinition(
      name: "Next actions",
      source: .supertag(BuiltInSupertags.task),
      viewKind: .list
    )
    let taskBoard = LiveQueryDefinition(
      name: "Task board",
      source: .supertag(BuiltInSupertags.task),
      viewKind: .board
    )
    let pageList = LiveQueryDefinition(name: "Pages", source: .pages, viewKind: .list)

    XCTAssertTrue(taskList.isTaskListPerspective)
    XCTAssertFalse(taskBoard.isTaskListPerspective)
    XCTAssertFalse(pageList.isTaskListPerspective)
  }

  func testTaskPerspectiveDraftUsesActiveTasksAndTaskOrdering() throws {
    let draft = LiveQueryDefinition.taskPerspectiveDraft()
    let statusFilter = try XCTUnwrap(draft.filters.first)

    XCTAssertEqual(draft.name, "New Perspective")
    XCTAssertEqual(draft.source, .supertag(BuiltInSupertags.task))
    XCTAssertEqual(draft.viewKind, .list)
    XCTAssertEqual(draft.filters.count, 1)
    XCTAssertEqual(statusFilter.fieldID, TaskFields.status.fieldID)
    XCTAssertEqual(statusFilter.operation, .equals)
    XCTAssertEqual(statusFilter.value, .select("to-do"))
    XCTAssertEqual(
      draft.sorts,
      [
        .init(fieldID: TaskFields.scheduled.fieldID),
        .init(fieldID: TaskFields.deadline.fieldID),
        .init(systemField: "title"),
      ]
    )
    XCTAssertTrue(draft.isTaskListPerspective)
  }

  func testTaskPerspectiveSaveDuplicateDeleteLifecycle() async throws {
    let fixture = try RepositoryFixture()
    let original = LiveQueryDefinition.taskPerspectiveDraft(name: "Focused")
    try await fixture.repository.saveView(original)

    var copy = original
    copy.id = .random()
    copy.name = "Focused Copy"
    try await fixture.repository.duplicateView(copy, from: original.id)

    var perspectives = try await fixture.repository.savedViews().filter(\.isTaskListPerspective)
    XCTAssertTrue(perspectives.contains(original))
    XCTAssertTrue(perspectives.contains(copy))

    try await fixture.repository.deleteView(copy.id)

    perspectives = try await fixture.repository.savedViews().filter(\.isTaskListPerspective)
    XCTAssertTrue(perspectives.contains(original))
    XCTAssertFalse(perspectives.contains(copy))
  }

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

  @MainActor
  func testPagesCreatedOrModifiedOnDayAreOrderedByActivityAscending() async throws {
    let fixture = try RepositoryFixture()
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!

    func date(day: Int, hour: Int) -> Date {
      calendar.date(from: DateComponents(year: 2026, month: 7, day: day, hour: hour))!
    }

    let edited = try await fixture.repository.createFreePage(
      title: "Edited today",
      now: date(day: 27, hour: 14)
    )
    let created = try await fixture.repository.createFreePage(
      title: "Created today",
      now: date(day: 28, hour: 9)
    )
    try await fixture.repository.togglePinned(
      pageID: edited.id,
      now: date(day: 28, hour: 10)
    )
    _ = try await fixture.repository.createFreePage(
      title: "Tomorrow",
      now: date(day: 29, hour: 8)
    )
    let deleted = try await fixture.repository.createFreePage(
      title: "Deleted today",
      now: date(day: 28, hour: 8)
    )
    try await fixture.repository.moveToTrash(
      pageID: deleted.id,
      now: date(day: 28, hour: 11)
    )

    let store = LibraryStore(
      repository: fixture.repository,
      calendar: calendar,
      startImmediately: false
    )
    await store.reload()

    XCTAssertEqual(
      store.pagesCreatedOrModified(on: date(day: 28, hour: 12)).map(\.id),
      [created.id, edited.id]
    )
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
      baseHeads: page.heads,
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

  func testEditorCommitMergesAValidatedStaleDeltaWithCurrentDocument() async throws {
    let fixture = try RepositoryFixture()
    let base = try await fixture.repository.createFreePage(title: "Base")
    let local = try PageDocument.replaceBody(with: "Local draft", in: base.document)
    let remote = try PageDocument.setPinned(true, in: base.document)

    _ = try await fixture.repository.persistEditorCommit(
      EditorCommit(
        pageID: base.id,
        loadGeneration: 1,
        journalID: "remote",
        baseHeads: base.heads,
        encodedChanges: try PageDocument.encodedChanges(from: remote.document, since: base.heads),
        advertisedHeads: remote.heads
      )
    )
    let receipt = try await fixture.repository.persistEditorCommit(
      EditorCommit(
        pageID: base.id,
        loadGeneration: 1,
        journalID: "stale-local",
        baseHeads: base.heads,
        encodedChanges: try PageDocument.encodedChanges(from: local.document, since: base.heads),
        advertisedHeads: local.heads
      )
    )
    let persisted = try await fixture.repository.page(id: base.id)

    XCTAssertEqual(persisted?.plainText, "Local draft")
    XCTAssertEqual(persisted?.isPinned, true)
    XCTAssertEqual(persisted?.heads, receipt.heads)
    XCTAssertNotEqual(receipt.heads, local.heads)
  }

  func testEditorCommitRejectsMissingBaseAndTamperedAdvertisedHeads() async throws {
    let fixture = try RepositoryFixture()
    let page = try await fixture.repository.createFreePage(title: "Base")
    let edited = try PageDocument.replaceBody(with: "Draft", in: page.document)
    let changes = try PageDocument.encodedChanges(from: edited.document, since: page.heads)

    await XCTAssertThrowsErrorAsync {
      try await fixture.repository.persistEditorCommit(
        EditorCommit(
          pageID: page.id,
          loadGeneration: 1,
          journalID: "missing-base",
          baseHeads: .empty,
          encodedChanges: changes,
          advertisedHeads: edited.heads
        )
      )
    }
    await XCTAssertThrowsErrorAsync {
      try await fixture.repository.persistEditorCommit(
        EditorCommit(
          pageID: page.id,
          loadGeneration: 1,
          journalID: "tampered-heads",
          baseHeads: page.heads,
          encodedChanges: changes,
          advertisedHeads: page.heads
        )
      )
    }

    let persisted = try await fixture.repository.page(id: page.id)
    XCTAssertEqual(persisted?.heads, page.heads)
    XCTAssertEqual(persisted?.plainText, page.plainText)
  }

  func testRichTextRoundTripPreservesFormattingReferencesAndUnicodeScalarOffsets() throws {
    let pageID = PageID.free()
    let targetID = PageID.free()
    let original = try PageDocument.create(
      id: pageID,
      kind: .free,
      title: "Original",
      createdAt: Date()
    )
    var body = AttributedString("Bold 😊 italic strike code Page")

    func range(
      in text: AttributedString,
      _ lowerBound: Int,
      _ upperBound: Int
    ) -> Range<AttributedString.Index> {
      text.index(text.startIndex, offsetByUnicodeScalars: lowerBound)
        ..< text.index(text.startIndex, offsetByUnicodeScalars: upperBound)
    }

    body[range(in: body, 0, 4)].inlinePresentationIntent = [.stronglyEmphasized]
    body[range(in: body, 7, 13)].inlinePresentationIntent = [.emphasized]
    body[range(in: body, 14, 20)].inlinePresentationIntent = [.strikethrough]
    body[range(in: body, 21, 25)].inlinePresentationIntent = [.code]
    body[range(in: body, 26, 30)][PageRichTextAttributes.AutomergeMarks.self] = [
      try PageDocument.pageReferenceMark(to: targetID, label: "Page")
    ]

    let updated = try PageDocument.replaceRichText(
      title: "Formatted",
      body: body,
      in: original.document
    )
    let decoded = try PageDocument.richText(in: updated.document)
    let document = try Document(updated.document)
    guard case .Object(let bodyObject, .Text)? = try document.get(obj: .ROOT, key: "body") else {
      return XCTFail("Expected the page body to be Automerge text.")
    }
    let marks = try document.marks(obj: bodyObject)

    XCTAssertEqual(decoded.title, "Formatted")
    XCTAssertEqual(String(decoded.body.characters), "Bold 😊 italic strike code Page")
    XCTAssertEqual(
      decoded.body[range(in: decoded.body, 0, 4)].inlinePresentationIntent,
      [.stronglyEmphasized]
    )
    XCTAssertEqual(
      decoded.body[range(in: decoded.body, 7, 13)].inlinePresentationIntent,
      [.emphasized]
    )
    XCTAssertEqual(
      decoded.body[range(in: decoded.body, 14, 20)].inlinePresentationIntent,
      [.strikethrough]
    )
    XCTAssertEqual(
      decoded.body[range(in: decoded.body, 21, 25)].inlinePresentationIntent,
      [.code]
    )
    XCTAssertEqual(
      decoded.body[range(in: decoded.body, 26, 30)][PageRichTextAttributes.AutomergeMarks.self],
      [try PageDocument.pageReferenceMark(to: targetID, label: "Page")]
    )
    XCTAssertEqual(
      marks.map { "\($0.start):\($0.end):\($0.name)" }.sorted(),
      [
        "0:4:\(PageDocument.strongMark)",
        "7:13:\(PageDocument.emphasisMark)",
        "14:20:\(PageDocument.strikethroughMark)",
        "21:25:\(PageDocument.codeMark)",
        "26:30:\(PageDocument.pageReferenceMark)",
      ].sorted()
    )
    XCTAssertEqual(updated.projection.references.map(\.targetPageID), [targetID])
  }

  func testRichTextCustomMarksDoNotPropagateToInsertedText() throws {
    let referenceMark = try PageDocument.pageReferenceMark(
      to: .free(),
      label: "Reference"
    )
    let customMark = PageRichTextMark(name: "comment", value: .string("review"))

    func range(
      in text: AttributedString,
      _ lowerBound: Int,
      _ upperBound: Int
    ) -> Range<AttributedString.Index> {
      text.index(text.startIndex, offsetByUnicodeScalars: lowerBound)
        ..< text.index(text.startIndex, offsetByUnicodeScalars: upperBound)
    }

    func markedText(with marks: [PageRichTextMark]) -> AttributedString {
      var text = AttributedString("Reference")
      text[text.startIndex..<text.endIndex][PageRichTextAttributes.AutomergeMarks.self] = marks
      return text
    }

    var text = markedText(with: [referenceMark])
    text.replaceSubrange(range(in: text, 0, 0), with: AttributedString("Start "))
    XCTAssertNil(text[range(in: text, 0, 6)][PageRichTextAttributes.AutomergeMarks.self])
    XCTAssertEqual(
      text[range(in: text, 6, 15)][PageRichTextAttributes.AutomergeMarks.self],
      [referenceMark]
    )

    text = markedText(with: [referenceMark])
    text.replaceSubrange(range(in: text, 9, 9), with: AttributedString(" end"))
    XCTAssertEqual(
      text[range(in: text, 0, 9)][PageRichTextAttributes.AutomergeMarks.self],
      [referenceMark]
    )
    XCTAssertNil(text[range(in: text, 9, 13)][PageRichTextAttributes.AutomergeMarks.self])

    text = markedText(with: [referenceMark])
    text.replaceSubrange(range(in: text, 4, 4), with: AttributedString("-"))
    XCTAssertEqual(
      text[range(in: text, 0, 4)][PageRichTextAttributes.AutomergeMarks.self],
      [referenceMark]
    )
    XCTAssertNil(text[range(in: text, 4, 5)][PageRichTextAttributes.AutomergeMarks.self])
    XCTAssertEqual(
      text[range(in: text, 5, 10)][PageRichTextAttributes.AutomergeMarks.self],
      [referenceMark]
    )

    text = AttributedString("xReference")
    text[range(in: text, 1, 10)][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark]
    text.replaceSubrange(range(in: text, 0, 3), with: AttributedString("X"))
    XCTAssertNil(text[range(in: text, 0, 1)][PageRichTextAttributes.AutomergeMarks.self])
    XCTAssertEqual(
      text[range(in: text, 1, 8)][PageRichTextAttributes.AutomergeMarks.self],
      [referenceMark]
    )

    text = markedText(with: [customMark])
    text.replaceSubrange(range(in: text, 9, 9), with: AttributedString("!"))
    XCTAssertEqual(
      text[range(in: text, 0, 9)][PageRichTextAttributes.AutomergeMarks.self],
      [customMark]
    )
    XCTAssertNil(text[range(in: text, 9, 10)][PageRichTextAttributes.AutomergeMarks.self])
  }

  func testRichTextEditorUpgradesSchemaVersionOneDocuments() throws {
    let created = try PageDocument.create(
      id: .free(),
      kind: .free,
      title: "Legacy",
      createdAt: Date()
    )
    let legacy = try Document(created.document)
    try legacy.put(obj: .ROOT, key: "schemaVersion", value: .Int(1))
    legacy.commitWith(message: "Write legacy schema", timestamp: Date())

    XCTAssertNoThrow(try PageDocument.richText(in: legacy.save()))

    let upgraded = try PageDocument.replaceRichText(
      title: "Migrated",
      body: AttributedString("Native text"),
      in: legacy.save()
    )
    let document = try Document(upgraded.document)

    XCTAssertEqual(
      try document.get(obj: .ROOT, key: "schemaVersion"),
      .Scalar(.Int(Int64(PageDocument.schemaVersion)))
    )
    XCTAssertEqual(upgraded.projection.title, "Migrated")
    XCTAssertEqual(upgraded.projection.plainText, "Native text")
  }

  func testRichTextRoundTripPreservesOverlappingCustomMarks() throws {
    let original = try PageDocument.create(
      id: .free(),
      kind: .free,
      title: "Overlapping marks",
      createdAt: Date()
    )
    let document = try Document(original.document)
    guard case .Object(let bodyObject, .Text)? = try document.get(obj: .ROOT, key: "body") else {
      return XCTFail("Expected the page body to be Automerge text.")
    }
    try document.spliceText(obj: bodyObject, start: 0, delete: 0, value: "abcdefghij")
    try document.mark(
      obj: bodyObject,
      start: 0,
      end: 10,
      expand: .both,
      name: "highlight",
      value: .String("yellow")
    )
    try document.mark(
      obj: bodyObject,
      start: 3,
      end: 7,
      expand: .both,
      name: "comment",
      value: .String("review")
    )
    document.commitWith(message: "Add overlapping marks", timestamp: Date())

    let decoded = try PageDocument.richText(in: document.save())
    let overlappingRange = decoded.body.index(decoded.body.startIndex, offsetByUnicodeScalars: 3)
      ..< decoded.body.index(decoded.body.startIndex, offsetByUnicodeScalars: 7)
    let roundTripped = try PageDocument.replaceRichText(
      title: decoded.title,
      body: decoded.body,
      in: document.save()
    )
    let decodedAgain = try PageDocument.richText(in: roundTripped.document)
    let roundTrippedRange = decodedAgain.body.index(
      decodedAgain.body.startIndex,
      offsetByUnicodeScalars: 3
    )..<decodedAgain.body.index(
      decodedAgain.body.startIndex,
      offsetByUnicodeScalars: 7
    )
    let expectedMarks: Set = [
      PageRichTextMark(name: "highlight", value: .string("yellow")),
      PageRichTextMark(name: "comment", value: .string("review")),
    ]

    XCTAssertEqual(
      Set(decoded.body[overlappingRange][PageRichTextAttributes.AutomergeMarks.self] ?? []),
      expectedMarks
    )
    XCTAssertEqual(
      Set(decodedAgain.body[roundTrippedRange][PageRichTextAttributes.AutomergeMarks.self] ?? []),
      expectedMarks
    )
  }

  func testPersistRichTextEditorUpdatesProjectionReferencesAndCloudDirtyState() async throws {
    let fixture = try RepositoryFixture()
    let target = try await fixture.repository.createFreePage(title: "Project Atlas")
    let source = try await fixture.repository.createFreePage(title: "Original")
    var body = AttributedString("Meet Project Atlas")
    let referenceRange = body.index(body.startIndex, offsetByUnicodeScalars: 5)
      ..< body.index(body.startIndex, offsetByUnicodeScalars: 18)
    body[referenceRange][PageRichTextAttributes.AutomergeMarks.self] = [
      try PageDocument.pageReferenceMark(to: target.id, label: "Project Atlas")
    ]
    body[referenceRange].inlinePresentationIntent = [.stronglyEmphasized]

    let updated = try await fixture.repository.persistRichTextEditor(
      pageID: source.id,
      title: "Meeting notes",
      body: body
    )
    let persisted = try await fixture.repository.page(id: source.id)
    let backlinks = try await fixture.repository.backlinks(to: target.id)
    let dirtyPages = try await fixture.repository.dirtyPages()
    let decoded = try PageDocument.richText(in: try XCTUnwrap(persisted).document)

    XCTAssertEqual(updated.dirtyGeneration, source.dirtyGeneration + 1)
    XCTAssertEqual(persisted?.title, "Meeting notes")
    XCTAssertEqual(persisted?.plainText, "Meet Project Atlas")
    XCTAssertEqual(backlinks.map(\.id), [source.id])
    XCTAssertTrue(dirtyPages.contains { $0.id == source.id })
    let decodedReferenceRange = decoded.body.index(decoded.body.startIndex, offsetByUnicodeScalars: 5)
      ..< decoded.body.index(decoded.body.startIndex, offsetByUnicodeScalars: 18)
    XCTAssertTrue(
      decoded.body[decodedReferenceRange][PageRichTextAttributes.AutomergeMarks.self]?.contains(
        try PageDocument.pageReferenceMark(to: target.id, label: "Project Atlas")
      ) == true
    )
    XCTAssertEqual(
      decoded.body[decodedReferenceRange].inlinePresentationIntent,
      [.stronglyEmphasized]
    )
  }

  @MainActor
  func testStoreRichTextEditorRefreshesOnlyTheCommittedPageCache() async throws {
    let fixture = try RepositoryFixture()
    let original = try await fixture.repository.createFreePage(title: "Original")
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    await store.reload(policy: .refreshOnly)

    let unrelated = try await fixture.repository.createFreePage(title: "External")
    _ = try await store.persistRichTextEditor(
      pageID: original.id,
      title: "Native editor",
      body: AttributedString("Saved without a web view")
    )

    XCTAssertEqual(store.page(id: original.id)?.title, "Native editor")
    XCTAssertEqual(store.page(id: original.id)?.plainText, "Saved without a web view")
    XCTAssertNil(store.page(id: unrelated.id))
  }

  @MainActor
  func testStoreEditorCommitRefreshesOnlyTheCommittedPageCache() async throws {
    let fixture = try RepositoryFixture()
    let original = try await fixture.repository.createFreePage(title: "Original")
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    await store.reload(policy: .refreshOnly)

    let unrelated = try await fixture.repository.createFreePage(title: "External")
    let edited = try PageDocument.replaceBody(with: "Responsive typing", in: original.document)
    let commit = EditorCommit(
      pageID: original.id,
      loadGeneration: 1,
      journalID: "targeted-editor-refresh",
      baseHeads: original.heads,
      encodedChanges: try PageDocument.encodedChanges(
        from: edited.document,
        since: original.heads
      ),
      advertisedHeads: edited.heads
    )

    _ = try await store.persistEditorCommit(commit)

    XCTAssertEqual(store.page(id: original.id)?.plainText, "Responsive typing")
    XCTAssertNil(store.page(id: unrelated.id))
  }

  func testConcurrentAutomergeChangesMergeWithoutDroppingEitherIntent() throws {
    let id = PageID.free()
    let original = try PageDocument.create(id: id, kind: .free, title: "Merge", createdAt: Date())
    let pinned = try PageDocument.setPinned(true, in: original.document)
    let deletedAt = Date(timeIntervalSince1970: 2_000)
    let deleted = try PageDocument.setDeleted(deletedAt, in: original.document)

    let merged = try PageDocument.merge(
      local: pinned.document, remote: deleted.document, pageID: id)

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
    XCTAssertEqual(
      views.first(where: { $0.id.rawValue == "view_work_calendar" })?.source, .workCalendar)
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
    let parsed = try DomainQueryCodec.parse(
      original.domainSQL, id: original.id, name: original.name)

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
      limit: 275,
      peopleScope: .includeOthers
    )

    let parsed = try DomainQueryCodec.parse(
      original.domainSQL, id: original.id, name: original.name)

    XCTAssertEqual(parsed.id, original.id)
    XCTAssertEqual(parsed.name, original.name)
    XCTAssertEqual(parsed.source, original.source)
    XCTAssertEqual(
      parsed.filters.map {
        [$0.fieldID?.rawValue, $0.systemField, $0.operation.rawValue, $0.value?.id]
      },
      original.filters.map {
        [$0.fieldID?.rawValue, $0.systemField, $0.operation.rawValue, $0.value?.id]
      })
    XCTAssertEqual(parsed.sorts, original.sorts)
    XCTAssertEqual(parsed.viewKind, original.viewKind)
    XCTAssertEqual(parsed.visibleFieldIDs, original.visibleFieldIDs)
    XCTAssertEqual(parsed.groupFieldID, original.groupFieldID)
    XCTAssertEqual(parsed.startFieldID, original.startFieldID)
    XCTAssertEqual(parsed.endFieldID, original.endFieldID)
    XCTAssertEqual(parsed.limit, original.limit)
    XCTAssertEqual(parsed.peopleScope, .includeOthers)
  }

  func testLegacySavedViewDefaultsToPromotedPeopleOnly() throws {
    let view = LiveQueryDefinition(name: "Legacy", source: .pages)
    let encoded = try JSONEncoder.enchiridion.encode(view)
    var object = try XCTUnwrap(
      JSONSerialization.jsonObject(with: encoded) as? [String: Any]
    )
    object.removeValue(forKey: "peopleScope")
    let legacy = try JSONSerialization.data(withJSONObject: object)

    let decoded = try JSONDecoder.enchiridion.decode(LiveQueryDefinition.self, from: legacy)

    XCTAssertEqual(decoded.peopleScope, .promotedOnly)
    XCTAssertFalse(decoded.domainSQL.contains("INCLUDE OTHERS"))
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
      try await fixture.repository.setProperty(
        pageID: page.id, key: status, values: [.select("active")])
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
    let before = try await IDs(
      for: .init(
        fieldID: due.fieldID, operation: .before, value: .date(Date(timeIntervalSince1970: 3_000))))
    let after = try await IDs(
      for: .init(
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

    XCTAssertTrue(
      items.contains { if case .event(let value) = $0 { value.id == event.id } else { false } })
    XCTAssertTrue(
      items.contains { if case .page(let value) = $0 { value.id == task.id } else { false } })
  }

  func testCalendarAttendeesCreateDeterministicPeople() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(
      provider: "google", id: "planning", start: start, end: start.addingTimeInterval(3600))
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
    let visiblePeople = try await fixture.repository.pages(with: BuiltInSupertags.person)
    let allPeople = try await fixture.repository.pages(
      with: BuiltInSupertags.person,
      includeOthers: true
    )
    let person = try XCTUnwrap(allPeople.first)

    XCTAssertTrue(visiblePeople.isEmpty)
    XCTAssertEqual(allPeople.count, 1)
    XCTAssertEqual(person.id, .person(email: "alice@example.com"))
    XCTAssertEqual(person.displayTitle, "Alice Smith")
    XCTAssertEqual(person.effectivePersonVisibility, .other)
    XCTAssertEqual(person.personOrigin, .calendarAttendee)
    try await fixture.repository.markAllCloudDataForZoneRecovery()
    let dirtyBeforePromotion = try await fixture.repository.dirtyPages()
    let libraryPages = try await fixture.repository.pages(in: .allPages)
    let suggestions = try await fixture.repository.suggestions(matching: "Alice")
    let taggedSuggestions = try await fixture.repository.taggedSuggestions(
      matching: "Alice",
      supertagID: BuiltInSupertags.person
    )
    XCTAssertFalse(dirtyBeforePromotion.contains { $0.id == person.id })
    XCTAssertFalse(libraryPages.contains { $0.id == person.id })
    XCTAssertTrue(suggestions.isEmpty)
    XCTAssertTrue(taggedSuggestions.isEmpty)

    let defaultView = LiveQueryDefinition(
      name: "People",
      source: .supertag(BuiltInSupertags.person)
    )
    var inclusiveView = defaultView
    inclusiveView.peopleScope = .includeOthers
    let defaultItems = try await fixture.repository.run(defaultView)
    let inclusiveItems = try await fixture.repository.run(inclusiveView)
    XCTAssertTrue(defaultItems.isEmpty)
    XCTAssertEqual(inclusiveItems.map(\.id), ["page:\(person.id.rawValue)"])

    let promoted = try await fixture.repository.promotePerson(pageID: person.id)
    let promotedPeople = try await fixture.repository.pages(with: BuiltInSupertags.person)
    let dirtyAfterPromotion = try await fixture.repository.dirtyPages()
    XCTAssertEqual(promoted.effectivePersonVisibility, .promoted)
    XCTAssertEqual(promotedPeople.map(\.id), [person.id])
    XCTAssertTrue(dirtyAfterPromotion.contains { $0.id == person.id })

    try await fixture.repository.replaceCalendarProjection([event], provider: "google")
    let refreshedPerson = try await fixture.repository.page(id: person.id)
    XCTAssertEqual(refreshedPerson?.effectivePersonVisibility, .promoted)
  }

  func testManualPeopleArePromotedByDefault() async throws {
    let fixture = try RepositoryFixture()

    let person = try await fixture.repository.createTaggedPage(
      title: "Ada Lovelace",
      supertagID: BuiltInSupertags.person
    )
    let visiblePeople = try await fixture.repository.pages(with: BuiltInSupertags.person)

    XCTAssertEqual(person.effectivePersonVisibility, .promoted)
    XCTAssertEqual(person.personOrigin, .manual)
    XCTAssertEqual(visiblePeople.map(\.id), [person.id])
  }

  func testCalendarOmissionRulesDefaultNormalizeAndFilterBeforeAttendees() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var blocked = calendarEvent(
      provider: "eventkit",
      id: "blocked",
      start: start,
      end: start.addingTimeInterval(3_600)
    )
    blocked.title = "Blöcked planning"
    blocked.attendees = [
      CalendarAttendeeIdentity(
        email: "noise@example.com",
        displayName: "Noise",
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      )
    ]
    var allowed = calendarEvent(
      provider: "eventkit",
      id: "allowed",
      start: start.addingTimeInterval(7_200),
      end: start.addingTimeInterval(10_800)
    )
    allowed.attendees = [
      CalendarAttendeeIdentity(
        email: "kept@example.com",
        displayName: "Kept",
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      )
    ]

    let defaultPrefixes = try await fixture.repository.calendarEventOmissionPrefixes()
    XCTAssertEqual(defaultPrefixes, ["Blocked"])
    try await fixture.repository.setCalendarEventOmissionPrefixes([
      "  BLOCKED ", "blöcked", "", "Private",
    ])
    let normalizedPrefixes = try await fixture.repository.calendarEventOmissionPrefixes()
    XCTAssertEqual(normalizedPrefixes, ["BLOCKED", "Private"])
    try await fixture.repository.replaceCalendarProjection(
      [blocked, allowed],
      provider: "eventkit"
    )

    let events = try await fixture.repository.calendarEvents(
      from: start.addingTimeInterval(-1),
      through: start.addingTimeInterval(12_000)
    )
    let people = try await fixture.repository.pages(
      with: BuiltInSupertags.person,
      includeOthers: true
    )
    XCTAssertEqual(events.map(\.id), [allowed.id])
    XCTAssertEqual(people.map(\.id), [.person(email: "kept@example.com")])
  }

  func testChangingOmissionRulesDetachesMappedNoteButHidesEvent() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(
      provider: "eventkit",
      id: "focus",
      start: start,
      end: start.addingTimeInterval(3_600)
    )
    event.title = "Focus block"
    try await fixture.repository.replaceCalendarProjection([event], provider: "eventkit")
    let note = try await fixture.repository.calendarEventPage(for: event)

    try await fixture.repository.setCalendarEventOmissionPrefixes(["Focus"])
    let preservedNote = try await fixture.repository.page(id: note.id)
    let visibleEvents = try await fixture.repository.calendarEvents(
      from: start.addingTimeInterval(-1),
      through: start.addingTimeInterval(3_601)
    )
    let contexts = try await fixture.repository.calendarPageContexts()

    XCTAssertNotNil(preservedNote)
    XCTAssertTrue(visibleEvents.isEmpty)
    XCTAssertEqual(contexts[note.id]?.sourceUnavailable, true)
  }

  @MainActor
  func testStoreFilterMutationReloadsCachedEventsWithoutConfiguredProviders() async throws {
    let fixture = try RepositoryFixture()
    let start = Date().addingTimeInterval(3_600)
    var event = calendarEvent(
      provider: "eventkit",
      id: "store-filter",
      start: start,
      end: start.addingTimeInterval(3_600)
    )
    event.title = "Private appointment"
    try await fixture.repository.replaceCalendarProjection([event], provider: "eventkit")
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)

    await store.reload()
    XCTAssertEqual(store.calendarEvents.map(\.identity.externalIdentifier), ["store-filter"])

    await store.setCalendarEventOmissionPrefixes(["Private"])
    XCTAssertTrue(store.calendarEvents.isEmpty)
  }

  func testProjectionCleanupPrunesOnlyUntouchedOrphansAndBacklinksHideOtherSources() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(
      provider: "eventkit",
      id: "people-cleanup",
      start: start,
      end: start.addingTimeInterval(3_600)
    )
    event.title = "Focus session"
    event.attendees = [
      .init(
        email: "orphan@example.com",
        displayName: "Orphan",
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      ),
      .init(
        email: "author@example.com",
        displayName: "Author",
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      ),
      .init(
        email: "referenced@example.com",
        displayName: "Referenced",
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      ),
      .init(
        email: "retained@example.com",
        displayName: "Retained",
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      ),
    ]
    try await fixture.repository.replaceCalendarProjection([event], provider: "eventkit")

    let orphanID = PageID.person(email: "orphan@example.com")
    let authorID = PageID.person(email: "author@example.com")
    let referencedID = PageID.person(email: "referenced@example.com")
    let retainedID = PageID.person(email: "retained@example.com")
    let backlinkTarget = try await fixture.repository.createFreePage(title: "Backlink target")
    let loadedAuthor = try await fixture.repository.page(id: authorID)
    let author = try XCTUnwrap(loadedAuthor)
    _ = try await fixture.repository.persistEditorCommit(
      try referenceCommit(from: author, to: backlinkTarget.id, label: "Target")
    )
    let referencingPage = try await fixture.repository.createFreePage(title: "Referencing page")
    _ = try await fixture.repository.persistEditorCommit(
      try referenceCommit(from: referencingPage, to: referencedID, label: "Referenced")
    )
    _ = try await fixture.repository.promotePerson(pageID: retainedID)
    _ = try await fixture.repository.movePersonToOther(pageID: retainedID)

    try await fixture.repository.setCalendarEventOmissionPrefixes(["Focus"])

    let orphan = try await fixture.repository.page(id: orphanID)
    let retainedAuthor = try await fixture.repository.page(id: authorID)
    let retainedReference = try await fixture.repository.page(id: referencedID)
    let retainedExplicitly = try await fixture.repository.page(id: retainedID)
    let defaultBacklinks = try await fixture.repository.backlinks(to: backlinkTarget.id)
    let inclusiveBacklinks = try await fixture.repository.backlinks(
      to: backlinkTarget.id,
      includeOthers: true
    )
    XCTAssertNil(orphan)
    XCTAssertNotNil(retainedAuthor)
    XCTAssertNotNil(retainedReference)
    XCTAssertNotNil(retainedExplicitly)
    XCTAssertTrue(defaultBacklinks.isEmpty)
    XCTAssertEqual(
      inclusiveBacklinks.map(\.id),
      [authorID]
    )
  }

  func testContactLinksRequireExactPersonEmailAndStayLocal() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(
      provider: "google",
      id: "contact",
      start: start,
      end: start.addingTimeInterval(3_600)
    )
    event.attendees = [
      CalendarAttendeeIdentity(
        email: "alice@example.com",
        displayName: "Alice",
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      )
    ]
    try await fixture.repository.replaceCalendarProjection([event], provider: "google")
    let personID = PageID.person(email: "alice@example.com")
    let persistedBeforeLink = try await fixture.repository.page(id: personID)
    let beforeLink = try XCTUnwrap(persistedBeforeLink)
    let record = DeviceContactRecord(
      identifier: "device-contact-1",
      displayName: "Alice Example",
      organizationName: "Example Ltd",
      jobTitle: "Engineer",
      emails: [" Alice@Example.com "],
      phoneNumbers: ["+44 20 0000 0000"],
      birthday: .init(month: 7, day: 28)
    )

    let link = try await fixture.repository.saveContactLink(
      record,
      for: personID,
      matchedEmail: "ALICE@example.com"
    )
    let storedLink = try await fixture.repository.contactLink(for: personID)
    let candidates = try await fixture.repository.contactCandidates()
    let dirtyPages = try await fixture.repository.dirtyPages()
    let persistedPerson = try await fixture.repository.page(id: personID)
    let person = try XCTUnwrap(persistedPerson)

    XCTAssertEqual(link.matchedEmail, "alice@example.com")
    XCTAssertEqual(storedLink?.pageID, link.pageID)
    XCTAssertEqual(storedLink?.contactIdentifier, link.contactIdentifier)
    XCTAssertEqual(storedLink?.matchedEmail, link.matchedEmail)
    XCTAssertEqual(storedLink?.record, link.record)
    XCTAssertEqual(
      storedLink?.refreshedAt.timeIntervalSince1970 ?? 0,
      link.refreshedAt.timeIntervalSince1970,
      accuracy: 0.001
    )
    XCTAssertEqual(candidates.first?.pageID, personID)
    XCTAssertFalse(dirtyPages.contains { $0.id == personID })
    XCTAssertEqual(person.title, beforeLink.title)
    XCTAssertEqual(person.heads, beforeLink.heads)
    XCTAssertEqual(person.dirtyGeneration, beforeLink.dirtyGeneration)
    XCTAssertEqual(person.effectivePersonVisibility, .other)
    let cloudEligibleAfterLink = try await fixture.repository.cloudEligiblePage(pageID: personID)
    XCTAssertNil(cloudEligibleAfterLink)
    await XCTAssertThrowsErrorAsync {
      _ = try await fixture.repository.saveContactLink(
        record,
        for: personID,
        matchedEmail: "somebody-else@example.com"
      )
    }
  }

  @MainActor
  func testStoreContactRefreshEnrichesExactMatchesRemovesStaleLinksAndNeverPromotes() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(
      provider: "eventkit",
      id: "store-contact",
      start: start,
      end: start.addingTimeInterval(3_600)
    )
    event.attendees = [
      CalendarAttendeeIdentity(
        email: "person@example.com",
        displayName: "Event Person",
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      )
    ]
    try await fixture.repository.replaceCalendarProjection([event], provider: "eventkit")
    let personID = PageID.person(email: "person@example.com")
    let resolver = StubContactResolver(contacts: [
      "person@example.com": DeviceContactRecord(
        identifier: "device-person",
        displayName: "Device Person",
        emails: ["person@example.com"]
      )
    ])
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    await store.reload()
    let titleBeforeRefresh = try XCTUnwrap(store.page(id: personID)).title
    let headsBeforeRefresh = try XCTUnwrap(store.page(id: personID)).heads

    await store.refreshContactEnrichment(using: resolver)

    XCTAssertEqual(store.contactLinks[personID]?.record.displayName, "Device Person")
    XCTAssertEqual(store.otherPeople.first { $0.id == personID }?.effectivePersonVisibility, .other)
    XCTAssertFalse(store.pages.contains { $0.id == personID })
    XCTAssertEqual(store.otherPeople.first { $0.id == personID }?.title, titleBeforeRefresh)
    XCTAssertEqual(store.otherPeople.first { $0.id == personID }?.heads, headsBeforeRefresh)
    let cloudEligibleAfterRefresh = try await fixture.repository.cloudEligiblePage(pageID: personID)
    XCTAssertNil(cloudEligibleAfterRefresh)

    let emptyResolver = StubContactResolver(contacts: [:])
    await store.refreshContactEnrichment(using: emptyResolver)
    XCTAssertNil(store.contactLinks[personID])
  }

  @MainActor
  func testContactAuthorizationRevocationPurgesPersistedAndInMemoryPII() async throws {
    let fixture = try RepositoryFixture()
    let personID = try await projectContactPerson(
      email: "revoked@example.com",
      eventID: "contact-revoke",
      repository: fixture.repository
    )
    let record = DeviceContactRecord(
      identifier: "revoked-contact",
      displayName: "Revoked Person",
      emails: ["revoked@example.com"],
      phoneNumbers: ["+44 20 0000 0000"]
    )
    _ = try await fixture.repository.saveContactLink(
      record,
      for: personID,
      matchedEmail: "revoked@example.com"
    )
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    await store.reload()
    XCTAssertNotNil(store.contactLinks[personID])

    await store.deviceContactsAuthorizationDidChange(.denied)

    XCTAssertTrue(store.contactLinks.isEmpty)
    let persistedLinks = try await fixture.repository.contactLinks()
    XCTAssertTrue(persistedLinks.isEmpty)
  }

  @MainActor
  func testLimitedContactRefreshRemovesRecordsNoLongerAvailable() async throws {
    let fixture = try RepositoryFixture()
    let retainedID = try await projectContactPerson(
      email: "visible@example.com",
      eventID: "contact-limited-visible",
      repository: fixture.repository
    )
    let removedID = try await projectContactPerson(
      email: "hidden@example.com",
      eventID: "contact-limited-hidden",
      repository: fixture.repository
    )
    let fullResolver = StubContactResolver(contacts: [
      "visible@example.com": .init(
        identifier: "visible-contact",
        displayName: "Visible",
        emails: ["visible@example.com"]
      ),
      "hidden@example.com": .init(
        identifier: "hidden-contact",
        displayName: "Hidden",
        emails: ["hidden@example.com"]
      ),
    ])
    let store = LibraryStore(
      repository: fixture.repository,
      contactResolver: fullResolver,
      startImmediately: false
    )
    await store.reload()
    await store.deviceContactsAuthorizationDidChange(.authorized)
    XCTAssertEqual(Set(store.contactLinks.keys), [retainedID, removedID])

    store.configureDeviceContactResolver(
      StubContactResolver(contacts: [
        "visible@example.com": .init(
          identifier: "visible-contact",
          displayName: "Visible",
          emails: ["visible@example.com"]
        )
      ])
    )
    await store.deviceContactsAuthorizationDidChange(.limited)

    XCTAssertEqual(Set(store.contactLinks.keys), [retainedID])
    let persistedLinks = try await fixture.repository.contactLinks()
    XCTAssertEqual(persistedLinks.map(\.pageID), [retainedID])
  }

  @MainActor
  func testManualContactSelectionRefreshesByIdentifierDespiteAmbiguousEmail() async throws {
    let fixture = try RepositoryFixture()
    let personID = try await projectContactPerson(
      email: "shared@example.com",
      eventID: "contact-manual-selection",
      repository: fixture.repository
    )
    let selected = DeviceContactRecord(
      identifier: "selected-contact",
      displayName: "Selected",
      emails: ["shared@example.com"]
    )
    _ = try await fixture.repository.saveContactLink(
      selected,
      for: personID,
      matchedEmail: "shared@example.com"
    )
    let refreshed = DeviceContactRecord(
      identifier: "selected-contact",
      displayName: "Selected Updated",
      emails: ["shared@example.com"]
    )
    let store = LibraryStore(
      repository: fixture.repository,
      contactResolver: IdentifierOnlyContactResolver(contacts: [refreshed]),
      startImmediately: false
    )
    await store.reload()

    await store.deviceContactsAuthorizationDidChange(.limited)
    XCTAssertEqual(store.contactLinks[personID]?.record.displayName, "Selected Updated")

    store.configureDeviceContactResolver(IdentifierOnlyContactResolver(contacts: []))
    await store.deviceContactsAuthorizationDidChange(.limited)
    XCTAssertNil(store.contactLinks[personID])
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
    let opened = try await projected.asyncMap {
      try await fixture.repository.calendarEventPages(for: $0)
    }

    XCTAssertEqual(Set(projected.compactMap { $0.identity.series?.canonicalKey }).count, 1)
    XCTAssertEqual(Set(opened.map(\.occurrence.id)).count, 1)
    XCTAssertEqual(Set(opened.compactMap { $0.series?.id }).count, 1)
  }

  func testLegacyOccurrencePageIsReusedWhenSeriesMetadataArrives() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    let legacy = calendarEvent(
      provider: "eventkit", id: "legacy", start: start, end: start.addingTimeInterval(3_600))
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

  func testTaggedPageReferenceInsertionCommitsSourceTargetReferencesAndDirtyState() async throws {
    let fixture = try RepositoryFixture()
    let source = try await fixture.repository.createFreePage(title: "Meeting notes")
    let request = try taggedPageReferenceRequest(source: source)

    let result = try await fixture.repository.createTaggedPageAndPersistReference(request)
    let persistedSource = try await fixture.repository.page(id: source.id)
    let persistedTarget = try await fixture.repository.page(id: request.targetPageID)
    let backlinks = try await fixture.repository.backlinks(to: request.targetPageID)
    let dirtyIDs = Set(try await fixture.repository.dirtyPages().map(\.id))

    XCTAssertEqual(result.source.id, source.id)
    XCTAssertEqual(result.target.id, request.targetPageID)
    XCTAssertEqual(persistedSource?.heads, result.source.heads)
    XCTAssertTrue(persistedTarget?.hasSupertag(request.supertagID) == true)
    XCTAssertEqual(backlinks.map(\.id), [source.id])
    XCTAssertTrue(dirtyIDs.isSuperset(of: [source.id, request.targetPageID]))
  }

  func testTaggedPageReferenceInsertionRejectsStaleAndDeletedSourcesWithoutPartialTarget() async throws {
    let fixture = try RepositoryFixture()
    let source = try await fixture.repository.createFreePage(title: "Source")
    let staleRequest = try taggedPageReferenceRequest(source: source)
    _ = try await fixture.repository.persistRichTextEditor(
      pageID: source.id,
      title: "Changed",
      body: AttributedString("New content")
    )

    try await assertTaggedPageReferenceInsertionError(
      .sourceStale,
      repository: fixture.repository,
      request: staleRequest
    )
    try await assertNoPartialTaggedPageInsertion(
      repository: fixture.repository,
      sourceID: source.id,
      targetID: staleRequest.targetPageID
    )

    let currentSnapshot = try await fixture.repository.page(id: source.id)
    let current = try XCTUnwrap(currentSnapshot)
    let deletedRequest = try taggedPageReferenceRequest(source: current)
    try await fixture.repository.moveToTrash(pageID: source.id)

    try await assertTaggedPageReferenceInsertionError(
      .sourceDeleted,
      repository: fixture.repository,
      request: deletedRequest
    )
    try await assertNoPartialTaggedPageInsertion(
      repository: fixture.repository,
      sourceID: source.id,
      targetID: deletedRequest.targetPageID
    )
  }

  func testTaggedPageReferenceInsertionRejectsInvalidAndDeletedSupertagsWithoutPartialTarget() async throws {
    let fixture = try RepositoryFixture()
    let source = try await fixture.repository.createFreePage(title: "Source")
    let invalidRequest = try taggedPageReferenceRequest(
      source: source,
      supertagID: .init(rawValue: "missing-tag")
    )

    try await assertTaggedPageReferenceInsertionError(
      .invalidSupertag,
      repository: fixture.repository,
      request: invalidRequest
    )
    try await assertNoPartialTaggedPageInsertion(
      repository: fixture.repository,
      sourceID: source.id,
      targetID: invalidRequest.targetPageID
    )

    var deletedTag = SupertagDefinition.draft(name: "Deleted tag")
    deletedTag.isDeleted = true
    try await fixture.repository.saveSupertag(deletedTag)
    let deletedRequest = try taggedPageReferenceRequest(source: source, supertagID: deletedTag.id)

    try await assertTaggedPageReferenceInsertionError(
      .invalidSupertag,
      repository: fixture.repository,
      request: deletedRequest
    )
    try await assertNoPartialTaggedPageInsertion(
      repository: fixture.repository,
      sourceID: source.id,
      targetID: deletedRequest.targetPageID
    )
  }

  func testTaggedPageReferenceInsertionRejectsOccupiedAndPurgedTargetIDsWithoutPartialReference() async throws {
    let fixture = try RepositoryFixture()
    let source = try await fixture.repository.createFreePage(title: "Source")
    let occupied = try await fixture.repository.createFreePage(title: "Existing target")
    let occupiedRequest = try taggedPageReferenceRequest(source: source, targetID: occupied.id)

    try await assertTaggedPageReferenceInsertionError(
      .targetOccupied,
      repository: fixture.repository,
      request: occupiedRequest
    )
    let occupiedBacklinks = try await fixture.repository.backlinks(to: occupied.id)
    XCTAssertTrue(occupiedBacklinks.isEmpty)

    let purged = try await fixture.repository.createFreePage(title: "Purged target")
    try await fixture.repository.moveToTrash(pageID: purged.id)
    try await fixture.repository.purge(pageID: purged.id)
    let purgedRequest = try taggedPageReferenceRequest(source: source, targetID: purged.id)

    try await assertTaggedPageReferenceInsertionError(
      .targetPurged,
      repository: fixture.repository,
      request: purgedRequest
    )
    let purgedBacklinks = try await fixture.repository.backlinks(to: purged.id)
    XCTAssertTrue(purgedBacklinks.isEmpty)
  }

  func testTaggedPageReferenceInsertionRejectsMissingCandidateReferenceWithoutPartialTarget() async throws {
    let fixture = try RepositoryFixture()
    let source = try await fixture.repository.createFreePage(title: "Source")
    let request = try taggedPageReferenceRequest(source: source, includesReference: false)

    try await assertTaggedPageReferenceInsertionError(
      .missingTargetReference,
      repository: fixture.repository,
      request: request
    )
    try await assertNoPartialTaggedPageInsertion(
      repository: fixture.repository,
      sourceID: source.id,
      targetID: request.targetPageID
    )
  }

  func testTaggedPageReferenceInsertionPreservesPersonTagClassificationParity() async throws {
    let fixture = try RepositoryFixture()
    let source = try await fixture.repository.createFreePage(title: "Source")
    let request = try taggedPageReferenceRequest(source: source, supertagID: BuiltInSupertags.person)

    let result = try await fixture.repository.createTaggedPageAndPersistReference(request)

    XCTAssertTrue(result.target.hasSupertag(BuiltInSupertags.person))
    XCTAssertEqual(result.target.objectMetadata.personVisibility, .promoted)
    XCTAssertEqual(result.target.objectMetadata.personOrigin, .manual)
  }

  func testPersonEmailNormalizerRejectsMalformedValues() throws {
    XCTAssertEqual(
      try PersonEmail.normalize(" Marissa.Flanagan@Example.COM "),
      "marissa.flanagan@example.com"
    )
    XCTAssertEqual(
      DeviceContactRecord.normalizedEmail(" Marissa.Flanagan@Example.COM "),
      "marissa.flanagan@example.com"
    )
    for value in ["", "marissa", "@example.com", "marissa@", "a@@example.com", "a @example.com"] {
      XCTAssertThrowsError(try PersonEmail.normalize(value)) { error in
        XCTAssertEqual(error as? PersonEmailValidationError, .invalid(value))
      }
    }
  }

  func testPersonEmailPropertyWriteNormalizesAndRejectsInvalidValues() async throws {
    let fixture = try RepositoryFixture()
    let person = try await fixture.repository.createTaggedPage(
      title: "Marissa Flanagan",
      supertagID: BuiltInSupertags.person
    )
    let key = personEmailKey

    try await fixture.repository.setProperty(
      pageID: person.id,
      key: key,
      values: [.email(" Marissa.Flanagan@Example.COM ")]
    )
    let normalized = try await fixture.repository.page(id: person.id)
    XCTAssertEqual(normalized?.objectMetadata.properties[key], [.email("marissa.flanagan@example.com")])

    await XCTAssertThrowsErrorAsync {
      try await fixture.repository.setProperty(
        pageID: person.id,
        key: key,
        values: [.email("not an email")]
      )
    }
    let unchanged = try await fixture.repository.page(id: person.id)
    XCTAssertEqual(
      unchanged?.objectMetadata.properties[key], [.email("marissa.flanagan@example.com")])
  }

  func testTaggedPersonInsertionSeedsNormalizedEmailAtomically() async throws {
    let fixture = try RepositoryFixture()
    let source = try await fixture.repository.createFreePage(title: "Source")
    let request = try taggedPageReferenceRequest(
      source: source,
      targetTitle: "Marissa Flanagan",
      supertagID: BuiltInSupertags.person,
      initialProperties: [personEmailKey: [.email(" Marissa@Example.COM ")]]
    )

    let result = try await fixture.repository.createTaggedPageAndPersistReference(request)

    XCTAssertEqual(result.target.title, "Marissa Flanagan")
    XCTAssertEqual(
      result.target.objectMetadata.properties[personEmailKey],
      [.email("marissa@example.com")]
    )
    let backlinks = try await fixture.repository.backlinks(to: result.target.id)
    XCTAssertEqual(backlinks.map(\.id), [source.id])
  }

  func testTaggedInsertionRejectsInvalidSeedAndMismatchedFallbackWithoutPartialState() async throws
  {
    let fixture = try RepositoryFixture()
    let source = try await fixture.repository.createFreePage(title: "Source")
    let invalidSeed = try taggedPageReferenceRequest(
      source: source,
      supertagID: BuiltInSupertags.person,
      initialProperties: [personEmailKey: [.email("invalid email")]]
    )

    try await assertTaggedPageReferenceInsertionError(
      .invalidInitialProperties,
      repository: fixture.repository,
      request: invalidSeed
    )
    try await assertNoPartialTaggedPageInsertion(
      repository: fixture.repository,
      sourceID: source.id,
      targetID: invalidSeed.targetPageID
    )

    let mismatchedFallback = try taggedPageReferenceRequest(
      source: source,
      targetTitle: "Marissa Flanagan",
      referenceLabel: "marissa@example.com"
    )
    try await assertTaggedPageReferenceInsertionError(
      .missingTargetReference,
      repository: fixture.repository,
      request: mismatchedFallback
    )
    try await assertNoPartialTaggedPageInsertion(
      repository: fixture.repository,
      sourceID: source.id,
      targetID: mismatchedFallback.targetPageID
    )
  }

  func testTaggedInsertionAcceptsInheritedSchemaFieldsWithOwningKey() async throws {
    let fixture = try RepositoryFixture()
    var parent = SupertagDefinition.draft(name: "Organization base")
    parent.fields = [.init(id: .init(rawValue: "website"), name: "Website", type: .url)]
    var child = SupertagDefinition.draft(name: "Company")
    child.parentIDs = [parent.id]
    try await fixture.repository.saveSupertag(parent)
    try await fixture.repository.saveSupertag(child)

    let source = try await fixture.repository.createFreePage(title: "Source")
    let inheritedKey = SupertagPropertyKey(
      supertagID: parent.id, fieldID: .init(rawValue: "website"))
    let request = try taggedPageReferenceRequest(
      source: source,
      supertagID: child.id,
      initialProperties: [inheritedKey: [.url("https://example.com")]]
    )

    let result = try await fixture.repository.createTaggedPageAndPersistReference(request)
    XCTAssertEqual(
      result.target.objectMetadata.properties[inheritedKey], [.url("https://example.com")])
  }

  func testPersonEmailLookupFindsLegacyCasingAndDoesNotMergeCandidates() async throws {
    let fixture = try RepositoryFixture()
    let first = try await fixture.repository.createTaggedPage(
      title: "Marissa Flanagan",
      supertagID: BuiltInSupertags.person
    )
    let second = try await fixture.repository.createTaggedPage(
      title: "Marissa Work",
      supertagID: BuiltInSupertags.person
    )
    let legacy = try PageDocument.setProperty(
      key: personEmailKey,
      values: [.email(" Marissa@Example.COM ")],
      in: first.document
    )
    let commit = EditorCommit(
      pageID: first.id,
      loadGeneration: 1,
      journalID: UUID().uuidString,
      baseHeads: first.heads,
      encodedChanges: try PageDocument.encodedChanges(from: legacy.document, since: first.heads),
      advertisedHeads: legacy.heads
    )
    _ = try await fixture.repository.persistEditorCommit(commit)
    try await fixture.repository.setProperty(
      pageID: second.id,
      key: personEmailKey,
      values: [.email("marissa@example.com")]
    )

    let candidates = try await fixture.repository.personEmailCandidates(
      matchingEmail: " Marissa@Example.COM "
    )

    XCTAssertEqual(candidates.map(\.pageID), [first.id, second.id])
    XCTAssertEqual(candidates.map(\.displayName), ["Marissa Flanagan", "Marissa Work"])
  }

  func testTaggedPersonInsertionRejectsAnEmailCreatedAfterLookupWithoutPartialState() async throws {
    let fixture = try RepositoryFixture()
    let source = try await fixture.repository.createFreePage(title: "Source")
    let existing = try await fixture.repository.createTaggedPage(
      title: "Marissa Flanagan",
      supertagID: BuiltInSupertags.person
    )
    try await fixture.repository.setProperty(
      pageID: existing.id,
      key: personEmailKey,
      values: [.email("marissa@example.com")]
    )
    let request = try taggedPageReferenceRequest(
      source: source,
      targetTitle: "Marissa New",
      supertagID: BuiltInSupertags.person,
      initialProperties: [personEmailKey: [.email("marissa@example.com")]]
    )

    try await assertTaggedPageReferenceInsertionError(
      .personEmailAlreadyExists,
      repository: fixture.repository,
      request: request
    )
    try await assertNoPartialTaggedPageInsertion(
      repository: fixture.repository,
      sourceID: source.id,
      targetID: request.targetPageID
    )
    let candidates = try await fixture.repository.personEmailCandidates(
      matchingEmail: "marissa@example.com"
    )
    XCTAssertEqual(candidates.map(\.pageID), [existing.id])
  }

  func testRenamePagePreservesRichBodyReferencesAndMarks() async throws {
    let fixture = try RepositoryFixture()
    let target = try await fixture.repository.createFreePage(title: "Reference target")
    let person = try await fixture.repository.createTaggedPage(
      title: "marissa@example.com",
      supertagID: BuiltInSupertags.person
    )
    var body = AttributedString("See reference")
    body[body.startIndex..<body.endIndex][PageRichTextAttributes.AutomergeMarks.self] = [
      try PageDocument.pageReferenceMark(to: target.id, label: "reference")
    ]
    let edited = try PageDocument.replaceRichText(
      title: person.title,
      body: body,
      in: person.document
    )
    let commit = EditorCommit(
      pageID: person.id,
      loadGeneration: 1,
      journalID: UUID().uuidString,
      baseHeads: person.heads,
      encodedChanges: try PageDocument.encodedChanges(from: edited.document, since: person.heads),
      advertisedHeads: edited.heads
    )
    _ = try await fixture.repository.persistEditorCommit(commit)

    let renamed = try await fixture.repository.renamePage(pageID: person.id, title: "Marissa Flanagan")
    let richText = try PageDocument.richText(in: renamed.document)
    let backlinks = try await fixture.repository.backlinks(to: target.id)

    XCTAssertEqual(renamed.title, "Marissa Flanagan")
    XCTAssertEqual(String(richText.body.characters), String(body.characters))
    XCTAssertTrue(renamed.objectMetadata.supertagIDs.contains(BuiltInSupertags.person))
    XCTAssertEqual(backlinks.map(\.id), [person.id])
  }

  @MainActor
  func testPersonDisplayNameUsesContactOnlyForLegacyTitleAndEmailChangesInvalidateLink() async throws {
    let fixture = try RepositoryFixture()
    let person = try await fixture.repository.createTaggedPage(
      title: "marissa@example.com",
      supertagID: BuiltInSupertags.person
    )
    try await fixture.repository.setProperty(
      pageID: person.id,
      key: personEmailKey,
      values: [.email("marissa@example.com")]
    )
    let contact = DeviceContactRecord(
      identifier: "marissa-contact",
      displayName: "Marissa Flanagan",
      emails: ["marissa@example.com"]
    )
    _ = try await fixture.repository.saveContactLink(
      contact,
      for: person.id,
      matchedEmail: "marissa@example.com"
    )
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    await store.reload()
    XCTAssertEqual(store.personDisplayName(for: try XCTUnwrap(store.page(id: person.id))), "Marissa Flanagan")

    _ = try await store.renamePage(pageID: person.id, title: "M. Flanagan")
    XCTAssertEqual(store.personDisplayName(for: try XCTUnwrap(store.page(id: person.id))), "M. Flanagan")

    try await fixture.repository.setProperty(
      pageID: person.id,
      key: personEmailKey,
      values: [.email("marissa.new@example.com")]
    )
    let contactLink = try await fixture.repository.contactLink(for: person.id)
    XCTAssertNil(contactLink)
    await store.reload()
    XCTAssertNil(store.contactLinks[person.id])
  }

  func testPersonDisplayNameUsesDurableTitleThenLocalContactThenCanonicalEmail() {
    let pageID = PageID(rawValue: "person-display-precedence")
    let namedContact = PersonContactLink(
      pageID: pageID,
      contactIdentifier: "contact",
      matchedEmail: "a@example.com",
      record: .init(
        identifier: "contact",
        displayName: "Marissa Antonia Flanagan",
        emails: ["a@example.com"]
      ),
      refreshedAt: .distantPast
    )
    let emptyContact = PersonContactLink(
      pageID: pageID,
      contactIdentifier: "empty-contact",
      matchedEmail: "a@example.com",
      record: .init(identifier: "empty-contact", displayName: "  ", emails: ["a@example.com"]),
      refreshedAt: .distantPast
    )
    let emails = [" Z@example.com ", "a@example.com", "A@example.com"]

    XCTAssertEqual(PersonDisplayName.canonicalEmail(from: emails), "a@example.com")
    XCTAssertEqual(PersonDisplayName.canonicalEmail(from: emails.reversed()), "a@example.com")
    XCTAssertTrue(
      PersonDisplayName.isSafeFallbackTitle(
        "z",
        emails: emails,
        origin: .calendarAttendee
      )
    )
    XCTAssertFalse(
      PersonDisplayName.isSafeFallbackTitle(
        "z",
        emails: emails,
        origin: .manual
      )
    )

    XCTAssertEqual(
      PersonDisplayName.resolved(
        title: "Marissa Flanagan",
        emails: emails,
        origin: .manual,
        contactLink: namedContact
      ),
      "Marissa Flanagan"
    )
    XCTAssertEqual(
      PersonDisplayName.resolved(
        title: "Z@example.com",
        emails: emails,
        origin: .manual,
        contactLink: namedContact
      ),
      "Marissa Antonia Flanagan"
    )
    XCTAssertEqual(
      PersonDisplayName.resolved(
        title: "Untitled",
        emails: emails,
        origin: .manual,
        contactLink: emptyContact
      ),
      "a@example.com"
    )
    XCTAssertEqual(
      PersonDisplayName.resolved(
        title: "marissa",
        emails: ["marissa@example.com"],
        origin: .calendarAttendee,
        contactLink: PersonContactLink(
          pageID: pageID,
          contactIdentifier: "marissa-contact",
          matchedEmail: "marissa@example.com",
          record: .init(
            identifier: "marissa-contact",
            displayName: "Marissa Antonia Flanagan",
            emails: ["marissa@example.com"]
          ),
          refreshedAt: .distantPast
        )
      ),
      "Marissa Antonia Flanagan"
    )
    XCTAssertEqual(
      PersonDisplayName.resolved(
        title: "marissa",
        emails: ["marissa@example.com"],
        origin: .manual,
        contactLink: PersonContactLink(
          pageID: pageID,
          contactIdentifier: "marissa-contact",
          matchedEmail: "marissa@example.com",
          record: .init(
            identifier: "marissa-contact",
            displayName: "Marissa Antonia Flanagan",
            emails: ["marissa@example.com"]
          ),
          refreshedAt: .distantPast
        )
      ),
      "marissa"
    )
  }

  @MainActor
  func testExplicitContactNameAdoptionPersistsOnlySafeTitlesAndRefreshCannotOverwriteIt() async throws {
    let fixture = try RepositoryFixture()
    let person = try await fixture.repository.createTaggedPage(
      title: "marissa@example.com",
      supertagID: BuiltInSupertags.person
    )
    try await fixture.repository.setProperty(
      pageID: person.id,
      key: personEmailKey,
      values: [.email("marissa@example.com")]
    )
    let persistedInitial = try await fixture.repository.page(id: person.id)
    let initial = try XCTUnwrap(persistedInitial)
    _ = try await fixture.repository.markCloudSaved(
      pageID: person.id,
      sentGeneration: initial.dirtyGeneration,
      systemFields: Data()
    )
    let contact = DeviceContactRecord(
      identifier: "marissa-contact",
      displayName: "Marissa Antonia Flanagan",
      emails: ["marissa@example.com"]
    )
    _ = try await fixture.repository.saveContactLink(
      contact,
      for: person.id,
      matchedEmail: "marissa@example.com"
    )
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    await store.reload()

    let outcome = try await store.adoptLinkedContactName(pageID: person.id)
    guard case .adopted(let adopted) = outcome else {
      return XCTFail("Expected the explicitly selected contact name to be adopted")
    }
    XCTAssertEqual(adopted.title, "Marissa Antonia Flanagan")
    XCTAssertEqual(store.page(id: person.id)?.title, "Marissa Antonia Flanagan")
    XCTAssertEqual(adopted.effectivePersonVisibility, .promoted)
    let cloudEligible = try await fixture.repository.cloudEligiblePage(pageID: person.id)
    XCTAssertEqual(cloudEligible?.id, person.id)
    let dirtyPages = try await fixture.repository.dirtyPages()
    XCTAssertTrue(dirtyPages.contains { $0.id == person.id })

    await store.refreshContactEnrichment(using: StubContactResolver(contacts: [:]))
    XCTAssertEqual(store.page(id: person.id)?.title, "Marissa Antonia Flanagan")
    XCTAssertNil(store.contactLinks[person.id])
  }

  @MainActor
  func testContactNameAdoptionNeverOverwritesAnAuthoredOrManualLocalPartTitle() async throws {
    let fixture = try RepositoryFixture()
    let person = try await fixture.repository.createTaggedPage(
      title: "marissa",
      supertagID: BuiltInSupertags.person
    )
    try await fixture.repository.setProperty(
      pageID: person.id,
      key: personEmailKey,
      values: [.email("marissa@example.com")]
    )
    _ = try await fixture.repository.saveContactLink(
      .init(
        identifier: "marissa-contact",
        displayName: "Marissa Antonia Flanagan",
        emails: ["marissa@example.com"]
      ),
      for: person.id,
      matchedEmail: "marissa@example.com"
    )
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    await store.reload()
    let original = try XCTUnwrap(store.page(id: person.id))

    let outcome = try await store.adoptLinkedContactName(pageID: person.id)
    guard case .unchanged(let unchanged) = outcome else {
      return XCTFail("A manual local-part title is authored data")
    }
    XCTAssertEqual(unchanged.title, "marissa")
    XCTAssertEqual(unchanged.heads, original.heads)
    XCTAssertEqual(store.page(id: person.id)?.title, "marissa")
  }

  @MainActor
  func testLegacyCalendarLocalPartTitleCanExplicitlyAdoptLinkedContactName() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(
      provider: "eventkit",
      id: "legacy-local-part-attendee",
      start: start,
      end: start.addingTimeInterval(3_600)
    )
    event.attendees = [
      .init(
        email: "marissa@example.com",
        displayName: nil,
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      )
    ]
    try await fixture.repository.replaceCalendarProjection([event], provider: "eventkit")

    let personID = PageID.person(email: "marissa@example.com")
    _ = try await fixture.repository.renamePage(pageID: personID, title: "marissa")
    _ = try await fixture.repository.saveContactLink(
      .init(
        identifier: "marissa-contact",
        displayName: "Marissa Antonia Flanagan",
        emails: ["marissa@example.com"]
      ),
      for: personID,
      matchedEmail: "marissa@example.com"
    )
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    await store.reload()

    let outcome = try await store.adoptLinkedContactName(pageID: personID)
    guard case .adopted(let adopted) = outcome else {
      return XCTFail("Expected a legacy calendar local-part title to be explicitly adoptable")
    }
    XCTAssertEqual(adopted.title, "Marissa Antonia Flanagan")
    XCTAssertEqual(store.page(id: personID)?.effectivePersonVisibility, .promoted)
    XCTAssertTrue(store.pages.contains { $0.id == personID })
    XCTAssertFalse(store.otherPeople.contains { $0.id == personID })
    let cloudEligible = try await fixture.repository.cloudEligiblePage(pageID: personID)
    XCTAssertEqual(cloudEligible?.id, personID)
  }

  @MainActor
  func testLegacyCalendarNoncanonicalEmailLocalPartCanAdoptButManualCannot() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(
      provider: "eventkit",
      id: "legacy-noncanonical-local-part",
      start: start,
      end: start.addingTimeInterval(3_600)
    )
    event.attendees = [
      .init(
        email: "z@example.com",
        displayName: nil,
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      )
    ]
    try await fixture.repository.replaceCalendarProjection([event], provider: "eventkit")

    let calendarPersonID = PageID.person(email: "z@example.com")
    try await fixture.repository.setProperty(
      pageID: calendarPersonID,
      key: personEmailKey,
      values: [.email("z@example.com"), .email("a@example.com")]
    )
    _ = try await fixture.repository.renamePage(pageID: calendarPersonID, title: "z")
    _ = try await fixture.repository.saveContactLink(
      .init(
        identifier: "z-contact",
        displayName: "Zoe Example",
        emails: ["z@example.com"]
      ),
      for: calendarPersonID,
      matchedEmail: "z@example.com"
    )

    let manualPerson = try await fixture.repository.createTaggedPage(
      title: "z",
      supertagID: BuiltInSupertags.person
    )
    try await fixture.repository.setProperty(
      pageID: manualPerson.id,
      key: personEmailKey,
      values: [.email("z@example.com"), .email("a@example.com")]
    )
    _ = try await fixture.repository.saveContactLink(
      .init(
        identifier: "manual-z-contact",
        displayName: "Zoe Example",
        emails: ["z@example.com"]
      ),
      for: manualPerson.id,
      matchedEmail: "z@example.com"
    )
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    await store.reload()

    let calendarOutcome = try await store.adoptLinkedContactName(pageID: calendarPersonID)
    guard case .adopted(let calendarPerson) = calendarOutcome else {
      return XCTFail("A legacy local part from any Person email is adoptable")
    }
    XCTAssertEqual(calendarPerson.title, "Zoe Example")

    let manualOutcome = try await store.adoptLinkedContactName(pageID: manualPerson.id)
    guard case .unchanged(let unchangedManual) = manualOutcome else {
      return XCTFail("A manual local part remains authored data")
    }
    XCTAssertEqual(unchangedManual.title, "z")
  }

  @MainActor
  func testUnavailableContactNameAdoptionLeavesPageAndCloudStateUnchanged() async throws {
    let fixture = try RepositoryFixture()
    let person = try await fixture.repository.createTaggedPage(
      title: "marissa@example.com",
      supertagID: BuiltInSupertags.person
    )
    try await fixture.repository.setProperty(
      pageID: person.id,
      key: personEmailKey,
      values: [.email("marissa@example.com")]
    )
    let storedPerson = try await fixture.repository.page(id: person.id)
    let persisted = try XCTUnwrap(storedPerson)
    _ = try await fixture.repository.markCloudSaved(
      pageID: person.id,
      sentGeneration: persisted.dirtyGeneration,
      systemFields: Data()
    )
    let cloudEligibleBefore = try await fixture.repository.cloudEligiblePage(pageID: person.id)
    let dirtyIDsBefore = Set(try await fixture.repository.dirtyPages().map(\.id))
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    await store.reload()

    let outcome = try await store.adoptLinkedContactName(pageID: person.id)
    guard case .unavailable = outcome else {
      return XCTFail("A Person without a linked contact has no adoption action")
    }
    let storedUnchanged = try await fixture.repository.page(id: person.id)
    let unchanged = try XCTUnwrap(storedUnchanged)
    XCTAssertEqual(unchanged.title, persisted.title)
    XCTAssertEqual(unchanged.heads, persisted.heads)
    XCTAssertEqual(unchanged.dirtyGeneration, persisted.dirtyGeneration)
    let cloudEligible = try await fixture.repository.cloudEligiblePage(pageID: person.id)
    let dirtyIDsAfter = Set(try await fixture.repository.dirtyPages().map(\.id))
    XCTAssertEqual(cloudEligible?.id, cloudEligibleBefore?.id)
    XCTAssertEqual(dirtyIDsAfter, dirtyIDsBefore)
    XCTAssertEqual(store.page(id: person.id)?.title, persisted.title)
  }

  @MainActor
  func testSameTitleContactAdoptionLeavesCalendarPersonLocalAndUnchanged() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(
      provider: "eventkit",
      id: "same-title-contact-adoption",
      start: start,
      end: start.addingTimeInterval(3_600)
    )
    event.attendees = [
      .init(
        email: "marissa@example.com",
        displayName: nil,
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      )
    ]
    try await fixture.repository.replaceCalendarProjection([event], provider: "eventkit")

    let personID = PageID.person(email: "marissa@example.com")
    let storedBeforeLink = try await fixture.repository.page(id: personID)
    let beforeLink = try XCTUnwrap(storedBeforeLink)
    let dirtyIDsBefore = Set(try await fixture.repository.dirtyPages().map(\.id))
    _ = try await fixture.repository.saveContactLink(
      .init(
        identifier: "same-title-contact",
        displayName: "marissa@example.com",
        emails: ["marissa@example.com"]
      ),
      for: personID,
      matchedEmail: "marissa@example.com"
    )
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    await store.reload()

    let outcome = try await store.adoptLinkedContactName(pageID: personID)
    guard case .unchanged(let unchanged) = outcome else {
      return XCTFail("A contact name already equal to the title must not promote or sync")
    }
    let storedAfter = try await fixture.repository.page(id: personID)
    let after = try XCTUnwrap(storedAfter)
    let dirtyIDsAfter = Set(try await fixture.repository.dirtyPages().map(\.id))
    let cloudEligibleAfter = try await fixture.repository.cloudEligiblePage(pageID: personID)
    XCTAssertEqual(unchanged.title, beforeLink.title)
    XCTAssertEqual(after.heads, beforeLink.heads)
    XCTAssertEqual(after.dirtyGeneration, beforeLink.dirtyGeneration)
    XCTAssertEqual(after.effectivePersonVisibility, .other)
    XCTAssertEqual(dirtyIDsAfter, dirtyIDsBefore)
    XCTAssertNil(cloudEligibleAfter)
    XCTAssertTrue(store.otherPeople.contains { $0.id == personID })
    XCTAssertFalse(store.pages.contains { $0.id == personID })
  }

  @MainActor
  func testUnchangedAdoptionReconcilesStoreUsingCurrentPersonClassification() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(
      provider: "eventkit",
      id: "stale-person-classification",
      start: start,
      end: start.addingTimeInterval(3_600)
    )
    event.attendees = [
      .init(
        email: "marissa@example.com",
        displayName: nil,
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      )
    ]
    try await fixture.repository.replaceCalendarProjection([event], provider: "eventkit")

    let personID = PageID.person(email: "marissa@example.com")
    _ = try await fixture.repository.renamePage(pageID: personID, title: "Marissa Flanagan")
    _ = try await fixture.repository.saveContactLink(
      .init(
        identifier: "stale-classification-contact",
        displayName: "Marissa Antonia Flanagan",
        emails: ["marissa@example.com"]
      ),
      for: personID,
      matchedEmail: "marissa@example.com"
    )
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    await store.reload()
    XCTAssertTrue(store.otherPeople.contains { $0.id == personID })

    _ = try await fixture.repository.promotePerson(pageID: personID)
    let outcome = try await store.adoptLinkedContactName(pageID: personID)
    guard case .unchanged(let unchanged) = outcome else {
      return XCTFail("An authored title must remain unchanged after a concurrent promotion")
    }
    XCTAssertEqual(unchanged.effectivePersonVisibility, .promoted)
    XCTAssertTrue(store.pages.contains { $0.id == personID })
    XCTAssertFalse(store.otherPeople.contains { $0.id == personID })
  }

  func testCalendarAttendeeWithoutNameUsesFullCanonicalEmail() async throws {
    let fixture = try RepositoryFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(
      provider: "eventkit",
      id: "unnamed-attendee",
      start: start,
      end: start.addingTimeInterval(3_600)
    )
    event.attendees = [
      .init(
        email: " Marissa@Example.com ",
        displayName: nil,
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      )
    ]

    try await fixture.repository.replaceCalendarProjection([event], provider: "eventkit")

    let person = try await fixture.repository.page(id: .person(email: "marissa@example.com"))
    XCTAssertEqual(person?.title, "marissa@example.com")
  }

  @MainActor
  func testStoreTaggedPageReferenceInsertionPreservesSelectionAndCachesBothPages() async throws {
    let fixture = try RepositoryFixture()
    let source = try await fixture.repository.createFreePage(title: "Source")
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    await store.reload(policy: .refreshOnly)
    store.selectedPageID = source.id
    let request = try taggedPageReferenceRequest(source: source)

    let result = try await store.createTaggedPageAndPersistReference(request)
    let dirtyIDs = Set(try await fixture.repository.dirtyPages().map(\.id))

    XCTAssertEqual(store.selectedPageID, source.id)
    XCTAssertEqual(store.page(id: source.id)?.heads, result.source.heads)
    XCTAssertEqual(store.page(id: request.targetPageID)?.heads, result.target.heads)
    XCTAssertTrue(dirtyIDs.isSuperset(of: [source.id, request.targetPageID]))
  }

  private var personEmailKey: SupertagPropertyKey {
    .init(supertagID: BuiltInSupertags.person, fieldID: .init(rawValue: "email"))
  }

  private func taggedPageReferenceRequest(
    source: PageSnapshot,
    targetID: PageID = .free(),
    targetTitle: String = "Project Aurora",
    supertagID: SupertagID = BuiltInSupertags.project,
    includesReference: Bool = true,
    referenceLabel: String? = nil,
    initialProperties: [SupertagPropertyKey: [SupertagValue]] = [:]
  ) throws -> TaggedPageReferenceInsertionRequest {
    let label = referenceLabel ?? targetTitle
    var body = AttributedString(includesReference ? label : "No reference")
    if includesReference {
      body[body.startIndex..<body.endIndex][PageRichTextAttributes.AutomergeMarks.self] = [
        try PageDocument.pageReferenceMark(to: targetID, label: label)
      ]
    }
    return TaggedPageReferenceInsertionRequest(
      sourcePageID: source.id,
      expectedSourceHeads: source.heads,
      sourceTitle: source.title,
      sourceBody: body,
      targetPageID: targetID,
      targetTitle: targetTitle,
      supertagID: supertagID,
      initialProperties: initialProperties
    )
  }

  private func assertTaggedPageReferenceInsertionError(
    _ expected: TaggedPageReferenceInsertionError,
    repository: LibraryRepository,
    request: TaggedPageReferenceInsertionRequest
  ) async throws {
    do {
      _ = try await repository.createTaggedPageAndPersistReference(request)
      XCTFail("Expected \(expected)")
    } catch let actual as TaggedPageReferenceInsertionError {
      XCTAssertEqual(actual, expected)
    }
  }

  private func assertNoPartialTaggedPageInsertion(
    repository: LibraryRepository,
    sourceID: PageID,
    targetID: PageID
  ) async throws {
    let target = try await repository.page(id: targetID)
    let backlinks = try await repository.backlinks(to: targetID)
    let dirtyPages = try await repository.dirtyPages()
    let source = try await repository.page(id: sourceID)
    XCTAssertNil(target)
    XCTAssertTrue(backlinks.isEmpty)
    XCTAssertFalse(dirtyPages.contains { $0.id == targetID })
    XCTAssertNotNil(source)
  }

  private func referenceCommit(
    from page: PageSnapshot,
    to targetPageID: PageID,
    label: String
  ) throws -> EditorCommit {
    let document = try Document(page.document)
    guard case .Object(let body, .Text)? = try document.get(obj: .ROOT, key: "body") else {
      throw PageDocumentError.invalidSchema
    }
    let current = try document.text(obj: body)
    try document.spliceText(
      obj: body,
      start: 0,
      delete: Int64(current.unicodeScalars.count),
      value: label
    )
    let payload = try JSONEncoder().encode(
      ReferenceMarkPayload(pageID: targetPageID.rawValue, label: label)
    )
    try document.mark(
      obj: body,
      start: 0,
      end: UInt64(label.unicodeScalars.count),
      expand: .none,
      name: PageDocument.pageReferenceMark,
      value: .String(String(decoding: payload, as: UTF8.self))
    )
    document.commitWith(message: "Reference page", timestamp: Date())
    let updatedDocument = document.save()
    return EditorCommit(
      pageID: page.id,
      loadGeneration: 1,
      journalID: "reference-\(UUID().uuidString)",
      baseHeads: page.heads,
      encodedChanges: try PageDocument.encodedChanges(
        from: updatedDocument,
        since: page.heads
      ),
      advertisedHeads: AutomergeHeads(try Document(updatedDocument).heads().map(\.debugDescription))
    )
  }

  @MainActor
  func testEntityRelationshipPersonResolutionRequiresExplicitLinkOnlyChoice() async throws {
    let fixture = try RepositoryFixture()
    let email = "ada@example.com"
    let first = try await fixture.repository.createTaggedPage(
      title: "Ada One", supertagID: BuiltInSupertags.person
    )
    let second = try await fixture.repository.createTaggedPage(
      title: "Ada Two", supertagID: BuiltInSupertags.person
    )
    for person in [first, second] {
      try await fixture.repository.setProperty(pageID: person.id, key: personEmailKey, values: [.email(email)])
    }
    let organization = try await fixture.repository.createTaggedPage(
      title: "Acme", supertagID: BuiltInSupertags.organization
    )
    let intent = try await fixture.repository.relationshipAuthoringIntent(
      relationID: BuiltInRelations.personOrganization,
      presentedSourceID: organization.id,
      direction: .inverse
    )
    let request = CreateEntityAndRelationshipRequest(
      intent: intent,
      selectedTargetTypeID: BuiltInSupertags.person,
      title: "Ada",
      initialProperties: [personEmailKey: [.email(" ADA@EXAMPLE.COM ")]]
    )

    do {
      _ = try await fixture.repository.createEntityAndRelationship(request)
      XCTFail("Expected explicit Person selection")
    } catch {
      XCTAssertEqual(error as? GraphRelationshipAuthoringError, .personSelectionRequired)
    }
    let resolved = try await fixture.repository.createEntityAndRelationship(
      .init(
        intent: intent,
        selectedTargetTypeID: BuiltInSupertags.person,
        title: "",
        existingPersonResolution: .useExistingMatchingEmail(
          pageID: second.id,
          matchingEmail: email
        )
      )
    )
    XCTAssertEqual(resolved.entity.id, second.id)

    let calendarEmail = "calendar@example.com"
    _ = try await projectContactPerson(
      email: calendarEmail, eventID: "calendar-adoption", repository: fixture.repository
    )
    let calendarPersonID = PageID.person(email: calendarEmail)
    let manualCalendarPerson = try await fixture.repository.createTaggedPage(
      title: "Manual Calendar Ada", supertagID: BuiltInSupertags.person
    )
    try await fixture.repository.setProperty(
      pageID: manualCalendarPerson.id,
      key: personEmailKey,
      values: [.email(calendarEmail)]
    )
    let secondOrganization = try await fixture.repository.createTaggedPage(
      title: "Calendar Acme", supertagID: BuiltInSupertags.organization
    )
    let calendarIntent = try await fixture.repository.relationshipAuthoringIntent(
      relationID: BuiltInRelations.personOrganization,
      presentedSourceID: secondOrganization.id,
      direction: .inverse
    )
    let explicitlyManual = try await fixture.repository.createEntityAndRelationship(
      .init(
        intent: calendarIntent,
        selectedTargetTypeID: BuiltInSupertags.person,
        title: "",
        existingPersonResolution: .useExistingMatchingEmail(
          pageID: manualCalendarPerson.id,
          matchingEmail: calendarEmail
        )
      )
    )
    XCTAssertEqual(explicitlyManual.entity.id, manualCalendarPerson.id)
    let calendarPersonAfterManualChoice = try await fixture.repository.page(id: calendarPersonID)
    XCTAssertEqual(
      calendarPersonAfterManualChoice?.effectivePersonVisibility,
      .other
    )

    let explicitCalendarEmail = "explicit-calendar@example.com"
    _ = try await projectContactPerson(
      email: explicitCalendarEmail,
      eventID: "explicit-calendar-choice",
      repository: fixture.repository
    )
    let explicitCalendarPersonID = PageID.person(email: explicitCalendarEmail)
    let explicitCalendarOrganization = try await fixture.repository.createTaggedPage(
      title: "Explicit Calendar Acme", supertagID: BuiltInSupertags.organization
    )
    let explicitCalendarIntent = try await fixture.repository.relationshipAuthoringIntent(
      relationID: BuiltInRelations.personOrganization,
      presentedSourceID: explicitCalendarOrganization.id,
      direction: .inverse
    )
    let explicitlyCalendar = try await fixture.repository.createEntityAndRelationship(
      .init(
        intent: explicitCalendarIntent,
        selectedTargetTypeID: BuiltInSupertags.person,
        title: "",
        existingPersonResolution: .useExistingMatchingEmail(
          pageID: explicitCalendarPersonID,
          matchingEmail: explicitCalendarEmail
        )
      )
    )
    XCTAssertEqual(explicitlyCalendar.entity.id, explicitCalendarPersonID)
    let calendarPersonAfterCalendarChoice = try await fixture.repository.page(id: explicitCalendarPersonID)
    XCTAssertEqual(
      calendarPersonAfterCalendarChoice?.effectivePersonVisibility,
      .other
    )

    do {
      _ = try await fixture.repository.createEntityAndRelationship(
        .init(
          intent: calendarIntent,
          selectedTargetTypeID: BuiltInSupertags.person,
          title: "Ambiguous calendar person",
          initialProperties: [personEmailKey: [.email(calendarEmail)]]
        )
      )
      XCTFail("Expected a calendar/manual collision to require explicit selection")
    } catch {
      XCTAssertEqual(error as? GraphRelationshipAuthoringError, .personSelectionRequired)
    }

    let soleCalendarEmail = "sole-calendar@example.com"
    _ = try await projectContactPerson(
      email: soleCalendarEmail,
      eventID: "sole-calendar-adoption",
      repository: fixture.repository
    )
    let soleCalendarID = PageID.person(email: soleCalendarEmail)
    let calendarPersonBeforeCandidate = try await fixture.repository.page(id: soleCalendarID)
    let calendarPersonBefore = try XCTUnwrap(calendarPersonBeforeCandidate)
    let eligibilityBefore = try await fixture.repository.cloudEligiblePage(pageID: soleCalendarID)
    do {
      _ = try await fixture.repository.createEntityAndRelationship(
        .init(
          intent: calendarIntent,
          selectedTargetTypeID: BuiltInSupertags.person,
          title: "Calendar Ada",
          initialProperties: [personEmailKey: [.email(soleCalendarEmail)]]
        )
      )
      XCTFail("Expected a sole calendar Person to require explicit selection")
    } catch {
      XCTAssertEqual(error as? GraphRelationshipAuthoringError, .personSelectionRequired)
    }
    let linked = try await fixture.repository.createEntityAndRelationship(
      .init(
        intent: calendarIntent,
        selectedTargetTypeID: BuiltInSupertags.person,
        title: "",
        existingPersonResolution: .useExistingMatchingEmail(
          pageID: soleCalendarID,
          matchingEmail: soleCalendarEmail
        )
      )
    )
    let calendarPersonAfter = try await fixture.repository.page(id: soleCalendarID)
    let eligibilityAfter = try await fixture.repository.cloudEligiblePage(pageID: soleCalendarID)
    XCTAssertEqual(linked.entity.id, soleCalendarID)
    XCTAssertEqual(linked.edge.sourceNodeID, soleCalendarID)
    XCTAssertEqual(calendarPersonAfter?.title, calendarPersonBefore.title)
    XCTAssertEqual(calendarPersonAfter?.objectMetadata.supertagIDs, calendarPersonBefore.objectMetadata.supertagIDs)
    // The canonical graph edge is stored on this Person because the relation runs Person →
    // Organization. Its derived relationship reference is expected; user-authored fields remain
    // untouched by the link-only branch.
    XCTAssertEqual(
      calendarPersonAfter?.objectMetadata.properties[personEmailKey],
      calendarPersonBefore.objectMetadata.properties[personEmailKey]
    )
    XCTAssertEqual(calendarPersonAfter?.personOrigin, calendarPersonBefore.personOrigin)
    XCTAssertEqual(calendarPersonAfter?.effectivePersonVisibility, calendarPersonBefore.effectivePersonVisibility)
    XCTAssertEqual(eligibilityAfter?.id, eligibilityBefore?.id)
  }

  @MainActor
  func testStoreSynchronizesEveryChangedPageFromEntityRelationshipReceipt() async throws {
    let fixture = try RepositoryFixture()
    let probe = PageSynchronizationProbe()
    let store = LibraryStore(
      repository: fixture.repository,
      startImmediately: false,
      pageSynchronizationObserver: { pageID in await probe.record(pageID) }
    )
    let task = try await fixture.repository.createTaggedPage(
      title: "Ship", supertagID: BuiltInSupertags.task
    )
    let intent = try await fixture.repository.relationshipAuthoringIntent(
      relationID: BuiltInRelations.taskProject,
      presentedSourceID: task.id,
      direction: .forward
    )

    let receipt = try await store.createEntityAndRelationship(
      .init(intent: intent, selectedTargetTypeID: BuiltInSupertags.project, title: "New project")
    )
    let synchronizedIDs = Set(await probe.pageIDs())
    XCTAssertEqual(synchronizedIDs, Set(receipt.changedPageIDs))
    XCTAssertEqual(Set(receipt.changedPageIDs), [task.id, receipt.entity.id])
  }

  func testPersonMeetingRelationshipsSortDeduplicateAndRemainReadOnly() async throws {
    let fixture = try RepositoryFixture()
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let email = "ada@example.com"
    let personID = PageID.person(email: email)
    let series = CalendarSeriesIdentity(
      provider: "eventkit", externalIdentifier: "weekly", crossProviderIdentifier: "weekly"
    )
    var past = recurringEvent(
      provider: "eventkit", id: "past", start: now.addingTimeInterval(-7_200), series: series
    )
    past.endDate = now.addingTimeInterval(-3_600)
    var ongoing = recurringEvent(
      provider: "eventkit", id: "now", start: now.addingTimeInterval(-600), series: series
    )
    ongoing.endDate = now.addingTimeInterval(600)
    let future = recurringEvent(
      provider: "eventkit", id: "future", start: now.addingTimeInterval(7_200), series: series
    )
    let duplicate = recurringEvent(
      provider: "google", id: "future-google", start: future.startDate,
      series: .init(provider: "google", externalIdentifier: "weekly-google", crossProviderIdentifier: "weekly")
    )
    func withAttendee(_ event: CalendarEventSnapshot) -> CalendarEventSnapshot {
      var withAttendee = event
      withAttendee.attendees = [.init(
        email: email, displayName: "Ada", role: "attendee", responseStatus: "accepted", isCurrentUser: false
      )]
      return withAttendee
    }
    try await fixture.repository.replaceCalendarProjection(
      [past, ongoing, future].map(withAttendee), provider: "eventkit", refreshedAt: now
    )
    try await fixture.repository.replaceCalendarProjection(
      [duplicate].map(withAttendee), provider: "google", refreshedAt: now
    )

    let before = try await fixture.repository.pages(in: .allPages).map(\.id)
    let relationships = try await fixture.repository.calendarMeetingRelationships(for: personID, now: now)
    let after = try await fixture.repository.pages(in: .allPages).map(\.id)

    XCTAssertEqual(relationships.map(\.timing), [.upcoming, .upcoming, .past])
    XCTAssertEqual(relationships.filter { $0.event.startDate == future.startDate }.count, 1)
    XCTAssertEqual(before, after)

    let manualPerson = try await fixture.repository.createTaggedPage(
      title: "Ada Manual", supertagID: BuiltInSupertags.person
    )
    try await fixture.repository.setProperty(
      pageID: manualPerson.id,
      key: personEmailKey,
      values: [.email(" ADA@EXAMPLE.COM ")]
    )
    let duplicateManualPerson = try await fixture.repository.createTaggedPage(
      title: "Ada Duplicate", supertagID: BuiltInSupertags.person
    )
    try await fixture.repository.setProperty(
      pageID: duplicateManualPerson.id,
      key: personEmailKey,
      values: [.email(email)]
    )
    let unrelatedPerson = try await fixture.repository.createTaggedPage(
      title: "Grace", supertagID: BuiltInSupertags.person
    )
    try await fixture.repository.setProperty(
      pageID: unrelatedPerson.id,
      key: personEmailKey,
      values: [.email("grace@example.com")]
    )

    var employee = SupertagDefinition.draft(name: "Employee")
    employee.parentIDs = [BuiltInSupertags.person]
    try await fixture.repository.saveSupertag(employee)
    let subtypePerson = try await fixture.repository.createTaggedPage(
      title: "Ada Employee", supertagID: employee.id
    )
    try await fixture.repository.setProperty(
      pageID: subtypePerson.id,
      key: personEmailKey,
      values: [.email(email)]
    )

    let beforeEmailResolution = try await fixture.repository.pages(in: .allPages).map(\.id)
    let manuallyResolved = try await fixture.repository.calendarMeetingRelationships(for: manualPerson.id, now: now)
    let duplicateResolved = try await fixture.repository.calendarMeetingRelationships(for: duplicateManualPerson.id, now: now)
    let subtypeResolved = try await fixture.repository.calendarMeetingRelationships(for: subtypePerson.id, now: now)
    let unrelated = try await fixture.repository.calendarMeetingRelationships(for: unrelatedPerson.id, now: now)
    let candidates = try await fixture.repository.personEmailCandidates(matchingEmail: email)
    let afterEmailResolution = try await fixture.repository.pages(in: .allPages).map(\.id)

    XCTAssertEqual(manuallyResolved.map(\.id), relationships.map(\.id))
    XCTAssertEqual(duplicateResolved.map(\.id), relationships.map(\.id))
    XCTAssertEqual(subtypeResolved.map(\.id), relationships.map(\.id))
    XCTAssertTrue(unrelated.isEmpty)
    XCTAssertTrue(candidates.contains { $0.pageID == subtypePerson.id })
    XCTAssertEqual(beforeEmailResolution, afterEmailResolution)
  }

  @MainActor
  private func projectContactPerson(
    email: String,
    eventID: String,
    repository: LibraryRepository
  ) async throws -> PageID {
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    var event = calendarEvent(
      provider: "eventkit",
      id: eventID,
      start: start,
      end: start.addingTimeInterval(3_600)
    )
    event.attendees = [
      .init(
        email: email,
        displayName: email,
        role: "attendee",
        responseStatus: "accepted",
        isCurrentUser: false
      )
    ]
    try await repository.replaceCalendarProjection([event], provider: eventID)
    return .person(email: email)
  }

  private func calendarEvent(
    provider: String, id: String, start: Date, end: Date
  ) -> CalendarEventSnapshot {
    CalendarEventSnapshot(
      identity: CalendarEventIdentity(
        provider: provider, externalIdentifier: id, occurrenceStart: start),
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

private actor TransientReminderEffects {
  private var attempts = 0

  func apply(_ effect: TaskMutationEffect) -> TaskMutationEffectDisposition {
    switch effect {
    case .scheduleReminder, .cancelReminder:
      attempts += 1
      return attempts <= 2
        ? .failed("The reminder could not be scheduled: Service offline")
        : .applied
    case .reloadLibrary, .sync, .syncPurge, .indexSpotlight, .removeSpotlight, .reloadWidgets:
      return .applied
    }
  }

  func reminderAttempts() -> Int {
    attempts
  }
}

private actor PageSynchronizationProbe {
  private var values: [PageID] = []

  func record(_ pageID: PageID) {
    values.append(pageID)
  }

  func pageIDs() -> [PageID] {
    values
  }
}

private struct ReferenceMarkPayload: Codable {
  var pageID: String
  var label: String
}

extension Array {
  fileprivate func asyncMap<T>(_ transform: (Element) async throws -> T) async rethrows -> [T] {
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

private actor StubContactResolver: DeviceContactResolving {
  private let contacts: [String: DeviceContactRecord]

  init(contacts: [String: DeviceContactRecord]) {
    self.contacts = contacts
  }

  func contact(matchingEmail normalizedEmail: String) async throws -> DeviceContactRecord? {
    contacts[normalizedEmail]
  }

  func contact(identifier: String) async throws -> DeviceContactRecord? {
    contacts.values.first { $0.identifier == identifier }
  }
}

private actor IdentifierOnlyContactResolver: DeviceContactResolving {
  private let contacts: [String: DeviceContactRecord]

  init(contacts: [DeviceContactRecord]) {
    self.contacts = Dictionary(uniqueKeysWithValues: contacts.map { ($0.identifier, $0) })
  }

  func contact(matchingEmail normalizedEmail: String) async throws -> DeviceContactRecord? {
    nil
  }

  func contact(identifier: String) async throws -> DeviceContactRecord? {
    contacts[identifier]
  }
}

private actor StoreReconciliationProbe {
  private var recordedSubmissions: [[PageID]] = []

  func record(_ pages: [PageSnapshot]) {
    recordedSubmissions.append(pages.map(\.id))
  }

  func submissions() -> [[PageID]] {
    recordedSubmissions
  }
}

private func XCTAssertThrowsErrorAsync<T>(
  _ expression: () async throws -> T,
  file: StaticString = #filePath,
  line: UInt = #line
) async {
  do {
    _ = try await expression()
    XCTFail("Expected expression to throw", file: file, line: line)
  } catch {}
}
