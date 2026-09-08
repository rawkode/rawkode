import SwiftUI
import AthenaeumDomain
import AthenaeumRPC

// Native sharing surface for the same real RPC-backed collaboration loop as the web client:
// collaborator invites, share-link creation/redeem/revoke, and preview-before-confirm for
// destructive access changes. The view model owns only request state and presentation data; the
// server remains authoritative for affected collaborators and link revocation.
@MainActor
final class SharePanelViewModel: ObservableObject {
    @Published private(set) var collaborators: [RPCCollaboratorInfo] = []
    @Published private(set) var shareLinks: [RPCShareLink] = []
    @Published private(set) var hasLoadedSharingDetails = false
    @Published var newCollaboratorEmail: String = ""
    @Published var newCollaboratorRole: String = "use"
    @Published var shareLinkRole: String = "use"
    @Published var redeemKey: String = ""
    @Published private(set) var mintedShareKey: String?
    @Published private(set) var redeemSucceeded = false
    @Published private(set) var isBusy = false
    @Published private(set) var isLoading = false
    @Published private(set) var loadErrorMessage: String?
    @Published var errorMessage: String?
    @Published private(set) var pendingRemovalProfileId: String?
    @Published private(set) var pendingRemovalAffected: [RPCAffectedCollaborator] = []
    @Published private(set) var pendingRevokeLinkId: String?
    @Published private(set) var pendingRevokeAffected: [RPCAffectedCollaborator] = []

    private let client: WorkspaceRPCClient

