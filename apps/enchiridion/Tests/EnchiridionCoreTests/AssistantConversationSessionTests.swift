import Foundation
import Observation
import XCTest

@testable import EnchiridionCore

final class AssistantConversationSessionTests: XCTestCase {
  @MainActor
  func testRunsListenAnswerSpeakSeriallyAndContinuesListening() async throws {
    let transcriber = ControlledTranscriber()
    let answerer = ControlledAnswerer()
    let speaker = ControlledSpeaker()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: answerer,
      speaker: speaker,
      speaksResponses: true,
      interTurnDelay: .zero,
      locale: Locale(identifier: "en_GB"),
      now: { Date(timeIntervalSince1970: 1_900_000_000) }
    )

    session.start()
    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    XCTAssertEqual(session.state, .listening)

    await transcriber.succeedNext(with: "What's next?")
    try await waitUntil { await answerer.requests.count == 1 }
    XCTAssertEqual(session.state, .thinking)
    let recordedRequests = await answerer.requests
    let request = try XCTUnwrap(recordedRequests.first)
    XCTAssertEqual(request.utterance, "What's next?")
    XCTAssertTrue(request.priorTurns.isEmpty)
    XCTAssertEqual(request.locale.identifier, "en_GB")
    XCTAssertEqual(request.now, Date(timeIntervalSince1970: 1_900_000_000))

    await answerer.succeedNext(
      with: GroundedAssistantResponse(answer: "Design review is next.", status: .answered)
    )
    try await waitUntil { await speaker.spoken.count == 1 }
    XCTAssertEqual(session.state, .speaking)
    let firstSpokenValues = await speaker.spoken
    XCTAssertEqual(firstSpokenValues, ["Design review is next."])

    await speaker.finishNext()
    try await waitUntil { await transcriber.callCount == 2 }
    XCTAssertEqual(session.state, .listening)
    XCTAssertEqual(session.turns.map(\.utterance), ["What's next?"])

