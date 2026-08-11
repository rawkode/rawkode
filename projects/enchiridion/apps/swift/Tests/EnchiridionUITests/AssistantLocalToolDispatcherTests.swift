// AssistantLocalToolDispatcherTests.swift
// EnchiridionUITests
//
// Task #68. Exercises `AssistantLocalToolDispatcher` against a REAL
// temporary `LocalGraphStore` (same fixture pattern
// `EnchiridionStoreTests/AssistantReadToolsTests.swift` established for
// #66) — not a mock at the read-tool layer, since that layer already has
// its own real-store tests; this file's job is proving THIS module's
// dispatch/argument-validation/security wiring is correct.
//
// THE CRITICAL TEST IN THIS FILE:
// `testDispatcherNeverAutoConfirmsAWriteProposalItRecords` and
// `testWriteFacadesCannotBeSwappedForReviewerShapedValues` together prove
// the property `AssistantLocalToolDispatcher.swift`'s header calls out as
// the single most important one in this task: the dispatcher, as actually
// constructed, has no reachable path to `confirm`/`reject`/
// `consumeConfirmed`/`confirmApproval`.

import EnchiridionCore
import EnchiridionSchema
import EnchiridionStore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionUI

// MARK: - Test doubles

private struct FakeSnapshotProvider: AssistantTaskSnapshotProviding {
  let snapshots: [String: Data]
  func snapshot(for pageID: PageID) async throws -> Data? { snapshots[pageID.rawValue] }
}

private final class FakeRemoteWriteTransport: AssistantRemoteWriteTransport, @unchecked Sendable {
  private let lock = NSLock()
  private(set) var createEventCalls: [AssistantCreateEventInput] = []
  private(set) var rsvpCalls: [AssistantRsvpInput] = []
  private(set) var sendEmailCalls: [AssistantSendEmailInput] = []
  private(set) var archiveThreadCalls: [AssistantArchiveThreadInput] = []
  private(set) var applyLabelCalls: [AssistantApplyLabelInput] = []
  private(set) var removeLabelCalls: [AssistantRemoveLabelInput] = []
  private(set) var markReadCalls: [AssistantMarkReadInput] = []
  private(set) var markUnreadCalls: [AssistantMarkUnreadInput] = []

  func createEvent(_ input: AssistantCreateEventInput) async throws -> AssistantPendingApproval {
    lock.withLock { createEventCalls.append(input) }
    return Self.approval(.createEvent)
  }

  func rsvp(_ input: AssistantRsvpInput) async throws -> AssistantPendingApproval {
    lock.withLock { rsvpCalls.append(input) }
    return Self.approval(.rsvp)
  }

  func sendEmail(_ input: AssistantSendEmailInput) async throws -> AssistantPendingApproval {
    lock.withLock { sendEmailCalls.append(input) }
    return Self.approval(.sendEmail)
  }

  func archiveThread(_ input: AssistantArchiveThreadInput) async throws -> AssistantPendingApproval {
    lock.withLock { archiveThreadCalls.append(input) }
    return Self.approval(.archiveThread)
  }

  func applyLabel(_ input: AssistantApplyLabelInput) async throws -> AssistantPendingApproval {
    lock.withLock { applyLabelCalls.append(input) }
    return Self.approval(.applyLabel)
  }

  func removeLabel(_ input: AssistantRemoveLabelInput) async throws -> AssistantPendingApproval {
    lock.withLock { removeLabelCalls.append(input) }
    return Self.approval(.removeLabel)
  }

  func markRead(_ input: AssistantMarkReadInput) async throws -> AssistantPendingApproval {
    lock.withLock { markReadCalls.append(input) }
    return Self.approval(.markRead)
  }

  func markUnread(_ input: AssistantMarkUnreadInput) async throws -> AssistantPendingApproval {
    lock.withLock { markUnreadCalls.append(input) }
    return Self.approval(.markUnread)
  }

  private static func approval(_ type: AssistantPendingApprovalActionType) -> AssistantPendingApproval {
    AssistantPendingApproval(
      id: "approval_1", actionType: type, versionToken: "token_1", status: .pending,
      createdAt: Date(), updatedAt: Date())
  }
}

// MARK: - Tests

final class AssistantLocalToolDispatcherTests: XCTestCase {
  private func makeStore() throws -> LocalGraphStore { try LocalGraphStore.openTemporary() }

  private func page(_ n: Int) -> PageID {
    PageID.free(UUID(uuidString: String(format: "00000000-0000-0000-0000-%012d", n))!)
  }

