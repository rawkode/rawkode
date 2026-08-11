// OpenAIResponsesAssistantTests.swift
// EnchiridionCoreTests
//
// Task #68. Mocks the OpenAI HTTP layer ONLY (a fake `OpenAIResponsesTransporting`
// returning pre-built SSE-decoded events) and a fake `AssistantModelToolExecuting`
// standing in for the real Store/Sync/API-backed dispatcher (that dispatcher
// itself, and its own security-critical construction, is tested in
// `EnchiridionUITests/AssistantLocalToolDispatcherTests.swift`, where the
// real `LocalGraphStore` lives). Per the task brief: do not re-test
// `AssistantGroundingPolicy`/`AssistantTurnRetrievalAuthorization` here —
// those already have their own tests from #65/#66 — this file tests that
// `OpenAIResponsesAssistant`'s turn loop calls them correctly.

import Foundation
import XCTest

@testable import EnchiridionCore

// MARK: - Test doubles

private final class FakeTransport: OpenAIResponsesTransporting, @unchecked Sendable {
  private let lock = NSLock()
  private var results: [OpenAIResponsesTransportResult]
  private(set) var sentBodies: [Data] = []

  init(results: [OpenAIResponsesTransportResult]) {
    self.results = results
  }

  func send(body: Data, credential: String) async throws -> OpenAIResponsesTransportResult {
    let ranOut = lock.withLock { () -> Bool in
      sentBodies.append(body)
      return results.isEmpty
    }
    if ranOut {
      XCTFail("FakeTransport received more requests than it was given canned results for")
      return OpenAIResponsesTransportResult(statusCode: 500, requestID: nil, retryAfterSeconds: nil, events: [], errorCode: nil)
    }
    return lock.withLock { results.removeFirst() }
  }
}

private struct FakeToolExecutor: AssistantModelToolExecuting {
  let handler: @Sendable (AssistantModelToolCall) throws -> AssistantModelToolExecutionResult

  func execute(
    _ call: AssistantModelToolCall,
    now: Date,
    eligibleCalendarSourceIDs: Set<String>,
    eligibleTaskPageIDs: Set<String>,
    eligibleEmailThreadIDs: Set<String>,
    calendarContextEstablishedThisTurn: Bool,
    retrievalAuthorization: AssistantTurnRetrievalAuthorization,
    writeAuthorization: AssistantTurnWriteAuthorization
  ) async throws -> AssistantModelToolExecutionResult {
    try handler(call)
  }
}

// MARK: - Event-building helpers (JSONSerialization, never manual string escaping)

private func completedEvent(model: String, output: [[String: Any]], status: String = "completed") throws -> Data {
  let response: [String: Any] = ["id": "resp_1", "model": model, "status": status, "output": output]
  let envelope: [String: Any] = ["type": "response.\(status)", "response": response]
  return try JSONSerialization.data(withJSONObject: envelope)
}

private func functionCallItem(name: String, callID: String, arguments: [String: Any]) throws -> [String: Any] {
  let argumentsData = try JSONSerialization.data(withJSONObject: arguments)
  return [
    "type": "function_call", "name": name, "call_id": callID,
    "arguments": String(decoding: argumentsData, as: UTF8.self),
  ]
}

private func answerMessageItem(answer: String, factIDs: [String]) throws -> [String: Any] {
  let payloadData = try JSONSerialization.data(withJSONObject: ["answer": answer, "factIDs": factIDs])
  return [
    "type": "message",
    "content": [["type": "output_text", "text": String(decoding: payloadData, as: UTF8.self)]],
  ]
}

private func refusalMessageItem(_ refusal: String) -> [String: Any] {
  ["type": "message", "content": [["type": "refusal", "refusal": refusal]]]
}

private func successResult(_ data: Data) -> OpenAIResponsesTransportResult {
  OpenAIResponsesTransportResult(statusCode: 200, requestID: "req_1", retryAfterSeconds: nil, events: [data], errorCode: nil)
}

// MARK: - Tests

final class OpenAIResponsesAssistantTests: XCTestCase {
  private let modelID = "gpt-test-model"

  private func makeAssistant(
    transport: FakeTransport, executor: any AssistantModelToolExecuting = FakeToolExecutor { _ in
      .retrieval(AssistantRetrievalToolOutput(jsonOutput: "{}", sources: [], facts: []))
    }
  ) -> OpenAIResponsesAssistant {
    OpenAIResponsesAssistant(
      modelID: modelID, executor: executor, credential: { "sk-test" }, transport: transport)
  }

  // MARK: Full round trip — the required "tool call -> real grounding" test

