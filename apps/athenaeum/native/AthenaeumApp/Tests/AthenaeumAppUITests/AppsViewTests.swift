@testable import AthenaeumAppUI
import AthenaeumRPC
import XCTest

@MainActor
final class AppsViewTests: XCTestCase {
    func testAppRunDocumentUsesSyntheticOriginAndNoCredentialMaterial() {
        let document = NativeAppRunDocument(
            workspaceId: "workspace-1", appId: "app-1", clientCodeVersion: 3)
        XCTAssertEqual(document.originURL.scheme, "athenaeum-app-run")
        XCTAssertEqual(document.clientJavaScriptURL.scheme, "athenaeum-app-run")
        XCTAssertEqual(document.runBaseURL.scheme, "athenaeum-app-run")
        XCTAssertTrue(document.clientJavaScriptURL.absoluteString.hasSuffix("/client.js?v=3"))
        XCTAssertTrue(document.runBaseURL.absoluteString.hasSuffix("/run"))
        XCTAssertFalse(document.html.contains("Authorization"))
        XCTAssertFalse(document.html.contains("Bearer"))
        XCTAssertFalse(document.html.contains("token="))
        XCTAssertFalse(document.html.contains("127.0.0.1"))
        XCTAssertTrue(document.html.contains("script-src athenaeum-app-run: 'nonce-"))
        XCTAssertTrue(document.html.contains("<script nonce=\""))
    }

    func testAppRunDocumentUsesAUniqueLaunchOrigin() {
        let first = NativeAppRunDocument(
            workspaceId: "workspace-1", appId: "app-1", clientCodeVersion: 3, launchID: "launch-a"
        )
        let second = NativeAppRunDocument(
            workspaceId: "workspace-1", appId: "app-1", clientCodeVersion: 3, launchID: "launch-b"
        )
        XCTAssertNotEqual(first.originURL, second.originURL)
        XCTAssertNotEqual(first.clientJavaScriptURL, second.clientJavaScriptURL)
        XCTAssertTrue(first.html.contains(first.originURL.host ?? ""))
        XCTAssertTrue(second.html.contains(second.originURL.host ?? ""))
    }

