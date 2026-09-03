import SwiftUI
import AthenaeumDomain
import AthenaeumRPC

// Phase 5 native stage — the native mirror of `web/src/BookmarksPanel.tsx`: paste-a-URL-and-save
// form + list, using the real `createBookmark`/`listBookmarks` RPCs (`gatekeeper-rpc.ts`). No
// OAuth/gatekeeper involved — see `bookmark.ts`'s own header comment for why bookmarks are the
// plan's deliberately low-complexity Phase 5 companion to Calendar.
@MainActor
final class BookmarksViewModel: ObservableObject {
    private struct PendingBookmarkIntent: Codable, Equatable {
        let requestId: String
        let url: String
        let title: String?
    }

    @Published private(set) var bookmarks: [RPCBookmark] = []
    @Published var newUrl: String = ""
    @Published var newTitle: String = ""
    @Published private(set) var isBusy = false
    @Published private(set) var isLoadingBookmarks = false
    @Published private(set) var hasLoadedBookmarks = false
    /// Capture uncertainty remains distinct from archive-read state so a manual Refresh cannot
    /// hide a frozen capture intent before its outcome is confirmed.
    @Published var errorMessage: String?
    @Published private(set) var loadErrorMessage: String?

    private let client: WorkspaceRPCClient
    private let pendingKey: String
    private var pendingIntent: PendingBookmarkIntent?

    private static func validPendingIntent(_ pending: PendingBookmarkIntent) -> PendingBookmarkIntent? {
        guard !pending.requestId.isEmpty, pending.requestId.count <= 200,
              !pending.url.isEmpty, (try? BookmarkUrl(validating: pending.url)) != nil else {
            return nil
        }
        return pending
    }

    init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.client = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
        self.pendingKey = "athenaeum.pendingBookmark.\(workspaceId.rawValue)"
        restorePendingIntent()
    }

    /// Test-only construction seam: production still resolves its client and workspace-specific
    /// pending key through the initializer above. Keeping the retry custody state in this model
    /// lets its actual failure-then-confirmed-success behavior be exercised without a backend.
    init(client: WorkspaceRPCClient, pendingKey: String) {
        self.client = client
        self.pendingKey = pendingKey
        restorePendingIntent()
    }

    private func restorePendingIntent() {
        if let data = UserDefaults.standard.data(forKey: pendingKey),
           let decoded = try? JSONDecoder().decode(PendingBookmarkIntent.self, from: data),
           let pending = Self.validPendingIntent(decoded) {
            self.pendingIntent = pending
            self.newUrl = pending.url
            self.newTitle = pending.title ?? ""
        } else {
            UserDefaults.standard.removeObject(forKey: pendingKey)
        }
    }

    func refresh() async {
        isLoadingBookmarks = true
        loadErrorMessage = nil
        defer { isLoadingBookmarks = false }
        do {
            bookmarks = try await client.listBookmarks()
            hasLoadedBookmarks = true
        } catch {
            loadErrorMessage = Self.bookmarksLoadFailureMessage(for: error)
        }
    }

    func capture() async {
        let url = newUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { return }
        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let semanticTitle = title.isEmpty ? nil : title
        let intent: PendingBookmarkIntent
        if let pending = pendingIntent, pending.url == url, pending.title == semanticTitle {
            intent = pending
        } else {
            intent = PendingBookmarkIntent(requestId: UUID().uuidString.lowercased(), url: url, title: semanticTitle)
        }
        pendingIntent = intent
        if let data = try? JSONEncoder().encode(intent) {
            UserDefaults.standard.set(data, forKey: pendingKey)
        }
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await client.createBookmark(
                url: intent.url,
                title: intent.title,
                requestId: intent.requestId,
                commitMessage: "Capture this bookmark in the workspace.",
                attribution: MutationAttribution(kind: "humanUi", surface: "macos")
            )
            pendingIntent = nil
            UserDefaults.standard.removeObject(forKey: pendingKey)
            newUrl = ""
            newTitle = ""
            errorMessage = nil
            await refresh()
        } catch {
            errorMessage = Self.captureFailureMessage(for: error)
        }
    }

    /// A lost response cannot prove the bookmark was not recorded. Keep the durable request
    /// identity and draft visible, and never interpolate transport or credential-adjacent detail.
    static func captureFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that this bookmark was saved. Your URL and title are still here. " +
            "Review your bookmarks before taking another action."
    }

    /// A read error can include backend or credential-adjacent detail. Keep the existing form and
    /// refresh path available without presenting an unavailable collection as an empty one.
    static func bookmarksLoadFailureMessage(for _: Error) -> String {
        "Bookmarks couldn’t be loaded. Nothing has been changed. Refresh to check your bookmarks again."
    }

    /// The archive is empty only after a confirmed successful read. A first render or a failed
    /// refresh has not established an empty collection and must retain its loading/error state.
    static func shouldShowEmptyBookmarks(
        isEmpty: Bool,
        hasLoadedBookmarks: Bool,
        isLoadingBookmarks: Bool,
        loadErrorMessage: String?
    ) -> Bool {
        isEmpty && hasLoadedBookmarks && !isLoadingBookmarks && loadErrorMessage == nil
    }

    static func shouldShowBookmarksLoading(
        hasLoadedBookmarks: Bool,
        isLoadingBookmarks: Bool,
        loadErrorMessage: String?
    ) -> Bool {
        isLoadingBookmarks || (!hasLoadedBookmarks && loadErrorMessage == nil)
    }
}

