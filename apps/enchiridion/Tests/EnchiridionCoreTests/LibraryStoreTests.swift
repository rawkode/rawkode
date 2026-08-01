import Automerge
import Foundation
import XCTest

@testable import EnchiridionCore

final class LibraryRepositoryTests: XCTestCase {
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

    await store.refreshContactEnrichment(using: resolver)

    XCTAssertEqual(store.contactLinks[personID]?.record.displayName, "Device Person")
    XCTAssertEqual(store.otherPeople.first { $0.id == personID }?.effectivePersonVisibility, .other)
    XCTAssertFalse(store.pages.contains { $0.id == personID })

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

  private func taggedPageReferenceRequest(
    source: PageSnapshot,
    targetID: PageID = .free(),
    targetTitle: String = "Project Aurora",
    supertagID: SupertagID = BuiltInSupertags.project,
    includesReference: Bool = true
  ) throws -> TaggedPageReferenceInsertionRequest {
    var body = AttributedString(includesReference ? targetTitle : "No reference")
    if includesReference {
      body[body.startIndex..<body.endIndex][PageRichTextAttributes.AutomergeMarks.self] = [
        try PageDocument.pageReferenceMark(to: targetID, label: targetTitle)
      ]
    }
    return TaggedPageReferenceInsertionRequest(
      sourcePageID: source.id,
      expectedSourceHeads: source.heads,
      sourceTitle: source.title,
      sourceBody: body,
      targetPageID: targetID,
      targetTitle: targetTitle,
      supertagID: supertagID
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
      encodedChanges: try PageDocument.encodedChanges(
        from: updatedDocument,
        since: page.heads
      ),
      advertisedHeads: .empty
    )
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
