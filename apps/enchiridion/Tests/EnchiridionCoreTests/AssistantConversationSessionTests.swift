import Foundation
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
    XCTAssertTrue(session.turns.isEmpty)
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
      interTurnDelay: .zero
    )

    session.start()
    try await waitUntil { await transcriber.callCount == 6 }

    let requests = await answerer.requests
    XCTAssertEqual(requests.count, 5)
    XCTAssertEqual(requests[4].priorTurns.map(\.utterance), [
      "question 1", "question 2", "question 3", "question 4",
    ])
    XCTAssertEqual(session.turns.map(\.utterance), [
      "question 2", "question 3", "question 4", "question 5",
    ])
    let spokenValues = await speaker.spoken
    XCTAssertEqual(spokenValues.count, 5)

    await session.stop()
    XCTAssertTrue(session.turns.isEmpty)
  }

  @MainActor
  func testStopCancelsActiveListeningAndClearsContext() async throws {
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
          message: "I couldn't verify that against your local sources."
        )
      )
    )
    let spokenValues = await speaker.spoken
    XCTAssertTrue(spokenValues.isEmpty)
    XCTAssertTrue(session.turns.isEmpty)
  }

  func testSpokenFormatterKeepsSafetyCaveatAndDeduplicatesSources() {
    let source = AssistantSource(id: "event:one", kind: .calendarEvent, title: "Design review")
    let response = GroundedAssistantResponse(
      answer: "It starts at ten.",
      status: .stale,
      sources: [source, source]
    )

    XCTAssertEqual(
      AssistantSpokenResponseFormatter.spokenText(for: response),
      "Your local calendar information may be out of date. It starts at ten. Sources: Design review."
    )
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

  private func cancel(id: UUID) {
    guard let index = pending.firstIndex(where: { $0.id == id }) else { return }
    cancellationCount += 1
    pending.remove(at: index).continuation.resume(throwing: CancellationError())
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
