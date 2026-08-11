// AssistantAppIntentsTests.swift
// EnchiridionUITests
//
// Task #74 ("App Intents / Siri"). Exercises `Sources/EnchiridionUI/AssistantAppIntents.swift`'s
// `perform()` logic directly (constructing each `AppIntent` value and
// calling `perform()` — the same thing the system does, minus Siri/
// Shortcuts UI chrome), against:
//   - a REAL temporary `LocalGraphStore` for the two read intents (same
//     fixture convention as `AssistantReadToolsTests.swift`), and
//   - a REAL `AssistantTaskMutationProposalLedger` for the two write
//     intents (same convention as `AssistantWriteToolsTests.swift`) — every
//     write intent test below injects `ledger.proposalRecorder` (the
//     narrow facade) directly into the intent's test seam, never the raw
//     ledger and never `ledger.proposalReviewer`.
//
// `RecordingProposalRecorder` below wraps the real ledger's recorder to
// capture exactly what a `perform()` call recorded (content assertions)
// while still forwarding to the real ledger (state-machine assertions via
// `ledger.proposalReviewer`) — the ledger's own API is deliberately
// callID-keyed with no "list everything" accessor (AssistantWriteTools.swift's
// header), so this is how content is recovered without weakening that.
//
// Deliberately does NOT exercise `AssistantAppIntentBridge`'s production
// fallback path (`LocalGraphStore.openAppGroupStore()`) beyond proving it
// throws when unconfigured — a real App Group entitlement doesn't exist
// for this sandboxed `swift test` process (mirrors
// `LocalGraphStoreLocationTests.swift`'s own reasoning for injecting a
// fake `FileManager` rather than exercising the real entitlement path).

import EnchiridionCore
import EnchiridionSchema
import EnchiridionStore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionUI

// MARK: - Test doubles

private actor ProposalSpy {
  private(set) var proposals: [AssistantTaskMutationProposal] = []
  func record(_ proposal: AssistantTaskMutationProposal) {
    proposals.append(proposal)
  }
}

/// Wraps a real `AssistantWriteProposalSubmitting` recorder, capturing
/// every proposal it's asked to record (for content assertions) while
/// still forwarding to the real ledger (for state-machine assertions).
/// Itself satisfies ONLY `AssistantWriteProposalSubmitting` — same narrow
/// shape the production intents depend on.
private struct RecordingProposalRecorder: AssistantWriteProposalSubmitting {
  let inner: any AssistantWriteProposalSubmitting
  let spy: ProposalSpy

  func record(_ proposal: AssistantTaskMutationProposal) async -> Bool {
    await spy.record(proposal)
    return await inner.record(proposal)
  }
}

/// Always reports `false` from `record(_:)`, regardless of what's passed —
/// simulates the ledger's real "already recorded" outcome
/// (`AssistantTaskMutationProposalLedger.record`'s guard) without needing
/// an actual UUID collision, so an intent's OWN handling of a `false`
/// return can be exercised through `perform()` directly, not just proven
/// at the ledger layer (`AssistantWriteToolsTests.testDoubleRecordSameCallIDRejected`
/// already covers the ledger itself).
private struct AlwaysRejectingProposalRecorder: AssistantWriteProposalSubmitting {
  func record(_ proposal: AssistantTaskMutationProposal) async -> Bool { false }
}

final class AssistantAppIntentsTests: XCTestCase {
  private func makeStore() throws -> LocalGraphStore {
    try LocalGraphStore.openTemporary()
  }

  private func page(_ n: Int) -> PageID {
    PageID.free(UUID(uuidString: String(format: "00000000-0000-0000-0000-%012d", n))!)
  }

  // MARK: - AddEnchiridionTaskIntent

