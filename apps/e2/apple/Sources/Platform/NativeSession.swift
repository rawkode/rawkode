#if os(iOS) || os(macOS)
import ApsidesCore
import Combine
import Foundation
import WebKit

/// A narrow bridge to the existing Access-protected website. It never asserts an owner.
@MainActor
public final class NativeSession: NSObject, ObservableObject, WKNavigationDelegate {
    public let origin: URL
    @Published public private(set) var isConnected = false
    @Published public private(set) var isVerifying = false
    @Published public private(set) var errorMessage: String?
    @Published public private(set) var accountID: String?
    @Published public private(set) var email: String?
    public var status: String { isVerifying ? "Checking connection…" : (isConnected ? "Connected to Enchiridion" : "Not connected") }

    private let websiteDataStore: WKWebsiteDataStore
    private var generation = 0

    public enum SessionError: LocalizedError {
        case invalidOrigin, signInRequired, invalidResponse, responseTooLarge, invalidDocumentID, cancelled, captureConflict

        public var errorDescription: String? {
            switch self {
            case .invalidOrigin: "Use the HTTPS address of your Enchiridion website, without a path."
            case .signInRequired: "Sign in to your Enchiridion website to load connected data."
            case .invalidResponse: "Enchiridion did not return valid account data."
            case .responseTooLarge: "The response is too large to open on this device."
            case .invalidDocumentID: "This document address is invalid."
            case .cancelled: "The connection changed. Please try again."
            case .captureConflict: "This capture already exists with different content. Your local copy is safe."
            }
        }
    }

