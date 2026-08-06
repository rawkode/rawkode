// AssistantHomeViewOwnershipTests.swift
// EnchiridionUITests
//
// Task #91 (adversarial-review finding, HIGH severity, real user-facing
// data loss). Before this task, `AssistantHomeView` (`EnchiridionUI
// /AssistantHomeView.swift`) owned its own `AssistantConversationController`
// via `@State private var controller: AssistantConversationController?`,
// rebuilt in a `.task` whenever `controller == nil`. `Sources/macOS
// /RootView.swift`'s `NavigationSplitView` renders exactly one destination
// at a time inside a conditional `switch` in its `detail` closure —
// standard SwiftUI branch-identity semantics tear down and rebuild
// whichever case isn't currently selected. Navigating away from
// "Assistant" and back therefore produced a BRAND NEW `AssistantHomeView`
// with `controller == nil`, silently discarding the whole conversation
// transcript AND any pending unconfirmed write proposal the person hadn't
// tapped "confirm" on yet.
//
// The fix moved controller ownership OUT of `AssistantHomeView` entirely:
// both `Sources/macOS/RootView.swift` and `Sources/iOS/RootView.swift` now
// construct exactly one `AssistantConversationController` in their own
// `@State`, above wherever `NavigationSplitView`/`TabView` swap
// destinations, and hand it down as a plain value. `AssistantHomeView`
// itself has no `@State` at all anymore — see its header.
//
// WHAT THIS FILE CAN AND CANNOT PROVE — stated plainly, matching this
// codebase's established standard (see `RootNavigationTests.swift`'s own
// header for the precedent): the real `NavigationSplitView`/`TabView`
// shells live in Xcode-app-target-only `Sources/macOS`/`Sources/iOS`
// directories with no SwiftPM test target reaching them (`Package.swift`
// lists neither directory as a target), so the actual branch-identity
// teardown-and-rebuild of a `NavigationSplitView` destination is NOT, and
// cannot be, exercised here — that remains verified only by the real
// `xcodebuild build` this task's own verification bar requires, same as
// before. What CAN be, and is, proven by a real automated test: the
// concrete mechanism the fix relies on — that `AssistantHomeView` never
// constructs or resets a controller itself, and that a real transcript and
// a real pending, unconfirmed write proposal survive being handed to
// MULTIPLE, independently-constructed `AssistantHomeView` values built from
// the SAME externally-owned controller reference, exactly the shape
// `RootView`'s hoisted `@State` now produces on every destination rebuild.
// A regression back to `AssistantHomeView` owning its own controller (e.g.
// reintroducing `init(store:)`) would fail this file to even compile.

import EnchiridionCore
import EnchiridionStore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionCore
@testable import EnchiridionUI

private final class OwnershipFakeTransport: OpenAIResponsesTransporting, @unchecked Sendable {
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

private func ownershipCompletedEvent(model: String, output: [[String: Any]]) throws -> Data {
  let response: [String: Any] = ["id": "resp_1", "model": model, "status": "completed", "output": output]
  let envelope: [String: Any] = ["type": "response.completed", "response": response]
  return try JSONSerialization.data(withJSONObject: envelope)
}

private func ownershipFunctionCallItem(name: String, callID: String, arguments: [String: Any]) throws -> [String: Any] {
  let argumentsData = try JSONSerialization.data(withJSONObject: arguments)
  return [
    "type": "function_call", "name": name, "call_id": callID,
    "arguments": String(decoding: argumentsData, as: UTF8.self),
  ]
}

private func ownershipSuccessResult(_ data: Data) -> OpenAIResponsesTransportResult {
  OpenAIResponsesTransportResult(statusCode: 200, requestID: "req_1", retryAfterSeconds: nil, events: [data], errorCode: nil)
}

@MainActor
final class AssistantHomeViewOwnershipTests: XCTestCase {
  private let modelID = "gpt-test-model"

