import Foundation
import GRDB
import XCTest

@testable import EnchiridionCore

final class CalendarProjectionGenerationTests: XCTestCase {
  func testExactGenerationResumesInBatchesAndTagsEventPages() async throws {
    let fixture = try CalendarProjectionFixture()
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let now = Date(timeIntervalSince1970: 1_830_000_000)
    let events = (0..<40).map { event("\($0)", now.addingTimeInterval(Double($0) * 60)) }
    let token = try await fixture.repository.beginAuthoritativeCalendarRefresh(provider: "eventkit", now: now)
    let first = try await fixture.repository.applyAuthoritativeCalendarProjection(
      .init(provider: "eventkit", interval: .init(start: now.addingTimeInterval(-60), end: now.addingTimeInterval(3600)), events: events),
      token: token, now: now
    )
    var receipt = first
    while !receipt.isTerminal {
      receipt = try await fixture.repository.resumeAuthoritativeCalendarProjection(provider: "eventkit", batchLimit: 1, now: now)
    }
    let pages = try await fixture.repository.pages(with: BuiltInSupertags.event)
    XCTAssertEqual(pages.count, 40)
    XCTAssertTrue(pages.allSatisfy { $0.hasSupertag(BuiltInSupertags.event) })
    let generation = try await fixture.repository.calendarProjectionGeneration(provider: "eventkit")
    XCTAssertEqual(generation?.status, .completed)
  }

  func testSupersededGenerationIsANoopAndLatestProjectionWins() async throws {
    let fixture = try CalendarProjectionFixture()
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let now = Date(timeIntervalSince1970: 1_830_100_000)
    let stale = try await fixture.repository.beginAuthoritativeCalendarRefresh(provider: "eventkit", now: now)
    let current = try await fixture.repository.beginAuthoritativeCalendarRefresh(provider: "eventkit", now: now.addingTimeInterval(1))
    do {
      _ = try await fixture.repository.applyAuthoritativeCalendarProjection(
        .init(provider: "eventkit", interval: .init(start: now, end: now.addingTimeInterval(3600)), events: [self.event("old", now)]), token: stale, now: now
      )
      XCTFail("Expected stale token to be rejected")
    } catch {
    }
    _ = try await fixture.repository.applyAuthoritativeCalendarProjection(
      .init(provider: "eventkit", interval: .init(start: now, end: now.addingTimeInterval(3600)), events: [event("new", now)]), token: current, now: now
    )
    let calendar = try await fixture.repository.calendarEvents(from: now.addingTimeInterval(-1), through: now.addingTimeInterval(3600))
    XCTAssertEqual(calendar.map { $0.title }, ["Event new"])
  }

  func testInvalidPartitionDoesNotPreventValidProjection() async throws {
    let fixture = try CalendarProjectionFixture()
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let now = Date(timeIntervalSince1970: 1_830_200_000)
    var invalid = event("invalid", now)
    invalid.iCalendarUID = nil
    let token = try await fixture.repository.beginAuthoritativeCalendarRefresh(provider: "eventkit", now: now)
    let receipt = try await fixture.repository.applyAuthoritativeCalendarProjection(
      .init(provider: "eventkit", interval: .init(start: now, end: now.addingTimeInterval(3600)), events: [invalid, event("valid", now.addingTimeInterval(60))]), token: token, now: now
    )
    XCTAssertEqual(receipt.skippedCount, 1)
    let calendar = try await fixture.repository.calendarEvents(from: now, through: now.addingTimeInterval(3600))
    XCTAssertEqual(calendar.count, 1)
  }

  func testDisableAndOmissionInvalidationKeepEventPages() async throws {
    let fixture = try CalendarProjectionFixture()
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let now = Date(timeIntervalSince1970: 1_830_300_000)
    let token = try await fixture.repository.beginAuthoritativeCalendarRefresh(provider: "eventkit", now: now)
    _ = try await fixture.repository.applyAuthoritativeCalendarProjection(
      .init(provider: "eventkit", interval: .init(start: now, end: now.addingTimeInterval(3600)), events: [event("keep", now)]), token: token, now: now
    )
    let initialPages = try await fixture.repository.pages(with: BuiltInSupertags.event)
    XCTAssertEqual(initialPages.count, 1)
    try await fixture.repository.setCalendarEventOmissionPrefixes(["Ignore"])
    try await fixture.repository.setCalendarEventMaterializationEnabled(false)
    let retainedPages = try await fixture.repository.pages(with: BuiltInSupertags.event)
    XCTAssertEqual(retainedPages.count, 1)
  }

