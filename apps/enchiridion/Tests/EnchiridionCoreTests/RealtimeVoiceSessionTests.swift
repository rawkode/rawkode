import Foundation
import XCTest

@testable import EnchiridionCore

@MainActor
final class RealtimeVoiceSessionTests: XCTestCase {
  func testStartEnforcesPermissionCredentialTransportAudioInputOrder() async throws {
    let fixture = try makeFixture()

    await fixture.session.start()

    let startCalls = await fixture.calls.values()
    XCTAssertEqual(
      startCalls,
      ["microphone.permission", "credential.read", "transport.start", "audio.activate", "input.on"]
    )
    XCTAssertEqual(fixture.session.state.phase, .listening)
    XCTAssertEqual(fixture.session.state.sessionID, "session-1")

    fixture.transport.emit(
      RealtimeServerEvent(
        eventID: "session-created",
        payload: .sessionCreated(
          RealtimeSessionCreated(
            sessionID: "session-1",
            modelID: "gpt-realtime-2.1-mini",
            voiceID: "marin",
            requestID: "request-1"
          )
        )
      )
    )
    await waitUntil { fixture.session.state.phase == .listening }
    XCTAssertEqual(fixture.session.state.sessionID, "session-1")

    await fixture.session.stop()
  }

  func testActivityUsesResponseLifecycleAndRemoteAudioRatherThanTranscriptDeltas() async throws {
    let fixture = try makeFixture()
    await startConnected(fixture)

    XCTAssertTrue(fixture.session.voiceActivity.isListening)
    XCTAssertFalse(fixture.session.voiceActivity.isPreparingResponse)
    fixture.transport.emit(event("created", .responseCreated(RealtimeResponseCreated(responseID: "response-1"))))
    await waitUntil { fixture.session.voiceActivity.isPreparingResponse }

    fixture.transport.emitActivity(
      RealtimeAudioActivitySample(generation: 1, inputLevel: .nan, outputLevel: .infinity)
    )
    await Task.yield()
    XCTAssertFalse(fixture.session.voiceActivity.isResponding)

    fixture.transport.emitActivity(
      RealtimeAudioActivitySample(generation: 1, inputLevel: 0.2, outputLevel: 0.02)
    )
    await waitUntil { fixture.session.voiceActivity.isResponding }
    XCTAssertTrue(fixture.session.voiceActivity.isPreparingResponse)
    XCTAssertEqual(fixture.session.voiceActivity.inputLevel, 0.2)
    XCTAssertEqual(fixture.session.voiceActivity.outputLevel, 0.02)

    fixture.transport.emit(
      event(
        "done",
        .responseDone(
          RealtimeResponseDone(responseID: "response-1", status: .completed, statusDetails: nil, usage: nil)
        )
      )
    )
    await waitUntil { !fixture.session.voiceActivity.isResponding }
    XCTAssertFalse(fixture.session.voiceActivity.isPreparingResponse)

    await fixture.session.setMuted(true)
    XCTAssertEqual(fixture.session.voiceActivity, .inactive)
    await fixture.session.stop()
  }

  func testActivityFloodDoesNotDelayResponseControlEvents() async throws {
    let fixture = try makeFixture()
    await startConnected(fixture)

    for _ in 0 ..< 5_000 {
      fixture.transport.emitActivity(
        RealtimeAudioActivitySample(generation: 1, inputLevel: 0.4, outputLevel: 0)
      )
    }
    fixture.transport.emit(event("created", .responseCreated(RealtimeResponseCreated(responseID: "response-1"))))
    await waitUntil { fixture.session.state.activeResponseID == "response-1" }

    fixture.transport.emit(
      event(
        "done",
        .responseDone(
          RealtimeResponseDone(responseID: "response-1", status: .completed, statusDetails: nil, usage: nil)
        )
      )
    )
    await waitUntil { fixture.session.state.activeResponseID == nil }
    XCTAssertEqual(fixture.session.state.phase, .listening)
    await fixture.session.stop()
  }

  func testDeniedPermissionNeverReadsKeyStartsTransportOrActivatesAudio() async throws {
    let fixture = try makeFixture(permission: .denied)

    await fixture.session.start()

    let calls = await fixture.calls.values()
    XCTAssertEqual(calls, ["microphone.permission"])
    XCTAssertEqual(fixture.session.state.phase, .failed)
    XCTAssertEqual(fixture.session.receipt?.completion, .failed)
    XCTAssertEqual(fixture.session.receipt?.failureCode, "microphone_denied")
  }

  func testInputEnableFailureIsTerminalAndCleansUp() async throws {
    let fixture = try makeFixture()
    fixture.transport.failNextInputEnable()

    await fixture.session.start()

    let calls = await fixture.calls.values()
    XCTAssertEqual(fixture.session.state.phase, .failed)
    XCTAssertEqual(fixture.session.receipt?.completion, .failed)
    XCTAssertEqual(fixture.session.receipt?.failureCode, "input_enable_failed")
    XCTAssertTrue(calls.contains("input.on"))
    XCTAssertTrue(calls.contains("input.off"))
    XCTAssertTrue(calls.contains("transport.close"))
    XCTAssertTrue(calls.contains("audio.deactivate"))
  }