  func testReadToolRoundTripAnswerIsExactlyTheToolsTrustedFactTextNeverModelProse() async throws {
    let source = AssistantSource(id: "page:1", kind: .page, title: "Grocery list")
    let fact = AssistantEvidenceFact(
      id: "page:1#title", sourceID: "page:1", kind: .pageTitle,
      spokenText: "A local page is titled Grocery list.")

    let callEvent = try completedEvent(
      model: modelID,
      output: [try functionCallItem(name: "searchPages", callID: "call_1", arguments: ["query": "grocery", "limit": 5])]
    )
    // The model's own generated prose ("Sure! Here's what I found...") must
    // NEVER become the answer once a tool ran — only `fact.spokenText` may.
    let finalEvent = try completedEvent(
      model: modelID,
      output: [try answerMessageItem(answer: "Sure! Here's what I found, in my own words...", factIDs: [fact.id])]
    )
    let transport = FakeTransport(results: [successResult(callEvent), successResult(finalEvent)])
    let executor = FakeToolExecutor { call in
      XCTAssertEqual(call.name, "searchPages")
      return .retrieval(
        AssistantRetrievalToolOutput(jsonOutput: "{\"ok\":true}", sources: [source], facts: [fact]))
    }
    let query = try AssistantApprovedQuery(originalQuery: "grocery")
    let authorization = AssistantTurnRetrievalAuthorization(
      pageSearch: try AssistantPageSearchAuthorization(query: query, maximumResults: 5))

    let outcome = await makeAssistant(transport: transport, executor: executor).respond(
      to: AssistantConversationRequest(utterance: "find my grocery list", retrievalAuthorization: authorization))

    guard case .grounded(let response) = outcome else { return XCTFail("expected a grounded response") }
    XCTAssertEqual(response.answer, fact.spokenText)
    XCTAssertNotEqual(response.answer, "Sure! Here's what I found, in my own words...")
    XCTAssertEqual(response.status, .answered)
    XCTAssertEqual(response.sources, [source])
    XCTAssertEqual(transport.sentBodies.count, 2)
  }

  // MARK: Write tool -> pending confirmation, never a second model round trip

  func testWriteToolCallEndsTheTurnImmediatelyWithPendingConfirmation() async throws {
    let callEvent = try completedEvent(
      model: modelID,
      output: [
        try functionCallItem(
          name: "proposeTaskCreate", callID: "call_write_1",
          arguments: ["title": "Buy milk", "notes": NSNull(), "priority": NSNull(), "placement": NSNull(), "estimatedMinutes": NSNull()])
      ])
    let transport = FakeTransport(results: [successResult(callEvent)])
    let executor = FakeToolExecutor { call in
      .writeProposed(
        call.callID,
        AssistantWriteToolOutput(jsonOutput: "{\"proposed\":true}", summary: "Create task \u{201C}Buy milk\u{201D}"))
    }
    let writeAuthorization = AssistantTurnWriteAuthorization(allowTaskCreate: true)

    let outcome = await makeAssistant(transport: transport, executor: executor).respond(
      to: AssistantConversationRequest(utterance: "add buy milk to my tasks", writeAuthorization: writeAuthorization))

    guard case .pendingWriteConfirmation(let summary) = outcome else {
      return XCTFail("expected a pending write confirmation")
    }
    XCTAssertEqual(summary.callID, AssistantToolCallID(rawValue: "call_write_1"))
    XCTAssertEqual(summary.summary, "Create task \u{201C}Buy milk\u{201D}")
    // The turn ended after ONE model round trip — the loop must never ask
    // the model for further text about its own write proposal (see
    // OpenAIResponsesAssistant.swift's header for why).
    XCTAssertEqual(transport.sentBodies.count, 1)
  }

  // MARK: Tool-call cap

  func testExceedingTheToolCallCapFailsSafely() async throws {
    let query = try AssistantApprovedQuery(originalQuery: "x")
    let authorization = AssistantTurnRetrievalAuthorization(
      pageSearch: try AssistantPageSearchAuthorization(query: query, maximumResults: 5))
    let callEvent = try completedEvent(
      model: modelID,
      output: [try functionCallItem(name: "searchPages", callID: "call_loop", arguments: ["query": "x", "limit": 5])])
    // 5 identical tool-call responses: the 5th push exceeds the cap of 4.
    let transport = FakeTransport(results: Array(repeating: successResult(callEvent), count: 5))
    let executor = FakeToolExecutor { _ in
      .retrieval(AssistantRetrievalToolOutput(jsonOutput: "{}", sources: [], facts: []))
    }

    let outcome = await makeAssistant(transport: transport, executor: executor).respond(
      to: AssistantConversationRequest(utterance: "keep searching", retrievalAuthorization: authorization))

    guard case .grounded(let response) = outcome else { return XCTFail("expected a grounded failure response") }
    XCTAssertEqual(response.status, .unavailable)
    XCTAssertEqual(transport.sentBodies.count, 5)
  }

