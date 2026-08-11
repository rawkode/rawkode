// AssistantRemoteWriteToolsTests.swift
// EnchiridionCoreTests
//
// Tests for Sources/EnchiridionCore/AssistantRemoteWriteTools.swift: the
// propose-only calls (createEvent/rsvp/sendEmail, plus the 5 Gmail triage
// calls archiveThread/applyLabel/removeLabel/markRead/markUnread), conflict
// surfacing on confirmApproval (reviewer-only), and the
// self-confirm-is-unreachable security property that file's header
// describes in full.

import Foundation
import XCTest

@testable import EnchiridionCore

/// A scripted `AssistantRemoteWriteHTTPSession` — returns canned
/// (Data, URLResponse) pairs in order, and records every request it saw so
/// tests can assert on method/path/body without a live network.
private final class FakeRemoteWriteSession: AssistantRemoteWriteHTTPSession, @unchecked Sendable {
  private var scriptedResponses: [(Data, HTTPURLResponse)]
  private(set) var capturedRequests: [URLRequest] = []

  init(responses: [(Data, HTTPURLResponse)]) {
    self.scriptedResponses = responses
  }

  func data(for request: URLRequest) async throws -> (Data, URLResponse) {
    capturedRequests.append(request)
    guard !scriptedResponses.isEmpty else {
      throw URLError(.unknown)
    }
    let (data, response) = scriptedResponses.removeFirst()
    return (data, response)
  }
}

private func jsonResponse(_ body: [String: Any], statusCode: Int = 200, url: URL) -> (Data, HTTPURLResponse) {
  let data = try! JSONSerialization.data(withJSONObject: body)
  let response = HTTPURLResponse(
    url: url, statusCode: statusCode, httpVersion: "HTTP/1.1", headerFields: nil)!
  return (data, response)
}

final class AssistantRemoteWriteToolsTests: XCTestCase {
  private let baseURL = URL(string: "https://vault.example.invalid")!
  private let credential: @Sendable () async throws -> AssistantRemoteWriteCredential = {
    AssistantRemoteWriteCredential(clientId: "test-client", clientSecret: "test-secret")
  }

  private func pendingApprovalJSON(
    id: String = "approval_1", actionType: String = "createEvent", status: String = "pending"
  ) -> [String: Any] {
    [
      "id": id,
      "actionType": actionType,
      "payload": ["note": "test-payload"],
      "versionToken": "token_abc",
      "status": status,
      "createdAt": 1_700_000_000_000.0,
      "updatedAt": 1_700_000_000_000.0,
    ]
  }

  // MARK: - Propose-only calls (assistant-facing)

