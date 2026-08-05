import Foundation
import GRDB
import XCTest

@testable import EnchiridionCore

final class BookmarkRepositoryTests: XCTestCase {
  func testMaterializationIsAtomicAndCreatesBookmarkPageWithSourceURL() async throws {
    let fixture = try BookmarkRepositoryFixture(testCase: self)
    let invalid = request(url: "file:///not-a-bookmark")

    do {
      _ = try await fixture.repository.materializeBookmark(invalid)
      XCTFail("An invalid URL must not materialize a partial bookmark")
    } catch let error as LibraryRepositoryError {
      XCTAssertEqual(error, .invalidRecord)
    }
    let pagesAfterInvalid = try await fixture.repository.pages(in: .allPages)
    let eventsAfterInvalid = try await fixture.repository.bookmarkCaptureEvents()
    XCTAssertTrue(pagesAfterInvalid.isEmpty)
    XCTAssertTrue(eventsAfterInvalid.isEmpty)

    let capture = request(url: "https://example.com/article", note: "Read later")
    let result = try await fixture.repository.materializeBookmark(capture)
    let storedPage = try await fixture.repository.page(id: result.pageID)
    let page = try XCTUnwrap(storedPage)
    let sourceURL = SupertagPropertyKey(
      supertagID: BuiltInSupertags.bookmark,
      fieldID: BuiltInSupertags.bookmarkSourceURLField
    )

    XCTAssertFalse(result.duplicate)
    XCTAssertTrue(page.hasSupertag(BuiltInSupertags.bookmark))
    XCTAssertEqual(page.objectMetadata.properties[sourceURL], [.url(capture.submittedURL)])
    let events = try await fixture.repository.bookmarkCaptureEvents()
    XCTAssertEqual(events, [
      .init(
        captureID: capture.captureID, urlKey: result.urlKey, submittedURL: capture.submittedURL,
        note: capture.note, capturedAt: capture.capturedAt, dayKey: capture.dayKey,
        timeZoneIdentifier: capture.timeZoneIdentifier, source: capture.source,
        platform: capture.platform, vaultID: capture.vaultID)
    ])
  }

  func testPermanentDeletionWaitsForCarrierAckThenSuppressesReplayWithoutAReceipt() async throws {
    let fixture = try BookmarkRepositoryFixture(testCase: self)
    let original = request(url: "https://example.com/original")
    let captured = try await fixture.repository.materializeBookmark(original)
    try await fixture.repository.moveToTrash(
      pageID: captured.pageID,
      now: original.capturedAt.addingTimeInterval(1)
    )
    try await fixture.repository.purge(
      pageID: captured.pageID,
      now: original.capturedAt.addingTimeInterval(2)
    )

    let pendingState = try await fixture.repository.bookmarkSuppressionState(for: captured.urlKey)
    let pending = try XCTUnwrap(pendingState)
    let carrierID = try XCTUnwrap(pending.carrierPageID)
    let requiredGeneration = try XCTUnwrap(pending.requiredGeneration)
    let candidateBeforeAck = try await fixture.repository.page(id: captured.pageID)
    XCTAssertEqual(pending.stage, .carrierPendingAck)
    XCTAssertTrue(pending.permanentRequested)
    XCTAssertNotNil(candidateBeforeAck)

    _ = try await fixture.repository.markCloudSaved(
      pageID: carrierID,
      sentGeneration: requiredGeneration,
      systemFields: Data("carrier-ack".utf8)
    )

    let candidateAfterAck = try await fixture.repository.page(id: captured.pageID)
    let eventsAfterAck = try await fixture.repository.bookmarkCaptureEvents()
    let resolvedAfterAck = try await fixture.repository.resolvedBookmarkPages()
    let allPagesAfterAck = try await fixture.repository.pages(in: .allPages)
    let trashAfterAck = try await fixture.repository.pages(in: .trash)
    let stableState = try await fixture.repository.bookmarkSuppressionState(for: captured.urlKey)
    let carrierAfterAck = try await fixture.repository.page(id: carrierID)
    let carrierIDs = try await fixture.repository.bookmarkDeletionCarrierPageIDs(
      urlKeyDigest: captured.urlKey.digest
    )
    let receiptCount = try await DatabaseQueue(path: fixture.path).read { db in
      try Int.fetchOne(
        db,
        sql: "SELECT COUNT(*) FROM bookmark_capture_receipts WHERE capture_id = ?",
        arguments: [original.captureID.uuidString.lowercased()]
      ) ?? -1
    }

    XCTAssertNil(candidateAfterAck)
    XCTAssertTrue(eventsAfterAck.isEmpty)
    XCTAssertTrue(resolvedAfterAck.isEmpty)
    XCTAssertTrue(allPagesAfterAck.isEmpty)
    XCTAssertTrue(trashAfterAck.isEmpty)
    XCTAssertEqual(stableState?.stage, .stable)
    XCTAssertNotNil(carrierAfterAck)
    XCTAssertEqual(carrierIDs, [carrierID])
    XCTAssertEqual(receiptCount, 0)

    let replays = [
      original,
      request(
        captureID: UUID(uuidString: "00000000-0000-0000-0000-000000000099")!,
        url: original.submittedURL,
        capturedAt: original.capturedAt.addingTimeInterval(3)
      ),
    ]
    for replay in replays {
      do {
        _ = try await fixture.repository.materializeBookmark(replay)
        XCTFail("A permanently suppressed URL must not allocate a replacement Page")
      } catch let error as LibraryRepositoryError {
        XCTAssertEqual(error, .bookmarkSuppressed)
      }
    }
  }

