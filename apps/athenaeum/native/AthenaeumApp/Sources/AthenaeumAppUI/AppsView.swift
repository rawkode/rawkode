import Foundation
import SwiftUI
import AthenaeumDomain
import AthenaeumRPC

/// Native read-only App Library. Apps are the durable, agent-authored surfaces in Athenaeum;
/// this view lets a user inspect their identity, versions, and immutable code snapshots without
/// creating an unledgered native write path.
@MainActor
final class AppsViewModel: ObservableObject {
    struct AppDetail: Equatable {
        let app: RPCApp
        let clientCode: RPCAppCodeVersion?
        let serverCode: RPCAppCodeVersion?
    }

    @Published private(set) var apps: [RPCApp] = []
    @Published private(set) var hasLoadedApps = false
    @Published private(set) var selectedDetail: AppDetail?
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingDetail = false
    @Published var errorMessage: String?
    @Published var detailErrorMessage: String?

    private let client: WorkspaceRPCClient

    init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.client = WorkspaceRPCClient(
            baseURL: workspaceURL,
            workspaceId: workspaceId.rawValue,
            bearerCredential: bearerCredential
        )
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            apps = try await client.listApps().sorted { $0.updatedAt > $1.updatedAt }
            hasLoadedApps = true
            errorMessage = nil
        } catch {
            errorMessage = Self.libraryLoadFailureMessage(for: error)
        }
    }

    func select(_ appId: String) async {
        isLoadingDetail = true
        detailErrorMessage = nil
        defer { isLoadingDetail = false }
        do {
            let app = try await client.getApp(appId: appId)
            async let clientCode = loadCodeIfPresent(app: app, kind: .client)
            async let serverCode = loadCodeIfPresent(app: app, kind: .server)
            selectedDetail = AppDetail(
                app: app,
                clientCode: try await clientCode,
                serverCode: try await serverCode
            )
        } catch {
            selectedDetail = nil
            detailErrorMessage = Self.detailLoadFailureMessage(for: error)
        }
    }

    /// Read errors can contain transport, server, or credential-adjacent details. The App Library
    /// is read-only, so its existing Refresh/selection controls are the only safe recovery path.
    static func libraryLoadFailureMessage(for _: Error) -> String {
        "Apps couldn’t be loaded. Nothing has been changed. Refresh to check the library again."
    }

    static func detailLoadFailureMessage(for _: Error) -> String {
        "This App couldn’t be loaded. Nothing has been changed. Retry this App or refresh the library."
    }

    /// A detail retry is meaningful only for an existing selected App and must not compete with
    /// its current immutable-detail read.
    static func canRetryDetail(appId: String?, isLoadingDetail: Bool) -> Bool {
        appId != nil && !isLoadingDetail
    }

    /// The library is empty only after a confirmed, idle, successful read. A failed request
    /// leaves the catalog unknown, so it must retain the error and Refresh recovery path instead.
    static func shouldShowEmptyLibrary(
        isEmpty: Bool,
        hasLoadedApps: Bool,
        isLoading: Bool,
        errorMessage: String?
    ) -> Bool {
        isEmpty && hasLoadedApps && !isLoading && errorMessage == nil
    }

    /// The first render is unresolved until the catalog read succeeds or fails. Later refreshes
    /// keep the current library visible, including its selection and immutable version detail.
    static func shouldShowLibraryLoading(
        hasLoadedApps: Bool,
        isLoading: Bool,
        errorMessage: String?
    ) -> Bool {
        !hasLoadedApps && (isLoading || errorMessage == nil)
    }

    private func loadCodeIfPresent(app: RPCApp, kind: RPCAppCodeKind) async throws -> RPCAppCodeVersion? {
        let version = kind == .client ? app.clientCodeVersion : app.serverCodeVersion
        guard version > 0 else { return nil }
        return try await client.getAppCode(appId: app.id, kind: kind, version: version)
    }

    static func versionSummary(_ app: RPCApp) -> String {
        "client v\(app.clientCodeVersion) · server v\(app.serverCodeVersion)"
    }

    static func formatDate(_ value: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: value) ?? {
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: value)
        }()
        guard let date else { return value }
        return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
    }
}