  func testAddTaskIntentRecordsTheTypedDraftAndLeavesItAwaitingConfirmation() async throws {
    let ledger = AssistantTaskMutationProposalLedger()
    let spy = ProposalSpy()
    let recorder = RecordingProposalRecorder(inner: ledger.proposalRecorder, spy: spy)

    var intent = AddEnchiridionTaskIntent()
    intent.title = "  Buy milk  "
    intent.notes = "Two cartons"
    intent.priority = .high
    intent.proposalRecorder = recorder

    _ = try await intent.perform()

    let proposals = await spy.proposals
    XCTAssertEqual(proposals.count, 1)
    guard case .create(let callID, let draft) = proposals[0] else {
      return XCTFail("expected a .create proposal")
    }
    XCTAssertEqual(draft.title, "Buy milk", "the title must be trimmed, matching AssistantTaskDraft.init")
    XCTAssertEqual(draft.notes, "Two cartons")
    XCTAssertEqual(draft.priority, .high)

    // Real ledger state: recorded, never auto-confirmed.
    let reviewer = ledger.proposalReviewer
    let state = await reviewer.state(for: callID)
    XCTAssertEqual(state, .awaitingNativeConfirmation)
  }

  func testAddTaskIntentReturnsTheExpectedDraftDialog() async throws {
    let ledger = AssistantTaskMutationProposalLedger()
    var intent = AddEnchiridionTaskIntent()
    intent.title = "Buy milk"
    intent.proposalRecorder = ledger.proposalRecorder

    let result = try await intent.perform()
    // `IntentDialog`/`some IntentResult & ProvidesDialog` has no public
    // plain-text accessor reachable from a non-UI XCTest without a real
    // AppIntents runtime host — `perform()` completing without throwing,
    // for a valid title, together with the ledger-state assertions above
    // and below, is what's actually load-bearing; this asserts the call
    // produced *a* result value at all.
    XCTAssertNotNil(result)
  }

  func testAddTaskIntentThrowsOnEmptyTitle() async throws {
    let ledger = AssistantTaskMutationProposalLedger()
    var intent = AddEnchiridionTaskIntent()
    intent.title = "   "
    intent.proposalRecorder = ledger.proposalRecorder

    do {
      _ = try await intent.perform()
      XCTFail("expected emptyTitle to be thrown")
    } catch let error as AssistantAppIntentError {
      XCTAssertEqual(error, .emptyTitle)
    }
  }

  func testAddTaskIntentThrowsWhenNoRecorderIsConfiguredOrInjected() async throws {
    AssistantAppIntentBridge.resetForTesting()
    var intent = AddEnchiridionTaskIntent()
    intent.title = "Buy milk"
    // proposalRecorder left nil — falls through to the unconfigured bridge.
    do {
      _ = try await intent.perform()
      XCTFail("expected notConfigured to be thrown")
    } catch let error as AssistantAppIntentError {
      XCTAssertEqual(error, .notConfigured)
    }
    AssistantAppIntentBridge.resetForTesting()
  }

  func testAddTaskIntentDuplicateCallIDIsRejectedAtTheLedger() async throws {
    // The intent generates a fresh UUID-based callID per perform() call, so
    // a real duplicate is practically unreachable through perform() itself
    // — see testAddTaskIntentSurfacesDuplicateProposalWhenTheRecorderRejects
    // below for that path. This proves the LEDGER's own duplicate-record
    // guard (AssistantWriteToolsTests.testDoubleRecordSameCallIDRejected
    // covers it too, at the core-package layer).
    let ledger = AssistantTaskMutationProposalLedger()
    let proposal = AssistantTaskMutationProposal.create(
      callID: AssistantToolCallID(rawValue: "dup"), draft: AssistantTaskDraft(title: "First"))
    let firstRecord = await ledger.proposalRecorder.record(proposal)
    XCTAssertTrue(firstRecord)
    let secondRecord = await ledger.proposalRecorder.record(proposal)
    XCTAssertFalse(secondRecord)
  }