  func testSafetyPauseInputDisableFailureIsTerminalAndNeverPublishesPausedState() async throws {
    let fixture = try makeFixture()
    await startConnected(fixture)
    fixture.transport.failNextInputDisable()

    await fixture.session.handleSafetyEvent(.appInactive)

    let calls = await fixture.calls.values()
    XCTAssertEqual(fixture.session.state.phase, .failed)
    XCTAssertEqual(fixture.session.receipt?.completion, .failed)
    XCTAssertEqual(fixture.session.receipt?.failureCode, "input_disable_failed")
    XCTAssertTrue(calls.contains("input.off"))
    XCTAssertTrue(calls.contains("transport.close"))
    XCTAssertTrue(calls.contains("audio.deactivate"))
  }

  func testEndedLiveServerStreamIsTerminal() async throws {
    let fixture = try makeFixture()
    await startConnected(fixture)

    fixture.transport.finishEvents()
    await waitUntil { fixture.session.state.phase == .failed }

    let calls = await fixture.calls.values()
    XCTAssertEqual(fixture.session.receipt?.completion, .failed)
    XCTAssertEqual(fixture.session.receipt?.failureCode, "transport_closed")
    XCTAssertEqual(
      fixture.session.receipt?.failureMessage,
      "The OpenAI Voice connection closed. Start a new conversation to try again."
    )
    XCTAssertTrue(fixture.session.state.captions.isEmpty)
    XCTAssertTrue(calls.contains("transport.close"))
    XCTAssertTrue(calls.contains("audio.deactivate"))
  }

  func testTerminalTeardownClosesAndDeactivatesWhenInputDisableHangs() async throws {
    let fixture = try makeFixture()
    await startConnected(fixture)
    let gate = AsyncGate()
    await fixture.gates.inputDisable.append(gate)

    let stop = Task { await fixture.session.stop() }
    await gate.waitUntilEntered()
    await stop.value

    let calls = await fixture.calls.values()
    XCTAssertEqual(fixture.session.state.phase, .ended)
    XCTAssertEqual(fixture.session.receipt?.completion, .cancelled)
    XCTAssertTrue(calls.contains("transport.close"))
    XCTAssertTrue(calls.contains("audio.deactivate"))
    await gate.resume()
  }

  func testMuteClearsPendingInputAndStopCancelsClearsAndClosesWithoutFallback() async throws {
    let fixture = try makeFixture()
    await fixture.session.start()
    fixture.transport.emit(
      RealtimeServerEvent(
        eventID: "session-created",
        payload: .sessionCreated(
          RealtimeSessionCreated(
            sessionID: "session-1",
            modelID: "gpt-realtime-2.1-mini",
            voiceID: "marin"
          )
        )
      )
    )
    await waitUntil { fixture.session.state.phase == .listening }

    await fixture.session.setMuted(true)
    XCTAssertEqual(fixture.session.state.phase, .muted)
    await fixture.session.setMuted(false)
    XCTAssertEqual(fixture.session.state.phase, .listening)
    await fixture.session.stop()

    let calls = await fixture.calls.values()
    XCTAssertTrue(calls.contains("input.off"))
    XCTAssertTrue(calls.contains("send.input-clear"))
    XCTAssertTrue(calls.contains("send.response-cancel:nil"))
    XCTAssertTrue(calls.contains("send.output-clear"))
    XCTAssertTrue(calls.contains("transport.close"))
    XCTAssertTrue(calls.contains("audio.deactivate"))
    XCTAssertEqual(fixture.session.receipt?.completion, .cancelled)
    XCTAssertEqual(fixture.session.receipt?.actualModelID, "gpt-realtime-2.1-mini")
    XCTAssertEqual(fixture.session.receipt?.actualVoiceID, "marin")
    XCTAssertEqual(fixture.session.receipt?.requestIDs, [])
  }

  func testSafetyPauseNeverAutoResumesAndExplicitResumeUsesExistingTransport() async throws {
    let fixture = try makeFixture()
    await fixture.session.start()
    fixture.transport.emit(
      RealtimeServerEvent(
        eventID: "session-created",
        payload: .sessionCreated(
          RealtimeSessionCreated(
            sessionID: "session-1",
            modelID: "gpt-realtime-2.1-mini",
            voiceID: "marin"
          )
        )
      )
    )
    await waitUntil { fixture.session.state.phase == .listening }

    await fixture.session.handleSafetyEvent(.appInactive)
    XCTAssertEqual(fixture.session.state.phase, .paused(.appInactive))
    let startsBeforeResume = await fixture.calls.values().filter { $0 == "transport.start" }.count

    await fixture.session.resumeAfterSafetyPause()

    XCTAssertEqual(fixture.session.state.phase, .listening)
    let startsAfterResume = await fixture.calls.values().filter { $0 == "transport.start" }.count
    XCTAssertEqual(
      startsAfterResume,
      startsBeforeResume,
      "Safety resume must not reconnect"
    )
    await fixture.session.stop()
  }

