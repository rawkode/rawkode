import SwiftUI
import WebKit

struct SettingsView: View {
    @ObservedObject var store: WorkspaceStore
    @ObservedObject var session: NativeSession
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @State private var signIn = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("Appearance") {
                    Picker("Palette", selection: $theme) { ForEach(ApsidesTheme.allCases) { Text($0.label).tag($0) } }
                }
                Section("Enchiridion account") {
                    Text(session.email ?? session.origin.host ?? "Enchiridion").font(.callout)
                    Text(session.isConnected ? "Connected" : (store.vault.accountID != nil ? "Offline · showing saved data" : "Not connected")).foregroundStyle(theme.secondary)
                    if session.isConnected || store.vault.accountID != nil {
                        Button("Refresh calendars and activity") { Task { await store.refresh() } }.disabled(store.refreshing)
                        Button("Sign out") { Task { await store.signOut() } }
                    }
                    if !session.isConnected {
                        Button("Sign in") { signIn = true }
                    }
                    if let error = session.errorMessage { Text(error).font(.callout).foregroundStyle(theme.secondary) }
                }
                Section("Your data") {
                    NavigationLink("Storage & sync") {
                        Form {
                            Section("On this device") {
                                Text("Device notes and capture drafts remain here when you sign out.")
                                Text("Pending task changes stay on this device until they sync to your account.")
                            }
                            Section("Workspace") {
                                Text("The daily note belongs to your connected workspace. Use Send to workspace to upload individual captures.")
                            }
                            Section("Apple Watch") {
                                Text("A capture reaches your phone before it reaches your account. Check its status in Captures.")
                            }
                        }.formStyle(.grouped).navigationTitle("Storage & sync")
                    }
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
                        if let error = session.errorMessage { Text(error).font(.caption).padding().background(.regularMaterial) }
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