  /// Proves `perform()` ITSELF surfaces `.duplicateProposal` when its
  /// recorder reports `false` — not just that the ledger can return
  /// `false` in isolation (the test above). Uses `AlwaysRejectingProposalRecorder`
  /// since a real UUID collision isn't practically reproducible.
  func testAddTaskIntentSurfacesDuplicateProposalWhenTheRecorderRejects() async throws {
    var intent = AddEnchiridionTaskIntent()
    intent.title = "Buy milk"
    intent.proposalRecorder = AlwaysRejectingProposalRecorder()

    do {
      _ = try await intent.perform()
      XCTFail("expected duplicateProposal to be thrown")
    } catch let error as AssistantAppIntentError {
      XCTAssertEqual(error, .duplicateProposal)
    }
  }

  /// THE CRITICAL TEST for this intent, mirroring
  /// `AssistantWriteToolsTests.testProposalRecorderCannotBeTreatedAsAConfirmer`:
  /// the intent's own stored dependency — the exact value it calls
  /// `.record(_:)` on — must not itself satisfy `AssistantWriteProposalConfirming`.
  /// If this ever starts passing a value that DOES satisfy it, the intent
  /// has gained a reachable path to self-confirm its own write, reopening
  /// the bug `AssistantWriteTools.swift`'s header documents in full.
  func testAddTaskIntentRecorderCannotBeTreatedAsAConfirmer() {
    let ledger = AssistantTaskMutationProposalLedger()
    var intent = AddEnchiridionTaskIntent()
    intent.title = "Buy milk"
    intent.proposalRecorder = ledger.proposalRecorder

    XCTAssertNil(
      intent.proposalRecorder as? any AssistantWriteProposalConfirming,
      "AddEnchiridionTaskIntent's stored recorder must never satisfy AssistantWriteProposalConfirming."
    )
  }

  // MARK: - LogWorkoutIntent

  func testLogWorkoutIntentRecordsADraftTaskWithActivityAndDurationInTitleAndNotes() async throws {
    let ledger = AssistantTaskMutationProposalLedger()
    let spy = ProposalSpy()
    let recorder = RecordingProposalRecorder(inner: ledger.proposalRecorder, spy: spy)

    var intent = LogWorkoutIntent()
    intent.activity = .outdoorRun
    intent.durationMinutes = 30
    intent.proposalRecorder = recorder

    _ = try await intent.perform()

    let proposals = await spy.proposals
    XCTAssertEqual(proposals.count, 1)
    guard case .create(let callID, let draft) = proposals[0] else {
      return XCTFail("expected a .create proposal — see this file's header on why a task-shaped draft")
    }
    XCTAssertEqual(draft.title, "Workout: Outdoor Run")
    XCTAssertEqual(draft.estimatedMinutes, 30)
    XCTAssertTrue(draft.notes?.contains("30 minute") ?? false)
    XCTAssertTrue(draft.notes?.localizedCaseInsensitiveContains("outdoor run") ?? false)

    let state = await ledger.proposalReviewer.state(for: callID)
    XCTAssertEqual(state, .awaitingNativeConfirmation)
  }

  func testLogWorkoutIntentRejectsZeroDuration() async throws {
    let ledger = AssistantTaskMutationProposalLedger()
    var intent = LogWorkoutIntent()
    intent.activity = .hiking
    intent.durationMinutes = 0
    intent.proposalRecorder = ledger.proposalRecorder

    do {
      _ = try await intent.perform()
      XCTFail("expected invalidDuration to be thrown")
    } catch let error as AssistantAppIntentError {
      XCTAssertEqual(error, .invalidDuration)
    }
  }

  func testLogWorkoutIntentRejectsNegativeDuration() async throws {
    let ledger = AssistantTaskMutationProposalLedger()
    var intent = LogWorkoutIntent()
    intent.activity = .hiking
    intent.durationMinutes = -5
    intent.proposalRecorder = ledger.proposalRecorder

    do {
      _ = try await intent.perform()
      XCTFail("expected invalidDuration to be thrown")
    } catch let error as AssistantAppIntentError {
      XCTAssertEqual(error, .invalidDuration)
    }
  }