  func testBargeInCommandsAndResponseUsageReachFinalSessionReceipt() async throws {
    let fixture = try makeFixture()
    await fixture.session.start()
    fixture.transport.emit(
      RealtimeServerEvent(
        eventID: "session-created",
        payload: .sessionCreated(
          RealtimeSessionCreated(
            sessionID: "session-1",
            modelID: "gpt-realtime-2.1-mini",
            voiceID: "marin",
            requestID: "request-1"
          )
        )
      )
    )
    fixture.transport.emit(
      event("created", .responseCreated(RealtimeResponseCreated(responseID: "response-1")))
    )
    fixture.transport.emit(
      event(
        "delta",
        .outputAudioTranscriptDelta(
          RealtimeOutputTranscriptDelta(
            responseID: "response-1",
            itemID: "output-1",
            contentIndex: 0,
            delta: "Hello"
          )
        )
      )
    )
    fixture.transport.emit(
      event("speech", .inputAudioSpeechStarted(RealtimeSpeechBoundary(itemID: "input-2")))
    )
    fixture.transport.emit(
      event(
        "done",
        .responseDone(
          RealtimeResponseDone(
            responseID: "response-1",
            status: .cancelled,
            usage: RealtimeTokenUsage(inputTokens: 2, outputTokens: 3, totalTokens: 5)
          )
        )
      )
    )
    await waitUntil { fixture.session.state.turnReceipts.count == 1 }

    await fixture.session.stop()

    let calls = await fixture.calls.values()
    XCTAssertTrue(calls.contains("send.response-cancel:response-1"))
    XCTAssertTrue(calls.contains("send.output-clear"))
    XCTAssertEqual(fixture.session.receipt?.turns.first?.completion, .bargeIn)
    XCTAssertEqual(fixture.session.receipt?.turns.first?.usage?.totalTokens, 5)
    XCTAssertEqual(fixture.session.receipt?.requestIDs, ["request-1"])
  }

  func testStopWhilePermissionIsSuspendedCannotReviveSession() async throws {
    let fixture = try makeFixture()
    let gate = AsyncGate()
    await fixture.gates.microphone.append(gate)
    let start = Task { await fixture.session.start() }
    await gate.waitUntilEntered()

    await fixture.session.stop()
    await gate.resume()
    await start.value

    let calls = await fixture.calls.values()
    XCTAssertEqual(fixture.session.state.phase, .ended)
    XCTAssertEqual(fixture.session.receipt?.completion, .cancelled)
    XCTAssertFalse(calls.contains("credential.read"))
  }

  func testStopWhileCredentialIsSuspendedCannotStartTransport() async throws {
    let fixture = try makeFixture()
    let gate = AsyncGate()
    await fixture.gates.credential.append(gate)
    let start = Task { await fixture.session.start() }
    await gate.waitUntilEntered()

    await fixture.session.stop()
    await gate.resume()
    await start.value

    let calls = await fixture.calls.values()
    XCTAssertEqual(fixture.session.state.phase, .ended)
    XCTAssertFalse(calls.contains("transport.start"))
  }

  func testStopWhileTransportStartIsSuspendedClosesWithoutEnablingInput() async throws {
    let fixture = try makeFixture()
    let gate = AsyncGate()
    await fixture.gates.transportStart.append(gate)
    let start = Task { await fixture.session.start() }
    await gate.waitUntilEntered()

    await fixture.session.stop()
    await gate.resume()
    await start.value

    let calls = await fixture.calls.values()
    XCTAssertEqual(fixture.session.state.phase, .ended)
    XCTAssertFalse(calls.contains("audio.activate"))
    XCTAssertFalse(calls.contains("input.on"))
    XCTAssertEqual(calls.last, "transport.close")
  }

  func testStopWhileAudioActivationIsSuspendedDeactivatesStaleOwnership() async throws {
    let fixture = try makeFixture()
    let gate = AsyncGate()
    await fixture.gates.audioActivation.append(gate)
    let start = Task { await fixture.session.start() }
    await gate.waitUntilEntered()

    await fixture.session.stop()
    await gate.resume()
    await start.value

    let calls = await fixture.calls.values()
    XCTAssertEqual(fixture.session.state.phase, .ended)
    XCTAssertFalse(calls.contains("input.on"))
    XCTAssertEqual(calls.last(where: { $0.hasPrefix("audio.") }), "audio.deactivate")
  }

