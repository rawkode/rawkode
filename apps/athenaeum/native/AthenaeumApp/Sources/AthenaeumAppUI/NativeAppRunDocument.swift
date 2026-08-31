import Foundation

public enum NativeAppRunResource: Equatable, Sendable {
    case client
    case run(path: String)
}

public enum NativeAppRunResourcePolicy {
    public static func resource(for url: URL, origin: URL) -> NativeAppRunResource? {
        guard url.scheme?.lowercased() == origin.scheme?.lowercased(),
            url.host?.lowercased() == origin.host?.lowercased(),
            url.port == origin.port,
            url.fragment == nil, url.user == nil, url.password == nil,
            safePath(url), safeQuery(url)
        else { return nil }
        if url.path == "/client.js" {
            guard clientVersion(url) != nil else { return nil }
            return .client
        }
        if url.path == "/run" { return .run(path: "") }
        if url.path.hasPrefix("/run/") { return .run(path: String(url.path.dropFirst(5))) }
        return nil
    }

    /// The client URL is the only resource with a query supplied by the runner. Keeping this
    /// parser strict prevents an App from turning the handler into a credential-bearing URL
    /// proxy by smuggling authority or auth-like query keys through its custom origin.
    public static func clientVersion(_ url: URL) -> Int? {
        guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
            items.count == 1,
            items[0].name == "v",
            let value = items[0].value,
            let version = Int(value), version > 0
        else { return nil }
        return version
    }

    public static func queryItems(_ url: URL) -> [URLQueryItem]? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let raw = components.percentEncodedQuery ?? ""
        guard validPercentEncoding(raw) else { return nil }
        guard let items = components.queryItems else {
            return raw.isEmpty ? [] : nil
        }
        guard
            items.allSatisfy({ item in
                guard let decodedName = item.name.removingPercentEncoding else { return false }
                let name = decodedName.lowercased()
                return !name.isEmpty && !forbiddenQueryNames.contains(name)
            })
        else { return nil }
        return items
    }

    private static func safePath(_ url: URL) -> Bool {
        let path = url.path
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return false
        }
        let encoded = components.percentEncodedPath.lowercased()
        return validPercentEncoding(encoded) && !path.contains("\\") && !path.contains("..")
            && !path.contains("//") && !encoded.contains("%5c") && !encoded.contains("%2e")
            && !encoded.contains("%2f") && !encoded.contains("%00")
    }

    private static func safeQuery(_ url: URL) -> Bool {
        queryItems(url) != nil && url.fragment == nil
    }

    private static let forbiddenQueryNames: Set<String> = [
        "token", "authorization", "cookie", "credential", "bearer",
    ]

    private static func validPercentEncoding(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        var index = 0
        while index < scalars.count {
            guard scalars[index] == "%" else {
                index += 1
                continue
            }
            guard index + 2 < scalars.count,
                scalars[index + 1].isASCII,
                scalars[index + 2].isASCII,
                CharacterSet(charactersIn: "0123456789abcdefABCDEF").contains(scalars[index + 1]),
                CharacterSet(charactersIn: "0123456789abcdefABCDEF").contains(scalars[index + 2])
            else { return false }
            index += 3
        }
        return true
    }
}

/// The HTML shell for one App Run. Its custom scheme is intentionally synthetic: the document
/// has no backend base URL and contains no capability or user bearer. The URL scheme handler owns
/// the short-lived capability separately and proxies only app-scoped resources.
public struct NativeAppRunDocument: Sendable, Equatable {
    public static let scheme = "athenaeum-app-run"
    public let workspaceId: String
    public let appId: String
    public let clientCodeVersion: Int
    public let html: String
    public let originURL: URL
    public let clientJavaScriptURL: URL
    public let runBaseURL: URL

    public init(
        workspaceId: String, appId: String, clientCodeVersion: Int, launchID: String = UUID().uuidString
    ) {
        let host = Self.syntheticHost(workspaceId: workspaceId, appId: appId, launchID: launchID)
        let origin = URL(string: "\(Self.scheme)://\(host)/")!
        let run = origin.appendingPathComponent("run")
        var client = origin.appendingPathComponent("client.js")
        var components = URLComponents(url: client, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "v", value: String(clientCodeVersion))]
        client = components?.url ?? client
        self.originURL = origin
        self.workspaceId = workspaceId
        self.appId = appId
        self.clientCodeVersion = clientCodeVersion
        self.clientJavaScriptURL = client
        self.runBaseURL = run
        self.html = Self.makeHTML(
            clientJavaScriptURL: client,
            runBaseURL: run,
            cspNonce: Self.cspNonce(for: launchID)
        )
    }

    static func makeHTML(clientJavaScriptURL: URL, runBaseURL: URL, cspNonce: String) -> String {
        let clientURL = htmlEscape(clientJavaScriptURL.absoluteString)
        let runURL = jsonStringLiteral(runBaseURL.absoluteString)
        let nonce = htmlEscape(cspNonce)
        return """
            <!doctype html>
            <html><head><meta name="viewport" content="width=device-width, initial-scale=1">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src athenaeum-app-run: 'nonce-\(nonce)'; connect-src athenaeum-app-run:; style-src 'unsafe-inline'; img-src athenaeum-app-run: data:">
            <style>html,body,#app{margin:0;min-height:100%;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:transparent;color:#222}#app{padding:16px;box-sizing:border-box}</style>
            </head><body><main id="app" aria-label="App"></main>
            <script nonce="\(nonce)">
            (() => {
              const runBaseURL = \(runURL);
              const originalFetch = window.fetch.bind(window);
              const rewriteFetchTarget = (input) => {
                if (input instanceof Request) return input;
                const raw = input instanceof URL ? input.href : String(input);
                if (/^[a-z][a-z0-9+.-]*:|^\\/\\//i.test(raw)) return raw;
                const path = raw.startsWith('/') ? raw : `/${raw}`;
                return `${runBaseURL}${path}`;
              };
              window.fetch = (input, init) => originalFetch(rewriteFetchTarget(input), init);
            })();
            </script>
            <script src="\(clientURL)" defer></script>
            </body></html>
            """
    }

    private static func cspNonce(for launchID: String) -> String {
        let bytes = Data((launchID.isEmpty ? "athenaeum-app-run" : launchID).utf8)
        return bytes.base64EncodedString()
    }

    private static func syntheticHost(workspaceId: String, appId: String, launchID: String) -> String {
        let source = "\(workspaceId)-\(appId)-\(launchID)"
        let allowed = source.unicodeScalars.map { scalar in
            scalar.isASCII
                && (scalar == "-" || scalar == "." || scalar.value >= 48 && scalar.value <= 57
                    || scalar.value >= 65 && scalar.value <= 90 || scalar.value >= 97 && scalar.value <= 122)
                ? Character(scalar) : "-"
        }
        return String(allowed).lowercased()
    }

    private static func jsonStringLiteral(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
            let encoded = String(data: data, encoding: .utf8)
        else { return "\"\"" }
        return String(encoded.dropFirst().dropLast())
    }

    private static func htmlEscape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}
