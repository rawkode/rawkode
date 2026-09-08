import SwiftUI

/// Authentication remains session-owned. This local claim closes the short interval before the
/// session publishes `isSigningIn`, so Return and the button cannot schedule duplicate sign-ins.
enum DevSignInPresentation {
    static func canStartSignIn(isSessionSigningIn: Bool, isSignInInFlight: Bool) -> Bool {
        !isSessionSigningIn && !isSignInInFlight
    }

    static func isSigningIn(isSessionSigningIn: Bool, isSignInInFlight: Bool) -> Bool {
        isSessionSigningIn || isSignInInFlight
    }

    static func signInTitle(isSigningIn: Bool) -> String {
        isSigningIn ? "Signing in…" : "Sign in (dev)"
    }
}

// Phase 4 — the native mirror of `web/src/SignIn.tsx`: an email-only dev sign-in form, clearly
// labeled as a stand-in, wired to the real `DevSession.signIn(email:)` (which itself calls the
// real `POST /api/dev/sign-in` route — see `DevAuthClient.swift`'s own doc comment for the full
// HARD CONSTRAINT rationale).
public struct SignInView: View {
    @ObservedObject var session: DevSession
    @State private var email: String = ""
    @State private var isSignInInFlight = false

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

            Button(
                DevSignInPresentation.signInTitle(
                    isSigningIn: isSigningIn
                ),
                action: signIn
            )
            .disabled(trimmedEmail.isEmpty || isSigningIn)
        }
        .padding()
        .frame(maxWidth: 360, alignment: .leading)
    }

    private var isSigningIn: Bool {
        DevSignInPresentation.isSigningIn(
            isSessionSigningIn: session.isSigningIn,
            isSignInInFlight: isSignInInFlight
        )
    }

    private func signIn() {
        guard !trimmedEmail.isEmpty,
              DevSignInPresentation.canStartSignIn(
                  isSessionSigningIn: session.isSigningIn,
                  isSignInInFlight: isSignInInFlight
              )
        else {
            return
        }
        let emailToSubmit = trimmedEmail
        isSignInInFlight = true
        Task { @MainActor in
            defer { isSignInInFlight = false }
            await session.signIn(email: emailToSubmit)
        }
    }
}
