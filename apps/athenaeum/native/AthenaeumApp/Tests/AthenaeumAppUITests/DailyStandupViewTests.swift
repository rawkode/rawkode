import XCTest
import AthenaeumDomain
import AthenaeumRPC
@testable import AthenaeumAppUI

@MainActor
final class DailyStandupViewTests: XCTestCase {
    func testRefreshPresentationPreventsRapidDuplicateActionsAndRestoresControls() {
        var isRefreshInFlight = false

        XCTAssertTrue(DailyStandupRefreshPresentation.canStartRefresh(isRefreshInFlight: isRefreshInFlight))
        XCTAssertEqual(DailyStandupRefreshPresentation.actionTitle(isRefreshing: false), "Refresh")
        XCTAssertEqual(DailyStandupRefreshPresentation.retryTitle(isRefreshing: false), "Retry")
        XCTAssertEqual(DailyStandupRefreshPresentation.progressTitle(isRefreshing: false), "Loading standup…")

        isRefreshInFlight = true
        XCTAssertFalse(DailyStandupRefreshPresentation.canStartRefresh(isRefreshInFlight: isRefreshInFlight))
        XCTAssertEqual(DailyStandupRefreshPresentation.actionTitle(isRefreshing: true), "Refreshing…")
        XCTAssertEqual(DailyStandupRefreshPresentation.retryTitle(isRefreshing: true), "Retrying…")
        XCTAssertEqual(DailyStandupRefreshPresentation.progressTitle(isRefreshing: true), "Refreshing recorded work…")

        isRefreshInFlight = false
        XCTAssertTrue(DailyStandupRefreshPresentation.canStartRefresh(isRefreshInFlight: isRefreshInFlight))
    }

    func testRecentActivityUsesTheSupportedWindowAndCalmDisclosureDefault() throws {
        XCTAssertEqual(DailyStandupPresentation.fetchLimit, 20)
        XCTAssertEqual(DailyStandupPresentation.initialVisibleEntryCount, 8)

        let timestamp = try IsoDateTimeString(validating: "2026-08-27T09:30:00.000Z")
        let entries = (0..<9).map { index in
            RPCLedgerActivityEntry(
                occurredAt: timestamp,
                type: .createNodeWithIntent,
                actor: .workspaceMember,
                message: "Recorded change \(index + 1)"
            )
        }

        XCTAssertEqual(DailyStandupPresentation.visibleEntries(entries, isExpanded: false).count, 8)
        XCTAssertEqual(DailyStandupPresentation.visibleEntries(entries, isExpanded: true).count, 9)
        XCTAssertEqual(DailyStandupPresentation.additionalEntryCount(entries), 1)
        XCTAssertEqual(
            DailyStandupPresentation.disclosureTitle(isExpanded: false, additionalEntryCount: 1),
            "Show 1 more recorded change"
        )
        XCTAssertEqual(
            DailyStandupPresentation.disclosureTitle(isExpanded: true, additionalEntryCount: 1),
            "Show fewer recorded changes"
        )
    }

    func testRecentActivityDoesNotNeedDisclosureWhenItFitsTheCalmDefault() throws {
        let timestamp = try IsoDateTimeString(validating: "2026-08-27T09:30:00.000Z")
        let entries = (0..<8).map { index in
            RPCLedgerActivityEntry(
                occurredAt: timestamp,
                type: .createNodeWithIntent,
                actor: .workspaceMember,
                message: "Recorded change \(index + 1)"
            )
        }

        XCTAssertEqual(DailyStandupPresentation.visibleEntries(entries, isExpanded: false).count, 8)
        XCTAssertEqual(DailyStandupPresentation.additionalEntryCount(entries), 0)
    }

    func testRefreshLoadsRecordedWork() async throws {
        let entry = RPCLedgerActivityEntry(
            occurredAt: try IsoDateTimeString(validating: "2026-08-26T09:30:00.000Z"),
            type: .applySupertag,
            actor: .you,
            message: "Applied Supertag to a workspace node."
        )
        let model = DailyStandupViewModel(loader: { [entry] })

        await model.refresh()

        XCTAssertEqual(model.state, .loaded([entry]))
    }

