import SwiftUI

/// Top-level composition, mirroring `web/src/App.tsx`'s layout (`DailyNote` then `GraphView`):
/// the one screen both `native/macOS` and `native/iOS`'s thin app shells embed in a `WindowGroup`.
/// A single `AthenaeumViewModel` (constructed once, in the app shell's `@main App`) is threaded
/// through — the native equivalent of the web client's single `runtime`/`workspaceId` module
/// singletons.
public struct ContentView: View {
    @StateObject private var model: AthenaeumViewModel
    @StateObject private var agentEditModel: AgentEditViewModel

    /// `model` is constructed by the caller (the app shell's `@main App`, where
    /// `AthenaeumViewModel.init` throwing — it opens a real local SQLite file — is handled with a
    /// real `try`/error UI rather than swallowed), then handed in already-built; `StateObject`'s
    /// job here is just "own this instance across `ContentView` re-renders", not construct it.
    /// `agentEditModel` is constructed here, pinned to the same `workspaceId` `model` resolved, so the
    /// Phase 3 chat/pending-changes panel talks to the same workspace the daily-note/graph panels do.
    public init(model: AthenaeumViewModel) {
        _model = StateObject(wrappedValue: model)
        _agentEditModel = StateObject(wrappedValue: AgentEditViewModel(workspaceId: model.workspaceId))
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Athenaeum").font(.largeTitle.bold())
                Text("workspace: \(model.workspaceId.rawValue)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)

                DailyNoteView(model: model)

                Divider()

                GraphNodesView(model: model)
                    .padding(.horizontal)

                Divider()

                PendingChangesView(model: agentEditModel)
                    .padding(.horizontal)
            }
            .padding()
            .frame(maxWidth: 720, alignment: .leading)
        }
        .task { await model.start() }
    }
}
