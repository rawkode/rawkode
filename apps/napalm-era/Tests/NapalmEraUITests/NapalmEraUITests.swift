import XCTest

@MainActor
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
        let save = app.buttons["Save"]
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        save.tap()
        XCTAssertTrue(save.waitForNonExistence(timeout: 5))

        let today = app.scrollViews.firstMatch
        let meal = app.staticTexts["Chicken burrito bowl"]
        for _ in 0..<10 where !meal.exists {
            today.swipeUp()
        }
        XCTAssertTrue(meal.waitForExistence(timeout: 5))
    }

    func testLiveFoundationModelsTextMealCapture() throws {
        guard ProcessInfo.processInfo.environment["NAPALM_RUN_LIVE_AI_TEST"] == "1" else {
            throw XCTSkip("Requires a signed Apple Intelligence-capable physical device.")
        }

        let app = XCUIApplication()
        app.launch()

        app.buttons["Log Nutrition"].tap()
        let composer = app.textFields["Describe your meal"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("Chicken burrito bowl with guacamole")
        app.buttons["Send"].tap()

        XCTAssertTrue(app.buttons["Save"].waitForExistence(timeout: 60))
    }
}