  /// The core regression test for the fix: a real transcript message and a
  /// real pending, unconfirmed write proposal (the two pieces of state the
  /// task brief names explicitly) must still be present on the controller
  /// after it has been handed to several separately-constructed
  /// `AssistantHomeView` values — simulating `NavigationSplitView` tearing
  /// down and rebuilding the destination struct on every sidebar
  /// reselection, which is exactly what happens on every "navigate away
  /// from Assistant and back" trip.
  func testTranscriptAndPendingProposalSurviveTheControllerBeingHandedToRepeatedlyReconstructedHomeViews() async throws {
    let toolCallEvent = try ownershipCompletedEvent(
      model: modelID,
      output: [
        try ownershipFunctionCallItem(
          name: "proposeTaskCreate", callID: "call_ownership_write",
          arguments: [
            "title": "Buy oat milk", "notes": NSNull(), "priority": NSNull(), "placement": NSNull(),
            "estimatedMinutes": NSNull(),
          ])
      ])
    let transport = OwnershipFakeTransport(results: [ownershipSuccessResult(toolCallEvent)])
    let ledger = AssistantTaskMutationProposalLedger()
    let dispatcher = AssistantLocalToolDispatcher(
      store: try LocalGraphStore.openTemporary(), writeProposalRecorder: ledger.proposalRecorder)
    let assistant = OpenAIResponsesAssistant(
      modelID: modelID, executor: dispatcher, credential: { "sk-test" }, transport: transport)

    // The ONE controller `RootView`'s own hoisted `@State` would construct
    // exactly once, above the navigation-shell's destination switch.
    let controller = AssistantConversationController(
      assistant: assistant,
      ledger: ledger,
      writeAuthorization: { AssistantTurnWriteAuthorization(allowTaskCreate: true) }
    )

    await controller.send("add buy oat milk to my tasks")

    XCTAssertFalse(controller.messages.isEmpty, "a real turn must produce a real transcript")
    XCTAssertEqual(
      controller.pendingProposals.count, 1,
      "a proposeTaskCreate tool call must surface a pending, unconfirmed write proposal")
    let messageCountBeforeRebuilds = controller.messages.count
    let pendingCallID = try XCTUnwrap(controller.pendingProposals.first?.callID)

    // Simulate `NavigationSplitView` (macOS) / `TabView` (iOS) tearing down
    // and rebuilding the "Assistant" destination struct several times —
    // e.g. the person bouncing between Today, Tasks, and Assistant. Each
    // rebuild constructs a BRAND NEW `AssistantHomeView` value, exactly the
    // way `RootView.destination(for:store:assistantController:)` does —
    // but always from the SAME hoisted `controller` reference, never asking
    // `AssistantHomeView` to build its own (its `init` no longer even has a
    // `store` parameter to build one from — see `AssistantHomeView.swift`).
    for _ in 0..<5 {
      _ = AssistantHomeView(controller: controller)
    }

    // Nothing about constructing (or discarding) those view values touched
    // the controller's own state — it isn't observable, settable, or
    // resettable from outside `AssistantConversationController` itself, and
    // `AssistantHomeView` never called anything on it.
    XCTAssertEqual(
      controller.messages.count, messageCountBeforeRebuilds,
      "the transcript must be byte-for-byte the same after the controller is handed to newly constructed views")
    XCTAssertEqual(
      controller.pendingProposals.count, 1,
      "the pending write proposal must still be there, unconfirmed, after repeated view reconstruction")
    XCTAssertEqual(controller.pendingProposals.first?.callID, pendingCallID)

    // And it isn't just the surface-level array that survived — the
    // underlying ledger entry is still genuinely confirmable, proving this
    // isn't a fresh controller silently starting from an empty ledger.
    await controller.confirmProposal(controller.pendingProposals[0])
    XCTAssertTrue(controller.pendingProposals.isEmpty)
    XCTAssertNil(controller.lastError, controller.lastError ?? "")
    let stateAfterConfirm = await ledger.proposalReviewer.state(for: pendingCallID)
    XCTAssertEqual(stateAfterConfirm, .consumed)
  }
}
