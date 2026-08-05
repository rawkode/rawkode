import Foundation
import GRDB
import XCTest

@testable import EnchiridionCore

final class BookmarkSyncedCaptureRepositoryTests: XCTestCase {
  func testMaterializationStoresSyncedHistoryWhileNotesRemainLocal() async throws {
    let source = try Fixture(testCase: self)
    let target = try Fixture(testCase: self)
    let capture = request(
      id: "00000000-0000-0000-0000-000000000001",
      url: "https://example.com/article",
      note: "Private reading note",
      capturedAt: Date(timeIntervalSince1970: 1_754_352_000.123_7)
    )
    let result = try await source.repository.materializeBookmark(capture)
    let storedPage = try await source.repository.page(id: result.pageID)
    let page = try XCTUnwrap(storedPage)
    let expected = try syncedEvent(capture)

    XCTAssertEqual(
      try PageDocument.bookmarkCaptureEvents(in: page.document).events.map(\.event),
      [expected]
    )
    let sourceHistory = try await source.repository.bookmarkSyncedCaptureEvents()
    let sourceLocalEvents = try await source.repository.bookmarkCaptureEvents()
    XCTAssertEqual(sourceHistory, [expected])
    XCTAssertEqual(sourceLocalEvents.map(\.note), [capture.note])

    _ = try await target.repository.mergeCloudPage(
      pageID: page.id,
      kind: page.kind,
      remoteDocument: page.document,
      systemFields: Data()
    )
    let targetHistory = try await target.repository.bookmarkSyncedCaptureEvents()
    let targetLocalEvents = try await target.repository.bookmarkCaptureEvents()
    XCTAssertEqual(targetHistory, [expected])
    XCTAssertTrue(targetLocalEvents.isEmpty)
  }

  func testFractionalReplayIsNoOpAndDuplicateCaptureAdvancesWinner() async throws {
    let fixture = try Fixture(testCase: self)
    let first = request(
      id: "00000000-0000-0000-0000-000000000002",
      url: "https://example.com/fractional",
      capturedAt: Date(timeIntervalSince1970: 1_754_352_000.123_7)
    )
    let result = try await fixture.repository.materializeBookmark(first)
    let storedBefore = try await fixture.repository.page(id: result.pageID)
    let before = try XCTUnwrap(storedBefore)

    let replay = try await fixture.repository.materializeBookmark(first)
    let storedReplay = try await fixture.repository.page(id: result.pageID)
    let replayed = try XCTUnwrap(storedReplay)
    XCTAssertTrue(replay.duplicate)
    XCTAssertEqual(replayed.document, before.document)
    XCTAssertEqual(replayed.heads, before.heads)
    XCTAssertEqual(replayed.dirtyGeneration, before.dirtyGeneration)

    let second = request(
      id: "00000000-0000-0000-0000-000000000003",
      url: first.submittedURL,
      capturedAt: first.capturedAt.addingTimeInterval(1)
    )
    let duplicate = try await fixture.repository.materializeBookmark(second)
    let storedAdvanced = try await fixture.repository.page(id: result.pageID)
    let advanced = try XCTUnwrap(storedAdvanced)
    let history = try await fixture.repository.bookmarkSyncedCaptureEvents()
    XCTAssertTrue(duplicate.duplicate)
    XCTAssertGreaterThan(advanced.dirtyGeneration, before.dirtyGeneration)
    XCTAssertEqual(history, [try syncedEvent(first), try syncedEvent(second)])
  }

  func testDivergentCaptureIdentifierIsRejectedWithoutChangingWinner() async throws {
    let fixture = try Fixture(testCase: self)
    let original = request(
      id: "00000000-0000-0000-0000-000000000004",
      url: "https://example.com/original"
    )
    let result = try await fixture.repository.materializeBookmark(original)
    let storedBefore = try await fixture.repository.page(id: result.pageID)
    let before = try XCTUnwrap(storedBefore)

    do {
      _ = try await fixture.repository.materializeBookmark(request(
        id: original.captureID.uuidString,
        url: "https://example.com/divergent",
        capturedAt: original.capturedAt
      ))
      XCTFail("A capture identifier cannot represent divergent immutable facts")
    } catch let error as LibraryRepositoryError {
      XCTAssertEqual(error, .bookmarkCaptureHistoryConflict)
    }

    let current = try await fixture.repository.page(id: result.pageID)
    let history = try await fixture.repository.bookmarkSyncedCaptureEvents()
    XCTAssertEqual(current, before)
    XCTAssertEqual(history, [try syncedEvent(original)])
  }