  func testSameURLUsesOneIdentityAndRecordsEveryCapture() async throws {
    let fixture = try BookmarkRepositoryFixture(testCase: self)
    let first = request(url: "HTTPS://Example.COM:443/article")
    let second = request(
      url: "https://example.com/article",
      capturedAt: first.capturedAt.addingTimeInterval(1)
    )

    let firstResult = try await fixture.repository.materializeBookmark(first)
    let secondResult = try await fixture.repository.materializeBookmark(second)

    XCTAssertEqual(firstResult.pageID, secondResult.pageID)
    XCTAssertFalse(firstResult.duplicate)
    XCTAssertTrue(secondResult.duplicate)
    let resolved = try await fixture.repository.resolvedBookmarkPages()
    let events = try await fixture.repository.bookmarkCaptureEvents()
    XCTAssertEqual(resolved.map(\.id), [firstResult.pageID])
    XCTAssertEqual(events.map(\.captureID), [first.captureID, second.captureID])
  }

  func testDeletionIsMonotonicAndDoesNotAllocateAReplacement() async throws {
    let fixture = try BookmarkRepositoryFixture(testCase: self)
    let first = request(url: "https://example.com/deleted")
    let identity = try await fixture.repository.materializeBookmark(first)
    let deletedAt = first.capturedAt.addingTimeInterval(1)
    try await fixture.repository.deleteBookmarkIdentity(
      .init(deletionID: UUID(), urlKey: identity.urlKey), now: deletedAt
    )

    let later = try await fixture.repository.materializeBookmark(request(url: first.submittedURL))

    XCTAssertEqual(later.pageID, identity.pageID)
    XCTAssertTrue(later.duplicate)
    let resolved = try await fixture.repository.resolvedBookmarkPages()
    let events = try await fixture.repository.bookmarkCaptureEvents()
    let pages = try await fixture.repository.pages(in: .allPages)
    let trash = try await fixture.repository.pages(in: .trash)
    let candidate = try await fixture.repository.page(id: identity.pageID)
    XCTAssertTrue(resolved.isEmpty)
    XCTAssertTrue(events.isEmpty)
    XCTAssertTrue(pages.isEmpty)
    XCTAssertEqual(trash.map(\.id), [identity.pageID])
    XCTAssertEqual(candidate?.deletedAt, deletedAt)
  }

  func testWinnerAndAliasesUseLexicographicPageID() async throws {
    let fixture = try BookmarkRepositoryFixture(testCase: self)
    let request = request(url: "https://example.com/alias")
    let first = try await fixture.repository.materializeBookmark(request)
    let alias = try await fixture.repository.createTaggedPage(
      title: "Alias", supertagID: BuiltInSupertags.bookmark)
    let key = try XCTUnwrap(BookmarkURLKey(submittedURL: request.submittedURL))
    try await DatabaseQueue(path: fixture.path).write { db in
      try db.execute(
        sql: """
          INSERT INTO bookmark_identity_candidates (url_key_digest,url_key_version,canonical_url,page_id)
          VALUES (?,?,?,?)
          """,
        arguments: [key.digest, BookmarkURLKey.version, key.canonicalURL, alias.id.rawValue]
      )
    }

    let winner = first.pageID.rawValue < alias.id.rawValue ? first.pageID : alias.id
    let losing = winner == first.pageID ? alias.id : first.pageID

    let resolved = try await fixture.repository.resolvedBookmarkPages()
    let aliases = try await fixture.repository.bookmarkAliases()
    XCTAssertEqual(resolved.map(\.id), [winner])
    XCTAssertEqual(aliases, [
      .init(urlKey: key, winner: winner, alias: losing)
    ])
  }

  func testCloudMergedBookmarkPageRebuildsLocalIdentityWithoutCaptureHistory() async throws {
    let source = try BookmarkRepositoryFixture(testCase: self)
    let destination = try BookmarkRepositoryFixture(testCase: self)
    let captured = try await source.repository.materializeBookmark(
      request(url: "https://example.com/synced-page")
    )
    let sourcePage = try await source.repository.page(id: captured.pageID)
    let page = try XCTUnwrap(sourcePage)

    _ = try await destination.repository.mergeCloudPage(
      pageID: page.id, kind: page.kind, remoteDocument: page.document, systemFields: Data()
    )

    let resolved = try await destination.repository.resolvedBookmarkPages()
    let events = try await destination.repository.bookmarkCaptureEvents()
    XCTAssertEqual(resolved.map(\.id), [page.id])
    XCTAssertTrue(events.isEmpty)
  }

  private func request(
    captureID: UUID = UUID(), url: String, note: String? = nil,
    capturedAt: Date = Date(timeIntervalSince1970: 1_754_352_000)
  ) -> BookmarkCaptureRequest {
    .init(
      captureID: captureID, submittedURL: url, note: note,
      capturedAt: capturedAt,
      dayKey: .init(rawValue: "2026-08-05"), timeZoneIdentifier: "Europe/London",
      source: "test", platform: "test", vaultID: .standalone
    )
  }
}

private struct BookmarkRepositoryFixture {
  let path: String
  let repository: LibraryRepository

  init(testCase: XCTestCase) throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("BookmarkRepositoryTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    testCase.addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    path = directory.appendingPathComponent("graph.sqlite").path
    repository = try LibraryRepository(path: path)
  }
}
