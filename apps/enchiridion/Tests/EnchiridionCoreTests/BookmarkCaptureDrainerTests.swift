import Foundation
import XCTest
@testable import EnchiridionCore

final class BookmarkCaptureDrainerTests: XCTestCase {
  func testSuccessfulDrainImportsAndMarksTheCapture() async throws {
    let fixture = try Fixture()
    let inbox = try CaptureInboxStore(path: fixture.inboxPath)
    let captureID = UUID()
    _ = try await inbox.enqueue(captureID: captureID, payload: fixture.payload(), vaultID: .personal)
    let drainer = BookmarkCaptureDrainer(inbox: inbox, openRepository: { _ in fixture.repository })

    let outcomes = await drainer.drain()
    XCTAssertEqual(outcomes, [.imported])

    let stored = try await inbox.record(captureID)
    let record = try XCTUnwrap(stored)
    XCTAssertEqual(record.state, .imported)
    XCTAssertNotNil(record.importedAt)
    let events = try await fixture.repository.bookmarkCaptureEvents()
    XCTAssertEqual(events.map(\.captureID), [captureID])
  }

  func testReplayAfterGraphCommitUsesTheReceiptAndCompletesTheQueue() async throws {
    let fixture = try Fixture()
    let inbox = try CaptureInboxStore(path: fixture.inboxPath)
    let captureID = UUID()
    let payload = fixture.payload()
    _ = try await inbox.enqueue(captureID: captureID, payload: payload, vaultID: .personal)

    // Simulate a process dying after the graph transaction commits but before queue acknowledgement.
    let request = payload.request(captureID: captureID, vaultID: .personal)
    let original = try await fixture.repository.materializeBookmark(request)
    XCTAssertFalse(original.duplicate)
    let directReplay = try await fixture.repository.materializeBookmark(request)
    XCTAssertTrue(directReplay.duplicate)

    let drainer = BookmarkCaptureDrainer(inbox: inbox, openRepository: { _ in fixture.repository })
    let outcomes = await drainer.drain()
    XCTAssertEqual(outcomes, [.imported])

    let stored = try await inbox.record(captureID)
    let record = try XCTUnwrap(stored)
    XCTAssertEqual(record.state, .imported)
    let events = try await fixture.repository.bookmarkCaptureEvents()
    XCTAssertEqual(events.map(\.captureID), [captureID])
  }

  func testTransientFailureReturnsTheCaptureToPendingForLaterRetry() async throws {
    let fixture = try Fixture()
    let inbox = try CaptureInboxStore(path: fixture.inboxPath)
    let captureID = UUID()
    _ = try await inbox.enqueue(captureID: captureID, payload: fixture.payload(), vaultID: .personal)
    let failing = BookmarkCaptureDrainer(inbox: inbox, openRepository: { _ in throw TransientFailure.unavailable })

    let failedOutcomes = await failing.drain()
    XCTAssertEqual(failedOutcomes, [.retained])
    let retainedRecord = try await inbox.record(captureID)
    let retained = try XCTUnwrap(retainedRecord)
    XCTAssertEqual(retained.state, .pending)
    XCTAssertEqual(retained.attempts, 1)

    let recovered = BookmarkCaptureDrainer(inbox: inbox, openRepository: { _ in fixture.repository })
    let recoveredOutcomes = await recovered.drain()
    XCTAssertEqual(recoveredOutcomes, [.imported])
    let importedRecord = try await inbox.record(captureID)
    let imported = try XCTUnwrap(importedRecord)
    XCTAssertEqual(imported.state, .imported)
    XCTAssertEqual(imported.attempts, 2)
  }

  func testUnavailableRoutedVaultIsQuarantined() async throws {
    let fixture = try Fixture()
    let inbox = try CaptureInboxStore(path: fixture.inboxPath)
    let captureID = UUID()
    _ = try await inbox.enqueue(captureID: captureID, payload: fixture.payload(), vaultID: .init(rawValue: "removed-vault"))
    let drainer = BookmarkCaptureDrainer(inbox: inbox, openRepository: { _ in throw VaultRegistryError.vaultNotFound })

    let outcomes = await drainer.drain()
    XCTAssertEqual(outcomes, [.quarantined])
    let stored = try await inbox.record(captureID)
    let record = try XCTUnwrap(stored)
    XCTAssertEqual(record.state, .quarantined)
    XCTAssertEqual(record.attempts, 1)
    XCTAssertEqual(record.lastError, VaultRegistryError.vaultNotFound.localizedDescription)
  }

