import Foundation
import XCTest

@testable import EnchiridionCore

@MainActor
final class GoogleCalendarProviderErrorTests: XCTestCase {
  func testTokenInvalidGrantIsAuthorizationRevoked() {
    XCTAssertEqual(
      GoogleCalendarProvider.classifyHTTPFailure(
        statusCode: 400,
        data: Data(#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#.utf8),
        tokenEndpoint: true
      ),
      .authorizationRevoked
    )
  }

  func testGenericTokenBadRequestRemainsAPIError() {
    XCTAssertEqual(
      GoogleCalendarProvider.classifyHTTPFailure(
        statusCode: 400,
        data: Data(#"{"error":"invalid_request","error_description":"Missing parameter."}"#.utf8),
        tokenEndpoint: true
      ),
      .api("Missing parameter.")
    )
  }

  func testCalendarUnauthorizedIsAuthorizationRevoked() {
    XCTAssertEqual(
      GoogleCalendarProvider.classifyHTTPFailure(
        statusCode: 401,
        data: Data(#"{"error":{"message":"Invalid Credentials"}}"#.utf8),
        tokenEndpoint: false
      ),
      .authorizationRevoked
    )
  }

  func testTransientCalendarFailureRemainsAPIError() {
    XCTAssertEqual(
      GoogleCalendarProvider.classifyHTTPFailure(
        statusCode: 500,
        data: Data(#"{"error":{"message":"Backend Error"}}"#.utf8),
        tokenEndpoint: false
      ),
      .api("Backend Error")
    )
  }
}
