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

    func testConversationCanSwitchToTypingWithoutMicrophone() {
        #if os(iOS)
        launchDemo()
        openWorkspaceSidebar()
        activate(app.buttons["openVoiceConversation"])
        let mode = app.segmentedControls["conversationInputMode"]
        XCTAssertTrue(mode.waitForExistence(timeout: 5))
        activate(mode.buttons["Type"])
        XCTAssertTrue(app.textFields["agentMessageInput"].waitForExistence(timeout: 5) || app.textViews["agentMessageInput"].exists)
        XCTAssertFalse(app.buttons["startVoiceConversation"].exists)
        captureScreenshot("Type to Enchiridion")
        activate(mode.buttons["Speak"])
        XCTAssertFalse(app.buttons["sendAgentMessage"].exists)
        #endif
    }

    func testWorkspaceSidebarMenuSwipeAndNotesAccess() {
        #if os(iOS)
        launchDemo()
        let note = app.buttons["dailyNotePreview"]
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        XCTAssertTrue(note.isHittable)
        XCTAssertFalse(app.buttons["openDailyNote"].exists)
        openWorkspaceSidebar()
        for id in ["openTasks", "openVoiceConversation", "daySearch", "quickCapture", "todaySettings"] {
            XCTAssertTrue(app.buttons[id].exists, "Missing sidebar action: \(id)")
        }
        captureScreenshot("Workspace sidebar Dawn")
        activate(app.buttons["sidebarClose"])
        XCTAssertTrue(note.isHittable)
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.48))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.70, dy: 0.48))
        start.press(forDuration: 0.05, thenDragTo: end)
        XCTAssertTrue(app.buttons["sidebarClose"].waitForExistence(timeout: 5))
        activate(app.buttons["openTasks"])
        XCTAssertTrue(app.staticTexts["Shape the voice workspace"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["sidebarClose"].exists)
        returnToPhoneDay()
        XCTAssertTrue(note.isHittable)
        let noteHandle = note.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        noteHandle.press(forDuration: 0.05, thenDragTo: noteHandle.withOffset(CGVector(dx: 0, dy: -180)))
        XCTAssertTrue(app.buttons["closeDailyNote"].waitForExistence(timeout: 5))
        #endif
    }

    func testTasksCaptureRemainsVisibleOffline() throws {
        app.terminate()
        app.launchArguments += ["--demo"]
        app.launch()
        openWorkspaceSidebar()
        let tasks = app.buttons["openTasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 5))
        activate(tasks)
        XCTAssertTrue(app.staticTexts["Shape the voice workspace"].waitForExistence(timeout: 5))
        captureScreenshot("Tasks Dawn")
        activate(app.buttons["newTask"])
        let title = app.textFields["taskTitle"].exists ? app.textFields["taskTitle"] : app.textViews["taskTitle"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap(); title.typeText("Keep this task offline")
        activate(app.buttons["saveTask"])
        XCTAssertTrue(app.staticTexts["Keep this task offline"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Waiting to sync"].exists)
        captureScreenshot("Tasks offline pending")
        app.terminate()
        app.launchArguments.removeAll { $0 == "--reset-test-data" }
        app.launch()
        openWorkspaceSidebar()
        activate(app.buttons["openTasks"])
        XCTAssertTrue(app.staticTexts["Keep this task offline"].waitForExistence(timeout: 5))
    }

    func testTasksDarkPalette() {
        launchDemo()
        openContext("Account & appearance")
        let palette = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Palette")).firstMatch
        XCTAssertTrue(palette.waitForExistence(timeout: 5))
        activate(palette); chooseMenuItem("Rosé Pine Dark")
        activate(app.buttons["Done"])
        relaunchPreservingData()
        openWorkspaceSidebar()
        activate(app.buttons["openTasks"])
        XCTAssertTrue(app.staticTexts["Shape the voice workspace"].waitForExistence(timeout: 5))
        captureScreenshot("Tasks Dark")
    }

    func testVoiceOpensWithoutStartingMicrophone() throws {
        #if os(iOS)
        app.terminate()
        app.launchEnvironment["APSIDES_EDITOR_TEST_ORIGIN"] = "http://127.0.0.1:9"
        app.launch()
        openWorkspaceSidebar()
        let voice = app.buttons["openVoiceConversation"]
        XCTAssertTrue(voice.waitForExistence(timeout: 5))
        activate(voice)
        let signIn = app.buttons["voiceSignIn"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 25))
        XCTAssertTrue(signIn.isEnabled)
        XCTAssertFalse(app.buttons["startVoiceConversation"].exists)
        XCTAssertTrue(app.buttons["voiceRetryConnection"].isEnabled)
        activate(signIn)
        XCTAssertTrue(app.buttons["Check connection"].waitForExistence(timeout: 5))
        activate(app.buttons["Cancel"])
        XCTAssertTrue(signIn.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["voiceStatus"].exists)
        XCTAssertTrue(app.staticTexts["voiceAccountStatus"].exists)
        XCTAssertFalse(app.buttons["End"].exists)
        captureScreenshot("Voice ready Dawn")
        activate(app.buttons["Done"])
        XCTAssertTrue(app.buttons["openWorkspaceSidebar"].waitForExistence(timeout: 5))
        #else
        throw XCTSkip("Voice transport is currently an iPhone surface")
        #endif
    }

    func testMeetingNotesPersistAndRecordingRequiresAwareness() throws {
        #if os(iOS)
        openContext("Meeting capture")
        activate(app.buttons["newMeetingCapture"])
        let start = app.buttons["startMeetingRecording"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        XCTAssertFalse(start.isEnabled)
        XCTAssertTrue(app.staticTexts["Ready when you are"].exists)
        captureScreenshot("Meeting preparation Dawn")
        activate(app.switches["meetingParticipantsInformed"])
        XCTAssertTrue(start.isEnabled)
        XCTAssertFalse(app.staticTexts["Microphone is on"].exists)
        let note = "Planning meeting " + UUID().uuidString
        let contentMode = app.segmentedControls["meetingContentMode"]
        XCTAssertTrue(contentMode.waitForExistence(timeout: 5))
        activate(contentMode.buttons["Notes"])
        let editor = app.textViews["meetingNotes"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        activate(editor)
        editor.typeText(note)
        activate(contentMode.buttons["Transcript"])
        XCTAssertTrue(app.staticTexts["Spoken words will appear here after recording starts."].waitForExistence(timeout: 5))
        XCTAssertFalse(editor.exists)
        activate(contentMode.buttons["Notes"])
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertEqual(editor.value as? String, note)
        activate(app.buttons["closeMeetingCapture"])
        XCTAssertTrue(app.staticTexts[note].waitForExistence(timeout: 5))
        relaunchPreservingData()
        openContext("Meeting capture")
        activate(app.staticTexts[note])
        XCTAssertTrue(contentMode.waitForExistence(timeout: 5))
        activate(contentMode.buttons["Notes"])
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertEqual(app.textViews["meetingNotes"].value as? String, note)
        XCTAssertFalse(app.buttons["startMeetingRecording"].isEnabled)
        XCTAssertFalse(app.staticTexts["Microphone is on"].exists)
        activate(app.buttons["closeMeetingCapture"])
        returnToPhoneDay()
        openContext("Account & appearance")
        activate(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Palette")).firstMatch)
        chooseMenuItem("Rosé Pine Dark")
        activate(app.buttons["Done"])
        returnToPhoneDay()
        openContext("Meeting capture")
        activate(app.staticTexts[note])
        XCTAssertTrue(contentMode.waitForExistence(timeout: 5))
        activate(contentMode.buttons["Notes"])
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        captureScreenshot("Meeting notes Dark")
        #else
        throw XCTSkip("Meeting recording is currently an iPhone surface")
        #endif
    }

    func testCachedWorkspaceOpensWithoutNetworkAfterRelaunch() {
        app.terminate()
        app.launchArguments = ["--ui-testing", "--reset-test-data", "--seed-cached-context"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["Release week"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Bringing your day together…"].exists)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Last updated")).firstMatch.exists)
        openContext("People")
        XCTAssertTrue(app.staticTexts["Ada Lovelace"].waitForExistence(timeout: 5))

        relaunchPreservingData()
        XCTAssertTrue(app.descendants(matching: .any)["Release week"].firstMatch.waitForExistence(timeout: 5))
        openContext("GitHub")
        XCTAssertTrue(app.staticTexts["rawkode/apsides"].waitForExistence(timeout: 5))
    }

    func testFreshLaunchHasEmptyDaybookAndCaptures() {
        openContext("On this device")
        let editor = app.textViews["daybookEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        XCTAssertEqual(editor.value as? String ?? "", "")

        openCaptures()
        XCTAssertTrue(app.staticTexts["No captures"].waitForExistence(timeout: 5))
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
        activate(app.buttons["newCapture"])
        XCTAssertTrue(app.textViews["captureText"].waitForExistence(timeout: 5))
        activate(app.buttons["Close"])

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
        XCTAssertTrue(app.staticTexts["No captures"].waitForExistence(timeout: 5))
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
        let filter = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Filter activity")).firstMatch
        #if os(macOS)
        let menu = app.popUpButtons["Filter activity"]
        XCTAssertTrue(menu.exists || filter.waitForExistence(timeout: 5))
        activate(menu.exists ? menu : filter)
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
        XCTAssertTrue(app.buttons["openWorkspaceSidebar"].waitForExistence(timeout: 5))
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
        for id in ["dailyNotePreview", "openWorkspaceSidebar"] {
            XCTAssertTrue(app.buttons[id].waitForExistence(timeout: 10))
            XCTAssertTrue(app.buttons[id].isHittable)
        }
        XCTAssertFalse(app.tabBars.firstMatch.exists)
        XCTAssertFalse(webEditor.exists, "Home must show the day before opening the editor")
        showSampleCalendarEvents()
        captureScreenshot("Notes pull-up Dawn")
        openWorkspaceSidebar()
        captureScreenshot("Sidebar Dawn")
        activate(app.buttons["sidebarClose"])
        openContext("Account & appearance")
        let palette = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Palette")).firstMatch
        XCTAssertTrue(palette.waitForExistence(timeout: 5))
        activate(palette)
        chooseMenuItem("Rosé Pine Dark")
        activate(app.buttons["Done"])
        returnToPhoneDay()
        showSampleCalendarEvents()
        captureScreenshot("Notes pull-up Dark")
        openWorkspaceSidebar()
        captureScreenshot("Sidebar Dark")
        activate(app.buttons["sidebarClose"])
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

    // MARK: Native editor (Settings → Editor → Native editor, or --native-editor)

    func testNativeEditorRetainsDraftAfterImmediateClose() throws {
        let editor = try launchNativeEditor()
        let text = "Keep this thought " + UUID().uuidString
        editor.typeText(text)
        activate(app.buttons["closeDailyNote"])
        XCTAssertFalse(app.buttons["closeDailyNote"].exists)
        relaunchPreservingData()
        openDailyNoteIfNeeded()
        let restored = app.textViews.matching(identifier: "noteText").firstMatch
        XCTAssertTrue(restored.waitForExistence(timeout: 20))
        XCTAssertEqual(restored.value as? String, text)
    }

    func testNativeEditorTypesHeadingAndSavesAcrossRelaunch() throws {
        let editor = try launchNativeEditor()
        editor.typeText("# Native heading\nA paragraph written natively.")
        XCTAssertTrue(app.textViews.matching(identifier: "noteText").count >= 2)
        XCTAssertEqual(app.textViews.matching(identifier: "noteText").element(boundBy: 0).value as? String, "Native heading")
        XCTAssertEqual(app.textViews.matching(identifier: "noteText").element(boundBy: 1).value as? String, "A paragraph written natively.")
        XCTAssertTrue(waitForNativeSave())
        captureScreenshot("Native editor Dawn")
        relaunchPreservingData()
        openDailyNoteIfNeeded()
        let restored = app.textViews.matching(identifier: "noteText").firstMatch
        XCTAssertTrue(restored.waitForExistence(timeout: 20))
        XCTAssertEqual(restored.value as? String, "Native heading")
    }

    func testNativeEditorSlashMenuInsertsChecklist() throws {
        let editor = try launchNativeEditor()
        editor.typeText("/check")
        XCTAssertTrue(app.otherElements["Insert a block"].waitForExistence(timeout: 5) || app.buttons["Checklist"].waitForExistence(timeout: 5))
        captureScreenshot("Native editor slash menu")
        activate(app.buttons["nativeSlashChecklist"])
        XCTAssertTrue(app.buttons["Open task"].waitForExistence(timeout: 5))
        app.textViews.matching(identifier: "noteText").firstMatch.typeText("Buy milk")
        XCTAssertEqual(app.textViews.matching(identifier: "noteText").firstMatch.value as? String, "Buy milk")
        activate(app.buttons["Open task"].firstMatch)
        XCTAssertTrue(app.buttons["Completed task"].waitForExistence(timeout: 5))
        captureScreenshot("Native editor checklist")
        XCTAssertTrue(waitForNativeSave())
    }

    func testNativeEditorMentionInsertsCanonicalEntity() throws {
        let editor = try launchNativeEditor()
        let entity = ProcessInfo.processInfo.environment["APSIDES_EDITOR_TEST_ENTITY"] ?? "Ada Lovelace"
        editor.typeText("Ping @Ada")
        let match = app.buttons[entity].firstMatch
        XCTAssertTrue(match.waitForExistence(timeout: 10), "The fixture entity must appear in @ suggestions")
        captureScreenshot("Native editor mention suggestions")
        activate(match)
        XCTAssertTrue((editor.value as? String ?? "").contains("@" + entity))
        XCTAssertTrue(waitForNativeSave())
        captureScreenshot("Native editor mention")
    }

    func testNativeEditorInsertsDrawingAndRendersDarkPalette() throws {
        let editor = try launchNativeEditor()
        editor.typeText("/drawing")
        activate(app.buttons["nativeSlashDrawing"])
        let save = app.buttons["Save"].firstMatch
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        captureScreenshot("Native drawing editor")
        activate(save)
        XCTAssertTrue(app.otherElements.matching(NSPredicate(format: "label BEGINSWITH %@", "Drawing:")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(waitForNativeSave())
        captureScreenshot("Native editor drawing card")
        openContext("Account & appearance")
        let palette = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Palette")).firstMatch
        XCTAssertTrue(palette.waitForExistence(timeout: 5))
        activate(palette)
        chooseMenuItem("Rosé Pine Dark")
        activate(app.buttons["Done"])
        openToday()
        XCTAssertTrue(app.textViews.matching(identifier: "noteText").firstMatch.waitForExistence(timeout: 10))
        captureScreenshot("Native editor Dark")
    }

    private var nativeStatus: XCUIElement { app.descendants(matching: .any).matching(identifier: "saveStatus").firstMatch }

    private func waitForNativeSave() -> Bool {
        let saved = NSPredicate(format: "label CONTAINS %@", "All changes saved")
        let expectation = XCTNSPredicateExpectation(predicate: saved, object: nativeStatus)
        return XCTWaiter().wait(for: [expectation], timeout: 15) == .completed
    }

    @discardableResult
    private func launchNativeEditor() throws -> XCUIElement {
        guard let origin = ProcessInfo.processInfo.environment["APSIDES_EDITOR_TEST_ORIGIN"],
              !origin.isEmpty, !origin.hasPrefix("$(") else {
            throw XCTSkip("Set APSIDES_EDITOR_TEST_ORIGIN to the running website fixture to test the native editor.")
        }
        app.terminate()
        app.launchEnvironment["APSIDES_EDITOR_TEST_ORIGIN"] = origin
        app.launchArguments = ["--ui-testing", "--reset-test-data", "--native-editor"]
        app.launchEnvironment["APSIDES_NATIVE_TEST_DOCUMENT_ID"] = "native-test:" + UUID().uuidString
        app.launch()
        openDailyNoteIfNeeded()
        let editor = app.textViews.matching(identifier: "noteText").firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 20))
        activate(editor)
        return editor
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
        if app.buttons["openWorkspaceSidebar"].exists || app.buttons["closeDaySearch"].exists || app.navigationBars.buttons["Search"].exists {
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
            if app.buttons["openWorkspaceSidebar"].isHittable { return }
            let closeSidebar = app.buttons["sidebarClose"]
            if closeSidebar.exists && closeSidebar.isHittable { activate(closeSidebar); continue }
            let closeSearch = app.buttons["closeDaySearch"]
            if closeSearch.exists && closeSearch.isHittable { activate(closeSearch); continue }
            let back = app.navigationBars.buttons.element(boundBy: 0)
            if back.exists && back.isHittable { activate(back) } else { break }
        }
        XCTAssertTrue(app.buttons["openWorkspaceSidebar"].waitForExistence(timeout: 5))
    }

    private func openDaySearch() {
        returnToPhoneDay()
        openWorkspaceSidebar()
        activate(app.buttons["daySearch"])
        XCTAssertTrue(app.buttons["closeDaySearch"].waitForExistence(timeout: 5))
    }
    #endif

    private func openWorkspaceSidebar() {
        #if os(iOS)
        if app.buttons["sidebarClose"].exists { return }
        let menu = app.buttons["openWorkspaceSidebar"]
        XCTAssertTrue(menu.waitForExistence(timeout: 5))
        activate(menu)
        XCTAssertTrue(app.buttons["sidebarClose"].waitForExistence(timeout: 5))
        #endif
    }

    private func openDailyNoteIfNeeded() {
        #if os(iOS)
        let control = app.buttons["dailyNotePreview"]
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
        returnToPhoneDay()
        openWorkspaceSidebar()
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
        returnToPhoneDay()
        openWorkspaceSidebar()
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