  func testStopWhileInitialInputEnableIsSuspendedLeavesInputOffAndNoTasksRevive() async throws {
    let fixture = try makeFixture()
    let gate = AsyncGate()
    await fixture.gates.inputEnable.append(gate)
    let start = Task { await fixture.session.start() }
    await gate.waitUntilEntered()

    await fixture.session.stop()
    await gate.resume()
    await start.value

    let calls = await fixture.calls.values()
    XCTAssertEqual(fixture.session.state.phase, .ended)
    XCTAssertEqual(fixture.session.receipt?.completion, .cancelled)
    XCTAssertEqual(calls.last(where: { $0.hasPrefix("input.") }), "input.off")
  }

  func testSafetyDuringSuspendedPermissionTerminatesWithoutStartingResources() async throws {
    try await assertStartupLifecycleTerminates(at: .permission)
  }

  func testSafetyDuringSuspendedCredentialReadTerminatesWithoutStartingTransport() async throws {
    try await assertStartupLifecycleTerminates(at: .credential)
  }

  func testSafetyDuringSuspendedTransportStartClosesLatePeerWithoutRevival() async throws {
    try await assertStartupLifecycleTerminates(at: .transportStart)
  }

  func testSafetyDuringSuspendedAudioActivationClosesAndDeactivatesLateResources() async throws {
    try await assertStartupLifecycleTerminates(at: .audioActivation)
  }

  func testSafetyDuringSuspendedInitialInputEnableRestoresInputOffAndClosesPeer() async throws {
    try await assertStartupLifecycleTerminates(at: .inputEnable)
  }

  func testAudioSafetyDuringStartupFailsInsteadOfPublishingEnded() async throws {
    let fixture = try makeFixture()
    let gate = AsyncGate()
    await fixture.gates.credential.append(gate)
    let start = Task { await fixture.session.start() }
    await gate.waitUntilEntered()

    await fixture.session.handleSafetyEvent(.interruptionBegan)

    XCTAssertEqual(fixture.session.state.phase, .failed)
    XCTAssertEqual(fixture.session.receipt?.completion, .failed)
    XCTAssertEqual(fixture.session.receipt?.failureCode, "startup_interrupted")
    await gate.resume()
    await start.value
    let calls = await fixture.calls.values()
    XCTAssertFalse(calls.contains("transport.start"))
  }

  func testInactiveDuringCredentialStartupWaitsForActiveThenConnects() async throws {
    try await assertInactiveStartupWaits(at: .credential)
  }

  func testInactiveDuringTransportStartupWaitsForActiveThenConnects() async throws {
    try await assertInactiveStartupWaits(at: .transportStart)
  }

  func testInactiveDuringAudioStartupWaitsForActiveThenConnects() async throws {
    try await assertInactiveStartupWaits(at: .audioActivation)
  }

  func testInactiveDuringInputStartupWaitsForActiveThenConnects() async throws {
    try await assertInactiveStartupWaits(at: .inputEnable)
  }

  func testBenignRouteConfigurationChangeDuringStartupReachesListening() async throws {
    let fixture = try makeFixture()
    let gate = AsyncGate()
    await fixture.gates.audioActivation.append(gate)
    let start = Task { await fixture.session.start() }
    await gate.waitUntilEntered()

    await fixture.session.handleSafetyEvent(
      .routeChanged(
        reason: .routeConfigurationChange,
        previous: AssistantAudioRouteSnapshot(
          inputs: [.builtInMic], outputs: [.builtInSpeaker]
        ),
        current: AssistantAudioRouteSnapshot(
          inputs: [.builtInMic], outputs: [.builtInSpeaker]
        )
      )
    )

    XCTAssertEqual(fixture.session.state.phase, .connecting)
    XCTAssertNil(fixture.session.receipt)
    await gate.resume()
    await start.value
    XCTAssertEqual(fixture.session.state.phase, .listening)
    await fixture.session.stop()
  }

  func testNoSuitableRouteDuringStartupRemainsRetryableFailure() async throws {
    let fixture = try makeFixture()
    let gate = AsyncGate()
    await fixture.gates.audioActivation.append(gate)
    let start = Task { await fixture.session.start() }
    await gate.waitUntilEntered()

    await fixture.session.handleSafetyEvent(
      .routeChanged(
        reason: .routeConfigurationChange,
        previous: AssistantAudioRouteSnapshot(
          inputs: [.builtInMic], outputs: [.builtInSpeaker]
        ),
        current: AssistantAudioRouteSnapshot(inputs: [], outputs: [])
      )
    )

    XCTAssertEqual(fixture.session.state.phase, .failed)
    XCTAssertEqual(fixture.session.receipt?.failureCode, "startup_interrupted")
    await gate.resume()
    await start.value
  }

  func testExternalRouteDowngradeDuringStartupRemainsRetryableFailure() async throws {
    let fixture = try makeFixture()
    let gate = AsyncGate()
    await fixture.gates.audioActivation.append(gate)
    let start = Task { await fixture.session.start() }
    await gate.waitUntilEntered()

    await fixture.session.handleSafetyEvent(
      .routeChanged(
        reason: .routeConfigurationChange,
        previous: AssistantAudioRouteSnapshot(
          inputs: [.bluetoothHFP], outputs: [.bluetoothHFP]
        ),
        current: AssistantAudioRouteSnapshot(
          inputs: [.builtInMic], outputs: [.builtInSpeaker]
        )
      )
    )

    XCTAssertEqual(fixture.session.state.phase, .failed)
    XCTAssertEqual(fixture.session.receipt?.failureCode, "startup_interrupted")
    await gate.resume()
    await start.value
  }

