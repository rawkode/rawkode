import Foundation

// Phase 4 prerequisite ("Minimal real dev-auth / identity scheme") — the native client for
// `packages/backend/src/index.ts`'s `POST /api/dev/sign-in` route. Deliberately NOT a
// `CapnWebBatchClient` call: sign-in happens *before* any workspace/user Cap'n Web session exists
// (`auth.ts`'s own header comment: "sign-in happens before any WorkspaceDurableObject/Cap'n Web
// session exists — there is nothing to call an RPC method 'on' yet"), so this is a plain JSON
// HTTP POST, exactly matching the backend route's own shape.
//
// **HARD CONSTRAINT compliance**: this is a client for the backend's own dev-only, HMAC-signed
// stand-in credential (`dev-auth.ts`) — not OAuth, not a magic link, and it never touches any real
// identity provider. `DevSignInOutput.credential` is an opaque Bearer token this client stores and
// forwards; it never inspects or fabricates one itself.
public enum DevAuthClient {
    public struct SignInError: Error, Sendable {
        public let status: Int
        public let body: String
    }

    /// Calls `POST <backend>/api/dev/sign-in` with `{"email": "<address>"}` and decodes the
    /// `DevSignInOutput` response (`{credential, email, issuedAt, expiresAt}`). Normalization
    /// (trimming/lower-casing) happens here, once, mirroring `index.ts#handleDevSignIn`'s own doc
    /// comment about where that normalization belongs — the same discipline `Email`'s own doc
    /// comment (`Auth.swift`) documents for the TS side.
    public static func signIn(
        email: String,
        backendURL: URL,
        urlSession: URLSession = .shared
    ) async throws -> (credential: String, email: String, issuedAt: String, expiresAt: String) {
        let normalized = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var request = URLRequest(url: backendURL.appendingPathComponent("api/dev/sign-in"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["email": normalized])

        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw SignInError(status: status, body: String(data: data, encoding: .utf8) ?? "")
        }

        guard
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let credential = json["credential"] as? String,
            let respondedEmail = json["email"] as? String,
            let issuedAt = json["issuedAt"] as? String,
            let expiresAt = json["expiresAt"] as? String
        else {
            throw CapnWebError.malformedMessage("malformed DevSignInOutput response")
        }
        return (credential: credential, email: respondedEmail, issuedAt: issuedAt, expiresAt: expiresAt)
    }
}
