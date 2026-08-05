import Foundation
import XCTest
@testable import EnchiridionCore

final class CaptureInboxStoreTests: XCTestCase {
  func testFractionalTimestampIsIdenticalBeforeAndAfterQueueReplay() async throws {
    let capturedAt = Date(timeIntervalSince1970: 1_786_000_000.123_456)
    let request = BookmarkCaptureRequest(
      captureID: UUID(),
      submittedURL: "https://example.com/article",
      capturedAt: capturedAt,
      dayKey: .init(rawValue: "2026-08-05"),
      timeZoneIdentifier: "UTC",
      source: "share",
      platform: "iOS",
      vaultID: .personal
    )
    let payload = BookmarkCaptureInboxPayload(request: request)
    XCTAssertEqual(payload.capturedAt.timeIntervalSince1970, 1_786_000_000.123, accuracy: 0.000_001)

    let path = try temporaryPath()
    let captureID = UUID()
    let store = try CaptureInboxStore(path: path)
    let result = try await store.enqueue(captureID: captureID, payload: payload, vaultID: .personal)
    guard case .enqueued(let inMemoryRecord) = result else {
      return XCTFail("Expected a new queue record")
    }
    XCTAssertEqual(payload, inMemoryRecord.payload)
    let reopened = try CaptureInboxStore(path: path)
    let persistedRecord = try await reopened.record(captureID)
    let replayedRecord = try XCTUnwrap(persistedRecord)
    XCTAssertEqual(inMemoryRecord.payload, replayedRecord.payload)

    let key = try XCTUnwrap(BookmarkURLKey(submittedURL: payload.submittedURL))
    let inMemoryEvent = try BookmarkSyncedCaptureEvent(
      captureID: captureID,
      urlKey: key,
      submittedURL: payload.submittedURL,
      capturedAt: payload.capturedAt,
      dayKey: payload.dayKey,
      timeZoneIdentifier: payload.timeZoneIdentifier
    )
    let replayedEvent = try BookmarkSyncedCaptureEvent(
      captureID: captureID,
      urlKey: key,
      submittedURL: replayedRecord.payload.submittedURL,
      capturedAt: replayedRecord.payload.capturedAt,
      dayKey: replayedRecord.payload.dayKey,
      timeZoneIdentifier: replayedRecord.payload.timeZoneIdentifier
    )
    XCTAssertEqual(inMemoryEvent, replayedEvent)
  }

  func testLegacyV1ISO8601TimestampStillDecodes() throws {
    struct LegacyPayload: Encodable {
      let submittedURL: String
      let note: String?
      let capturedAt: Date
      let dayKey: DayKey
      let timeZoneIdentifier: String
      let source: String
      let platform: String
    }
    let capturedAt = Date(timeIntervalSince1970: 1_786_000_000)
    let encoded = try JSONEncoder.enchiridion.encode(LegacyPayload(
      submittedURL: "https://example.com/article",
      note: nil,
      capturedAt: capturedAt,
      dayKey: .init(rawValue: "2026-08-05"),
      timeZoneIdentifier: "UTC",
      source: "share",
      platform: "iOS"
    ))

    let decoded = try JSONDecoder.enchiridion.decode(BookmarkCaptureInboxPayload.self, from: encoded)
    XCTAssertEqual(decoded.capturedAt, capturedAt)
    XCTAssertEqual(decoded.submittedURL, "https://example.com/article")
  }

  func testReplayAndPersistenceKeepTheOriginalRoute() async throws {
    let path = try temporaryPath()
    let id = UUID(); let payload = makePayload()
    let store = try CaptureInboxStore(path: path)
    _ = try await store.enqueue(captureID: id, payload: payload, vaultID: .personal)
    let reopened = try CaptureInboxStore(path: path)
    let record = try await reopened.record(id)
    let persisted = try XCTUnwrap(record)
    XCTAssertEqual(persisted.vaultID, .personal)
    let replay = try await reopened.enqueue(captureID: id, payload: payload, vaultID: .init(rawValue: "vault_work"))
    XCTAssertEqual(replay, .existing(persisted))
  }

  func testSameIdentifierWithDifferentPayloadConflicts() async throws {
    let store = try CaptureInboxStore(path: try temporaryPath()); let id = UUID()
    _ = try await store.enqueue(captureID: id, payload: makePayload(), vaultID: .personal)
    // A different note is part of the canonical durable payload.
    let changed = BookmarkCaptureInboxPayload(request: .init(captureID: UUID(), submittedURL: "https://example.com", note: "changed", dayKey: .init(rawValue: "2026-08-05"), timeZoneIdentifier: "UTC", source: "share", platform: "iOS", vaultID: .personal))
    await XCTAssertThrowsErrorAsync(try await store.enqueue(captureID: id, payload: changed, vaultID: .personal)) { XCTAssertEqual($0 as? CaptureInboxStoreError, .conflictingPayload) }
  }