  func testInactivePermissionPromptWaitsForExplicitActiveBeforeReadingCredential() async throws {
    let fixture = try makeFixture()
    let gate = AsyncGate()
    await fixture.gates.microphone.append(gate)
    let start = Task { await fixture.session.start() }
    await gate.waitUntilEntered()

    await fixture.session.handleLifecycleChange(.inactive)
    await gate.resume()
    await waitUntil { fixture.session.state.phase == .requestingMicrophone }
    let callsBeforeActive = await fixture.calls.values()
    XCTAssertEqual(callsBeforeActive, ["microphone.permission"])

    await fixture.session.handleLifecycleChange(.active)
    await start.value

    XCTAssertEqual(fixture.session.state.phase, .listening)
    let callsAfterActive = await fixture.calls.values()
    XCTAssertEqual(
      callsAfterActive,
      ["microphone.permission", "credential.read", "transport.start", "audio.activate", "input.on"]
    )
    await fixture.session.stop()
  }

  func testBackgroundWhilePermissionWaitsFailsWithoutCredentialOrRevival() async throws {
    let fixture = try makeFixture()
    let gate = AsyncGate()
    await fixture.gates.microphone.append(gate)
    let start = Task { await fixture.session.start() }
    await gate.waitUntilEntered()

    await fixture.session.handleLifecycleChange(.inactive)
    await fixture.session.handleLifecycleChange(.background)
    XCTAssertEqual(fixture.session.state.phase, .failed)
    XCTAssertEqual(fixture.session.receipt?.failureCode, "startup_interrupted")

    await gate.resume()
    await start.value
    let calls = await fixture.calls.values()
    XCTAssertFalse(calls.contains("credential.read"))
    XCTAssertFalse(calls.contains("transport.start"))
  }

  func testStopWhileAwaitingActiveCannotReviveSession() async throws {
    let fixture = try makeFixture(initialLifecycleState: .inactive)
    let start = Task { await fixture.session.start() }
    await waitUntil { fixture.session.state.phase == .requestingMicrophone }
    await Task.yield()

    await fixture.session.stop()
    await fixture.session.handleLifecycleChange(.active)
    await start.value

    XCTAssertEqual(fixture.session.state.phase, .ended)
    XCTAssertEqual(fixture.session.receipt?.completion, .cancelled)
    let calls = await fixture.calls.values()
    XCTAssertFalse(calls.contains("credential.read"))
  }

  func testInitialBackgroundStartFailsWithoutPermissionOrCredentials() async throws {
    let fixture = try makeFixture(initialLifecycleState: .background)

    await fixture.session.start()

    XCTAssertEqual(fixture.session.state.phase, .failed)
    XCTAssertEqual(fixture.session.receipt?.failureCode, "startup_interrupted")
    XCTAssertEqual(
      fixture.session.receipt?.failureMessage,
      "OpenAI Voice was interrupted while starting. Try again when Enchiridion is active."
    )
    let calls = await fixture.calls.values()
    XCTAssertTrue(calls.isEmpty)
  }

  func testStopWhileUnmuteIsSuspendedLeavesTerminalStateAndInputOff() async throws {
    let fixture = try makeFixture()
    await startConnected(fixture)
    await fixture.session.setMuted(true)
    let gate = AsyncGate()
    await fixture.gates.inputEnable.append(gate)
    let unmute = Task { await fixture.session.setMuted(false) }
    await gate.waitUntilEntered()

    await fixture.session.stop()
    await gate.resume()
    await unmute.value

    let calls = await fixture.calls.values()
    XCTAssertEqual(fixture.session.state.phase, .ended)
    XCTAssertEqual(calls.last(where: { $0.hasPrefix("input.") }), "input.off")
  }

  func testStopWhileSafetyResumeIsSuspendedCannotReactivateAudioOrInput() async throws {
    let fixture = try makeFixture()
    await startConnected(fixture)
    await fixture.session.handleSafetyEvent(.appInactive)
    let gate = AsyncGate()
    await fixture.gates.audioActivation.append(gate)
    let resume = Task { await fixture.session.resumeAfterSafetyPause() }
    await gate.waitUntilEntered()

    await fixture.session.stop()
    await gate.resume()
    await resume.value

    let calls = await fixture.calls.values()
    XCTAssertEqual(fixture.session.state.phase, .ended)
    XCTAssertEqual(calls.last(where: { $0.hasPrefix("audio.") }), "audio.deactivate")
    XCTAssertEqual(calls.last(where: { $0.hasPrefix("input.") }), "input.off")
  }

