// AssistantTurnRetrievalAuthorizationTests.swift
// EnchiridionCoreTests
//
// Ported concept from the authorization-adjacent coverage implied by
// `apps/enchiridion/Tests/EnchiridionCoreTests/AssistantCoreTests.swift`
// (e.g. `testCalendarSearchRejectsUnboundedDateRanges`), expanded per task
// #65's explicit instruction to include "a real adversarial-shaped test,
// not just a happy-path one" for
// `AssistantTurnRetrievalAuthorization`/`AssistantApprovedQuery`.
//
// The property under test throughout this file is the one stated in the
// plan's "Assistant (P5)" section: retrieval authorization is pre-flight,
// not tool-argument-trusting. Once an `AssistantTurnRetrievalAuthorization`
// (or any of its per-tool authorization structs) is constructed, nothing
// can widen it — a wider value can only ever be represented by
// constructing a brand new struct, and that construction itself is bounds-
// checked in `init`.

import Foundation
import XCTest

@testable import EnchiridionCore

final class AssistantTurnRetrievalAuthorizationTests: XCTestCase {
  // MARK: - AssistantApprovedQuery

  func testApprovedQueryPermitsOriginalAndExplicitlyApprovedTermsOnly() throws {
    let query = try AssistantApprovedQuery(
      originalQuery: "today", approvedQueryTerms: ["today", "standup"])

    XCTAssertTrue(query.permits("today"))
    XCTAssertTrue(query.permits("standup"))
    XCTAssertFalse(query.permits("standup notes and salary details"))
    XCTAssertFalse(query.permits("unrelated"))
  }

  func testApprovedQueryPermitsNormalizesWhitespaceBeforeComparing() throws {
    let query = try AssistantApprovedQuery(originalQuery: "today")

    XCTAssertTrue(query.permits("  today  "))
    XCTAssertTrue(query.permits("\ntoday\n"))
  }

  func testApprovedQueryConstructionRejectsOverlongOriginalQuery() {
    let overlong = String(repeating: "a", count: AssistantRetrievalLimits.maximumQueryLength + 1)

    XCTAssertThrowsError(try AssistantApprovedQuery(originalQuery: overlong)) { error in
      XCTAssertEqual(
        error as? AssistantTurnRetrievalAuthorizationError, .invalidQuery)
    }
  }

  func testApprovedQueryConstructionRejectsOverlongApprovedTerm() {
    let overlong = String(repeating: "b", count: AssistantRetrievalLimits.maximumQueryLength + 1)

    XCTAssertThrowsError(
      try AssistantApprovedQuery(originalQuery: "ok", approvedQueryTerms: [overlong])
    ) { error in
      XCTAssertEqual(
        error as? AssistantTurnRetrievalAuthorizationError, .invalidQuery)
    }
  }

  // MARK: - AssistantCalendarSearchAuthorization bounds

  func testCalendarSearchAuthorizationRejectsInvertedDateRange() throws {
    let query = try AssistantApprovedQuery(originalQuery: "sync")
    let start = Date(timeIntervalSince1970: 1_900_000_000)

    XCTAssertThrowsError(
      try AssistantCalendarSearchAuthorization(
        query: query, start: start, end: start, maximumResults: 5, includeOngoing: false)
    ) { error in
      XCTAssertEqual(
        error as? AssistantTurnRetrievalAuthorizationError, .invalidDateRange)
    }
  }

  func testCalendarSearchAuthorizationRejectsRangeLargerThanMaximum() throws {
    let query = try AssistantApprovedQuery(originalQuery: "sync")
    let start = Date(timeIntervalSince1970: 1_900_000_000)
    let end = start.addingTimeInterval(AssistantRetrievalLimits.maximumCalendarDays + 1)

    XCTAssertThrowsError(
      try AssistantCalendarSearchAuthorization(
        query: query, start: start, end: end, maximumResults: 5, includeOngoing: false)
    ) { error in
      XCTAssertEqual(
        error as? AssistantTurnRetrievalAuthorizationError, .invalidDateRange)
    }
  }