  func testLegacyUpgradeProgressesBeyondOneBoundedSlice() async throws {
    let fixture = try CalendarProjectionFixture()
    let now = Date(timeIntervalSince1970: 1_831_000_000)
    let events = (0..<40).map { event("legacy-\($0)", now.addingTimeInterval(Double($0) * 60)) }
    _ = try await fixture.repository.replaceCalendarProjection(events, provider: "eventkit", refreshedAt: now)
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let first = try await fixture.repository.materializeActiveCalendarProjectionForUpgrade(eligibleProviders: ["eventkit"], now: now)
    let second = try await fixture.repository.materializeActiveCalendarProjectionForUpgrade(eligibleProviders: ["eventkit"], now: now.addingTimeInterval(1))
    XCTAssertEqual(first.changedPageIDs.count, 32)
    XCTAssertEqual(second.changedPageIDs.count, 8)
    let pages = try await fixture.repository.pages(with: BuiltInSupertags.event)
    XCTAssertEqual(pages.count, 40)
  }

  func testLegacyUpgradeHonorsExplicitDisableAndAccessInvalidation() async throws {
    let fixture = try CalendarProjectionFixture()
    let now = Date(timeIntervalSince1970: 1_831_100_000)
    _ = try await fixture.repository.replaceCalendarProjection([event("blocked", now)], provider: "eventkit", refreshedAt: now)
    try await fixture.repository.setCalendarEventMaterializationEnabled(false)
    let disabled = try await fixture.repository.materializeActiveCalendarProjectionForUpgrade(eligibleProviders: ["eventkit"], now: now)
    XCTAssertTrue(disabled.changedPageIDs.isEmpty)
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    try await fixture.repository.invalidateCalendarProjectionAccess(provider: "eventkit", now: now)
    let revoked = try await fixture.repository.materializeActiveCalendarProjectionForUpgrade(now: now)
    XCTAssertTrue(revoked.changedPageIDs.isEmpty)
  }

  func testLegacyUpgradeSkipsMoreThanOneWindowOfPoisonRows() async throws {
    let fixture = try CalendarProjectionFixture()
    let now = Date(timeIntervalSince1970: 1_831_200_000)
    let valid = event("after-poison", now)
    let queue = try DatabaseQueue(path: fixture.path)
    try await queue.write { db in
      for index in 0..<257 {
        try db.execute(
          sql: "INSERT INTO calendar_events (event_key,provider,event_json,start_at,end_at,active,refreshed_at) VALUES (?,?,?,?,?,?,?)",
          arguments: ["poison-\(index)", "eventkit", Data("not-json".utf8), Double(index), Double(index + 1), true, now.timeIntervalSince1970]
        )
      }
      try db.execute(
        sql: "INSERT INTO calendar_events (event_key,provider,event_json,start_at,end_at,active,refreshed_at) VALUES (?,?,?,?,?,?,?)",
        arguments: [valid.identity.stableKey, "eventkit", try JSONEncoder.enchiridion.encode(valid), now.timeIntervalSince1970, now.addingTimeInterval(1_800).timeIntervalSince1970, true, now.timeIntervalSince1970]
      )
    }
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    _ = try await fixture.repository.materializeActiveCalendarProjectionForUpgrade(eligibleProviders: ["eventkit"], now: now)
    let second = try await fixture.repository.materializeActiveCalendarProjectionForUpgrade(eligibleProviders: ["eventkit"], now: now.addingTimeInterval(1))
    XCTAssertEqual(second.changedPageIDs.count, 1)
    let pages = try await fixture.repository.pages(with: BuiltInSupertags.event)
    XCTAssertEqual(pages.map { $0.title }, [valid.title])
  }

