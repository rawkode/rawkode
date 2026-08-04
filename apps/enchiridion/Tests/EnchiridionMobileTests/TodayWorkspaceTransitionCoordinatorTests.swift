import XCTest

@testable import Enchiridion

@available(iOS 26.0, *)
@MainActor
final class TodayWorkspaceTransitionCoordinatorTests: XCTestCase {
  func testIdenticalTargetIsCoalesced() async {
    let day = Date(timeIntervalSinceReferenceDate: 100)
    let coordinator = TodayWorkspaceTransitionCoordinator(day: day)
    var requests = 0
    let target = TodayWorkspaceTransitionCoordinator.Target(day: day, panel: .plan)

    coordinator.request(target) { _, _ in requests += 1 }
    coordinator.request(target) { _, _ in requests += 1 }
    await Task.yield()

    XCTAssertEqual(requests, 1)
    XCTAssertEqual(coordinator.generation, 1)
  }

  func testForcedIdenticalTargetStartsNewRequest() async {
    let day = Date(timeIntervalSinceReferenceDate: 100)
    let coordinator = TodayWorkspaceTransitionCoordinator(day: day)
    let target = TodayWorkspaceTransitionCoordinator.Target(day: day, panel: .plan)
    var requests = 0

    coordinator.request(target) { _, _ in requests += 1 }
    await Task.yield()
    coordinator.request(target, force: true) { _, _ in requests += 1 }
    await Task.yield()

    XCTAssertEqual(requests, 2)
    XCTAssertEqual(coordinator.generation, 2)
  }

  func testNewTargetSupersedesPreviousGeneration() async {
    let day = Date(timeIntervalSinceReferenceDate: 100)
    let coordinator = TodayWorkspaceTransitionCoordinator(day: day)
    let first = TodayWorkspaceTransitionCoordinator.Target(day: day, panel: .note)
    let second = TodayWorkspaceTransitionCoordinator.Target(
      day: day.addingTimeInterval(86_400), panel: .plan)
    var firstGeneration = 0

    coordinator.request(first) { generation, _ in
      firstGeneration = generation
      await Task.yield()
    }
    coordinator.request(second) { _, _ in }
    await Task.yield()

    XCTAssertFalse(coordinator.isCurrent(firstGeneration, target: first))
    XCTAssertTrue(coordinator.isCurrent(coordinator.generation, target: second))
  }

  func testFailedMaterializationPreservesVisibleState() async {
    let day = Date(timeIntervalSinceReferenceDate: 100)
    let coordinator = TodayWorkspaceTransitionCoordinator(day: day)
    let target = TodayWorkspaceTransitionCoordinator.Target(day: day, panel: .note)
    var visiblePanel = TodayWorkspaceTransitionCoordinator.Panel.plan

    coordinator.request(target) { generation, target in
      coordinator.commitIfCurrent(generation, target: target, materialized: false) {
        visiblePanel = .note
      }
    }
    await Task.yield()

    XCTAssertEqual(visiblePanel, .plan)
  }

  func testSupersededMaterializationPreservesVisibleState() async {
    let day = Date(timeIntervalSinceReferenceDate: 100)
    let coordinator = TodayWorkspaceTransitionCoordinator(day: day)
    let note = TodayWorkspaceTransitionCoordinator.Target(day: day, panel: .note)
    let plan = TodayWorkspaceTransitionCoordinator.Target(day: day, panel: .plan)
    var visiblePanel = TodayWorkspaceTransitionCoordinator.Panel.plan

    coordinator.request(note) { generation, target in
      await Task.yield()
      coordinator.commitIfCurrent(generation, target: target) { visiblePanel = .note }
    }
    coordinator.request(plan) { _, _ in }
    await Task.yield()

    XCTAssertEqual(visiblePanel, .plan)
  }

  func testImmediateTargetCancelsPendingWork() async {
    let day = Date(timeIntervalSinceReferenceDate: 100)
    let coordinator = TodayWorkspaceTransitionCoordinator(day: day)
    let note = TodayWorkspaceTransitionCoordinator.Target(day: day, panel: .note)
    let plan = TodayWorkspaceTransitionCoordinator.Target(
      day: day.addingTimeInterval(86_400), panel: .plan)
    var materializedNote = false

    coordinator.request(note) { _, _ in
      try? await Task.sleep(for: .seconds(1))
      guard !Task.isCancelled else { return }
      materializedNote = true
    }
    coordinator.showImmediately(plan)
    await Task.yield()

    XCTAssertFalse(materializedNote)
    XCTAssertTrue(coordinator.isCurrent(coordinator.generation, target: plan))
  }
}
