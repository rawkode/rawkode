// VaultEmailSearchClientTests.swift
// EnchiridionAPITests
//
// Task #66 ("Assistant read tools"). `EnchiridionAPI`'s first test file —
// see `Package.swift`'s comment on this target for why (no prior mocking
// convention existed in this module). A `URLProtocol` stub intercepts the
// real `URLSession` call `VaultEmailSearchClient.searchEmail` makes,
// proving the actual GraphQL request (method, headers, body) and response
// decoding both work end to end — not just the business logic layered on
// top (that's `AssistantReadToolModelsTests.swift`, in `EnchiridionCoreTests`,
// against a fake `AssistantEmailSearchClient`).

import EnchiridionCore
import Foundation
import XCTest

@testable import EnchiridionAPI

/// Records the single most recent intercepted request. `@unchecked
/// Sendable`: this is test-only, single-request-at-a-time usage (the async
/// `URLSession` call is awaited before any assertion reads `request`), the
/// same pattern this kind of `URLProtocol`-stub test always needs.
private final class RequestRecorder: @unchecked Sendable {
  var request: URLRequest?
  /// The request body — read separately from `request.httpBody`, which the
  /// URL Loading System replaces with `httpBodyStream` by the time a
  /// `URLProtocol` subclass observes the request (a well-known
  /// `URLProtocol`-stub gotcha: `httpBody` is nil here even though the
  /// caller set it).
  var body: Data?
}

/// `nonisolated(unsafe)`: a `URLProtocol` subclass's overrides are called
/// by the URL Loading System on its own thread(s); this static is
/// deliberately set once per test and only ever read from that same
/// single in-flight request, matching the standard `URLProtocol`-stub
/// testing pattern.
private final class StubURLProtocol: URLProtocol {
  nonisolated(unsafe) static var handler: ((URLRequest) -> (Data, HTTPURLResponse))?
  nonisolated(unsafe) static var recorder: RequestRecorder?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.recorder?.request = request
    Self.recorder?.body = Self.extractBody(from: request)
    guard let handler = Self.handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }
    let (data, response) = handler(request)
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}

  private static func extractBody(from request: URLRequest) -> Data? {
    if let data = request.httpBody { return data }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    let bufferSize = 4_096
    var buffer = [UInt8](repeating: 0, count: bufferSize)
    while stream.hasBytesAvailable {
      let read = stream.read(&buffer, maxLength: bufferSize)
      guard read > 0 else { break }
      data.append(buffer, count: read)
    }
    return data
  }
}

