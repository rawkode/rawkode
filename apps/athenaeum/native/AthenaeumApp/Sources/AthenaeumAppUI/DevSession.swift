import Foundation
import AthenaeumDomain
import AthenaeumRPC

// Phase 4 ("Extend the minimum real slice: dev sign-in, workspace switcher"). The native analog of
// `web/src/dev-session.ts` — a small `ObservableObject` holding the app's one real identity/workspace
// state: a `DevAuthClient`-minted Bearer credential and the caller's own multi-workspace catalog
// (`UserRPCClient`). Persisted to `UserDefaults`, the same convention `WorkspaceConfiguration` already
// uses for its own pre-Phase-4 workspace-id persistence — relaunching the app keeps you signed in and
// on the same workspace, rather than dropping back to the sign-in screen every launch.
//
// **HARD CONSTRAINT compliance**: this is a client for the backend's dev-only stand-in credential
// (see `DevAuthClient.swift`'s own doc comment) — clearly labeled as such in `SignInView`, never
// presented as real production sign-in.
@MainActor
public final class DevSession: ObservableObject {
    @Published public private(set) var credential: String?
    @Published public private(set) var email: String?
    @Published public private(set) var workspaces: [RPCWorkspaceCatalogEntry] = []
    @Published public private(set) var isLoadingWorkspaces = false
    @Published public private(set) var isSigningIn = false
    @Published public private(set) var workspaceLoadErrorMessage: String?
    @Published public var errorMessage: String?
    @Published public private(set) var selectedWorkspaceId: EntityId?

    public let backendURL: URL

    private static let credentialDefaultsKey = "athenaeum.session.credential"
    private static let emailDefaultsKey = "athenaeum.session.email"
    private static let workspaceDefaultsKey = "athenaeum.session.selectedWorkspaceId"

    private let defaults: UserDefaults

    public init(backendURL: URL = WorkspaceConfiguration.resolveBackendURL(), defaults: UserDefaults = .standard) {
        self.backendURL = backendURL
        self.defaults = defaults
        self.credential = defaults.string(forKey: Self.credentialDefaultsKey)
        self.email = defaults.string(forKey: Self.emailDefaultsKey)
        if let stored = defaults.string(forKey: Self.workspaceDefaultsKey), let id = try? EntityId(validating: stored) {
            self.selectedWorkspaceId = id
        }
    }

    public var isSignedIn: Bool { credential != nil }

    /// Real, not a stub: calls the backend's `POST /api/dev/sign-in` route via `DevAuthClient`,
    /// then immediately loads this account's workspace catalog so the caller lands directly on their
    /// "Personal" default workspace (mirrors `dev-session.ts`'s own sign-in-then-load-catalog shape).
    public func signIn(email rawEmail: String) async {
        errorMessage = nil
        isSigningIn = true
        defer { isSigningIn = false }
        do {
            let result = try await DevAuthClient.signIn(email: rawEmail, backendURL: backendURL)
            credential = result.credential
            email = result.email
            defaults.set(result.credential, forKey: Self.credentialDefaultsKey)
            defaults.set(result.email, forKey: Self.emailDefaultsKey)
            await refreshWorkspaces()
        } catch {
            errorMessage = Self.signInFailureMessage(for: error)
        }
    }

    /// Sign-in transport failures can include credential-adjacent detail. The form retains its
    /// email field, so direct the user to retry without presenting that raw diagnostic.
    static func signInFailureMessage(for _: Error) -> String {
        "We couldn’t sign you in. Your email is still here. Check the connection and try again."
    }

    public func signOut() {
        credential = nil
        email = nil
        workspaces = []
        workspaceLoadErrorMessage = nil
        errorMessage = nil
        selectedWorkspaceId = nil
        defaults.removeObject(forKey: Self.credentialDefaultsKey)
        defaults.removeObject(forKey: Self.emailDefaultsKey)
        defaults.removeObject(forKey: Self.workspaceDefaultsKey)
    }

    private func userClient() -> UserRPCClient? {
        guard let credential else { return nil }
        return UserRPCClient(backendURL: backendURL, bearerCredential: credential)
    }

    /// Loads the caller's real multi-workspace catalog (`listWorkspaces`) and, if no workspace is selected yet,
    /// auto-selects the fixed-identity default "Personal" workspace — same "land on Personal by
    /// default" behavior `web/src/WorkspaceSwitcher.tsx` gives its own first-load case.
    public func refreshWorkspaces() async {
        guard let client = userClient() else { return }
        isLoadingWorkspaces = true
        defer { isLoadingWorkspaces = false }
        do {
            workspaces = try await client.listWorkspaces()
            workspaceLoadErrorMessage = nil
            if selectedWorkspaceId == nil, let landingWorkspace = workspaces.first(where: { $0.isDefault }) ?? workspaces.first {
                selectWorkspace(id: landingWorkspace.workspaceId)
            }
        } catch {
            workspaceLoadErrorMessage = Self.workspaceCatalogLoadFailureMessage(for: error)
        }
    }

    /// Catalog transport failures can include workspace or credential-adjacent detail. Keep that
    /// diagnostic out of the UI and retain the existing catalog until a retry succeeds.
    static func workspaceCatalogLoadFailureMessage(for _: Error) -> String {
        "Workspaces couldn’t be loaded. Nothing has been changed. Retry to check your workspace list."
    }

    @discardableResult
    public func createWorkspace(title: String) async -> Bool {
        guard let client = userClient() else { return false }
        errorMessage = nil
        do {
            let workspace = try await client.createWorkspace(title: title)
            await refreshWorkspaces()
            selectWorkspace(id: workspace.workspaceId)
            return true
        } catch {
            errorMessage = Self.workspaceCreationFailureMessage(for: error)
            return false
        }
    }

    /// A lost creation response cannot prove that the workspace was not recorded. Retain the
    /// caller's draft title and direct them to inspect the catalog without exposing transport detail.
    static func workspaceCreationFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that workspace creation completed. Your title is still here. Check your workspace list before trying again."
    }

    public func selectWorkspace(id: String) {
        guard let entityId = try? EntityId(validating: id) else { return }
        selectedWorkspaceId = entityId
        defaults.set(id, forKey: Self.workspaceDefaultsKey)
    }

    /// Deselects the active workspace (back to the switcher) without signing out — the "Switch workspace"
    /// affordance `WorkspaceCommandCenterView` exposes.
    public func deselectWorkspace() {
        selectedWorkspaceId = nil
        defaults.removeObject(forKey: Self.workspaceDefaultsKey)
    }
}