  private func call(_ name: String, callID: String = "call_1", arguments: [String: Any]) throws -> AssistantModelToolCall {
    let data = try JSONSerialization.data(withJSONObject: arguments)
    return AssistantModelToolCall(
      name: name, callID: AssistantToolCallID(rawValue: callID), arguments: String(decoding: data, as: UTF8.self))
  }

  // MARK: - Read tools (functional smoke tests — the real bounds tests live in EnchiridionStoreTests)

  func testSearchPagesReturnsRealStoreResults() async throws {
    let store = try makeStore()
    try await store.writeProjection(
      pageID: page(1), kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Grocery run", plainText: "Grocery run\nBuy milk.", deletedAt: nil, isPinned: false,
        references: [], graphEdges: [], objectMetadata: .init()))
    let dispatcher = AssistantLocalToolDispatcher(store: store)
    let query = try AssistantApprovedQuery(originalQuery: "grocery")
    let authorization = AssistantTurnRetrievalAuthorization(
      pageSearch: try AssistantPageSearchAuthorization(query: query, maximumResults: 5))

    let result = try await dispatcher.execute(
      try call("searchPages", arguments: ["query": "grocery", "limit": 5]),
      now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [], eligibleEmailThreadIDs: [], calendarContextEstablishedThisTurn: false,
      retrievalAuthorization: authorization, writeAuthorization: .none)

