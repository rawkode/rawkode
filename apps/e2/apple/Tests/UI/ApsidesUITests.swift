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

    func testCachedWorkspaceOpensWithoutNetworkAfterRelaunch() {
        app.terminate()
        app.launchArguments = ["--ui-testing", "--reset-test-data", "--seed-cached-context"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Release week"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Bringing your day together…"].exists)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Last updated")).firstMatch.exists)
        openContext("People")
        XCTAssertTrue(app.staticTexts["Ada Lovelace"].waitForExistence(timeout: 5))

        relaunchPreservingData()
        XCTAssertTrue(app.staticTexts["Release week"].waitForExistence(timeout: 5))
        openContext("GitHub")
        XCTAssertTrue(app.staticTexts["rawkode/apsides"].waitForExistence(timeout: 5))
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

    func testTodayDockRecentersTimelineOnEveryTap() {
        launchDemo()
        #if os(iOS)
        let timeline = app.scrollViews["dayTimelineScroll"]
        let now = app.otherElements["dayTimelineNow"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 10))
        XCTAssertTrue(now.waitForExistence(timeout: 5))
        let initialY = now.frame.midY
        for _ in 0..<2 {
            if Calendar.current.component(.hour, from: Date()) >= 12 { timeline.swipeDown() }
            else { timeline.swipeUp() }
            XCTAssertGreaterThan(abs(now.frame.midY - initialY), 80)
            activate(app.buttons["recenterToday"])
            let centered = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                abs(now.frame.midY - initialY) < 8
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [centered], timeout: 5), .completed)
        }
        openDaySearch()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
        activate(app.searchFields.firstMatch)
        app.searchFields.firstMatch.typeText("Ada")
        XCTAssertTrue(app.staticTexts["Ada Lovelace"].waitForExistence(timeout: 5))
        captureScreenshot("Day search Ada")
        if !app.buttons["closeDaySearch"].exists {
            let cancelSearch = app.buttons["close"].firstMatch
            XCTAssertTrue(cancelSearch.waitForExistence(timeout: 5))
            activate(cancelSearch)
        }
        XCTAssertTrue(app.buttons["closeDaySearch"].waitForExistence(timeout: 5))
        activate(app.buttons["closeDaySearch"])
        XCTAssertTrue(app.buttons["recenterToday"].waitForExistence(timeout: 5))
        #endif
    }

    func testWeekSelectionAndTodayDockReturnToCurrentDay() {
        launchDemo()
        #if os(iOS)
        let today = Calendar.current.startOfDay(for: Date())
        let week = Calendar.current.dateInterval(of: .weekOfYear, for: today)!
        let other = Calendar.current.isDate(week.start, inSameDayAs: today)
            ? Calendar.current.date(byAdding: .day, value: 1, to: today)! : week.start
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar.current
        formatter.dateFormat = "yyyy-MM-dd"
        let otherButton = app.buttons["calendar-day-" + formatter.string(from: other)]
        let todayButton = app.buttons["calendar-day-" + formatter.string(from: today)]
        XCTAssertTrue(otherButton.waitForExistence(timeout: 10))
        activate(otherButton)
        XCTAssertTrue(otherButton.isSelected)
        XCTAssertFalse(app.otherElements["dayTimelineNow"].exists)
        captureScreenshot("Selected day in week")
        activate(app.buttons["recenterToday"])
        XCTAssertTrue(todayButton.isSelected)
        XCTAssertTrue(app.otherElements["dayTimelineNow"].waitForExistence(timeout: 5))
        captureScreenshot("Today restored from week")
        #endif
    }

    func testDayActivityShowsMeaningfulGitHubDetails() {
        launchDemo()
        let marker = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "GitHub, ")).firstMatch
        XCTAssertTrue(marker.waitForExistence(timeout: 10))
        activate(marker)
        XCTAssertTrue(app.staticTexts["Keep the thought, wherever you are"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Pull request #35 · Opened"].exists)
        XCTAssertTrue(app.staticTexts["Adds a calendar-first day view, quick access to today’s note, and touch selection for Supertags."].exists)
        XCTAssertTrue(app.links["openGitHubActivity"].exists || app.buttons["openGitHubActivity"].exists)
        captureScreenshot("GitHub activity detail Dawn")
        activate(app.buttons["Done"])
        openContext("Account & appearance")
        let palette = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Palette")).firstMatch
        activate(palette)
        chooseMenuItem("Rosé Pine Dark")
        activate(app.buttons["Done"])
        #if os(iOS)
        returnToPhoneDay()
        #endif
        captureScreenshot("GitHub timeline mark Dark")
        activate(marker)
        captureScreenshot("GitHub activity detail Dark")
    }

    func testDayTimelineFloatingDockInBothPalettes() {
        launchDemo()
        #if os(iOS)
        for id in ["openDailyNote", "dailyNotePreview", "daySearch", "recenterToday"] {
            XCTAssertTrue(app.buttons[id].waitForExistence(timeout: 10))
            XCTAssertTrue(app.buttons[id].isHittable)
        }
        XCTAssertFalse(app.tabBars.firstMatch.exists)
        XCTAssertFalse(webEditor.exists, "Home must show the day before opening the editor")
        showSampleCalendarEvents()
        captureScreenshot("Floating dock Dawn")
        openContext("Account & appearance")
        let palette = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Palette")).firstMatch
        XCTAssertTrue(palette.waitForExistence(timeout: 5))
        activate(palette)
        chooseMenuItem("Rosé Pine Dark")
        activate(app.buttons["Done"])
        returnToPhoneDay()
        showSampleCalendarEvents()
        captureScreenshot("Floating dock Dark")
        XCTAssertTrue(app.buttons["dailyNotePreview"].isHittable)
        relaunchPreservingData()
        openContext("Account & appearance")
        let restored = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Palette")).firstMatch
        XCTAssertTrue(restored.waitForExistence(timeout: 5))
        XCTAssertTrue(restored.label.contains("Dark") || (restored.value as? String ?? "").contains("Dark"))
        #endif
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
        openDailyNoteIfNeeded()
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

    func testTouchSelectionOffersSupertags() throws {
        let editor = try launchWebEditor()
        activate(editor)
        editor.typeText("\nTouch candidate")
        app.webViews.staticTexts["Touch candidate"].firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5)).doubleTap()
        let addTag = app.webViews.buttons["Add Supertag to selected text"]
        XCTAssertTrue(addTag.waitForExistence(timeout: 5))
        captureScreenshot("Touch selected text action")
        activate(addTag)
        XCTAssertTrue(app.webViews.staticTexts["Choose a Supertag"].waitForExistence(timeout: 5))
        let cancel = app.webViews.buttons["Cancel Supertag selection"]
        XCTAssertTrue(cancel.exists)
        captureScreenshot("Touch Supertag picker")
        activate(cancel)
        XCTAssertTrue((editor.value as? String ?? "").contains("Touch candidate"))
        activate(addTag)
        let colleague = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Colleague")).firstMatch
        XCTAssertTrue(colleague.waitForExistence(timeout: 5))
        activate(colleague)
        XCTAssertTrue(app.webViews.staticTexts["All changes saved"].waitForExistence(timeout: 10))
        XCTAssertFalse(cancel.exists)
        captureScreenshot("Touch Supertag applied")
        activate(app.buttons["closeDailyNote"])
        openDailyNoteIfNeeded()
        XCTAssertTrue(webEditor.waitForExistence(timeout: 10))
        XCTAssertTrue((webEditor.value as? String ?? "").contains("candidate"))
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
        openDailyNoteIfNeeded()
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
              !origin.isEmpty, !origin.hasPrefix("$(") else {
            throw XCTSkip("Set APSIDES_EDITOR_TEST_ORIGIN to the running editor fixture to test the real WKWebView.")
        }
        app.terminate()
        app.launchEnvironment["APSIDES_EDITOR_TEST_ORIGIN"] = origin
        app.launchArguments = ["--ui-testing", "--reset-test-data"]
        app.launch()
        openDailyNoteIfNeeded()
        XCTAssertTrue(webEditor.waitForExistence(timeout: 20))
        return webEditor
    }

    private func openToday() {
        #if os(iOS)
        if app.buttons["daySearch"].exists || app.buttons["closeDaySearch"].exists || app.navigationBars.buttons["Search"].exists {
            returnToPhoneDay()
            activate(app.buttons["recenterToday"])
            openDailyNoteIfNeeded()
            return
        }
        #endif
        let destination = app.staticTexts["Today"].firstMatch
        XCTAssertTrue(destination.waitForExistence(timeout: 5))
        activate(destination)
    }

    #if os(iOS)
    private func showSampleCalendarEvents() {
        let event = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Design review,")).firstMatch
        let timeline = app.scrollViews["dayTimelineScroll"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 5))
        for _ in 0..<12 {
            if event.exists && event.isHittable { break }
            if Calendar.current.component(.hour, from: Date()) >= 12 { timeline.swipeDown() }
            else { timeline.swipeUp() }
        }
        XCTAssertTrue(event.isHittable, "The calendar screenshot should include the sample design review")
    }

    private func returnToPhoneDay() {
        let closeNote = app.buttons["closeDailyNote"]
        if closeNote.exists { activate(closeNote) }
        for _ in 0..<5 {
            if app.buttons["daySearch"].isHittable { return }
            let closeSearch = app.buttons["closeDaySearch"]
            if closeSearch.exists && closeSearch.isHittable { activate(closeSearch); continue }
            let back = app.navigationBars.buttons.element(boundBy: 0)
            if back.exists && back.isHittable { activate(back) } else { break }
        }
        XCTAssertTrue(app.buttons["daySearch"].waitForExistence(timeout: 5))
    }

    private func openDaySearch() {
        returnToPhoneDay()
        activate(app.buttons["daySearch"])
        XCTAssertTrue(app.buttons["closeDaySearch"].waitForExistence(timeout: 5))
    }
    #endif

    private func openDailyNoteIfNeeded() {
        #if os(iOS)
        let control = app.buttons["openDailyNote"]
        if control.waitForExistence(timeout: 3) { activate(control) }
        #endif
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
        let closeNote = app.buttons["closeDailyNote"]
        if closeNote.exists { activate(closeNote) }
        #if os(iOS)
        openDaySearch()
        #endif
        let destination = app.buttons[name].firstMatch.exists ? app.buttons[name].firstMatch : app.staticTexts[name].firstMatch
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
        #if os(iOS)
        openDaySearch()
        #endif
        let capture = app.buttons["quickCapture"].firstMatch
        XCTAssertTrue(capture.waitForExistence(timeout: 10))
        activate(capture)
        XCTAssertTrue(app.textViews["captureText"].waitForExistence(timeout: 5))
    }

    private func openCaptures() {
        #if os(iOS)
        openContext("Captures")
        #else
        let destination = app.staticTexts["Captures"].firstMatch
        XCTAssertTrue(destination.waitForExistence(timeout: 5))
        activate(destination)
        #endif
    }

    private func relaunchPreservingData() {
        app.terminate()
        app.launchArguments.removeAll { $0 == "--reset-test-data" }
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