  func testLateEventsDuringSafetyPauseKeepPauseStickyAndPreserveReceipts() async throws {
    let fixture = try makeFixture()
    await startConnected(fixture)
    await fixture.session.handleSafetyEvent(.appInactive)
    let commandsBeforeEvents = await fixture.calls.values().filter { $0.hasPrefix("send.") }.count

    fixture.transport.emit(
      event("speech-paused", .inputAudioSpeechStarted(RealtimeSpeechBoundary(itemID: "input-2")))
    )
    fixture.transport.emit(
      event("created-paused", .responseCreated(RealtimeResponseCreated(responseID: "response-2")))
    )
    fixture.transport.emit(
      event(
        "done-paused",
        .responseDone(
          RealtimeResponseDone(
            responseID: "response-2",
            status: .completed,
            usage: RealtimeTokenUsage(totalTokens: 4)
          )
        )
      )
    )
    fixture.transport.emit(
      event(
        "error-paused",
        .error(RealtimeCorrelatedError(code: "paused_error", message: "queued"))
      )
    )
    await waitUntil {
      fixture.session.state.turnReceipts.contains { $0.responseID == "response-2" }
        && fixture.session.state.failure?.code == "paused_error"
    }
    let commandsAfterEvents = await fixture.calls.values().filter { $0.hasPrefix("send.") }.count

    XCTAssertEqual(fixture.session.state.phase, .paused(.appInactive))
    XCTAssertEqual(commandsAfterEvents, commandsBeforeEvents)
    XCTAssertEqual(
      fixture.session.state.turnReceipts.first(where: { $0.responseID == "response-2" })?
        .usage?.totalTokens,
      4
    )

    await fixture.session.stop()
    XCTAssertEqual(fixture.session.state.phase, .ended)
  }

  private func startConnected(_ fixture: Fixture) async {
    await fixture.session.start()
    fixture.transport.emit(
      RealtimeServerEvent(
        eventID: "session-created-\(UUID().uuidString)",
        payload: .sessionCreated(
          RealtimeSessionCreated(
            sessionID: "session-1",
            modelID: "gpt-realtime-2.1-mini",
            voiceID: "marin"
          )
        )
      )
    )
    await waitUntil { fixture.session.state.phase == .listening }
  }

  private enum StartupGate: Equatable {
    case permission
    case credential
    case transportStart
    case audioActivation
    case inputEnable
  }

  private func assertStartupLifecycleTerminates(
    at startupGate: StartupGate,
    file: StaticString = #filePath,
    line: UInt = #line
  ) async throws {
    let fixture = try makeFixture()
    let gate = AsyncGate()
    switch startupGate {
    case .permission:
      await fixture.gates.microphone.append(gate)
    case .credential:
      await fixture.gates.credential.append(gate)
    case .transportStart:
      await fixture.gates.transportStart.append(gate)
    case .audioActivation:
      await fixture.gates.audioActivation.append(gate)
    case .inputEnable:
      await fixture.gates.inputEnable.append(gate)
    }
    let start = Task { await fixture.session.start() }
    await gate.waitUntilEntered()

    await fixture.session.handleLifecycleChange(.background)

    XCTAssertEqual(fixture.session.state.phase, .failed, file: file, line: line)
    XCTAssertEqual(fixture.session.receipt?.completion, .failed, file: file, line: line)
    XCTAssertEqual(fixture.session.receipt?.failureCode, "startup_interrupted", file: file, line: line)
    XCTAssertEqual(
      fixture.session.receipt?.failureMessage,
      "OpenAI Voice was interrupted while starting. Try again when Enchiridion is active.",
      file: file,
      line: line
    )
    XCTAssertTrue(fixture.session.state.captions.isEmpty, file: file, line: line)
    let callsAtTermination = await fixture.calls.values()
    XCTAssertFalse(callsAtTermination.contains("input.on"), file: file, line: line)
    switch startupGate {
    case .permission, .credential:
      XCTAssertFalse(callsAtTermination.contains("transport.close"), file: file, line: line)
    case .transportStart, .audioActivation, .inputEnable:
      XCTAssertEqual(
        callsAtTermination.last(where: { $0.hasPrefix("input.") }),
        "input.off",
        file: file,
        line: line
      )
      XCTAssertTrue(callsAtTermination.contains("transport.close"), file: file, line: line)
    }

    await gate.resume()
    await start.value

    let finalCalls = await fixture.calls.values()
    XCTAssertEqual(fixture.session.state.phase, .failed, file: file, line: line)
    XCTAssertEqual(fixture.session.receipt?.completion, .failed, file: file, line: line)
    XCTAssertEqual(
      finalCalls.last(where: { $0.hasPrefix("input.") }),
      startupGate == .permission || startupGate == .credential ? nil : "input.off",
      file: file,
      line: line
    )
    switch startupGate {
    case .permission:
      XCTAssertFalse(finalCalls.contains("credential.read"), file: file, line: line)
      XCTAssertFalse(finalCalls.contains("transport.start"), file: file, line: line)
    case .credential:
      XCTAssertFalse(finalCalls.contains("transport.start"), file: file, line: line)
    case .transportStart:
      XCTAssertFalse(finalCalls.contains("audio.activate"), file: file, line: line)
      XCTAssertEqual(finalCalls.last, "transport.close", file: file, line: line)
    case .audioActivation:
      XCTAssertFalse(finalCalls.contains("input.on"), file: file, line: line)
      XCTAssertEqual(
        finalCalls.last(where: { $0.hasPrefix("audio.") }),
        "audio.deactivate",
        file: file,
        line: line
      )
      XCTAssertEqual(finalCalls.last, "transport.close", file: file, line: line)
    case .inputEnable:
      XCTAssertEqual(
        finalCalls.last(where: { $0.hasPrefix("input.") }),
        "input.off",
        file: file,
        line: line
      )
      XCTAssertEqual(finalCalls.last, "transport.close", file: file, line: line)
    }
  }

