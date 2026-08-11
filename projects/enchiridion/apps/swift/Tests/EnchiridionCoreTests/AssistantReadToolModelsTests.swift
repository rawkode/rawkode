// AssistantReadToolModelsTests.swift
// EnchiridionCoreTests
//
// Task #66 ("Assistant read tools"). Covers the parts of
// `AssistantReadToolModels.swift` that can be tested without a database:
// `AssistantReadToolSupport`'s helpers, and the full `searchEmailThreads`
// tool against a fake `AssistantEmailSearchClient` (no networking — the
// real wire format is covered separately by `EnchiridionAPITests`).

import Foundation
import XCTest

@testable import EnchiridionCore

private struct FakeEmailSearchClient: AssistantEmailSearchClient {
  var messages: [AssistantEmailMessage]

  func searchEmail(query: String, limit: Int) async throws -> [AssistantEmailMessage] {
    Array(messages.prefix(limit))
  }
}

/// A thread-safe query recorder (`actor`, not an unsafe pointer) — used by
/// `testSearchEmailThreadsUsesTheAuthorizationsOriginalQueryNotTheCandidateVerbatim`
/// to observe exactly what `searchEmailThreads` passed to the client.
private actor QueryRecorder {
  private(set) var queries: [String] = []
  func record(_ query: String) { queries.append(query) }
}

private struct RecordingEmailSearchClient: AssistantEmailSearchClient {
  var messages: [AssistantEmailMessage]
  let recorder: QueryRecorder

  func searchEmail(query: String, limit: Int) async throws -> [AssistantEmailMessage] {
    await recorder.record(query)
    return Array(messages.prefix(limit))
  }
}

private struct OverLimitEmailSearchClient: AssistantEmailSearchClient {
  var messages: [AssistantEmailMessage]

  func searchEmail(query: String, limit: Int) async throws -> [AssistantEmailMessage] {
    // Deliberately violates its contract (returns MORE than `limit`) to
    // exercise `searchEmailThreads`'s own defense — see that function's
    // doc comment.
    messages
  }
}

final class AssistantReadToolModelsTests: XCTestCase {
  // MARK: - AssistantReadToolSupport

  func testBoundedTruncatesLongTextWithEllipsis() {
    let text = String(repeating: "a", count: 10)
    XCTAssertEqual(AssistantReadToolSupport.bounded(text, maximum: 5), "aaaa…")
    XCTAssertEqual(AssistantReadToolSupport.bounded("short", maximum: 10), "short")
  }

  func testExcerptCentersOnTheMatchingQueryTerm() {
    let text = String(repeating: "x", count: 300) + " NEEDLE " + String(repeating: "y", count: 300)
    let excerpt = AssistantReadToolSupport.excerpt(text, matching: "NEEDLE")
    XCTAssertNotNil(excerpt)
    XCTAssertTrue(excerpt!.contains("NEEDLE"))
    XCTAssertTrue(excerpt!.hasPrefix("…"))
    XCTAssertTrue(excerpt!.hasSuffix("…"))
  }

  func testAmbiguousTitlesFindsDuplicatesCaseInsensitively() {
    let sources = [
      AssistantSource(id: "a", kind: .page, title: "Weekly Sync"),
      AssistantSource(id: "b", kind: .page, title: "weekly sync"),
      AssistantSource(id: "c", kind: .page, title: "Unique"),
    ]
    XCTAssertEqual(AssistantReadToolSupport.ambiguousTitles(among: sources), ["Weekly Sync"])
  }

  func testCalendarSourceIDRoundTripsThroughPageIDDecoding() {
    let sourceID = AssistantReadToolSupport.calendarSourceID(pageID: "event_abc123")
    XCTAssertTrue(sourceID.hasPrefix("calendar:"))
    XCTAssertEqual(AssistantReadToolSupport.pageID(fromCalendarSourceID: sourceID), "event_abc123")
  }

  func testPageIDFromCalendarSourceIDRejectsMalformedInput() {
    XCTAssertNil(AssistantReadToolSupport.pageID(fromCalendarSourceID: "not-a-calendar-id"))
    XCTAssertNil(AssistantReadToolSupport.pageID(fromCalendarSourceID: "calendar:not-base64!!"))
  }

  // MARK: - searchEmailThreads: happy path

  func testSearchEmailThreadsReturnsSourcesAndEvidenceForEachMessage() async throws {
    let query = try AssistantApprovedQuery(originalQuery: "budget")
    let authorization = try AssistantEmailSearchAuthorization(query: query, maximumResults: 5)
    let client = FakeEmailSearchClient(messages: [
      AssistantEmailMessage(
        id: "m1", threadPageID: "email_thread_1", from: "alice@example.com",
        subject: "Budget review", snippet: "Here is the Q3 budget review.",
        receivedAt: Date(timeIntervalSince1970: 1_700_000_000)),
    ])

    let result = try await searchEmailThreads(authorization: authorization, candidateQuery: "budget", client: client)

    XCTAssertEqual(result.sources.count, 1)
    XCTAssertEqual(result.sources.first?.title, "Budget review")
    XCTAssertFalse(result.evidence.isEmpty)
    XCTAssertTrue(result.evidence.contains { $0.spokenText.contains("Budget review") })
    XCTAssertFalse(result.truncated)
  }

