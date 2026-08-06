import XCTest
import AVFoundation
import EnchiridionCore

@testable import Enchiridion

#if os(iOS)
  @MainActor
  final class LiveKitRTCManagedAudioSessionControllerTests: XCTestCase {
    func testDefaultWrappedLeaseControllerUsesRTCBackedConfiguration() async throws {
      let events = EventLog()
      let subject = LiveKitRTCManagedAudioSessionController(rtcAudio: FakeRTCAudio(events: events))

      try await subject.activate()
      await subject.deactivate()

      XCTAssertEqual(
        events.values,
        [
          "rtc.configure", "rtc.category", "rtc.activateConfigured", "rtc.enabled.true",
          "rtc.enabled.false", "rtc.deactivateConfigured",
        ]
      )
    }

    func testActivationConfiguresManualAudioBeforeControllerAndEnablesAfterward() async throws {
      let events = EventLog()
      let controller = FakeController(events: events)
      let rtcAudio = FakeRTCAudio(events: events)
      let subject = LiveKitRTCManagedAudioSessionController(controller: controller, rtcAudio: rtcAudio)

      try await subject.activate()

      XCTAssertEqual(events.values, ["rtc.configure", "controller.activate", "rtc.enabled.true"])
      XCTAssertEqual(controller.activateCalls, 1)
    }

    func testDeactivationDisablesRTCBeforeForwardingExactlyOnce() async throws {
      let events = EventLog()
      let controller = FakeController(events: events)
      let subject = LiveKitRTCManagedAudioSessionController(
        controller: controller, rtcAudio: FakeRTCAudio(events: events)
      )
      try await subject.activate()

      await subject.deactivate()
      await subject.deactivate()

      XCTAssertEqual(Array(events.values.suffix(2)), ["rtc.enabled.false", "controller.deactivate"])
      XCTAssertEqual(controller.deactivateCalls, 1)
    }

    func testResultDeactivationPreservesTimeoutAndDoesNotRepeatControllerOperation() async throws {
      let events = EventLog()
      let controller = FakeController(events: events)
      controller.deactivationResult = .timedOut
      let subject = LiveKitRTCManagedAudioSessionController(
        controller: controller, rtcAudio: FakeRTCAudio(events: events)
      )
      try await subject.activate()

      let firstResult = await subject.deactivateWithResult()
      let secondResult = await subject.deactivateWithResult()
      XCTAssertEqual(firstResult, .timedOut)
      XCTAssertEqual(secondResult, .completed)

      XCTAssertEqual(
        Array(events.values.suffix(2)), ["rtc.enabled.false", "controller.deactivateWithResult"]
      )
      XCTAssertEqual(controller.deactivateWithResultCalls, 1)
    }

    func testResetDisablesRTCBeforeForwardingExactlyOnce() async {
      let events = EventLog()
      let controller = FakeController(events: events)
      let subject = LiveKitRTCManagedAudioSessionController(
        controller: controller, rtcAudio: FakeRTCAudio(events: events)
      )

      await subject.resetAfterMediaServicesReset()

      XCTAssertEqual(events.values, ["rtc.configure", "rtc.enabled.false", "controller.reset"])
      XCTAssertEqual(controller.resetCalls, 1)
    }

    func testStaleActivationDoesNotEnableRTCOrCompensateWithSecondControllerCall() async throws {
      let events = EventLog()
      let controller = FakeController(events: events)
      controller.suspendActivation = true
      let subject = LiveKitRTCManagedAudioSessionController(
        controller: controller, rtcAudio: FakeRTCAudio(events: events)
      )

      let activation = Task { try await subject.activate() }
      await controller.waitForActivation()
      await subject.resetAfterMediaServicesReset()
      controller.resumeActivation()
      _ = await activation.result

      XCTAssertEqual(
        events.values,
        ["rtc.configure", "controller.activate", "rtc.enabled.false", "controller.reset"]
      )
      XCTAssertEqual(controller.activateCalls, 1)
      XCTAssertEqual(controller.deactivateCalls, 0)
    }

    func testDeactivationDuringActivationWaitsToForwardUntilActivationDrains() async throws {
      let events = EventLog()
      let controller = FakeController(events: events)
      controller.suspendActivation = true
      let subject = LiveKitRTCManagedAudioSessionController(
        controller: controller, rtcAudio: FakeRTCAudio(events: events)
      )
      let activation = Task { try await subject.activate() }
      await controller.waitForActivation()
      await subject.deactivate()
      controller.resumeActivation()
      _ = await activation.result

      XCTAssertEqual(controller.activateCalls, 1)
      XCTAssertEqual(controller.deactivateCalls, 1)
      XCTAssertEqual(events.values.suffix(2).map { $0 }, ["rtc.enabled.false", "controller.deactivate"])
    }
  }

  private final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []
    var values: [String] { lock.lock(); defer { lock.unlock() }; return storage }
    func append(_ event: String) { lock.lock(); storage.append(event); lock.unlock() }
  }

  private final class FakeRTCAudio: LiveKitRTCAudioSessionBacking, @unchecked Sendable {
    private let events: EventLog
    init(events: EventLog) { self.events = events }
    func configureManualAudioDisabled() { events.append("rtc.configure") }
    func setAudioEnabled(_ enabled: Bool) { events.append("rtc.enabled.\(enabled)") }
    func setCategory(
      _: AVAudioSession.Category, mode _: AVAudioSession.Mode,
      options _: AVAudioSession.CategoryOptions
    ) throws { events.append("rtc.category") }
    func setActive(_: Bool, options _: AVAudioSession.SetActiveOptions) throws { events.append("rtc.active") }
    func activateConfigured() async throws { events.append("rtc.activateConfigured") }
    func deactivateConfigured() async throws { events.append("rtc.deactivateConfigured") }
  }

  private final class FakeController: RealtimeAudioSessionControlling, @unchecked Sendable {
    private let events: EventLog
    private let lock = NSLock()
    private var storedActivateCalls = 0
    private var storedDeactivateCalls = 0
    private var storedDeactivateWithResultCalls = 0
    private var storedResetCalls = 0
    private var storedDeactivationResult: RealtimeAudioSessionDeactivationResult = .completed
    private var storedSuspendActivation = false
    private var activationEntered = false
    private var activationResumeRequested = false
    private var activationContinuation: CheckedContinuation<Void, Never>?

    var activateCalls: Int { lock.lock(); defer { lock.unlock() }; return storedActivateCalls }
    var deactivateCalls: Int { lock.lock(); defer { lock.unlock() }; return storedDeactivateCalls }
    var deactivateWithResultCalls: Int { lock.lock(); defer { lock.unlock() }; return storedDeactivateWithResultCalls }
    var resetCalls: Int { lock.lock(); defer { lock.unlock() }; return storedResetCalls }
    var deactivationResult: RealtimeAudioSessionDeactivationResult { get { lock.lock(); defer { lock.unlock() }; return storedDeactivationResult } set { lock.lock(); storedDeactivationResult = newValue; lock.unlock() } }
    var suspendActivation: Bool { get { lock.lock(); defer { lock.unlock() }; return storedSuspendActivation } set { lock.lock(); storedSuspendActivation = newValue; lock.unlock() } }

    private func beginActivation() -> Bool { lock.lock(); storedActivateCalls += 1; let suspended = storedSuspendActivation; if suspended { activationEntered = true }; lock.unlock(); return suspended }
    private func installActivationContinuation(_ continuation: CheckedContinuation<Void, Never>) { lock.lock(); if activationResumeRequested { lock.unlock(); continuation.resume() } else { activationContinuation = continuation; lock.unlock() } }
    private func recordDeactivation() { lock.lock(); storedDeactivateCalls += 1; lock.unlock() }
    private func recordResultDeactivation() -> RealtimeAudioSessionDeactivationResult { lock.lock(); storedDeactivateWithResultCalls += 1; let result = storedDeactivationResult; lock.unlock(); return result }
    private func recordReset() { lock.lock(); storedResetCalls += 1; lock.unlock() }
    private func hasEnteredActivation() -> Bool { lock.lock(); defer { lock.unlock() }; return activationEntered }

    init(events: EventLog) { self.events = events }
    func activate() async throws {
      let suspended = beginActivation()
      events.append("controller.activate")
      guard suspended else { return }
      await withCheckedContinuation { installActivationContinuation($0) }
    }
    func deactivate() async { recordDeactivation(); events.append("controller.deactivate") }
    func deactivateWithResult() async -> RealtimeAudioSessionDeactivationResult {
      let result = recordResultDeactivation()
      events.append("controller.deactivateWithResult")
      return result
    }
    func resetAfterMediaServicesReset() async { recordReset(); events.append("controller.reset") }
    func waitForActivation() async { while !hasEnteredActivation() { await Task.yield() } }
    func resumeActivation() { lock.lock(); activationResumeRequested = true; let continuation = activationContinuation; activationContinuation = nil; lock.unlock(); continuation?.resume() }
  }
#endif
