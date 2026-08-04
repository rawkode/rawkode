import XCTest

@testable import EnchiridionCore

@MainActor
final class RealtimeVoiceReducerTests: XCTestCase {
  func testConfigurationIsExactBoundedNoToolContract() throws {
    let configuration = try RealtimeVoiceConfiguration(route: route())

    XCTAssertEqual(configuration.modelID, "gpt-realtime-mini")
    XCTAssertEqual(configuration.voiceID, "marin")
    XCTAssertEqual(configuration.outputModalities, ["audio"])
    XCTAssertEqual(configuration.inputAudioTranscriptionModelID, "gpt-4o-mini-transcribe")
    XCTAssertEqual(configuration.turnDetection.type, "semantic_vad")
    XCTAssertEqual(configuration.turnDetection.eagerness, "auto")
    XCTAssertTrue(configuration.turnDetection.createResponse)
    XCTAssertTrue(configuration.turnDetection.interruptResponse)
    XCTAssertEqual(configuration.maxOutputTokens, 1_024)
    XCTAssertNil(configuration.tracing)
    XCTAssertEqual(configuration.tools, [])
    XCTAssertEqual(configuration.toolChoice, "none")
    XCTAssertTrue(configuration.instructions.contains("cannot access notes"))
  }

  func testSessionCreatedFailsClosedOnActualModelOrVoiceMismatch() throws {
    let configuration = try RealtimeVoiceConfiguration(route: route())
    var reducer = RealtimeVoiceReducer(configuration: configuration)

    let effects = reducer.reduce(
      RealtimeServerEvent(
        eventID: "event-1",
        payload: .sessionCreated(
          RealtimeSessionCreated(
            sessionID: "session-1",
            modelID: "gpt-realtime",
            voiceID: "marin"
          )
        )
      )
    )

    XCTAssertEqual(reducer.state.phase, .failed)
    XCTAssertEqual(reducer.state.failure?.code, "route_mismatch")
    XCTAssertEqual(effects.count, 1)
    guard case .terminate = effects.first else {
      return XCTFail("A route mismatch must terminate the session")
    }
  }

  func testBargeInCancelsResponseClearsOutputAndProducesImmutableUsageReceipt() throws {
    let configuration = try RealtimeVoiceConfiguration(route: route())
    var reducer = RealtimeVoiceReducer(configuration: configuration)
    reducer.setLocalPhase(.connecting)
    _ = reducer.reduce(
      event(
        "session",
        .sessionCreated(
          RealtimeSessionCreated(
            sessionID: "session-1",
            modelID: configuration.modelID,
            voiceID: configuration.voiceID,
            requestID: "request-1"
          )
        )
      )
    )
    _ = reducer.reduce(
      event(
        "input-final",
        .inputAudioTranscriptionCompleted(
          RealtimeTranscriptCompleted(
            itemID: "input-1",
            transcript: "Hello",
            usage: RealtimeTranscriptionUsage(
              inputTokens: 3,
              audioTokens: 2,
              textTokens: 1,
              totalTokens: 3
            )
          )
        )
      )
    )
    _ = reducer.reduce(
      event("response", .responseCreated(RealtimeResponseCreated(responseID: "response-1")))
    )
    _ = reducer.reduce(
      event(
        "output-delta",
        .outputAudioTranscriptDelta(
          RealtimeOutputTranscriptDelta(
            responseID: "response-1",
            itemID: "output-1",
            contentIndex: 0,
            delta: "Hi there"
          )
        )
      )
    )

    let effects = reducer.reduce(
      event(
        "speech-start",
        .inputAudioSpeechStarted(RealtimeSpeechBoundary(itemID: "input-2"))
      )
    )
    XCTAssertEqual(
      effects,
      [
        .send(.responseCancel(responseID: "response-1")),
        .send(.outputAudioBufferClear),
      ]
    )
    XCTAssertEqual(reducer.state.captions.last?.status, .interrupted)

    let usage = RealtimeTokenUsage(
      inputTokens: 7,
      outputTokens: 5,
      totalTokens: 12,
      inputDetails: RealtimeTokenUsageDetails(
        textTokens: 2,
        audioTokens: 4,
        cachedTokens: 1
      ),
      outputDetails: RealtimeTokenUsageDetails(textTokens: 2, audioTokens: 3)
    )
    let done = event(
      "response-done",
      .responseDone(
        RealtimeResponseDone(
          responseID: "response-1",
          status: .cancelled,
          statusDetails: RealtimeResponseStatusDetails(reason: "turn_detected"),
          usage: usage
        )
      )
    )
    _ = reducer.reduce(done)
    _ = reducer.reduce(done)

    XCTAssertEqual(reducer.state.turnReceipts.count, 1)
    let receipt = try XCTUnwrap(reducer.state.turnReceipts.first)
    XCTAssertEqual(receipt.completion, .bargeIn)
    XCTAssertEqual(receipt.inputItemID, "input-1")
    XCTAssertEqual(receipt.inputTranscript, "Hello")
    XCTAssertEqual(receipt.outputTranscript, "Hi there")
    XCTAssertEqual(receipt.usage, usage)
    XCTAssertEqual(receipt.transcriptionUsage?.audioTokens, 2)
    XCTAssertEqual(reducer.state.requestIDs, ["request-1"])
  }