    await session.stop()
    XCTAssertEqual(session.state, .stopped)
    XCTAssertEqual(session.turns.map(\.utterance), ["What's next?"])
  }

  @MainActor
  func testVoiceGreetingSpeaksBeforeListening() async throws {
    let transcriber = ControlledTranscriber()
    let speaker = ControlledSpeaker()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      speaker: speaker,
      speaksResponses: true,
      interTurnDelay: .zero
    )

    await session.startVoice(greeting: "Hello. What can I help with?")
    try await waitUntil { await speaker.spoken.count == 1 }
    XCTAssertEqual(session.state, .speaking)
    let greetingValues = await speaker.spoken
    let captureCountBeforeGreetingFinished = await transcriber.callCount
    XCTAssertEqual(greetingValues, ["Hello. What can I help with?"])
    XCTAssertEqual(captureCountBeforeGreetingFinished, 0)

    await speaker.finishNext()
    try await waitUntil { await transcriber.callCount == 1 }
    XCTAssertEqual(session.state, .listening)

    await session.stop()
  }

  @MainActor
  func testRetainsOnlyFourEphemeralTurnsAndPassesThemAsContext() async throws {
    let transcriber = ScriptedTranscriber(
      utterances: ["question 1", "question 2", "question 3", "question 4", "question 5"]
    )
    let answerer = RecordingAnswerer()
    let speaker = RecordingSpeaker()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: answerer,
      speaker: speaker,
      speaksResponses: true,
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil { await transcriber.callCount == 6 }

    let requests = await answerer.requests
    XCTAssertEqual(requests.count, 5)
    XCTAssertEqual(
      requests[4].priorTurns.map(\.utterance),
      [
        "question 1", "question 2", "question 3", "question 4",
      ])
    XCTAssertEqual(
      session.turns.map(\.utterance),
      [
        "question 2", "question 3", "question 4", "question 5",
      ])
    let spokenValues = await speaker.spoken
    XCTAssertEqual(spokenValues.count, 5)

    await session.stop()
    XCTAssertEqual(session.turns.count, 4)
  }

  @MainActor
  func testTypedAndVoiceRequestsReceiveTheSameBoundedVisibleContext() async throws {
    let typedAnswerer = RecordingAnswerer()
    let typedSession = AssistantConversationSession(answerer: typedAnswerer)
    for index in 1...5 {
      await typedSession.submit("question \(index)")
    }

    let voiceAnswerer = RecordingAnswerer()
    let transcriber = ScriptedTranscriber(
      utterances: (1...5).map { "question \($0)" }
    )
    let voiceSession = AssistantConversationSession(
      transcriber: transcriber,
      answerer: voiceAnswerer,
      interTurnDelay: .zero
    )
    voiceSession.start()
    try await waitUntil { await transcriber.callCount == 6 }

    let typedRequests = await typedAnswerer.requests
    let voiceRequests = await voiceAnswerer.requests
    XCTAssertEqual(typedRequests[4].priorTurns, voiceRequests[4].priorTurns)
    XCTAssertEqual(
      typedRequests[4].priorTurns.map(\.utterance),
      ["question 1", "question 2", "question 3", "question 4"]
    )
    await voiceSession.stop()
  }

  @MainActor
  func testStoppedSuspendedAnswerCannotEnterTheNextRequestContext() async throws {
    let answerer = ControlledAnswerer()
    let speaker = RecordingSpeaker()
    let session = AssistantConversationSession(answerer: answerer, speaker: speaker)

    let staleSubmission = Task { await session.submit("stale suspended request") }
    try await waitUntil { await answerer.requests.count == 1 }
    let stop = Task { await session.stop() }
    try await waitUntil { await speaker.stopCount == 1 }
    await answerer.succeedNext(
      with: GroundedAssistantResponse(answer: "stale released answer", status: .answered)
    )
    await stop.value
    await staleSubmission.value

    let freshSubmission = Task { await session.submit("unrelated fresh request") }
    try await waitUntil { await answerer.requests.count == 2 }
    let requests = await answerer.requests
    XCTAssertTrue(session.turns.isEmpty)
    XCTAssertTrue(requests[1].priorTurns.isEmpty)
    await answerer.succeedNext(
      with: GroundedAssistantResponse(answer: "fresh answer", status: .answered)
    )
    await freshSubmission.value
    XCTAssertEqual(session.turns.map(\.utterance), ["unrelated fresh request"])
  }

  @MainActor
  func testStopCancelsActiveListeningAndPreservesContext() async throws {
    let transcriber = ControlledTranscriber()
    let answerer = RecordingAnswerer()
    let speaker = RecordingSpeaker()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: answerer,
      speaker: speaker,
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    await session.stop()

    XCTAssertEqual(session.state, .stopped)
    XCTAssertFalse(session.isRunning)
    XCTAssertTrue(session.turns.isEmpty)
    let stopCount = await speaker.stopCount
    XCTAssertEqual(stopCount, 1)
    let cancellationCount = await transcriber.cancellationCount
    XCTAssertEqual(cancellationCount, 1, "Stop must await microphone adapter cleanup")
  }

  @MainActor
  func testUngroundedResponseStopsWithoutSpeaking() async throws {
    let transcriber = ScriptedTranscriber(utterances: ["Invent something"])
    let answerer = FixedAnswerer(
      response: GroundedAssistantResponse(
        answer: "I couldn't verify that against your local sources.",
        status: .ungrounded
      )
    )
    let speaker = RecordingSpeaker()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: answerer,
      speaker: speaker,
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil {
      if case .error = session.state { return true }
      return false
    }

    XCTAssertEqual(
      session.state,
      .error(
        AssistantConversationFailure(
          kind: .ungrounded,
          message: "I couldn't answer that confidently. Try asking more specifically."
        )
      )
    )
    let spokenValues = await speaker.spoken
    XCTAssertTrue(spokenValues.isEmpty)
    XCTAssertEqual(session.turns.map(\.utterance), ["Invent something"])
    XCTAssertEqual(
      session.turns.map(\.answer),
      ["I couldn't answer that confidently. Try asking more specifically."]
    )
  }

  @MainActor
  func testTypedChatWorksWithoutSpeechAdapters() async {
    let session = AssistantConversationSession(
      answerer: FixedAnswerer(
        response: GroundedAssistantResponse(
          answer: "Design review is at ten.",
          status: .answered
        )
      ),
      locale: Locale(identifier: "en_GB")
    )

    await session.submit("What is next?")

    XCTAssertEqual(session.state, .idle)
    XCTAssertEqual(
      session.turns,
      [
        AssistantConversationTurn(
          utterance: "What is next?",
          answer: "Design review is at ten.",
          status: .answered,
          provenance: .nonLocal
        )
      ]
    )
    if case .unavailable = session.voiceAvailability {
      // Voice availability never gates typed requests.
    } else {
      XCTFail("A session without a transcriber should report voice as unavailable")
    }
  }

  @MainActor
  func testTypedChatDoesNotSpeakWhenVoiceOutputIsConfigured() async {
    let speaker = RecordingSpeaker()
    let session = AssistantConversationSession(
      answerer: FixedAnswerer(
        response: GroundedAssistantResponse(
          answer: "Design review is at ten.",
          status: .answered
        )
      ),
      speaker: speaker,
      speaksResponses: true
    )

    await session.submit("What is next?")

    XCTAssertEqual(session.state, .idle)
    let spokenValues = await speaker.spoken
    XCTAssertTrue(spokenValues.isEmpty)
  }

  @MainActor
  func testVoiceKeepsFullVisibleAnswerWhileSpeakingComposedAnswer() async throws {
    let fullAnswer = """
      ## Today
      Read the [project plan](https://example.com/private-plan). The design review starts at ten. \
      Bring the draft so the team can compare both options.

      ## Sources
      - Design review
      - Private project plan
      """
    let transcriber = ScriptedTranscriber(utterances: ["What is next?"])
    let speaker = RecordingSpeaker()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: FixedAnswerer(
        response: GroundedAssistantResponse(
          answer: fullAnswer,
          status: .answered,
          sources: [
            AssistantSource(
              id: "event:design-review",
              kind: .calendarEvent,
              title: "Design review"
            )
          ]
        )
      ),
      speaker: speaker,
      speaksResponses: true,
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil { await transcriber.callCount == 2 }

    XCTAssertEqual(session.turns.first?.answer, fullAnswer)
    let spokenValues = await speaker.spoken
    XCTAssertEqual(
      spokenValues,
      [
        "Today: Read the project plan. The design review starts at ten. "
          + "You can ask me to keep going."
      ]
    )
    await session.stop()
  }

  @MainActor
  func testDeniedVoiceDoesNotEraseTypedConversationOrStartCapture() async {
    let transcriber = DeniedTranscriber()
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: FixedAnswerer(
        response: GroundedAssistantResponse(answer: "Local answer", status: .answered)
      ),
      audioSessionController: audioSession
    )

    await session.submit("Typed first")
    await session.startVoice()

    XCTAssertEqual(session.voiceAvailability, .permissionDenied)
    XCTAssertEqual(session.turns.map(\.utterance), ["Typed first"])
    let captureCount = await transcriber.captureCount
    XCTAssertEqual(captureCount, 0)
    let activationCount = await audioSession.activationCount
    XCTAssertEqual(activationCount, 0)
  }

  @MainActor
  func testConcurrentVoiceStartsCommitOnlyOneOperationAfterAvailabilityCheck() async throws {
    let transcriber = SuspendedAvailabilityTranscriber()
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      audioSessionController: audioSession,
      interTurnDelay: .zero
    )

    async let first: Void = session.startVoice()
    async let second: Void = session.startVoice()
    try await waitUntil { await transcriber.availabilityCheckCount == 1 }
    await transcriber.resumeAvailabilityChecks()
    _ = await (first, second)
    try await waitUntil { await transcriber.captureCount == 1 }

    XCTAssertTrue(session.isVoiceRunning)
    let captureCount = await transcriber.captureCount
    XCTAssertEqual(captureCount, 1)
    let activationCount = await audioSession.activationCount
    XCTAssertEqual(activationCount, 1)
    await session.stop()
    let deactivationCount = await audioSession.deactivationCount
    XCTAssertEqual(deactivationCount, 1)
  }

  @MainActor
  func testStopInvalidatesAVoiceStartWaitingOnPreflight() async throws {
    let transcriber = SuspendedAvailabilityTranscriber()
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      audioSessionController: audioSession,
      interTurnDelay: .zero
    )

    async let start: Void = session.startVoice()
    try await waitUntil { await transcriber.availabilityCheckCount == 1 }
    await session.stop()
    await transcriber.resumeAvailabilityChecks()
    _ = await start

    XCTAssertEqual(session.state, .stopped)
    XCTAssertFalse(session.isVoiceRunning)
    let captureCount = await transcriber.captureCount
    XCTAssertEqual(captureCount, 0)
    let activationCount = await audioSession.activationCount
    XCTAssertEqual(activationCount, 0)
  }

  @MainActor
  func testStopInvalidatesAVoiceStartWaitingOnPermission() async throws {
    let transcriber = SuspendedPermissionTranscriber()
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      audioSessionController: audioSession,
      interTurnDelay: .zero
    )

    async let start: Void = session.startVoice()
    try await waitUntil { await transcriber.permissionRequestCount == 1 }
    await session.stop()
    await transcriber.resumePermissionRequest()
    _ = await start

    XCTAssertEqual(session.state, .stopped)
    XCTAssertFalse(session.isVoiceRunning)
    let captureCount = await transcriber.captureCount
    XCTAssertEqual(captureCount, 0)
    let activationCount = await audioSession.activationCount
    XCTAssertEqual(activationCount, 0)
  }

  @MainActor
  func testVoiceWaitsForPermissionBeforeStartingCapture() async throws {
    let transcriber = SuspendedPermissionTranscriber()
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      audioSessionController: audioSession,
      interTurnDelay: .zero
    )

    async let start: Void = session.startVoice()
    try await waitUntil { await transcriber.permissionRequestCount == 1 }
    let captureCountBeforePermission = await transcriber.captureCount
    XCTAssertEqual(captureCountBeforePermission, 0)
    let activationCountBeforePermission = await audioSession.activationCount
    XCTAssertEqual(activationCountBeforePermission, 0)

    await transcriber.resumePermissionRequest()
    _ = await start
    try await waitUntil { await transcriber.captureCount == 1 }

    XCTAssertTrue(session.isVoiceRunning)
    let activationCount = await audioSession.activationCount
    XCTAssertEqual(activationCount, 1)
    await session.stop()
  }

  @MainActor
  func testAudioSessionActivatesOnceAcrossTwoListenThinkSpeakTurns() async throws {
    let transcriber = ProgressiveTranscriber()
    let answerer = ControlledAnswerer()
    let speaker = ControlledSpeaker()
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: answerer,
      speaker: speaker,
      audioSessionController: audioSession,
      speaksResponses: true,
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    var audioCounts = await audioSession.counts()
    XCTAssertEqual(audioCounts.activations, 1)
    XCTAssertEqual(audioCounts.deactivations, 0)

    await transcriber.finish(.utterance("first request"), forCall: 0)
    try await waitUntil { await answerer.requests.count == 1 }
    XCTAssertEqual(session.state, .thinking)
    audioCounts = await audioSession.counts()
    XCTAssertEqual(audioCounts.deactivations, 0)

    await answerer.succeedNext(
      with: GroundedAssistantResponse(answer: "first answer", status: .answered)
    )
    try await waitUntil { await speaker.spoken.count == 1 }
    XCTAssertEqual(session.state, .speaking)
    audioCounts = await audioSession.counts()
    XCTAssertEqual(audioCounts.deactivations, 0)

    await speaker.finishNext()
    try await waitUntil { await transcriber.callCount == 2 }
    XCTAssertEqual(session.state, .listening)
    audioCounts = await audioSession.counts()
    XCTAssertEqual(audioCounts.activations, 1)
    XCTAssertEqual(audioCounts.deactivations, 0)

    await transcriber.finish(.utterance("second request"), forCall: 1)
    try await waitUntil { await answerer.requests.count == 2 }
    audioCounts = await audioSession.counts()
    XCTAssertEqual(audioCounts.deactivations, 0)
    await answerer.succeedNext(
      with: GroundedAssistantResponse(answer: "second answer", status: .answered)
    )
    try await waitUntil { await speaker.spoken.count == 2 }
    audioCounts = await audioSession.counts()
    XCTAssertEqual(audioCounts.deactivations, 0)
    await speaker.finishNext()
    try await waitUntil { await transcriber.callCount == 3 }
    audioCounts = await audioSession.counts()
    XCTAssertEqual(audioCounts.activations, 1)
    XCTAssertEqual(audioCounts.deactivations, 0)

    await session.stop()
    audioCounts = await audioSession.counts()
    XCTAssertEqual(audioCounts.deactivations, 1)
  }

  @MainActor
  func testNaturalNoSpeechCompletionReleasesAudioSessionExactlyOnce() async throws {
    let transcriber = ProgressiveTranscriber()
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      audioSessionController: audioSession,
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    await transcriber.finish(.noSpeech, forCall: 0)
    try await waitUntil { await audioSession.deactivationCount == 1 }

    let audioCounts = await audioSession.counts()
    XCTAssertEqual(audioCounts.activations, 1)
    XCTAssertEqual(audioCounts.deactivations, 1)
    XCTAssertFalse(session.isVoiceRunning)
  }

  @MainActor
  func testTranscriptionFailureReleasesAudioSessionExactlyOnce() async throws {
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: FailingTranscriber(),
      answerer: RecordingAnswerer(),
      audioSessionController: audioSession,
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil { await audioSession.deactivationCount == 1 }

    let audioCounts = await audioSession.counts()
    XCTAssertEqual(audioCounts.activations, 1)
    XCTAssertEqual(audioCounts.deactivations, 1)
    guard case .error(let failure) = session.state else {
      return XCTFail("Expected a transcription error")
    }
    XCTAssertEqual(failure.kind, .transcription)
  }

  @MainActor
  func testSpeakerFailureReleasesAudioSessionExactlyOnce() async throws {
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: ScriptedTranscriber(utterances: ["question"]),
      answerer: RecordingAnswerer(),
      speaker: FailingSpeaker(),
      audioSessionController: audioSession,
      speaksResponses: true,
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil { await audioSession.deactivationCount == 1 }

    let audioCounts = await audioSession.counts()
    XCTAssertEqual(audioCounts.activations, 1)
    XCTAssertEqual(audioCounts.deactivations, 1)
    guard case .error(let failure) = session.state else {
      return XCTFail("Expected a speaking error")
    }
    XCTAssertEqual(failure.kind, .speaking)
  }

  @MainActor
  func testUnavailableAndUngroundedResponsesEachReleaseTheirAudioSession() async throws {
    for status in [AssistantResponseStatus.unavailable, .ungrounded] {
      let audioSession = RecordingAudioSessionController()
      let session = AssistantConversationSession(
        transcriber: ScriptedTranscriber(utterances: ["question"]),
        answerer: FixedAnswerer(
          response: GroundedAssistantResponse(answer: "terminal response", status: status)
        ),
        audioSessionController: audioSession,
        interTurnDelay: .zero
      )

      session.start()
      try await waitUntil { await audioSession.deactivationCount == 1 }

      let audioCounts = await audioSession.counts()
      XCTAssertEqual(audioCounts.activations, 1)
      XCTAssertEqual(audioCounts.deactivations, 1)
    }
  }

  @MainActor
  func testUnavailablePreflightNeverActivatesAudioSession() async {
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: UnavailableTranscriber(),
      answerer: RecordingAnswerer(),
      audioSessionController: audioSession
    )

    await session.startVoice()

    let audioCounts = await audioSession.counts()
    XCTAssertEqual(audioCounts.activations, 0)
    XCTAssertEqual(audioCounts.deactivations, 0)
  }

  @MainActor
  func testStaleSuspendedActivationReleasesWithoutStartingCapture() async throws {
    let transcriber = ControlledTranscriber()
    let audioSession = SuspendedAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      audioSessionController: audioSession,
      interTurnDelay: .zero
    )
    let replacementSurface = UUID()

    async let start: Void = session.startVoice()
    try await waitUntil { await audioSession.activationCount == 1 }
    async let replace: Void = session.activateSurface(replacementSurface)
    await audioSession.resumeActivation()
    _ = await (start, replace)

    let audioCounts = await audioSession.counts()
    let captureCount = await transcriber.callCount
    XCTAssertEqual(audioCounts.activations, 1)
    XCTAssertEqual(audioCounts.deactivations, 1)
    XCTAssertEqual(captureCount, 0)
    XCTAssertEqual(session.state, .idle)
  }

  @MainActor
  func testSurfaceAndBackgroundCleanupEachReleaseExactlyOnce() async throws {
    let surfaceAudioSession = RecordingAudioSessionController()
    let surfaceSession = AssistantConversationSession(
      transcriber: ControlledTranscriber(),
      answerer: RecordingAnswerer(),
      audioSessionController: surfaceAudioSession,
      interTurnDelay: .zero
    )
    let surfaceID = UUID()
    await surfaceSession.activateSurface(surfaceID)
    surfaceSession.start()
    try await waitUntil { await surfaceAudioSession.activationCount == 1 }
    await surfaceSession.stopSurface(surfaceID)
    let surfaceAudioCounts = await surfaceAudioSession.counts()
    XCTAssertEqual(surfaceAudioCounts.deactivations, 1)

    let backgroundAudioSession = RecordingAudioSessionController()
    let backgroundSession = AssistantConversationSession(
      transcriber: ControlledTranscriber(),
      answerer: RecordingAnswerer(),
      audioSessionController: backgroundAudioSession,
      interTurnDelay: .zero
    )
    backgroundSession.start()
    try await waitUntil { await backgroundAudioSession.activationCount == 1 }
    await backgroundSession.stop()
    let backgroundAudioCounts = await backgroundAudioSession.counts()
    XCTAssertEqual(backgroundAudioCounts.deactivations, 1)
  }

  @MainActor
  func testResetClearsVisibleAndModelConversationContext() async {
    let answerer = ResetRecordingAnswerer()
    let session = AssistantConversationSession(answerer: answerer)

    await session.submit("Remember this only for this surface")
    await session.reset()

    XCTAssertTrue(session.turns.isEmpty)
    XCTAssertEqual(session.state, .idle)
    let resetCount = await answerer.resetCount
    XCTAssertEqual(resetCount, 1)

    await session.submit("Start over")
    let requests = await answerer.requests
    XCTAssertEqual(
      requests.map(\.utterance),
      ["Remember this only for this surface", "Start over"]
    )
    XCTAssertTrue(requests[1].priorTurns.isEmpty)
  }

  @MainActor
  func testInterruptionWhileListeningPausesOnceAndPreservesCommittedTurns() async throws {
    let events = ManualVoiceSafetyEventSource()
    let transcriber = ControlledTranscriber()
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      audioSessionController: audioSession,
      voiceSafetyEventSource: events,
      interTurnDelay: .zero
    )
    await session.submit("keep this turn")
    session.start()
    try await waitUntil { await transcriber.callCount == 1 }

    events.emit(.interruptionBegan)
    try await waitUntil { session.voicePauseReason == .interruption }
    events.emit(.interruptionBegan)
    try await Task.sleep(for: .milliseconds(20))

    XCTAssertEqual(session.state, .stopped)
    XCTAssertEqual(session.turns.map(\.utterance), ["keep this turn"])
    XCTAssertFalse(session.isVoiceRunning)
    let cancellationCount = await transcriber.cancellationCount
    let deactivationCount = await audioSession.deactivationCount
    XCTAssertEqual(cancellationCount, 1)
    XCTAssertEqual(deactivationCount, 1)
  }

  @MainActor
  func testUnsafeRouteWhileThinkingFencesLateAnswerAndSpeech() async throws {
    let transcriber = ControlledTranscriber()
    let answerer = ControlledAnswerer()
    let speaker = ControlledSpeaker()
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: answerer,
      speaker: speaker,
      audioSessionController: audioSession,
      speaksResponses: true,
      interTurnDelay: .zero
    )
    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    await transcriber.succeedNext(with: "unsafe pending request")
    try await waitUntil { await answerer.requests.count == 1 }

    let pause = Task {
      await session.handleVoiceSafetyEvent(
        .routeChanged(
          reason: .oldDeviceUnavailable,
          previous: AssistantAudioRouteSnapshot(inputs: [.headsetMic], outputs: [.headphones]),
          current: AssistantAudioRouteSnapshot(
            inputs: [.builtInMic],
            outputs: [.builtInSpeaker]
          )
        )
      )
    }
    try await waitUntil { !session.isVoiceRunning }
    await answerer.succeedNext(
      with: GroundedAssistantResponse(answer: "late private answer", status: .answered)
    )
    await pause.value

    XCTAssertEqual(session.voicePauseReason, .routeChanged)
    XCTAssertTrue(session.turns.isEmpty)
    let spoken = await speaker.spoken
    let deactivationCount = await audioSession.deactivationCount
    XCTAssertTrue(spoken.isEmpty)
    XCTAssertEqual(deactivationCount, 1)
  }

  @MainActor
  func testMediaResetWhileSpeakingStopsSpeechPreservesTurnAndRunsResetHooks() async throws {
    let transcriber = ControlledTranscriber()
    let speaker = ControlledSpeaker()
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      speaker: speaker,
      audioSessionController: audioSession,
      speaksResponses: true,
      interTurnDelay: .zero
    )
    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    await transcriber.succeedNext(with: "committed request")
    try await waitUntil { await speaker.spoken.count == 1 }

    await session.handleVoiceSafetyEvent(.mediaServicesReset)

    XCTAssertEqual(session.voicePauseReason, .mediaServicesRestarted)
    XCTAssertEqual(session.turns.map(\.utterance), ["committed request"])
    let speakerStopCount = await speaker.stopCount
    let speakerResetCount = await speaker.resetCount
    let transcriberResetCount = await transcriber.resetCount
    let audioResetCount = await audioSession.resetCount
    let deactivationCount = await audioSession.deactivationCount
    XCTAssertEqual(speakerStopCount, 1)
    XCTAssertEqual(speakerResetCount, 1)
    XCTAssertEqual(transcriberResetCount, 1)
    XCTAssertEqual(audioResetCount, 1)
    XCTAssertEqual(deactivationCount, 1)
  }

  @MainActor
  func testSafetyEventsNeverCancelTypedAnswer() async throws {
    let events = ManualVoiceSafetyEventSource()
    let answerer = ControlledAnswerer()
    let session = AssistantConversationSession(
      transcriber: ControlledTranscriber(),
      answerer: answerer,
      voiceSafetyEventSource: events
    )

    async let submission: Void = session.submit("typed request")
    try await waitUntil { await answerer.requests.count == 1 }
    events.emit(.interruptionBegan)
    try await Task.sleep(for: .milliseconds(20))
    XCTAssertEqual(session.state, .thinking)
    XCTAssertNil(session.voicePauseReason)

    await answerer.succeedNext(
      with: GroundedAssistantResponse(answer: "typed answer", status: .answered)
    )
    _ = await submission
    XCTAssertEqual(session.turns.map(\.answer), ["typed answer"])
  }

  @MainActor
  func testBenignRouteEventsNeverPauseOrResumeVoice() async throws {
    let transcriber = ControlledTranscriber()
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      audioSessionController: audioSession,
      interTurnDelay: .zero
    )
    let builtIn = AssistantAudioRouteSnapshot(
      inputs: [.builtInMic],
      outputs: [.builtInSpeaker]
    )
    let external = AssistantAudioRouteSnapshot(
      inputs: [.bluetoothHFP],
      outputs: [.bluetoothHFP]
    )
    session.start()
    try await waitUntil { await transcriber.callCount == 1 }

    await session.handleVoiceSafetyEvent(
      .routeChanged(reason: .newDeviceAvailable, previous: builtIn, current: external)
    )
    XCTAssertEqual(session.state, .listening)
    XCTAssertNil(session.voicePauseReason)
    let activeDeactivationCount = await audioSession.deactivationCount
    XCTAssertEqual(activeDeactivationCount, 0)

    await session.handleVoiceSafetyEvent(.interruptionBegan)
    XCTAssertEqual(session.state, .stopped)
    await session.handleVoiceSafetyEvent(
      .routeChanged(reason: .newDeviceAvailable, previous: builtIn, current: external)
    )
    XCTAssertEqual(session.state, .stopped)
    let captureCount = await transcriber.callCount
    XCTAssertEqual(captureCount, 1)
  }

  @MainActor
  func testExplicitMicStartClearsPauseAndRestartsExactlyOnce() async throws {
    let transcriber = ControlledTranscriber()
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      audioSessionController: audioSession,
      interTurnDelay: .zero
    )
    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    await session.handleVoiceSafetyEvent(.appInactive)
    XCTAssertEqual(session.voicePauseReason, .appInactive)

    await session.startVoice()
    try await waitUntil { await transcriber.callCount == 2 }

    XCTAssertNil(session.voicePauseReason)
    XCTAssertTrue(session.isVoiceRunning)
    let activationCount = await audioSession.activationCount
    XCTAssertEqual(activationCount, 2)
    await session.stop()
  }

  @MainActor
  func testMediaResetHooksRunWhileIdleAndStoppedAndDuplicatesAreIdempotent() async throws {
    let transcriber = ControlledTranscriber()
    let speaker = ControlledSpeaker()
    let audioSession = RecordingAudioSessionController()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      speaker: speaker,
      audioSessionController: audioSession,
      interTurnDelay: .zero
    )

    await session.handleVoiceSafetyEvent(.mediaServicesReset)
    await session.handleVoiceSafetyEvent(.mediaServicesReset)
    var transcriberResetCount = await transcriber.resetCount
    var speakerResetCount = await speaker.resetCount
    var audioResetCount = await audioSession.resetCount
    XCTAssertEqual(transcriberResetCount, 1)
    XCTAssertEqual(speakerResetCount, 1)
    XCTAssertEqual(audioResetCount, 1)

    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    let activationCount = await audioSession.activationCount
    XCTAssertEqual(activationCount, 1)
    await session.handleVoiceSafetyEvent(.appInactive)
    await session.handleVoiceSafetyEvent(.mediaServicesLost)
    transcriberResetCount = await transcriber.resetCount
    speakerResetCount = await speaker.resetCount
    audioResetCount = await audioSession.resetCount
    XCTAssertEqual(transcriberResetCount, 2)
    XCTAssertEqual(speakerResetCount, 2)
    XCTAssertEqual(audioResetCount, 2)
  }

  @MainActor
  func testInactiveThenForegroundRefreshNeverRestartsVoice() async throws {
    let transcriber = ControlledTranscriber()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      interTurnDelay: .zero
    )
    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    await session.handleVoiceSafetyEvent(.appInactive)

    await session.refreshVoiceAvailability()
    try await Task.sleep(for: .milliseconds(20))

    XCTAssertEqual(session.state, .stopped)
    XCTAssertEqual(session.voicePauseReason, .appInactive)
    let captureCount = await transcriber.callCount
    XCTAssertEqual(captureCount, 1)
  }

  func testTranscriptStabilityUsesExactNoSpeechAndStableBoundaries() {
    var tracker = AssistantTranscriptStabilityTracker()

    XCTAssertEqual(tracker.decision(at: .milliseconds(4_999)), .continueListening)
    XCTAssertEqual(tracker.decision(at: .seconds(5)), .noSpeech)

    tracker = AssistantTranscriptStabilityTracker()
    XCTAssertEqual(tracker.record("  review   today  ", at: .seconds(1)), "review today")
    XCTAssertNil(tracker.record("review today", at: .seconds(2)))
    XCTAssertNil(tracker.record("   ", at: .milliseconds(2_100)))
    XCTAssertEqual(tracker.decision(at: .milliseconds(2_199)), .continueListening)
    XCTAssertEqual(tracker.decision(at: .milliseconds(2_200)), .finalize("review today"))
  }

  func testTranscriptStabilityResetsOnlyForChangedNonemptyTextAndHonorsHardLimit() {
    var tracker = AssistantTranscriptStabilityTracker()
    tracker.record("review", at: .seconds(1))
    tracker.record("review today", at: .seconds(2))

    XCTAssertEqual(tracker.decision(at: .milliseconds(3_199)), .continueListening)
    XCTAssertEqual(tracker.decision(at: .milliseconds(3_200)), .finalize("review today"))

    tracker = AssistantTranscriptStabilityTracker()
    tracker.record("hard limit", at: .milliseconds(14_900))
    XCTAssertEqual(tracker.decision(at: .milliseconds(14_999)), .continueListening)
    XCTAssertEqual(tracker.decision(at: .seconds(15)), .finalize("hard limit"))
  }

  func testFinalizationUsesCorrectedLatestTranscriptWithoutReversingNoSpeech() {
    var tracker = AssistantTranscriptStabilityTracker()
    tracker.record("review today", at: .seconds(1))
    let endpointOutcome = AssistantTranscriptionOutcome.utterance("review today")
    tracker.record("Review today.", at: .milliseconds(2_300))

    XCTAssertEqual(
      tracker.finalizedOutcome(preserving: endpointOutcome),
      .utterance("Review today.")
    )

    tracker = AssistantTranscriptStabilityTracker()
    tracker.record("late hypothesis", at: .milliseconds(5_100))
    XCTAssertEqual(tracker.finalizedOutcome(preserving: .noSpeech), .noSpeech)
  }

  func testLegacyTranscriberReceivesOutcomeThroughCompatibilityBridge() async throws {
    let transcriber = ScriptedTranscriber(utterances: ["  legacy request  "])

    let outcome = try await transcriber.transcribe(reportingProgress: { _ in })

    XCTAssertEqual(outcome, .utterance("legacy request"))
  }

  @MainActor
  func testProgressIsVisibleButOnlyFinalOutcomeIsSubmitted() async throws {
    let transcriber = ProgressiveTranscriber()
    let answerer = RecordingAnswerer()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: answerer,
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    await transcriber.emit("Review", forCall: 0)
    await transcriber.emit("Review today", forCall: 0)
    XCTAssertEqual(session.liveTranscript, "Review today")
    XCTAssertTrue(session.turns.isEmpty)

    await transcriber.finish(.utterance("Review today"), forCall: 0)
    try await waitUntil { await transcriber.callCount == 2 }

    XCTAssertTrue(session.isVoiceRunning, "CarPlay audio must stay active between turns")
    XCTAssertEqual(session.voiceOperationCompletionGeneration, 0)
    let requests = await answerer.requests
    XCTAssertEqual(requests.map(\.utterance), ["Review today"])
    XCTAssertEqual(session.turns.map(\.utterance), ["Review today"])
    await session.stop()
  }

  @MainActor
  func testProgressAfterFinalOutcomeCannotRepopulateTranscriptWhileThinking() async throws {
    let transcriber = ProgressiveTranscriber()
    let answerer = ControlledAnswerer()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: answerer,
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    await transcriber.emit("accepted request", forCall: 0)
    await transcriber.finish(.utterance("accepted request"), forCall: 0)
    try await waitUntil { await answerer.requests.count == 1 }
    XCTAssertEqual(session.state, .thinking)

    await transcriber.emit("escaped final progress", forCall: 0)
    XCTAssertTrue(session.liveTranscript.isEmpty)

    await answerer.succeedNext(
      with: GroundedAssistantResponse(answer: "answer", status: .answered)
    )
    try await waitUntil { await transcriber.callCount == 2 }
    await session.stop()
  }

  @MainActor
  func testStaleProgressCannotRepopulateTranscriptAfterStopOrNewTurn() async throws {
    let transcriber = ProgressiveTranscriber()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    await transcriber.emit("first", forCall: 0)
    XCTAssertEqual(session.liveTranscript, "first")

    await session.stop()
    await transcriber.emit("stale after stop", forCall: 0)
    XCTAssertTrue(session.liveTranscript.isEmpty)

    session.start()
    try await waitUntil { await transcriber.callCount == 2 }
    await transcriber.emit("second", forCall: 1)
    await transcriber.emit("stale first turn", forCall: 0)
    XCTAssertEqual(session.liveTranscript, "second")
    await session.stop()
  }

  @MainActor
  func testConsecutiveVoiceTurnsResetTheProvisionalTranscript() async throws {
    let transcriber = ProgressiveTranscriber()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    await transcriber.emit("first request", forCall: 0)
    await transcriber.finish(.utterance("first request"), forCall: 0)
    try await waitUntil { await transcriber.callCount == 2 }

    XCTAssertTrue(session.liveTranscript.isEmpty)
    await transcriber.emit("second request", forCall: 1)
    XCTAssertEqual(session.liveTranscript, "second request")
    await session.stop()
  }

  @MainActor
  func testNoSpeechReturnsToIdleWithoutAnErrorOrConversationTurn() async throws {
    let transcriber = ProgressiveTranscriber()
    let answerer = RecordingAnswerer()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: answerer,
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    let completionGeneration = session.voiceOperationCompletionGeneration
    let operationEnded = expectation(description: "Voice operation lifecycle ended")
    withObservationTracking(
      { _ = session.voiceOperationCompletionGeneration },
      onChange: { operationEnded.fulfill() }
    )
    await transcriber.finish(.noSpeech, forCall: 0)
    await fulfillment(of: [operationEnded], timeout: 1)
    try await waitUntil { !session.isVoiceRunning }
    await transcriber.emit("escaped no-speech progress", forCall: 0)

    XCTAssertEqual(session.state, .idle)
    XCTAssertEqual(session.voiceOperationCompletionGeneration, completionGeneration + 1)
    XCTAssertTrue(session.liveTranscript.isEmpty)
    XCTAssertEqual(
      session.voiceInputNotice,
      "No speech detected. Tap the microphone to try again."
    )
    XCTAssertTrue(session.turns.isEmpty)
    let requests = await answerer.requests
    XCTAssertTrue(requests.isEmpty)
  }

  @MainActor
  func testSurfaceReplacementClearsProgressAndFencesLateCallbacks() async throws {
    let transcriber = ProgressiveTranscriber()
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: RecordingAnswerer(),
      interTurnDelay: .zero
    )
    let firstSurface = UUID()
    await session.activateSurface(firstSurface)

    session.start()
    try await waitUntil { await transcriber.callCount == 1 }
    await transcriber.emit("private draft", forCall: 0)
    XCTAssertEqual(session.liveTranscript, "private draft")

    await session.activateSurface(UUID())
    await transcriber.emit("late private draft", forCall: 0)

    XCTAssertTrue(session.liveTranscript.isEmpty)
    XCTAssertTrue(session.turns.isEmpty)
    XCTAssertEqual(session.state, .idle)
  }

  func testSpokenFormatterKeepsConversationalResponseNatural() {
    let response = GroundedAssistantResponse(
      answer: "Hello! How can I help?",
      status: .answered
    )

    XCTAssertEqual(
      AssistantSpokenResponseFormatter.spokenText(for: response),
      "Hello! How can I help?"
    )
  }

  func testSpokenFormatterOmitsDuplicateAndMultipleSources() {
    let first = AssistantSource(id: "event:one", kind: .calendarEvent, title: "Design review")
    let second = AssistantSource(id: "page:two", kind: .page, title: "Private project plan")
    let response = GroundedAssistantResponse(
      answer: "It starts at ten. Sources: Design review, Private project plan.",
      status: .answered,
      sources: [first, first, second]
    )

    let spoken = AssistantSpokenResponseFormatter.spokenText(for: response)
    XCTAssertEqual(spoken, "It starts at ten.")
    XCTAssertFalse(spoken.contains("Sources:"))
    XCTAssertFalse(spoken.contains("Design review"))
    XCTAssertFalse(spoken.contains("Private project plan"))
  }

  func testSpokenFormatterNormalizesDecoratedSourceSectionsBeforeOmittingThem() {
    let answers = [
      """
      The review starts at ten.

      ## **Sources**
      - Secret calendar title
      - event:secret-source
      """,
      """
      The review starts at ten.

      **Sources:** Secret calendar title
      - event:secret-source
      """,
      """
      The review starts at ten.

      **Source:** Secret calendar title
      - event:secret-source
      """,
      """
      The review starts at ten.

      - **Sources:**
        - Secret calendar title
        - event:secret-source
      """,
      """
      The review starts at ten.

      > ### **Source**
      > - Secret calendar title
      > - event:secret-source
      """,
    ]

    for answer in answers {
      let spoken = AssistantSpokenResponseFormatter.spokenText(
        for: GroundedAssistantResponse(answer: answer, status: .answered)
      )
      XCTAssertEqual(spoken, "The review starts at ten.")
      XCTAssertFalse(spoken.localizedCaseInsensitiveContains("sources"))
      XCTAssertFalse(spoken.contains("Secret calendar title"))
      XCTAssertFalse(spoken.contains("event:secret-source"))
    }
  }

  func testSpokenFormatterOmitsFencedCodeAndURLLikeIdentifiers() {
    let response = GroundedAssistantResponse(
      answer: """
        Your report is ready.
        ```text
        event:fenced-secret-source
        file:///private/fenced-report
        ```
        event:outside-secret-source
        file:///private/report
        ftp://files.example.com/private-report
        enchiridion://page/private-report
        Open [the private page](enchiridion://page/private-report).
        """,
      status: .answered
    )

    let spoken = AssistantSpokenResponseFormatter.spokenText(for: response)
    XCTAssertEqual(spoken, "Your report is ready. Open the private page.")
    XCTAssertFalse(spoken.contains("secret-source"))
    XCTAssertFalse(spoken.contains("private-report"))
    XCTAssertFalse(spoken.contains("://"))
  }

  func testSpokenFormatterOmitsQuotedFencedContent() {
    let response = GroundedAssistantResponse(
      answer: """
        Your report is ready.
        > ```text
        > event:quoted-secret-source
        > file:///private/quoted-report
        > ```
        Keep the visible summary.
        """,
      status: .answered
    )

    XCTAssertEqual(
      AssistantSpokenResponseFormatter.spokenText(for: response),
      "Your report is ready. Keep the visible summary."
    )
  }

  func testSpokenFormatterRemovesBoundedURIsWithoutRemovingColonProse() {
    let privateTokens = [
      "https://example.com/private(secret)",
      "https://example.com/private(secret",
      "http://example.com/private",
      "ftp://files.example.com/private",
      "file:///private/report",
      "enchiridion://page/private",
      "mailto:secret@example.com",
      "tel:+441234567890",
      "www.example.com/private",
      "calendar:private-event",
      "event:private-event",
      "page:private-page",
      "task:private-task",
    ]

    for token in privateTokens {
      let response = GroundedAssistantResponse(
        answer: "Version:v2 is ready. \(token) Keep this private.",
        status: .answered
      )
      let spoken = AssistantSpokenResponseFormatter.spokenText(for: response)
      XCTAssertEqual(spoken, "Version:v2 is ready. Keep this private.", token)
      XCTAssertFalse(spoken.contains("(secret)"), token)
    }

    let parenthesized = GroundedAssistantResponse(
      answer: "Version:v2 is ready. (https://example.com/private) Keep this private.",
      status: .answered
    )
    XCTAssertEqual(
      AssistantSpokenResponseFormatter.spokenText(for: parenthesized),
      "Version:v2 is ready. Keep this private."
    )
  }

  func testSpokenFormatterDoesNotTreatOrdinaryColonProseAsAURL() {
    let response = GroundedAssistantResponse(
      answer: "Note: bring lunch. The file is attached.",
      status: .answered
    )

    XCTAssertEqual(
      AssistantSpokenResponseFormatter.spokenText(for: response),
      "Note: bring lunch. The file is attached."
    )
  }

  func testSpokenFormatterKeepsSafetyCaveatExactlyOnce() {
    let caveat = "Your local notes contain conflicting information."
    let response = GroundedAssistantResponse(
      answer: "\(caveat) The newer note says eleven. \(caveat)",
      status: .conflicting
    )

    let spoken = AssistantSpokenResponseFormatter.spokenText(for: response)
    XCTAssertEqual(spoken, "\(caveat) The newer note says eleven.")
    XCTAssertEqual(spoken.components(separatedBy: caveat).count - 1, 1)
  }

  func testSpokenFormatterRendersMarkdownAsPlainSpeech() {
    let response = GroundedAssistantResponse(
      answer: """
        # Plan
        - Read [the project plan](https://example.com/private-plan).
        - Review **today's** `draft`.
        """,
      status: .answered
    )

    XCTAssertEqual(
      AssistantSpokenResponseFormatter.spokenText(for: response),
      "Plan: Read the project plan. Review today's draft."
    )
  }

  func testSpokenFormatterStopsAtCompleteSentencesAndOffersContinuation() {
    let response = GroundedAssistantResponse(
      answer: "First, review the plan. Second, compare the drafts. Third, share the decision.",
      status: .answered
    )

    XCTAssertEqual(
      AssistantSpokenResponseFormatter.spokenText(for: response),
      "First, review the plan. Second, compare the drafts. You can ask me to keep going."
    )
  }

  func testSpokenFormatterUsesReadableFallbackWhenNoSentenceFits() {
    let longSentence = Array(repeating: "detail", count: 56).joined(separator: " ") + "."
    let response = GroundedAssistantResponse(answer: longSentence, status: .answered)

    XCTAssertEqual(
      AssistantSpokenResponseFormatter.spokenText(for: response),
      "I have a longer answer ready. You can ask me to keep going."
    )
  }

  func testSpokenFormatterHandlesEmptyAndFormattingOnlyAnswers() {
    for answer in ["", "   ", "#\n***\n**"] {
      XCTAssertEqual(
        AssistantSpokenResponseFormatter.spokenText(
          for: GroundedAssistantResponse(answer: answer, status: .answered)
        ),
        "I don't have an answer to read aloud."
      )
    }
  }

  func testSpokenFormatterRecognizesUnicodeSentencePunctuation() {
    let response = GroundedAssistantResponse(
      answer: "第一句话！第二句话？第三句话。",
      status: .answered
    )

    XCTAssertEqual(
      AssistantSpokenResponseFormatter.spokenText(for: response),
      "第一句话！ 第二句话？ You can ask me to keep going."
    )
  }

  func testSpokenFormatterKeepsAbbreviationsInitialsAndDecimalsInTheirSentences() {
    let response = GroundedAssistantResponse(
      answer: "Meet Dr. A. Smith at 10.30, e.g. by the desk. Bring notes. Leave early.",
      status: .answered
    )

    XCTAssertEqual(
      AssistantSpokenResponseFormatter.spokenText(for: response),
      "Meet Dr. A. Smith at 10.30, e.g. by the desk. Bring notes. "
        + "You can ask me to keep going."
    )
  }

  func testSpokenFormatterAppliesLexicalUnitLimitToUnspacedCJKText() {
    let longSentence = Array(repeating: "细节", count: 56).joined(separator: "，") + "。"
    let response = GroundedAssistantResponse(answer: longSentence, status: .answered)

    XCTAssertEqual(
      AssistantSpokenResponseFormatter.spokenText(for: response),
      "I have a longer answer ready. You can ask me to keep going."
    )
  }
}

