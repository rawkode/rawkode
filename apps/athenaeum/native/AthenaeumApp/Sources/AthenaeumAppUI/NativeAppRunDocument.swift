import Foundation

public enum NativeAppRunResource: Equatable, Sendable {
    case client
    case run(path: String)
}

public enum NativeAppRunResourcePolicy {
    public static func resource(for url: URL, origin: URL) -> NativeAppRunResource? {
        guard url.scheme == origin.scheme, url.host == origin.host,
              url.fragment == nil, url.user == nil, url.password == nil,
              !url.path.contains("\\"), !url.path.contains(".."),
              !url.path.contains("//"), !(url.query?.lowercased().contains("token") ?? false)
        else { return nil }
        if url.path == "/client.js" { return .client }
        if url.path == "/run" { return .run(path: "") }
        if url.path.hasPrefix("/run/") { return .run(path: String(url.path.dropFirst(5))) }
        return nil
    }
}

/// The HTML shell for one App Run. Its custom scheme is intentionally synthetic: the document
/// has no backend base URL and contains no capability or user bearer. The URL scheme handler owns
/// the short-lived capability separately and proxies only app-scoped resources.
public struct NativeAppRunDocument: Sendable, Equatable {
    public let workspaceId: String
    public let appId: String
    public let clientCodeVersion: Int
    public let html: String
    public let originURL: URL
    public let clientJavaScriptURL: URL
    public let runBaseURL: URL

    public init(workspaceId: String, appId: String, clientCodeVersion: Int) {
        let host = Self.syntheticHost(workspaceId: workspaceId, appId: appId)
        let origin = URL(string: "athenaeum-app-run://\(host)/")!
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
        self.html = Self.makeHTML(clientJavaScriptURL: client, runBaseURL: run)
    }

    static func makeHTML(clientJavaScriptURL: URL, runBaseURL: URL) -> String {
        let clientURL = htmlEscape(clientJavaScriptURL.absoluteString)
        let runURL = jsonStringLiteral(runBaseURL.absoluteString)
        return """
        <!doctype html>
        <html><head><meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src athenaeum-app-run:; connect-src athenaeum-app-run:; style-src 'unsafe-inline'; img-src athenaeum-app-run: data:">
        <style>html,body,#app{margin:0;min-height:100%;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:transparent;color:#222}#app{padding:16px;box-sizing:border-box}</style>
        </head><body><main id="app" aria-label="App"></main>
        <script>
        (() => {
          const runBaseURL = \(runURL);
          const originalFetch = window.fetch.bind(window);
          const rewriteFetchTarget = (input) => {
            if (input instanceof Request) return input;
            const raw = input instanceof URL ? input.href : String(input);
            if (/^(https?:)?\\/\\//i.test(raw)) return raw;
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

    private static func syntheticHost(workspaceId: String, appId: String) -> String {
        let source = "\(workspaceId)-\(appId)"
        let allowed = source.unicodeScalars.map { scalar in
            scalar.isASCII && (scalar == "-" || scalar == "." || scalar.value >= 48 && scalar.value <= 57 || scalar.value >= 65 && scalar.value <= 90 || scalar.value >= 97 && scalar.value <= 122) ? Character(scalar) : "-"
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
