import Foundation
import XCTest
@testable import EnchiridionCore

@MainActor
final class RealtimeSessionBootstrapTests: XCTestCase {
  func testDevelopmentDisabledFailsBeforeLoaderInvocation() async throws {
    let fixture = try makeFixture()
    let loader = FakeRealtimeCallsLoader(exchange: validExchange())
    let bootstrap = DirectBYOKBootstrap(loader: loader)

    do {
      _ = try await bootstrap.bootstrap(
        offerSDP: "v=0",
        route: fixture.route,
        configuration: fixture.configuration,
        credential: fixture.credential
      )
      XCTFail("Expected the development route to be disabled")
    } catch {
      XCTAssertEqual(error as? RealtimeSessionBootstrapError, .developmentRouteDisabled)
    }
    let invocationCount = await loader.invocationCount
    XCTAssertEqual(invocationCount, 0)
  }

  func testPublicPersonalDevelopmentFactoryUsesDebugOnlyDecision() async throws {
    let bootstrap = DirectBYOKBootstrap.personalDevelopment()
    let isEnabled = await bootstrap.isDevelopmentRouteEnabledForTesting

    #if DEBUG
      XCTAssertTrue(isEnabled)
    #else
      XCTAssertFalse(isEnabled)
    #endif
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
    let bootstrap = DirectBYOKBootstrap(isDevelopmentRouteEnabled: true, loader: loader)

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
    let bootstrap = DirectBYOKBootstrap(isDevelopmentRouteEnabled: true, loader: loader)

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
    let loader = FakeRealtimeCallsLoader(exchange: validExchange(body: Data()))
    let bootstrap = DirectBYOKBootstrap(isDevelopmentRouteEnabled: true, loader: loader)

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
  }

  func testValidNativeAnswerReturnsSDPAndRequestIDAndKeepsCredentialOutOfBody() async throws {
    let fixture = try makeFixture()
    let loader = FakeRealtimeCallsLoader(
      exchange: validExchange(body: Data("v=0\r\na=answer\r\n".utf8))
    )
    let bootstrap = DirectBYOKBootstrap(isDevelopmentRouteEnabled: true, loader: loader)

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
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fake-development-key")
    let body = try XCTUnwrap(request.httpBody.flatMap { String(data: $0, encoding: .utf8) })
    XCTAssertFalse(body.contains("fake-development-key"))
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
      RealtimeCredentialLease(credential: "fake-development-key", binding: binding)
    )
  }

  private func validExchange(body: Data = Data("v=0\r\na=answer\r\n".utf8)) -> RealtimeCallsHTTPExchange {
    RealtimeCallsHTTPExchange(
      finalURL: RealtimeCallsRequestSpecBuilder.endpoint,
      statusCode: 201,
      headers: ["x-request-id": "req_valid_answer"],
      body: body
    )
  }
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