private enum AssistantConversationTestFailure: Error {
  case transcription
  case speaking
}

private final class ManualVoiceSafetyEventSource:
  AssistantVoiceSafetyEventSource, @unchecked Sendable
{
  private let stream: AsyncStream<AssistantVoiceSafetyEvent>
  private let continuation: AsyncStream<AssistantVoiceSafetyEvent>.Continuation

  init() {
    let pair = AsyncStream.makeStream(of: AssistantVoiceSafetyEvent.self)
    stream = pair.stream
    continuation = pair.continuation
  }

  func events() -> AsyncStream<AssistantVoiceSafetyEvent> {
    stream
  }

  func emit(_ event: AssistantVoiceSafetyEvent) {
    continuation.yield(event)
  }
}

private actor RecordingAudioSessionController: AssistantConversationAudioSessionControlling {
  private(set) var activationCount = 0
  private(set) var deactivationCount = 0
  private(set) var resetCount = 0

  func activate() {
    activationCount += 1
  }

  func deactivate() {
    deactivationCount += 1
  }

  func resetAfterMediaServicesReset() {
    resetCount += 1
  }

  func counts() -> (activations: Int, deactivations: Int) {
    (activationCount, deactivationCount)
  }
}

private actor SuspendedAudioSessionController: AssistantConversationAudioSessionControlling {
  private var activationContinuation: CheckedContinuation<Void, Never>?
  private(set) var activationCount = 0
  private(set) var deactivationCount = 0

  func activate() async throws {
    activationCount += 1
    await withCheckedContinuation { continuation in
      activationContinuation = continuation
    }
  }

  func deactivate() {
    deactivationCount += 1
  }

  func resumeActivation() {
    activationContinuation?.resume()
    activationContinuation = nil
  }

  func counts() -> (activations: Int, deactivations: Int) {
    (activationCount, deactivationCount)
  }
}

