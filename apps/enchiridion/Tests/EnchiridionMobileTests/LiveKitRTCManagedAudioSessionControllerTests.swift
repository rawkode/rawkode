import XCTest
import AVFoundation

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

      XCTAssertEqual(await subject.deactivateWithResult(), .timedOut)
      XCTAssertEqual(await subject.deactivateWithResult(), .completed)

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

  @MainActor
  private final class EventLog {
    var values: [String] = []
    func append(_ event: String) { values.append(event) }
  }

  @MainActor
  private final class FakeRTCAudio: LiveKitRTCAudioSessionBacking {
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

  @MainActor
  private final class FakeController: RealtimeAudioSessionControlling {
    private let events: EventLog
    var activateCalls = 0
    var deactivateCalls = 0
    var deactivateWithResultCalls = 0
    var resetCalls = 0
    var deactivationResult: RealtimeAudioSessionDeactivationResult = .completed
    var suspendActivation = false
    private var activationEntered = false
    private var activationContinuation: CheckedContinuation<Void, Never>?

    init(events: EventLog) { self.events = events }
    func activate() async throws {
      activateCalls += 1
      events.append("controller.activate")
      guard suspendActivation else { return }
      activationEntered = true
      await withCheckedContinuation { activationContinuation = $0 }
    }
    func deactivate() async { deactivateCalls += 1; events.append("controller.deactivate") }
    func deactivateWithResult() async -> RealtimeAudioSessionDeactivationResult {
      deactivateWithResultCalls += 1
      events.append("controller.deactivateWithResult")
      return deactivationResult
    }
    func resetAfterMediaServicesReset() async { resetCalls += 1; events.append("controller.reset") }
    func waitForActivation() async { while !activationEntered { await Task.yield() } }
    func resumeActivation() { activationContinuation?.resume(); activationContinuation = nil }
  }
#endif
