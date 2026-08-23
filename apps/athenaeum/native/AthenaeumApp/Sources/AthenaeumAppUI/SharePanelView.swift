import SwiftUI
import AthenaeumDomain
import AthenaeumRPC

// Phase 4 — a basic share/collaborator list view: add/remove collaborator by email, matching
// this task's own explicit scope note ("share-link create/revoke can be minimal if time-
// constrained — prioritize the workspace-switcher + sign-in working for real"). Scoped-down
// deliberately relative to `web/src/SharePanel.tsx`: this view supports add/list/remove
// collaborator (the core loop docs/sharing.md's example — "removing Bob makes Carol unreachable
// automatically" — actually needs to be demonstrable) but does NOT include share-link
// create/redeem/revoke UI or the two-phase preview→confirm warning `SharePanel.tsx` builds for
// removal (`previewRemoveCollaborator`) — both real, tested RPC methods
// (`WorkspaceRPCClient+Sharing.swift`), just not wired into this minimal view. A future stage can add
// them the same way this view calls `listCollaborators`/`addCollaborator`/`removeCollaborator`.
@MainActor
final class SharePanelViewModel: ObservableObject {
    @Published private(set) var collaborators: [RPCCollaboratorInfo] = []
    @Published var newCollaboratorEmail: String = ""
    @Published var newCollaboratorRole: String = "use"
    @Published private(set) var isBusy = false
    @Published var errorMessage: String?

    private let client: WorkspaceRPCClient

    init(backendURL: URL, workspaceId: EntityId, bearerCredential: String) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.client = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
    }

    func refresh() async {
        do {
            collaborators = try await client.listCollaborators()
        } catch {
            errorMessage = "Failed to load collaborators: \(error)"
        }
    }

    func addCollaborator() async {
        let email = newCollaboratorEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !email.isEmpty else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await client.addCollaborator(profileId: email, role: newCollaboratorRole)
            newCollaboratorEmail = ""
            await refresh()
        } catch {
            errorMessage = "Failed to add collaborator: \(error)"
        }
    }

    func removeCollaborator(profileId: String) async {
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await client.removeCollaborator(profileId: profileId)
            await refresh()
        } catch {
            errorMessage = "Failed to remove collaborator: \(error)"
        }
    }
}

public struct SharePanelView: View {
    @StateObject private var model: SharePanelViewModel

    public init(backendURL: URL, workspaceId: EntityId, bearerCredential: String) {
        _model = StateObject(
            wrappedValue: SharePanelViewModel(backendURL: backendURL, workspaceId: workspaceId, bearerCredential: bearerCredential)
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Sharing").font(.title2.bold())

            HStack {
                TextField("collaborator@example.com", text: $model.newCollaboratorEmail)
                    .textFieldStyle(.roundedBorder)
                Picker("Role", selection: $model.newCollaboratorRole) {
                    Text("use (read + tasks)").tag("use")
                    Text("build (full edit)").tag("build")
                }
                .labelsHidden()
                Button("Add") { Task { await model.addCollaborator() } }
                    .disabled(
                        model.newCollaboratorEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || model.isBusy
                    )
            }

            Text("Collaborators").font(.headline)
            if model.collaborators.isEmpty {
                Text("No collaborators yet.").foregroundStyle(.secondary)
            }
            ForEach(model.collaborators, id: \.profileId) { collaborator in
                HStack {
                    Text(collaborator.profileId)
                    Text("— \(collaborator.role)").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Remove") { Task { await model.removeCollaborator(profileId: collaborator.profileId) } }
                        .disabled(model.isBusy)
                }
            }

            if let error = model.errorMessage {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .padding()
        .task { await model.refresh() }
    }
}
