import SwiftUI
import AthenaeumRPC

/// Workspace catalog reads stay session-owned. This short local claim closes the gap between an
/// initial or Retry activation and `DevSession` publishing its loading state.
enum WorkspaceCatalogRefreshPresentation {
    static func canStartRefresh(isModelLoading: Bool, isRefreshInFlight: Bool) -> Bool {
        !isModelLoading && !isRefreshInFlight
    }

    static func isRefreshing(isModelLoading: Bool, isRefreshInFlight: Bool) -> Bool {
        isModelLoading || isRefreshInFlight
    }

    static func retryTitle(isRefreshing: Bool) -> String {
        isRefreshing ? "Retrying…" : "Retry"
    }

    static let loadingTitle = "Loading workspaces…"
}

// Phase 4 — the native mirror of `web/src/WorkspaceSwitcher.tsx`: lists the caller's real workspace
// catalog (`DevSession.workspaces`, backed by `UserRPCClient.listWorkspaces`), supports creating a new
// workspace, and switches the active workspace. Used two ways: as the full-screen "pick a workspace" step
// right after sign-in (`AthenaeumRootView`, no workspace selected yet), and presented as a sheet from
// the resolved workspace (`WorkspaceCommandCenterView`) so switching workspaces mid-session is a
// real, reachable action, not just a first-launch-only choice.
public struct WorkspaceSwitcherView: View {
    @ObservedObject var session: DevSession
    @State private var newWorkspaceTitle: String = ""
    @State private var isCreatingWorkspace = false
    @State private var isWorkspaceCatalogRefreshInFlight = false

    public init(session: DevSession) {
        self.session = session
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("signed in as \(session.email ?? "?")").font(.subheadline)
                Spacer()
                Button("Sign out") { session.signOut() }
            }

            Text("Workspace").font(.headline)

            if isRefreshingWorkspaceCatalog {
                ProgressView(WorkspaceCatalogRefreshPresentation.loadingTitle)
            }

            if let loadError = session.workspaceLoadErrorMessage {
                VStack(alignment: .leading, spacing: 6) {
                    Text(loadError)
                        .font(.caption)
                        .foregroundStyle(.red)
                    Button(
                        WorkspaceCatalogRefreshPresentation.retryTitle(
                            isRefreshing: isRefreshingWorkspaceCatalog
                        )
                    ) {
                        startWorkspaceCatalogRefresh()
                    }
                    .disabled(isRefreshingWorkspaceCatalog)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                ForEach(session.workspaces, id: \.workspaceId) { workspace in
                    Button {
                        session.selectWorkspace(id: workspace.workspaceId)
                    } label: {
                        HStack {
                            Text(workspace.title)
                            if workspace.isDefault {
                                Text("(default)").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(workspace.role).font(.caption.monospaced()).foregroundStyle(.secondary)
                            if workspace.workspaceId == session.selectedWorkspaceId?.rawValue {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(.blue)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }

            HStack {
                TextField("New workspace title", text: $newWorkspaceTitle)
                    .textFieldStyle(.roundedBorder)
                Button(isCreatingWorkspace ? "Creating…" : "+ New workspace") {
                    let draft = newWorkspaceTitle
                    let title = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !title.isEmpty else { return }
                    isCreatingWorkspace = true
                    Task {
                        let created = await session.createWorkspace(title: title)
                        if created, newWorkspaceTitle == draft {
                            newWorkspaceTitle = ""
                        }
                        isCreatingWorkspace = false
                    }
                }
                .disabled(newWorkspaceTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isCreatingWorkspace)
            }

            if let error = session.errorMessage {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .padding()
        .task { await refreshWorkspaceCatalogOnAppear() }
    }

    private var isRefreshingWorkspaceCatalog: Bool {
        WorkspaceCatalogRefreshPresentation.isRefreshing(
            isModelLoading: session.isLoadingWorkspaces,
            isRefreshInFlight: isWorkspaceCatalogRefreshInFlight
        )
    }

    private func startWorkspaceCatalogRefresh() {
        guard beginWorkspaceCatalogRefresh() else { return }
        Task { @MainActor in
            await completeWorkspaceCatalogRefresh()
        }
    }

    private func refreshWorkspaceCatalogOnAppear() async {
        guard beginWorkspaceCatalogRefresh() else { return }
        await completeWorkspaceCatalogRefresh()
    }

    private func beginWorkspaceCatalogRefresh() -> Bool {
        guard WorkspaceCatalogRefreshPresentation.canStartRefresh(
            isModelLoading: session.isLoadingWorkspaces,
            isRefreshInFlight: isWorkspaceCatalogRefreshInFlight
        ) else {
            return false
        }
        isWorkspaceCatalogRefreshInFlight = true
        return true
    }

    private func completeWorkspaceCatalogRefresh() async {
        defer { isWorkspaceCatalogRefreshInFlight = false }
        await session.refreshWorkspaces()
    }
}