private struct FailingTranscriber: AssistantConversationTranscribing {
  func transcribe() async throws -> String {
    throw AssistantConversationTestFailure.transcription
  }
}

private struct FailingSpeaker: AssistantConversationSpeaking {
  func speak(_ text: String) async throws {
    throw AssistantConversationTestFailure.speaking
  }

  func stop() async {}
}

private actor UnavailableTranscriber: AssistantConversationTranscribing {
  private(set) var captureCount = 0

  func availability() -> AssistantVoiceAvailability {
    .unavailable("Voice is unavailable for this test.")
  }

  func transcribe() -> String {
    captureCount += 1
    return "should not capture"
  }
}

private actor DeniedTranscriber: AssistantConversationTranscribing {
  private(set) var captureCount = 0

  func availability() -> AssistantVoiceAvailability { .permissionRequired }
  func requestPermission() -> AssistantVoiceAvailability { .permissionDenied }

  func transcribe() async throws -> String {
    captureCount += 1
    return "should not capture"
  }
}

private actor SuspendedAvailabilityTranscriber: AssistantConversationTranscribing {
  private var availabilityContinuations: [CheckedContinuation<AssistantVoiceAvailability, Never>] =
    []
  private var captureContinuation: CheckedContinuation<String, any Error>?
  private(set) var availabilityCheckCount = 0
  private(set) var captureCount = 0

  func availability() async -> AssistantVoiceAvailability {
    availabilityCheckCount += 1
    return await withCheckedContinuation { continuation in
      availabilityContinuations.append(continuation)
    }
  }

  func transcribe() async throws -> String {
    captureCount += 1
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        captureContinuation = continuation
      }
    } onCancel: {
      Task { await self.cancelCapture() }
    }
  }

  func stop() {
    cancelCapture()
  }

  func resumeAvailabilityChecks() {
    let continuations = availabilityContinuations
    availabilityContinuations.removeAll()
    for continuation in continuations {
      continuation.resume(returning: .available)
    }
  }

  private func cancelCapture() {
    captureContinuation?.resume(throwing: CancellationError())
    captureContinuation = nil
  }
}