  func testCalendarSearchAuthorizationAcceptsExactlyMaximumRange() throws {
    let query = try AssistantApprovedQuery(originalQuery: "sync")
    let start = Date(timeIntervalSince1970: 1_900_000_000)
    let end = start.addingTimeInterval(AssistantRetrievalLimits.maximumCalendarDays)

    let authorization = try AssistantCalendarSearchAuthorization(
      query: query, start: start, end: end, maximumResults: 5, includeOngoing: false)

    XCTAssertEqual(authorization.end, end)
  }

  func testCalendarSearchAuthorizationRejectsResultCapAboveMaximum() throws {
    let query = try AssistantApprovedQuery(originalQuery: "sync")
    let start = Date(timeIntervalSince1970: 1_900_000_000)
    let end = start.addingTimeInterval(60 * 60)

    XCTAssertThrowsError(
      try AssistantCalendarSearchAuthorization(
        query: query, start: start, end: end,
        maximumResults: AssistantRetrievalLimits.maximumCalendarResults + 1,
        includeOngoing: false)
    ) { error in
      XCTAssertEqual(
        error as? AssistantTurnRetrievalAuthorizationError, .invalidResultLimit)
    }
  }

  func testCalendarSearchAuthorizationRejectsZeroResultCap() throws {
    let query = try AssistantApprovedQuery(originalQuery: "sync")
    let start = Date(timeIntervalSince1970: 1_900_000_000)
    let end = start.addingTimeInterval(60 * 60)

    XCTAssertThrowsError(
      try AssistantCalendarSearchAuthorization(
        query: query, start: start, end: end, maximumResults: 0, includeOngoing: false)
    ) { error in
      XCTAssertEqual(
        error as? AssistantTurnRetrievalAuthorizationError, .invalidResultLimit)
    }
  }

  // MARK: - AssistantPageSearchAuthorization / AssistantTaskSearchAuthorization bounds

  func testPageSearchAuthorizationRejectsResultCapAboveMaximum() throws {
    let query = try AssistantApprovedQuery(originalQuery: "launch")

    XCTAssertThrowsError(
      try AssistantPageSearchAuthorization(
        query: query, maximumResults: AssistantRetrievalLimits.maximumPageResults + 1)
    ) { error in
      XCTAssertEqual(
        error as? AssistantTurnRetrievalAuthorizationError, .invalidResultLimit)
    }
  }

  func testTaskSearchAuthorizationRejectsResultCapAboveMaximum() throws {
    let query = try AssistantApprovedQuery(originalQuery: "today")

    XCTAssertThrowsError(
      try AssistantTaskSearchAuthorization(
        scope: .today, query: query,
        maximumResults: AssistantRetrievalLimits.maximumTaskResults + 1)
    ) { error in
      XCTAssertEqual(
        error as? AssistantTurnRetrievalAuthorizationError, .invalidResultLimit)
    }
  }

  // MARK: - AssistantMeetingBriefAuthorization bounds

  func testMeetingBriefAuthorizationRejectsEmptySourceAllowlist() {
    XCTAssertThrowsError(
      try AssistantMeetingBriefAuthorization(allowedSourceIDs: [], maximumPeople: 3)
    ) { error in
      XCTAssertEqual(
        error as? AssistantTurnRetrievalAuthorizationError, .invalidSourceID)
    }
  }

  func testMeetingBriefAuthorizationRejectsNonCanonicalSourceID() {
    XCTAssertThrowsError(
      try AssistantMeetingBriefAuthorization(
        allowedSourceIDs: ["not-a-canonical-id"], maximumPeople: 3)
    ) { error in
      XCTAssertEqual(
        error as? AssistantTurnRetrievalAuthorizationError, .invalidSourceID)
    }
  }

  func testMeetingBriefAuthorizationAcceptsCanonicalSourceID() throws {
    let encoded = Data("event:abc123".utf8).base64EncodedString()
    let authorization = try AssistantMeetingBriefAuthorization(
      allowedSourceIDs: ["calendar:\(encoded)"], maximumPeople: 3)

    XCTAssertEqual(authorization.allowedSourceIDs, ["calendar:\(encoded)"])
  }

  // MARK: - allowedTools derivation

  func testAllowedToolsReflectsOnlyNonNilPerToolAuthorizations() throws {
    let query = try AssistantApprovedQuery(originalQuery: "sync")
    let calendarAuthorization = try AssistantCalendarSearchAuthorization(
      query: query, start: Date(), end: Date().addingTimeInterval(3_600), maximumResults: 3,
      includeOngoing: false)

    let authorization = AssistantTurnRetrievalAuthorization(calendarSearch: calendarAuthorization)

    XCTAssertEqual(authorization.allowedTools, [.findCalendarEvents])
  }

