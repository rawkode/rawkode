import XCTest

@testable import Enchiridion

@available(iOS 26.0, *)
final class MobileTabSelectionCoordinatorTests: XCTestCase {
  private enum Tab: Hashable {
    case today
    case tasks
    case library
  }

  func testSelectingTodayFromAnotherTabDoesNotRequestReturnToToday() {
    var coordinator = MobileTabSelectionCoordinator(selectedTab: Tab.tasks, todayTab: .today)

    coordinator.select(.today)

    XCTAssertEqual(coordinator.selectedTab, .today)
    XCTAssertEqual(coordinator.todayReturnRequest, 0)
  }

  func testReselectingTodayEmitsOneDistinctRequestPerTap() {
    var coordinator = MobileTabSelectionCoordinator(selectedTab: Tab.today, todayTab: .today)

    coordinator.select(.today)
    XCTAssertEqual(coordinator.todayReturnRequest, 1)

    coordinator.select(.today)
    XCTAssertEqual(coordinator.todayReturnRequest, 2)
  }

  func testReselectingAnotherTabIsInert() {
    var coordinator = MobileTabSelectionCoordinator(selectedTab: Tab.tasks, todayTab: .today)

    coordinator.select(.tasks)

    XCTAssertEqual(coordinator.selectedTab, .tasks)
    XCTAssertEqual(coordinator.todayReturnRequest, 0)
  }

  func testRequestTokenSaturatesWithoutOverflowing() {
    var coordinator = MobileTabSelectionCoordinator(
      selectedTab: Tab.today,
      todayTab: .today,
      todayReturnRequest: .max
    )

    coordinator.select(.today)

    XCTAssertEqual(coordinator.todayReturnRequest, .max)
  }
}
