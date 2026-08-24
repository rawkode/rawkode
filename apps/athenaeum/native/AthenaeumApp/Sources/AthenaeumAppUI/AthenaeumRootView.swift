import SwiftUI
import AthenaeumDomain

/// The one view both `native/macOS` and `native/iOS`'s `@main App` shells embed directly in a
/// `WindowGroup`. Phase 4 turned this into a real three-state flow, mirroring `web/src/App.tsx`'s
/// own sign-in -> workspace-switcher -> workspace composition: not signed in -> `SignInView`; signed
/// in but no workspace chosen yet -> `WorkspaceSwitcherView`; a workspace chosen -> `WorkspaceView` (the
/// pre-Phase-4 daily-note/backlinks/graph/pending-changes `ContentView`, plus the workspace-switcher
/// bar and the new `SharePanelView`). All three states share one `DevSession`, constructed once
/// here — the native analog of the web client's single `runtime`/`workspaceId` module singletons this
/// file's own prior doc comment already described, now scoped one level up to "one session,"
/// mirrored down into the workspace-scoped clients each screen constructs from it.
public struct AthenaeumRootView: View {
    @StateObject private var session = DevSession()

    public init() {}

    public var body: some View {
        Group {
            if !session.isSignedIn {
                SignInView(session: session)
            } else if let workspaceId = session.selectedWorkspaceId {
                WorkspaceView(session: session, workspaceId: workspaceId)
                    // Forces a full remount whenever the resolved (workspace, credential) pair
                    // changes — the native analog of `web/src/App.tsx`'s own documented
                    // `key={`${workspaceId}:${credential}`}` remount convention: `AthenaeumViewModel`
                    // owns per-workspace local SQLite/Automerge state that must never straddle two
                    // different workspaces or identities.
                    .id("\(workspaceId.rawValue):\(session.credential ?? "")")
            } else {
                SwitcherWrapper(session: session)
            }
        }
    }
}

/// Full-screen wrapper around `WorkspaceSwitcherView` for the "signed in, no workspace chosen yet" state —
/// distinct from the collapsed bar `WorkspaceView` shows once a workspace IS chosen, but built on
/// the exact same real view.
private struct SwitcherWrapper: View {
    @ObservedObject var session: DevSession

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Athenaeum").font(.largeTitle.bold())
            WorkspaceSwitcherView(session: session)
            Spacer()
        }
        .padding()
    }
}

/// One resolved workspace's full workspace: the pre-Phase-4 `ContentView` (daily note/backlinks/graph/
/// pending changes), with the workspace-switcher collapsed into a top bar (so switching workspaces
/// mid-session is a real, reachable action) and the new `SharePanelView` beneath it.
private struct WorkspaceView: View {
    @ObservedObject var session: DevSession
    let workspaceId: EntityId

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                WorkspaceSwitcherView(session: session)

                Divider()

                switch Result(catching: {
                    try AthenaeumViewModel(baseURL: session.backendURL, workspaceId: workspaceId, bearerCredential: session.credential)
                }) {
                case .success(let model):
                    ContentView(model: model)
                case .failure(let error):
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.largeTitle)
                            .foregroundStyle(.orange)
                        Text("Couldn't start Athenaeum")
                            .font(.headline)
                        Text(String(describing: error))
                            .font(.caption.monospaced())
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                }

                Divider()

                // Today Brief is a server-owned local-day projection. It replaces the legacy
                // raw synced-event CalendarDayView; the view never joins or sorts provider data.
                TodayBriefView(backendURL: session.backendURL, workspaceId: workspaceId, bearerCredential: session.credential)

                Divider()

                BookmarksView(backendURL: session.backendURL, workspaceId: workspaceId, bearerCredential: session.credential)

                Divider()

                // Native voice-UI task: start/stop a realtime voice session, stream real
                // AVAudioEngine mic capture to the backend's voice-audio RPC surface, and reuse
                // Phase 3's PendingChangesView for the resulting accept/revert flow. Accepts an
                // anonymous connection for an ungoverned workspace, matching every panel above except
                // SharePanelView.
                VoiceAssistantView(
                    backendURL: session.backendURL, workspaceId: workspaceId, bearerCredential: session.credential
                )

                Divider()

                if let credential = session.credential {
                    SharePanelView(backendURL: session.backendURL, workspaceId: workspaceId, bearerCredential: credential)
                }
            }
            .padding()
            .frame(maxWidth: 720, alignment: .leading)
        }
    }
}
