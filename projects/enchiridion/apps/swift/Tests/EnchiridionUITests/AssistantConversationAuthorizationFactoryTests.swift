// AssistantConversationAuthorizationFactoryTests.swift
// EnchiridionUITests
//
// Task #85 (P7 integration wave). Real coverage for
// `AssistantConversationAuthorizationFactory` — the utterance-driven
// pre-flight authorization factory that makes the interactive assistant
// screen's retrieval tools reachable at all (see that file's header for
// the full design rationale). Against a REAL temporary `LocalGraphStore`,
// same fixture-writing convention `DayAgendaLoaderTests.swift`/
// `AssistantReadToolsTests.swift` already established — nothing mocked.

import EnchiridionCore
import EnchiridionSchema
import EnchiridionStore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionUI

final class AssistantConversationAuthorizationFactoryTests: XCTestCase {
  private func makeStore() throws -> LocalGraphStore {
    try LocalGraphStore.openTemporary()
  }

  // MARK: - Empty/whitespace utterance -> no authorized tools

  func testEmptyUtteranceAuthorizesNoRetrievalTools() throws {
    let store = try makeStore()
    let authorization = AssistantConversationAuthorizationFactory.retrievalAuthorization(
      store: store, utterance: "   ")
    XCTAssertNil(authorization.pageSearch)
    XCTAssertNil(authorization.taskSearch)
    XCTAssertNil(authorization.calendarSearch)
    XCTAssertNil(authorization.meetingBrief)
    XCTAssertNil(
      authorization.emailSearch, "emailSearch is gated on a non-empty approved query, same as pageSearch/taskSearch")
    XCTAssertTrue(authorization.allowedTools.isEmpty)
  }

  // MARK: - Real utterance -> pre-approved query vocabulary derived from it

  func testNonEmptyUtteranceAuthorizesPageTaskAndCalendarSearchWithItsOwnWordsApproved() throws {
    let store = try makeStore()
    let authorization = AssistantConversationAuthorizationFactory.retrievalAuthorization(
      store: store, utterance: "find my budget notes")

    let pageSearch = try XCTUnwrap(authorization.pageSearch)
    XCTAssertTrue(pageSearch.query.permits("budget"))
    XCTAssertTrue(pageSearch.query.permits("notes"))
    XCTAssertTrue(pageSearch.query.permits("find my budget notes"))
    XCTAssertFalse(
      pageSearch.query.permits("anything the model invents"),
      "only words that were actually in the utterance may be approved")

    let taskSearch = try XCTUnwrap(authorization.taskSearch)
    XCTAssertEqual(taskSearch.scope, .all)
    XCTAssertTrue(taskSearch.query.permits("budget"))

    let calendarSearch = try XCTUnwrap(authorization.calendarSearch)
    XCTAssertTrue(calendarSearch.includeOngoing)
    XCTAssertGreaterThan(calendarSearch.end, calendarSearch.start)
    XCTAssertLessThanOrEqual(
      calendarSearch.end.timeIntervalSince(calendarSearch.start), AssistantRetrievalLimits.maximumCalendarDays)

    // task #96: emailSearch is now authorized the same way pageSearch/
    // taskSearch already were — see this factory's header.
    let emailSearch = try XCTUnwrap(authorization.emailSearch)
    XCTAssertTrue(emailSearch.query.permits("budget"))
  }

  // MARK: - meetingBrief: only authorized when this turn's own calendar window has a real event

  func testMeetingBriefIsNotAuthorizedWhenTheCalendarWindowHasNoEvents() throws {
    let store = try makeStore()
    let authorization = AssistantConversationAuthorizationFactory.retrievalAuthorization(
      store: store, utterance: "what's my next meeting")
    XCTAssertNil(authorization.meetingBrief)
  }

  func testMeetingBriefIsAuthorizedAndSeededFromARealEventInThisTurnsCalendarWindow() async throws {
    let store = try makeStore()
    let now = Date()
    let eventID = PageID.free()
    try await store.writeProjection(
      pageID: eventID, kind: .calendarMaterializedEvent(.init(uidDigest: "sync", occurrenceToken: "1")),
      createdAt: now, modifiedAt: now,
      projection: .init(
        title: "Roadmap sync", plainText: "Roadmap sync", deletedAt: nil, isPinned: false, references: [],
        graphEdges: [],
        objectMetadata: .init(
          supertagIDs: [CoreEventFieldIDs.supertagID],
          properties: [
            .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.start): [
              .dateTime(now.addingTimeInterval(3600))
            ],
            .init(supertagID: CoreEventFieldIDs.supertagID, fieldID: CoreEventFieldIDs.end): [
              .dateTime(now.addingTimeInterval(7200))
            ],
          ])))

    let authorization = AssistantConversationAuthorizationFactory.retrievalAuthorization(
      store: store, utterance: "what's my next meeting", now: now)

    let meetingBrief = try XCTUnwrap(authorization.meetingBrief)
    let expectedSourceID = "calendar:" + Data(eventID.rawValue.utf8).base64EncodedString()
    XCTAssertTrue(meetingBrief.allowedSourceIDs.contains(expectedSourceID))
  }

  // MARK: - Write authorization

  /// task #96 (plan §Live Backend Connectivity (P8) scope item 3): local
  /// task create plus every remote write tool are now authorized —
  /// `proposeTaskUpdate`/`proposeTaskComplete` remain the only ones still
  /// off (no production `AssistantTaskSnapshotProviding` — see
  /// `AssistantSceneAssembly.swift`'s header).
  func testWriteAuthorizationAllowsLocalTaskCreateAndEveryRemoteWriteTool() {
    let authorization = AssistantConversationAuthorizationFactory.writeAuthorization
    XCTAssertEqual(
      Set(authorization.allowedTools),
      [
        .proposeTaskCreate,
        .proposeCreateEvent,
        .proposeRsvp,
        .proposeSendEmail,
        .proposeArchiveEmail,
        .proposeApplyLabel,
        .proposeRemoveLabel,
        .proposeMarkRead,
        .proposeMarkUnread,
      ])
    XCTAssertFalse(authorization.allowedTools.contains(.proposeTaskUpdate))
    XCTAssertFalse(authorization.allowedTools.contains(.proposeTaskComplete))
  }
}