  func testProjectionWipeAndRebuildRestoresHistoryFromDocuments() async throws {
    let fixture = try Fixture(testCase: self)
    let capture = request(
      id: "00000000-0000-0000-0000-000000000005",
      url: "https://example.com/rebuild"
    )
    let result = try await fixture.repository.materializeBookmark(capture)

    try await DatabaseQueue(path: fixture.path).write { db in
      try db.execute(
        sql: "DELETE FROM bookmark_capture_event_sources WHERE page_id = ?",
        arguments: [result.pageID.rawValue]
      )
      try db.execute(
        sql: "DELETE FROM bookmark_capture_event_issues WHERE page_id = ?",
        arguments: [result.pageID.rawValue]
      )
    }
    let erasedHistory = try await fixture.repository.bookmarkSyncedCaptureEvents()
    XCTAssertTrue(erasedHistory.isEmpty)

    try await fixture.repository.rebuildBookmarkCaptureEventProjection()

    let rebuiltHistory = try await fixture.repository.bookmarkSyncedCaptureEvents()
    XCTAssertEqual(rebuiltHistory, [try syncedEvent(capture)])
  }

  func testV30MigrationBackfillsSyncedHistoryFromRetainedPageDocuments() async throws {
    let fixture = try Fixture(testCase: self)
    let capture = request(
      id: "00000000-0000-0000-0000-000000000011",
      url: "https://example.com/migration"
    )
    _ = try await fixture.repository.materializeBookmark(capture)
    try await fixture.repository.closeDatabase()

    var configuration = Configuration()
    configuration.foreignKeysEnabled = false
    let queue = try DatabaseQueue(path: fixture.path, configuration: configuration)
    try await queue.write { db in
      for table in [
        "bookmark_capture_event_sources",
        "bookmark_capture_event_issues",
        "bookmark_frozen_identities",
        "bookmark_deletion_carriers",
        "bookmark_identity_suppressions",
        "bookmark_permanent_delete_handoffs",
        "bookmark_projection_backfills",
      ] {
        try db.execute(sql: "DROP TABLE \(table)")
      }
      try db.execute(
        sql: "DELETE FROM grdb_migrations WHERE identifier = ?",
        arguments: ["v30-bookmark-synced-history-and-deletion-state"]
      )
    }

    let reopened = try LibraryRepository(path: fixture.path)
    let history = try await reopened.bookmarkSyncedCaptureEvents()
    XCTAssertEqual(history, [try syncedEvent(capture)])
  }

  func testTombstonedPageStillContributesHistoryUntilItsIdentityIsSuppressed() async throws {
    let source = try Fixture(testCase: self)
    let target = try Fixture(testCase: self)
    let capture = request(
      id: "00000000-0000-0000-0000-000000000012",
      url: "https://example.com/history-shard"
    )
    let result = try await source.repository.materializeBookmark(capture)
    let storedPage = try await source.repository.page(id: result.pageID)
    let page = try XCTUnwrap(storedPage)
    let deleted = try PageDocument.setDeleted(capture.capturedAt.addingTimeInterval(1), in: page.document)

    _ = try await target.repository.mergeCloudPage(
      pageID: page.id,
      kind: page.kind,
      remoteDocument: deleted.document,
      systemFields: Data()
    )

    let history = try await target.repository.bookmarkSyncedCaptureEvents()
    let targetPage = try await target.repository.page(id: page.id)
    XCTAssertEqual(history, [try syncedEvent(capture)])
    XCTAssertEqual(targetPage?.deletedAt, capture.capturedAt.addingTimeInterval(1))
  }

