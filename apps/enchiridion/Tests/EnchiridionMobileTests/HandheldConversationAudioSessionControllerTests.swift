import XCTest
import AVFoundation

@testable import Enchiridion

#if os(iOS)
@MainActor
final class HandheldConversationAudioSessionControllerTests: XCTestCase {
  func testResetDuringSuspendedActivationLeavesControllerInactive() async throws {
    let backend = ControlledAudioBackend()
    let controller = HandheldConversationAudioSessionController(backend: backend)
    let activation = Task { try await controller.activate() }
    await backend.waitForActivation()
    await controller.resetAfterMediaServicesReset()
    await backend.resumeActivation()
    _ = await activation.result
    XCTAssertFalse(controller.isActiveForTesting)
  }

  func testResetDuringSuspendedActivationDoesNotOverlapAnotherController() async throws {
    let firstBackend = ControlledAudioBackend()
    let secondBackend = ControlledAudioBackend()
    let first = HandheldConversationAudioSessionController(backend: firstBackend)
    let second = HandheldConversationAudioSessionController(backend: secondBackend)
    let firstActivation = Task { try await first.activate() }
    await firstBackend.waitForActivation()
    await first.resetAfterMediaServicesReset()

    let blockedActivation = await Task { try await second.activate() }.result
    guard case .failure(let error) = blockedActivation else {
      return XCTFail("second controller must not activate while the first native activation is pending")
    }
    XCTAssertEqual(error as? HandheldConversationAudioSessionError, .leaseUnavailable)
    XCTAssertFalse(secondBackend.didEnterActivation)

    await firstBackend.resumeActivation()
    _ = await firstActivation.result

    let secondActivation = Task { try await activateWhenLeaseAvailable(second) }
    await secondBackend.waitForActivation()
    await secondBackend.resumeActivation()
    guard case .success = await secondActivation.result else {
      return XCTFail("second controller should acquire the lease after the stale activation drains")
    }
    await second.deactivate()
  }

  func testSuspendedDeactivationBlocksSameControllerReactivation() async throws {
    let backend = ControlledAudioBackend()
    let controller = HandheldConversationAudioSessionController(backend: backend)
    backend.suspendActivation = false
    try await controller.activate()
    backend.suspendDeactivation = true
    let deactivation = Task { await controller.deactivate() }
    await backend.waitForDeactivation()
    do {
      try await controller.activate()
      XCTFail("expected pending deactivation to reject activation")
    } catch {}
    await backend.resumeDeactivation()
    await deactivation.value
    XCTAssertFalse(controller.isActiveForTesting)
  }

  func testResetDuringSuspendedDeactivationDoesNotOverlapAnotherController() async throws {
    let firstBackend = ControlledAudioBackend()
    firstBackend.suspendActivation = false
    let secondBackend = ControlledAudioBackend()
    let first = HandheldConversationAudioSessionController(backend: firstBackend)
    let second = HandheldConversationAudioSessionController(backend: secondBackend)
    try await first.activate()

    firstBackend.suspendDeactivation = true
    let firstDeactivation = Task { await first.deactivate() }
    await firstBackend.waitForDeactivation()
    await first.resetAfterMediaServicesReset()

    let blockedActivation = await Task { try await second.activate() }.result
    guard case .failure(let error) = blockedActivation else {
      return XCTFail("second controller must not activate while the first native deactivation is pending")
    }
    XCTAssertEqual(error as? HandheldConversationAudioSessionError, .leaseUnavailable)
    XCTAssertFalse(secondBackend.didEnterActivation)

    await firstBackend.resumeDeactivation()
    await firstDeactivation.value

    let secondActivation = Task { try await activateWhenLeaseAvailable(second) }
    await secondBackend.waitForActivation()
    await secondBackend.resumeActivation()
    guard case .success = await secondActivation.result else {
      return XCTFail("second controller should acquire the lease after deactivation completes")
    }
    await second.deactivate()
  }

  func testNonOwnerReleaseAndStaleResetCannotRevokeNewerLease() async throws {
    let coordinator = HandheldConversationAudioLeaseCoordinator()
    let ownerA = UUID()
    let ownerB = UUID()
    let leaseA = try await coordinator.acquire(ownerA)
    await coordinator.release(ownerA, generation: leaseA)
    let leaseB = try await coordinator.acquire(ownerB)
    // A late release/reset from A must not disturb B's live lease.
    await coordinator.release(ownerA, generation: leaseA)
    await coordinator.reset(ownerA, generation: leaseA)
    do {
      _ = try await coordinator.acquire(UUID())
      XCTFail("new owner must be rejected while B owns lease")
    } catch {}
    await coordinator.release(ownerB, generation: leaseB)
    do {
      _ = try await coordinator.acquire(UUID())
    } catch {
      XCTFail("lease should be available after B releases")
    }
  }

  func testForcedLegacyFallbackConfiguresThenActivatesOffMain() async throws {
    let backend = ControlledAudioBackend()
    backend.suspendActivation = false
    let controller = HandheldConversationAudioSessionController(
      backend: backend, forceLegacyActivationForTesting: true
    )
    try await controller.activate()
    XCTAssertEqual(backend.calls, ["category", "legacy-active"])
    XCTAssertFalse(backend.categoryWasMain)
    XCTAssertFalse(backend.legacyActivationWasMain)
    await controller.deactivate()
  }
}

@MainActor
private func activateWhenLeaseAvailable(
  _ controller: HandheldConversationAudioSessionController
) async throws {
  for _ in 0..<100 {
    do {
      try await controller.activate()
      return
    } catch HandheldConversationAudioSessionError.leaseUnavailable {
      await Task.yield()
    }
  }
  throw HandheldConversationAudioSessionError.leaseUnavailable
}

private final class ControlledAudioBackend: HandheldConversationAudioSessionBacking, @unchecked Sendable {
  private var activationContinuation: CheckedContinuation<Void, Never>?
  private var deactivationContinuation: CheckedContinuation<Void, Never>?
  private var activationEntered = false
  private var deactivationEntered = false
  private(set) var calls: [String] = []
  private(set) var categoryWasMain = true
  private(set) var legacyActivationWasMain = true
  var suspendActivation = true
  var suspendDeactivation = false

  func setCategory(_: AVAudioSession.Category, mode _: AVAudioSession.Mode, options _: AVAudioSession.CategoryOptions) throws {
    calls.append("category"); categoryWasMain = Thread.isMainThread
  }
  func setActive(_: Bool, options _: AVAudioSession.SetActiveOptions) throws {
    calls.append("legacy-active"); legacyActivationWasMain = Thread.isMainThread
  }
  func activateConfigured() async throws {
    guard suspendActivation else { return }
    activationEntered = true
    await withCheckedContinuation { activationContinuation = $0 }
  }
  func deactivateConfigured() async throws {
    guard suspendDeactivation else { return }
    deactivationEntered = true
    await withCheckedContinuation { deactivationContinuation = $0 }
  }
  func waitForActivation() async { while !activationEntered { await Task.yield() } }
  func waitForDeactivation() async { while !deactivationEntered { await Task.yield() } }
  func resumeActivation() async { activationContinuation?.resume(); activationContinuation = nil }
  func resumeDeactivation() async { deactivationContinuation?.resume(); deactivationContinuation = nil }
  var didEnterActivation: Bool { activationEntered }
}
#endif
