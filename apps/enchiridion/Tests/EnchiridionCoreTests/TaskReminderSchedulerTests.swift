import Foundation
import XCTest
@testable import EnchiridionCore

final class TaskReminderSchedulerTests: XCTestCase {
  func testRouteMapsNotificationActionsToTheExactTask() {
    let pageID = PageID(rawValue: "task-123")
    let route = TaskReminderScheduler.route(
      actionIdentifier: TaskReminderAction.complete.notificationActionIdentifier,
      userInfo: [TaskReminderScheduler.pageIDUserInfoKey: pageID.rawValue]
    )

    XCTAssertEqual(route, .init(pageID: pageID, action: .complete))
  }

  func testDefaultNotificationTapOpensTheExactTask() {
    let pageID = PageID(rawValue: "task-123")
    let route = TaskReminderScheduler.route(
      actionIdentifier: "default",
      userInfo: [TaskReminderScheduler.pageIDUserInfoKey: pageID.rawValue],
      defaultActionIdentifier: "default"
    )

    XCTAssertEqual(route, .init(pageID: pageID, action: .open))
  }

  func testRouteRejectsUnknownActionsAndMissingTaskIDs() {
    XCTAssertNil(TaskReminderScheduler.route(
      actionIdentifier: "unexpected",
      userInfo: [TaskReminderScheduler.pageIDUserInfoKey: "task-123"]
    ))
    XCTAssertNil(TaskReminderScheduler.route(
      actionIdentifier: TaskReminderAction.snooze.notificationActionIdentifier,
      userInfo: [:]
    ))
  }

  func testSnoozePlanUsesTheRequestedIntervalWithoutChangingTheTaskID() {
    let pageID = PageID(rawValue: "task-123")
    let now = Date(timeIntervalSince1970: 1_817_000_000)
    let plan = TaskReminderActionPlan.make(
      route: .init(pageID: pageID, action: .snooze),
      now: now,
      snoozeInterval: 15 * 60
    )

    XCTAssertEqual(plan, .snooze(pageID, until: now.addingTimeInterval(15 * 60)))
  }

  func testTaskURLTargetsTasksAndCarriesTheExactTaskID() throws {
    let pageID = PageID(rawValue: "task-123")
    let components = try XCTUnwrap(
      TaskReminderScheduler.taskURL(for: pageID)
        .flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
    )

    XCTAssertEqual(components.scheme, "enchiridion")
    XCTAssertEqual(components.host, "tasks")
    XCTAssertEqual(components.path, "/today")
    XCTAssertEqual(components.queryItems?.first(where: { $0.name == "task" })?.value, pageID.rawValue)
  }
}