  // MARK: HTTP error classification

  func testUnauthorizedHTTPStatusProducesAnUnavailableResponse() async throws {
    let transport = FakeTransport(
      results: [
        OpenAIResponsesTransportResult(statusCode: 401, requestID: nil, retryAfterSeconds: nil, events: [], errorCode: nil)
      ])
    let outcome = await makeAssistant(transport: transport).respond(to: AssistantConversationRequest(utterance: "hi"))
    guard case .grounded(let response) = outcome else { return XCTFail("expected a grounded failure response") }
    XCTAssertEqual(response.status, .unavailable)
    XCTAssertTrue(response.answer.contains("API key"))
  }

  func testCredentialFailureNeverReachesTheNetwork() async throws {
    let transport = FakeTransport(results: [])
    let assistant = OpenAIResponsesAssistant(
      modelID: modelID,
      executor: FakeToolExecutor { _ in .retrieval(AssistantRetrievalToolOutput(jsonOutput: "{}", sources: [], facts: [])) },
      credential: { throw AssistantOpenAICredentialStoreError.unavailable },
      transport: transport
    )
    let outcome = await assistant.respond(to: AssistantConversationRequest(utterance: "hi"))
    guard case .grounded(let response) = outcome else { return XCTFail("expected a grounded failure response") }
    XCTAssertEqual(response.status, .unavailable)
    XCTAssertEqual(transport.sentBodies.count, 0)
  }

  // MARK: Tool-free conversational replies

  func testRefusalWithNoToolCallPassesThroughVerbatim() async throws {
    let event = try completedEvent(model: modelID, output: [refusalMessageItem("I can't help with that.")])
    let transport = FakeTransport(results: [successResult(event)])
    let outcome = await makeAssistant(transport: transport).respond(to: AssistantConversationRequest(utterance: "do something unsafe"))
    guard case .grounded(let response) = outcome else { return XCTFail("expected a grounded response") }
    XCTAssertEqual(response.answer, "I can't help with that.")
    XCTAssertEqual(response.status, .answered)
  }

  func testToolFreeConversationalAnswerPassesThroughWhenFactIDsAreEmpty() async throws {
    let event = try completedEvent(model: modelID, output: [try answerMessageItem(answer: "Hello! How can I help?", factIDs: [])])
    let transport = FakeTransport(results: [successResult(event)])
    let outcome = await makeAssistant(transport: transport).respond(to: AssistantConversationRequest(utterance: "hello"))
    guard case .grounded(let response) = outcome else { return XCTFail("expected a grounded response") }
    XCTAssertEqual(response.answer, "Hello! How can I help?")
    // No tool ran this turn, so nothing retrieved backs this answer — it
    // must be tagged `.ungrounded`, not `.answered`. See Fix 1 (#72).
    XCTAssertEqual(response.status, .ungrounded)
  }

  /// Fix 1 (#72), part (a): a genuinely tool-free model reply (no tool call
  /// made at all this turn) must be tagged `.ungrounded` — the visual
  /// "unverified" signal the person needs since nothing retrieved backs it.
  func testToolFreeModelReplyIsTaggedUngroundedNotAnswered() async throws {
    let event = try completedEvent(
      model: modelID, output: [try answerMessageItem(answer: "Sure, let's brainstorm some ideas.", factIDs: [])])
    let transport = FakeTransport(results: [successResult(event)])

    let outcome = await makeAssistant(transport: transport).respond(
      to: AssistantConversationRequest(utterance: "let's brainstorm"))

    guard case .grounded(let response) = outcome else { return XCTFail("expected a grounded response") }
    XCTAssertEqual(response.answer, "Sure, let's brainstorm some ideas.")
    XCTAssertEqual(response.status, .ungrounded)
  }

  /// Fix 1 (#72), part (b) — regression guard: a tool-backed answer that
  /// validates through `AssistantGroundingPolicy` must still be tagged
  /// `.answered`, exactly as before this fix. This must never flip.
  func testToolBackedGroundingPolicyValidatedAnswerIsStillTaggedAnswered() async throws {
    let source = AssistantSource(id: "page:1", kind: .page, title: "Grocery list")
    let fact = AssistantEvidenceFact(
      id: "page:1#title", sourceID: "page:1", kind: .pageTitle,
      spokenText: "A local page is titled Grocery list.")
    let callEvent = try completedEvent(
      model: modelID,
      output: [try functionCallItem(name: "searchPages", callID: "call_1", arguments: ["query": "grocery", "limit": 5])])
    let finalEvent = try completedEvent(
      model: modelID, output: [try answerMessageItem(answer: "ignored model prose", factIDs: [fact.id])])
    let transport = FakeTransport(results: [successResult(callEvent), successResult(finalEvent)])
    let executor = FakeToolExecutor { _ in
      .retrieval(AssistantRetrievalToolOutput(jsonOutput: "{\"ok\":true}", sources: [source], facts: [fact]))
    }
    let query = try AssistantApprovedQuery(originalQuery: "grocery")
    let authorization = AssistantTurnRetrievalAuthorization(
      pageSearch: try AssistantPageSearchAuthorization(query: query, maximumResults: 5))

    let outcome = await makeAssistant(transport: transport, executor: executor).respond(
      to: AssistantConversationRequest(utterance: "find my grocery list", retrievalAuthorization: authorization))

    guard case .grounded(let response) = outcome else { return XCTFail("expected a grounded response") }
    XCTAssertEqual(response.answer, fact.spokenText)
    XCTAssertEqual(response.status, .answered)
  }

