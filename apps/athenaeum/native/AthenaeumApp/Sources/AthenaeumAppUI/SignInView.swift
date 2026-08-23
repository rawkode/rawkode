import SwiftUI

// Phase 4 — the native mirror of `web/src/SignIn.tsx`: an email-only dev sign-in form, clearly
// labeled as a stand-in, wired to the real `DevSession.signIn(email:)` (which itself calls the
// real `POST /api/dev/sign-in` route — see `DevAuthClient.swift`'s own doc comment for the full
// HARD CONSTRAINT rationale).
public struct SignInView: View {
    @ObservedObject var session: DevSession
    @State private var email: String = ""

    public init(session: DevSession) {
        self.session = session
    }

    private var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Athenaeum").font(.largeTitle.bold())
            Text("Dev sign-in").font(.headline)
            Text(
                "A stand-in for real sign-in, not production auth. Any email works; no password, "
                    + "no verification."
            )
            .font(.caption)
            .foregroundStyle(.secondary)

            TextField("Email", text: $email)
                .textFieldStyle(.roundedBorder)
                .disableAutocorrection(true)
                #if os(iOS)
                .textInputAutocapitalization(.never)
                .keyboardType(.emailAddress)
                #endif
                .onSubmit(signIn)

            if let error = session.errorMessage {
                Text(error).font(.caption).foregroundStyle(.red)
            }

            Button(session.isSigningIn ? "Signing in…" : "Sign in (dev)", action: signIn)
                .disabled(trimmedEmail.isEmpty || session.isSigningIn)
        }
        .padding()
        .frame(maxWidth: 360, alignment: .leading)
    }

    private func signIn() {
        guard !trimmedEmail.isEmpty else { return }
        let emailToSubmit = trimmedEmail
        Task { await session.signIn(email: emailToSubmit) }
    }
}