final class VaultEmailSearchClientTests: XCTestCase {
  private func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    return URLSession(configuration: configuration)
  }

  override func tearDown() {
    StubURLProtocol.handler = nil
    StubURLProtocol.recorder = nil
    super.tearDown()
  }

  func testSearchEmailDecodesARealGraphQLResponseIntoAssistantEmailMessages() async throws {
    let endpoint = URL(string: "https://vault.example.com/graphql")!
    let recorder = RequestRecorder()
    StubURLProtocol.recorder = recorder
    StubURLProtocol.handler = { request in
      let json = """
        {"data":{"emailSearch":[{"id":"m1","threadPageId":"email_thread_1","from":"alice@example.com","subject":"Budget review","bodyText":"Here is the Q3 budget review.","receivedAt":1700000000000}]}}
        """
      let response = HTTPURLResponse(url: endpoint, statusCode: 200, httpVersion: nil, headerFields: nil)!
      return (Data(json.utf8), response)
    }
    let client = VaultEmailSearchClient(
      endpoint: endpoint,
      credentials: EnchiridionAPICredentials(accessClientID: "device-id", accessClientSecret: "device-secret"),
      urlSession: makeSession()
    )

    let messages = try await client.searchEmail(query: "budget", limit: 5)

    XCTAssertEqual(messages.count, 1)
    let message = try XCTUnwrap(messages.first)
    XCTAssertEqual(message.id, "m1")
    XCTAssertEqual(message.threadPageID, "email_thread_1")
    XCTAssertEqual(message.from, "alice@example.com")
    XCTAssertEqual(message.subject, "Budget review")
    XCTAssertEqual(message.snippet, "Here is the Q3 budget review.")
    XCTAssertEqual(message.receivedAt, Date(timeIntervalSince1970: 1_700_000_000))

    let request = try XCTUnwrap(recorder.request)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url, endpoint)
    XCTAssertEqual(request.value(forHTTPHeaderField: "CF-Access-Client-Id"), "device-id")
    XCTAssertEqual(request.value(forHTTPHeaderField: "CF-Access-Client-Secret"), "device-secret")
    let body = try XCTUnwrap(recorder.body)
    let bodyText = String(decoding: body, as: UTF8.self)
    XCTAssertTrue(bodyText.contains("emailSearch"))
    XCTAssertTrue(bodyText.contains("\"query\":\"budget\""))
    XCTAssertTrue(bodyText.contains("\"limit\":5"))
  }

  func testSearchEmailThrowsOnGraphQLLevelErrors() async throws {
    let endpoint = URL(string: "https://vault.example.com/graphql")!
    StubURLProtocol.handler = { _ in
      let json = #"{"errors":[{"message":"unauthorized"}]}"#
      let response = HTTPURLResponse(url: endpoint, statusCode: 200, httpVersion: nil, headerFields: nil)!
      return (Data(json.utf8), response)
    }
    let client = VaultEmailSearchClient(endpoint: endpoint, urlSession: makeSession())

    do {
      _ = try await client.searchEmail(query: "budget", limit: 5)
      XCTFail("expected a GraphQL-level error")
    } catch let error as VaultGraphQLClientError {
      XCTAssertEqual(error, .graphQLErrors(["unauthorized"]))
    }
  }

  func testSearchEmailThrowsOnNonSuccessHTTPStatus() async throws {
    let endpoint = URL(string: "https://vault.example.com/graphql")!
    StubURLProtocol.handler = { _ in
      let response = HTTPURLResponse(url: endpoint, statusCode: 401, httpVersion: nil, headerFields: nil)!
      return (Data(), response)
    }
    let client = VaultEmailSearchClient(endpoint: endpoint, urlSession: makeSession())

    do {
      _ = try await client.searchEmail(query: "budget", limit: 5)
      XCTFail("expected an HTTP error")
    } catch let error as VaultGraphQLClientError {
      XCTAssertEqual(error, .httpError(401))
    }
  }

  func testSearchEmailThrowsOnUndecodableResponseBody() async throws {
    let endpoint = URL(string: "https://vault.example.com/graphql")!
    StubURLProtocol.handler = { _ in
      let response = HTTPURLResponse(url: endpoint, statusCode: 200, httpVersion: nil, headerFields: nil)!
      return (Data("not json".utf8), response)
    }
    let client = VaultEmailSearchClient(endpoint: endpoint, urlSession: makeSession())

    do {
      _ = try await client.searchEmail(query: "budget", limit: 5)
      XCTFail("expected a decoding error")
    } catch let error as VaultGraphQLClientError {
      XCTAssertEqual(error, .decodingFailed)
    }
  }

  // MARK: - credentialProvider (task #96, plan §Live Backend Connectivity
  // (P8) scope item 4) — the real, per-call-resolved credential path.

  func testSearchEmailUsesCredentialProviderHeadersWhenSupplied() async throws {
    let endpoint = URL(string: "https://vault.example.com/graphql")!
    let recorder = RequestRecorder()
    StubURLProtocol.recorder = recorder
    StubURLProtocol.handler = { _ in
      let json = #"{"data":{"emailSearch":[]}}"#
      let response = HTTPURLResponse(url: endpoint, statusCode: 200, httpVersion: nil, headerFields: nil)!
      return (Data(json.utf8), response)
    }
    let client = VaultEmailSearchClient(
      endpoint: endpoint,
      credentialProvider: { EnchiridionAPICredentials(accessClientID: "resolved-id", accessClientSecret: "resolved-secret") },
      urlSession: makeSession()
    )

    _ = try await client.searchEmail(query: "budget", limit: 5)

    let request = try XCTUnwrap(recorder.request)
    XCTAssertEqual(request.value(forHTTPHeaderField: "CF-Access-Client-Id"), "resolved-id")
    XCTAssertEqual(request.value(forHTTPHeaderField: "CF-Access-Client-Secret"), "resolved-secret")
  }

  /// The missing-device-credential honesty requirement (plan §Live Backend
  /// Connectivity (P8) scope item 2): a `credentialProvider` that throws
  /// (exactly what `EnchiridionCore.DeviceAccessCredentialResolver
  /// .resolveCredential()` does for a never-enrolled device) must propagate
  /// as a real, catchable error BEFORE any request reaches the network —
  /// not a silently-unauthenticated request, not a crash.
  func testSearchEmailPropagatesADeviceNotEnrolledErrorFromCredentialProviderWithoutSendingARequest() async throws {
    let endpoint = URL(string: "https://vault.example.com/graphql")!
    let recorder = RequestRecorder()
    StubURLProtocol.recorder = recorder
    StubURLProtocol.handler = { _ in
      XCTFail("no HTTP request should be sent when the credential provider throws")
      let response = HTTPURLResponse(url: endpoint, statusCode: 200, httpVersion: nil, headerFields: nil)!
      return (Data(), response)
    }
    let client = VaultEmailSearchClient(
      endpoint: endpoint,
      credentialProvider: { throw DeviceAccessCredentialResolutionError.deviceNotEnrolled },
      urlSession: makeSession()
    )

    do {
      _ = try await client.searchEmail(query: "budget", limit: 5)
      XCTFail("expected deviceNotEnrolled to propagate")
    } catch DeviceAccessCredentialResolutionError.deviceNotEnrolled {
      // expected
    }
    XCTAssertNil(recorder.request, "no request should have been recorded")
  }
}
