import Foundation
import XCTest

@testable import EnchiridionCore

final class OpenAIModelsValidatorTests: XCTestCase {
  func testRequestIsExactAndCredentialExistsOnlyInAuthorizationAtSendSeam() async throws {
    let transport = RecordingModelsTransport(response: successResponse(ids: ["gpt-5.6-terra"]))
    let validator = OpenAIModelsValidator(transport: transport)

    _ = try await validator.validate(credential: "credential-placeholder")

    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.url?.absoluteString, "https://api.openai.com/v1/models")
    XCTAssertEqual(request.url?.host, "api.openai.com")
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.allHTTPHeaderFields, ["Authorization": "Bearer credential-placeholder"])
    XCTAssertNil(request.httpBody)
  }

  func testSuccessIntersectsServerIDsWithVersionedCapabilities() async throws {
    let response = successResponse(ids: [
      "gpt-5.6-terra", "gpt-realtime-mini", "unreviewed-model",
    ])
    let result = try await OpenAIModelsValidator(
      transport: RecordingModelsTransport(response: response)
    ).validate(credential: "credential-placeholder")

    XCTAssertEqual(result.capabilities.catalogVersion, OpenAIModelCatalog.version)
    XCTAssertEqual(result.capabilities.textModelIDs, ["gpt-5.6-terra"])
    XCTAssertEqual(result.capabilities.realtimeModelIDs, ["gpt-realtime-mini"])
    XCTAssertFalse(result.capabilities.textModelIDs.contains("unreviewed-model"))
  }

  func testMalformedModelsResponseIsRejected() async {
    for data in [Data("{}".utf8), Data("{\"data\":[{\"id\":\"\"}]}".utf8), Data("not-json".utf8)] {
      await assertValidationError(
        .invalidResponse(requestID: "request-placeholder"),
        response: .init(
          data: data,
          statusCode: 200,
          headers: ["x-request-id": "request-placeholder"]
        )
      )
    }
  }

  func testStatusAndRedirectErrorsAreSanitized() async {
    await assertValidationError(.invalidCredential(requestID: "one"), status: 401, requestID: "one")
    await assertValidationError(.forbidden(requestID: "two"), status: 403, requestID: "two")
    await assertValidationError(
      .rateLimited(retryAfterSeconds: 17, requestID: "three"),
      response: .init(
        data: Data(),
        statusCode: 429,
        headers: ["Retry-After": "17", "X-Request-ID": "three"]
      )
    )
    await assertValidationError(.redirectBlocked, status: 307)
  }

  func testNetworkErrorsAreCategorizedWithoutUnderlyingDetails() async {
    let offline = OpenAIModelsValidator(
      transport: RecordingModelsTransport(error: URLError(.notConnectedToInternet))
    )
    let timeout = OpenAIModelsValidator(
      transport: RecordingModelsTransport(error: URLError(.timedOut))
    )

    do {
      _ = try await offline.validate(credential: "credential-placeholder")
      XCTFail("Expected offline error")
    } catch {
      XCTAssertEqual(error as? OpenAIValidationError, .networkUnavailable)
    }
    do {
      _ = try await timeout.validate(credential: "credential-placeholder")
      XCTFail("Expected timeout error")
    } catch {
      XCTAssertEqual(error as? OpenAIValidationError, .timedOut)
    }
  }

  func testRestrictedSessionHasNoPersistentStores() {
    let configuration = OpenAIModelsURLSessionTransport.restrictedConfiguration()
    XCTAssertNil(configuration.urlCache)
    XCTAssertNil(configuration.httpCookieStorage)
    XCTAssertNil(configuration.urlCredentialStorage)
    XCTAssertFalse(configuration.httpShouldSetCookies)
    XCTAssertEqual(configuration.httpCookieAcceptPolicy, .never)
    XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
  }

  private func assertValidationError(
    _ expected: OpenAIValidationError,
    status: Int,
    requestID: String? = nil
  ) async {
    await assertValidationError(
      expected,
      response: .init(
        data: Data(),
        statusCode: status,
        headers: requestID.map { ["x-request-id": $0] } ?? [:]
      )
    )
  }

  private func assertValidationError(
    _ expected: OpenAIValidationError,
    response: OpenAIModelsHTTPResponse
  ) async {
    do {
      _ = try await OpenAIModelsValidator(
        transport: RecordingModelsTransport(response: response)
      ).validate(credential: "credential-placeholder")
      XCTFail("Expected \(expected)")
    } catch {
      XCTAssertEqual(error as? OpenAIValidationError, expected)
    }
  }

  private func successResponse(ids: [String]) -> OpenAIModelsHTTPResponse {
    let data = try! JSONSerialization.data(withJSONObject: [
      "data": ids.map { ["id": $0] }
    ])
    return .init(data: data, statusCode: 200)
  }
}

private actor RecordingModelsTransport: OpenAIModelsTransport {
  private(set) var requests: [URLRequest] = []
  private let response: OpenAIModelsHTTPResponse?
  private let error: Error?

  init(response: OpenAIModelsHTTPResponse) {
    self.response = response
    error = nil
  }

  init(error: Error) {
    response = nil
    self.error = error
  }

  func send(_ request: URLRequest) async throws -> OpenAIModelsHTTPResponse {
    requests.append(request)
    if let error { throw error }
    return response!
  }
}