  func testFrozenLocalIdentityRejectsSourceChangeAndTagRemovalAtomically() async throws {
    let fixture = try Fixture(testCase: self)
    let capture = request(
      id: "00000000-0000-0000-0000-000000000006",
      url: "https://example.com/frozen"
    )
    let result = try await fixture.repository.materializeBookmark(capture)
    let storedOriginal = try await fixture.repository.page(id: result.pageID)
    let original = try XCTUnwrap(storedOriginal)

    do {
      try await fixture.repository.setProperty(
        pageID: result.pageID,
        key: bookmarkSourceKey,
        values: [.url("https://example.com/changed")]
      )
      XCTFail("Capture history must freeze the source identity")
    } catch let error as LibraryRepositoryError {
      XCTAssertEqual(error, .bookmarkIdentityFrozen)
    }
    let afterSourceChange = try await fixture.repository.page(id: result.pageID)
    XCTAssertEqual(afterSourceChange, original)

    do {
      try await fixture.repository.removeSupertag(BuiltInSupertags.bookmark, from: result.pageID)
      XCTFail("Capture history must freeze Bookmark membership")
    } catch let error as LibraryRepositoryError {
      XCTAssertEqual(error, .bookmarkIdentityFrozen)
    }
    let afterTagRemoval = try await fixture.repository.page(id: result.pageID)
    XCTAssertEqual(afterTagRemoval, original)
  }

  func testHistoryDeduplicatesIdenticalPagesAndExcludesDivergentCaptureID() async throws {
    let fixture = try Fixture(testCase: self)
    let capture = request(
      id: "00000000-0000-0000-0000-000000000007",
      url: "https://example.com/shared"
    )
    let event = try syncedEvent(capture)
    let firstID = pageID("00000000-0000-0000-0000-000000000101")
    let secondID = pageID("00000000-0000-0000-0000-000000000102")
    for id in [firstID, secondID] {
      try await mergeBookmark(
        into: fixture.repository,
        pageID: id,
        sourceURL: capture.submittedURL,
        events: [event]
      )
    }
    let deduplicatedHistory = try await fixture.repository.bookmarkSyncedCaptureEvents()
    XCTAssertEqual(deduplicatedHistory, [event])

    let thirdID = pageID("00000000-0000-0000-0000-000000000103")
    let divergent = request(
      id: capture.captureID.uuidString,
      url: "https://example.com/other",
      capturedAt: capture.capturedAt
    )
    try await mergeBookmark(
      into: fixture.repository,
      pageID: thirdID,
      sourceURL: divergent.submittedURL,
      events: [try syncedEvent(divergent)]
    )

    let divergentHistory = try await fixture.repository.bookmarkSyncedCaptureEvents()
    XCTAssertTrue(divergentHistory.isEmpty)
    let firstRead = try await fixture.repository.bookmarkCaptureHistoryIssues()
    let secondRead = try await fixture.repository.bookmarkCaptureHistoryIssues()
    XCTAssertEqual(firstRead, secondRead)
    let conflict = try XCTUnwrap(firstRead.first {
      $0.reason.localizedCaseInsensitiveContains("conflict")
        || $0.reason.localizedCaseInsensitiveContains("diverg")
    })
    XCTAssertEqual(conflict.pageIDs, [firstID, secondID, thirdID])
  }

  func testRemoteSourceMismatchIsQuarantinedAndProjectionSurvivesRebuild() async throws {
    let fixture = try Fixture(testCase: self)
    let page = pageID("00000000-0000-0000-0000-000000000201")
    let capture = request(
      id: "00000000-0000-0000-0000-000000000008",
      url: "https://example.com/event"
    )
    try await mergeBookmark(
      into: fixture.repository,
      pageID: page,
      sourceURL: "https://example.com/page",
      events: [try syncedEvent(capture)]
    )

    let mismatchedHistory = try await fixture.repository.bookmarkSyncedCaptureEvents()
    XCTAssertTrue(mismatchedHistory.isEmpty)
    let issues = try await fixture.repository.bookmarkCaptureHistoryIssues()
    XCTAssertTrue(issues.contains {
      $0.pageIDs == [page] && $0.reason.localizedCaseInsensitiveContains("source")
    })

    try await fixture.repository.rebuildBookmarkCaptureEventProjection()
    let rebuiltIssues = try await fixture.repository.bookmarkCaptureHistoryIssues()
    let resolvedPages = try await fixture.repository.resolvedBookmarkPages()
    XCTAssertEqual(rebuiltIssues, issues)
    XCTAssertEqual(resolvedPages.map(\.id), [page])
  }

