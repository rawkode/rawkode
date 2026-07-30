import XCTest

final class ScoutUITests: XCTestCase {
  private var fixtureURL: URL!

  override func setUpWithError() throws {
    continueAfterFailure = false
    fixtureURL = FileManager.default.temporaryDirectory.appending(path: "ScoutUITest-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: fixtureURL.appending(path: "Documents"), withIntermediateDirectories: true)
    XCTAssertTrue(FileManager.default.createFile(atPath: fixtureURL.appending(path: "Welcome.txt").path, contents: Data("Welcome to Scout".utf8)))
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: fixtureURL)
  }

  @MainActor
  func testFixtureLaunchShowsColumnBrowserAndCommandPalette() {
    let app = XCUIApplication()
    app.launchArguments = ["--scout-ui-fixture"]
    app.launchEnvironment["SCOUT_FIXTURE_ROOT"] = fixtureURL.path
    app.launch()

    XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Scout Fixture"].waitForExistence(timeout: 5))
    app.typeKey("k", modifierFlags: .command)
    XCTAssertTrue(app.textFields["Type a command"].waitForExistence(timeout: 2))
  }

  @MainActor
  func testViewSwitchingPreservesWindow() {
    let app = XCUIApplication()
    app.launchArguments = ["--scout-ui-fixture"]
    app.launchEnvironment["SCOUT_FIXTURE_ROOT"] = fixtureURL.path
    app.launch()
    XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 5))
    app.typeKey("2", modifierFlags: .command)
    app.typeKey("3", modifierFlags: .command)
    XCTAssertTrue(app.windows.firstMatch.exists)
  }
}
