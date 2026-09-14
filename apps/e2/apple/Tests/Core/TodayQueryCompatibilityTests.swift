import Foundation
import XCTest
@testable import ApsidesCore

final class TodayQueryCompatibilityTests: XCTestCase {
    func testRetriesOnlyTheOlderTodaySchemaValidationFailure() throws {
        let message = "Cannot query field \"githubActivityPartial\" on type \"Today\". Did you mean \"githubActivity\"?"
        func response(_ errors: [[String: Any]], data: Any = NSNull()) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["errors": errors, "data": data])
        }
        XCTAssertTrue(TodayQueryCompatibility.lacksGitHubCompleteness(try response([["message": message]])))
        XCTAssertFalse(TodayQueryCompatibility.lacksGitHubCompleteness(try response([["message": "Unauthorized"]])))
        XCTAssertFalse(TodayQueryCompatibility.lacksGitHubCompleteness(try response([["message": message, "path": ["me", "today"]]])))
        XCTAssertFalse(TodayQueryCompatibility.lacksGitHubCompleteness(try response([["message": message], ["message": "Another unknown field"]])))
        XCTAssertFalse(TodayQueryCompatibility.lacksGitHubCompleteness(try response([["message": message]], data: ["me": NSNull()])))
        XCTAssertFalse(TodayQueryCompatibility.lacksGitHubCompleteness(Data("not json".utf8)))
    }
}
