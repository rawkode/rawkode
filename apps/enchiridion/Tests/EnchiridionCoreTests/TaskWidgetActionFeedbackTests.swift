import Foundation
import XCTest

@testable import EnchiridionCore

final class TaskWidgetActionFeedbackTests: XCTestCase {
  func testFailureSurvivesAnotherStoreAndExpires() {
    let suiteName = "TaskWidgetActionFeedbackTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let start = Date(timeIntervalSince1970: 1_000)
    TaskWidgetActionFeedbackStore(defaults: defaults).recordFailure(
      "Couldn’t complete that task.",
      at: start
    )

    let reader = TaskWidgetActionFeedbackStore(defaults: defaults)
    XCTAssertEqual(
      reader.current(at: start.addingTimeInterval(60))?.message,
      "Couldn’t complete that task."
    )
    XCTAssertNil(
      reader.current(
        at: start.addingTimeInterval(TaskWidgetActionFeedback.lifetime + 1)
      )
    )
    XCTAssertNil(reader.current(at: start.addingTimeInterval(30)))
  }

  func testSuccessfulActionCanClearPreviousFailure() {
    let suiteName = "TaskWidgetActionFeedbackTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let store = TaskWidgetActionFeedbackStore(defaults: defaults)
    store.recordFailure("Try again.")
    XCTAssertNotNil(store.current())

    store.clear()
    XCTAssertNil(store.current())
  }
}