    init(backendURL: URL, workspaceId: EntityId, bearerCredential: String) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.client = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
    }

    /// Test-only construction seam: production continues to create its authenticated workspace
    /// client above. It lets the real mint/refresh path be regression-tested without a backend.
    init(client: WorkspaceRPCClient) {
        self.client = client
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            collaborators = try await client.listCollaborators()
            shareLinks = try await client.listShareLinks()
            hasLoadedSharingDetails = true
            loadErrorMessage = nil
        } catch {
            loadErrorMessage = Self.sharingLoadFailureMessage(for: error)
        }
    }

    /// A failed read does not make any mutation uncertain. Keep it separate from mutation errors
    /// so the UI can safely retry only this refresh without exposing transport detail.
    static func sharingLoadFailureMessage(for _: Error) -> String {
        "Sharing details couldn’t be loaded. Nothing has been changed. Retry to check collaborators and active links."
    }

    /// Both access lists form one catalog. Empty access copy is truthful only after both reads
    /// succeed; a failed or incomplete pair must remain distinguishable from no access.
    static func shouldShowEmptySharingDetails(
        isEmpty: Bool,
        hasLoadedSharingDetails: Bool,
        isLoading: Bool,
        loadErrorMessage: String?
    ) -> Bool {
        isEmpty && hasLoadedSharingDetails && !isLoading && loadErrorMessage == nil
    }

    /// Before the pair has its first resolution, show loading rather than either successful-empty
    /// claim. Later refreshes keep the previously resolved details on screen.
    static func shouldShowSharingDetailsLoading(
        hasLoadedSharingDetails: Bool,
        isLoading: Bool,
        loadErrorMessage: String?
    ) -> Bool {
        !hasLoadedSharingDetails && (isLoading || loadErrorMessage == nil)
    }

    func addCollaborator() async {
        let email = newCollaboratorEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !email.isEmpty else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            _ = try await client.addCollaborator(profileId: email, role: newCollaboratorRole)
            newCollaboratorEmail = ""
            await refresh()
        } catch {
            errorMessage = Self.addCollaboratorFailureMessage(for: error)
        }
    }

    /// A lost response cannot prove the collaborator was not added. Preserve the form so the user
    /// can review the catalog before taking another access-changing action, without raw detail.
    static func addCollaboratorFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that this collaborator was added. The email is still here. Review the list before trying again."
    }

    func previewRemoveCollaborator(profileId: String) async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            pendingRemovalAffected = try await client.previewRemoveCollaborator(profileId: profileId)
            pendingRemovalProfileId = profileId
        } catch {
            errorMessage = Self.collaboratorRemovalPreviewFailureMessage(for: error)
        }
    }

    /// A failed preview does not change access. Keep the confirm path closed until the server can
    /// describe its effects, without exposing transport or credential-adjacent error detail.
    static func collaboratorRemovalPreviewFailureMessage(for _: Error) -> String {
        "We couldn’t inspect this collaborator’s access changes. Review the collaborators and try again."
    }

    func cancelRemoveCollaborator() {
        pendingRemovalProfileId = nil
        pendingRemovalAffected = []
    }

    func removeCollaborator(profileId: String) async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            _ = try await client.removeCollaborator(profileId: profileId)
            cancelRemoveCollaborator()
            await refresh()
        } catch {
            errorMessage = Self.collaboratorRemovalFailureMessage(for: error)
        }
    }

    /// A lost confirmation cannot establish whether access was removed. Preserve the preview so
    /// the user can review its effects, without exposing transport detail or claiming completion.
    static func collaboratorRemovalFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that this collaborator was removed. Review the collaborators before taking another action."
    }

    func createShareLink() async {
        isBusy = true
        errorMessage = nil
        mintedShareKey = nil
        defer { isBusy = false }
        do {
            let result = try await client.createShareLink(role: shareLinkRole)
            mintedShareKey = result.key
            await refresh()
        } catch {
            errorMessage = Self.shareLinkCreationFailureMessage(for: error)
        }
    }

    /// A failed response cannot prove that the server did not mint a link. The raw key is only
    /// available on a confirmed response, so direct the user to review existing links rather
    /// than echoing transport detail or implying it is safe to create another immediately.
    static func shareLinkCreationFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that the share link was created. Review active share links before taking another action."
    }

    func redeemShareLink() async {
        let key = redeemKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        isBusy = true
        errorMessage = nil
        redeemSucceeded = false
        defer { isBusy = false }
        do {
            _ = try await client.redeemShareLink(key: key)
            redeemKey = ""
            redeemSucceeded = true
            await refresh()
        } catch {
            errorMessage = Self.shareKeyRedemptionFailureMessage(for: error)
        }
    }

    /// A lost response cannot prove the access grant did not occur. Preserve the entered key and
    /// direct the user to review access before taking another action, without raw error detail.
    static func shareKeyRedemptionFailureMessage(for _: Error) -> String {
        "We couldn’t confirm whether this share key was redeemed. The key is still here. Review access before taking another action."
    }

    func previewRevokeShareLink(linkId: String) async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            pendingRevokeAffected = try await client.previewRevokeShareLink(linkId: linkId)
            pendingRevokeLinkId = linkId
        } catch {
            errorMessage = Self.shareLinkRevocationPreviewFailureMessage(for: error)
        }
    }

    /// A failed preview cannot establish the link's effects. Keep the confirmed revocation path
    /// closed until the server can describe them, without exposing transport detail.
    static func shareLinkRevocationPreviewFailureMessage(for _: Error) -> String {
        "We couldn’t inspect this share link’s effects. Review the active links and try again."
    }

    func cancelRevokeShareLink() {
        pendingRevokeLinkId = nil
        pendingRevokeAffected = []
    }

    func revokeShareLink(linkId: String) async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            _ = try await client.revokeShareLink(linkId: linkId)
            cancelRevokeShareLink()
            await refresh()
        } catch {
            errorMessage = Self.shareLinkRevocationFailureMessage(for: error)
        }
    }

    /// A lost confirmation cannot establish whether the link was revoked. Preserve the preview so
    /// the user can review its effects, without exposing transport detail or claiming completion.
    static func shareLinkRevocationFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that this share link was revoked. Review the active links before taking another action."
    }
}

/// The paired sharing-details read remains model-owned; this claim only rejects rapid direct UI
/// refreshes before the model's asynchronous loading publication can update the view.
enum ShareDetailsRefreshPresentation {
    static func canStartRefresh(isRefreshInFlight: Bool) -> Bool {
        !isRefreshInFlight
    }

    static func isLoading(isModelLoading: Bool, isRefreshInFlight: Bool) -> Bool {
        isModelLoading || isRefreshInFlight
    }
}

/// Every access-changing operation is model-owned, but the view claims the intent before a Task
/// can be scheduled. This closes the small activation window before the model publishes `isBusy`.
enum ShareMutationAction: Equatable {
    case addCollaborator
    case createShareLink
    case redeemShareLink
    case previewCollaboratorRemoval(profileId: String)
    case removeCollaborator(profileId: String)
    case previewShareLinkRevocation(linkId: String)
    case revokeShareLink(linkId: String)
}