  func testSuppressionTrashesEveryAliasAndPreventsReplacementAllocation() async throws {
    let fixture = try Fixture(testCase: self)
    let capture = request(
      id: "00000000-0000-0000-0000-000000000009",
      url: "https://example.com/suppress"
    )
    let first = try await fixture.repository.materializeBookmark(capture)
    let aliasID = pageID("00000000-0000-0000-0000-000000000301")
    try await mergeBookmark(
      into: fixture.repository,
      pageID: aliasID,
      sourceURL: capture.submittedURL,
      events: []
    )
    let key = try XCTUnwrap(BookmarkURLKey(submittedURL: capture.submittedURL))

    try await fixture.repository.deleteBookmarkIdentity(
      .init(
        deletionID: UUID(uuidString: "00000000-0000-0000-0000-000000000901")!,
        urlKey: key
      ),
      now: capture.capturedAt.addingTimeInterval(1)
    )

    let resolved = try await fixture.repository.resolvedBookmarkPages()
    let trashed = try await fixture.repository.pages(in: .trash)
    XCTAssertTrue(resolved.isEmpty)
    XCTAssertEqual(Set(trashed.map(\.id)), Set([first.pageID, aliasID]))
    let allBefore = try await fixture.repository.pages(in: .allPages)
    let trashBefore = try await fixture.repository.pages(in: .trash)
    let pageCount = allBefore.count + trashBefore.count
    let later = try await fixture.repository.materializeBookmark(request(
      id: "00000000-0000-0000-0000-000000000010",
      url: capture.submittedURL,
      capturedAt: capture.capturedAt.addingTimeInterval(2)
    ))
    XCTAssertTrue(later.duplicate)
    XCTAssertTrue([first.pageID, aliasID].contains(later.pageID))
    let allAfter = try await fixture.repository.pages(in: .allPages)
    let trashAfter = try await fixture.repository.pages(in: .trash)
    let suppression = try await fixture.repository.bookmarkSuppressionState(for: key)
    XCTAssertEqual(allAfter.count + trashAfter.count, pageCount)
    XCTAssertNotNil(suppression)
  }

  func testTrashCreatesDistinctHiddenCarrierAndPermanentPurgeWaitsForExactAck() async throws {
    let fixture = try Fixture(testCase: self)
    let capture = request(
      id: "00000000-0000-0000-0000-000000000013",
      url: "https://example.com/ack-fence"
    )
    let captured = try await fixture.repository.materializeBookmark(capture)
    let key = try XCTUnwrap(BookmarkURLKey(submittedURL: capture.submittedURL))
    try await fixture.repository.moveToTrash(pageID: captured.pageID, now: capture.capturedAt.addingTimeInterval(1))

    let initialState = try await fixture.repository.bookmarkSuppressionState(for: key)
    var state = try XCTUnwrap(initialState)
    XCTAssertEqual(state.stage, .carrierPendingAck)
    let carrierID = try XCTUnwrap(state.carrierPageID)
    XCTAssertNotEqual(carrierID, captured.pageID)
    let storedCarrier = try await fixture.repository.page(id: carrierID)
    let carrier = try XCTUnwrap(storedCarrier)
    XCTAssertTrue(try PageDocument.bookmarkIdentityDeletionCarrierInspection(in: carrier.document).isCanonicalCarrier)
    let trash = try await fixture.repository.pages(in: .trash)
    XCTAssertEqual(trash.map(\.id), [captured.pageID])

    try await fixture.repository.purge(pageID: captured.pageID, now: capture.capturedAt.addingTimeInterval(2))
    let requestedState = try await fixture.repository.bookmarkSuppressionState(for: key)
    state = try XCTUnwrap(requestedState)
    XCTAssertTrue(state.permanentRequested)
    let candidateBeforeAck = try await fixture.repository.page(id: captured.pageID)
    XCTAssertNotNil(candidateBeforeAck)

    _ = try await fixture.repository.markCloudSaved(
      pageID: carrierID,
      sentGeneration: max(0, carrier.dirtyGeneration - 1),
      systemFields: Data("stale".utf8)
    )
    let candidateAfterStaleAck = try await fixture.repository.page(id: captured.pageID)
    XCTAssertNotNil(candidateAfterStaleAck)

    _ = try await fixture.repository.markCloudSaved(
      pageID: carrierID,
      sentGeneration: carrier.dirtyGeneration,
      systemFields: Data("acked".utf8)
    )
    let candidateAfterExactAck = try await fixture.repository.page(id: captured.pageID)
    XCTAssertNil(candidateAfterExactAck)
    let stableState = try await fixture.repository.bookmarkSuppressionState(for: key)
    state = try XCTUnwrap(stableState)
    XCTAssertEqual(state.stage, .stable)
    let handoffs = try await fixture.repository.bookmarkPermanentDeletionHandoffs()
    XCTAssertEqual(handoffs.map(\.urlKeyDigest), [key.digest])

    do {
      _ = try await fixture.repository.materializeBookmark(request(
        id: "00000000-0000-0000-0000-000000000014",
        url: capture.submittedURL,
        capturedAt: capture.capturedAt.addingTimeInterval(3)
      ))
      XCTFail("Permanent suppression must not recreate a Page")
    } catch let error as LibraryRepositoryError {
      XCTAssertEqual(error, .bookmarkSuppressed)
    }
  }