  func testOutOfOrderTranscriptEventsUpsertCaptionsWithoutDuplicateReceipts() throws {
    let configuration = try RealtimeVoiceConfiguration(route: route())
    var reducer = RealtimeVoiceReducer(configuration: configuration)

    _ = reducer.reduce(
      event(
        "output-first",
        .outputAudioTranscriptDelta(
          RealtimeOutputTranscriptDelta(
            responseID: "response-1",
            itemID: "output-1",
            contentIndex: 0,
            delta: "Hel"
          )
        )
      )
    )
    _ = reducer.reduce(
      event("created-late", .responseCreated(RealtimeResponseCreated(responseID: "response-1")))
    )
    _ = reducer.reduce(
      event(
        "output-done",
        .outputAudioTranscriptDone(
          RealtimeOutputTranscriptDone(
            responseID: "response-1",
            itemID: "output-1",
            contentIndex: 0,
            transcript: "Hello"
          )
        )
      )
    )
    _ = reducer.reduce(
      event(
        "done",
        .responseDone(RealtimeResponseDone(responseID: "response-1", status: .completed))
      )
    )
    _ = reducer.reduce(
      event(
        "done-again-with-new-event-id",
        .responseDone(RealtimeResponseDone(responseID: "response-1", status: .completed))
      )
    )

    XCTAssertEqual(reducer.state.captions.count, 1)
    XCTAssertEqual(reducer.state.captions.first?.text, "Hello")
    XCTAssertEqual(reducer.state.captions.first?.status, .completed)
    XCTAssertEqual(reducer.state.turnReceipts.count, 1)
  }

  func testLateCompletionForBargedInResponseDoesNotOverwriteNewActiveResponsePhase() throws {
    let configuration = try RealtimeVoiceConfiguration(route: route())
    var reducer = RealtimeVoiceReducer(configuration: configuration)
    _ = reducer.reduce(
      event("old-created", .responseCreated(RealtimeResponseCreated(responseID: "old")))
    )
    _ = reducer.reduce(
      event("barge-in", .inputAudioSpeechStarted(RealtimeSpeechBoundary(itemID: "input-new")))
    )
    _ = reducer.reduce(
      event("new-created", .responseCreated(RealtimeResponseCreated(responseID: "new")))
    )
    _ = reducer.reduce(
      event(
        "new-delta",
        .outputAudioTranscriptDelta(
          RealtimeOutputTranscriptDelta(
            responseID: "new",
            itemID: "output-new",
            contentIndex: 0,
            delta: "New response"
          )
        )
      )
    )

    _ = reducer.reduce(
      event(
        "late-old-delta",
        .outputAudioTranscriptDelta(
          RealtimeOutputTranscriptDelta(
            responseID: "old",
            itemID: "output-old",
            contentIndex: 0,
            delta: "Late old response"
          )
        )
      )
    )
    _ = reducer.reduce(
      event(
        "old-done",
        .responseDone(RealtimeResponseDone(responseID: "old", status: .cancelled))
      )
    )

    XCTAssertEqual(reducer.state.activeResponseID, "new")
    XCTAssertEqual(reducer.state.phase, .assistantSpeaking)
    XCTAssertEqual(
      reducer.state.turnReceipts.first(where: { $0.responseID == "old" })?.completion,
      .bargeIn
    )
    XCTAssertEqual(
      reducer.state.captions.first(where: { $0.id == "assistant:old" })?.status,
      .interrupted
    )

    let effects = reducer.reduce(
      event(
        "next-speech",
        .inputAudioSpeechStarted(RealtimeSpeechBoundary(itemID: "input-next"))
      )
    )
    XCTAssertEqual(
      effects,
      [
        .send(.responseCancel(responseID: "new")),
        .send(.outputAudioBufferClear),
      ]
    )

    _ = reducer.reduce(
      event(
        "new-done",
        .responseDone(RealtimeResponseDone(responseID: "new", status: .cancelled))
      )
    )
    XCTAssertNil(reducer.state.activeResponseID)
    XCTAssertEqual(reducer.state.phase, .listening)
  }

  func testCorrelatedErrorFinalizesFailedResponseAndTerminates() throws {
    let configuration = try RealtimeVoiceConfiguration(route: route())
    var reducer = RealtimeVoiceReducer(configuration: configuration)
    _ = reducer.reduce(
      event("created", .responseCreated(RealtimeResponseCreated(responseID: "response-1")))
    )

    let effects = reducer.reduce(
      event(
        "error",
        .error(
          RealtimeCorrelatedError(
            eventID: "request-2",
            responseID: "response-1",
            code: "rate_limit_exceeded",
            message: "Slow down"
          )
        )
      )
    )

    XCTAssertEqual(reducer.state.phase, .failed)
    XCTAssertEqual(reducer.state.turnReceipts.first?.completion, .failed)
    XCTAssertEqual(reducer.state.requestIDs, ["request-2"])
    XCTAssertEqual(
      effects,
      [.terminate(RealtimeVoiceFailure(
        code: "rate_limit_exceeded",
        message: "Slow down",
        responseID: "response-1"
      ))]
    )
  }

  private func route() -> RealtimeVoiceRouteSnapshot {
    try! makeAuthorizedRealtimeVoiceRoute(
      binding: OpenAICredentialBinding(revision: "revision-1", fingerprint: "fp-1")
    )
  }

  private func event(
    _ id: String,
    _ payload: RealtimeServerEventPayload
  ) -> RealtimeServerEvent {
    RealtimeServerEvent(eventID: id, payload: payload)
  }
}
