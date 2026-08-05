import Foundation
import XCTest

@testable import EnchiridionCore

@MainActor
final class EventKitCalendarProviderTests: XCTestCase {
  func testSlowSnapshotEnumerationDoesNotBlockMainActor() async throws {
    let source = SnapshotSource(delay: .milliseconds(250))
    let provider = EventKitCalendarProvider(source: source)
    let interval = DateInterval(start: Date(timeIntervalSince1970: 0), duration: 60)

    let refresh = Task { @MainActor in
      try await provider.authoritativeProjection(from: interval.start, through: interval.end)
    }

    for _ in 0..<20 where !(await source.didBeginFetch()) {
      await Task.yield()
    }
    let didBeginFetch = await source.didBeginFetch()
    XCTAssertTrue(didBeginFetch)

    let markerStart = ContinuousClock.now
    await MainActor.run {}
    XCTAssertLessThan(markerStart.duration(to: .now), .milliseconds(100))

    let projection = try await refresh.value
    XCTAssertEqual(projection.events.map(\.title), ["Earlier", "Later"])
  }

  func testAuthorizationErrorsAreStable() async throws {
    let denied = EventKitCalendarProvider(source: SnapshotSource(authorization: .denied))
    do {
      try await denied.requestAccess()
      XCTFail("Expected access denial")
    } catch {
      XCTAssertEqual(error as? CalendarProviderError, .accessDenied)
    }

    let restricted = EventKitCalendarProvider(source: SnapshotSource(authorization: .restricted))
    do {
      try await restricted.requestAccess()
      XCTFail("Expected access restriction")
    } catch {
      XCTAssertEqual(error as? CalendarProviderError, .accessRestricted)
    }
  }

  func testCancelledRefreshDoesNotPublishAnEventKitResult() async throws {
    let source = SnapshotSource(delay: .milliseconds(100))
    let provider = EventKitCalendarProvider(source: source)
    let interval = DateInterval(start: Date(timeIntervalSince1970: 0), duration: 60)
    let refresh = Task { @MainActor in
      try await provider.authoritativeProjection(from: interval.start, through: interval.end)
    }

    for _ in 0..<20 where !(await source.didBeginFetch()) {
      await Task.yield()
    }
    refresh.cancel()

    do {
      _ = try await refresh.value
      XCTFail("A cancelled refresh must not publish a projection")
    } catch is CancellationError {
      // Expected: the source owns an uninterruptible EventKit call, while the
      // facade prevents its completed result from crossing back to the UI.
    }
  }

  func testCancelledObservationIgnoresAnAlreadyQueuedNotification() async throws {
    let source = SnapshotSource()
    let provider = EventKitCalendarProvider(source: source)
    let changed = expectation(description: "change callback")
    changed.isInverted = true

    await provider.startObserving {
      changed.fulfill()
    }
    let queuedCallback = await source.currentChangeHandler()
    await provider.stopObserving()
    queuedCallback?()

    await fulfillment(of: [changed], timeout: 0.05)
    let stopCount = await source.stopCount()
    XCTAssertEqual(stopCount, 1)
  }

  func testLatestObservationReplacesEarlierCallback() async throws {
    let source = SnapshotSource()
    let provider = EventKitCalendarProvider(source: source)
    let stale = expectation(description: "stale callback")
    stale.isInverted = true
    let current = expectation(description: "current callback")

    await provider.startObserving { stale.fulfill() }
    let firstHandler = await source.currentChangeHandler()
    await provider.startObserving { current.fulfill() }
    firstHandler?()
    await source.emitChange()

    await fulfillment(of: [current, stale], timeout: 0.2)
  }
}

private actor SnapshotSource: EventKitCalendarSnapshotSource {
  private let authorization: EventKitCalendarAuthorization
  private let delay: Duration?
  private var handler: (@Sendable () -> Void)?
  private var fetchHasStarted = false
  private var stops = 0

  init(
    authorization: EventKitCalendarAuthorization = .fullAccess,
    delay: Duration? = nil
  ) {
    self.authorization = authorization
    self.delay = delay
  }

  func authorizationStatus() -> EventKitCalendarAuthorization { authorization }

  func requestFullAccess() -> Bool { false }

  func authoritativeProjection(from start: Date, through end: Date) async throws
    -> AuthoritativeCalendarProjection
  {
    fetchHasStarted = true
    if let delay { try await Task.sleep(for: delay) }
    return .init(
      provider: "eventkit",
      interval: .init(start: start, end: end),
      events: [
        event(title: "Earlier", start: start),
        event(title: "Later", start: start.addingTimeInterval(1)),
      ]
    )
  }

  func startObserving(onChanged: @escaping @Sendable () -> Void) {
    handler = onChanged
  }

  func stopObserving() {
    stops += 1
    handler = nil
  }

  func didBeginFetch() -> Bool { fetchHasStarted }
  func currentChangeHandler() -> (@Sendable () -> Void)? { handler }
  func emitChange() { handler?() }
  func stopCount() -> Int { stops }

  private func event(title: String, start: Date) -> CalendarEventSnapshot {
    .init(
      identity: .init(externalIdentifier: title, occurrenceStart: start),
      title: title,
      startDate: start,
      endDate: start.addingTimeInterval(1),
      isAllDay: false,
      location: nil,
      notes: nil,
      url: nil,
      calendarTitle: "Calendar"
    )
  }
}