  func testPermanentPurgeRemovesQueryableCandidateSidecarsButRetainsDigestFactAndCarrier() async throws {
    let fixture = try Fixture(testCase: self)
    let capture = request(
      id: "00000000-0000-0000-0000-000000000015",
      url: "https://example.com/logical-delete",
      note: "local-only note"
    )
    let captured = try await fixture.repository.materializeBookmark(capture)
    let key = try XCTUnwrap(BookmarkURLKey(submittedURL: capture.submittedURL))
    try await fixture.repository.moveToTrash(
      pageID: captured.pageID,
      now: capture.capturedAt.addingTimeInterval(1)
    )
    try await fixture.repository.purge(
      pageID: captured.pageID,
      now: capture.capturedAt.addingTimeInterval(2)
    )
    let storedState = try await fixture.repository.bookmarkSuppressionState(for: key)
    let state = try XCTUnwrap(storedState)
    let carrierID = try XCTUnwrap(state.carrierPageID)
    let storedCarrier = try await fixture.repository.page(id: carrierID)
    let carrier = try XCTUnwrap(storedCarrier)
    _ = try await fixture.repository.markCloudSaved(
      pageID: carrierID,
      sentGeneration: carrier.dirtyGeneration,
      systemFields: Data()
    )

    let counts = try await DatabaseQueue(path: fixture.path).read { db in
      try [
        Int.fetchOne(db, sql: "SELECT COUNT(*) FROM bookmark_capture_events WHERE url_key_digest=?", arguments: [key.digest]) ?? -1,
        Int.fetchOne(db, sql: "SELECT COUNT(*) FROM bookmark_identity_candidates WHERE url_key_digest=?", arguments: [key.digest]) ?? -1,
        Int.fetchOne(db, sql: "SELECT COUNT(*) FROM bookmark_capture_receipts WHERE page_id=?", arguments: [captured.pageID.rawValue]) ?? -1,
        Int.fetchOne(db, sql: "SELECT COUNT(*) FROM bookmark_identity_deletions WHERE url_key_digest=?", arguments: [key.digest]) ?? -1,
        Int.fetchOne(db, sql: "SELECT COUNT(*) FROM bookmark_identity_suppressions WHERE url_key_digest=?", arguments: [key.digest]) ?? -1,
        Int.fetchOne(db, sql: "SELECT COUNT(*) FROM bookmark_deletion_carriers WHERE page_id=?", arguments: [carrierID.rawValue]) ?? -1,
      ]
    }
    XCTAssertEqual(counts, [0, 0, 0, 0, 1, 1])
    let localEvents = try await fixture.repository.bookmarkCaptureEvents()
    let syncedEvents = try await fixture.repository.bookmarkSyncedCaptureEvents()
    XCTAssertTrue(localEvents.isEmpty)
    XCTAssertTrue(syncedEvents.isEmpty)
  }

  func testInboundCarrierDominatesCandidateWhenCarrierArrivesFirst() async throws {
    try await assertInboundCarrierDominatesCandidate(carrierFirst: true)
  }

  func testInboundCarrierDominatesCandidateWhenCandidateArrivesFirst() async throws {
    try await assertInboundCarrierDominatesCandidate(carrierFirst: false)
  }

