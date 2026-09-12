import XCTest

@MainActor
final class ApsidesUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        await MainActor.run {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "rawkode.academy.enchiridion")
        app.launchArguments = ["--ui-testing", "--reset-test-data"]
        app.launch()
        }
    }

    override func tearDown() async throws {
        await MainActor.run {
        app.terminate()
        app = nil
        }
    }

    func testFreshLaunchHasEmptyDaybookAndCaptures() {
        openContext("On this device")
        let editor = app.textViews["daybookEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        XCTAssertEqual(editor.value as? String ?? "", "")

        openCaptures()
        XCTAssertTrue(app.staticTexts["A place for passing thoughts"].waitForExistence(timeout: 5))
    }

    func testCapturePersistsAfterRelaunch() {
        let thought = "Remember the design review \(UUID().uuidString)"
        openCapture()
        let editor = app.textViews["captureText"]
        activate(editor)
        editor.typeText(thought)
        let save = app.buttons["saveCapture"]
        XCTAssertTrue(save.isEnabled)
        activate(save)
        openCaptures()
        XCTAssertTrue(app.staticTexts[thought].waitForExistence(timeout: 5))

        relaunchPreservingData()
        openCaptures()
        XCTAssertTrue(app.staticTexts[thought].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts.matching(identifier: thought).count, 1)
    }

    func testDaybookPersistsAfterImmediateRelaunch() {
        openContext("On this device")
        let thought = "A durable daily thought \(UUID().uuidString)"
        let editor = app.textViews["daybookEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        activate(editor)
        editor.typeText(thought)
        // No arbitrary save delay: leaving immediately must preserve the input.
        relaunchPreservingData()
        openContext("On this device")
        let restored = app.textViews["daybookEditor"]
        XCTAssertTrue(restored.waitForExistence(timeout: 10))
        let savedText = NSPredicate(format: "value == %@", thought)
        let check = XCTNSPredicateExpectation(predicate: savedText, object: restored)
        XCTAssertEqual(XCTWaiter.wait(for: [check], timeout: 5), .completed)
    }

    func testEmptyAndWhitespaceOnlyCaptureCannotBeSaved() {
        openCapture()
        let save = app.buttons["saveCapture"]
        XCTAssertFalse(save.isEnabled)
        let editor = app.textViews["captureText"]
        activate(editor)
        editor.typeText("   \n  ")
        XCTAssertFalse(save.isEnabled)

        activate(app.buttons["Close"])
        openCaptures()
        XCTAssertTrue(app.staticTexts["A place for passing thoughts"].waitForExistence(timeout: 5))
    }

    func testCalendarTimelineAndEventDetail() {
        launchDemo()
        openContext("Day calendar")
        // All-day content belongs outside the timed scroll region.
        XCTAssertTrue(app.buttons["Release week"].waitForExistence(timeout: 5))
        captureScreenshot("Calendar Dawn")
        let layout = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Calendar layout")).firstMatch
        XCTAssertTrue(layout.waitForExistence(timeout: 5))
        activate(layout)
        chooseMenuItem("Agenda list")

        let event = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Design review")).firstMatch
        XCTAssertTrue(event.waitForExistence(timeout: 5))
        #if os(iOS)
        if !event.isHittable { app.swipeUp() }
        #endif
        activate(event)
        let eventTime = app.descendants(matching: .any)["eventTime"].firstMatch
        XCTAssertTrue(eventTime.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Design review"].exists)
        activate(app.buttons["Done"])
        XCTAssertTrue(layout.waitForExistence(timeout: 5))
    }

    func testPersonOpensContactDetail() {
        launchDemo()
        openContext("People")
        let ada = app.staticTexts["Ada Lovelace"].firstMatch
        XCTAssertTrue(ada.waitForExistence(timeout: 5))
        activate(ada)
        let email = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", "Email Ada Lovelace at ada@example.test")
        ).firstMatch
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        XCTAssertTrue(email.isHittable)
        captureScreenshot("Person detail")
        // Do not activate the mail link: this test must not launch external mail.
    }

    func testRepositoryOpensTimelineAndFiltersActivityType() {
        launchDemo()
        openContext("GitHub")
        let repository = app.staticTexts["rawkode/apsides"].firstMatch
        XCTAssertTrue(repository.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["1 activity"].exists)
        activate(repository)
        let activity = app.staticTexts["Keep the thought, wherever you are"]
        XCTAssertTrue(activity.waitForExistence(timeout: 5))
        let filter = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Activity type")).firstMatch
        #if os(macOS)
        let picker = app.popUpButtons["Activity type"]
        activate(picker.exists ? picker : filter)
        #else
        XCTAssertTrue(filter.waitForExistence(timeout: 5))
        activate(filter)
        #endif
        chooseMenuItem("Pull requests")
        XCTAssertTrue(activity.waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts.matching(identifier: "Keep the thought, wherever you are").count, 1)
        XCTAssertFalse(app.staticTexts["pullRequest"].exists)
        captureScreenshot("GitHub timeline")
    }

    func testPalettePersistsAfterRelaunch() {
        launchDemo()
        openContext("Account & appearance")
        let palette = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Palette")).firstMatch
        XCTAssertTrue(palette.waitForExistence(timeout: 5))
        activate(palette)
        chooseMenuItem("Rosé Pine Dark")
        activate(app.buttons["Done"])
        relaunchPreservingData()
        captureScreenshot("Today Dark")
        openContext("Account & appearance")
        let restored = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Palette")).firstMatch
        XCTAssertTrue(restored.waitForExistence(timeout: 5))
        XCTAssertTrue(restored.label.contains("Dark") || (restored.value as? String ?? "").contains("Dark"))
    }

    func testWebEditorHasOneDocumentHeadingAndNoDesktopChrome() throws {
        try launchWebEditor()
        let web = app.webViews.firstMatch
        XCTAssertEqual(web.staticTexts.matching(identifier: "Today").count, 1)
        let heading = web.staticTexts["Today"].firstMatch
        let format = web.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Format text")).firstMatch
        XCTAssertTrue(format.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(format.frame.midY, heading.frame.minY)
        XCTAssertLessThanOrEqual(format.frame.midY, heading.frame.maxY)
        for label in ["Supertags", "Google", "Accounts", "Commands", "Clear", "Export"] {
            XCTAssertFalse(web.links[label].exists, "Desktop navigation leaked into the editor: \(label)")
            XCTAssertFalse(web.buttons[label].exists, "Desktop action leaked into the editor: \(label)")
        }
        XCTAssertFalse(app.buttons["Device notes"].exists)
        XCTAssertFalse(app.staticTexts["Device notes"].exists)
        captureScreenshot("Embedded editor Dawn")
    }

    func testWebEditorSlashCommandInsertsHeading() throws {
        let editor = try launchWebEditor()
        activate(editor)
        editor.typeText("\n/heading")
        let heading = app.webViews.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", "Heading 1")
        ).firstMatch
        XCTAssertTrue(heading.waitForExistence(timeout: 5))
        activate(heading)
        editor.typeText("Native editor heading")
        XCTAssertTrue((editor.value as? String ?? "").contains("Native editor heading"))
        XCTAssertFalse(app.webViews.staticTexts["Insert a block"].exists)
        captureScreenshot("Embedded editor slash command")
    }

    func testWebEditorMentionListsAndInsertsEntity() throws {
        let editor = try launchWebEditor()
        let entity = ProcessInfo.processInfo.environment["APSIDES_EDITOR_TEST_ENTITY"] ?? "Ada Lovelace"
        activate(editor)
        editor.typeText("\n@\(entity)")
        let match = app.webViews.descendants(matching: .any).matching(
            NSPredicate(format: "label BEGINSWITH %@", "@ " + entity)
        ).firstMatch
        XCTAssertTrue(match.waitForExistence(timeout: 10), "The fixture entity must appear in @ suggestions")
        captureScreenshot("Embedded editor mention suggestions")
        activate(match)
        XCTAssertTrue((editor.value as? String ?? "").contains(entity))
        XCTAssertFalse(app.webViews.staticTexts["Mention an entity"].exists)
        captureScreenshot("Embedded editor mention")
        XCTAssertTrue(app.webViews.staticTexts["All changes saved"].waitForExistence(timeout: 10))
        relaunchPreservingData()
        XCTAssertTrue(webEditor.waitForExistence(timeout: 15))
        XCTAssertTrue((webEditor.value as? String ?? "").contains(entity))
        // A canonical mention renders with an @ prefix too. Opening its entity
        // proves this is an interactive reference rather than retained plain text.
        let mention = app.webViews.staticTexts["@" + entity].firstMatch
        XCTAssertTrue(mention.waitForExistence(timeout: 5))
        activate(mention)
        XCTAssertTrue(app.webViews.staticTexts[entity].waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.buttons["Back"].exists)
        captureScreenshot("Embedded editor linked entity")
    }

    func testWebEditorReturnsAfterPaletteChangeAndRelaunch() throws {
        try launchWebEditor()
        openContext("Account & appearance")
        let palette = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Palette")).firstMatch
        XCTAssertTrue(palette.waitForExistence(timeout: 5))
        activate(palette)
        chooseMenuItem("Rosé Pine Dark")
        activate(app.buttons["Done"])
        openToday()
        XCTAssertTrue(webEditor.waitForExistence(timeout: 10))
        captureScreenshot("Embedded editor Dark")
        relaunchPreservingData()
        XCTAssertTrue(webEditor.waitForExistence(timeout: 15))
        openContext("Account & appearance")
        let restored = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Palette")).firstMatch
        XCTAssertTrue(restored.waitForExistence(timeout: 5))
        XCTAssertTrue(restored.label.contains("Dark") || (restored.value as? String ?? "").contains("Dark"))
    }

    private var webEditor: XCUIElement {
        app.webViews.textViews["Note editor"].firstMatch
    }

    @discardableResult
    private func launchWebEditor() throws -> XCUIElement {
        guard let origin = ProcessInfo.processInfo.environment["APSIDES_EDITOR_TEST_ORIGIN"],
              !origin.isEmpty else {
            throw XCTSkip("Set APSIDES_EDITOR_TEST_ORIGIN to the running editor fixture to test the real WKWebView.")
        }
        app.terminate()
        app.launchEnvironment["APSIDES_EDITOR_TEST_ORIGIN"] = origin
        app.launchArguments = ["--ui-testing", "--reset-test-data"]
        app.launch()
        XCTAssertTrue(webEditor.waitForExistence(timeout: 20))
        return webEditor
    }

    private func openToday() {
        #if os(iOS)
        let tab = app.tabBars.buttons["Today"]
        if tab.exists { activate(tab); return }
        #endif
        let destination = app.staticTexts["Today"].firstMatch
        XCTAssertTrue(destination.waitForExistence(timeout: 5))
        activate(destination)
    }

    private func captureScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func launchDemo() {
        app.terminate()
        app.launchArguments = ["--ui-testing", "--reset-test-data", "--demo"]
        app.launch()
    }

    private func openContext(_ name: String) {
        #if os(iOS)
        let context = app.tabBars.buttons["Context"]
        if context.exists { activate(context) }
        else if name == "Account & appearance" {
            activate(app.buttons["Settings"])
            return
        }
        #endif
        let destination = name == "Account & appearance" ? app.buttons[name].firstMatch : app.staticTexts[name].firstMatch
        XCTAssertTrue(destination.waitForExistence(timeout: 5))
        activate(destination)
    }

    private func chooseMenuItem(_ title: String) {
        #if os(macOS)
        let item = app.menuItems[title]
        #else
        let item = app.buttons[title]
        #endif
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        activate(item)
    }

    private func openCapture() {
        let capture = app.buttons["quickCapture"].firstMatch
        XCTAssertTrue(capture.waitForExistence(timeout: 10))
        activate(capture)
        XCTAssertTrue(app.textViews["captureText"].waitForExistence(timeout: 5))
    }

    private func openCaptures() {
        #if os(iOS)
        let tab = app.tabBars.buttons["Captures"]
        if tab.exists {
            activate(tab)
            return
        }
        #endif
        // The regular-width iPad and Mac use a sidebar instead of phone tabs.
        let destination = app.staticTexts["Captures"].firstMatch
        XCTAssertTrue(destination.waitForExistence(timeout: 5))
        activate(destination)
    }

    private func relaunchPreservingData() {
        app.terminate()
        app.launchArguments = ["--ui-testing"]
        app.launch()
    }

    private func activate(_ element: XCUIElement) {
        #if os(macOS)
        element.click()
        #else
        element.tap()
        #endif
    }
}