private actor SuspendedPermissionTranscriber: AssistantConversationTranscribing {
  private var permissionContinuation: CheckedContinuation<AssistantVoiceAvailability, Never>?
  private(set) var permissionRequestCount = 0
  private(set) var captureCount = 0

  func availability() -> AssistantVoiceAvailability { .permissionRequired }

  func requestPermission() async -> AssistantVoiceAvailability {
    permissionRequestCount += 1
    return await withCheckedContinuation { continuation in
      permissionContinuation = continuation
    }
  }

  func transcribe() -> String {
    captureCount += 1
    return "should not capture"
  }

  func resumePermissionRequest() {
    permissionContinuation?.resume(returning: .available)
    permissionContinuation = nil
  }
}

private actor ResetRecordingAnswerer: AssistantConversationAnswering {
  private(set) var resetCount = 0
  private(set) var requests: [AssistantConversationRequest] = []

  func respond(to request: AssistantConversationRequest) -> GroundedAssistantResponse {
    requests.append(request)
    return GroundedAssistantResponse(answer: "Remembered for now", status: .answered)
  }

  func resetConversation() {
    resetCount += 1
  }
}

private actor ControlledTranscriber: AssistantConversationTranscribing {
  private struct Pending {
    var id: UUID
    var continuation: CheckedContinuation<String, any Error>
  }

  private var pending: [Pending] = []
  private(set) var callCount = 0
  private(set) var cancellationCount = 0
  private(set) var resetCount = 0

  func transcribe() async throws -> String {
    let id = UUID()
    callCount += 1
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pending.append(Pending(id: id, continuation: continuation))
      }
    } onCancel: {
      Task { await self.cancel(id: id) }
    }
  }

  func succeedNext(with utterance: String) {
    guard !pending.isEmpty else { return }
    pending.removeFirst().continuation.resume(returning: utterance)
  }

  func resetAfterMediaServicesReset() {
    resetCount += 1
  }

  private func cancel(id: UUID) {
    guard let index = pending.firstIndex(where: { $0.id == id }) else { return }
    cancellationCount += 1
    pending.remove(at: index).continuation.resume(throwing: CancellationError())
  }
}

