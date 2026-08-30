import XCTest
@testable import AthenaeumAppUI
import AthenaeumCore
import AthenaeumDomain
@testable import AthenaeumRPC
#if os(macOS)
import AppKit
#endif

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
        XCTAssertEqual(WorkspaceIOSHomePresentation.navigationTitle(isToday: true), "")
        XCTAssertEqual(WorkspaceIOSHomePresentation.navigationTitle(isToday: false), "Daily note")
        XCTAssertEqual(WorkspaceIOSHomePresentation.dailyNoteTitle, "Daily note")
    }

    func testTodayCompositionKeepsTheNoteFirstAndStacksBeforeItCompressesWriting() {
        XCTAssertEqual(TodayWorkspaceComposition.mode(availableWidth: 1_000, isAccessibilitySize: false), .horizontal)
        XCTAssertEqual(TodayWorkspaceComposition.mode(availableWidth: 800, isAccessibilitySize: false), .stacked)
        XCTAssertEqual(TodayWorkspaceComposition.mode(availableWidth: 1_000, isAccessibilitySize: true), .stacked)
        XCTAssertEqual(TodayWorkspaceComposition.minimumHorizontalWidth, 864)
    }

    func testWorkspaceRecallRevealsAHiddenSidebarWithoutResettingSearchState() {
        let request = WorkspaceRecallPresentation.request(
            generation: 4,
            sidebarIsVisible: false,
            query: "Athenaeum roadmap",
            selectedResultID: "result-2"
        )

        XCTAssertEqual(request.phase, .revealThenFocus)
        XCTAssertEqual(request.generation, 4)
        XCTAssertEqual(request.query, "Athenaeum roadmap")
        XCTAssertEqual(request.selectedResultID, "result-2")
        XCTAssertTrue(WorkspaceRecallPresentation.mayApplyDeferredFocus(requestGeneration: 4, currentGeneration: 4))
    }

    func testWorkspaceRecallRepeatedShortcutRefocusesAndFencesAnOlderDeferredRequest() {
        let first = WorkspaceRecallPresentation.request(
            generation: 7,
            sidebarIsVisible: false,
            query: "people I met",
            selectedResultID: "person-result"
        )
        let repeatRequest = WorkspaceRecallPresentation.request(
            generation: 8,
            sidebarIsVisible: true,
            query: first.query,
            selectedResultID: first.selectedResultID
        )

        XCTAssertEqual(repeatRequest.phase, .focus)
        XCTAssertEqual(repeatRequest.query, "people I met")
        XCTAssertEqual(repeatRequest.selectedResultID, "person-result")
        XCTAssertFalse(WorkspaceRecallPresentation.mayApplyDeferredFocus(requestGeneration: first.generation, currentGeneration: repeatRequest.generation))
        XCTAssertTrue(WorkspaceRecallPresentation.mayApplyDeferredFocus(requestGeneration: repeatRequest.generation, currentGeneration: repeatRequest.generation))
    }

    func testMacOSRecallBridgeDefersAndGenerationFencesSidebarSearchFocus() throws {
        let testDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let packageDirectory = testDirectory
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sourceURL = packageDirectory
            .appendingPathComponent("Sources/AthenaeumAppUI/WorkspaceCommandCenterView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertTrue(source.contains("struct SidebarSearchFocusBridge: NSViewRepresentable"))
        XCTAssertTrue(source.contains("SidebarSearchFocusPresentation.disposition("))
        XCTAssertTrue(source.contains("DispatchQueue.main.async"))
        XCTAssertTrue(source.contains("guard activeGeneration.wrappedValue == requestGeneration"))
        XCTAssertTrue(source.contains("$0.makeFirstResponder(field)"))
        XCTAssertTrue(source.contains("requestGeneration: sidebarSearchFocusRequest"))
    }

    func testSidebarSearchFocusRetriesUntilTheCurrentRequestFocusesThenConsumesIt() {
        XCTAssertEqual(
            SidebarSearchFocusPresentation.disposition(
                requestGeneration: 5,
                activeGeneration: 5,
                attempt: 0,
                didFocus: false
            ),
            .retry
        )
        XCTAssertEqual(
            SidebarSearchFocusPresentation.disposition(
                requestGeneration: 5,
                activeGeneration: 5,
                attempt: 1,
                didFocus: true
            ),
            .complete
        )
        XCTAssertEqual(
            SidebarSearchFocusPresentation.disposition(
                requestGeneration: 5,
                activeGeneration: 6,
                attempt: 1,
                didFocus: true
            ),
            .stale
        )
        XCTAssertEqual(
            SidebarSearchFocusPresentation.disposition(
                requestGeneration: 5,
                activeGeneration: 5,
                attempt: SidebarSearchFocusPresentation.maximumAttempts - 1,
                didFocus: false
            ),
            .exhausted
        )
    }

    func testSidebarSearchFocusCustodyRejectsDetailSearchAndMarksOnlySidebarSearch() {
        XCTAssertTrue(
            SidebarSearchFocusPresentation.acceptsSearchField(
                isInSidebarColumn: true,
                identifier: nil,
                placeholder: SidebarSearchFocusPresentation.searchPrompt
            )
        )
        XCTAssertFalse(
            SidebarSearchFocusPresentation.acceptsSearchField(
                isInSidebarColumn: false,
                identifier: SidebarSearchFocusPresentation.searchFieldIdentifier,
                placeholder: SidebarSearchFocusPresentation.searchPrompt
            )
        )

        #if os(macOS)
        let split = NSSplitView()
        let sidebar = NSView()
        let detail = NSView()
        split.addSubview(sidebar)
        split.addSubview(detail)
        let bridgeAnchor = NSView()
        let sidebarSearch = NSSearchField()
        sidebarSearch.placeholderString = SidebarSearchFocusPresentation.searchPrompt
        let detailSearch = NSSearchField()
        detailSearch.placeholderString = SidebarSearchFocusPresentation.searchPrompt
        sidebar.addSubview(bridgeAnchor)
        sidebar.addSubview(sidebarSearch)
        detail.addSubview(detailSearch)

        let selected = SidebarSearchFocusBridge.sidebarSearchField(from: bridgeAnchor)

        XCTAssertTrue(selected === sidebarSearch)
        XCTAssertEqual(sidebarSearch.identifier?.rawValue, SidebarSearchFocusPresentation.searchFieldIdentifier)
        XCTAssertNil(detailSearch.identifier)
        #endif
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

    func testEntityPagePreviewRetryIsLimitedToStaleOrGenericFailedReads() {
        XCTAssertEqual(
            WorkspaceEntityPagePreviewPresentation.failureMessage,
            "Page content is unavailable right now."
        )
        XCTAssertFalse(WorkspaceEntityPagePreviewPresentation.canRetry(state: .idle))
        XCTAssertFalse(WorkspaceEntityPagePreviewPresentation.canRetry(state: .loading))
        XCTAssertFalse(WorkspaceEntityPagePreviewPresentation.canRetry(state: .loadedContent(.legacy("Page body"))))
        XCTAssertFalse(WorkspaceEntityPagePreviewPresentation.canRetry(state: .missing))
        XCTAssertFalse(WorkspaceEntityPagePreviewPresentation.canRetry(state: .unsupported))
        XCTAssertTrue(WorkspaceEntityPagePreviewPresentation.canRetry(state: .stale))
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

    func testPageDescriptorWitnessPreservesConcreteStorageVariant() throws {
        let node = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")
        let automerge = AutomergePageDocumentDescriptor(
            docId: node.rawValue,
            headsHash: "legacy-heads",
            bytesSha256: String(repeating: "a", count: 64)
        )
        let loro = LoroPageDocumentDescriptor(
            schemaVersion: 1,
            snapshotSha256: String(repeating: "b", count: 64)
        )

        let legacy = WorkspacePageDescriptorWitness(
            .legacy(nodeId: node, storageVersion: 1, automerge: automerge)
        )
        let migrated = WorkspacePageDescriptorWitness(
            .migratedLoro(nodeId: node, storageVersion: 2, automerge: automerge, loro: loro)
        )
        let native = WorkspacePageDescriptorWitness(
            .nativeLoro(nodeId: node, storageVersion: 2, loro: loro)
        )

        XCTAssertEqual(legacy.variant, .legacy)
        XCTAssertEqual(legacy.activeFormat, .automergeV1)
        XCTAssertNil(legacy.schemaVersion)
        XCTAssertNil(legacy.snapshotSHA256)
        XCTAssertEqual(migrated.variant, .migratedLoro)
        XCTAssertEqual(native.variant, .nativeLoro)
        XCTAssertNotEqual(migrated, native)
        XCTAssertEqual(migrated.schemaVersion, 1)
        XCTAssertEqual(migrated.snapshotSHA256, String(repeating: "b", count: 64))
    }

    func testEntityPagePreviewLoaderPublishesFencedLoroContent() async throws {
        let node = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")
        let descriptor = nativePageDescriptor(node)
        let projection = loroProjection(node, text: "A useful companion update")
        var descriptorReadCount = 0
        var legacyReadCount = 0
        var loroReadCount = 0
        let loader = WorkspaceEntityPagePreviewLoader(
            readDescriptor: { requestedNode in
                XCTAssertEqual(requestedNode, node)
                descriptorReadCount += 1
                return descriptor
            },
            readLegacy: { _, _, _ in
                legacyReadCount += 1
                throw WorkspaceEntityPagePreviewLoadError.unsupported
            },
            readLoro: { requestedNode in
                XCTAssertEqual(requestedNode, node)
                loroReadCount += 1
                return DailyNoteLoroProjectionState(projection)
            }
        )

        await loader.load(nodeId: node)

        XCTAssertEqual(loader.state, .loadedContent(.loro(DailyNoteLoroProjectionState(projection))))
        XCTAssertEqual(descriptorReadCount, 2, "the descriptor must be witnessed before and after the read")
        XCTAssertEqual(legacyReadCount, 0)
        XCTAssertEqual(loroReadCount, 1)
    }

    func testEntityPagePreviewLoaderPublishesLegacyTextOnlyAfterPostReadFence() async throws {
        let node = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")
        let descriptor = legacyPageDescriptor(node)
        var descriptorReadCount = 0
        var receivedSession = false
        let loader = WorkspaceEntityPagePreviewLoader(
            readDescriptor: { _ in
                descriptorReadCount += 1
                return descriptor
            },
            readLegacy: { requestedNode, requestedDescriptor, _ in
                XCTAssertEqual(requestedNode, node)
                XCTAssertEqual(requestedDescriptor, descriptor)
                receivedSession = true
                return DailyNoteLegacyReadOnlyState(text: "Legacy companion text", descriptor: descriptor)
            },
            readLoro: { _ in
                throw WorkspaceEntityPagePreviewLoadError.unsupported
            }
        )

        await loader.load(nodeId: node)

        XCTAssertEqual(loader.state, .loadedContent(.legacy("Legacy companion text")))
        XCTAssertEqual(descriptorReadCount, 2)
        XCTAssertTrue(receivedSession)
    }

    func testEntityPagePreviewLoaderRejectsDescriptorABAAsStale() async throws {
        let node = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")
        let first = nativePageDescriptor(node, snapshot: "b")
        let changed = nativePageDescriptor(node, snapshot: "c")
        let projection = loroProjection(node, text: "Old companion update", snapshot: "b")
        var descriptors = [first, changed]
        let loader = WorkspaceEntityPagePreviewLoader(
            readDescriptor: { _ in
                defer { descriptors.removeFirst() }
                return descriptors[0]
            },
            readLegacy: { _, _, _ in
                throw WorkspaceEntityPagePreviewLoadError.unsupported
            },
            readLoro: { _ in DailyNoteLoroProjectionState(projection) }
        )

        await loader.load(nodeId: node)

        XCTAssertEqual(loader.state, .stale)
        XCTAssertTrue(WorkspaceEntityPagePreviewPresentation.canRetry(state: loader.state))
    }

    func testEntityPagePreviewLoaderClassifiesProjectionAndDescriptorFailuresSafely() async throws {
        let node = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")
        let descriptor = nativePageDescriptor(node)
        let malformedLoader = WorkspaceEntityPagePreviewLoader(
            readDescriptor: { _ in descriptor },
            readLegacy: { _, _, _ in throw WorkspaceEntityPagePreviewLoadError.unsupported },
            readLoro: { _ in throw LoroPageProjectionError.malformedKnownContent }
        )
        await malformedLoader.load(nodeId: node)
        XCTAssertEqual(malformedLoader.state, .unsupported)

        let missingLoader = WorkspaceEntityPagePreviewLoader(
            readDescriptor: { _ in throw AthenaeumDomainError.pageNotFound(nodeId: "private-node") },
            readLegacy: { _, _, _ in throw WorkspaceEntityPagePreviewLoadError.unsupported },
            readLoro: { _ in throw WorkspaceEntityPagePreviewLoadError.unsupported }
        )
        await missingLoader.load(nodeId: node)
        XCTAssertEqual(missingLoader.state, .missing)
        XCTAssertEqual(
            WorkspaceEntityPagePreviewPresentation.missingMessage,
            "No page document is attached to this entity yet."
        )
        XCTAssertFalse(WorkspaceEntityPagePreviewPresentation.missingMessage.contains(node.rawValue))
    }

    func testEntityPagePreviewLoaderIgnoresLateOlderNodeCompletion() async throws {
        let first = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")
        let latest = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440001")
        let reader = DeferredPageProjectionReader()
        let loader = WorkspaceEntityPagePreviewLoader(
            readDescriptor: { requestedNode in self.nativePageDescriptor(requestedNode) },
            readLegacy: { _, _, _ in throw WorkspaceEntityPagePreviewLoadError.unsupported },
            readLoro: { requestedNode in try await reader.read(requestedNode) }
        )

        let firstLoad = Task { @MainActor in await loader.load(nodeId: first) }
        await waitForProjectionReader(reader, toStart: first)
        let latestLoad = Task { @MainActor in await loader.load(nodeId: latest) }
        await waitForProjectionReader(reader, toStart: latest)

        reader.resume(latest, with: .success(DailyNoteLoroProjectionState(loroProjection(latest, text: "Latest update"))))
        await latestLoad.value
        XCTAssertEqual(loader.state, .loadedContent(.loro(DailyNoteLoroProjectionState(loroProjection(latest, text: "Latest update")))))

        reader.resume(first, with: .success(DailyNoteLoroProjectionState(loroProjection(first, text: "Stale update"))))
        await firstLoad.value
        XCTAssertEqual(loader.state, .loadedContent(.loro(DailyNoteLoroProjectionState(loroProjection(latest, text: "Latest update")))))
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

    private func waitForProjectionReader(
        _ reader: DeferredPageProjectionReader,
        toStart nodeId: EntityId
    ) async {
        for _ in 0..<100 {
            if reader.isWaiting(for: nodeId) {
                return
            }
            await Task.yield()
        }
        XCTFail("Timed out waiting for deferred page projection read")
    }

    private func nativePageDescriptor(
        _ nodeId: EntityId,
        storageVersion: Int = 1,
        snapshot: Character = "b"
    ) -> PageDocumentDescriptor {
        .nativeLoro(
            nodeId: nodeId,
            storageVersion: storageVersion,
            loro: .init(schemaVersion: 1, snapshotSha256: String(repeating: snapshot, count: 64))
        )
    }

    private func legacyPageDescriptor(_ nodeId: EntityId) -> PageDocumentDescriptor {
        .legacy(
            nodeId: nodeId,
            storageVersion: 1,
            automerge: .init(
                docId: nodeId.rawValue,
                headsHash: "legacy-heads",
                bytesSha256: String(repeating: "a", count: 64)
            )
        )
    }

    private func loroProjection(
        _ nodeId: EntityId,
        text: String,
        snapshot: Character = "b"
    ) -> LoroPageProjection {
        let snapshotSHA256 = String(repeating: snapshot, count: 64)
        return LoroPageProjection(
            root: .document([.paragraph([.text(text, marks: [])])]),
            route: .init(
                nodeId: nodeId,
                format: .loroV1,
                storageVersion: 1,
                schemaVersion: 1,
                snapshotSHA256: snapshotSHA256
            ),
            replica: .init(snapshotSHA256: snapshotSHA256, versionVectorSHA256: String(repeating: "d", count: 64)),
            schemaVersion: 1,
            isDirty: false
        )
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

@MainActor
private final class DeferredPageProjectionReader {
    private var continuations: [EntityId: CheckedContinuation<DailyNoteLoroProjectionState, Error>] = [:]

    func read(_ nodeId: EntityId) async throws -> DailyNoteLoroProjectionState {
        try await withCheckedThrowingContinuation { continuation in
            continuations[nodeId] = continuation
        }
    }

    func isWaiting(for nodeId: EntityId) -> Bool {
        continuations[nodeId] != nil
    }

    func resume(
        _ nodeId: EntityId,
        with result: Result<DailyNoteLoroProjectionState, Error>
    ) {
        guard let continuation = continuations.removeValue(forKey: nodeId) else { return }
        continuation.resume(with: result)
    }
}
