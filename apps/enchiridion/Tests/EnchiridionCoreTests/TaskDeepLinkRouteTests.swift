import Foundation
import XCTest

@testable import EnchiridionCore

final class TaskDeepLinkRouteTests: XCTestCase {
  private let vaultID = VaultID(rawValue: "vault_personal")

  func testRoutesEverySmartList() throws {
    for list in TaskSmartList.allCases {
      let url = try XCTUnwrap(
        URL(string: "enchiridion://tasks/\(list.rawValue)?vault=\(vaultID.rawValue)")
      )
      XCTAssertEqual(TaskDeepLinkRoute(url: url), .list(list, vaultID: vaultID))
    }
  }

  func testTaskRoutePreservesItsFallbackList() throws {
    let url = try XCTUnwrap(
      URL(string: "enchiridion://tasks/upcoming?vault=\(vaultID.rawValue)&task=task-123")
    )

    XCTAssertEqual(
      TaskDeepLinkRoute(url: url),
      .task(scoped("task-123"), list: .upcoming)
    )
  }

  func testQuickAddRouteUsesTheRequestedList() throws {
    let url = try XCTUnwrap(
      URL(string: "enchiridion://tasks/inbox?vault=\(vaultID.rawValue)&quickAdd=1")
    )

    XCTAssertEqual(TaskDeepLinkRoute(url: url), .quickAdd(.inbox, vaultID: vaultID))
  }

  func testExactTaskTakesPrecedenceOverQuickAdd() throws {
    let url = try XCTUnwrap(
      URL(
        string: "enchiridion://tasks/today?vault=\(vaultID.rawValue)&quickAdd=1&task=task-123"
      )
    )

    XCTAssertEqual(
      TaskDeepLinkRoute(url: url),
      .task(scoped("task-123"), list: .today)
    )
  }

  func testEmptyPathDefaultsToInbox() throws {
    let url = try XCTUnwrap(URL(string: "enchiridion://tasks?vault=\(vaultID.rawValue)"))

    XCTAssertEqual(TaskDeepLinkRoute(url: url), .list(.inbox, vaultID: vaultID))
  }

  func testRejectsForeignAndMalformedRoutes() throws {
    let routes = try [
      XCTUnwrap(URL(string: "https://tasks/today")),
      XCTUnwrap(URL(string: "enchiridion://calendar/today")),
      XCTUnwrap(URL(string: "enchiridion://tasks/unknown")),
      XCTUnwrap(URL(string: "enchiridion://tasks/today/extra")),
      XCTUnwrap(URL(string: "enchiridion://tasks/today")),
    ]

    for url in routes {
      XCTAssertNil(TaskDeepLinkRoute(url: url), "Unexpectedly accepted \(url)")
    }
  }

  func testEmptyTaskIdentifierFallsBackToTheListRoute() throws {
    let url = try XCTUnwrap(
      URL(string: "enchiridion://tasks/today?vault=\(vaultID.rawValue)&task=%20%20")
    )

    XCTAssertEqual(TaskDeepLinkRoute(url: url), .list(.today, vaultID: vaultID))
  }

  func testValidTaskSurvivesStoreValidation() {
    let pageID = PageID(rawValue: "task-123")
    let route = TaskDeepLinkRoute.task(scoped(pageID.rawValue), list: .today)

    XCTAssertEqual(route.validated(against: [page(id: pageID, isTask: true)]), route)
  }

  func testMissingAndNonTaskPagesFallBackToTheRequestedList() {
    let pageID = PageID(rawValue: "task-123")
    let route = TaskDeepLinkRoute.task(scoped(pageID.rawValue), list: .upcoming)

    XCTAssertEqual(route.validated(against: []), .list(.upcoming, vaultID: vaultID))
    XCTAssertEqual(
      route.validated(against: [page(id: pageID, isTask: false)]),
      .list(.upcoming, vaultID: vaultID)
    )
  }

  func testDeletedTaskFallsBackToTheRequestedList() {
    let pageID = PageID(rawValue: "task-123")
    let route = TaskDeepLinkRoute.task(scoped(pageID.rawValue), list: .today)

    XCTAssertEqual(
      route.validated(against: [page(id: pageID, isTask: true, isDeleted: true)]),
      .list(.today, vaultID: vaultID)
    )
  }

  private func page(id: PageID, isTask: Bool, isDeleted: Bool = false) -> PageSnapshot {
    PageSnapshot(
      id: id,
      kind: .free,
      title: "Example",
      plainText: "",
      document: Data(),
      heads: .empty,
      createdAt: .distantPast,
      modifiedAt: .distantPast,
      deletedAt: isDeleted ? .distantPast : nil,
      objectMetadata: .init(supertagIDs: isTask ? [BuiltInSupertags.task] : [])
    )
  }

  private func scoped(_ pageID: String) -> VaultScopedNodeID {
    .init(vaultID: vaultID, nodeID: .init(rawValue: pageID))
  }
}