  func testNoneAuthorizationPermitsNoTools() {
    XCTAssertTrue(AssistantTurnRetrievalAuthorization.none.allowedTools.isEmpty)
  }

  // MARK: - The core adversarial property: constructed authorization cannot be widened

  /// Simulates the exact shape task #65 calls out: build one authorization
  /// for a calendar search, then simulate a tool-call's arguments trying
  /// to (a) use a wider date range, (b) add a query term never approved,
  /// and (c) request a higher result cap than what was authorized. Every
  /// one of those attempts must be rejected — either because the widened
  /// value fails `permits()`, or because reconstructing an authorization
  /// with the widened value fails bounds validation in `init` — proving
  /// there is no path from "the model asked for more" to "the app gave
  /// it more."
  func testWidenedToolCallArgumentsAreRejectedAgainstAFixedAuthorization() throws {
    let approvedQuery = try AssistantApprovedQuery(
      originalQuery: "weekly sync", approvedQueryTerms: ["weekly sync"])
    let authorizedStart = Date(timeIntervalSince1970: 1_900_000_000)
    let authorizedEnd = authorizedStart.addingTimeInterval(7 * 24 * 60 * 60)
    let authorizedMaximumResults = 3

    let authorization = try AssistantCalendarSearchAuthorization(
      query: approvedQuery,
      start: authorizedStart,
      end: authorizedEnd,
      maximumResults: authorizedMaximumResults,
      includeOngoing: false
    )

    // (a) A model tries to smuggle in an extra query term beyond what was
    // approved (e.g. appending unrelated words to widen a text search).
    let widenedQueryAttempt = "weekly sync OR salary details"
    XCTAssertFalse(authorization.query.permits(widenedQueryAttempt))
    // The original, narrow, approved term is unaffected by the attempt.
    XCTAssertTrue(authorization.query.permits("weekly sync"))

    // (b) A model tries to request a date range wider than what was
    // authorized. The authorization's own stored bounds do not change...
    let widenedEnd = authorizedEnd.addingTimeInterval(60 * 24 * 60 * 60)
    XCTAssertEqual(authorization.end, authorizedEnd)
    XCTAssertNotEqual(authorization.end, widenedEnd)
    // ...and an attempt to construct a fresh authorization matching the
    // model's widened request fails outright, because the widened range
    // itself violates policy (task #65: "reject... not clamp").
    XCTAssertThrowsError(
      try AssistantCalendarSearchAuthorization(
        query: approvedQuery, start: authorizedStart, end: widenedEnd,
        maximumResults: authorizedMaximumResults, includeOngoing: false)
    ) { error in
      XCTAssertEqual(
        error as? AssistantTurnRetrievalAuthorizationError, .invalidDateRange)
    }

    // (c) A model tries to request more results than it was authorized
    // for. The stored authorization is unaffected...
    let widenedMaximumResults = authorizedMaximumResults + 50
    XCTAssertEqual(authorization.maximumResults, authorizedMaximumResults)
    XCTAssertNotEqual(authorization.maximumResults, widenedMaximumResults)
    // ...and reconstructing with the widened cap fails too (it also
    // exceeds the type's own absolute ceiling, but even a value between
    // the authorized cap and the ceiling would still only ever produce a
    // DIFFERENT authorization object, never a mutation of this one).
    XCTAssertThrowsError(
      try AssistantCalendarSearchAuthorization(
        query: approvedQuery, start: authorizedStart, end: authorizedEnd,
        maximumResults: widenedMaximumResults, includeOngoing: false)
    ) { error in
      XCTAssertEqual(
        error as? AssistantTurnRetrievalAuthorizationError, .invalidResultLimit)
    }

    // The original authorization's fields are still exactly what was
    // authorized at construction — nothing above could have touched them.
    XCTAssertEqual(authorization.start, authorizedStart)
    XCTAssertEqual(authorization.end, authorizedEnd)
    XCTAssertEqual(authorization.maximumResults, authorizedMaximumResults)
  }
}