    guard case .retrieval(let output) = result else { return XCTFail("expected a retrieval result") }
    XCTAssertEqual(output.sources.map(\.title), ["Grocery run"])
    XCTAssertFalse(output.facts.isEmpty)
  }

  func testUnauthorizedToolIsRejectedRegardlessOfWhatTheModelClaims() async throws {
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore())
    do {
      _ = try await dispatcher.execute(
        try call("searchPages", arguments: ["query": "grocery", "limit": 5]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [], eligibleEmailThreadIDs: [], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: .none)
      XCTFail("expected toolNotAuthorizedThisTurn")
    } catch AssistantModelToolError.toolNotAuthorizedThisTurn {
      // expected — no pageSearch authorization was granted this turn.
    }
  }

  func testUnknownToolNameIsRejected() async throws {
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore())
    do {
      _ = try await dispatcher.execute(
        try call("deleteEverything", arguments: [:]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [], eligibleEmailThreadIDs: [], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: .none)
      XCTFail("expected unknownTool")
    } catch AssistantModelToolError.unknownTool {
      // expected
    }
  }

  func testExtraOrMissingArgumentKeysAreRejected() async throws {
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore())
    let query = try AssistantApprovedQuery(originalQuery: "grocery")
    let authorization = AssistantTurnRetrievalAuthorization(
      pageSearch: try AssistantPageSearchAuthorization(query: query, maximumResults: 5))
    do {
      _ = try await dispatcher.execute(
        try call("searchPages", arguments: ["query": "grocery", "limit": 5, "extra": "surprise"]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [], eligibleEmailThreadIDs: [], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: authorization, writeAuthorization: .none)
      XCTFail("expected invalidArguments")
    } catch AssistantModelToolError.invalidArguments {
      // expected
    }
  }

  // MARK: - meetingBrief eligibility discipline

  func testMeetingBriefRejectsASourceIDNotActuallyReturnedThisTurnEvenIfPreAuthorized() async throws {
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore())
    let sourceID = "calendar:\(Data("some-event".utf8).base64EncodedString())"
    let authorization = AssistantTurnRetrievalAuthorization(
      meetingBrief: try AssistantMeetingBriefAuthorization(allowedSourceIDs: [sourceID], maximumPeople: 5))
    do {
      _ = try await dispatcher.execute(
        try call("meetingBrief", arguments: ["sourceID": sourceID, "peopleLimit": 5]),
        // Note: NOT included in eligibleCalendarSourceIDs, simulating a
        // model that never actually called findCalendarEvents this turn.
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [], eligibleEmailThreadIDs: [], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: authorization, writeAuthorization: .none)
      XCTFail("expected candidateNotEligibleThisTurn")
    } catch AssistantModelToolError.candidateNotEligibleThisTurn {
      // expected — pre-authorization alone is not enough; the source must
      // have actually been surfaced by findCalendarEvents this turn.
    }
  }

  // MARK: - Local task write tools

  func testProposeTaskCreateRecordsARealProposalAndReturnsATrustedSummary() async throws {
    let ledger = AssistantTaskMutationProposalLedger()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), writeProposalRecorder: ledger.proposalRecorder)
    let authorization = AssistantTurnWriteAuthorization(allowTaskCreate: true)

    let result = try await dispatcher.execute(
      try call(
        "proposeTaskCreate", callID: "call_create",
        arguments: ["title": "Buy milk", "notes": NSNull(), "priority": "high", "placement": NSNull(), "estimatedMinutes": NSNull()]),
      now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [], eligibleEmailThreadIDs: [], calendarContextEstablishedThisTurn: false,
      retrievalAuthorization: .none, writeAuthorization: authorization)

    guard case .writeProposed(let callID, let output) = result else { return XCTFail("expected a write proposal") }
    XCTAssertEqual(callID, AssistantToolCallID(rawValue: "call_create"))
    XCTAssertTrue(output.summary.contains("Buy milk"))
    XCTAssertNil(output.remoteApproval)

    let recorded = await ledger.proposalReviewer.proposal(for: callID)
    guard case .create(_, let draft) = recorded else { return XCTFail("expected a recorded create proposal") }
    XCTAssertEqual(draft.title, "Buy milk")
    XCTAssertEqual(draft.priority, .high)
    let state = await ledger.proposalReviewer.state(for: callID)
    XCTAssertEqual(state, .awaitingNativeConfirmation)
  }

  func testProposeTaskCreateIsUnavailableWithNoRecorderEvenIfAuthorized() async throws {
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore())  // no writeProposalRecorder
    let authorization = AssistantTurnWriteAuthorization(allowTaskCreate: true)
    do {
      _ = try await dispatcher.execute(
        try call(
          "proposeTaskCreate",
          arguments: ["title": "Buy milk", "notes": NSNull(), "priority": NSNull(), "placement": NSNull(), "estimatedMinutes": NSNull()]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [], eligibleEmailThreadIDs: [], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected toolNotAuthorizedThisTurn")
    } catch AssistantModelToolError.toolNotAuthorizedThisTurn {
      // expected
    }
  }

  func testProposeTaskUpdateRejectsAPageIDNotReturnedBySearchTasksThisTurn() async throws {
    let ledger = AssistantTaskMutationProposalLedger()
    let dispatcher = AssistantLocalToolDispatcher(
      store: try makeStore(), writeProposalRecorder: ledger.proposalRecorder,
      taskSnapshotProvider: FakeSnapshotProvider(snapshots: [:]))
    let authorization = AssistantTurnWriteAuthorization(allowTaskUpdate: true)
    do {
      _ = try await dispatcher.execute(
        try call(
          "proposeTaskUpdate",
          arguments: [
            "pageID": "task:invented-id", "title": NSNull(), "notes": NSNull(), "priority": NSNull(),
            "placement": NSNull(), "estimatedMinutes": NSNull(),
          ]),
        now: Date(), eligibleCalendarSourceIDs: [],
        eligibleTaskPageIDs: [], eligibleEmailThreadIDs: [], calendarContextEstablishedThisTurn: false,  // model never actually got this ID from searchTasks
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected candidateNotEligibleThisTurn")
    } catch AssistantModelToolError.candidateNotEligibleThisTurn {
      // expected
    }
  }

  func testProposeTaskUpdateRecordsAProposalWithARealVersionTokenWhenEligible() async throws {
    let pageID = page(60)
    let (document, _) = try PageDocument.create(id: pageID, kind: .free, title: "Old title", createdAt: Date())
    let ledger = AssistantTaskMutationProposalLedger()
    let dispatcher = AssistantLocalToolDispatcher(
      store: try makeStore(), writeProposalRecorder: ledger.proposalRecorder,
      taskSnapshotProvider: FakeSnapshotProvider(snapshots: [pageID.rawValue: document]))
    let authorization = AssistantTurnWriteAuthorization(allowTaskUpdate: true)
    let sourceID = "task:\(pageID.rawValue)"

    let result = try await dispatcher.execute(
      try call(
        "proposeTaskUpdate", callID: "call_update",
        arguments: [
          "pageID": sourceID, "title": "New title", "notes": NSNull(), "priority": NSNull(),
          "placement": NSNull(), "estimatedMinutes": NSNull(),
        ]),
      now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [sourceID], eligibleEmailThreadIDs: [], calendarContextEstablishedThisTurn: false,
      retrievalAuthorization: .none, writeAuthorization: authorization)

    guard case .writeProposed(let callID, let output) = result else { return XCTFail("expected a write proposal") }
    XCTAssertTrue(output.summary.contains("New title"))
    let recorded = await ledger.proposalReviewer.proposal(for: callID)
    guard case .update(_, let recordedPageID, let version, let patch) = recorded else {
      return XCTFail("expected a recorded update proposal")
    }
    XCTAssertEqual(recordedPageID, pageID)
    XCTAssertEqual(patch.title, "New title")
    XCTAssertFalse(version.encoded.isEmpty)
  }

  // MARK: - Remote write tools

  func testProposeCreateEventCallsOnlyTheProposeOnlyTransportMethod() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowCreateEvent: true)

    let result = try await dispatcher.execute(
      try call(
        "proposeCreateEvent",
        arguments: [
          "summary": "Team sync", "description": NSNull(), "location": NSNull(),
          "start": ["dateTime": "2026-01-01T10:00:00Z", "date": NSNull(), "timeZone": NSNull()],
          "end": ["dateTime": "2026-01-01T11:00:00Z", "date": NSNull(), "timeZone": NSNull()],
          "attendeeEmails": NSNull(),
        ]),
      now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [], eligibleEmailThreadIDs: [], calendarContextEstablishedThisTurn: false,
      retrievalAuthorization: .none, writeAuthorization: authorization)

    guard case .writeProposed(_, let output) = result else { return XCTFail("expected a write proposal") }
    XCTAssertTrue(output.summary.contains("Team sync"))
    XCTAssertNotNil(output.remoteApproval)
    XCTAssertEqual(transport.createEventCalls.count, 1)
    XCTAssertEqual(transport.createEventCalls.first?.summary, "Team sync")
  }

  // MARK: - proposeRsvp calendar-context + eligibility discipline (#72 Fix
  // 2, extended by task #96's real server-side event-ID verification)

  /// (a) With no prior `findCalendarEvents`/`meetingBrief` call this turn,
  /// `proposeRsvp` must be rejected outright before argument validation
  /// even gets a chance to run.
  func testProposeRsvpIsRejectedWithNoPriorCalendarToolCallThisTurn() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowRsvp: true)
    do {
      _ = try await dispatcher.execute(
        try call(
          "proposeRsvp",
          arguments: ["eventSourceID": "calendar:bogus", "responseStatus": "accepted"]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [], eligibleEmailThreadIDs: [],
        calendarContextEstablishedThisTurn: false,  // model never called findCalendarEvents/meetingBrief this turn
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected noCalendarContextThisTurn")
    } catch AssistantModelToolError.noCalendarContextThisTurn {
      // expected
    }
    XCTAssertEqual(transport.rsvpCalls.count, 0)
  }

  /// (b) Regression guard: once `findCalendarEvents`/`meetingBrief` has run
  /// earlier this turn AND actually returned this event's source ID,
  /// `proposeRsvp` must be accepted, decoding the source ID back to the
  /// real `eventPageID` the wire contract (task #94) now requires.
  func testProposeRsvpIsAcceptedForAnEligibleEventSourceIDAfterACalendarReadToolCallThisTurn() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowRsvp: true)
    let sourceID = AssistantReadToolSupport.calendarSourceID(pageID: "event:abc123")

    let result = try await dispatcher.execute(
      try call(
        "proposeRsvp",
        arguments: ["eventSourceID": sourceID, "responseStatus": "accepted"]),
      now: Date(), eligibleCalendarSourceIDs: [sourceID], eligibleTaskPageIDs: [], eligibleEmailThreadIDs: [],
      calendarContextEstablishedThisTurn: true,  // simulating findCalendarEvents/meetingBrief ran earlier this turn
      retrievalAuthorization: .none, writeAuthorization: authorization)

    guard case .writeProposed(_, let output) = result else { return XCTFail("expected a write proposal") }
    XCTAssertEqual(transport.rsvpCalls.count, 1)
    XCTAssertEqual(transport.rsvpCalls.first?.eventPageID, "event:abc123")
    XCTAssertNotNil(output.remoteApproval)
  }

  /// (c) The real eligibility check (task #96): an `eventSourceID` the
  /// model invents — even a syntactically valid one — must be rejected if
  /// it wasn't actually a member of THIS turn's real
  /// `eligibleCalendarSourceIDs`, exactly the same discipline
  /// `taskPageID(from:eligibleTaskPageIDs:)` already enforces for local
  /// task writes and `threadPageID(from:eligibleEmailThreadIDs:)` enforces
  /// for Gmail triage. This is the property that used to be entirely
  /// absent for `proposeRsvp` (P5/P7's tracked gap) — closing it is this
  /// task's own re-verification requirement.
  func testProposeRsvpRejectsAnEventSourceIDNotReturnedThisTurn() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowRsvp: true)
    let returnedThisTurn = AssistantReadToolSupport.calendarSourceID(pageID: "event:real")
    let invented = AssistantReadToolSupport.calendarSourceID(pageID: "event:invented-by-model")

    do {
      _ = try await dispatcher.execute(
        try call(
          "proposeRsvp",
          arguments: ["eventSourceID": invented, "responseStatus": "accepted"]),
        now: Date(), eligibleCalendarSourceIDs: [returnedThisTurn], eligibleTaskPageIDs: [],
        eligibleEmailThreadIDs: [],
        calendarContextEstablishedThisTurn: true,
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected candidateNotEligibleThisTurn")
    } catch AssistantModelToolError.candidateNotEligibleThisTurn {
      // expected
    }
    XCTAssertEqual(transport.rsvpCalls.count, 0, "an ineligible eventSourceID must never reach the transport")
  }

  func testProposeSendEmailRejectsAnEmptyRecipientList() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowSendEmail: true)
    do {
      _ = try await dispatcher.execute(
        try call(
          "proposeSendEmail",
          arguments: ["to": [], "subject": "Hi", "body": "Hello", "cc": NSNull(), "bcc": NSNull()]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [], eligibleEmailThreadIDs: [], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected invalidArguments")
    } catch AssistantModelToolError.invalidArguments {
      // expected
    }
    XCTAssertEqual(transport.sendEmailCalls.count, 0)
  }

  // MARK: - Gmail triage remote write tools (archive/apply label/remove
  // label/mark read/mark unread) — for each: (a) happy path when the
  // threadPageID was actually returned by searchEmailThreads this turn,
  // (b) rejected with candidateNotEligibleThisTurn when it was not, (c)
  // rejected with toolNotAuthorizedThisTurn when the corresponding
  // `allow*` flag is off, (d) rejected the same way when
  // `remoteWriteTransport` is nil.

  private let eligibleThreadPageID = "email_thread_eligible_1"

  func testProposeArchiveEmailCallsArchiveThreadWhenEligible() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowArchiveEmail: true)

    let result = try await dispatcher.execute(
      try call("proposeArchiveEmail", arguments: ["threadPageID": eligibleThreadPageID]),
      now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
      eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
      retrievalAuthorization: .none, writeAuthorization: authorization)

    guard case .writeProposed(_, let output) = result else { return XCTFail("expected a write proposal") }
    XCTAssertNotNil(output.remoteApproval)
    XCTAssertEqual(transport.archiveThreadCalls.count, 1)
    XCTAssertEqual(transport.archiveThreadCalls.first?.threadPageID, eligibleThreadPageID)
  }

  func testProposeArchiveEmailRejectsAThreadPageIDNotReturnedBySearchEmailThreadsThisTurn() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowArchiveEmail: true)
    do {
      _ = try await dispatcher.execute(
        try call("proposeArchiveEmail", arguments: ["threadPageID": "invented-thread-id"]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        // Non-empty but deliberately excludes "invented-thread-id": proves the guard
        // checks *membership*, not merely non-emptiness, of eligibleEmailThreadIDs.
        eligibleEmailThreadIDs: ["some-other-thread-returned-by-search"],
        calendarContextEstablishedThisTurn: false, retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected candidateNotEligibleThisTurn")
    } catch AssistantModelToolError.candidateNotEligibleThisTurn {
      // expected
    }
    XCTAssertEqual(transport.archiveThreadCalls.count, 0)
  }

  func testProposeArchiveEmailIsRejectedWhenNotAuthorized() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    do {
      _ = try await dispatcher.execute(
        try call("proposeArchiveEmail", arguments: ["threadPageID": eligibleThreadPageID]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: .none)  // allowArchiveEmail defaults false
      XCTFail("expected toolNotAuthorizedThisTurn")
    } catch AssistantModelToolError.toolNotAuthorizedThisTurn {
      // expected
    }
    XCTAssertEqual(transport.archiveThreadCalls.count, 0)
  }

  func testProposeArchiveEmailIsUnavailableWithNoTransportEvenIfAuthorized() async throws {
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore())  // no remoteWriteTransport
    let authorization = AssistantTurnWriteAuthorization(allowArchiveEmail: true)
    do {
      _ = try await dispatcher.execute(
        try call("proposeArchiveEmail", arguments: ["threadPageID": eligibleThreadPageID]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected toolNotAuthorizedThisTurn")
    } catch AssistantModelToolError.toolNotAuthorizedThisTurn {
      // expected
    }
  }

  func testProposeApplyLabelCallsApplyLabelWhenEligible() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowApplyLabel: true)

    let result = try await dispatcher.execute(
      try call("proposeApplyLabel", arguments: ["threadPageID": eligibleThreadPageID, "label": "IMPORTANT"]),
      now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
      eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
      retrievalAuthorization: .none, writeAuthorization: authorization)

    guard case .writeProposed(_, let output) = result else { return XCTFail("expected a write proposal") }
    XCTAssertTrue(output.summary.contains("IMPORTANT"))
    XCTAssertNotNil(output.remoteApproval)
    XCTAssertEqual(transport.applyLabelCalls.count, 1)
    XCTAssertEqual(transport.applyLabelCalls.first?.threadPageID, eligibleThreadPageID)
    XCTAssertEqual(transport.applyLabelCalls.first?.label, "IMPORTANT")
  }

  func testProposeApplyLabelRejectsAThreadPageIDNotReturnedBySearchEmailThreadsThisTurn() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowApplyLabel: true)
    do {
      _ = try await dispatcher.execute(
        try call("proposeApplyLabel", arguments: ["threadPageID": "invented-thread-id", "label": "IMPORTANT"]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        // Non-empty but deliberately excludes "invented-thread-id": proves the guard
        // checks *membership*, not merely non-emptiness, of eligibleEmailThreadIDs.
        eligibleEmailThreadIDs: ["some-other-thread-returned-by-search"], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected candidateNotEligibleThisTurn")
    } catch AssistantModelToolError.candidateNotEligibleThisTurn {
      // expected
    }
    XCTAssertEqual(transport.applyLabelCalls.count, 0)
  }

  func testProposeApplyLabelIsRejectedWhenNotAuthorized() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    do {
      _ = try await dispatcher.execute(
        try call("proposeApplyLabel", arguments: ["threadPageID": eligibleThreadPageID, "label": "IMPORTANT"]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: .none)
      XCTFail("expected toolNotAuthorizedThisTurn")
    } catch AssistantModelToolError.toolNotAuthorizedThisTurn {
      // expected
    }
    XCTAssertEqual(transport.applyLabelCalls.count, 0)
  }

  func testProposeApplyLabelIsUnavailableWithNoTransportEvenIfAuthorized() async throws {
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore())  // no remoteWriteTransport
    let authorization = AssistantTurnWriteAuthorization(allowApplyLabel: true)
    do {
      _ = try await dispatcher.execute(
        try call("proposeApplyLabel", arguments: ["threadPageID": eligibleThreadPageID, "label": "IMPORTANT"]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected toolNotAuthorizedThisTurn")
    } catch AssistantModelToolError.toolNotAuthorizedThisTurn {
      // expected
    }
  }

  func testProposeRemoveLabelCallsRemoveLabelWhenEligible() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowRemoveLabel: true)

    let result = try await dispatcher.execute(
      try call("proposeRemoveLabel", arguments: ["threadPageID": eligibleThreadPageID, "label": "STARRED"]),
      now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
      eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
      retrievalAuthorization: .none, writeAuthorization: authorization)

    guard case .writeProposed(_, let output) = result else { return XCTFail("expected a write proposal") }
    XCTAssertTrue(output.summary.contains("STARRED"))
    XCTAssertNotNil(output.remoteApproval)
    XCTAssertEqual(transport.removeLabelCalls.count, 1)
    XCTAssertEqual(transport.removeLabelCalls.first?.threadPageID, eligibleThreadPageID)
    XCTAssertEqual(transport.removeLabelCalls.first?.label, "STARRED")
  }

  func testProposeRemoveLabelRejectsAThreadPageIDNotReturnedBySearchEmailThreadsThisTurn() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowRemoveLabel: true)
    do {
      _ = try await dispatcher.execute(
        try call("proposeRemoveLabel", arguments: ["threadPageID": "invented-thread-id", "label": "STARRED"]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        // Non-empty but deliberately excludes "invented-thread-id": proves the guard
        // checks *membership*, not merely non-emptiness, of eligibleEmailThreadIDs.
        eligibleEmailThreadIDs: ["some-other-thread-returned-by-search"], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected candidateNotEligibleThisTurn")
    } catch AssistantModelToolError.candidateNotEligibleThisTurn {
      // expected
    }
    XCTAssertEqual(transport.removeLabelCalls.count, 0)
  }

  func testProposeRemoveLabelIsRejectedWhenNotAuthorized() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    do {
      _ = try await dispatcher.execute(
        try call("proposeRemoveLabel", arguments: ["threadPageID": eligibleThreadPageID, "label": "STARRED"]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: .none)
      XCTFail("expected toolNotAuthorizedThisTurn")
    } catch AssistantModelToolError.toolNotAuthorizedThisTurn {
      // expected
    }
    XCTAssertEqual(transport.removeLabelCalls.count, 0)
  }

  func testProposeRemoveLabelIsUnavailableWithNoTransportEvenIfAuthorized() async throws {
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore())  // no remoteWriteTransport
    let authorization = AssistantTurnWriteAuthorization(allowRemoveLabel: true)
    do {
      _ = try await dispatcher.execute(
        try call("proposeRemoveLabel", arguments: ["threadPageID": eligibleThreadPageID, "label": "STARRED"]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected toolNotAuthorizedThisTurn")
    } catch AssistantModelToolError.toolNotAuthorizedThisTurn {
      // expected
    }
  }

  func testProposeMarkReadCallsMarkReadWhenEligible() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowMarkRead: true)

    let result = try await dispatcher.execute(
      try call("proposeMarkRead", arguments: ["threadPageID": eligibleThreadPageID]),
      now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
      eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
      retrievalAuthorization: .none, writeAuthorization: authorization)

    guard case .writeProposed(_, let output) = result else { return XCTFail("expected a write proposal") }
    XCTAssertNotNil(output.remoteApproval)
    XCTAssertEqual(transport.markReadCalls.count, 1)
    XCTAssertEqual(transport.markReadCalls.first?.threadPageID, eligibleThreadPageID)
  }

  func testProposeMarkReadRejectsAThreadPageIDNotReturnedBySearchEmailThreadsThisTurn() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowMarkRead: true)
    do {
      _ = try await dispatcher.execute(
        try call("proposeMarkRead", arguments: ["threadPageID": "invented-thread-id"]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        // Non-empty but deliberately excludes "invented-thread-id": proves the guard
        // checks *membership*, not merely non-emptiness, of eligibleEmailThreadIDs.
        eligibleEmailThreadIDs: ["some-other-thread-returned-by-search"], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected candidateNotEligibleThisTurn")
    } catch AssistantModelToolError.candidateNotEligibleThisTurn {
      // expected
    }
    XCTAssertEqual(transport.markReadCalls.count, 0)
  }

  func testProposeMarkReadIsRejectedWhenNotAuthorized() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    do {
      _ = try await dispatcher.execute(
        try call("proposeMarkRead", arguments: ["threadPageID": eligibleThreadPageID]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: .none)
      XCTFail("expected toolNotAuthorizedThisTurn")
    } catch AssistantModelToolError.toolNotAuthorizedThisTurn {
      // expected
    }
    XCTAssertEqual(transport.markReadCalls.count, 0)
  }

  func testProposeMarkReadIsUnavailableWithNoTransportEvenIfAuthorized() async throws {
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore())  // no remoteWriteTransport
    let authorization = AssistantTurnWriteAuthorization(allowMarkRead: true)
    do {
      _ = try await dispatcher.execute(
        try call("proposeMarkRead", arguments: ["threadPageID": eligibleThreadPageID]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected toolNotAuthorizedThisTurn")
    } catch AssistantModelToolError.toolNotAuthorizedThisTurn {
      // expected
    }
  }

  func testProposeMarkUnreadCallsMarkUnreadWhenEligible() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowMarkUnread: true)

    let result = try await dispatcher.execute(
      try call("proposeMarkUnread", arguments: ["threadPageID": eligibleThreadPageID]),
      now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
      eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
      retrievalAuthorization: .none, writeAuthorization: authorization)

    guard case .writeProposed(_, let output) = result else { return XCTFail("expected a write proposal") }
    XCTAssertNotNil(output.remoteApproval)
    XCTAssertEqual(transport.markUnreadCalls.count, 1)
    XCTAssertEqual(transport.markUnreadCalls.first?.threadPageID, eligibleThreadPageID)
  }

  func testProposeMarkUnreadRejectsAThreadPageIDNotReturnedBySearchEmailThreadsThisTurn() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    let authorization = AssistantTurnWriteAuthorization(allowMarkUnread: true)
    do {
      _ = try await dispatcher.execute(
        try call("proposeMarkUnread", arguments: ["threadPageID": "invented-thread-id"]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        // Non-empty but deliberately excludes "invented-thread-id": proves the guard
        // checks *membership*, not merely non-emptiness, of eligibleEmailThreadIDs.
        eligibleEmailThreadIDs: ["some-other-thread-returned-by-search"], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected candidateNotEligibleThisTurn")
    } catch AssistantModelToolError.candidateNotEligibleThisTurn {
      // expected
    }
    XCTAssertEqual(transport.markUnreadCalls.count, 0)
  }

  func testProposeMarkUnreadIsRejectedWhenNotAuthorized() async throws {
    let transport = FakeRemoteWriteTransport()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), remoteWriteTransport: transport)
    do {
      _ = try await dispatcher.execute(
        try call("proposeMarkUnread", arguments: ["threadPageID": eligibleThreadPageID]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: .none)
      XCTFail("expected toolNotAuthorizedThisTurn")
    } catch AssistantModelToolError.toolNotAuthorizedThisTurn {
      // expected
    }
    XCTAssertEqual(transport.markUnreadCalls.count, 0)
  }

  func testProposeMarkUnreadIsUnavailableWithNoTransportEvenIfAuthorized() async throws {
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore())  // no remoteWriteTransport
    let authorization = AssistantTurnWriteAuthorization(allowMarkUnread: true)
    do {
      _ = try await dispatcher.execute(
        try call("proposeMarkUnread", arguments: ["threadPageID": eligibleThreadPageID]),
        now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [],
        eligibleEmailThreadIDs: [eligibleThreadPageID], calendarContextEstablishedThisTurn: false,
        retrievalAuthorization: .none, writeAuthorization: authorization)
      XCTFail("expected toolNotAuthorizedThisTurn")
    } catch AssistantModelToolError.toolNotAuthorizedThisTurn {
      // expected
    }
  }

  // MARK: - THE critical wiring-correctness property

  func testDispatcherNeverAutoConfirmsAWriteProposalItRecords() async throws {
    let ledger = AssistantTaskMutationProposalLedger()
    let dispatcher = AssistantLocalToolDispatcher(store: try makeStore(), writeProposalRecorder: ledger.proposalRecorder)
    let authorization = AssistantTurnWriteAuthorization(allowTaskCreate: true)

    let result = try await dispatcher.execute(
      try call(
        "proposeTaskCreate", callID: "call_never_confirmed",
        arguments: ["title": "Buy milk", "notes": NSNull(), "priority": NSNull(), "placement": NSNull(), "estimatedMinutes": NSNull()]),
      now: Date(), eligibleCalendarSourceIDs: [], eligibleTaskPageIDs: [], eligibleEmailThreadIDs: [], calendarContextEstablishedThisTurn: false,
      retrievalAuthorization: .none, writeAuthorization: authorization)
    guard case .writeProposed(let callID, _) = result else { return XCTFail("expected a write proposal") }

    // The dispatcher had every opportunity to also confirm this proposal in
    // the same call — it must not have. Only an explicit, separate call to
    // the WIDE reviewer facade (never reachable from the dispatcher itself
    // — see this file's header) can ever move this state forward.
    let state = await ledger.proposalReviewer.state(for: callID)
    XCTAssertEqual(
      state, .awaitingNativeConfirmation,
      "a write tool call must only ever RECORD a proposal, never confirm it — if this is anything "
        + "other than .awaitingNativeConfirmation, the dispatcher has a reachable self-confirm path")
  }

  /// Compile-time proof, matching #67's own established pattern
  /// (`AssistantWriteToolsTests.testProposalRecorderCannotBeTreatedAsAConfirmer`):
  /// the WIDE reviewer/review-transport facades this dispatcher is
  /// constructed WITHOUT do not themselves satisfy the NARROW protocols its
  /// `init` actually accepts — so there is no value a future caller could
  /// pass to `writeProposalRecorder`/`remoteWriteTransport` that would
  /// smuggle a confirm/reject/confirmApproval path in. The dispatcher's own
  /// `init` parameter types (`(any AssistantWriteProposalSubmitting)?`,
  /// `(any AssistantRemoteWriteTransport)?`) are themselves the compiler
  /// enforcement — this test documents and exercises WHY that enforcement
  /// holds, by showing the wide types genuinely never satisfy the narrow
  /// ones.
  func testWriteFacadesCannotBeSwappedForReviewerShapedValues() {
    let ledger = AssistantTaskMutationProposalLedger()
    let reviewer: any AssistantWriteProposalConfirming = ledger.proposalReviewer
    XCTAssertNil(
      reviewer as? any AssistantWriteProposalSubmitting,
      "AssistantWriteProposalReviewer must never satisfy AssistantWriteProposalSubmitting — if this "
        + "fails, `AssistantLocalToolDispatcher(writeProposalRecorder:)` could be constructed with a "
        + "reviewer, giving the tool-dispatch path a reachable confirm/reject/consumeConfirmed route.")

    let reviewClient: any AssistantRemoteWriteReviewTransport = AssistantRemoteWriteReviewClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: URL(string: "https://example.invalid")!),
      credential: { AssistantRemoteWriteCredential(clientId: "id", clientSecret: "secret") })
    XCTAssertNil(
      reviewClient as? any AssistantRemoteWriteTransport,
      "AssistantRemoteWriteReviewClient must never satisfy AssistantRemoteWriteTransport — if this "
        + "fails, `AssistantLocalToolDispatcher(remoteWriteTransport:)` could be constructed with a "
        + "review client, giving the tool-dispatch path a reachable confirmApproval route.")
  }
}
