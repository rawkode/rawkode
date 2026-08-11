// AssistantConversationControllerTests.swift
// EnchiridionUITests
//
// Task #68. Proves `AssistantConversationController`'s own required
// property directly (task brief: "propose a write -> pending-confirmation
// UI shown -> explicit user tap required before AssistantTaskMutationApplier.apply
// or AssistantRemoteWriteClient's reviewer-side confirm is ever called"):
// `send(_:)` alone must never apply anything; only a separate, explicit
// `confirmProposal(_:)` call may.

import EnchiridionCore
import EnchiridionStore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionCore
@testable import EnchiridionUI

private final class FakeTransport: OpenAIResponsesTransporting, @unchecked Sendable {
  private let lock = NSLock()
  private var results: [OpenAIResponsesTransportResult]
  init(results: [OpenAIResponsesTransportResult]) { self.results = results }
  func send(body: Data, credential: String) async throws -> OpenAIResponsesTransportResult {
    lock.withLock {
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

private struct RecordingApplyTarget {
  final class Box: @unchecked Sendable {
    private let lock = NSLock()
    private var results: [AssistantTaskMutationApplyResult] = []
    func record(_ result: AssistantTaskMutationApplyResult) {
      lock.withLock { results.append(result) }
    }
    var count: Int { lock.withLock { results.count } }
  }
}

@MainActor
final class AssistantConversationControllerTests: XCTestCase {
  private let modelID = "gpt-test-model"

  func testSendAloneNeverAppliesAWriteProposalOnlyConfirmProposalDoes() async throws {
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
    let ledger = AssistantTaskMutationProposalLedger()
    let dispatcher = AssistantLocalToolDispatcher(
      store: try LocalGraphStore.openTemporary(), writeProposalRecorder: ledger.proposalRecorder)
    let assistant = OpenAIResponsesAssistant(
      modelID: modelID, executor: dispatcher, credential: { "sk-test" }, transport: transport)

    let applyBox = RecordingApplyTarget.Box()
    let controller = AssistantConversationController(
      assistant: assistant,
      ledger: ledger,
      writeAuthorization: { AssistantTurnWriteAuthorization(allowTaskCreate: true) },
      onLocalTaskMutationApplied: { result in applyBox.record(result) }
    )

    await controller.send("add buy milk to my tasks")

    // A write proposal must be surfaced for confirmation...
    XCTAssertEqual(controller.pendingProposals.count, 1)
    // ...but `send(_:)` alone must NEVER have applied it.
    XCTAssertEqual(applyBox.count, 0)
    let callID = try XCTUnwrap(controller.pendingProposals.first?.callID)
    let stateBeforeConfirm = await ledger.proposalReviewer.state(for: callID)
    XCTAssertEqual(stateBeforeConfirm, .awaitingNativeConfirmation)

    // Only this explicit call may apply it.
    await controller.confirmProposal(controller.pendingProposals[0])

    XCTAssertEqual(applyBox.count, 1)
    XCTAssertTrue(controller.pendingProposals.isEmpty)
    let stateAfterConfirm = await ledger.proposalReviewer.state(for: callID)
    XCTAssertEqual(stateAfterConfirm, .consumed)
  }

  func testRejectProposalNeverApplies() async throws {
    let toolCallEvent = try completedEvent(
      model: modelID,
      output: [
        try functionCallItem(
          name: "proposeTaskCreate", callID: "call_write_2",
          arguments: [
            "title": "Buy eggs", "notes": NSNull(), "priority": NSNull(), "placement": NSNull(),
            "estimatedMinutes": NSNull(),
          ])
      ])
    let transport = FakeTransport(results: [successResult(toolCallEvent)])
    let ledger = AssistantTaskMutationProposalLedger()
    let dispatcher = AssistantLocalToolDispatcher(
      store: try LocalGraphStore.openTemporary(), writeProposalRecorder: ledger.proposalRecorder)
    let assistant = OpenAIResponsesAssistant(
      modelID: modelID, executor: dispatcher, credential: { "sk-test" }, transport: transport)
    let applyBox = RecordingApplyTarget.Box()
    let controller = AssistantConversationController(
      assistant: assistant, ledger: ledger,
      writeAuthorization: { AssistantTurnWriteAuthorization(allowTaskCreate: true) },
      onLocalTaskMutationApplied: { result in applyBox.record(result) })

    await controller.send("add buy eggs to my tasks")
    let proposal = try XCTUnwrap(controller.pendingProposals.first)
    await controller.rejectProposal(proposal)

    XCTAssertEqual(applyBox.count, 0)
    let stateAfterReject = await ledger.proposalReviewer.state(for: proposal.callID)
    XCTAssertEqual(stateAfterReject, .rejected)
    // A rejected proposal can never later be confirmed.
    let confirmedAfterReject = await ledger.proposalReviewer.confirm(proposal.callID)
    XCTAssertFalse(confirmedAfterReject)
  }

  // MARK: - Task #78: default persistence when no `onLocalTaskMutationApplied` is supplied

  /// The real write-path fix: before task #78, a caller that did not
  /// supply its own `onLocalTaskMutationApplied` closure had an applied
  /// task mutation silently dropped — nothing persisted its CRDT snapshot
  /// or projection anywhere. This proves `confirmProposal(_:)` now
  /// persists it itself, into `store`, when no closure is supplied.
  func testConfirmProposalPersistsTheAppliedResultWhenNoClosureIsSupplied() async throws {
    let toolCallEvent = try completedEvent(
      model: modelID,
      output: [
        try functionCallItem(
          name: "proposeTaskCreate", callID: "call_write_3",
          arguments: [
            "title": "Buy bread", "notes": NSNull(), "priority": NSNull(), "placement": NSNull(),
            "estimatedMinutes": NSNull(),
          ])
      ])
    let transport = FakeTransport(results: [successResult(toolCallEvent)])
    let ledger = AssistantTaskMutationProposalLedger()
    let store = try LocalGraphStore.openTemporary()
    let dispatcher = AssistantLocalToolDispatcher(store: store, writeProposalRecorder: ledger.proposalRecorder)
    let assistant = OpenAIResponsesAssistant(
      modelID: modelID, executor: dispatcher, credential: { "sk-test" }, transport: transport)

    // Deliberately no `onLocalTaskMutationApplied` — proving the DEFAULT
    // (closure-less) persistence path.
    let controller = AssistantConversationController(
      assistant: assistant,
      ledger: ledger,
      store: store,
      writeAuthorization: { AssistantTurnWriteAuthorization(allowTaskCreate: true) }
    )

    await controller.send("add buy bread to my tasks")
    XCTAssertEqual(controller.pendingProposals.count, 1)

    await controller.confirmProposal(controller.pendingProposals[0])

    XCTAssertTrue(controller.pendingProposals.isEmpty)
    XCTAssertNil(controller.lastError, controller.lastError ?? "")

    let queried = try store.query(
      sql: "SELECT node_id FROM graph_nodes WHERE title = :title",
      arguments: [":title": .text("Buy bread")])
    XCTAssertEqual(queried.rows.count, 1, "confirming the proposal must have created and persisted a real page")
    guard case .text(let nodeID)? = queried.rows.first?.values.first else {
      return XCTFail("expected a text node_id column")
    }
    let pageID = PageID(rawValue: nodeID)

    let record = try await store.documentSnapshot(for: pageID)
    let unwrapped = try XCTUnwrap(
      record,
      "confirming a proposal with no onLocalTaskMutationApplied closure must still persist a real CRDT snapshot")
    XCTAssertEqual(try PageDocument.projection(of: unwrapped.snapshot).title, "Buy bread")
  }
}

private func successResult(_ data: Data) -> OpenAIResponsesTransportResult {
  OpenAIResponsesTransportResult(statusCode: 200, requestID: "req_1", retryAfterSeconds: nil, events: [data], errorCode: nil)
}
