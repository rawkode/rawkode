import SwiftUI
import AthenaeumDomain

/// The one view both `native/macOS` and `native/iOS`'s `@main App` shells embed directly in a
/// `WindowGroup`. Phase 4 turned this into a real three-state flow, mirroring `web/src/App.tsx`'s
/// own sign-in -> workspace-switcher -> workspace composition: not signed in -> `SignInView`; signed
/// in but no workspace chosen yet -> `WorkspaceSwitcherView`; a workspace chosen ->
/// `WorkspaceCommandCenterView`, the focused native shell around the daily note and its supporting
/// tools. All three states share one `DevSession`, constructed once
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
                WorkspaceCommandCenterView(session: session, workspaceId: workspaceId)
                    // Forces a full remount whenever the resolved (workspace, credential) pair
                    // changes — the native analog of `web/src/App.tsx`'s own documented
                    // `key={`${workspaceId}:${credential}`}` remount convention: `AthenaeumViewModel`
                    // owns per-workspace local SQLite state, including legacy recovery witnesses
                    // and Loro replicas, that must never straddle two different workspaces or identities.
                    .id("\(workspaceId.rawValue):\(session.credential ?? "")")
            } else {
                SwitcherWrapper(session: session)
            }
        }
    }
}

/// Full-screen wrapper around `WorkspaceSwitcherView` for the "signed in, no workspace chosen yet" state —
/// distinct from the workspace sheet `WorkspaceCommandCenterView` shows once a workspace IS chosen,
/// but built on
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