  func testLegacyUpgradeRejectsDecodedProviderMismatchAndRecordsStoredKey() async throws {
    let fixture = try CalendarProjectionFixture()
    let now = Date(timeIntervalSince1970: 1_831_300_000)
    var google = event("google-hidden", now)
    google.identity.provider = "google"
    let mismatchedGoogle = google
    let eventKit = event("source-key-mismatch", now.addingTimeInterval(60))
    let queue = try DatabaseQueue(path: fixture.path)
    try await queue.write { db in
      for (key, event) in [("stored-eventkit-google", mismatchedGoogle), ("stored-different-key", eventKit)] {
        try db.execute(sql: "INSERT INTO calendar_events (event_key,provider,event_json,start_at,end_at,active,refreshed_at) VALUES (?,?,?,?,?,?,?)", arguments: [key, "eventkit", try JSONEncoder.enchiridion.encode(event), event.startDate.timeIntervalSince1970, event.endDate.timeIntervalSince1970, true, now.timeIntervalSince1970])
      }
    }
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let first = try await fixture.repository.materializeActiveCalendarProjectionForUpgrade(eligibleProviders: ["eventkit"], now: now)
    let second = try await fixture.repository.materializeActiveCalendarProjectionForUpgrade(eligibleProviders: ["eventkit"], now: now.addingTimeInterval(1))
    XCTAssertEqual(first.changedPageIDs.count, 1)
    XCTAssertTrue(second.changedPageIDs.isEmpty)
    let pages = try await fixture.repository.pages(with: BuiltInSupertags.event)
    XCTAssertEqual(pages.map { $0.title }, [eventKit.title])
  }

  func testV34MigratesV33SkipTableWithPortableUniqueIndex() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("calendar-v33-migration-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("library.sqlite").path
    _ = try LibraryRepository(path: path) // establish the current schema
    let queue = try DatabaseQueue(path: path)
    try queue.write { db in
      try db.execute(sql: "DROP INDEX calendar_legacy_upgrade_skips_source_rowid")
      try db.execute(sql: "ALTER TABLE calendar_legacy_upgrade_skips RENAME TO calendar_legacy_upgrade_skips_v34")
      try db.execute(sql: "CREATE TABLE calendar_legacy_upgrade_skips (event_key TEXT PRIMARY KEY NOT NULL, reason TEXT NOT NULL, recorded_at DOUBLE NOT NULL)")
      try db.execute(sql: "INSERT INTO calendar_legacy_upgrade_skips (event_key,reason,recorded_at) SELECT event_key,reason,recorded_at FROM calendar_legacy_upgrade_skips_v34")
      try db.execute(sql: "DROP TABLE calendar_legacy_upgrade_skips_v34")
      try db.execute(sql: "DELETE FROM grdb_migrations WHERE identifier = ?", arguments: ["v34-calendar-legacy-upgrade-poison-rows"])
    }
    _ = try LibraryRepository(path: path) // must apply v34 to the v33 shape
    let indexes = try queue.read { db in
      try Row.fetchAll(db, sql: "PRAGMA index_list(calendar_legacy_upgrade_skips)")
    }
    XCTAssertTrue(indexes.contains { ($0["name"] as String?) == "calendar_legacy_upgrade_skips_source_rowid" })
  }

  private func event(_ id: String, _ start: Date) -> CalendarEventSnapshot {
    .init(
      identity: .init(provider: "eventkit", externalIdentifier: id, occurrenceStart: start),
      title: "Event \(id)", startDate: start, endDate: start.addingTimeInterval(1800),
      isAllDay: false, location: nil, notes: nil, url: nil, calendarTitle: "Calendar",
      iCalendarUID: "\(id)@example.test", originalStartDate: start, timeZoneIdentifier: "UTC"
    )
  }
}

private final class CalendarProjectionFixture {
  let path: String
  let repository: LibraryRepository

  init() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("calendar-ledger-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    path = directory.appendingPathComponent("library.sqlite").path
    repository = try LibraryRepository(path: path)
  }

  deinit { try? FileManager.default.removeItem(at: URL(fileURLWithPath: path).deletingLastPathComponent()) }
}
