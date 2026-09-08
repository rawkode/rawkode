import Foundation
import XCTest
@testable import AthenaeumAppUI

@MainActor
final class DevSessionTests: XCTestCase {
    private struct PrivateTransportError: Error, CustomStringConvertible {
        let description = "backend=https://internal.example/api?credential=private-token"
    }

    func testSignInFailureMessageSuppressesTransportDetails() {
        let error = PrivateTransportError()
        let message = DevSession.signInFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "We couldn’t sign you in. Your email is still here. Check the connection and try again."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testDevSignInClaimRejectsReturnAndButtonDuplicatesUntilCompletion() {
        var isSignInInFlight = false

        XCTAssertTrue(
            DevSignInPresentation.canStartSignIn(
                isSessionSigningIn: false,
                isSignInInFlight: isSignInInFlight
            )
        )
        XCTAssertFalse(
            DevSignInPresentation.isSigningIn(
                isSessionSigningIn: false,
                isSignInInFlight: isSignInInFlight
            )
        )
        XCTAssertEqual(
            DevSignInPresentation.signInTitle(isSigningIn: false),
            "Sign in (dev)"
        )

        isSignInInFlight = true
        XCTAssertFalse(
            DevSignInPresentation.canStartSignIn(
                isSessionSigningIn: false,
                isSignInInFlight: isSignInInFlight
            )
        )
        XCTAssertTrue(
            DevSignInPresentation.isSigningIn(
                isSessionSigningIn: false,
                isSignInInFlight: isSignInInFlight
            )
        )
        XCTAssertEqual(
            DevSignInPresentation.signInTitle(isSigningIn: true),
            "Signing in…"
        )

        isSignInInFlight = false
        XCTAssertFalse(
            DevSignInPresentation.canStartSignIn(
                isSessionSigningIn: true,
                isSignInInFlight: isSignInInFlight
            )
        )
        XCTAssertTrue(
            DevSignInPresentation.isSigningIn(
                isSessionSigningIn: true,
                isSignInInFlight: isSignInInFlight
            )
        )

        XCTAssertTrue(
            DevSignInPresentation.canStartSignIn(
                isSessionSigningIn: false,
                isSignInInFlight: isSignInInFlight
            )
        )
        XCTAssertEqual(
            DevSignInPresentation.signInTitle(isSigningIn: false),
            "Sign in (dev)"
        )
    }

    func testWorkspaceCatalogLoadFailureMessageSuppressesTransportDetails() {
        let error = PrivateTransportError()
        let message = DevSession.workspaceCatalogLoadFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "Workspaces couldn’t be loaded. Nothing has been changed. Retry to check your workspace list."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testWorkspaceCatalogRefreshClaimRejectsDuplicatesUntilCompletion() {
        var isRefreshInFlight = false

        XCTAssertTrue(
            WorkspaceCatalogRefreshPresentation.canStartRefresh(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            WorkspaceCatalogRefreshPresentation.isRefreshing(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertEqual(
            WorkspaceCatalogRefreshPresentation.retryTitle(isRefreshing: false),
            "Retry"
        )
        XCTAssertEqual(
            WorkspaceCatalogRefreshPresentation.loadingTitle,
            "Loading workspaces…"
        )

        isRefreshInFlight = true
        XCTAssertFalse(
            WorkspaceCatalogRefreshPresentation.canStartRefresh(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            WorkspaceCatalogRefreshPresentation.isRefreshing(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertEqual(
            WorkspaceCatalogRefreshPresentation.retryTitle(isRefreshing: true),
            "Retrying…"
        )

        isRefreshInFlight = false
        XCTAssertFalse(
            WorkspaceCatalogRefreshPresentation.canStartRefresh(
                isModelLoading: true,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            WorkspaceCatalogRefreshPresentation.isRefreshing(
                isModelLoading: true,
                isRefreshInFlight: isRefreshInFlight
            )
        )

        XCTAssertTrue(
            WorkspaceCatalogRefreshPresentation.canStartRefresh(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertEqual(
            WorkspaceCatalogRefreshPresentation.retryTitle(isRefreshing: false),
            "Retry"
        )
    }

    func testWorkspaceCreationFailureMessageSuppressesTransportDetails() {
        let error = PrivateTransportError()
        let message = DevSession.workspaceCreationFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "We couldn’t confirm that workspace creation completed. Your title is still here. Check your workspace list before trying again."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testWorkspaceCreationWithoutSessionDoesNotReportSuccessOrClearExistingError() async throws {
        let suiteName = "DevSessionTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let backendURL = try XCTUnwrap(URL(string: "http://127.0.0.1:8787"))
        let session = DevSession(backendURL: backendURL, defaults: defaults)
        session.errorMessage = "Existing mutation error"

        let created = await session.createWorkspace(title: "Focused test workspace")

        XCTAssertFalse(created)
        XCTAssertEqual(session.errorMessage, "Existing mutation error")
    }

    func testSignOutClearsPersistedSessionAndStaleGenericError() throws {
        let suiteName = "DevSessionTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set("credential", forKey: "athenaeum.session.credential")
        defaults.set("person@example.com", forKey: "athenaeum.session.email")
        defaults.set("stale-workspace", forKey: "athenaeum.session.selectedWorkspaceId")
        let backendURL = try XCTUnwrap(URL(string: "http://127.0.0.1:8787"))
        let session = DevSession(backendURL: backendURL, defaults: defaults)
        session.errorMessage = "A previous workspace request failed"

        session.signOut()

        XCTAssertFalse(session.isSignedIn)
        XCTAssertNil(session.email)
        XCTAssertNil(session.errorMessage)
        XCTAssertNil(defaults.string(forKey: "athenaeum.session.credential"))
        XCTAssertNil(defaults.string(forKey: "athenaeum.session.email"))
        XCTAssertNil(defaults.string(forKey: "athenaeum.session.selectedWorkspaceId"))
    }
}
