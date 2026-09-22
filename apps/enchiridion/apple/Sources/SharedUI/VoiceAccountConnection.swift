#if os(iOS) || os(macOS)
import SwiftUI

/// Account recovery stays beside the action that needs it, using the editor's cookie store.
struct VoiceAccountConnection: View {
    @ObservedObject var session: NativeSession
    @AppStorage("enchiridionTheme", store: EnchiridionPreferences.store) private var theme: EnchiridionTheme = .dawn
    @State private var signInPresented = false
    @State private var checkID = 0

    var body: some View {
        VStack(spacing: 12) {
            if session.isVerifying {
                ProgressView("Checking your account…")
            } else {
                Text("Connect to start a conversation")
                    .font(.headline)
                Text(session.errorMessage ?? "Use the same Enchiridion account as your notebook.")
                    .font(.footnote).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("voiceAccountStatus")
                HStack {
                    Button("Sign in") { signInPresented = true }
                        .buttonStyle(.glassProminent).foregroundStyle(theme.canvas)
                        .accessibilityIdentifier("voiceSignIn")
                    Button("Try again") { checkID += 1 }
                        .buttonStyle(.glass)
                        .accessibilityIdentifier("voiceRetryConnection")
                }
            }
        }
        .task(id: checkID) {
            guard !session.isConnected, !session.isVerifying else { return }
            // NativeSession publishes the actual error for display above.
            try? await session.verifyConnection()
        }
        .sheet(isPresented: $signInPresented) {
            NavigationStack {
                SignInWebView(session: session)
                    .navigationTitle("Sign in to Enchiridion")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { signInPresented = false }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Check connection") { checkID += 1 }
                                .disabled(session.isVerifying)
                        }
                    }
                    .safeAreaInset(edge: .bottom) {
                        Text(session.isVerifying ? "Checking your account…" : (session.errorMessage ?? "Sign in with your existing account."))
                            .font(.caption).padding().background(.regularMaterial)
                    }
            }
            #if os(macOS)
            .frame(width: 700, height: 650)
            #endif
        }
        .onChange(of: session.isConnected) { _, connected in
            if connected { signInPresented = false }
        }
    }
}
#endif