  // MARK: Model identity check

  func testAModelIDMismatchInTheTerminalResponseIsRejected() async throws {
    let event = try completedEvent(model: "a-different-model", output: [try answerMessageItem(answer: "hi", factIDs: [])])
    let transport = FakeTransport(results: [successResult(event)])
    let outcome = await makeAssistant(transport: transport).respond(to: AssistantConversationRequest(utterance: "hello"))
    guard case .grounded(let response) = outcome else { return XCTFail("expected a grounded failure response") }
    XCTAssertEqual(response.status, .unavailable)
  }

  // MARK: A hallucinated fact ID degrades safely, never surfaces a raw grounding error

  func testAHallucinatedFactIDDegradesToNoResultsRatherThanSurfacingTheGroundingError() async throws {
    let query = try AssistantApprovedQuery(originalQuery: "grocery")
    let authorization = AssistantTurnRetrievalAuthorization(
      pageSearch: try AssistantPageSearchAuthorization(query: query, maximumResults: 5))
    let callEvent = try completedEvent(
      model: modelID,
      output: [try functionCallItem(name: "searchPages", callID: "call_1", arguments: ["query": "grocery", "limit": 5])])
    let finalEvent = try completedEvent(
      model: modelID, output: [try answerMessageItem(answer: "", factIDs: ["fact-that-was-never-returned"])])
    let transport = FakeTransport(results: [successResult(callEvent), successResult(finalEvent)])
    let executor = FakeToolExecutor { _ in
      .retrieval(
        AssistantRetrievalToolOutput(
          jsonOutput: "{}",
          sources: [AssistantSource(id: "page:1", kind: .page, title: "Grocery list")],
          facts: [
            AssistantEvidenceFact(id: "page:1#title", sourceID: "page:1", kind: .pageTitle, spokenText: "real fact")
          ]))
    }

    let outcome = await makeAssistant(transport: transport, executor: executor).respond(
      to: AssistantConversationRequest(utterance: "find grocery", retrievalAuthorization: authorization))

    guard case .grounded(let response) = outcome else { return XCTFail("expected a grounded response") }
    XCTAssertEqual(response.status, .noResults)
    XCTAssertNotEqual(response.answer, "")
  }

  // MARK: Request builder — only authorized tools are advertised

  func testRequestOnlyAdvertisesAuthorizedToolsAndOmitsToolsEntirelyWhenNoneAreAuthorized() throws {
    let noToolsBody = try OpenAIResponsesRequestBuilder.makeBody(
      utterance: "hi", priorTurns: [], modelID: modelID, continuationItems: [],
      retrievalAuthorization: .none, writeAuthorization: .none)
    let noToolsJSON = try XCTUnwrap(
      JSONSerialization.jsonObject(with: noToolsBody) as? [String: Any])
    XCTAssertEqual((noToolsJSON["tools"] as? [Any])?.count, 0)
    XCTAssertEqual(noToolsJSON["tool_choice"] as? String, "none")

    let query = try AssistantApprovedQuery(originalQuery: "milk")
    let retrievalAuthorization = AssistantTurnRetrievalAuthorization(
      pageSearch: try AssistantPageSearchAuthorization(query: query, maximumResults: 5))
    let writeAuthorization = AssistantTurnWriteAuthorization(allowTaskCreate: true, allowSendEmail: true)
    let body = try OpenAIResponsesRequestBuilder.makeBody(
      utterance: "hi", priorTurns: [], modelID: modelID, continuationItems: [],
      retrievalAuthorization: retrievalAuthorization, writeAuthorization: writeAuthorization)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    let tools = try XCTUnwrap(json["tools"] as? [[String: Any]])
    let toolNames = Set(tools.compactMap { $0["name"] as? String })
    XCTAssertEqual(toolNames, ["searchPages", "proposeTaskCreate", "proposeSendEmail"])
    XCTAssertEqual(json["tool_choice"] as? String, "auto")
  }
}
