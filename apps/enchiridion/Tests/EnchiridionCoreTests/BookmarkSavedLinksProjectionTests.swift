import Foundation
import XCTest

@testable import EnchiridionCore

final class BookmarkSavedLinksProjectionTests: XCTestCase {
  func testRepeatedIdentityProducesOneRowWithNewestCaptureAndWinningPage() throws {
    let key = try key("https://example.com/article")
    let winner = page("Winner", key: key, id: .free(UUID(uuidString: "00000000-0000-0000-0000-000000000001")!))
    let older = try event(key, at: 1_722_816_100)
    let newer = try event(key, at: 1_722_816_200)

    let rows = BookmarkSavedLinksProjection.rows(
      dayKey: .init(rawValue: "2026-08-05"), timeZoneIdentifier: "Europe/London",
      events: [older, newer], resolvedPages: [winner]
    )

    XCTAssertEqual(rows.count, 1)
    XCTAssertEqual(rows.first?.page.id, winner.id)
    XCTAssertEqual(rows.first?.saveCount, 2)
    XCTAssertEqual(rows.first?.newestCaptureAt, newer.capturedAt)
  }

  func testDifferentIdentitiesAreNewestFirstAndDoNotUseMissingOrAliasPages() throws {
    let first = try key("https://example.com/first")
    let second = try key("https://example.com/second")
    let firstWinner = page("First winner", key: first)
    let winner = page("Second winner", key: second)
    let alias = page("First alias", key: first)

    let rows = BookmarkSavedLinksProjection.rows(
      dayKey: .init(rawValue: "2026-08-05"), timeZoneIdentifier: "Europe/London",
      events: [
        try event(first, at: 1_722_816_300),
        try event(second, at: 1_722_816_200),
      ], resolvedPages: [firstWinner, alias, winner]
    )

    XCTAssertEqual(rows.map(\.page.id), [firstWinner.id, winner.id])
    XCTAssertFalse(rows.contains { $0.page.id == alias.id })
  }

  func testDayAndTimezoneBoundaryFiltersEvents() throws {
    let key = try key("https://example.com/boundary")
    let winner = page("Boundary", key: key)
    let today = DayKey(rawValue: "2026-08-05")
    let rows = BookmarkSavedLinksProjection.rows(
      dayKey: today, timeZoneIdentifier: "America/Los_Angeles",
      events: [
        try event(key, at: 1_722_816_100, day: today, zone: "Europe/London"),
        try event(
          key, at: 1_722_816_200, day: .init(rawValue: "2026-08-06"),
          zone: "America/Los_Angeles"),
        try event(key, at: 1_722_816_300, day: today, zone: "America/Los_Angeles"),
      ], resolvedPages: [winner]
    )

    XCTAssertEqual(rows.map(\.newestCaptureAt), [Date(timeIntervalSince1970: 1_722_816_300)])
    XCTAssertEqual(rows.first?.page.id, winner.id)
  }

  func testDeletedCandidatesAndRepositoryFilteredSuppressedEventsAreAbsent() throws {
    let key = try key("https://example.com/removed")
    var deleted = page("Removed", key: key)
    deleted.deletedAt = Date(timeIntervalSince1970: 1)
    let day = DayKey(rawValue: "2026-08-05")

    XCTAssertTrue(BookmarkSavedLinksProjection.rows(
      dayKey: day, timeZoneIdentifier: "Europe/London",
      events: [try event(key, at: 1_722_816_100, day: day)], resolvedPages: [deleted]
    ).isEmpty)
    XCTAssertTrue(BookmarkSavedLinksProjection.rows(
      dayKey: day, timeZoneIdentifier: "Europe/London",
      events: [], resolvedPages: [page("Visible", key: key)]
    ).isEmpty, "Suppressed events are filtered by the repository before this projection.")
  }

  func testLibraryRowsUseSyncedHistoryAndPreserveRepeatedSaveCount() throws {
    let key = try key("https://example.com/synced")
    let winner = page("Synced", key: key)

    let rows = BookmarkSavedLinksProjection.rows(
      events: [
        try event(key, at: 1_722_816_100),
        try event(key, at: 1_722_816_200),
      ],
      resolvedPages: [winner]
    )

    XCTAssertEqual(rows.map(\.page.id), [winner.id])
    XCTAssertEqual(rows.first?.saveCount, 2)
  }