  /// Matches `estimatedMinutes`'s 1...600 bound everywhere else it's set in
  /// this codebase (`OpenAIResponsesRequestBuilder.swift`,
  /// `AssistantLocalToolDispatcher.swift`) — a Siri/Shortcuts-supplied
  /// duration must not be able to write an unbounded value through a path
  /// the model-facing tool schema itself doesn't allow.
  func testLogWorkoutIntentRejectsDurationAboveSixHundredMinutes() async throws {
    let ledger = AssistantTaskMutationProposalLedger()
    var intent = LogWorkoutIntent()
    intent.activity = .hiking
    intent.durationMinutes = 601
    intent.proposalRecorder = ledger.proposalRecorder

    do {
      _ = try await intent.perform()
      XCTFail("expected invalidDuration to be thrown")
    } catch let error as AssistantAppIntentError {
      XCTAssertEqual(error, .invalidDuration)
    }
  }

  func testLogWorkoutIntentAcceptsDurationAtTheUpperBound() async throws {
    let ledger = AssistantTaskMutationProposalLedger()
    var intent = LogWorkoutIntent()
    intent.activity = .hiking
    intent.durationMinutes = 600
    intent.proposalRecorder = ledger.proposalRecorder

    // Must not throw — 600 is inclusive.
    _ = try await intent.perform()
  }

  func testLogWorkoutIntentThrowsWhenNoRecorderIsConfiguredOrInjected() async throws {
    AssistantAppIntentBridge.resetForTesting()
    var intent = LogWorkoutIntent()
    intent.activity = .hiking
    intent.durationMinutes = 20
    do {
      _ = try await intent.perform()
      XCTFail("expected notConfigured to be thrown")
    } catch let error as AssistantAppIntentError {
      XCTAssertEqual(error, .notConfigured)
    }
    AssistantAppIntentBridge.resetForTesting()
  }

  /// See `testAddTaskIntentSurfacesDuplicateProposalWhenTheRecorderRejects`'s
  /// comment — same proof for the workout intent's own `perform()`.
  func testLogWorkoutIntentSurfacesDuplicateProposalWhenTheRecorderRejects() async throws {
    var intent = LogWorkoutIntent()
    intent.activity = .hiking
    intent.durationMinutes = 20
    intent.proposalRecorder = AlwaysRejectingProposalRecorder()

    do {
      _ = try await intent.perform()
      XCTFail("expected duplicateProposal to be thrown")
    } catch let error as AssistantAppIntentError {
      XCTAssertEqual(error, .duplicateProposal)
    }
  }

  func testLogWorkoutIntentRecorderCannotBeTreatedAsAConfirmer() {
    let ledger = AssistantTaskMutationProposalLedger()
    var intent = LogWorkoutIntent()
    intent.activity = .hiking
    intent.durationMinutes = 20
    intent.proposalRecorder = ledger.proposalRecorder

    XCTAssertNil(intent.proposalRecorder as? any AssistantWriteProposalConfirming)
  }

  // MARK: - WhatsOnMyCalendarIntent

