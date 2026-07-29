import Foundation
import XCTest

@testable import EnchiridionCore

final class TaskReminderSchedulerTests: XCTestCase {
  private let vaultID = VaultID(rawValue: "vault_personal")

  func testRouteMapsNotificationActionsToTheExactTask() {
    let pageID = PageID(rawValue: "task-123")
    let route = TaskReminderScheduler.route(
      actionIdentifier: TaskReminderAction.complete.notificationActionIdentifier,
      userInfo: [
        TaskReminderScheduler.pageIDUserInfoKey: pageID.rawValue,
        TaskReminderScheduler.vaultIDUserInfoKey: vaultID.rawValue,
      ]
    )

    XCTAssertEqual(route, .init(identity: scoped(pageID), action: .complete))
  }

  func testDefaultNotificationTapOpensTheExactTask() {
    let pageID = PageID(rawValue: "task-123")
    let route = TaskReminderScheduler.route(
      actionIdentifier: "default",
      userInfo: [
        TaskReminderScheduler.pageIDUserInfoKey: pageID.rawValue,
        TaskReminderScheduler.vaultIDUserInfoKey: vaultID.rawValue,
      ],
      defaultActionIdentifier: "default"
    )

    XCTAssertEqual(route, .init(identity: scoped(pageID), action: .open))
  }

  func testRouteRejectsUnknownActionsAndMissingTaskIDs() {
    XCTAssertNil(
      TaskReminderScheduler.route(
        actionIdentifier: "unexpected",
        userInfo: [
          TaskReminderScheduler.pageIDUserInfoKey: "task-123",
          TaskReminderScheduler.vaultIDUserInfoKey: vaultID.rawValue,
        ]
      ))
    XCTAssertNil(
      TaskReminderScheduler.route(
        actionIdentifier: TaskReminderAction.snooze.notificationActionIdentifier,
        userInfo: [:]
      ))
  }

  func testSnoozePlanUsesTheRequestedIntervalWithoutChangingTheTaskID() {
    let pageID = PageID(rawValue: "task-123")
    let now = Date(timeIntervalSince1970: 1_817_000_000)
    let plan = TaskReminderActionPlan.make(
      route: .init(identity: scoped(pageID), action: .snooze),
      now: now,
      snoozeInterval: 15 * 60
    )

    XCTAssertEqual(plan, .snooze(scoped(pageID), until: now.addingTimeInterval(15 * 60)))
  }

  func testTaskURLRoutesToTheExactTask() throws {
    let pageID = PageID(rawValue: "task-123")
    let url = try XCTUnwrap(TaskReminderScheduler.taskURL(for: scoped(pageID)))

    XCTAssertEqual(TaskDeepLinkRoute(url: url), .task(scoped(pageID), list: .today))
  }

  private func scoped(_ pageID: PageID) -> VaultScopedNodeID {
    .init(vaultID: vaultID, nodeID: pageID)
  }
}