  func testDiagnosticSummaryContainsCountsButNoCaptureContent() {
    let issues = [
      BookmarkCaptureHistoryIssue(
        reason: "Conflicting synced capture facts",
        pageIDs: [.init(rawValue: "page-a"), .init(rawValue: "page-b")]
      ),
      BookmarkCaptureHistoryIssue(
        reason: "Bookmark capture history could not be read",
        pageIDs: [.init(rawValue: "page-b")]
      ),
    ]

    let summary = BookmarkSavedLinksProjection.diagnosticSummary(issues: issues)
    XCTAssertEqual(summary?.issueCount, 2)
    XCTAssertEqual(summary?.affectedPageCount, 2)
    let notice = summary?.notice ?? ""
    XCTAssertFalse(notice.contains("https://"))
    XCTAssertFalse(notice.localizedCaseInsensitiveContains("note"))
    XCTAssertFalse(notice.localizedCaseInsensitiveContains("platform"))
    XCTAssertFalse(notice.localizedCaseInsensitiveContains("vault"))
    XCTAssertFalse(notice.localizedCaseInsensitiveContains("source"))
  }

  @MainActor
  func testStoreReloadConvergesTodayFromPageSyncedHistory() async throws {
    let repository = try repositoryFixture()
    let key = try key("https://example.com/remote-history")
    let pageID = PageID.free(
      UUID(uuidString: "00000000-0000-0000-0000-000000000091")!)
    let created = try PageDocument.create(
      id: pageID,
      kind: .free,
      title: "Remote history",
      createdAt: Date(timeIntervalSince1970: 1_754_352_000)
    )
    var mutation = try PageDocument.addSupertag(BuiltInSupertags.bookmark, in: created.document)
    mutation = try PageDocument.setProperty(
      key: .init(
        supertagID: BuiltInSupertags.bookmark,
        fieldID: BuiltInSupertags.bookmarkSourceURLField
      ),
      values: [.url(key.canonicalURL)],
      in: mutation.document
    )
    mutation = try PageDocument.appendBookmarkCaptureEvent(
      event(key, at: 1_754_352_100), in: mutation.document)
    mutation = try PageDocument.appendBookmarkCaptureEvent(
      event(key, at: 1_754_352_200), in: mutation.document)
    _ = try await repository.mergeCloudPage(
      pageID: pageID,
      kind: .free,
      remoteDocument: mutation.document,
      systemFields: Data()
    )

    let store = LibraryStore(repository: repository, startImmediately: false)
    await store.reload()

    let localCaptureEvents = try await repository.bookmarkCaptureEvents()
    XCTAssertTrue(localCaptureEvents.isEmpty)
    XCTAssertEqual(store.bookmarkSyncedCaptureHistory.count, 2)
    XCTAssertEqual(
      store.savedLinks(
        on: .init(rawValue: "2026-08-05"),
        timeZoneIdentifier: "Europe/London"
      ).first?.saveCount,
      2
    )
  }

  @MainActor
  func testSuppressedTrashReadModelPreventsOpenAndRestoreWhileOrdinaryTrashRemainsRestorable()
    async throws
  {
    let repository = try repositoryFixture()
    let capturedAt = Date(timeIntervalSince1970: 1_754_352_000)
    let saved = try await repository.materializeBookmark(.init(
      captureID: UUID(),
      submittedURL: "https://example.com/deleted",
      note: "local-only note",
      capturedAt: capturedAt,
      dayKey: .init(rawValue: "2026-08-05"),
      timeZoneIdentifier: "Europe/London",
      source: "test",
      platform: "test",
      vaultID: .standalone
    ))
    try await repository.moveToTrash(
      pageID: saved.pageID,
      now: capturedAt.addingTimeInterval(1)
    )
    let ordinary = try await repository.createFreePage(
      title: "Ordinary trash",
      now: capturedAt
    )
    try await repository.moveToTrash(
      pageID: ordinary.id,
      now: capturedAt.addingTimeInterval(1)
    )

    let store = LibraryStore(repository: repository, startImmediately: false)
    await store.reload()

    let presentation = try XCTUnwrap(
      store.suppressedBookmarkTrashPresentation(for: saved.pageID))
    XCTAssertEqual(presentation.status, "Deleted saved link")
    XCTAssertEqual(
      store.pageContentAccess(for: saved.pageID),
      .suppressedBookmark(presentation)
    )
    XCTAssertFalse(store.canOpenPage(saved.pageID))
    XCTAssertFalse(store.canRestore(pageID: saved.pageID))
    XCTAssertNil(store.suppressedBookmarkTrashPresentation(for: ordinary.id))
    XCTAssertTrue(store.canOpenPage(ordinary.id))
    XCTAssertTrue(store.canRestore(pageID: ordinary.id))
  }