    public init(origin: URL) throws {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/" else {
            throw SessionError.invalidOrigin
        }
        var allowedScheme = components.scheme?.lowercased() == "https"
        #if DEBUG
        allowedScheme = allowedScheme || (components.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host))
        #endif
        guard allowedScheme else { throw SessionError.invalidOrigin }
        components.scheme = components.scheme?.lowercased()
        components.host = host.lowercased()
        components.path = ""
        guard let normalized = components.url else { throw SessionError.invalidOrigin }
        self.origin = normalized
        self.websiteDataStore = .default()
        super.init()
    }

    private var editorWebView: WKWebView?

    /// Keep the editor alive across native tab switches; use the same cookie store as sign-in.
    public func makeEditorWebView() -> WKWebView {
        if let editorWebView { return editorWebView }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = websiteDataStore
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.allowsBackForwardNavigationGestures = false
        #if os(iOS)
        view.isOpaque = true
        #endif
        editorWebView = view
        return view
    }

    /// Used for the dedicated account sign-in sheet.
    public func makeSignInWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = websiteDataStore
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.load(URLRequest(url: origin))
        return view
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let url = webView.url, matchesOrigin(url), !isVerifying else { return }
        Task { try? await verifyConnection() }
    }

    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }
        // Identity-provider HTTPS redirects are allowed inside the sign-in view.
        // No script is injected and no credential is copied to another origin.
        let allowed = url.scheme == "https" || matchesOrigin(url)
        return allowed ? .allow : .cancel
    }

    public func verifyConnection() async throws {
        let currentGeneration = generation
        isVerifying = true
        defer { if generation == currentGeneration { isVerifying = false } }
        do {
            let query = try JSONSerialization.data(withJSONObject: ["query": "query AppleAccount { me { id email } }"])
            let bytes = try await read(path: "/api/graphql", body: query, limit: 32 * 1024)
            guard let body = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  body["errors"] == nil,
                  let data = body["data"] as? [String: Any],
                  let me = data["me"] as? [String: Any],
                  let verifiedID = me["id"] as? String, !verifiedID.isEmpty,
                  let verifiedEmail = me["email"] as? String, !verifiedEmail.isEmpty else { throw SessionError.invalidResponse }
            guard currentGeneration == generation else { throw SessionError.cancelled }
            if let accountID, accountID != verifiedID {
                generation += 1
                isVerifying = false
            }
            accountID = verifiedID
            email = verifiedEmail
            isConnected = true
            errorMessage = nil
        } catch {
            if currentGeneration == generation {
                isConnected = false
                accountID = nil
                email = nil
                errorMessage = error.localizedDescription
            }
            throw error
        }
    }

    /// Returns the existing GraphQL envelope, including partial-data/errors information.
    public func today(date: String, from: Date, to: Date) async throws -> Data {
        let formatter = ISO8601DateFormatter()
        let query = """
        query AppleToday($date: String!, $from: String!, $to: String!) {
          me { today(date: $date, from: $from, to: $to) {
            googleEvents { connectionId id calendarId calendarName calendarColor summary start end recurringEventId attendees { email name } }
            googleEventsPartial
            googlePeople { connectionId id displayName emails }
            githubActivity { connectionId id resourceId kind title summary number url repository actor createdAt action }
          } }
        }
        """
        let body = try JSONSerialization.data(withJSONObject: [
            "query": query,
            "variables": ["date": date, "from": formatter.string(from: from), "to": formatter.string(from: to)],
        ])
        return try await read(path: "/api/graphql", body: body, limit: 4 * 1024 * 1024)
    }

    public func document(id: String) async throws -> Data {
        guard id.range(of: "^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$", options: .regularExpression) != nil else {
            throw SessionError.invalidDocumentID
        }
        return try await read(path: "/api/documents/\(id)", limit: 17 * 1024 * 1024)
    }

    public func entities(query: String) async throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: [
            "query": "query AppleEntities($query: String!) { me { entities(query: $query, limit: 50) { id label bodyDocumentId tagIds rootId } } }",
            "variables": ["query": String(query.prefix(200))],
        ])
        return try await read(path: "/api/graphql", body: body, limit: 4 * 1024 * 1024)
    }

    public func supertags() async throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: [
            "query": "query AppleSupertags { me { supertags { id name kind parentId rootId depth revision archived } } }",
        ])
        return try await read(path: "/api/graphql", body: body, limit: 4 * 1024 * 1024)
    }

    public func captureFeed() async throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: [
            "query": "query AppleCaptures { me { documentFeed(prefix: \"capture:\", limit: 100) { id revision createdAt updatedAt } } }",
        ])
        return try await read(path: "/api/graphql", body: body, limit: 1024 * 1024)
    }

    /// Only creates a capture document. It cannot update daily/event notes or overwrite a revision.
    /// The caller must retain id/date/text unchanged until this method acknowledges persistence.
    public func createCapture(id: UUID, text: String, date: Date) async throws {
        let operationGeneration = generation
        let documentID = "capture:\(id.uuidString.lowercased())"
        let note = try RemoteCaptureDocument.note(text: text, date: date)
        let existing = try JSONSerialization.jsonObject(with: await document(id: documentID)) as? [String: Any]
        guard operationGeneration == generation else { throw SessionError.cancelled }
        if let stored = existing?["document"] as? [String: Any] {
            guard captureMatches(stored, id: documentID, note: note) else { throw SessionError.captureConflict }
            return
        }
        guard existing?["document"] is NSNull else { throw SessionError.invalidResponse }
        let body = try JSONSerialization.data(withJSONObject: ["note": note, "expectedRevision": NSNull()])
        let bytes = try await read(path: "/api/documents/\(documentID)", body: body, limit: 17 * 1024 * 1024, allowConflict: true)
        guard operationGeneration == generation else { throw SessionError.cancelled }
        guard let result = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let stored = result["document"] as? [String: Any] else { throw SessionError.invalidResponse }
        // Also handles a lost first response or another sender with the same capture UUID.
        guard captureMatches(stored, id: documentID, note: note) else { throw SessionError.captureConflict }
    }

    private func captureMatches(_ stored: [String: Any], id: String, note: [String: Any]) -> Bool {
        guard stored["id"] as? String == id,
              let storedNote = stored["note"] as? NSDictionary,
              let revision = stored["revision"] as? Int, revision > 0 else { return false }
        return storedNote.isEqual(to: note)
    }

    /// Ask the existing editor's synchronous unsaved-change guard before replacing its page.
    public func editorCanLeave() async -> Bool {
        guard let view = editorWebView, let url = view.url, matchesOrigin(url) else { return true }
        do {
            let result = try await view.evaluateJavaScript("(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return !event.defaultPrevented; })()")
            return result as? Bool == true
        } catch { return false }
    }

    public func signOut() async -> Bool {
        guard await editorCanLeave() else {
            errorMessage = "Your editor has unsaved changes. Wait for All changes saved or export your note before signing out."
            return false
        }
        editorWebView?.loadHTMLString("<p>Signed out. Return to Today to sign in.</p>", baseURL: nil)
        generation += 1
        isConnected = false
        accountID = nil
        email = nil
        isVerifying = false
        errorMessage = nil
        // This store belongs to this app. Remove IdP sessions as well as the application cookie.
        await websiteDataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        return true
    }

    private func matchesOrigin(_ url: URL) -> Bool {
        url.scheme?.lowercased() == origin.scheme &&
            url.host?.lowercased() == origin.host && effectivePort(url) == effectivePort(origin)
    }

    private func effectivePort(_ url: URL) -> Int? {
        url.port ?? (url.scheme == "https" ? 443 : 80)
    }

    private func read(path: String, body: Data? = nil, limit: Int, allowConflict: Bool = false) async throws -> Data {
        let currentGeneration = generation
        let url = origin.appendingPathComponent(path)
        guard matchesOrigin(url) else { throw SessionError.invalidOrigin }
        let cookies = await websiteDataStore.httpCookieStore.allCookies()
        guard currentGeneration == generation else { throw SessionError.cancelled }
        let eligible = cookies.filter { cookie in
            let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
            let pathMatches = cookie.path == "/" || url.path == cookie.path ||
                url.path.hasPrefix(cookie.path.hasSuffix("/") ? cookie.path : cookie.path + "/")
            return cookie.name == "CF_Authorization" && domain.lowercased() == origin.host &&
                pathMatches && (cookie.expiresDate.map { $0 > Date() } ?? true) &&
                (cookie.isSecure || origin.scheme == "http")
        }
        // No fallback to a team-domain token or a caller-supplied JWT assertion.
        guard let cookie = eligible.sorted(by: { $0.path.count > $1.path.count }).first else {
            isConnected = false
            accountID = nil
            email = nil
            throw SessionError.signInRequired
        }
        var request = URLRequest(url: url)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue(HTTPCookie.requestHeaderFields(with: [cookie])["Cookie"], forHTTPHeaderField: "Cookie")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 15

        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForResource = 15
        let session = URLSession(configuration: configuration, delegate: NativeRedirectBlocker(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse,
              let responseURL = http.url, matchesOrigin(responseURL) else { throw SessionError.invalidResponse }
        if http.statusCode == 401 || http.statusCode == 403 || (300..<400).contains(http.statusCode) {
            if currentGeneration == generation {
                isConnected = false
                accountID = nil
                email = nil
                errorMessage = SessionError.signInRequired.localizedDescription
            }
            throw SessionError.signInRequired
        }
        guard http.statusCode == 200 || (allowConflict && http.statusCode == 409),
              http.mimeType?.lowercased() == "application/json" else { throw SessionError.invalidResponse }
        if http.expectedContentLength > limit { throw SessionError.responseTooLarge }
        var result = Data()
        for try await byte in bytes {
            if result.count >= limit { throw SessionError.responseTooLarge }
            result.append(byte)
        }
        guard currentGeneration == generation else { throw SessionError.cancelled }
        return result
    }
}

/// A cookie-bearing API request must never be redirected, even to a login page.
private final class NativeRedirectBlocker: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
#endif
