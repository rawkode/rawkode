// AssistantWriteToolsTests.swift
// EnchiridionCoreTests
//
// Tests for Sources/EnchiridionCore/AssistantWriteTools.swift: the ledger
// state machine (record -> confirm/reject -> consumeConfirmed) and the
// self-confirm-is-unreachable security property that file's header
// describes in full.

import Foundation
import XCTest

@testable import EnchiridionCore

final class AssistantWriteToolsTests: XCTestCase {
  private func makeCreateProposal(_ id: String = "call_1") -> AssistantTaskMutationProposal {
    .create(
      callID: AssistantToolCallID(rawValue: id),
      draft: AssistantTaskDraft(title: "Buy milk"))
  }

  // MARK: - Happy path

  func testRecordConfirmConsumeHappyPath() async {
    let ledger = AssistantTaskMutationProposalLedger()
    let recorder = ledger.proposalRecorder
    let reviewer = ledger.proposalReviewer
    let proposal = makeCreateProposal()

    let recorded = await recorder.record(proposal)
    XCTAssertTrue(recorded)

    let stateAfterRecord = await reviewer.state(for: proposal.callID)
    XCTAssertEqual(stateAfterRecord, .awaitingNativeConfirmation)

    let confirmed = await reviewer.confirm(proposal.callID)
    XCTAssertTrue(confirmed)
    let stateAfterConfirm = await reviewer.state(for: proposal.callID)
    XCTAssertEqual(stateAfterConfirm, .confirmed)

    let consumed = await reviewer.consumeConfirmed(proposal.callID)
    XCTAssertEqual(consumed, proposal)
    let stateAfterConsume = await reviewer.state(for: proposal.callID)
    XCTAssertEqual(stateAfterConsume, .consumed)
  }

  func testRejectTransitionsAwaitingToRejected() async {
    let ledger = AssistantTaskMutationProposalLedger()
    let recorder = ledger.proposalRecorder
    let reviewer = ledger.proposalReviewer
    let proposal = makeCreateProposal()

    _ = await recorder.record(proposal)
    let rejected = await reviewer.reject(proposal.callID)
    XCTAssertTrue(rejected)
    let state = await reviewer.state(for: proposal.callID)
    XCTAssertEqual(state, .rejected)

    // Rejecting again fails — no longer `.awaitingNativeConfirmation`.
    let secondReject = await reviewer.reject(proposal.callID)
    XCTAssertFalse(secondReject)
  }

  // MARK: - Rejections

  func testDoubleRecordSameCallIDRejected() async {
    let ledger = AssistantTaskMutationProposalLedger()
    let recorder = ledger.proposalRecorder
    let proposal = makeCreateProposal()

    let firstRecord = await recorder.record(proposal)
    XCTAssertTrue(firstRecord)

    // A different proposal shape reusing the SAME callID (e.g. a
    // duplicate/retried tool call) must not silently overwrite the first.
    let secondProposal = AssistantTaskMutationProposal.create(
      callID: proposal.callID, draft: AssistantTaskDraft(title: "Different title"))
    let secondRecord = await recorder.record(secondProposal)
    XCTAssertFalse(secondRecord)

    let reviewer = ledger.proposalReviewer
    let stored = await reviewer.proposal(for: proposal.callID)
    XCTAssertEqual(stored, proposal)
  }

  func testConfirmBeforeRecordRejected() async {
    let ledger = AssistantTaskMutationProposalLedger()
    let reviewer = ledger.proposalReviewer
    let unknownCallID = AssistantToolCallID(rawValue: "never_recorded")

    let confirmed = await reviewer.confirm(unknownCallID)
    XCTAssertFalse(confirmed)
    let state = await reviewer.state(for: unknownCallID)
    XCTAssertNil(state)
  }

  func testConsumeBeforeConfirmRejected() async {
    let ledger = AssistantTaskMutationProposalLedger()
    let recorder = ledger.proposalRecorder
    let reviewer = ledger.proposalReviewer
    let proposal = makeCreateProposal()

    _ = await recorder.record(proposal)
    let consumed = await reviewer.consumeConfirmed(proposal.callID)
    XCTAssertNil(consumed)

    // State is unchanged — still awaiting confirmation, not silently
    // advanced.
    let state = await reviewer.state(for: proposal.callID)
    XCTAssertEqual(state, .awaitingNativeConfirmation)
  }