  private func assertInactiveStartupWaits(
    at startupGate: StartupGate,
    file: StaticString = #filePath,
    line: UInt = #line
  ) async throws {
    let fixture = try makeFixture()
    let gate = AsyncGate()
    switch startupGate {
    case .permission:
      await fixture.gates.microphone.append(gate)
    case .credential:
      await fixture.gates.credential.append(gate)
    case .transportStart:
      await fixture.gates.transportStart.append(gate)
    case .audioActivation:
      await fixture.gates.audioActivation.append(gate)
    case .inputEnable:
      await fixture.gates.inputEnable.append(gate)
    }
    let start = Task { await fixture.session.start() }
    await gate.waitUntilEntered()

    await fixture.session.handleLifecycleChange(.inactive)
    XCTAssertNotEqual(fixture.session.state.phase, .failed, file: file, line: line)
    XCTAssertNil(fixture.session.receipt, file: file, line: line)
    await gate.resume()
    await Task.yield()
    XCTAssertNotEqual(fixture.session.state.phase, .failed, file: file, line: line)
    XCTAssertNil(fixture.session.receipt, file: file, line: line)

    await fixture.session.handleLifecycleChange(.active)
    await start.value
    XCTAssertEqual(fixture.session.state.phase, .listening, file: file, line: line)
    await fixture.session.stop()
  }

  private func makeFixture(
    permission: RealtimeMicrophonePermission = .authorized,
    initialLifecycleState: RealtimeVoiceLifecycleState = .active
  ) throws -> Fixture {
    let calls = CallRecorder()
    let gates = SessionGates()
    let binding = OpenAICredentialBinding(revision: "revision-1", fingerprint: "fp-1")
    let route = try makeAuthorizedRealtimeVoiceRoute(
      modelID: "gpt-realtime-2.1-mini",
      voiceID: "marin",
      binding: binding
    )
    let transport = FakeRealtimeTransport(calls: calls, gates: gates)
    let session = try RealtimeVoiceSession(
      route: route,
      microphone: FakeMicrophone(permission: permission, calls: calls, gates: gates),
      credentialReader: FakeCredentialReader(binding: binding, calls: calls, gates: gates),
      transport: transport,
      audioSession: FakeRealtimeAudioSession(calls: calls, gates: gates),
      initialLifecycleState: initialLifecycleState
    )
    return Fixture(session: session, transport: transport, calls: calls, gates: gates)
  }

  private func event(
    _ id: String,
    _ payload: RealtimeServerEventPayload
  ) -> RealtimeServerEvent {
    RealtimeServerEvent(eventID: id, payload: payload)
  }

  private func waitUntil(
    _ condition: @MainActor () -> Bool,
    file: StaticString = #filePath,
    line: UInt = #line
  ) async {
    for _ in 0..<200 {
      if condition() { return }
      await Task.yield()
    }
    XCTFail("Condition was not reached", file: file, line: line)
  }
}

private struct Fixture {
  let session: RealtimeVoiceSession
  let transport: FakeRealtimeTransport
  let calls: CallRecorder
  let gates: SessionGates
}

private actor CallRecorder {
  private var calls: [String] = []

  func append(_ call: String) {
    calls.append(call)
  }

  func values() -> [String] {
    calls
  }
}

private struct FakeMicrophone: RealtimeMicrophoneAuthorizing {
  let permission: RealtimeMicrophonePermission
  let calls: CallRecorder
  let gates: SessionGates

  func requestPermission() async -> RealtimeMicrophonePermission {
    if let gate = await gates.microphone.next() { await gate.suspend() }
    await calls.append("microphone.permission")
    return permission
  }
}

private struct FakeCredentialReader: RealtimeCredentialReading {
  let binding: OpenAICredentialBinding
  let calls: CallRecorder
  let gates: SessionGates

