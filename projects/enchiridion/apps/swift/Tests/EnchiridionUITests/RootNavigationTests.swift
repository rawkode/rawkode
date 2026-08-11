// RootNavigationTests.swift
// EnchiridionUITests
//
// Task #85 (P7 integration wave). `RootTab` (RootNavigation.swift) is the
// one piece of the real navigation shell that lives in an SPM target at
// all — the actual `TabView`/`NavigationSplitView` shells
// (`Sources/iOS/RootView.swift`/`Sources/macOS/RootView.swift`) are Xcode
// app-target sources with no SwiftPM test target to run them under (see
// `Package.swift`: neither directory is listed as a target), so THAT
// wiring is verified only by the real `xcodebuild build` this task's
// verification bar requires, not by `swift test` — stated here plainly
// rather than left implicit. What CAN be asserted by a plain unit test:
// the destination vocabulary itself is complete and stable (exactly the
// three real P7 destinations, each with a distinct title/icon) — a
// regression here (e.g. someone accidentally dropping a case, or two tabs
// silently sharing a title) would be a real, catchable bug.
//
// TASK #91 UPDATE: the same "no SwiftPM target reaches real SwiftUI
// navigation lifecycle" limitation stated above is still true — this file
// still cannot exercise `NavigationSplitView`'s actual branch-identity
// teardown/rebuild of a destination. What #91 adds is
// `AssistantHomeViewOwnershipTests.swift`, a real automated test of the
// underlying mechanism that fix relies on (the hoisted
// `AssistantConversationController`'s transcript and pending write
// proposals surviving being handed to repeatedly, independently
// reconstructed `AssistantHomeView` values) — see that file's header for
// exactly what it does and does not prove.
import XCTest

@testable import EnchiridionUI

final class RootNavigationTests: XCTestCase {
  func testThereAreExactlyTheFourRealDestinations() {
    // task #96 (plan §Live Backend Connectivity (P8) scope item 5) added
    // `.devices` to P7's original three.
    XCTAssertEqual(RootTab.allCases, [.today, .tasks, .assistant, .devices])
  }

  func testEveryTabHasADistinctTitleAndSystemImage() {
    let titles = Set(RootTab.allCases.map(\.title))
    let images = Set(RootTab.allCases.map(\.systemImage))
    XCTAssertEqual(titles.count, RootTab.allCases.count, "every destination needs its own distinct title")
    XCTAssertEqual(images.count, RootTab.allCases.count, "every destination needs its own distinct icon")
  }

  func testIdMatchesRawValueForStableSwiftUIIdentity() {
    for tab in RootTab.allCases {
      XCTAssertEqual(tab.id, tab.rawValue)
    }
  }
}