/// App detail reads fetch an immutable App plus two immutable code snapshots. Keep the
/// single-flight interaction state in `AppsView`, rather than broadening the App/RPC model,
/// so a second rapid row activation cannot replace the first selected detail out of order.
enum AppDetailSelectionPresentation {
    static func canStartSelection(pendingAppId: String?) -> Bool {
        pendingAppId == nil
    }

    static func loadingTitle(appTitle: String) -> String {
        "Loading \(appTitle)…"
    }

    static func pendingAppId(afterCompleting appId: String, pendingAppId: String?) -> String? {
        pendingAppId == appId ? nil : pendingAppId
    }
}

/// The library read remains model-owned; this claim only rejects rapid UI activations before the
/// model's asynchronous loading publication can update the view.
enum AppsLibraryRefreshPresentation {
    static func canStartRefresh(isRefreshInFlight: Bool) -> Bool {
        !isRefreshInFlight
    }

    static func isLoading(isModelLoading: Bool, isRefreshInFlight: Bool) -> Bool {
        isModelLoading || isRefreshInFlight
    }
}

public struct AppsView: View {
    @StateObject private var model: AppsViewModel
    @State private var selectedAppId: String?
    @State private var pendingDetailSelectionAppId: String?
    @State private var isLibraryRefreshInFlight = false
    private let onOpenAgent: (() -> Void)?

    public init(
        backendURL: URL,
        workspaceId: EntityId,
        bearerCredential: String?,
        onOpenAgent: (() -> Void)? = nil
    ) {
        self.onOpenAgent = onOpenAgent
        _model = StateObject(
            wrappedValue: AppsViewModel(
                backendURL: backendURL,
                workspaceId: workspaceId,
                bearerCredential: bearerCredential
            )
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Agent-authored surfaces")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Apps")
                        .font(.title2.bold())
                }
                Spacer()
                Button {
                    startLibraryRefresh()
                } label: {
                    Label(isLoadingApps ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(isLoadingApps)
            }

            Text("Review the small tools your agents have built. Ask Agent review for a new tool or a change; durable versions appear here.")
                .font(.callout)
                .foregroundStyle(.secondary)

            if let error = model.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            if AppsViewModel.shouldShowLibraryLoading(
                hasLoadedApps: model.hasLoadedApps,
                isLoading: isLoadingApps,
                errorMessage: model.errorMessage
            ) {
                ProgressView("Loading Apps…")
                    .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
            } else if AppsViewModel.shouldShowEmptyLibrary(
                isEmpty: model.apps.isEmpty,
                hasLoadedApps: model.hasLoadedApps,
                isLoading: isLoadingApps,
                errorMessage: model.errorMessage
            ) {
                AppsEmptyState(onOpenAgent: onOpenAgent)
            } else {
                HStack(alignment: .top, spacing: 20) {
                    appList
                        .frame(minWidth: 280, maxWidth: 360, alignment: .leading)
                    Divider()
                    appDetail
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                }
            }
        }
        .padding()
        .task { await refreshLibraryOnAppear() }
    }

    private var isLoadingApps: Bool {
        AppsLibraryRefreshPresentation.isLoading(
            isModelLoading: model.isLoading,
            isRefreshInFlight: isLibraryRefreshInFlight
        )
    }

    private func startLibraryRefresh() {
        guard beginLibraryRefresh() else { return }
        Task { @MainActor in
            await completeLibraryRefresh()
        }
    }

    private func refreshLibraryOnAppear() async {
        guard beginLibraryRefresh() else { return }
        await completeLibraryRefresh()
    }

    private func beginLibraryRefresh() -> Bool {
        guard AppsLibraryRefreshPresentation.canStartRefresh(
            isRefreshInFlight: isLibraryRefreshInFlight
        ) else {
            return false
        }
        isLibraryRefreshInFlight = true
        return true
    }

    private func completeLibraryRefresh() async {
        defer { isLibraryRefreshInFlight = false }
        await model.refresh()
    }

    private var appList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Library")
                .font(.headline)
            ForEach(model.apps) { app in
                let isLoadingThisApp = pendingDetailSelectionAppId == app.id
                Button {
                    selectAppDetail(app.id)
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Text(app.icon)
                            .font(.title3)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(app.title)
                                    .font(.body.weight(.semibold))
                                    .lineLimit(1)
                                if app.pending != nil {
                                    Text("pending")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(.orange)
                                }
                            }
                            Text(AppsViewModel.versionSummary(app))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text("Updated \(AppsViewModel.formatDate(app.updatedAt))")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                            if isLoadingThisApp {
                                Text(AppDetailSelectionPresentation.loadingTitle(appTitle: app.title))
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(.vertical, 7)
                    .padding(.horizontal, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!AppDetailSelectionPresentation.canStartSelection(pendingAppId: pendingDetailSelectionAppId))
                .background(
                    selectedAppId == app.id ? Color.accentColor.opacity(0.12) : .clear,
                    in: RoundedRectangle(cornerRadius: 7)
                )
            }
        }
    }

    @ViewBuilder
    private var appDetail: some View {
        if model.isLoadingDetail {
            ProgressView("Loading App…")
                .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
        } else if let error = model.detailErrorMessage {
            VStack(alignment: .leading, spacing: 8) {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                if let appId = selectedAppId,
                   AppsViewModel.canRetryDetail(appId: appId, isLoadingDetail: model.isLoadingDetail) {
                    Button("Retry App") {
                        selectAppDetail(appId)
                    }
                    .buttonStyle(.bordered)
                    .disabled(!AppDetailSelectionPresentation.canStartSelection(pendingAppId: pendingDetailSelectionAppId))
                    .accessibilityHint("Retries loading this App and its immutable code snapshots.")
                }
            }
        } else if let detail = model.selectedDetail {
            AppDetailView(detail: detail)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: "square.stack.3d.up")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text("Select an App")
                    .font(.headline)
                Text("Its versions and immutable client/server snapshots will appear here.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
        }
    }

    private func selectAppDetail(_ appId: String) {
        guard AppDetailSelectionPresentation.canStartSelection(pendingAppId: pendingDetailSelectionAppId) else {
            return
        }

        selectedAppId = appId
        pendingDetailSelectionAppId = appId
        Task {
            await model.select(appId)
            pendingDetailSelectionAppId = AppDetailSelectionPresentation.pendingAppId(
                afterCompleting: appId,
                pendingAppId: pendingDetailSelectionAppId
            )
        }
    }
}

