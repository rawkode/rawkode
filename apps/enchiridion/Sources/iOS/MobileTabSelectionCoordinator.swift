/// Owns tab-selection semantics that SwiftUI's `TabView` does not expose directly.
///
/// A reselect of Today is represented by a new request token rather than a Boolean so
/// consumers can safely distinguish successive requests.
struct MobileTabSelectionCoordinator<Tab: Hashable> {
  private(set) var selectedTab: Tab
  private(set) var todayReturnRequest: Int

  private let todayTab: Tab

  init(selectedTab: Tab, todayTab: Tab, todayReturnRequest: Int = 0) {
    self.selectedTab = selectedTab
    self.todayTab = todayTab
    self.todayReturnRequest = todayReturnRequest
  }

  mutating func select(_ tab: Tab) {
    guard tab == selectedTab else {
      selectedTab = tab
      return
    }
    guard tab == todayTab else { return }

    // Saturation keeps the token nondecreasing and prevents an overflow trap.
    // Reaching this limit would require more than nine quintillion reselections.
    if todayReturnRequest < Int.max {
      todayReturnRequest += 1
    }
  }
}
