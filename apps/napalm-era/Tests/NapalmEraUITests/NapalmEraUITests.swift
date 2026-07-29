import XCTest

final class NapalmEraUITests: XCTestCase {
    func testAIOnlyMealCapture() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        app.launch()

        app.buttons["Log Nutrition"].tap()
        let composer = app.textFields["Describe your meal"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        composer.tap()
        composer.typeText("Chicken burrito bowl with guacamole")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.buttons["Save"].waitForExistence(timeout: 5))
        app.buttons["Save"].tap()

        let today = app.scrollViews.firstMatch
        for _ in 0..<4 where !app.staticTexts["Chicken burrito bowl"].exists {
            today.swipeUp()
        }
        XCTAssertTrue(app.staticTexts["Chicken burrito bowl"].waitForExistence(timeout: 5))
    }
}