/// The list read is model-owned, but rapid SwiftUI actions need a synchronous, view-local claim
/// before the model's asynchronous loading publication reaches the next render.
enum BookmarkRefreshPresentation {
    static func canStartRefresh(isRefreshInFlight: Bool) -> Bool {
        !isRefreshInFlight
    }

    static func isLoading(isModelLoading: Bool, isRefreshInFlight: Bool) -> Bool {
        isModelLoading || isRefreshInFlight
    }

    static func actionTitle(isLoading: Bool) -> String {
        isLoading ? "Refreshing…" : "Refresh"
    }

    static func progressTitle(hasLoadedBookmarks: Bool) -> String {
        hasLoadedBookmarks ? "Refreshing bookmarks…" : "Loading bookmarks…"
    }

    static func accessibilityHint(isLoading: Bool) -> String {
        isLoading ? "Refreshing the bookmark archive." : "Refresh the bookmark archive."
    }
}

/// Capture keeps its durable intent in the model. This local claim only rejects repeated Save
/// activations before the model can publish its existing busy state.
enum BookmarkCapturePresentation {
    static func isSaving(isModelBusy: Bool, isCaptureInFlight: Bool) -> Bool {
        isModelBusy || isCaptureInFlight
    }

    static func canStartCapture(isModelBusy: Bool, isCaptureInFlight: Bool) -> Bool {
        !isSaving(isModelBusy: isModelBusy, isCaptureInFlight: isCaptureInFlight)
    }
}

public struct BookmarksView: View {
    @StateObject private var model: BookmarksViewModel
    @State private var isRefreshInFlight = false
    @State private var isCaptureInFlight = false

    public init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        _model = StateObject(
            wrappedValue: BookmarksViewModel(backendURL: backendURL, workspaceId: workspaceId, bearerCredential: bearerCredential)
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Bookmarks").font(.title2.bold())
                Spacer()
                Button(BookmarkRefreshPresentation.actionTitle(isLoading: isLoadingBookmarks)) {
                    startRefresh()
                }
                .buttonStyle(.borderless)
                .disabled(isLoadingBookmarks)
                .accessibilityHint(
                    BookmarkRefreshPresentation.accessibilityHint(isLoading: isLoadingBookmarks)
                )
            }

            HStack {
                TextField("https://…", text: $model.newUrl)
                    .textFieldStyle(.roundedBorder)
                TextField("Title (optional)", text: $model.newTitle)
                    .textFieldStyle(.roundedBorder)
                Button(isSavingBookmark ? "Saving…" : "Save") { startCapture() }
                    .disabled(
                        isSavingBookmark ||
                            model.newUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
            }

            if let error = model.errorMessage {
                Text(error).font(.caption).foregroundStyle(.red)
            }

            if BookmarksViewModel.shouldShowBookmarksLoading(
                hasLoadedBookmarks: model.hasLoadedBookmarks,
                isLoadingBookmarks: isLoadingBookmarks,
                loadErrorMessage: model.loadErrorMessage
            ) {
                ProgressView(
                    BookmarkRefreshPresentation.progressTitle(
                        hasLoadedBookmarks: model.hasLoadedBookmarks
                    )
                )
                    .foregroundStyle(.secondary)
            } else if let error = model.loadErrorMessage {
                Text(error).font(.caption).foregroundStyle(.red)
            } else if BookmarksViewModel.shouldShowEmptyBookmarks(
                isEmpty: model.bookmarks.isEmpty,
                hasLoadedBookmarks: model.hasLoadedBookmarks,
                isLoadingBookmarks: isLoadingBookmarks,
                loadErrorMessage: model.loadErrorMessage
            ) {
                Text("No bookmarks yet.").foregroundStyle(.secondary)
            }
            ForEach(model.bookmarks, id: \.id) { bookmark in
                VStack(alignment: .leading, spacing: 2) {
                    Text(bookmark.title ?? bookmark.url).bold()
                    Text(bookmark.url).font(.caption).foregroundStyle(.secondary)
                }
            }

        }
        .padding()
        .task { await refreshOnAppear() }
    }

    private var isLoadingBookmarks: Bool {
        BookmarkRefreshPresentation.isLoading(
            isModelLoading: model.isLoadingBookmarks,
            isRefreshInFlight: isRefreshInFlight
        )
    }

    private var isSavingBookmark: Bool {
        BookmarkCapturePresentation.isSaving(
            isModelBusy: model.isBusy,
            isCaptureInFlight: isCaptureInFlight
        )
    }

    private func startCapture() {
        guard BookmarkCapturePresentation.canStartCapture(
            isModelBusy: model.isBusy,
            isCaptureInFlight: isCaptureInFlight
        ) else { return }

        isCaptureInFlight = true
        Task { @MainActor in
            defer { isCaptureInFlight = false }
            await model.capture()
        }
    }

    private func startRefresh() {
        guard beginRefresh() else { return }
        Task { @MainActor in
            await completeRefresh()
        }
    }

    private func refreshOnAppear() async {
        guard beginRefresh() else { return }
        await completeRefresh()
    }

    private func beginRefresh() -> Bool {
        guard BookmarkRefreshPresentation.canStartRefresh(
            isRefreshInFlight: isRefreshInFlight
        ) else {
            return false
        }
        isRefreshInFlight = true
        return true
    }

    private func completeRefresh() async {
        defer { isRefreshInFlight = false }
        await model.refresh()
    }
}