  private func assertInboundCarrierDominatesCandidate(carrierFirst: Bool) async throws {
    let capture = request(
      id: "00000000-0000-0000-0000-000000000016",
      url: "https://example.com/arrival-order"
    )
    let event = try syncedEvent(capture)
    let key = event.urlKey
    let candidateID = pageID("00000000-0000-0000-0000-000000000401")
    let deletion = try BookmarkIdentityDeletionEnvelope(
      deletionID: UUID(uuidString: "00000000-0000-0000-0000-000000000902")!,
      urlKeyDigest: key.digest,
      deletedAt: capture.capturedAt.addingTimeInterval(1)
    )
    let carrierID = pageID("00000000-0000-0000-0000-000000000402")
    let carrier = try PageDocument.makeBookmarkIdentityDeletionCarrier(
      id: carrierID,
      replacingCandidateID: candidateID,
      deletion: deletion
    )

    let fixture = try Fixture(testCase: self)
    if carrierFirst {
      _ = try await fixture.repository.mergeCloudPage(
        pageID: carrierID,
        kind: .free,
        remoteDocument: carrier.document,
        systemFields: Data()
      )
    }
    try await mergeBookmark(
      into: fixture.repository,
      pageID: candidateID,
      sourceURL: capture.submittedURL,
      events: [event]
    )
    if !carrierFirst {
      _ = try await fixture.repository.mergeCloudPage(
        pageID: carrierID,
        kind: .free,
        remoteDocument: carrier.document,
        systemFields: Data()
      )
    }

    let storedCandidate = try await fixture.repository.page(id: candidateID)
    let candidate = try XCTUnwrap(storedCandidate)
    let allPages = try await fixture.repository.pages(in: .allPages)
    let trashPages = try await fixture.repository.pages(in: .trash)
    XCTAssertNotNil(candidate.deletedAt)
    XCTAssertTrue(allPages.isEmpty)
    XCTAssertEqual(trashPages.map(\.id), [candidateID])
    let storedState = try await fixture.repository.bookmarkSuppressionState(for: key)
    let state = try XCTUnwrap(storedState)
    XCTAssertEqual(state.stage, .carrierAcknowledged)

    try await fixture.repository.purge(pageID: candidateID)
    let removedCandidate = try await fixture.repository.page(id: candidateID)
    let finalState = try await fixture.repository.bookmarkSuppressionState(for: key)
    XCTAssertNil(removedCandidate)
    XCTAssertEqual(finalState?.stage, .stable)
    try await fixture.repository.closeDatabase()
  }

  func testLastCarrierCloudDeletionCreatesFreshPendingCarrier() async throws {
    let fixture = try Fixture(testCase: self)
    let capture = request(
      id: "00000000-0000-0000-0000-000000000017",
      url: "https://example.com/carrier-repair"
    )
    let captured = try await fixture.repository.materializeBookmark(capture)
    let key = try XCTUnwrap(BookmarkURLKey(submittedURL: capture.submittedURL))
    try await fixture.repository.moveToTrash(
      pageID: captured.pageID,
      now: capture.capturedAt.addingTimeInterval(1)
    )
    let pendingState = try await fixture.repository.bookmarkSuppressionState(for: key)
    var state = try XCTUnwrap(pendingState)
    let originalCarrierID = try XCTUnwrap(state.carrierPageID)
    let storedOriginalCarrier = try await fixture.repository.page(id: originalCarrierID)
    let originalCarrier = try XCTUnwrap(storedOriginalCarrier)
    _ = try await fixture.repository.markCloudSaved(
      pageID: originalCarrierID,
      sentGeneration: originalCarrier.dirtyGeneration,
      systemFields: Data()
    )

    let needsReplacementUpload = try await fixture.repository.applyCloudPageRecordDeletion(
      pageID: originalCarrierID
    )
    XCTAssertTrue(needsReplacementUpload)
    let replacementState = try await fixture.repository.bookmarkSuppressionState(for: key)
    state = try XCTUnwrap(replacementState)
    let replacementID = try XCTUnwrap(state.carrierPageID)
    XCTAssertNotEqual(replacementID, originalCarrierID)
    XCTAssertEqual(state.stage, .carrierPendingAck)
    let removedOriginalCarrier = try await fixture.repository.page(id: originalCarrierID)
    let storedReplacement = try await fixture.repository.page(id: replacementID)
    let replacement = try XCTUnwrap(storedReplacement)
    XCTAssertNil(removedOriginalCarrier)
    XCTAssertTrue(try PageDocument.bookmarkIdentityDeletionCarrierInspection(
      in: replacement.document
    ).isCanonicalCarrier)
  }

