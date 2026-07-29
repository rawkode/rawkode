import XCTest
@testable import Scout

final class ModelTests: XCTestCase {
  func testCommandMatchingIncludesKeywords() {
    let command = CommandDescriptor(id: "trash", title: "Move to Trash", subtitle: nil, systemImage: "trash", keyEquivalent: "⌘⌫", keywords: ["delete", "remove"])
    XCTAssertTrue(command.matches("delete"))
    XCTAssertFalse(command.matches("compress"))
  }

  func testWindowRestorationRoundTrip() throws {
    let state = BrowserWindowState(grantID: UUID(), relativePathComponents: ["Projects", "Scout"], viewMode: .columns, inspectorPresented: true, sidebarPresented: true, searchScopeAllRoots: false)
    let data = try JSONEncoder().encode(state)
    XCTAssertEqual(try JSONDecoder().decode(BrowserWindowState.self, from: data), state)
  }
}
