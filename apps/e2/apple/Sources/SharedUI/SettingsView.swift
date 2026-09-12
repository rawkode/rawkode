import SwiftUI
import WebKit

struct SettingsView: View {
    @ObservedObject var store: WorkspaceStore
    @ObservedObject var session: NativeSession
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @AppStorage("notesEntryStyle", store: ApsidesPreferences.store) private var notesEntryStyle: NotesEntryStyle = .floatingButton
    @State private var signIn = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("Appearance") {
                    Picker("Palette", selection: $theme) { ForEach(ApsidesTheme.allCases) { Text($0.label).tag($0) } }
                }
                #if os(iOS)
                Section("Today’s note") {
                    Picker("Notes control", selection: $notesEntryStyle) {
                        ForEach(NotesEntryStyle.allCases) { Text($0.label).tag($0) }
                    }.accessibilityIdentifier("notesEntryStyle")
                    Text("Choose how you open your note from the day timeline. Tap either control, or swipe up on the handle.")
                        .font(.caption).foregroundStyle(theme.secondary)
                }
                #endif
                Section("Enchiridion account") {
                    Text(session.origin.host ?? "Enchiridion").font(.callout)
                    Text(session.isConnected ? "Connected" : "Local notebook · not connected").foregroundStyle(theme.secondary)
                    if session.isConnected {
                        Button("Refresh connected context") { Task { await store.refresh() } }.disabled(store.refreshing)
                        Button("Sign out") { Task { await store.signOut() } }
                    } else {
                        Button("Sign in") { signIn = true }
                    }
                    if let error = session.errorMessage { Text(error).font(.callout).foregroundStyle(theme.secondary) }
                    Text("Sign-in opens your existing Enchiridion workspace. The Today editor uses your web workspace. Earlier device notes remain local. Send individual captures to the workspace when ready.").font(.caption).foregroundStyle(theme.secondary)
                }
                Section("Your data") {
                    Text("Local notes and capture drafts are saved on this device. They remain here when you sign out.")
                    Text("Apple Watch captures are acknowledged only after the iPhone saves them. This does not mean they have reached your account.").font(.caption).foregroundStyle(theme.secondary)
                }
            }.formStyle(.grouped).navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 480)
        #endif
        .sheet(isPresented: $signIn) {
            NavigationStack {
                SignInWebView(session: session)
                    .navigationTitle("Sign in to Enchiridion")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { signIn = false } }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Check connection") { Task { do { try await session.verifyConnection(); signIn = false; await store.refresh() } catch {} } }.disabled(session.isVerifying)
                        }
                    }
                    .safeAreaInset(edge: .bottom) {
                        Text(session.errorMessage ?? "Use your existing sign-in method. If it does not work in this window, close it and continue using your local notebook.").font(.caption).padding().background(.regularMaterial)
                    }
                    .onChange(of: session.isConnected) { _, connected in if connected { signIn = false; Task { await store.refresh() } } }
            }
            #if os(macOS)
            .frame(width: 700, height: 650)
            #endif
        }
    }
}
#if os(macOS)
struct SignInWebView: NSViewRepresentable {
    let session: NativeSession
    func makeNSView(context: Context) -> WKWebView { session.makeSignInWebView() }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#else
struct SignInWebView: UIViewRepresentable {
    let session: NativeSession
    func makeUIView(context: Context) -> WKWebView { session.makeSignInWebView() }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#endif
