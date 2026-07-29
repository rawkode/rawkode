import Foundation
import XCTest

@testable import EnchiridionCore

@MainActor
final class TaskSystemCoordinationTests: XCTestCase {
  func testColdLaunchDeliversExactTaskAfterFreshRead() async {
    let coordinator = TaskSystemHandoffCoordinator()
    let task = page("cold-launch")
    let route = TaskDeepLinkRoute.task(task.id, list: .today)

    let outcome = await coordinator.open(route) { [task] in [task] }

    XCTAssertEqual(outcome?.route, route)
    XCTAssertEqual(outcome?.pages, [task])
  }

  func testActivationSupersedesRefreshButPreservesPendingURLRoute() async {
    let coordinator = TaskSystemHandoffCoordinator()
    let gate = OneShotGate()
    let task = page("activation-url")
    let route = TaskDeepLinkRoute.task(task.id, list: .inbox)

    let urlRequest = Task {
      await coordinator.open(route) { [task] in
        await gate.enterAndWait()
        return [task]
      }
    }
    await gate.waitUntilEntered()

    let activationRequest = Task {
      await coordinator.activate { [task] in [task] }
    }
    await waitUntilSubmitted(2, to: coordinator)
    await gate.release()

    let staleOutcome = await urlRequest.value
    let activationOutcome = await activationRequest.value
    XCTAssertNil(staleOutcome)
    XCTAssertEqual(activationOutcome?.route, route)
    XCTAssertEqual(activationOutcome?.pages, [task])
  }

  func testTwoRapidExactTaskRoutesDeliverOnlyTheLatestTask() async {
    let coordinator = TaskSystemHandoffCoordinator()
    let gate = OneShotGate()
    let firstTask = page("first")
    let secondTask = page("second")
    let pages = [firstTask, secondTask]
    let firstRoute = TaskDeepLinkRoute.task(firstTask.id, list: .today)
    let secondRoute = TaskDeepLinkRoute.task(secondTask.id, list: .upcoming)

    let firstRequest = Task {
      await coordinator.open(firstRoute) { [pages] in
        await gate.enterAndWait()
        return pages
      }
    }
    await gate.waitUntilEntered()

    let secondRequest = Task {
      await coordinator.open(secondRoute) { [pages] in pages }
    }
    await waitUntilSubmitted(2, to: coordinator)
    await gate.release()

    let firstOutcome = await firstRequest.value
    let secondOutcome = await secondRequest.value
    XCTAssertNil(firstOutcome)
    XCTAssertEqual(secondOutcome?.route, secondRoute)
    XCTAssertEqual(secondOutcome?.pages, pages)
  }

  func testFailedRefreshKeepsExactRoutePendingForNextSuccessfulActivation() async {
    let coordinator = TaskSystemHandoffCoordinator()
    let task = page("retry-after-refresh")
    let route = TaskDeepLinkRoute.task(task.id, list: .today)

    let failedOutcome = await coordinator.open(route) { nil }
    let recoveredOutcome = await coordinator.activate { [task] in [task] }

    XCTAssertNil(failedOutcome)
    XCTAssertEqual(recoveredOutcome?.route, route)
    XCTAssertEqual(recoveredOutcome?.pages, [task])
  }

  func testReconciliationIsSerializedAndCoalescesToLatestSnapshot() async {
    let gate = OneShotGate()
    let probe = ReconciliationProbe(gate: gate)
    let coordinator = TaskSystemReconciliationCoordinator { pages in
      await probe.reconcile(pages)
    }
    let first = page("first")
    let middle = page("middle")
    let latest = page("latest")

    await coordinator.submit([first])
    await gate.waitUntilEntered()
    await coordinator.submit([middle])
    await coordinator.submit([latest])
    await gate.release()
    await coordinator.waitUntilIdle()

    let snapshot = await probe.snapshot()
    XCTAssertEqual(snapshot.calls, [[first.id], [latest.id]])
    XCTAssertEqual(snapshot.maximumConcurrentOperations, 1)
  }