private actor ProgressiveTranscriber: AssistantConversationTranscribing {
  private struct Capture {
    var progress: AssistantTranscriptionProgressHandler
    var continuation: CheckedContinuation<AssistantTranscriptionOutcome, any Error>?
  }

  private var captures: [Capture] = []
  private(set) var callCount = 0

  func transcribe() async throws -> String {
    switch try await transcribe(reportingProgress: { _ in }) {
    case .utterance(let utterance): utterance
    case .noSpeech: ""
    }
  }

  func transcribe(
    reportingProgress: @escaping AssistantTranscriptionProgressHandler
  ) async throws -> AssistantTranscriptionOutcome {
    let index = captures.count
    callCount += 1
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        captures.append(Capture(progress: reportingProgress, continuation: continuation))
      }
    } onCancel: {
      Task { await self.cancel(call: index) }
    }
  }

  func emit(_ transcript: String, forCall index: Int) async {
    guard captures.indices.contains(index) else { return }
    await captures[index].progress(transcript)
  }

  func finish(_ outcome: AssistantTranscriptionOutcome, forCall index: Int) {
    guard captures.indices.contains(index), let continuation = captures[index].continuation else {
      return
    }
    captures[index].continuation = nil
    continuation.resume(returning: outcome)
  }

  func stop() {
    for index in captures.indices {
      cancel(call: index)
    }
  }

  private func cancel(call index: Int) {
    guard captures.indices.contains(index), let continuation = captures[index].continuation else {
      return
    }
    captures[index].continuation = nil
    continuation.resume(throwing: CancellationError())
  }
}

