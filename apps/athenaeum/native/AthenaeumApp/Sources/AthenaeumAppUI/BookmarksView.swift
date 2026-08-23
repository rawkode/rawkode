import SwiftUI
import AthenaeumDomain
import AthenaeumRPC

// Phase 5 native stage — the native mirror of `web/src/BookmarksPanel.tsx`: paste-a-URL-and-save
// form + list, using the real `createBookmark`/`listBookmarks` RPCs (`gatekeeper-rpc.ts`). No
// OAuth/gatekeeper involved — see `bookmark.ts`'s own header comment for why bookmarks are the
// plan's deliberately low-complexity Phase 5 companion to Calendar.
@MainActor
final class BookmarksViewModel: ObservableObject {
    @Published private(set) var bookmarks: [RPCBookmark] = []
    @Published var newUrl: String = ""
    @Published var newTitle: String = ""
    @Published private(set) var isBusy = false
    @Published var errorMessage: String?

    private let client: WorkspaceRPCClient

    init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.client = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
    }

    func refresh() async {
        do {
            bookmarks = try await client.listBookmarks()
            errorMessage = nil
        } catch {
            errorMessage = "Failed to load bookmarks: \(error)"
        }
    }

    func capture() async {
        let url = newUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { return }
        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await client.createBookmark(url: url, title: title.isEmpty ? nil : title)
            newUrl = ""
            newTitle = ""
            await refresh()
        } catch {
            errorMessage = "Failed to save bookmark: \(error)"
        }
    }
}

public struct BookmarksView: View {
    @StateObject private var model: BookmarksViewModel

    public init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        _model = StateObject(
            wrappedValue: BookmarksViewModel(backendURL: backendURL, workspaceId: workspaceId, bearerCredential: bearerCredential)
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Bookmarks").font(.title2.bold())

            HStack {
                TextField("https://…", text: $model.newUrl)
                    .textFieldStyle(.roundedBorder)
                TextField("Title (optional)", text: $model.newTitle)
                    .textFieldStyle(.roundedBorder)
                Button(model.isBusy ? "Saving…" : "Save") { Task { await model.capture() } }
                    .disabled(model.isBusy || model.newUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if model.bookmarks.isEmpty {
                Text("No bookmarks yet.").foregroundStyle(.secondary)
            }
            ForEach(model.bookmarks, id: \.id) { bookmark in
                VStack(alignment: .leading, spacing: 2) {
                    Text(bookmark.title ?? bookmark.url).bold()
                    Text(bookmark.url).font(.caption).foregroundStyle(.secondary)
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