enum ShareMutationPresentation {
    static func canStartMutation(
        pendingAction: ShareMutationAction?,
        isModelBusy: Bool
    ) -> Bool {
        pendingAction == nil && !isModelBusy
    }

    static func isMutationBusy(
        pendingAction: ShareMutationAction?,
        isModelBusy: Bool
    ) -> Bool {
        pendingAction != nil || isModelBusy
    }

    static func actionTitle(
        idleTitle: String,
        busyTitle: String,
        action: ShareMutationAction,
        pendingAction: ShareMutationAction?
    ) -> String {
        pendingAction == action ? busyTitle : idleTitle
    }
}

public struct SharePanelView: View {
    @StateObject private var model: SharePanelViewModel
    @State private var isDetailsRefreshInFlight = false
    @State private var pendingShareMutation: ShareMutationAction?

    public init(backendURL: URL, workspaceId: EntityId, bearerCredential: String) {
        _model = StateObject(
            wrappedValue: SharePanelViewModel(backendURL: backendURL, workspaceId: workspaceId, bearerCredential: bearerCredential)
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Sharing").font(.largeTitle.bold())
            Text("Invite people or create a link with the smallest role they need.")
                .font(.callout)
                .foregroundStyle(.secondary)

            GroupBox("Invite a collaborator") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        TextField("collaborator@example.com", text: $model.newCollaboratorEmail)
                            .textFieldStyle(.roundedBorder)
                            .disabled(isSharingMutationBusy)
                        rolePicker(selection: $model.newCollaboratorRole)
                            .disabled(isSharingMutationBusy)
                        Button(
                            mutationActionTitle(
                                idleTitle: "Add",
                                busyTitle: "Adding…",
                                action: .addCollaborator
                            )
                        ) {
                            startAddCollaborator()
                        }
                            .disabled(
                                model.newCollaboratorEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    || isSharingMutationBusy
                            )
                    }
                    Text("Use allows reading and tasks. Build allows full editing.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }

            GroupBox("Share link") {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        rolePicker(selection: $model.shareLinkRole)
                            .disabled(isSharingMutationBusy)
                        Button(
                            mutationActionTitle(
                                idleTitle: "Create link",
                                busyTitle: "Creating…",
                                action: .createShareLink
                            )
                        ) {
                            startCreateShareLink()
                        }
                            .disabled(isSharingMutationBusy)
                    }
                    if let key = model.mintedShareKey {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Copy this key now — it is shown only once.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(key)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary.opacity(0.45))
                        .clipShape(RoundedRectangle(cornerRadius: 7))
                    }
                    HStack {
                        TextField("Paste a share key", text: $model.redeemKey)
                            .textFieldStyle(.roundedBorder)
                            .disabled(isSharingMutationBusy)
                        Button(
                            mutationActionTitle(
                                idleTitle: "Redeem",
                                busyTitle: "Redeeming…",
                                action: .redeemShareLink
                            )
                        ) {
                            startRedeemShareLink()
                        }
                            .disabled(
                                isSharingMutationBusy
                                    || model.redeemKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            )
                    }
                    if model.redeemSucceeded {
                        Text("Redeemed — you now have access to this workspace.")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                }
                .padding(.vertical, 4)
            }

            GroupBox("Collaborators") {
                VStack(alignment: .leading, spacing: 8) {
                    if SharePanelViewModel.shouldShowSharingDetailsLoading(
                        hasLoadedSharingDetails: model.hasLoadedSharingDetails,
                        isLoading: isLoadingSharingDetails,
                        loadErrorMessage: model.loadErrorMessage
                    ) {
                        ProgressView("Loading collaborators…")
                    } else if SharePanelViewModel.shouldShowEmptySharingDetails(
                        isEmpty: model.collaborators.isEmpty,
                        hasLoadedSharingDetails: model.hasLoadedSharingDetails,
                        isLoading: isLoadingSharingDetails,
                        loadErrorMessage: model.loadErrorMessage
                    ) {
                        Text("No collaborators yet.").foregroundStyle(.secondary)
                    } else {
                        ForEach(model.collaborators, id: \.profileId) { collaborator in
                            collaboratorRow(collaborator)
                        }
                    }
                }
                .padding(.vertical, 4)
            }