  func testExclusiveOperationLaneDoesNotReenterAcrossSuspension() async {
    let lane = TaskSystemExclusiveOperationLane()
    let gate = OneShotGate()
    let probe = ExclusiveLaneProbe()

    let first = Task {
      await lane.perform {
        await probe.enter("first")
        await gate.enterAndWait()
        await probe.leave("first")
      }
    }
    await gate.waitUntilEntered()
    let second = Task {
      await lane.perform {
        await probe.enter("second")
        await probe.leave("second")
      }
    }
    await Task.yield()
    let concurrentBeforeRelease = await probe.maximumConcurrentOperations()
    XCTAssertEqual(concurrentBeforeRelease, 1)

    await gate.release()
    await first.value
    await second.value

    let events = await probe.events()
    let maximumConcurrentOperations = await probe.maximumConcurrentOperations()
    XCTAssertEqual(events, ["first:start", "first:end", "second:start", "second:end"])
    XCTAssertEqual(maximumConcurrentOperations, 1)
  }

  private func waitUntilSubmitted(
    _ count: UInt64,
    to coordinator: TaskSystemHandoffCoordinator
  ) async {
    for _ in 0..<10_000 {
      if await coordinator.submittedRequestCount() >= count { return }
      await Task.yield()
    }
    XCTFail("Timed out waiting for \(count) coordinated requests")
  }

  private func page(_ suffix: String) -> PageSnapshot {
    PageSnapshot(
      id: PageID(rawValue: "task-\(suffix)"),
      kind: .free,
      title: suffix,
      plainText: "",
      document: Data(),
      heads: .empty,
      createdAt: .distantPast,
      modifiedAt: .distantPast,
      objectMetadata: .init(supertagIDs: [BuiltInSupertags.task])
    )
  }
}

private actor OneShotGate {
  private var entered = false
  private var released = false
  private var entryWaiters: [CheckedContinuation<Void, Never>] = []
  private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

  func enterAndWait() async {
    entered = true
    let waiters = entryWaiters
    entryWaiters.removeAll()
    for waiter in waiters { waiter.resume() }

    guard !released else { return }
    await withCheckedContinuation { continuation in
      releaseWaiters.append(continuation)
    }
  }

  func waitUntilEntered() async {
    guard !entered else { return }
    await withCheckedContinuation { continuation in
      entryWaiters.append(continuation)
    }
  }

  func release() {
    released = true
    let waiters = releaseWaiters
    releaseWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
  }
}

private actor ReconciliationProbe {
  struct Snapshot: Sendable {
    let calls: [[PageID]]
    let maximumConcurrentOperations: Int
  }

  private let gate: OneShotGate
  private var calls: [[PageID]] = []
  private var concurrentOperations = 0
  private var maximumConcurrentOperations = 0

  init(gate: OneShotGate) {
    self.gate = gate
  }

  func reconcile(_ pages: [PageSnapshot]) async {
    concurrentOperations += 1
    maximumConcurrentOperations = max(maximumConcurrentOperations, concurrentOperations)
    calls.append(pages.map(\.id))
    if calls.count == 1 { await gate.enterAndWait() }
    concurrentOperations -= 1
  }

  func snapshot() -> Snapshot {
    Snapshot(
      calls: calls,
      maximumConcurrentOperations: maximumConcurrentOperations
    )
  }
}

private actor ExclusiveLaneProbe {
  private var recordedEvents: [String] = []
  private var concurrentOperations = 0
  private var maximumConcurrent = 0

  func enter(_ name: String) {
    concurrentOperations += 1
    maximumConcurrent = max(maximumConcurrent, concurrentOperations)
    recordedEvents.append("\(name):start")
  }

  func leave(_ name: String) {
    recordedEvents.append("\(name):end")
    concurrentOperations -= 1
  }

  func events() -> [String] { recordedEvents }

  func maximumConcurrentOperations() -> Int { maximumConcurrent }
}