  func testSuppressedCaptureIsTerminalAndRemovesEveryQueuedURLVariant() async throws {
    let fixture = try Fixture()
    let inbox = try CaptureInboxStore(path: fixture.inboxPath)
    let firstID = UUID(), secondID = UUID()
    _ = try await inbox.enqueue(
      captureID: firstID,
      payload: fixture.payload(submittedURL: "https://EXAMPLE.com:443/%7Earticle"),
      vaultID: .personal
    )
    _ = try await inbox.enqueue(
      captureID: secondID,
      payload: fixture.payload(submittedURL: "https://example.com/~article"),
      vaultID: .personal
    )
    let attempts = AttemptCounter()
    let drainer = BookmarkCaptureDrainer(
      inbox: inbox,
      openRepository: { _ in fixture.repository },
      materialize: { _, _ in
        await attempts.increment()
        throw LibraryRepositoryError.bookmarkSuppressed
      }
    )

    let outcomes = await drainer.drain(limit: 2)
    // The first suppression removes both rows. The second already-claimed record remains a
    // terminal success even though its idempotent digest purge therefore removes zero rows.
    XCTAssertEqual(outcomes, [.imported, .imported])
    let records = try await inbox.records()
    XCTAssertTrue(records.isEmpty)
    let firstAttemptCount = await attempts.value
    XCTAssertEqual(firstAttemptCount, 2)
    let replayOutcomes = await drainer.drain()
    XCTAssertTrue(replayOutcomes.isEmpty)
    let finalAttemptCount = await attempts.value
    XCTAssertEqual(finalAttemptCount, 2)
  }

  func testCompletedPermanentDeletionHandoffPurgesQueuedPayload() async throws {
    let fixture = try Fixture()
    let inbox = try CaptureInboxStore(path: fixture.inboxPath)
    let queuedID = UUID()
    let payload = fixture.payload(
      submittedURL: "https://example.com/permanent",
      capturedAt: Date(timeIntervalSince1970: 1_754_352_000)
    )
    _ = try await inbox.enqueue(captureID: queuedID, payload: payload, vaultID: .personal)

    let graphRequest = payload.request(captureID: UUID(), vaultID: .personal)
    let bookmark = try await fixture.repository.materializeBookmark(graphRequest)
    try await fixture.repository.moveToTrash(
      pageID: bookmark.pageID,
      now: graphRequest.capturedAt.addingTimeInterval(1)
    )
    try await fixture.repository.purge(
      pageID: bookmark.pageID,
      now: graphRequest.capturedAt.addingTimeInterval(2)
    )
    let storedState = try await fixture.repository.bookmarkSuppressionState(for: bookmark.urlKey)
    let state = try XCTUnwrap(storedState)
    let carrierID = try XCTUnwrap(state.carrierPageID)
    let storedCarrier = try await fixture.repository.page(id: carrierID)
    let carrier = try XCTUnwrap(storedCarrier)
    _ = try await fixture.repository.markCloudSaved(
      pageID: carrierID,
      sentGeneration: carrier.dirtyGeneration,
      systemFields: Data("acked".utf8)
    )

    let drainer = BookmarkCaptureDrainer(inbox: inbox, openRepository: { _ in fixture.repository })
    let removed = await drainer.purgePermanentDeletionHandoffs(vaultIDs: [.personal])
    XCTAssertEqual(removed, 1)
    let queuedAfterHandoff = try await inbox.record(queuedID)
    XCTAssertNil(queuedAfterHandoff)
  }

  func testDrainIsBoundedAndSerialized() async throws {
    let fixture = try Fixture()
    let inbox = try CaptureInboxStore(path: fixture.inboxPath)
    for _ in 0 ..< 3 {
      _ = try await inbox.enqueue(captureID: UUID(), payload: fixture.payload(), vaultID: .personal)
    }
    let drainer = BookmarkCaptureDrainer(inbox: inbox, openRepository: { _ in fixture.repository })

    async let first = drainer.drain(limit: 2)
    async let second = drainer.drain(limit: 2)
    let outcomes = await [first, second]
    XCTAssertEqual(outcomes.flatMap { $0 }.count, 2)
    let records = try await inbox.records()
    XCTAssertEqual(records.filter { $0.state == .imported }.count, 2)
    XCTAssertEqual(records.filter { $0.state == .pending }.count, 1)

    let remaining = await drainer.drain(limit: 2)
    XCTAssertEqual(remaining, [.imported])
  }

  private enum TransientFailure: Error { case unavailable }

  private final class Fixture: @unchecked Sendable {
    let directory: URL
    let inboxPath: String
    let repository: LibraryRepository

    init() throws {
      directory = FileManager.default.temporaryDirectory.appendingPathComponent("BookmarkCaptureDrainerTests-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      inboxPath = directory.appendingPathComponent("inbox.sqlite").path
      repository = try LibraryRepository(path: directory.appendingPathComponent("graph.sqlite").path)
    }

    deinit { try? FileManager.default.removeItem(at: directory) }

    func payload(
      submittedURL: String = "https://example.com/article",
      capturedAt: Date = Date()
    ) -> BookmarkCaptureInboxPayload {
      .init(request: .init(
        captureID: UUID(),
        submittedURL: submittedURL,
        capturedAt: capturedAt,
        dayKey: .init(rawValue: "2026-08-05"),
        timeZoneIdentifier: "UTC",
        source: "share",
        platform: "iOS",
        vaultID: .personal
      ))
    }
  }
}

private actor AttemptCounter {
  private var attempts = 0
  var value: Int { attempts }
  func increment() { attempts += 1 }
}
