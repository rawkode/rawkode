import Foundation
import XCTest
@testable import EnchiridionCore

@MainActor
final class RealtimeSessionBootstrapTests: XCTestCase {
  func testPublicBootstrapUsesNativeBYOKInEveryBuildConfiguration() async throws {
    let fixture = try makeFixture()
    let loader = FakeRealtimeCallsLoader(exchange: validExchange())
    let bootstrap = DirectBYOKBootstrap(loader: loader)

    _ = try await bootstrap.bootstrap(
      offerSDP: "v=0",
      route: fixture.route,
      configuration: fixture.configuration,
      credential: fixture.credential
    )
    let invocationCount = await loader.invocationCount
    XCTAssertEqual(invocationCount, 1)
  }

  func testRejectsRedirectBeforeAcceptingAnswer() async throws {
    let fixture = try makeFixture()
    let loader = FakeRealtimeCallsLoader(
      exchange: RealtimeCallsHTTPExchange(
        finalURL: URL(string: "https://redirect.example.invalid/v1/realtime/calls")!,
        statusCode: 200,
        headers: [:],
        body: Data("v=0\r\n".utf8)
      )
    )
    let bootstrap = DirectBYOKBootstrap(loader: loader)

    do {
      _ = try await bootstrap.bootstrap(
        offerSDP: "v=0",
        route: fixture.route,
        configuration: fixture.configuration,
        credential: fixture.credential
      )
      XCTFail("Expected a redirect to be rejected")
    } catch {
      XCTAssertEqual(error as? RealtimeSessionBootstrapError, .redirectBlocked)
    }
  }

  func testRejectsNon2xxResponse() async throws {
    let fixture = try makeFixture()
    let loader = FakeRealtimeCallsLoader(
      exchange: RealtimeCallsHTTPExchange(
        finalURL: RealtimeCallsRequestSpecBuilder.endpoint,
        statusCode: 401,
        headers: ["x-request-id": "req_auth_failed"],
        body: Data("unauthorized".utf8)
      )
    )
    let bootstrap = DirectBYOKBootstrap(loader: loader)

    do {
      _ = try await bootstrap.bootstrap(
        offerSDP: "v=0",
        route: fixture.route,
        configuration: fixture.configuration,
        credential: fixture.credential
      )
      XCTFail("Expected a non-2xx response to be rejected")
    } catch {
      XCTAssertEqual(
        error as? RealtimeSessionBootstrapError,
        .rejected(statusCode: 401, requestID: "req_auth_failed")
      )
    }
  }

  func testRejectsMalformedNativeAnswer() async throws {
    let fixture = try makeFixture()
    let loader = FakeRealtimeCallsLoader(exchange: validExchange(
      body: Data(), requestID: "req_invalid_answer"
    ))
    let diagnostics = RecordingVoiceDiagnosticSink()
    let bootstrap = DirectBYOKBootstrap(loader: loader, diagnostics: diagnostics)

    do {
      _ = try await bootstrap.bootstrap(
        offerSDP: "v=0",
        route: fixture.route,
        configuration: fixture.configuration,
        credential: fixture.credential
      )
      XCTFail("Expected malformed SDP to be rejected")
    } catch {
      XCTAssertEqual(error as? RealtimeSessionBootstrapError, .invalidAnswer)
    }
    XCTAssertEqual(
      diagnostics.events.last,
      .init(
        stage: .bootstrapResponse, outcome: .failed,
        httpStatus: 200, requestID: "req_invalid_answer"
      )
    )
  }

  func testValidNativeAnswerReturnsSDPAndRequestIDAndKeepsCredentialOutOfBody() async throws {
    let fixture = try makeFixture()
    let loader = FakeRealtimeCallsLoader(
      exchange: validExchange(body: Data("v=0\r\na=answer\r\n".utf8))
    )
    let bootstrap = DirectBYOKBootstrap(loader: loader)

    let result = try await bootstrap.bootstrap(
      offerSDP: "v=0\r\na=offer\r\n",
      route: fixture.route,
      configuration: fixture.configuration,
      credential: fixture.credential
    )

    XCTAssertEqual(result.answerSDP, "v=0\r\na=answer\r\n")
    XCTAssertEqual(result.requestID, "req_valid_answer")
    let lastRequest = await loader.lastRequest
    let request = try XCTUnwrap(lastRequest)
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fake-platform-key")
    let body = try XCTUnwrap(request.httpBody.flatMap { String(data: $0, encoding: .utf8) })
    XCTAssertFalse(body.contains("fake-platform-key"))
    XCTAssertFalse(body.contains("Bearer"))
  }

  private func makeFixture() throws -> (
    route: RealtimeVoiceRouteSnapshot,
    configuration: RealtimeVoiceConfiguration,
    credential: RealtimeCredentialLease
  ) {
    let binding = OpenAICredentialBinding(revision: "fixture-revision", fingerprint: "fixture")
    let route = try makeAuthorizedRealtimeVoiceRoute(binding: binding)
    return (
      route,
      try RealtimeVoiceConfiguration(route: route),
      RealtimeCredentialLease(credential: "fake-platform-key", binding: binding)
    )
  }

  private func validExchange(
    body: Data = Data("v=0\r\na=answer\r\n".utf8),
    requestID: String = "req_valid_answer"
  ) -> RealtimeCallsHTTPExchange {
    RealtimeCallsHTTPExchange(
      finalURL: RealtimeCallsRequestSpecBuilder.endpoint,
      statusCode: 201,
      headers: ["x-request-id": requestID],
      body: body
    )
  }
}

private final class RecordingVoiceDiagnosticSink: OpenAIRealtimeVoiceDiagnosticSinking, @unchecked Sendable {
  private(set) var events: [OpenAIRealtimeVoiceDiagnosticEvent] = []
  func record(_ event: OpenAIRealtimeVoiceDiagnosticEvent) { events.append(event) }
}

private actor FakeRealtimeCallsLoader: RealtimeCallsHTTPLoading {
  private let exchange: RealtimeCallsHTTPExchange
  private(set) var invocationCount = 0
  private(set) var lastRequest: URLRequest?

  init(exchange: RealtimeCallsHTTPExchange) {
    self.exchange = exchange
  }

  func load(_ request: URLRequest) async throws -> RealtimeCallsHTTPExchange {
    invocationCount += 1
    lastRequest = request
    return exchange
  }
}
