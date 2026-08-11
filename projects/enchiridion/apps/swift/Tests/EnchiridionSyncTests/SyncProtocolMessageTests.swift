// SyncProtocolMessageTests.swift
// EnchiridionSyncTests

import Foundation
import XCTest

@testable import EnchiridionCore
@testable import EnchiridionSync

final class SyncProtocolMessageTests: XCTestCase {
  private func roundTrip(_ message: SyncProtocolMessage) throws -> SyncProtocolMessage {
    // Must use the shared `.vaultSyncProtocol` coders, not bare
    // `JSONEncoder()`/`JSONDecoder()` — a plain pair would round-trip fine
    // *within Swift* (Foundation's default `.deferredToDate` is internally
    // consistent) while still producing the wrong wire bytes for the TS
    // side, which is exactly the bug this suite guards against elsewhere
    // (see `testCatalogEntryDateFieldsEncodeAsUnixEpochMilliseconds` below).
    let data = try JSONEncoder.vaultSyncProtocol.encode(message)
    return try JSONDecoder.vaultSyncProtocol.decode(SyncProtocolMessage.self, from: data)
  }

  func testCatalogRequestRoundTrips() throws {
    XCTAssertEqual(try roundTrip(.catalogRequest), .catalogRequest)
  }

  func testCatalogDiffRoundTrips() throws {
    let entries = [
      CatalogEntry(
        pageID: PageID.daily(DayKey(rawValue: "2026-08-06")),
        docType: "daily",
        createdAt: Date(timeIntervalSince1970: 1_700_000_000),
        tombstoned: false,
        updatedAt: Date(timeIntervalSince1970: 1_700_000_050)
      ),
      CatalogEntry(
        pageID: .free(UUID(uuidString: "00000000-0000-0000-0000-000000000001")!),
        docType: "note",
        createdAt: Date(timeIntervalSince1970: 1_700_000_100),
        tombstoned: true,
        updatedAt: Date(timeIntervalSince1970: 1_700_000_200)
      ),
    ]
    let message = SyncProtocolMessage.catalogDiff(entries: entries)
    XCTAssertEqual(try roundTrip(message), message)
  }

  func testDocVersionVectorRoundTrips() throws {
    let message = SyncProtocolMessage.docVersionVector(
      pageID: .free(UUID(uuidString: "00000000-0000-0000-0000-000000000002")!),
      versionVector: Data([0x01, 0x02, 0x03, 0xFF])
    )
    XCTAssertEqual(try roundTrip(message), message)
  }

  func testDocUpdateRoundTrips() throws {
    let message = SyncProtocolMessage.docUpdate(
      pageID: .free(UUID(uuidString: "00000000-0000-0000-0000-000000000003")!),
      bytes: Data(repeating: 0xAB, count: 128)
    )
    XCTAssertEqual(try roundTrip(message), message)
  }

  func testDocFullSnapshotRoundTrips() throws {
    let message = SyncProtocolMessage.docFullSnapshot(
      pageID: .free(UUID(uuidString: "00000000-0000-0000-0000-000000000004")!),
      bytes: Data(repeating: 0xCD, count: 4096)
    )
    XCTAssertEqual(try roundTrip(message), message)
  }

  func testTombstoneRoundTrips() throws {
    let deleteMessage = SyncProtocolMessage.tombstone(
      pageID: .free(UUID(uuidString: "00000000-0000-0000-0000-000000000005")!),
      undelete: false
    )
    XCTAssertEqual(try roundTrip(deleteMessage), deleteMessage)

    let undeleteMessage = SyncProtocolMessage.tombstone(
      pageID: .free(UUID(uuidString: "00000000-0000-0000-0000-000000000005")!),
      undelete: true
    )
    XCTAssertEqual(try roundTrip(undeleteMessage), undeleteMessage)
  }

  func testWireFormatUsesStableTypeDiscriminator() throws {
    // Guards the "legible from the TS side" design goal in
    // SyncProtocolMessage.swift's header comment: assert the JSON shape
    // itself, not just that Swift can decode what Swift encoded.
    let message = SyncProtocolMessage.tombstone(
      pageID: PageID(rawValue: "page_test"),
      undelete: false
    )
    let data = try JSONEncoder.vaultSyncProtocol.encode(message)
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    XCTAssertEqual(object?["type"] as? String, "tombstone")
    XCTAssertEqual(object?["pageID"] as? String, "page_test")
    XCTAssertEqual(object?["undelete"] as? Bool, false)
  }

  // MARK: - Wire-shape parity with the TS side (workers/vault/src)
  //
  // SHARED FIXTURE — if you change this instant or these field values on
  // EITHER side, change it on both, or this stops proving anything:
  //
  //   pageID:    "daily:2026-08-06"
  //   docType:   "daily"
  //   createdAt: 1000  (epoch-ms)  == 1 second past the Unix epoch
  //   updatedAt: 1000  (epoch-ms)
  //   tombstoned: false
  //
  // This exact entry is asserted byte-for-byte against
  // `workers/vault/src/sync-protocol.test.ts`'s first `catalogDiff` case
  // (the `daily:2026-08-06` entry at line 17 of that file, part of the
  // "sync-protocol — round trips for every message type" describe block).
  // These two tests don't run in the same process — there's no way to
  // enforce this at compile time — so this comment IS the contract: it's
  // the thing a future reviewer/CI reader has to notice broke if one side's
  // fixture changes without the other's.

  func testCatalogEntryDateFieldsEncodeAsUnixEpochMilliseconds() throws {
    // Regression test for the interop bug: Foundation's default `Date`
    // `Codable` conformance (`.deferredToDate`) encodes seconds since the
    // 2001 Cocoa reference date, not Unix epoch milliseconds. A round-trip
    // test alone (encode-then-decode with the SAME misconfigured coder)
    // can never catch this, because both sides of that round trip agree
    // with each other, just not with the TS side of the wire. This test
    // instead asserts the literal JSON *number*.
    let entry = CatalogEntry(
      pageID: PageID.daily(DayKey(rawValue: "2026-08-06")),
      docType: "daily",
      createdAt: Date(timeIntervalSince1970: 1.0),  // 1000ms since Unix epoch
      tombstoned: false,
      updatedAt: Date(timeIntervalSince1970: 1.0)  // 1000ms since Unix epoch
    )
    let message = SyncProtocolMessage.catalogDiff(entries: [entry])
    let data = try JSONEncoder.vaultSyncProtocol.encode(message)
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let entries = object?["entries"] as? [[String: Any]]
    XCTAssertEqual(entries?.count, 1)
    let wireEntry = entries?.first

    // Field-for-field match against
    // workers/vault/src/sync-protocol.test.ts:17's
    // `{ pageID: "daily:2026-08-06", docType: "daily", createdAt: 1000,
    //    tombstoned: false, updatedAt: 1000 }`.
    XCTAssertEqual(wireEntry?["pageID"] as? String, "daily:2026-08-06")
    XCTAssertEqual(wireEntry?["docType"] as? String, "daily")
    XCTAssertEqual(wireEntry?["tombstoned"] as? Bool, false)
    XCTAssertEqual(wireEntry?["createdAt"] as? Double, 1000)
    XCTAssertEqual(wireEntry?["updatedAt"] as? Double, 1000)

    // Decode side of the same contract: an incoming frame with epoch-ms
    // integers must decode back to the instant those milliseconds denote,
    // not be misread as Cocoa-reference-seconds.
    let decoded = try JSONDecoder.vaultSyncProtocol.decode(
      SyncProtocolMessage.self, from: data)
    XCTAssertEqual(decoded, message)
  }
}