  func testLeaseContentionExpiryAndStaleFinish() async throws {
    let path = try temporaryPath(); let id = UUID(); let first = try CaptureInboxStore(path: path); let second = try CaptureInboxStore(path: path)
    _ = try await first.enqueue(captureID: id, payload: makePayload(), vaultID: .personal)
    let owner = UUID(); let lease = UUID(); let now = Date(timeIntervalSince1970: 1_000)
    let firstClaim = try await first.claim(ownerID: owner, leaseID: lease, leaseDuration: 2, now: now)
    XCTAssertEqual(firstClaim.count, 1)
    let contendedClaim = try await second.claim(ownerID: UUID(), now: now)
    XCTAssertTrue(contendedClaim.isEmpty)
    let replacementOwner = UUID(); let replacementLease = UUID()
    let replacementClaim = try await second.claim(ownerID: replacementOwner, leaseID: replacementLease, now: now.addingTimeInterval(3))
    XCTAssertEqual(replacementClaim.count, 1)
    let staleFinish = try await first.finishImported(captureID: id, ownerID: owner, leaseID: lease, now: now.addingTimeInterval(3))
    XCTAssertFalse(staleFinish)
  }

  func testDigestPurgeRemovesEveryQueueStateAndInvalidatesAnActiveLease() async throws {
    let store = try CaptureInboxStore(path: try temporaryPath())
    let pendingID = UUID(), leasedID = UUID(), importedID = UUID(), quarantinedID = UUID()
    let differentID = UUID()
    let matchingURLs = [
      "https://EXAMPLE.com:443/%7Earticle",
      "https://example.com/~article",
      "https://example.com/%7earticle",
      "https://EXAMPLE.COM/~article",
    ]
    let ids = [pendingID, leasedID, importedID, quarantinedID]
    for (index, id) in ids.enumerated() {
      _ = try await store.enqueue(
        captureID: id,
        payload: makePayload(submittedURL: matchingURLs[index]),
        vaultID: .personal,
        now: Date(timeIntervalSince1970: TimeInterval(index))
      )
    }
    _ = try await store.enqueue(
      captureID: differentID,
      payload: makePayload(submittedURL: "https://example.com/other"),
      vaultID: .personal,
      now: Date(timeIntervalSince1970: 10)
    )

    let ownerID = UUID(), leaseID = UUID(), leaseNow = Date(timeIntervalSince1970: 100)
    let claimed = try await store.claim(ownerID: ownerID, leaseID: leaseID, leaseDuration: 60, limit: 4, now: leaseNow)
    XCTAssertEqual(claimed.count, 4)
    let released = try await store.release(captureID: pendingID, ownerID: ownerID, leaseID: leaseID, now: leaseNow)
    XCTAssertTrue(released)
    let finished = try await store.finishImported(captureID: importedID, ownerID: ownerID, leaseID: leaseID, now: leaseNow)
    XCTAssertTrue(finished)
    let quarantined = try await store.quarantine(captureID: quarantinedID, ownerID: ownerID, leaseID: leaseID, reason: "test", now: leaseNow)
    XCTAssertTrue(quarantined)

    let digest = try XCTUnwrap(BookmarkURLKey(submittedURL: matchingURLs[0])).digest
    let purgeCount = try await store.purgeURLKeyDigests([digest])
    XCTAssertEqual(purgeCount, 4)
    for id in ids {
      let removed = try await store.record(id)
      XCTAssertNil(removed)
    }
    let retained = try await store.record(differentID)
    XCTAssertEqual(retained?.state, .pending)
    let staleFinish = try await store.finishImported(captureID: leasedID, ownerID: ownerID, leaseID: leaseID, now: leaseNow)
    XCTAssertFalse(staleFinish)
    let staleRelease = try await store.release(captureID: leasedID, ownerID: ownerID, leaseID: leaseID, now: leaseNow)
    XCTAssertFalse(staleRelease)
    let remainingIDs = try await store.records().map(\.captureID)
    XCTAssertEqual(remainingIDs, [differentID])
  }

  private func makePayload(submittedURL: String = "https://example.com") -> BookmarkCaptureInboxPayload {
    .init(request: .init(captureID: UUID(), submittedURL: submittedURL, dayKey: .init(rawValue: "2026-08-05"), timeZoneIdentifier: "UTC", source: "share", platform: "iOS", vaultID: .personal))
  }
  private func temporaryPath() throws -> String {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("CaptureInboxTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return directory.appendingPathComponent("inbox.sqlite").path
  }
}

private func XCTAssertThrowsErrorAsync<T>(_ expression: @autoclosure () async throws -> T, _ handler: (Error) -> Void) async {
  do { _ = try await expression(); XCTFail("Expected an error") } catch { handler(error) }
}