private struct AppDetailView: View {
    let detail: AppsViewModel.AppDetail
    @State private var selectedKind: RPCAppCodeKind = .client

    private var selectedCode: RPCAppCodeVersion? {
        selectedKind == .client ? detail.clientCode : detail.serverCode
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Text(detail.app.icon)
                    .font(.system(size: 34))
                VStack(alignment: .leading, spacing: 4) {
                    Text(detail.app.title)
                        .font(.title3.bold())
                    Text(AppsViewModel.versionSummary(detail.app))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Created \(AppsViewModel.formatDate(detail.app.createdAt)) · updated \(AppsViewModel.formatDate(detail.app.updatedAt))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            Picker("Code snapshot", selection: $selectedKind) {
                Text("Client").tag(RPCAppCodeKind.client)
                Text("Server").tag(RPCAppCodeKind.server)
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 360)

            if let code = selectedCode {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("\(selectedKind.rawValue.capitalized) snapshot v\(code.version)")
                            .font(.headline)
                        Spacer()
                        Text(AppsViewModel.formatDate(code.createdAt))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ScrollView([.horizontal, .vertical]) {
                        Text(code.code)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .padding(12)
                    }
                    .frame(minHeight: 260, maxHeight: 520)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "doc.text.magnifyingglass")
                        .foregroundStyle(.secondary)
                    Text("No \(selectedKind.rawValue) code yet")
                        .font(.headline)
                    Text("This App has a typed identity, but that code surface has not been authored.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
            }
        }
    }
}

private struct AppsEmptyState: View {
    let onOpenAgent: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "square.stack.3d.up")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("No Apps yet")
                .font(.headline)
            Text("Ask Agent review to make a small tool for the work in front of you. When it has a durable version, you can inspect it here.")
                .font(.callout)
                .foregroundStyle(.secondary)
            if let onOpenAgent {
                Button("Open Agent review", systemImage: "sparkles") {
                    onOpenAgent()
                }
                .buttonStyle(.borderedProminent)
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
    }
}