  func realtimeCredential(
    matching expectedBinding: OpenAICredentialBinding
  ) async throws -> RealtimeCredentialLease {
    if let gate = await gates.credential.next() { await gate.suspend() }
    await calls.append("credential.read")
    guard binding == expectedBinding else { throw OpenAICredentialStoreError.bindingMismatch }
    return RealtimeCredentialLease(credential: "test-placeholder", binding: binding)
  }
}

private struct FakeRealtimeAudioSession: RealtimeAudioSessionControlling {
  let calls: CallRecorder
  let gates: SessionGates

  func activate() async throws {
    if let gate = await gates.audioActivation.next() { await gate.suspend() }
    await calls.append("audio.activate")
  }

  func deactivate() async {
    await calls.append("audio.deactivate")
  }
}

@MainActor
private final class FakeRealtimeTransport: RealtimeVoiceTransport {
  private let stream: AsyncStream<RealtimeServerEvent>
  private let continuation: AsyncStream<RealtimeServerEvent>.Continuation
  private let activityStream: AsyncStream<RealtimeAudioActivitySample>
  private let activityContinuation: AsyncStream<RealtimeAudioActivitySample>.Continuation
  private let calls: CallRecorder
  private let gates: SessionGates
  private var shouldFailNextInputEnable = false
  private var shouldFailNextInputDisable = false

  init(calls: CallRecorder, gates: SessionGates) {
    self.calls = calls
    self.gates = gates
    let pair = AsyncStream.makeStream(of: RealtimeServerEvent.self)
    stream = pair.stream
    continuation = pair.continuation
    let activity = AsyncStream<RealtimeAudioActivitySample>.makeStream(
      bufferingPolicy: .bufferingNewest(1)
    )
    activityStream = activity.stream
    activityContinuation = activity.continuation
  }

  func start(
    generation: UInt64,
    route: RealtimeVoiceRouteSnapshot,
    configuration: RealtimeVoiceConfiguration,
    credential: RealtimeCredentialLease
  ) async throws -> RealtimeSessionCreated {
    if let gate = await gates.transportStart.next() { await gate.suspend() }
    XCTAssertGreaterThan(generation, 0)
    XCTAssertEqual(credential.generation, route.credentialBinding?.revision)
    XCTAssertTrue(credential.withSecret { !$0.isEmpty })
    await calls.append("transport.start")
    return RealtimeSessionCreated(
      sessionID: "session-1",
      modelID: configuration.modelID,
      voiceID: configuration.voiceID
    )
  }

  func events() -> AsyncStream<RealtimeServerEvent> {
    stream
  }

  func activity() -> AsyncStream<RealtimeAudioActivitySample> {
    activityStream
  }

  func send(_ command: RealtimeClientCommand) async throws {
    switch command {
    case .responseCancel(let responseID):
      await calls.append("send.response-cancel:\(responseID ?? "nil")")
    case .outputAudioBufferClear:
      await calls.append("send.output-clear")
    case .inputAudioBufferClear:
      await calls.append("send.input-clear")
    }
  }

  func setInputEnabled(_ enabled: Bool) async throws {
    if enabled, let gate = await gates.inputEnable.next() { await gate.suspend() }
    if !enabled, let gate = await gates.inputDisable.next() { await gate.suspend() }
    await calls.append(enabled ? "input.on" : "input.off")
    if enabled, shouldFailNextInputEnable {
      shouldFailNextInputEnable = false
      throw FakeRealtimeTransportError.inputTransition
    }
    if !enabled, shouldFailNextInputDisable {
      shouldFailNextInputDisable = false
      throw FakeRealtimeTransportError.inputTransition
    }
  }

  func close() async {
    await calls.append("transport.close")
  }

  func emit(_ event: RealtimeServerEvent) {
    continuation.yield(event)
  }

  func emitActivity(_ sample: RealtimeAudioActivitySample) {
    activityContinuation.yield(sample)
  }

  func finishEvents() {
    continuation.finish()
  }

  func failNextInputEnable() {
    shouldFailNextInputEnable = true
  }

  func failNextInputDisable() {
    shouldFailNextInputDisable = true
  }
}

private enum FakeRealtimeTransportError: Error {
  case inputTransition
}

private final class SessionGates: @unchecked Sendable {
  let microphone = GateQueue()
  let credential = GateQueue()
  let transportStart = GateQueue()
  let audioActivation = GateQueue()
  let inputEnable = GateQueue()
  let inputDisable = GateQueue()
}

private actor GateQueue {
  private var gates: [AsyncGate] = []

  func append(_ gate: AsyncGate) {
    gates.append(gate)
  }

  func next() -> AsyncGate? {
    gates.isEmpty ? nil : gates.removeFirst()
  }
}

private actor AsyncGate {
  private var entered = false
  private var continuation: CheckedContinuation<Void, Never>?

  func suspend() async {
    entered = true
    await withCheckedContinuation { continuation in
      self.continuation = continuation
    }
  }

  func waitUntilEntered() async {
    while !entered { await Task.yield() }
  }

  func resume() {
    let continuation = continuation
    self.continuation = nil
    continuation?.resume()
  }
}
