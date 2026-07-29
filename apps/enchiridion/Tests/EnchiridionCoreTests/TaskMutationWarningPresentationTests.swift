import Foundation
import XCTest

@testable import EnchiridionCore

final class TaskMutationWarningPresentationTests: XCTestCase {
  func testReminderWarningsArePrioritizedGroupedAndDeduplicated() throws {
    let pageID = PageID(rawValue: "task_warning_policy")
    let reminder = TaskMutationWarning(
      effect: .cancelReminder(pageID),
      message: "The reminder could not be scheduled: Service offline"
    )
    let spotlight = TaskMutationWarning(
      effect: .removeSpotlight(pageID),
      message: "The task could not be removed from Spotlight: Search offline"
    )

    let presentation = try XCTUnwrap(
      TaskMutationWarningPresentation.make(
        warnings: [spotlight, reminder, reminder]
      )
    )

    XCTAssertEqual(presentation.title, "Task Change Saved, but Reminder Failed")
    XCTAssertEqual(
      presentation.message,
      """
      The reminder could not be scheduled: Service offline

      The task could not be removed from Spotlight: Search offline
      """
    )
    XCTAssertEqual(presentation.recovery, .retryPendingEffects)
  }

  func testDeniedReminderAuthorizationOffersNotificationSettings() throws {
    let presentation = try XCTUnwrap(
      TaskMutationWarningPresentation.make(
        warnings: [
          TaskMutationWarning(
            effect: .cancelReminder(PageID(rawValue: "task_denied")),
            message: "Reminder authorization is denied."
          )
        ]
      )
    )

    XCTAssertEqual(presentation.title, "Task Change Saved, but Notifications Are Off")
    XCTAssertEqual(presentation.recovery, .notificationsSettings)
  }

  func testNoWarningsProduceNoPresentation() {
    XCTAssertNil(TaskMutationWarningPresentation.make(warnings: []))
  }
}
