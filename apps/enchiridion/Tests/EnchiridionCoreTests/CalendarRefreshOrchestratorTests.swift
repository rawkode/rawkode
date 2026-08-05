import Foundation
import XCTest

@testable import EnchiridionCore

@MainActor
final class CalendarRefreshOrchestratorTests: XCTestCase {
  func testStartPublishesDailyPageBeforeSuspendedEventKitRefreshCompletes() async throws {
    let fixture = try CalendarStoreFixture()
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let source = ControlledCalendarSource(event: calendarEvent())
    let store = LibraryStore(
      repository: fixture.repository,
      calendarProvider: EventKitCalendarProvider(source: source),
      startImmediately: false
    )

    let started = ContinuousClock.now
    await store.start()
    XCTAssertLessThan(started.duration(to: .now), .seconds(1))
    XCTAssertFalse(store.isLoading)
    XCTAssertNotNil(store.selectedPage)

    for _ in 0..<100 where !(await source.didBeginFetch()) { await Task.yield() }
    let didBeginFetch = await source.didBeginFetch()
    XCTAssertTrue(didBeginFetch)
    XCTAssertEqual(store.calendarRefreshPhase, .refreshing)

    // Opening Today's page must remain independent of the suspended calendar
    // enumeration/materialization task.
    let daily = await store.openDailyPage()
    XCTAssertNotNil(daily)

    await source.release()
    for _ in 0..<20 where !store.pages.contains(where: { $0.hasSupertag(BuiltInSupertags.event) }) {
      try await Task.sleep(for: .milliseconds(50))
    }
    XCTAssertTrue(
      store.pages.contains(where: { $0.hasSupertag(BuiltInSupertags.event) }),
      store.calendarError ?? "Calendar page batch did not publish"
    )
    XCTAssertEqual(store.calendarRefreshPhase, .idle)
    await store.stop()
  }

  func testStopFencesSuspendedRefreshFromPublishingStalePages() async throws {
    let fixture = try CalendarStoreFixture()
    try await fixture.repository.setCalendarEventMaterializationEnabled(true)
    let source = ControlledCalendarSource(event: calendarEvent(title: "Stale event"))
    let store = LibraryStore(
      repository: fixture.repository,
      calendarProvider: EventKitCalendarProvider(source: source),
      startImmediately: false
    )

    await store.start()
    for _ in 0..<100 where !(await source.didBeginFetch()) { await Task.yield() }
    await store.stop()
    await source.release()
    for _ in 0..<100 { await Task.yield() }

    XCTAssertFalse(store.pages.contains(where: { $0.title == "Stale event" }))
    XCTAssertEqual(store.calendarRefreshPhase, .idle)
  }

  private func calendarEvent(title: String = "Materialized event") -> CalendarEventSnapshot {
    let start = Date(timeIntervalSince1970: 1_830_000_000)
    return .init(
      identity: .init(provider: "eventkit", externalIdentifier: title, occurrenceStart: start),
      title: title,
      startDate: start,
      endDate: start.addingTimeInterval(3_600),
      isAllDay: false,
      location: nil,
      notes: nil,
      url: nil,
      calendarTitle: "Calendar",
      iCalendarUID: "\(title)@example.test",
      originalStartDate: start,
      timeZoneIdentifier: "UTC"
    )
  }
}

private final class CalendarStoreFixture {
  let directory: URL
  let repository: LibraryRepository

  init() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-calendar-store-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    repository = try LibraryRepository(path: directory.appendingPathComponent("library.sqlite").path)
  }

  deinit { try? FileManager.default.removeItem(at: directory) }
}

private actor ControlledCalendarSource: EventKitCalendarSnapshotSource {
  private let event: CalendarEventSnapshot
  private var hasBegunFetch = false
  private var releaseContinuation: CheckedContinuation<Void, Never>?
  private var changeHandler: (@Sendable () -> Void)?

  init(event: CalendarEventSnapshot) { self.event = event }

  func authorizationStatus() -> EventKitCalendarAuthorization { .fullAccess }
  func requestFullAccess() -> Bool { true }

  func authoritativeProjection(from start: Date, through end: Date) async throws
    -> AuthoritativeCalendarProjection
  {
    hasBegunFetch = true
    await withCheckedContinuation { releaseContinuation = $0 }
    try Task.checkCancellation()
    return .init(provider: "eventkit", interval: .init(start: start, end: end), events: [event])
  }

  func startObserving(onChanged: @escaping @Sendable () -> Void) { changeHandler = onChanged }
  func stopObserving() { changeHandler = nil }
  func didBeginFetch() -> Bool { hasBegunFetch }
  func release() {
    releaseContinuation?.resume()
    releaseContinuation = nil
  }
}
