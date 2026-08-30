import XCTest
@testable import AthenaeumAppUI
import AthenaeumDomain
@testable import AthenaeumRPC

@MainActor
final class WorkspaceRouteTests: XCTestCase {
    func testActionAndEntityRouteMappingsPreserveIntent() {
        XCTAssertEqual(WorkspaceRoute.voiceAction, .section(.voice))
        XCTAssertEqual(WorkspaceRoute.agentAction, .section(.agent))
        XCTAssertEqual(WorkspaceRoute.graphID("calendar-node"), .graph("calendar-node"))
        XCTAssertEqual(WorkspaceRoute.searchID("search-node"), .search("search-node"))
        XCTAssertNotEqual(WorkspaceRoute.searchID("node"), WorkspaceRoute.graphID("node"))
    }

    func testPersonRouteCarriesTheValidatedEntityIDWithoutUsingGraphRows() throws {
        let personNodeId = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")

        XCTAssertEqual(WorkspaceRoute.personID(personNodeId), .person(personNodeId))
        XCTAssertNotEqual(WorkspaceRoute.personID(personNodeId), .graph(personNodeId.rawValue))
    }

    func testGenericEntityRouteCarriesTheValidatedReferenceIDWithoutUsingGraphRows() throws {
        let entityId = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")
        XCTAssertEqual(WorkspaceRoute.entityID(entityId), .entity(entityId))
        XCTAssertNotEqual(WorkspaceRoute.entityID(entityId), .graph(entityId.rawValue))
        XCTAssertEqual(WorkspaceDirectEntityDestination.entity(entityId).nodeId, entityId)
        XCTAssertEqual(WorkspaceDirectEntityDestination.entity(entityId).presentation, .entity)
    }

    func testGenericEntityPresentationKeepsMissingAndFailureCopyPrivateSafe() {
        XCTAssertEqual(WorkspaceDirectEntityPresentation.entity.missingMessage, "This referenced entity is no longer available in this workspace.")
        XCTAssertEqual(WorkspaceDirectEntityPresentation.entity.failureMessage, "Referenced entity details are unavailable right now.")
        XCTAssertFalse(WorkspaceDirectEntityPresentation.entity.missingMessage.contains("provider-private-node"))
        XCTAssertFalse(WorkspaceDirectEntityPresentation.entity.failureMessage.contains("token=secret"))
    }

    func testEmployeeUpdateRouteIsDistinctAndRetainsItsValidatedEntityID() throws {
        let nodeId = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")

        XCTAssertEqual(WorkspaceRoute.employeeUpdateID(nodeId), .employeeUpdate(nodeId))
        XCTAssertNotEqual(WorkspaceRoute.employeeUpdateID(nodeId), .person(nodeId))
        XCTAssertEqual(WorkspaceDirectEntityDestination.employeeUpdate(nodeId).nodeId, nodeId)
        XCTAssertEqual(WorkspaceDirectEntityDestination.employeeUpdate(nodeId).presentation, .employeeUpdate)
    }

    func testEmployeeUpdatePresentationKeepsMissingAndFailureCopyPrivateSafe() {
        XCTAssertEqual(
            WorkspaceDirectEntityPresentation.employeeUpdate.missingMessage,
            "This employee update is no longer available in this workspace."
        )
        XCTAssertEqual(
            WorkspaceDirectEntityPresentation.employeeUpdate.failureMessage,
            "Employee update details are unavailable right now."
        )
        XCTAssertFalse(WorkspaceDirectEntityPresentation.employeeUpdate.missingMessage.contains("provider-private-node"))
        XCTAssertFalse(WorkspaceDirectEntityPresentation.employeeUpdate.failureMessage.contains("token=secret"))
    }