  func testSearchEmailThreadsPopulatesThreadPageIDsFromFetchedMessages() async throws {
    let query = try AssistantApprovedQuery(originalQuery: "budget")
    let authorization = try AssistantEmailSearchAuthorization(query: query, maximumResults: 5)
    let client = FakeEmailSearchClient(messages: [
      AssistantEmailMessage(
        id: "m1", threadPageID: "email_thread_1", subject: "Budget review",
        receivedAt: Date(timeIntervalSince1970: 1_700_000_000)),
      // A second message on the SAME thread — the eligibility set must
      // de-duplicate, not just collect every message's threadPageID
      // verbatim.
      AssistantEmailMessage(
        id: "m2", threadPageID: "email_thread_1", subject: "Re: Budget review",
        receivedAt: Date(timeIntervalSince1970: 1_700_000_100)),
      AssistantEmailMessage(
        id: "m3", threadPageID: "email_thread_2", subject: "Other thread",
        receivedAt: Date(timeIntervalSince1970: 1_700_000_200)),
    ])

    let result = try await searchEmailThreads(authorization: authorization, candidateQuery: "budget", client: client)

    XCTAssertEqual(result.threadPageIDs, ["email_thread_1", "email_thread_2"])
  }

  func testSearchEmailThreadsUsesTheAuthorizationsOriginalQueryNotTheCandidateVerbatim() async throws {
    // The candidate must match after normalization, but the actual network
    // call uses the authorization's own stored `originalQuery` — proving
    // the client never receives arbitrary model-supplied text, only what
    // was pre-approved.
    let query = try AssistantApprovedQuery(originalQuery: "  budget  ")
    let authorization = try AssistantEmailSearchAuthorization(query: query, maximumResults: 5)
    let recorder = QueryRecorder()
    let client = RecordingEmailSearchClient(messages: [], recorder: recorder)

    _ = try await searchEmailThreads(authorization: authorization, candidateQuery: "budget", client: client)

    let recorded = await recorder.queries
    XCTAssertEqual(recorded, ["budget"])
  }

  // MARK: - searchEmailThreads: pre-flight authorization enforcement

  func testSearchEmailThreadsRejectsAQueryOutsideTheApprovedSet() async throws {
    let query = try AssistantApprovedQuery(originalQuery: "budget")
    let authorization = try AssistantEmailSearchAuthorization(query: query, maximumResults: 5)
    let client = FakeEmailSearchClient(messages: [])

    do {
      _ = try await searchEmailThreads(
        authorization: authorization, candidateQuery: "budget OR salary details", client: client)
      XCTFail("expected an authorization error")
    } catch let error as AssistantTurnRetrievalAuthorizationError {
      XCTAssertEqual(error, .invalidQuery)
    }
  }

  func testSearchEmailThreadsRejectsAMisbehavingClientThatExceedsTheApprovedResultCap() async throws {
    let query = try AssistantApprovedQuery(originalQuery: "budget")
    let authorization = try AssistantEmailSearchAuthorization(query: query, maximumResults: 2)
    let client = OverLimitEmailSearchClient(messages: (0..<5).map {
      AssistantEmailMessage(id: "m\($0)", threadPageID: "t\($0)", receivedAt: Date())
    })

    do {
      _ = try await searchEmailThreads(authorization: authorization, candidateQuery: "budget", client: client)
      XCTFail("expected a result-limit error")
    } catch let error as AssistantEmailSearchError {
      XCTAssertEqual(error, .resultLimitExceeded)
    }
  }

  // MARK: - AssistantEmailSearchAuthorization bounds (mirrors the sibling
  // authorization structs' own adversarial coverage in
  // AssistantTurnRetrievalAuthorizationTests.swift)

  func testEmailSearchAuthorizationRejectsResultCapAboveMaximum() throws {
    let query = try AssistantApprovedQuery(originalQuery: "budget")
    XCTAssertThrowsError(
      try AssistantEmailSearchAuthorization(
        query: query, maximumResults: AssistantRetrievalLimits.maximumEmailResults + 1)
    ) { error in
      XCTAssertEqual(error as? AssistantTurnRetrievalAuthorizationError, .invalidResultLimit)
    }
  }

  func testEmailSearchToolIsReflectedInAllowedTools() throws {
    let query = try AssistantApprovedQuery(originalQuery: "budget")
    let emailAuthorization = try AssistantEmailSearchAuthorization(query: query, maximumResults: 3)
    let authorization = AssistantTurnRetrievalAuthorization(emailSearch: emailAuthorization)

    XCTAssertEqual(authorization.allowedTools, [.searchEmailThreads])
  }
}
