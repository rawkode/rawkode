// AssistantConversationEndToEndTests.swift
// EnchiridionUITests
//
// Task #68. THE required full round-trip test (task brief: "fake OpenAI
// response containing a tool call -> your dispatch loop executes the real
// tool (against a fixture EnchiridionStore or similar) -> grounding policy
// produces a real GroundedAssistantResponse -> assert the answer text is
// exactly the tool's trusted fact text, never anything from the fake
// model's own generated prose"). Every layer here is real EXCEPT the
// OpenAI HTTP transport itself:
//   - `OpenAIResponsesAssistant` — real (task #68).
//   - `AssistantLocalToolDispatcher` — real (task #68).
//   - `LocalGraphStore` — real, temporary on-disk SQLite (task #66's own
//     fixture pattern, `EnchiridionStoreTests/AssistantReadToolsTests.swift`).
//   - `AssistantGroundingPolicy` — real (#65), invoked transitively.
//   - The OpenAI transport — fake, returning hand-built SSE-decoded events,
//     matching this task's "mock the OpenAI HTTP layer only" instruction.

import EnchiridionCore
import EnchiridionSchema
import EnchiridionStore
import Foundation
import XCTest

@testable import EnchiridionCore
@testable import EnchiridionUI

private final class FakeTransport: OpenAIResponsesTransporting, @unchecked Sendable {
  private let lock = NSLock()
  private var results: [OpenAIResponsesTransportResult]
  private(set) var sentBodies: [Data] = []

  init(results: [OpenAIResponsesTransportResult]) { self.results = results }

  func send(body: Data, credential: String) async throws -> OpenAIResponsesTransportResult {
    lock.withLock {
      sentBodies.append(body)
      guard !results.isEmpty else {
        return OpenAIResponsesTransportResult(statusCode: 500, requestID: nil, retryAfterSeconds: nil, events: [], errorCode: nil)
      }
      return results.removeFirst()
    }
  }
}

private func completedEvent(model: String, output: [[String: Any]]) throws -> Data {
  let response: [String: Any] = ["id": "resp_1", "model": model, "status": "completed", "output": output]
  let envelope: [String: Any] = ["type": "response.completed", "response": response]
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

private func successResult(_ data: Data) -> OpenAIResponsesTransportResult {
  OpenAIResponsesTransportResult(statusCode: 200, requestID: "req_1", retryAfterSeconds: nil, events: [data], errorCode: nil)
}

final class AssistantConversationEndToEndTests: XCTestCase {
  private let modelID = "gpt-test-model"

  func testFullRoundTripAnswerIsExactlyTheRealTasksToolsTrustedFactText() async throws {
    // Real store, seeded with one real task page — nothing about this
    // page's data is fabricated by the test's mocks; it goes through the
    // exact same GRDB projection every other read-tool test uses.
    let store = try LocalGraphStore.openTemporary()
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000099")!)
    try await store.writeProjection(
      pageID: pageID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Buy milk", plainText: "Buy milk", deletedAt: nil, isPinned: false, references: [],
        graphEdges: [],
        objectMetadata: .init(
          supertagIDs: [CoreTaskFieldIDs.supertagID],
          properties: [
            .init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.status): [
              .select(CoreTaskStatus.toDo.rawValue)
            ],
            .init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.placement): [
              .select(CoreTaskPlacement.inbox.rawValue)
            ],
          ])))
    let dispatcher = AssistantLocalToolDispatcher(store: store)

    let query = try AssistantApprovedQuery(originalQuery: "")
    let taskAuthorization = try AssistantTaskSearchAuthorization(scope: .inbox, query: query, maximumResults: 10)
    let retrievalAuthorization = AssistantTurnRetrievalAuthorization(taskSearch: taskAuthorization)

    // First model turn: a tool call for searchTasks. Second model turn: a
    // structured answer whose OWN prose must be discarded — only the fact
    // the real store actually returned may become the final answer text.
    let toolCallEvent = try completedEvent(
      model: modelID,
      output: [try functionCallItem(name: "searchTasks", callID: "call_1", arguments: ["scope": "inbox", "query": "", "limit": 10])])
    let finalEvent = try completedEvent(
      model: modelID,
      output: [
        try answerMessageItem(
          answer: "This text was generated by the fake model and must never appear in the final answer.",
          factIDs: ["task:\(pageID.rawValue)#summary"])
      ])
    let transport = FakeTransport(results: [successResult(toolCallEvent), successResult(finalEvent)])

    let assistant = OpenAIResponsesAssistant(
      modelID: modelID, executor: dispatcher, credential: { "sk-test" }, transport: transport)

    let outcome = await assistant.respond(
      to: AssistantConversationRequest(
        utterance: "what's in my inbox?", retrievalAuthorization: retrievalAuthorization))

    guard case .grounded(let response) = outcome else { return XCTFail("expected a grounded response") }
    // The real store's own trusted fact text — built entirely by app code
    // in AssistantReadTools.swift's `taskSpokenText`, never by the model.
    XCTAssertEqual(response.answer, "Buy milk.")
    XCTAssertNotEqual(
      response.answer, "This text was generated by the fake model and must never appear in the final answer.")
    XCTAssertEqual(response.status, .answered)
    XCTAssertEqual(response.sources.map(\.title), ["Buy milk"])
    XCTAssertEqual(transport.sentBodies.count, 2)
  }

  func testFullRoundTripWriteProposalIsRecordedButNeverAutoConfirmed() async throws {
    let store = try LocalGraphStore.openTemporary()
    let ledger = AssistantTaskMutationProposalLedger()
    let dispatcher = AssistantLocalToolDispatcher(store: store, writeProposalRecorder: ledger.proposalRecorder)
    let writeAuthorization = AssistantTurnWriteAuthorization(allowTaskCreate: true)

    let toolCallEvent = try completedEvent(
      model: modelID,
      output: [
        try functionCallItem(
          name: "proposeTaskCreate", callID: "call_write",
          arguments: [
            "title": "Buy milk", "notes": NSNull(), "priority": NSNull(), "placement": NSNull(),
            "estimatedMinutes": NSNull(),
          ])
      ])
    let transport = FakeTransport(results: [successResult(toolCallEvent)])
    let assistant = OpenAIResponsesAssistant(
      modelID: modelID, executor: dispatcher, credential: { "sk-test" }, transport: transport)

    let outcome = await assistant.respond(
      to: AssistantConversationRequest(utterance: "add buy milk to my tasks", writeAuthorization: writeAuthorization))

    guard case .pendingWriteConfirmation(let summary) = outcome else {
      return XCTFail("expected a pending write confirmation")
    }
    let stateBeforeConfirm = await ledger.proposalReviewer.state(for: summary.callID)
    XCTAssertEqual(stateBeforeConfirm, .awaitingNativeConfirmation)
    // Only an explicit later call to the WIDE reviewer facade — never
    // reached by anything above — can move this forward.
    let confirmed = await ledger.proposalReviewer.confirm(summary.callID)
    XCTAssertTrue(confirmed)
    let stateAfterConfirm = await ledger.proposalReviewer.state(for: summary.callID)
    XCTAssertEqual(stateAfterConfirm, .confirmed)
  }
}
