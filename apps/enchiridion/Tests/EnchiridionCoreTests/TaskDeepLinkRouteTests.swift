import Foundation
import XCTest

@testable import EnchiridionCore

final class TaskDeepLinkRouteTests: XCTestCase {
  func testRoutesEverySmartList() throws {
    for list in TaskSmartList.allCases {
      let url = try XCTUnwrap(URL(string: "enchiridion://tasks/\(list.rawValue)"))
      XCTAssertEqual(TaskDeepLinkRoute(url: url), .list(list))
    }
  }

  func testTaskRoutePreservesItsFallbackList() throws {
    let url = try XCTUnwrap(URL(string: "enchiridion://tasks/upcoming?task=task-123"))

    XCTAssertEqual(
      TaskDeepLinkRoute(url: url),
      .task(PageID(rawValue: "task-123"), list: .upcoming)
    )
  }

  func testQuickAddRouteUsesTheRequestedList() throws {
    let url = try XCTUnwrap(URL(string: "enchiridion://tasks/inbox?quickAdd=1"))

    XCTAssertEqual(TaskDeepLinkRoute(url: url), .quickAdd(.inbox))
  }

  func testExactTaskTakesPrecedenceOverQuickAdd() throws {
    let url = try XCTUnwrap(
      URL(string: "enchiridion://tasks/today?quickAdd=1&task=task-123")
    )

    XCTAssertEqual(
      TaskDeepLinkRoute(url: url),
      .task(PageID(rawValue: "task-123"), list: .today)
    )
  }

  func testEmptyPathDefaultsToInbox() throws {
    let url = try XCTUnwrap(URL(string: "enchiridion://tasks"))

    XCTAssertEqual(TaskDeepLinkRoute(url: url), .list(.inbox))
  }

  func testRejectsForeignAndMalformedRoutes() throws {
    let routes = try [
      XCTUnwrap(URL(string: "https://tasks/today")),
      XCTUnwrap(URL(string: "enchiridion://calendar/today")),
      XCTUnwrap(URL(string: "enchiridion://tasks/unknown")),
      XCTUnwrap(URL(string: "enchiridion://tasks/today/extra")),
    ]

    for url in routes {
      XCTAssertNil(TaskDeepLinkRoute(url: url), "Unexpectedly accepted \(url)")
    }
  }

  func testEmptyTaskIdentifierFallsBackToTheListRoute() throws {
    let url = try XCTUnwrap(URL(string: "enchiridion://tasks/today?task=%20%20"))

    XCTAssertEqual(TaskDeepLinkRoute(url: url), .list(.today))
  }

  func testValidTaskSurvivesStoreValidation() {
    let pageID = PageID(rawValue: "task-123")
    let route = TaskDeepLinkRoute.task(pageID, list: .today)

    XCTAssertEqual(route.validated(against: [page(id: pageID, isTask: true)]), route)
  }

  func testMissingAndNonTaskPagesFallBackToTheRequestedList() {
    let pageID = PageID(rawValue: "task-123")
    let route = TaskDeepLinkRoute.task(pageID, list: .upcoming)

    XCTAssertEqual(route.validated(against: []), .list(.upcoming))
    XCTAssertEqual(
      route.validated(against: [page(id: pageID, isTask: false)]),
      .list(.upcoming)
    )
  }

  func testDeletedTaskFallsBackToTheRequestedList() {
    let pageID = PageID(rawValue: "task-123")
    let route = TaskDeepLinkRoute.task(pageID, list: .today)

    XCTAssertEqual(
      route.validated(against: [page(id: pageID, isTask: true, isDeleted: true)]),
      .list(.today)
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
}