            GroupBox("Active share links") {
                VStack(alignment: .leading, spacing: 8) {
                    let activeLinks = model.shareLinks.filter { !$0.revoked }
                    if SharePanelViewModel.shouldShowSharingDetailsLoading(
                        hasLoadedSharingDetails: model.hasLoadedSharingDetails,
                        isLoading: isLoadingSharingDetails,
                        loadErrorMessage: model.loadErrorMessage
                    ) {
                        ProgressView("Loading active share links…")
                    } else if SharePanelViewModel.shouldShowEmptySharingDetails(
                        isEmpty: activeLinks.isEmpty,
                        hasLoadedSharingDetails: model.hasLoadedSharingDetails,
                        isLoading: isLoadingSharingDetails,
                        loadErrorMessage: model.loadErrorMessage
                    ) {
                        Text("No active share links.").foregroundStyle(.secondary)
                    } else {
                        ForEach(activeLinks, id: \.id) { link in
                            shareLinkRow(link)
                        }
                    }
                }
                .padding(.vertical, 4)
            }

            if let loadError = model.loadErrorMessage {
                VStack(alignment: .leading, spacing: 6) {
                    Text(loadError)
                        .font(.caption)
                        .foregroundStyle(.red)
                    Button(isLoadingSharingDetails ? "Retrying…" : "Retry") {
                        startDetailsRefresh()
                    }
                    .disabled(isLoadingSharingDetails)
                }
            }