    func testRefreshSurfacesSafeFailure() async {
        let model = DailyStandupViewModel(loader: { throw TestFailure.load })

        await model.refresh()

        XCTAssertEqual(model.state, .failed("Unable to load the daily standup. Please try again."))
    }

    func testLocalizedFailureSuppressesUnderlyingTransportDetails() async {
        let error = PrivateLocalizedFailure()
        let model = DailyStandupViewModel(loader: { throw error })

        await model.refresh()

        XCTAssertEqual(model.state, .failed("Unable to load the daily standup. Please try again."))
        if case .failed(let message) = model.state {
            XCTAssertFalse(message.contains(error.errorDescription ?? ""))
        } else {
            XCTFail("Expected failed state")
        }
    }

    func testAddFactActivityMatchesThePublicLedgerVocabulary() {
        let type = RPCLedgerActivityType(rawValue: "addFact")

        XCTAssertEqual(type, .addFact)
        XCTAssertEqual(type?.displayName, "Updated a workspace fact")
        XCTAssertEqual(type?.systemImage, "list.bullet.rectangle")
    }

    func testCreateEdgeActivityMatchesThePublicLedgerVocabulary() {
        let type = RPCLedgerActivityType(rawValue: "createEdge")

        XCTAssertEqual(type, .createEdge)
        XCTAssertEqual(type?.displayName, "Created a relationship")
        XCTAssertEqual(type?.systemImage, "link")
    }

    func testCreateTagActivityMatchesThePublicLedgerVocabulary() {
        let type = RPCLedgerActivityType(rawValue: "createTag")

        XCTAssertEqual(type, .createTag)
        XCTAssertEqual(type?.displayName, "Created a Supertag definition")
        XCTAssertEqual(type?.systemImage, "tag")
    }

    func testCreateNodeWithIntentActivityMatchesThePublicLedgerVocabulary() {
        let type = RPCLedgerActivityType(rawValue: "createNodeWithIntent")

        XCTAssertEqual(type, .createNodeWithIntent)
        XCTAssertEqual(type?.displayName, "Created a node with provenance")
        XCTAssertEqual(type?.systemImage, "checkmark.seal")
    }

    func testSummaryKeepsActorAttributionVisible() throws {
        let timestamp = try IsoDateTimeString(validating: "2026-08-27T09:30:00.000Z")
        let entries = [
            RPCLedgerActivityEntry(occurredAt: timestamp, type: .createNodeWithIntent, actor: .you, message: "Create the person entity."),
            RPCLedgerActivityEntry(occurredAt: timestamp, type: .createEdge, actor: .anonymous, message: "Link the attendee to the event."),
            RPCLedgerActivityEntry(occurredAt: timestamp, type: .createTag, actor: .workspaceMember, message: "Create the Person Supertag.")
        ]

        let summary = DailyStandupSummary(entries: entries)

        XCTAssertEqual(summary.total, 3)
        XCTAssertEqual(summary.byYou, 1)
        XCTAssertEqual(summary.byWorkspaceMembers, 1)
        XCTAssertEqual(summary.byAutomatedActors, 1)
    }

    func testStandupWindowUsesTheLocalCalendarDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 3_600)!
        let window = DailyStandupDayWindow(
            now: Date(timeIntervalSince1970: 1_756_297_800), // 2025-08-27 12:30:00 +01:00
            calendar: calendar
        )

        XCTAssertEqual(window.from, "2025-08-26T23:00:00.000Z")
        XCTAssertEqual(window.to, "2025-08-27T23:00:00.000Z")
    }

    private enum TestFailure: Error {
        case load
    }

    private struct PrivateLocalizedFailure: LocalizedError {
        var errorDescription: String? {
            "backend=https://internal.example/api?credential=private-token"
        }
    }
}