  func testConsumeIsOneShot() async {
    let ledger = AssistantTaskMutationProposalLedger()
    let recorder = ledger.proposalRecorder
    let reviewer = ledger.proposalReviewer
    let proposal = makeCreateProposal()

    _ = await recorder.record(proposal)
    _ = await reviewer.confirm(proposal.callID)

    let firstConsume = await reviewer.consumeConfirmed(proposal.callID)
    XCTAssertEqual(firstConsume, proposal)

    let secondConsume = await reviewer.consumeConfirmed(proposal.callID)
    XCTAssertNil(secondConsume)

    let state = await reviewer.state(for: proposal.callID)
    XCTAssertEqual(state, .consumed)
  }

  func testConfirmAfterConsumeFails() async {
    let ledger = AssistantTaskMutationProposalLedger()
    let recorder = ledger.proposalRecorder
    let reviewer = ledger.proposalReviewer
    let proposal = makeCreateProposal()

    _ = await recorder.record(proposal)
    _ = await reviewer.confirm(proposal.callID)
    _ = await reviewer.consumeConfirmed(proposal.callID)

    let reconfirm = await reviewer.confirm(proposal.callID)
    XCTAssertFalse(reconfirm)
  }

  // MARK: - Proposal identity across cases

  func testCallIDIsExtractedForEveryProposalCase() {
    let createProposal = AssistantTaskMutationProposal.create(
      callID: AssistantToolCallID(rawValue: "c1"), draft: AssistantTaskDraft(title: "A"))
    XCTAssertEqual(createProposal.callID, AssistantToolCallID(rawValue: "c1"))

    let updateProposal = AssistantTaskMutationProposal.update(
      callID: AssistantToolCallID(rawValue: "c2"),
      pageID: PageID.free(),
      version: AssistantPageVersionToken(encoded: Data()),
      patch: AssistantTaskMutationPatch(title: "B"))
    XCTAssertEqual(updateProposal.callID, AssistantToolCallID(rawValue: "c2"))

    let completeProposal = AssistantTaskMutationProposal.complete(
      callID: AssistantToolCallID(rawValue: "c3"),
      pageID: PageID.free(),
      version: AssistantPageVersionToken(encoded: Data()))
    XCTAssertEqual(completeProposal.callID, AssistantToolCallID(rawValue: "c3"))
  }

  // MARK: - Security property: self-confirm is unreachable from the
  // tool-dispatch-facing facade.
  //
  // `AssistantWriteProposalRecorder` (what the assistant's tool-dispatch
  // code is meant to be constructed with) is declared to conform to
  // `AssistantWriteProposalSubmitting` only. If it also, even
  // accidentally, ended up conforming to `AssistantWriteProposalConfirming`
  // (the protocol that carries `confirm`/`reject`/`consumeConfirmed`), a
  // caller could satisfy a `some AssistantWriteProposalConfirming`
  // parameter with it and reach those methods indirectly. This test proves
  // — at runtime, not just by reading the source — that the concrete value
  // handed out by `.proposalRecorder` does NOT satisfy
  // `AssistantWriteProposalConfirming`: the dynamic cast genuinely fails.
  //
  // (The stronger, compile-time half of this guarantee —
  // `recorder.confirm(...)` is a compile error because that member does
  // not exist on `AssistantWriteProposalRecorder` at all — can't be
  // expressed as a passing/failing test without breaking the build; it is
  // the reason `AssistantWriteProposalRecorder` has no `confirm` method in
  // its source, which is directly inspectable in AssistantWriteTools.swift.)
  func testProposalRecorderCannotBeTreatedAsAConfirmer() {
    let ledger = AssistantTaskMutationProposalLedger()
    let recorder: any AssistantWriteProposalSubmitting = ledger.proposalRecorder

    XCTAssertNil(
      recorder as? any AssistantWriteProposalConfirming,
      "AssistantWriteProposalRecorder must never satisfy AssistantWriteProposalConfirming — "
        + "if this fails, the tool-dispatch-facing facade has gained a reachable path to "
        + "confirm/reject/consumeConfirmed, reopening the self-confirm bug this file's header "
        + "documents.")
  }

  func testProposalReviewerDoesSatisfyConfirming() {
    // Sanity check for the test above: the REVIEWER facade (meant only for
    // human-driven UI code) does, correctly, satisfy the confirming
    // protocol — proving the previous test's `XCTAssertNil` is a real
    // negative, not an artifact of the protocol being uninhabited.
    let ledger = AssistantTaskMutationProposalLedger()
    let reviewer: any AssistantWriteProposalConfirming = ledger.proposalReviewer
    XCTAssertNotNil(reviewer as? any AssistantWriteProposalConfirming)
  }
}
