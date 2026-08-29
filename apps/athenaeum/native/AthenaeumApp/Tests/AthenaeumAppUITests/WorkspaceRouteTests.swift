import XCTest
@testable import AthenaeumAppUI
import AthenaeumDomain

final class WorkspaceRouteTests: XCTestCase {
    func testActionAndEntityRouteMappingsPreserveIntent() {
        XCTAssertEqual(WorkspaceRoute.voiceAction, .section(.voice))
        XCTAssertEqual(WorkspaceRoute.agentAction, .section(.agent))
        XCTAssertEqual(WorkspaceRoute.graphID("calendar-node"), .graph("calendar-node"))
        XCTAssertEqual(WorkspaceRoute.searchID("search-node"), .search("search-node"))
        XCTAssertNotEqual(WorkspaceRoute.searchID("node"), WorkspaceRoute.graphID("node"))
    }

    func testSidebarKeepsCoreWorkSurfacesSeparateFromBrowseDestinations() {
        XCTAssertEqual(WorkspaceSection.coreSections, [.today, .supertags])
        XCTAssertEqual(WorkspaceSection.browseSections.first, .brief)
        XCTAssertTrue(WorkspaceSection.browseSections.contains(.sharing))
        XCTAssertFalse(WorkspaceSection.today.showsDestinationHeader)
        XCTAssertTrue(WorkspaceSection.supertags.showsDestinationHeader)
    }

    func testDailyNoteNavigationTitleFollowsTheSelectedDay() {
        XCTAssertEqual(WorkspaceIOSHomePresentation.navigationTitle(isToday: true), "Today")
        XCTAssertEqual(WorkspaceIOSHomePresentation.navigationTitle(isToday: false), "Daily note")
        XCTAssertEqual(WorkspaceIOSHomePresentation.dailyNoteTitle, "Daily note")
    }

    func testIOSHomeMakesTodayPrimaryAndKeepsSupportingSurfacesBrowsable() throws {
        let localDate = try LocalDate(validating: "2026-08-27")

        XCTAssertEqual(WorkspaceIOSHomePresentation.homeSection, .today)
        XCTAssertEqual(WorkspaceIOSHomePresentation.browseCoreSections, [.supertags])
        XCTAssertFalse(WorkspaceIOSHomePresentation.browseCoreSections.contains(.today))
        XCTAssertEqual(
            Set(WorkspaceIOSHomePresentation.browseCoreSections + WorkspaceIOSHomePresentation.browseSections),
            Set(WorkspaceSection.allCases).subtracting([.today])
        )
        XCTAssertEqual(
            WorkspaceIOSHomePresentation.dailyNoteDate(for: .dailyNote(localDate)),
            localDate
        )
        XCTAssertNil(WorkspaceIOSHomePresentation.dailyNoteDate(for: .section(.supertags)))
    }

    func testGraphDetailBackLabelMatchesItsSourceSurface() {
        XCTAssertEqual(
            WorkspaceGraphDetailPresentation.backButtonTitle(for: .brief),
            "Back to calendar"
        )
        XCTAssertEqual(
            WorkspaceGraphDetailPresentation.backButtonTitle(for: .graph),
            "Back to graph"
        )
    }

    func testSearchResultReturnLabelPreservesTheSearchRoute() {
        XCTAssertEqual(WorkspaceSearchResultPresentation.backButtonTitle, "Back to search")
        XCTAssertEqual(WorkspaceRoute.searchID("search-node"), .search("search-node"))
    }

    func testDailyNoteSearchResultsRouteToTheTypedDailyNoteSurface() throws {
        let localDate = try LocalDate(validating: "2026-08-27")
        let dailyNoteId = dailyNoteIdForLocalDate(localDate).rawValue

        XCTAssertEqual(
            WorkspaceSearchResultPresentation.route(for: dailyNoteId),
            .dailyNote(localDate)
        )
        XCTAssertEqual(
            WorkspaceSearchResultPresentation.route(for: "018f6a5e-0000-7000-8000-000000000000"),
            .search("018f6a5e-0000-7000-8000-000000000000")
        )
    }