  func testPendingPermanentDeletionRecoversAcrossRepositoryReopen() async throws {
    let fixture = try Fixture(testCase: self)
    let capture = request(
      id: "00000000-0000-0000-0000-000000000018",
      url: "https://example.com/reopen"
    )
    let captured = try await fixture.repository.materializeBookmark(capture)
    let key = try XCTUnwrap(BookmarkURLKey(submittedURL: capture.submittedURL))
    try await fixture.repository.moveToTrash(
      pageID: captured.pageID,
      now: capture.capturedAt.addingTimeInterval(1)
    )
    try await fixture.repository.purge(
      pageID: captured.pageID,
      now: capture.capturedAt.addingTimeInterval(2)
    )
    let storedBefore = try await fixture.repository.bookmarkSuppressionState(for: key)
    let before = try XCTUnwrap(storedBefore)
    try await fixture.repository.closeDatabase()

    let reopened = try LibraryRepository(path: fixture.path)
    let storedAfter = try await reopened.bookmarkSuppressionState(for: key)
    let after = try XCTUnwrap(storedAfter)
    XCTAssertEqual(after.stage, .carrierPendingAck)
    XCTAssertEqual(after.carrierPageID, before.carrierPageID)
    XCTAssertEqual(after.requiredGeneration, before.requiredGeneration)
    XCTAssertTrue(after.permanentRequested)
    let candidate = try await reopened.page(id: captured.pageID)
    XCTAssertNotNil(candidate)
  }

  private var bookmarkSourceKey: SupertagPropertyKey {
    .init(
      supertagID: BuiltInSupertags.bookmark,
      fieldID: BuiltInSupertags.bookmarkSourceURLField
    )
  }

  private func request(
    id: String,
    url: String,
    note: String? = nil,
    capturedAt: Date = Date(timeIntervalSince1970: 1_754_352_000)
  ) -> BookmarkCaptureRequest {
    .init(
      captureID: UUID(uuidString: id)!,
      submittedURL: url,
      note: note,
      capturedAt: capturedAt,
      dayKey: .init(rawValue: "2026-08-05"),
      timeZoneIdentifier: "Europe/London",
      source: "test",
      platform: "test",
      vaultID: .standalone
    )
  }

  private func syncedEvent(_ request: BookmarkCaptureRequest) throws -> BookmarkSyncedCaptureEvent {
    try BookmarkSyncedCaptureEvent(
      captureID: request.captureID,
      urlKey: XCTUnwrap(BookmarkURLKey(submittedURL: request.submittedURL)),
      submittedURL: request.submittedURL,
      capturedAt: request.capturedAt,
      dayKey: request.dayKey,
      timeZoneIdentifier: request.timeZoneIdentifier
    )
  }

  private func pageID(_ raw: String) -> PageID {
    .free(UUID(uuidString: raw)!)
  }

  private func mergeBookmark(
    into repository: LibraryRepository,
    pageID: PageID,
    sourceURL: String,
    events: [BookmarkSyncedCaptureEvent]
  ) async throws {
    let created = try PageDocument.create(
      id: pageID,
      kind: .free,
      title: sourceURL,
      createdAt: Date(timeIntervalSince1970: 1_754_352_000)
    )
    var mutation = try PageDocument.addSupertag(
      BuiltInSupertags.bookmark,
      in: created.document
    )
    mutation = try PageDocument.setProperty(
      key: bookmarkSourceKey,
      values: [.url(sourceURL)],
      in: mutation.document
    )
    for event in events {
      mutation = try PageDocument.appendBookmarkCaptureEvent(event, in: mutation.document)
    }
    _ = try await repository.mergeCloudPage(
      pageID: pageID,
      kind: .free,
      remoteDocument: mutation.document,
      systemFields: Data()
    )
  }
}

private struct BookmarkSyncedCaptureRepositoryFixture {
  let path: String
  let repository: LibraryRepository

  init(testCase: XCTestCase) throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "BookmarkSyncedCaptureRepositoryTests-\(UUID().uuidString)",
      isDirectory: true
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    testCase.addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    path = directory.appendingPathComponent("graph.sqlite").path
    repository = try LibraryRepository(path: path)
  }
}

private typealias Fixture = BookmarkSyncedCaptureRepositoryFixture