  @MainActor
  func testReloadInvalidatesAlreadySelectedPageWhenBookmarkBecomesSuppressed() async throws {
    let repository = try repositoryFixture()
    let capturedAt = Date(timeIntervalSince1970: 1_754_352_000)
    let saved = try await repository.materializeBookmark(.init(
      captureID: UUID(),
      submittedURL: "https://example.com/selected-before-remote-delete",
      note: nil,
      capturedAt: capturedAt,
      dayKey: .init(rawValue: "2026-08-05"),
      timeZoneIdentifier: "Europe/London",
      source: "test",
      platform: "test",
      vaultID: .standalone
    ))
    let store = LibraryStore(repository: repository, startImmediately: false)
    await store.reload()
    store.selectedPageID = saved.pageID
    XCTAssertEqual(store.pageContentAccess(for: saved.pageID), .allowed)

    try await repository.moveToTrash(
      pageID: saved.pageID,
      now: capturedAt.addingTimeInterval(1)
    )
    await store.reload()

    guard case .suppressedBookmark = store.pageContentAccess(for: saved.pageID) else {
      return XCTFail("Direct PageID access must become locked after suppression reloads.")
    }
    XCTAssertNotEqual(store.selectedPageID, saved.pageID)
    XCTAssertFalse(store.canOpenPage(saved.pageID))
  }

  func testPermanentDeletionCopyIsBookmarkSpecificAndLeavesOrdinaryCopyUnchanged() throws {
    let bookmarkKey = try key("https://example.com/delete-copy")
    let bookmarkMessage = PagePermanentDeletionCopy.message(
      for: page("Saved article", key: bookmarkKey)
    )
    XCTAssertTrue(bookmarkMessage.contains("local content will be removed after deletion syncs"))
    XCTAssertTrue(bookmarkMessage.contains("non-reversible identity digest remains"))
    XCTAssertTrue(bookmarkMessage.contains("cannot be saved again"))

    let ordinary = PageSnapshot(
      id: .free(), kind: .free, title: "Ordinary page", plainText: "", document: Data(),
      heads: .empty, createdAt: .distantPast, modifiedAt: .distantPast
    )
    XCTAssertEqual(
      PagePermanentDeletionCopy.message(for: ordinary),
      "Ordinary page and its data will be permanently deleted. This cannot be undone."
    )
  }

  private func key(_ value: String) throws -> BookmarkURLKey {
    try XCTUnwrap(BookmarkURLKey(submittedURL: value))
  }

  private func event(
    _ key: BookmarkURLKey, at seconds: TimeInterval,
    day: DayKey = .init(rawValue: "2026-08-05"), zone: String = "Europe/London"
  ) throws -> BookmarkSyncedCaptureEvent {
    try .init(
      captureID: UUID(), urlKey: key, submittedURL: key.canonicalURL,
      capturedAt: Date(timeIntervalSince1970: seconds),
      dayKey: day, timeZoneIdentifier: zone
    )
  }

  private func page(_ title: String, key: BookmarkURLKey, id: PageID = .free()) -> PageSnapshot {
    PageSnapshot(
      id: id, kind: .free, title: title, plainText: "", document: Data(), heads: .empty,
      createdAt: .distantPast, modifiedAt: .distantPast,
      objectMetadata: .init(
        supertagIDs: [BuiltInSupertags.bookmark],
        properties: [
          .init(supertagID: BuiltInSupertags.bookmark, fieldID: BuiltInSupertags.bookmarkSourceURLField): [.url(key.canonicalURL)]
        ]
      )
    )
  }

  private func repositoryFixture() throws -> LibraryRepository {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(
        "BookmarkSavedLinksProjectionTests-\(UUID().uuidString)",
        isDirectory: true
      )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return try LibraryRepository(path: directory.appendingPathComponent("graph.sqlite").path)
  }
}