            if let error = model.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .padding()
        .task { await refreshDetailsOnAppear() }
    }

    private var isLoadingSharingDetails: Bool {
        ShareDetailsRefreshPresentation.isLoading(
            isModelLoading: model.isLoading,
            isRefreshInFlight: isDetailsRefreshInFlight
        )
    }

    private var isSharingMutationBusy: Bool {
        ShareMutationPresentation.isMutationBusy(
            pendingAction: pendingShareMutation,
            isModelBusy: model.isBusy
        )
    }

    private func startDetailsRefresh() {
        guard beginDetailsRefresh() else { return }
        Task { @MainActor in
            await completeDetailsRefresh()
        }
    }

    private func refreshDetailsOnAppear() async {
        guard beginDetailsRefresh() else { return }
        await completeDetailsRefresh()
    }

    private func beginDetailsRefresh() -> Bool {
        guard ShareDetailsRefreshPresentation.canStartRefresh(
            isRefreshInFlight: isDetailsRefreshInFlight
        ) else {
            return false
        }
        isDetailsRefreshInFlight = true
        return true
    }

    private func completeDetailsRefresh() async {
        defer { isDetailsRefreshInFlight = false }
        await model.refresh()
    }

    private func mutationActionTitle(
        idleTitle: String,
        busyTitle: String,
        action: ShareMutationAction
    ) -> String {
        ShareMutationPresentation.actionTitle(
            idleTitle: idleTitle,
            busyTitle: busyTitle,
            action: action,
            pendingAction: pendingShareMutation
        )
    }

    private func beginShareMutation(_ action: ShareMutationAction) -> Bool {
        guard ShareMutationPresentation.canStartMutation(
            pendingAction: pendingShareMutation,
            isModelBusy: model.isBusy
        ) else {
            return false
        }
        pendingShareMutation = action
        return true
    }

    private func finishShareMutation(_ action: ShareMutationAction) {
        guard pendingShareMutation == action else { return }
        pendingShareMutation = nil
    }

    private func startAddCollaborator() {
        let action = ShareMutationAction.addCollaborator
        guard beginShareMutation(action) else { return }
        Task { @MainActor in
            defer { finishShareMutation(action) }
            await model.addCollaborator()
        }
    }

    private func startCreateShareLink() {
        let action = ShareMutationAction.createShareLink
        guard beginShareMutation(action) else { return }
        Task { @MainActor in
            defer { finishShareMutation(action) }
            await model.createShareLink()
        }
    }

    private func startRedeemShareLink() {
        let action = ShareMutationAction.redeemShareLink
        guard beginShareMutation(action) else { return }
        Task { @MainActor in
            defer { finishShareMutation(action) }
            await model.redeemShareLink()
        }
    }

    private func startCollaboratorRemovalPreview(profileId: String) {
        let action = ShareMutationAction.previewCollaboratorRemoval(profileId: profileId)
        guard beginShareMutation(action) else { return }
        Task { @MainActor in
            defer { finishShareMutation(action) }
            await model.previewRemoveCollaborator(profileId: profileId)
        }
    }

    private func startCollaboratorRemoval(profileId: String) {
        let action = ShareMutationAction.removeCollaborator(profileId: profileId)
        guard beginShareMutation(action) else { return }
        Task { @MainActor in
            defer { finishShareMutation(action) }
            await model.removeCollaborator(profileId: profileId)
        }
    }

    private func startShareLinkRevocationPreview(linkId: String) {
        let action = ShareMutationAction.previewShareLinkRevocation(linkId: linkId)
        guard beginShareMutation(action) else { return }
        Task { @MainActor in
            defer { finishShareMutation(action) }
            await model.previewRevokeShareLink(linkId: linkId)
        }
    }

    private func startShareLinkRevocation(linkId: String) {
        let action = ShareMutationAction.revokeShareLink(linkId: linkId)
        guard beginShareMutation(action) else { return }
        Task { @MainActor in
            defer { finishShareMutation(action) }
            await model.revokeShareLink(linkId: linkId)
        }
    }

    private func rolePicker(selection: Binding<String>) -> some View {
        Picker("Role", selection: selection) {
            Text("Use").tag("use")
            Text("Build").tag("build")
        }
        .labelsHidden()
    }

    @ViewBuilder
    private func collaboratorRow(_ collaborator: RPCCollaboratorInfo) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(collaborator.profileId)
                    Text(collaborator.role == "build" ? "Build access" : "Use access")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if model.pendingRemovalProfileId != collaborator.profileId {
                    Button(
                        mutationActionTitle(
                            idleTitle: "Remove",
                            busyTitle: "Inspecting…",
                            action: .previewCollaboratorRemoval(profileId: collaborator.profileId)
                        )
                    ) {
                        startCollaboratorRemovalPreview(profileId: collaborator.profileId)
                    }
                    .disabled(isSharingMutationBusy)
                }
            }
            if model.pendingRemovalProfileId == collaborator.profileId {
                confirmation(
                    affected: model.pendingRemovalAffected,
                    action: .removeCollaborator(profileId: collaborator.profileId),
                    actionTitle: "Confirm removal",
                    busyTitle: "Removing…",
                    onConfirm: { startCollaboratorRemoval(profileId: collaborator.profileId) },
                    onCancel: model.cancelRemoveCollaborator
                )
            }
        }
    }

    @ViewBuilder
    private func shareLinkRow(_ link: RPCShareLink) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(String(link.id.prefix(12)) + "…")
                        .font(.caption.monospaced())
                    Text("\(link.role == "build" ? "Build" : "Use") access · created by \(link.creatorId)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if model.pendingRevokeLinkId != link.id {
                    Button(
                        mutationActionTitle(
                            idleTitle: "Revoke",
                            busyTitle: "Inspecting…",
                            action: .previewShareLinkRevocation(linkId: link.id)
                        )
                    ) {
                        startShareLinkRevocationPreview(linkId: link.id)
                    }
                    .disabled(isSharingMutationBusy)
                }
            }
            if model.pendingRevokeLinkId == link.id {
                confirmation(
                    affected: model.pendingRevokeAffected,
                    action: .revokeShareLink(linkId: link.id),
                    actionTitle: "Confirm revocation",
                    busyTitle: "Revoking…",
                    onConfirm: { startShareLinkRevocation(linkId: link.id) },
                    onCancel: model.cancelRevokeShareLink
                )
            }
        }
    }

    private func confirmation(
        affected: [RPCAffectedCollaborator],
        action: ShareMutationAction,
        actionTitle: String,
        busyTitle: String,
        onConfirm: @escaping () -> Void,
        onCancel: @escaping () -> Void
    ) -> some View {
        let affectedSummary = affected.map { collaborator in
            if let newRole = collaborator.newRole {
                return "\(collaborator.profileId) → \(newRole)"
            }
            return "\(collaborator.profileId) loses access"
        }.joined(separator: ", ")

        return VStack(alignment: .leading, spacing: 6) {
            if affected.isEmpty {
                Text("No downstream access changes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("This will also affect: \(affectedSummary)")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            HStack {
                Button(
                    mutationActionTitle(
                        idleTitle: actionTitle,
                        busyTitle: busyTitle,
                        action: action
                    ),
                    action: onConfirm
                )
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .disabled(isSharingMutationBusy)
                Button("Cancel", action: onCancel)
                    .disabled(isSharingMutationBusy)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.red.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 7))
    }
}