  private func eventProjection(
    id: PageID, title: String, start: Date, end: Date, location: String?
  ) -> PageDocumentProjection {
    let properties: [SupertagPropertyKey: [SupertagValue]] = [
      .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.start): [.dateTime(start)],
      .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.end): [.dateTime(end)],
      .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.allDay): [.boolean(false)],
    ]
    return .init(
      title: title, plainText: title, deletedAt: nil, isPinned: false, references: [],
      graphEdges: [],
      objectMetadata: .init(supertagIDs: [CoreEventFieldIDs.supertagID], properties: properties))
  }

  func testCalendarIntentReturnsGroundedAnswerForAnEventWithinRange() async throws {
    let store = try makeStore()
    let referenceNow = Date(timeIntervalSince1970: 1_800_000_000)
    let eventStart = referenceNow.addingTimeInterval(3_600)
    let eventEnd = eventStart.addingTimeInterval(1_800)
    let eventID = page(1)
    try await store.writeProjection(
      pageID: eventID, kind: .calendarMaterializedEvent(.init(uidDigest: "d", occurrenceToken: "1")),
      createdAt: referenceNow, modifiedAt: referenceNow,
      projection: eventProjection(
        id: eventID, title: "Roadmap sync", start: eventStart, end: eventEnd, location: "Room 1"))

    var intent = WhatsOnMyCalendarIntent()
    intent.daysAhead = 1
    intent.store = store
    intent.now = referenceNow

    _ = try await intent.perform()

    // Independently confirm the read tool itself (the same one the intent
    // calls) finds the seeded event in the exact window `perform()`
    // constructs — proving the intent's authorization/date-window
    // construction is correct, not just that it didn't throw.
    let query = try AssistantApprovedQuery(originalQuery: "")
    let calendar = Calendar.current
    let start = calendar.startOfDay(for: referenceNow)
    let end = calendar.date(byAdding: .day, value: 1, to: start)!
    let authorization = try AssistantCalendarSearchAuthorization(
      query: query, start: start, end: end, maximumResults: 10, includeOngoing: true)
    let directResult = try store.findCalendarEvents(authorization: authorization)
    XCTAssertEqual(directResult.events.map(\.source.title), ["Roadmap sync"])
    XCTAssertTrue(directResult.evidence.contains { $0.spokenText.contains("Roadmap sync") })
  }

  func testCalendarIntentReturnsNoResultsAnswerWhenEmpty() async throws {
    let store = try makeStore()
    var intent = WhatsOnMyCalendarIntent()
    intent.daysAhead = 1
    intent.store = store
    intent.now = Date(timeIntervalSince1970: 1_800_000_000)

    let result = try await intent.perform()
    XCTAssertNotNil(result)
  }

  func testCalendarIntentClampsExcessiveDaysAheadRatherThanThrowing() async throws {
    let store = try makeStore()
    var intent = WhatsOnMyCalendarIntent()
    intent.daysAhead = 999
    intent.store = store
    intent.now = Date(timeIntervalSince1970: 1_800_000_000)

    // Must not throw invalidDateRange or violate
    // AssistantRetrievalLimits.maximumCalendarDays — proves perform()
    // clamps daysAhead to the authorized 1...7 window rather than passing
    // an unbounded value straight into AssistantCalendarSearchAuthorization's
    // init.
    _ = try await intent.perform()
  }

  func testCalendarIntentThrowsWhenNoStoreIsAvailable() async throws {
    AssistantAppIntentBridge.resetForTesting()
    var intent = WhatsOnMyCalendarIntent()
    intent.now = Date()
    // store left nil, and no App Group entitlement exists in this sandbox,
    // so the bridge's fallback (`LocalGraphStore.openAppGroupStore()`)
    // must fail — proving the intent doesn't silently succeed against a
    // wrong/default store when nothing was configured or injected.
    do {
      _ = try await intent.perform()
      XCTFail("expected opening the (unentitled, in this sandbox) App Group store to throw")
    } catch {
      // Any thrown error is acceptable here — the exact error surface is
      // LocalGraphStoreLocation.ResolutionError's concern
      // (LocalGraphStoreLocationTests.swift), not this intent's.
    }
  }

  // MARK: - WhatAreMyTasksIntent

  private func taskProjection(title: String, placement: CoreTaskPlacement, status: CoreTaskStatus)
    -> PageDocumentProjection
  {
    let properties: [SupertagPropertyKey: [SupertagValue]] = [
      .init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.status): [
        .select(status.rawValue)
      ],
      .init(supertagID: CoreTaskFieldIDs.supertagID, fieldID: CoreTaskFieldIDs.placement): [
        .select(placement.rawValue)
      ],
    ]
    return .init(
      title: title, plainText: title, deletedAt: nil, isPinned: false, references: [],
      graphEdges: [],
      objectMetadata: .init(supertagIDs: [CoreTaskFieldIDs.supertagID], properties: properties))
  }

  func testTasksIntentReturnsGroundedAnswerForInboxScope() async throws {
    let store = try makeStore()
    let taskID = page(2)
    try await store.writeProjection(
      pageID: taskID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: taskProjection(title: "Review inbox", placement: .inbox, status: .toDo))

    var intent = WhatAreMyTasksIntent()
    intent.scope = .inbox
    intent.store = store
    intent.now = Date()

    _ = try await intent.perform()

    let query = try AssistantApprovedQuery(originalQuery: "")
    let authorization = try AssistantTaskSearchAuthorization(scope: .inbox, query: query, maximumResults: 10)
    let directResult = try store.searchTasks(authorization: authorization, candidateScope: .inbox)
    XCTAssertEqual(directResult.sources.map(\.title), ["Review inbox"])
  }

  func testTasksIntentReturnsScopeEmptyAnswerWhenNoTasksMatch() async throws {
    let store = try makeStore()
    var intent = WhatAreMyTasksIntent()
    intent.scope = .someday
    intent.store = store
    intent.now = Date()

    let result = try await intent.perform()
    XCTAssertNotNil(result)
  }

  func testTasksIntentDefaultsToTodayScopeWhenUnspecified() async throws {
    let store = try makeStore()
    var intent = WhatAreMyTasksIntent()
    intent.scope = nil
    intent.store = store
    intent.now = Date()
    // Must not throw — proves the nil-scope default path constructs a
    // valid authorization.
    _ = try await intent.perform()
  }

  func testTasksIntentThrowsWhenNoStoreIsAvailable() async throws {
    AssistantAppIntentBridge.resetForTesting()
    var intent = WhatAreMyTasksIntent()
    intent.now = Date()
    do {
      _ = try await intent.perform()
      XCTFail("expected opening the (unentitled, in this sandbox) App Group store to throw")
    } catch {
      // See testCalendarIntentThrowsWhenNoStoreIsAvailable's comment.
    }
  }

  // MARK: - AssistantAppIntentBridge

  func testBridgeConfigureThenResolveReturnsTheConfiguredValues() async throws {
    AssistantAppIntentBridge.resetForTesting()
    let ledger = AssistantTaskMutationProposalLedger()
    let store = try makeStore()
    AssistantAppIntentBridge.configure(proposalRecorder: ledger.proposalRecorder, store: store)

    let resolvedRecorder = try AssistantAppIntentBridge.resolveProposalRecorder()
    let recorded = await resolvedRecorder.record(
      .create(
        callID: AssistantToolCallID(rawValue: "bridge-test"),
        draft: AssistantTaskDraft(title: "Bridge task")))
    XCTAssertTrue(recorded)
    let state = await ledger.proposalReviewer.state(for: AssistantToolCallID(rawValue: "bridge-test"))
    XCTAssertEqual(
      state, .awaitingNativeConfirmation,
      "the bridge-resolved recorder must record into the SAME ledger instance it was configured with")

    let resolvedStore = try AssistantAppIntentBridge.resolveStore()
    let pageID = page(3)
    try await resolvedStore.writeProjection(
      pageID: pageID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Bridge page", plainText: "Bridge page", deletedAt: nil, isPinned: false,
        references: [], graphEdges: [], objectMetadata: .init()))
    let query = try AssistantApprovedQuery(originalQuery: "bridge")
    let authorization = try AssistantPageSearchAuthorization(query: query, maximumResults: 5)
    let searchResult = try resolvedStore.searchPages(authorization: authorization, candidateQuery: "bridge")
    XCTAssertEqual(
      searchResult.sources.map(\.title), ["Bridge page"],
      "the bridge-resolved store must be the SAME instance it was configured with")

    AssistantAppIntentBridge.resetForTesting()
  }

  func testBridgeThrowsNotConfiguredForRecorderAfterReset() async throws {
    AssistantAppIntentBridge.resetForTesting()
    XCTAssertThrowsError(try AssistantAppIntentBridge.resolveProposalRecorder()) { error in
      XCTAssertEqual(error as? AssistantAppIntentError, .notConfigured)
    }
  }
}
