import SwiftUI
import AthenaeumRPC

// Phase 4 — the native mirror of `web/src/WorkspaceSwitcher.tsx`: lists the caller's real workspace
// catalog (`DevSession.workspaces`, backed by `UserRPCClient.listWorkspaces`), supports creating a new
// workspace, and switches the active workspace. Used two ways: as the full-screen "pick a workspace" step
// right after sign-in (`AthenaeumRootView`, no workspace selected yet), and collapsed into a bar atop
// the resolved workspace (`WorkspaceView`) so switching workspaces mid-session is a real,
// reachable action, not just a first-launch-only choice.
public struct WorkspaceSwitcherView: View {
    @ObservedObject var session: DevSession
    @State private var newWorkspaceTitle: String = ""
    @State private var isCreatingWorkspace = false

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

            if session.isLoadingWorkspaces {
                ProgressView()
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
                    let title = newWorkspaceTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !title.isEmpty else { return }
                    newWorkspaceTitle = ""
                    isCreatingWorkspace = true
                    Task {
                        await session.createWorkspace(title: title)
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
        .task { await session.refreshWorkspaces() }
    }
}
