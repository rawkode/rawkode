import XCTest
import AthenaeumRPC
@testable import AthenaeumAppUI

@MainActor
final class AppsViewTests: XCTestCase {
    func testAppRunIdentityIncludesEveryAcceptedDetailField() throws {
        let app = RPCApp(
            id: "app-1", workspaceId: "workspace-1", title: "Focus", icon: "⚡",
            clientCodeVersion: 3, serverCodeVersion: 4,
            createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-02T00:00:00Z"
        )
        let identity = NativeAppRunPresentation.identity(workspaceId: "workspace-1", app: app)
        XCTAssertEqual(identity.workspaceId, "workspace-1")
        XCTAssertEqual(identity.appId, "app-1")
        XCTAssertNil(identity.pending)
        XCTAssertEqual(identity.clientCodeVersion, 3)
        XCTAssertEqual(identity.serverCodeVersion, 4)
        XCTAssertEqual(identity.updatedAt, "2024-01-02T00:00:00Z")
        XCTAssertTrue(NativeAppRunPresentation.canPublish(
            candidate: NativeAppRunLaunchIdentity(detail: identity, generation: 2),
            accepted: NativeAppRunLaunchIdentity(detail: identity, generation: 2)
        ))
        XCTAssertFalse(NativeAppRunPresentation.canPublish(
            candidate: NativeAppRunLaunchIdentity(detail: identity, generation: 1),
            accepted: NativeAppRunLaunchIdentity(detail: identity, generation: 2)
        ))
    }

    private struct PrivateTransportError: Error, CustomStringConvertible {
        let description = "backend=https://internal.example/api?credential=private-token"
    }

    func testCodeKindMatchesWireLiterals() {
        XCTAssertEqual(RPCAppCodeKind(rawValue: "client"), .client)
        XCTAssertEqual(RPCAppCodeKind(rawValue: "server"), .server)
        XCTAssertNil(RPCAppCodeKind(rawValue: "browser"))
    }

    func testFormatDateKeepsMalformedWireValuesVisible() {
        XCTAssertEqual(AppsViewModel.formatDate("not-a-date"), "not-a-date")
    }

    func testLoadFailureMessagesSuppressUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let library = AppsViewModel.libraryLoadFailureMessage(for: error)
        let detail = AppsViewModel.detailLoadFailureMessage(for: error)

        XCTAssertEqual(library, "Apps couldn’t be loaded. Nothing has been changed. Refresh to check the library again.")
        XCTAssertEqual(detail, "This App couldn’t be loaded. Nothing has been changed. Retry this App or refresh the library.")
        XCTAssertFalse(library.contains(error.description))
        XCTAssertFalse(detail.contains(error.description))
    }

    func testDetailRetryRequiresSelectedAppAndNoActiveDetailRead() {
        XCTAssertTrue(
            AppsViewModel.canRetryDetail(appId: "app-1", isLoadingDetail: false)
        )
        XCTAssertFalse(
            AppsViewModel.canRetryDetail(appId: nil, isLoadingDetail: false)
        )
        XCTAssertFalse(
            AppsViewModel.canRetryDetail(appId: "app-1", isLoadingDetail: true)
        )
    }

    func testRapidAppDetailActivationKeepsTheFirstPendingSelectionUntilItCompletes() {
        let firstAppId = "app-first"
        let secondAppId = "app-second"
        var pendingAppId: String? = firstAppId

        XCTAssertEqual(
            AppDetailSelectionPresentation.loadingTitle(appTitle: "Focus Timer"),
            "Loading Focus Timer…"
        )

        XCTAssertFalse(AppDetailSelectionPresentation.canStartSelection(pendingAppId: pendingAppId))

        pendingAppId = AppDetailSelectionPresentation.pendingAppId(
            afterCompleting: secondAppId,
            pendingAppId: pendingAppId
        )
        XCTAssertEqual(pendingAppId, firstAppId)

        pendingAppId = AppDetailSelectionPresentation.pendingAppId(
            afterCompleting: firstAppId,
            pendingAppId: pendingAppId
        )
        XCTAssertNil(pendingAppId)
        XCTAssertTrue(AppDetailSelectionPresentation.canStartSelection(pendingAppId: pendingAppId))
    }

    func testLibraryRefreshPresentationRejectsRapidDuplicateActionsAndRestoresLoadingState() {
        var isRefreshInFlight = false

        XCTAssertTrue(
            AppsLibraryRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            AppsLibraryRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )

        isRefreshInFlight = true
        XCTAssertFalse(
            AppsLibraryRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            AppsLibraryRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )

        isRefreshInFlight = false
        XCTAssertTrue(
            AppsLibraryRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            AppsLibraryRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            AppsLibraryRefreshPresentation.isLoading(
                isModelLoading: true,
                isRefreshInFlight: isRefreshInFlight
            )
        )
    }

    func testEmptyLibraryPresentationRequiresAConfirmedIdleSuccessfulLoad() {
        XCTAssertFalse(
            AppsViewModel.shouldShowEmptyLibrary(
                isEmpty: true,
                hasLoadedApps: false,
                isLoading: false,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            AppsViewModel.shouldShowEmptyLibrary(
                isEmpty: true,
                hasLoadedApps: false,
                isLoading: true,
                errorMessage: nil
            )
        )
        XCTAssertTrue(
            AppsViewModel.shouldShowEmptyLibrary(
                isEmpty: true,
                hasLoadedApps: true,
                isLoading: false,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            AppsViewModel.shouldShowEmptyLibrary(
                isEmpty: true,
                hasLoadedApps: true,
                isLoading: false,
                errorMessage: "Apps couldn’t be loaded."
            )
        )
        XCTAssertFalse(
            AppsViewModel.shouldShowEmptyLibrary(
                isEmpty: false,
                hasLoadedApps: true,
                isLoading: false,
                errorMessage: nil
            )
        )
    }

    func testLibraryLoadingPresentationWaitsForFirstResolutionWithoutHidingCachedApps() {
        XCTAssertTrue(
            AppsViewModel.shouldShowLibraryLoading(
                hasLoadedApps: false,
                isLoading: false,
                errorMessage: nil
            )
        )
        XCTAssertTrue(
            AppsViewModel.shouldShowLibraryLoading(
                hasLoadedApps: false,
                isLoading: true,
                errorMessage: nil
            )
        )
        XCTAssertTrue(
            AppsViewModel.shouldShowLibraryLoading(
                hasLoadedApps: false,
                isLoading: true,
                errorMessage: "Apps couldn’t be loaded."
            )
        )
        XCTAssertFalse(
            AppsViewModel.shouldShowLibraryLoading(
                hasLoadedApps: false,
                isLoading: false,
                errorMessage: "Apps couldn’t be loaded."
            )
        )
        XCTAssertFalse(
            AppsViewModel.shouldShowLibraryLoading(
                hasLoadedApps: true,
                isLoading: true,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            AppsViewModel.shouldShowLibraryLoading(
                hasLoadedApps: true,
                isLoading: false,
                errorMessage: "Apps couldn’t be loaded."
            )
        )
    }
}