private actor ScriptedTranscriber: AssistantConversationTranscribing {
  private var utterances: [String]
  private var pending: CheckedContinuation<String, any Error>?
  private(set) var callCount = 0

  init(utterances: [String]) {
    self.utterances = utterances
  }

  func transcribe() async throws -> String {
    callCount += 1
    if !utterances.isEmpty { return utterances.removeFirst() }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pending = continuation
      }
    } onCancel: {
      Task { await self.cancelPending() }
    }
  }

  private func cancelPending() {
    pending?.resume(throwing: CancellationError())
    pending = nil
  }
}

private actor ControlledAnswerer: AssistantConversationAnswering {
  private struct Pending {
    var continuation: CheckedContinuation<GroundedAssistantResponse, Never>
  }

  private var pending: [Pending] = []
  private(set) var requests: [AssistantConversationRequest] = []

  func respond(to request: AssistantConversationRequest) async -> GroundedAssistantResponse {
    requests.append(request)
    return await withCheckedContinuation { continuation in
      pending.append(Pending(continuation: continuation))
    }
  }

  func succeedNext(with response: GroundedAssistantResponse) {
    guard !pending.isEmpty else { return }
    pending.removeFirst().continuation.resume(returning: response)
  }
}

private actor RecordingAnswerer: AssistantConversationAnswering {
  private(set) var requests: [AssistantConversationRequest] = []

  func respond(to request: AssistantConversationRequest) -> GroundedAssistantResponse {
    requests.append(request)
    return GroundedAssistantResponse(
      answer: "answer \(requests.count)",
      status: .answered
    )
  }
}