  func testCreateEventPostsToCreateEventEndpointAndDecodesPendingApproval() async throws {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(pendingApprovalJSON(actionType: "createEvent"), url: baseURL)
    ])
    let client = AssistantRemoteWriteClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let approval = try await client.createEvent(
      AssistantCreateEventInput(
        summary: "Team sync",
        start: AssistantCalendarEventDateTime(dateTime: "2026-08-10T10:00:00Z"),
        end: AssistantCalendarEventDateTime(dateTime: "2026-08-10T10:30:00Z")))

    XCTAssertEqual(approval.actionType, .createEvent)
    XCTAssertEqual(approval.status, .pending)
    XCTAssertEqual(session.capturedRequests.count, 1)
    XCTAssertEqual(session.capturedRequests[0].httpMethod, "POST")
    XCTAssertEqual(
      session.capturedRequests[0].url?.path, "/gatekeeper-google/calendar/create-event")
  }

  func testRsvpPostsToRsvpEndpoint() async throws {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(pendingApprovalJSON(actionType: "rsvp"), url: baseURL)
    ])
    let client = AssistantRemoteWriteClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let approval = try await client.rsvp(
      AssistantRsvpInput(eventPageID: "event_page_123", responseStatus: .accepted))

    XCTAssertEqual(approval.actionType, .rsvp)
    XCTAssertEqual(session.capturedRequests[0].url?.path, "/gatekeeper-google/calendar/rsvp")
  }

  func testSendEmailPostsToSendEmailEndpoint() async throws {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(pendingApprovalJSON(actionType: "sendEmail"), url: baseURL)
    ])
    let client = AssistantRemoteWriteClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let approval = try await client.sendEmail(
      AssistantSendEmailInput(to: ["someone@example.com"], subject: "Hi", body: "Hello there"))

    XCTAssertEqual(approval.actionType, .sendEmail)
    XCTAssertEqual(session.capturedRequests[0].url?.path, "/gatekeeper-google/gmail/send")
  }

  // MARK: - Propose-only calls — Gmail triage (archive/label/mark read-unread)

  func testArchiveThreadPostsToArchiveThreadEndpoint() async throws {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(pendingApprovalJSON(actionType: "archiveThread"), url: baseURL)
    ])
    let client = AssistantRemoteWriteClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let approval = try await client.archiveThread(AssistantArchiveThreadInput(threadPageID: "thread_1"))

    XCTAssertEqual(approval.actionType, .archiveThread)
    XCTAssertEqual(
      session.capturedRequests[0].url?.path, "/gatekeeper-google/gmail/archive-thread")
  }

  func testApplyLabelPostsToApplyLabelEndpoint() async throws {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(pendingApprovalJSON(actionType: "applyLabel"), url: baseURL)
    ])
    let client = AssistantRemoteWriteClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let approval = try await client.applyLabel(
      AssistantApplyLabelInput(threadPageID: "thread_1", label: "IMPORTANT"))

    XCTAssertEqual(approval.actionType, .applyLabel)
    XCTAssertEqual(session.capturedRequests[0].url?.path, "/gatekeeper-google/gmail/apply-label")
  }

  func testRemoveLabelPostsToRemoveLabelEndpoint() async throws {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(pendingApprovalJSON(actionType: "removeLabel"), url: baseURL)
    ])
    let client = AssistantRemoteWriteClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let approval = try await client.removeLabel(
      AssistantRemoveLabelInput(threadPageID: "thread_1", label: "STARRED"))

    XCTAssertEqual(approval.actionType, .removeLabel)
    XCTAssertEqual(session.capturedRequests[0].url?.path, "/gatekeeper-google/gmail/remove-label")
  }

  func testMarkReadPostsToMarkReadEndpoint() async throws {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(pendingApprovalJSON(actionType: "markRead"), url: baseURL)
    ])
    let client = AssistantRemoteWriteClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let approval = try await client.markRead(AssistantMarkReadInput(threadPageID: "thread_1"))

    XCTAssertEqual(approval.actionType, .markRead)
    XCTAssertEqual(session.capturedRequests[0].url?.path, "/gatekeeper-google/gmail/mark-read")
  }

  func testMarkUnreadPostsToMarkUnreadEndpoint() async throws {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(pendingApprovalJSON(actionType: "markUnread"), url: baseURL)
    ])
    let client = AssistantRemoteWriteClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let approval = try await client.markUnread(AssistantMarkUnreadInput(threadPageID: "thread_1"))

    XCTAssertEqual(approval.actionType, .markUnread)
    XCTAssertEqual(session.capturedRequests[0].url?.path, "/gatekeeper-google/gmail/mark-unread")
  }

  // MARK: - Wire DTO round-trip coverage — Gmail triage

  func testTriageInputDTOsRoundTripThroughEncodeDecode() throws {
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()

    let archive = AssistantArchiveThreadInput(threadPageID: "thread_1")
    XCTAssertEqual(try decoder.decode(AssistantArchiveThreadInput.self, from: encoder.encode(archive)), archive)

    let applyLabel = AssistantApplyLabelInput(threadPageID: "thread_1", label: "IMPORTANT")
    XCTAssertEqual(try decoder.decode(AssistantApplyLabelInput.self, from: encoder.encode(applyLabel)), applyLabel)

    let removeLabel = AssistantRemoveLabelInput(threadPageID: "thread_1", label: "STARRED")
    XCTAssertEqual(try decoder.decode(AssistantRemoveLabelInput.self, from: encoder.encode(removeLabel)), removeLabel)

    let markRead = AssistantMarkReadInput(threadPageID: "thread_1")
    XCTAssertEqual(try decoder.decode(AssistantMarkReadInput.self, from: encoder.encode(markRead)), markRead)

    let markUnread = AssistantMarkUnreadInput(threadPageID: "thread_1")
    XCTAssertEqual(try decoder.decode(AssistantMarkUnreadInput.self, from: encoder.encode(markUnread)), markUnread)
  }

  func testPendingApprovalActionTypeIncludesAllFiveTriageCasesWithMatchingRawValues() {
    XCTAssertEqual(AssistantPendingApprovalActionType.archiveThread.rawValue, "archiveThread")
    XCTAssertEqual(AssistantPendingApprovalActionType.applyLabel.rawValue, "applyLabel")
    XCTAssertEqual(AssistantPendingApprovalActionType.removeLabel.rawValue, "removeLabel")
    XCTAssertEqual(AssistantPendingApprovalActionType.markRead.rawValue, "markRead")
    XCTAssertEqual(AssistantPendingApprovalActionType.markUnread.rawValue, "markUnread")
  }

  func testTransportFailureIsSurfacedNotSwallowed() async {
    let session = FakeRemoteWriteSession(responses: [])  // no scripted response -> throws
    let client = AssistantRemoteWriteClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    do {
      _ = try await client.rsvp(AssistantRsvpInput(eventPageID: "event_page_1", responseStatus: .declined))
      XCTFail("expected a transport failure to be thrown")
    } catch AssistantRemoteWriteError.transportFailure {
      // expected
    } catch {
      XCTFail("expected .transportFailure, got \(error)")
    }
  }

  // MARK: - Conflict surfacing (reviewer-facing) — the required test:
  // "stale version token surfaces as a conflict result, not a silent
  // overwrite or retry."

  func testConfirmApprovalWithStaleVersionTokenSurfacesAsConflict() async throws {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(
        ["status": "conflict", "reason": "version token does not match — this approval was already confirmed by another caller"],
        url: baseURL)
    ])
    let reviewClient = AssistantRemoteWriteReviewClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let result = try await reviewClient.confirmApproval(id: "approval_1", versionToken: "stale-token")

    guard case .conflict(let reason) = result else {
      XCTFail("expected .conflict, got \(result)")
      return
    }
    XCTAssertTrue(reason.contains("version token"))

    // Exactly one request was sent — proving this did NOT silently retry
    // with a fresh token.
    XCTAssertEqual(session.capturedRequests.count, 1)
    XCTAssertEqual(
      session.capturedRequests[0].url?.path,
      "/write/gatekeeper-google/approvals/approval_1/confirm")
  }

  func testConfirmApprovalExecutedSurfacesAsExecuted() async throws {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(["status": "executed", "result": ["applied": true]], url: baseURL)
    ])
    let reviewClient = AssistantRemoteWriteReviewClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let result = try await reviewClient.confirmApproval(id: "approval_1", versionToken: "token_abc")
    XCTAssertEqual(result, .executed)
  }

  func testConfirmApprovalFailedSurfacesReason() async throws {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(["status": "failed", "reason": "Google Calendar events.insert failed (HTTP 500)"], url: baseURL)
    ])
    let reviewClient = AssistantRemoteWriteReviewClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let result = try await reviewClient.confirmApproval(id: "approval_1", versionToken: "token_abc")
    guard case .failed(let reason) = result else {
      XCTFail("expected .failed, got \(result)")
      return
    }
    XCTAssertTrue(reason.contains("500"))
  }

  // MARK: - AssistantPendingApproval decode coverage — payload/result/
  // providerMessageId (adversarial-review finding: these fields are what a
  // human reviewer needs to actually trust the "unknown" sendEmail safety
  // status — see AssistantRemoteWriteTools.swift's AssistantPendingApproval
  // doc comment).

  func testGetApprovalDecodesPayloadResultAndProviderMessageIdForAnUnknownSendEmailApproval() async throws {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(
        [
          "id": "approval_1",
          "actionType": "sendEmail",
          "payload": ["to": ["someone@example.com"], "subject": "Hi", "body": "Hello there"],
          "versionToken": "token_abc",
          "status": "unknown",
          "result": [
            "error":
              "confirmation timed out — Gmail send outcome could not be confirmed automatically; verify the Sent folder before retrying (Message-ID: abc123@mail.gmail.com)"
          ],
          "createdAt": 1_700_000_000_000.0,
          "updatedAt": 1_700_000_003_000.0,
          "providerMessageId": "abc123@mail.gmail.com",
        ], url: baseURL)
    ])
    let reviewClient = AssistantRemoteWriteReviewClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let approval = try await reviewClient.getApproval(id: "approval_1")

    XCTAssertEqual(approval?.status, .unknown)
    XCTAssertEqual(approval?.providerMessageId, "abc123@mail.gmail.com")

    guard case .object(let payloadFields)? = approval?.payload else {
      XCTFail("expected payload to decode as a JSON object, got \(String(describing: approval?.payload))")
      return
    }
    XCTAssertEqual(payloadFields["subject"], .string("Hi"))

    guard case .object(let resultFields)? = approval?.result else {
      XCTFail("expected result to decode as a JSON object, got \(String(describing: approval?.result))")
      return
    }
    guard case .string(let errorMessage)? = resultFields["error"] else {
      XCTFail("expected result.error to decode as a string")
      return
    }
    XCTAssertTrue(errorMessage.contains("abc123@mail.gmail.com"))
  }

  func testAssistantPendingApprovalWithNewFieldsRoundTripsThroughEncodeDecode() throws {
    let original = AssistantPendingApproval(
      id: "approval_1",
      actionType: .sendEmail,
      payload: .object(["to": .array([.string("someone@example.com")]), "subject": .string("Hi")]),
      versionToken: "token_abc",
      status: .unknown,
      result: .object(["error": .string("confirmation timed out")]),
      createdAt: Date(timeIntervalSince1970: 1_700_000_000),
      updatedAt: Date(timeIntervalSince1970: 1_700_000_003),
      providerMessageId: "abc123@mail.gmail.com")

    let encoder = JSONEncoder()
    let decoder = JSONDecoder()
    let decoded = try decoder.decode(AssistantPendingApproval.self, from: encoder.encode(original))

    XCTAssertEqual(decoded, original)
    XCTAssertEqual(decoded.payload, original.payload)
    XCTAssertEqual(decoded.result, original.result)
    XCTAssertEqual(decoded.providerMessageId, original.providerMessageId)
  }

  func testAssistantPendingApprovalDecodesWithoutResultOrProviderMessageIdWhenAbsent() async throws {
    // A still-`pending` approval's wire JSON omits `result` entirely (TS's
    // `result: undefined` is never serialized) and `providerMessageId` is
    // only ever present for `sendEmail` approvals — both must decode to
    // `nil`, not throw.
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(pendingApprovalJSON(actionType: "createEvent", status: "pending"), url: baseURL)
    ])
    let client = AssistantRemoteWriteClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let approval = try await client.createEvent(
      AssistantCreateEventInput(
        summary: "Team sync",
        start: AssistantCalendarEventDateTime(dateTime: "2026-08-10T10:00:00Z"),
        end: AssistantCalendarEventDateTime(dateTime: "2026-08-10T10:30:00Z")))

    XCTAssertNil(approval.result)
    XCTAssertNil(approval.providerMessageId)
    XCTAssertEqual(approval.payload, .object(["note": .string("test-payload")]))
  }

  func testGetApprovalReturnsNilOn404() async throws {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse([:], statusCode: 404, url: baseURL)
    ])
    let reviewClient = AssistantRemoteWriteReviewClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential, session: session)

    let approval = try await reviewClient.getApproval(id: "does_not_exist")
    XCTAssertNil(approval)
  }

  // MARK: - Security property: the propose-only client is structurally
  // incapable of confirming.
  //
  // `AssistantRemoteWriteClient` (what the assistant's tool-dispatch code
  // is meant to be constructed with) conforms ONLY to
  // `AssistantRemoteWriteTransport`. It shares no base type and no
  // protocol conformance with `AssistantRemoteWriteReviewClient` (which
  // alone carries `confirmApproval`), so — unlike a single class exposing
  // both sets of methods — there is no downcast path from one to the
  // other. This test proves that at runtime: the dynamic cast genuinely
  // fails, not merely "isn't attempted by today's code."
  func testProposeOnlyClientCannotBeTreatedAsAReviewClient() {
    let client: any AssistantRemoteWriteTransport = AssistantRemoteWriteClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential)

    XCTAssertNil(
      client as? any AssistantRemoteWriteReviewTransport,
      "AssistantRemoteWriteClient must never satisfy AssistantRemoteWriteReviewTransport — if "
        + "this fails, the assistant-tool-dispatch-facing client has gained a reachable path to "
        + "confirmApproval, reopening the self-propose-then-self-confirm bug this file's header "
        + "documents.")
  }

  func testReviewClientDoesSatisfyReviewTransport() {
    // Sanity check for the test above.
    let reviewClient: any AssistantRemoteWriteReviewTransport = AssistantRemoteWriteReviewClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: credential)
    XCTAssertNotNil(reviewClient as? any AssistantRemoteWriteReviewTransport)
  }

  // MARK: - Missing-device-credential honesty (task #96, plan §Live Backend
  // Connectivity (P8) scope item 2: "these calls should fail with a clear,
  // honest 'device not enrolled' error, not silently no-op or crash").
  //
  // `AssistantRemoteWriteClient`'s `credential` closure is now throwing
  // (was non-throwing before this task) specifically so a real
  // `DeviceAccessCredentialResolver.resolveCredential()` can reject BEFORE
  // any request is even built — this proves that plumbing end to end using
  // exactly the error type that resolver throws, without needing a real
  // Keychain (see `DeviceAccessCredentialStoreTests.swift` for the
  // resolver's own dedicated coverage).

  func testMissingDeviceCredentialThrowsDeviceNotEnrolledBeforeAnyRequestIsSent() async {
    let session = FakeRemoteWriteSession(responses: [
      jsonResponse(pendingApprovalJSON(actionType: "rsvp"), url: baseURL)
    ])
    let neverEnrolledCredential: @Sendable () async throws -> AssistantRemoteWriteCredential = {
      throw DeviceAccessCredentialResolutionError.deviceNotEnrolled
    }
    let client = AssistantRemoteWriteClient(
      endpoint: AssistantRemoteWriteEndpoint(baseURL: baseURL), credential: neverEnrolledCredential,
      session: session)

    do {
      _ = try await client.rsvp(AssistantRsvpInput(eventPageID: "event_page_1", responseStatus: .accepted))
      XCTFail("expected deviceNotEnrolled to be thrown")
    } catch DeviceAccessCredentialResolutionError.deviceNotEnrolled {
      // expected — a real, catchable, distinct error.
    } catch {
      XCTFail("expected DeviceAccessCredentialResolutionError.deviceNotEnrolled, got \(error)")
    }
    XCTAssertEqual(session.capturedRequests.count, 0, "no HTTP request should ever be sent for an unenrolled device")
  }
}