    func testAppRunResourcePolicyOnlyAllowsCapturedClientAndRunPaths() {
        let document = NativeAppRunDocument(
            workspaceId: "workspace-1", appId: "app-1", clientCodeVersion: 3)
        XCTAssertEqual(
            NativeAppRunResourcePolicy.resource(
                for: document.clientJavaScriptURL, origin: document.originURL), .client)
        XCTAssertEqual(
            NativeAppRunResourcePolicy.resource(for: document.runBaseURL, origin: document.originURL),
            .run(path: ""))
        for value in [
            "athenaeum-app-run://other/run",
            "athenaeum-app-run://\(document.originURL.host!)/run/../secret",
            "athenaeum-app-run://\(document.originURL.host!)/run?token=redacted",
            "athenaeum-app-run://\(document.originURL.host!)/run?%61uthorization=redacted",
            "athenaeum-app-run://\(document.originURL.host!)/run/%2e%2e/secret",
            "athenaeum-app-run://\(document.originURL.host!)/run/%2Fsecret",
            "https://example.invalid/run",
        ] {
            XCTAssertNil(
                NativeAppRunResourcePolicy.resource(for: URL(string: value)!, origin: document.originURL))
        }
        let wrongVersionURL = URL(string: "\(document.originURL.absoluteString)client.js?v=4")!
        XCTAssertEqual(
            NativeAppRunResourcePolicy.resource(for: wrongVersionURL, origin: document.originURL), .client
        )
        XCTAssertNotEqual(
            NativeAppRunResourcePolicy.clientVersion(wrongVersionURL), document.clientCodeVersion)
        XCTAssertNil(
            NativeAppRunResourcePolicy.resource(
                for: URL(string: "\(document.originURL.absoluteString)client.js?v=3&extra=1")!,
                origin: document.originURL
            )
        )
    }

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
        let launchID = "launch-1"
        XCTAssertTrue(
            NativeAppRunPresentation.canPublish(
                candidate: NativeAppRunLaunchIdentity(detail: identity, generation: 2, launchID: launchID),
                accepted: NativeAppRunLaunchIdentity(detail: identity, generation: 2, launchID: launchID)
            ))
        XCTAssertFalse(
            NativeAppRunPresentation.canPublish(
                candidate: NativeAppRunLaunchIdentity(detail: identity, generation: 1, launchID: launchID),
                accepted: NativeAppRunLaunchIdentity(detail: identity, generation: 2, launchID: launchID)
            ))
        XCTAssertFalse(
            NativeAppRunPresentation.canPublish(
                candidate: NativeAppRunLaunchIdentity(
                    detail: identity, generation: 2, launchID: "launch-2"),
                accepted: NativeAppRunLaunchIdentity(detail: identity, generation: 2, launchID: launchID)
            ))
        XCTAssertTrue(NativeAppRunPresentation.canLaunch(workspaceId: "workspace-1", app: app))
        XCTAssertFalse(NativeAppRunPresentation.canLaunch(workspaceId: "workspace-2", app: app))
        let codeMissing = RPCApp(
            id: "app-2", workspaceId: "workspace-1", title: "Empty", icon: "·",
            clientCodeVersion: 0, serverCodeVersion: 1,
            createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-02T00:00:00Z"
        )
        XCTAssertFalse(NativeAppRunPresentation.canLaunch(workspaceId: "workspace-1", app: codeMissing))
    }

    func testAppRunRequiresExactCurrentListedIdentityAndStableClientSnapshot() {
        let app = RPCApp(
            id: "app-1", workspaceId: "workspace-1", title: "Inbox", icon: "·",
            clientCodeVersion: 3, serverCodeVersion: 4,
            createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-02T00:00:00Z"
        )
        let detail = AppsViewModel.AppDetail(
            app: app,
            clientCode: RPCAppCodeVersion(
                id: "code-3", appId: "app-1", kind: .client, version: 3,
                code: "export {}", createdAt: "2024-01-02T00:00:00Z"
            ),
            serverCode: nil
        )
        XCTAssertTrue(
            AppsViewModel.canRun(
                detail: detail, listedApp: app,
                workspaceId: "workspace-1", isLibraryRefreshInFlight: false
            )
        )
        let newer = RPCApp(
            id: "app-1", workspaceId: "workspace-1", title: "Inbox", icon: "·",
            clientCodeVersion: 4, serverCodeVersion: 4,
            createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-03T00:00:00Z"
        )
        XCTAssertFalse(
            AppsViewModel.canRun(
                detail: detail, listedApp: newer,
                workspaceId: "workspace-1", isLibraryRefreshInFlight: false
            )
        )
        XCTAssertFalse(
            AppsViewModel.canRun(
                detail: detail, listedApp: app,
                workspaceId: "workspace-1", isLibraryRefreshInFlight: true
            )
        )
        let wrongSnapshot = AppsViewModel.AppDetail(
            app: app,
            clientCode: RPCAppCodeVersion(
                id: "code-2", appId: "app-1", kind: .client, version: 2,
                code: "export {}", createdAt: "2024-01-02T00:00:00Z"
            ),
            serverCode: nil
        )
        XCTAssertFalse(
            AppsViewModel.canRun(
                detail: wrongSnapshot, listedApp: app,
                workspaceId: "workspace-1", isLibraryRefreshInFlight: false
            )
        )
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

        XCTAssertEqual(
            library,
            "Apps couldn’t be loaded. Nothing has been changed. Refresh to check the library again.")
        XCTAssertEqual(
            detail,
            "This App couldn’t be loaded. Nothing has been changed. Retry this App or refresh the library."
        )
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