private struct FixedAnswerer: AssistantConversationAnswering {
  var response: GroundedAssistantResponse

  func respond(to request: AssistantConversationRequest) async -> GroundedAssistantResponse {
    response
  }
}

private actor ControlledSpeaker: AssistantConversationSpeaking {
  private var pending: [CheckedContinuation<Void, any Error>] = []
  private(set) var spoken: [String] = []
  private(set) var stopCount = 0
  private(set) var resetCount = 0

  func speak(_ text: String) async throws {
    spoken.append(text)
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pending.append(continuation)
      }
    } onCancel: {
      Task { await self.cancelPending() }
    }
  }

  func stop() {
    stopCount += 1
    cancelPending()
  }

  func resetAfterMediaServicesReset() {
    resetCount += 1
  }

  func finishNext() {
    guard !pending.isEmpty else { return }
    pending.removeFirst().resume()
  }

  private func cancelPending() {
    let continuations = pending
    pending.removeAll()
    for continuation in continuations {
      continuation.resume(throwing: CancellationError())
    }
  }
}

private actor RecordingSpeaker: AssistantConversationSpeaking {
  private(set) var spoken: [String] = []
  private(set) var stopCount = 0

  func speak(_ text: String) {
    spoken.append(text)
  }

  func stop() {
    stopCount += 1
  }
}

@MainActor
private func waitUntil(
  timeout: Duration = .seconds(2),
  _ condition: @MainActor () async -> Bool
) async throws {
  let clock = ContinuousClock()
  let deadline = clock.now.advanced(by: timeout)
  while !(await condition()) {
    if clock.now >= deadline {
      XCTFail("Timed out waiting for asynchronous state")
      return
    }
    try await Task.sleep(for: .milliseconds(5))
  }
}