    func testSearchFailurePresentationIsStaticAndRetryRequiresFailedIdleQuery() {
        let message = WorkspaceSearchPresentation.failureMessage

        XCTAssertEqual(message, "Search is unavailable right now.")
        XCTAssertTrue(
            WorkspaceSearchPresentation.canRetry(
                query: "notes",
                isSearching: false,
                errorMessage: message
            )
        )
        XCTAssertFalse(
            WorkspaceSearchPresentation.canRetry(
                query: "   ",
                isSearching: false,
                errorMessage: message
            )
        )
        XCTAssertFalse(
            WorkspaceSearchPresentation.canRetry(
                query: "notes",
                isSearching: true,
                errorMessage: message
            )
        )
        XCTAssertFalse(
            WorkspaceSearchPresentation.canRetry(
                query: "notes",
                isSearching: false,
                errorMessage: nil
            )
        )
    }

    func testStartupFailurePresentationSuppressesPrivateErrorDetail() {
        let privateFailure = NSError(
            domain: "private.workspace.backend",
            code: 500,
            userInfo: [NSLocalizedDescriptionKey: "credential=not-for-display"]
        )

        let message = WorkspaceStartupPresentation.failureMessage(for: privateFailure)

        XCTAssertEqual(
            message,
            "Athenaeum couldn’t start this workspace. Choose another workspace to try again."
        )
        XCTAssertFalse(message.contains("private.workspace.backend"))
        XCTAssertFalse(message.contains("credential=not-for-display"))
    }

    func testEntityPagePreviewRetryIsLimitedToGenericFailedReads() {
        XCTAssertEqual(
            WorkspaceEntityPagePreviewPresentation.failureMessage,
            "Page content is unavailable right now."
        )
        XCTAssertFalse(WorkspaceEntityPagePreviewPresentation.canRetry(state: .idle))
        XCTAssertFalse(WorkspaceEntityPagePreviewPresentation.canRetry(state: .loading))
        XCTAssertFalse(WorkspaceEntityPagePreviewPresentation.canRetry(state: .loaded("Page body")))
        XCTAssertFalse(WorkspaceEntityPagePreviewPresentation.canRetry(state: .unavailable))
        XCTAssertTrue(WorkspaceEntityPagePreviewPresentation.canRetry(state: .failed))
    }

    func testEntityPagePreviewRetryKeepsOneNodeKeyedActionInFlight() {
        let firstNodeId = "node-first"
        let secondNodeId = "node-second"
        var retryingNodeId: String?

        XCTAssertTrue(
            WorkspaceEntityPagePreviewPresentation.canStartRetry(
                state: .failed,
                retryingNodeId: retryingNodeId
            )
        )
        XCTAssertEqual(
            WorkspaceEntityPagePreviewPresentation.loadingTitle(
                nodeId: firstNodeId,
                retryingNodeId: retryingNodeId
            ),
            "Loading page…"
        )

        retryingNodeId = firstNodeId
        XCTAssertFalse(
            WorkspaceEntityPagePreviewPresentation.canStartRetry(
                state: .failed,
                retryingNodeId: retryingNodeId
            )
        )
        XCTAssertEqual(
            WorkspaceEntityPagePreviewPresentation.loadingTitle(
                nodeId: firstNodeId,
                retryingNodeId: retryingNodeId
            ),
            "Retrying page…"
        )
        XCTAssertEqual(
            WorkspaceEntityPagePreviewPresentation.loadingTitle(
                nodeId: secondNodeId,
                retryingNodeId: retryingNodeId
            ),
            "Loading page…"
        )

        retryingNodeId = WorkspaceEntityPagePreviewPresentation.retryingNodeId(
            afterCompleting: secondNodeId,
            retryingNodeId: retryingNodeId
        )
        XCTAssertEqual(retryingNodeId, firstNodeId)

        retryingNodeId = WorkspaceEntityPagePreviewPresentation.retryingNodeId(
            afterCompleting: firstNodeId,
            retryingNodeId: retryingNodeId
        )
        XCTAssertNil(retryingNodeId)
        XCTAssertTrue(
            WorkspaceEntityPagePreviewPresentation.canStartRetry(
                state: .failed,
                retryingNodeId: retryingNodeId
            )
        )
    }
}