    func testBothDailyNoteConstructionSitesForwardEmployeeUpdateOpening() throws {
        let testDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let packageDirectory = testDirectory
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sourceURL = packageDirectory
            .appendingPathComponent("Sources/AthenaeumAppUI/WorkspaceCommandCenterView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertEqual(source.components(separatedBy: "DailyNoteView(").count - 1, 2)
        XCTAssertEqual(source.components(separatedBy: "onOpenEmployeeUpdate: { nodeId in openEmployeeUpdate(nodeId) }").count - 1, 2)
        XCTAssertEqual(source.components(separatedBy: "onOpenReference: { reference in openReference(reference) }").count - 1, 2)
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

    func testTodayCompositionKeepsTheNoteFirstAndStacksBeforeItCompressesWriting() {
        XCTAssertEqual(TodayWorkspaceComposition.mode(availableWidth: 1_000, isAccessibilitySize: false), .horizontal)
        XCTAssertEqual(TodayWorkspaceComposition.mode(availableWidth: 800, isAccessibilitySize: false), .stacked)
        XCTAssertEqual(TodayWorkspaceComposition.mode(availableWidth: 1_000, isAccessibilitySize: true), .stacked)
        XCTAssertEqual(TodayWorkspaceComposition.minimumHorizontalWidth, 864)
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

    func testBrowseDestinationsExposeTheirNavigationTitles() {
        let destinations = WorkspaceIOSHomePresentation.browseCoreSections + WorkspaceIOSHomePresentation.browseSections

        XCTAssertTrue(destinations.allSatisfy { !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
        XCTAssertEqual(
            destinations.map(\.title),
            ["Supertags", "Calendar brief", "Meetings", "Workouts", "Graph", "Bookmarks", "Apps", "Voice", "Agent review", "Sharing"]
        )
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

    func testDirectEntityLoaderVerifiesTheRequestedIdentityBeforeComposingAPreview() async throws {
        let requested = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")
        let loaded = WorkspaceDirectEntityNode(id: requested, title: "Alice")
        let loader = WorkspaceDirectEntityLoader { nodeId in
            XCTAssertEqual(nodeId, requested)
            return loaded
        }

        await loader.load(nodeId: requested)

        XCTAssertEqual(loader.state, .loaded(loaded))
        XCTAssertTrue(
            WorkspaceDirectEntityPresentation.canComposePagePreview(
                state: loader.state,
                for: requested
            )
        )

        let unexpected = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440001")
        let mismatchedLoader = WorkspaceDirectEntityLoader { _ in
            WorkspaceDirectEntityNode(id: unexpected, title: "Wrong person")
        }
        await mismatchedLoader.load(nodeId: requested)

        XCTAssertEqual(mismatchedLoader.state, .failed)
        XCTAssertFalse(
            WorkspaceDirectEntityPresentation.canComposePagePreview(
                state: mismatchedLoader.state,
                for: requested
            )
        )
        XCTAssertFalse(
            WorkspaceDirectEntityPresentation.canComposePagePreview(
                state: .loaded(WorkspaceDirectEntityNode(id: unexpected, title: "Stale person")),
                for: requested
            )
        )
        XCTAssertEqual(WorkspaceDirectEntityPresentation.person.failureMessage, "Person details are unavailable right now.")
        XCTAssertFalse(WorkspaceDirectEntityPresentation.person.failureMessage.contains(requested.rawValue))
    }

    func testDirectEntityLoaderKeepsMissingAndGenericFailuresDistinctAndSafe() async throws {
        let requested = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")
        let missingLoader = WorkspaceDirectEntityLoader { _ in
            throw AthenaeumDomainError.nodeNotFound(nodeId: "provider-private-node")
        }

        await missingLoader.load(nodeId: requested)

        XCTAssertEqual(missingLoader.state, .notFound)
        XCTAssertFalse(
            WorkspaceDirectEntityPresentation.canComposePagePreview(
                state: missingLoader.state,
                for: requested
            )
        )
        XCTAssertFalse(WorkspaceDirectEntityPresentation.canRetry(state: missingLoader.state))
        XCTAssertFalse(WorkspaceDirectEntityPresentation.person.missingMessage.contains("provider-private-node"))

        let genericLoader = WorkspaceDirectEntityLoader { _ in
            throw NSError(domain: "private.workspace.backend", code: 500, userInfo: [NSLocalizedDescriptionKey: "token=secret"])
        }
        await genericLoader.load(nodeId: requested)

        XCTAssertEqual(genericLoader.state, .failed)
        XCTAssertTrue(WorkspaceDirectEntityPresentation.canRetry(state: genericLoader.state))
        XCTAssertFalse(WorkspaceDirectEntityPresentation.person.failureMessage.contains("token=secret"))
    }

    func testDirectEntityLoaderIgnoresALateOlderRouteCompletion() async throws {
        let first = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")
        let latest = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440001")
        let reader = DeferredDirectEntityReader()
        let loader = WorkspaceDirectEntityLoader { nodeId in
            try await reader.read(nodeId)
        }

        let firstLoad = Task { await loader.load(nodeId: first) }
        await waitForReader(reader, toStart: first)
        let latestLoad = Task { await loader.load(nodeId: latest) }
        await waitForReader(reader, toStart: latest)

        await reader.resume(
            latest,
            with: .success(WorkspaceDirectEntityNode(id: latest, title: "Latest person"))
        )
        await latestLoad.value
        XCTAssertEqual(loader.state, .loaded(WorkspaceDirectEntityNode(id: latest, title: "Latest person")))

        await reader.resume(
            first,
            with: .success(WorkspaceDirectEntityNode(id: first, title: "Stale person"))
        )
        await firstLoad.value

        XCTAssertEqual(loader.state, .loaded(WorkspaceDirectEntityNode(id: latest, title: "Latest person")))
    }

    private func waitForReader(
        _ reader: DeferredDirectEntityReader,
        toStart nodeId: EntityId
    ) async {
        for _ in 0..<100 {
            if await reader.isWaiting(for: nodeId) {
                return
            }
            await Task.yield()
        }
        XCTFail("Timed out waiting for deferred direct entity read")
    }
}

private actor DeferredDirectEntityReader {
    private var continuations: [EntityId: CheckedContinuation<WorkspaceDirectEntityNode, Error>] = [:]

    func read(_ nodeId: EntityId) async throws -> WorkspaceDirectEntityNode {
        try await withCheckedThrowingContinuation { continuation in
            continuations[nodeId] = continuation
        }
    }

    func isWaiting(for nodeId: EntityId) -> Bool {
        continuations[nodeId] != nil
    }

    func resume(
        _ nodeId: EntityId,
        with result: Result<WorkspaceDirectEntityNode, Error>
    ) {
        guard let continuation = continuations.removeValue(forKey: nodeId) else { return }
        continuation.resume(with: result)
    }
}
