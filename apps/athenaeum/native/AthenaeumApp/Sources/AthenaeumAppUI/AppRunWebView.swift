import AthenaeumRPC
import Foundation
import SwiftUI

#if canImport(WebKit)
import WebKit
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// Events intentionally contain only the immutable launch identity. In particular, transport
/// errors and URLs are not surfaced to the SwiftUI layer where they could accidentally expose a
/// short-lived capability in diagnostics or user-facing copy.
public enum NativeAppRunWebViewEvent: Equatable, Sendable {
    case loaded(NativeAppRunLaunchIdentity)
    case failed(NativeAppRunLaunchIdentity)
}

private enum NativeAppRunWebViewError: Error {
    case unavailable
}

extension NativeAppRunWebViewError {
    fileprivate var safeNSError: NSError {
        NSError(
            domain: "Athenaeum.AppRun",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "The App run is unavailable."]
        )
    }
}

/// A deliberately narrow URL-scheme bridge. It is a capability router, not a general-purpose
/// WebKit proxy: the only accepted resources are the captured client snapshot and paths below the
/// captured App's `/run` prefix. The user's session bearer never enters this object.
private final class NativeAppRunSchemeHandler: NSObject, WKURLSchemeHandler,
    URLSessionDataDelegate, URLSessionTaskDelegate
{
    private static let maximumRequestBodyBytes = 2 * 1024 * 1024
    private static let maximumResponseBytes = 16 * 1024 * 1024

    private struct Record {
        let schemeTask: WKURLSchemeTask
        let requestURL: URL
        let resource: NativeAppRunResource
        var dataTask: URLSessionDataTask
        var byteCount = 0
        var didReceiveResponse = false
    }

    private let backendURL: URL
    private let workspaceId: String
    private let appId: String
    private let clientCodeVersion: Int
    private let originURL: URL
    private let lock = NSLock()
    private var credential: String?
    private var active = true
    private var records: [ObjectIdentifier: Record] = [:]
    private var recordBySessionTask: [Int: ObjectIdentifier] = [:]
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }()

    init(
        backendURL: URL,
        workspaceId: String,
        appId: String,
        clientCodeVersion: Int,
        originURL: URL,
        credential: String
    ) {
        self.backendURL = backendURL
        self.workspaceId = workspaceId
        self.appId = appId
        self.clientCodeVersion = clientCodeVersion
        self.originURL = originURL
        self.credential = credential

        super.init()
    }

    func invalidate() {
        let tasks: [URLSessionDataTask]
        lock.lock()
        active = false
        credential = nil
        tasks = records.values.map(\.dataTask)
        records.removeAll()
        recordBySessionTask.removeAll()
        lock.unlock()
        tasks.forEach { $0.cancel() }
        session.invalidateAndCancel()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let taskKey = ObjectIdentifier(urlSchemeTask as AnyObject)
        guard let request = makeRequest(for: urlSchemeTask) else {
            fail(urlSchemeTask)
            return
        }
        let dataTask = session.dataTask(with: request.request)
        lock.lock()
        guard active, credential != nil else {
            lock.unlock()
            fail(urlSchemeTask)
            return
        }
        records[taskKey] = Record(
            schemeTask: urlSchemeTask,
            requestURL: request.sourceURL,
            resource: request.resource,
            dataTask: dataTask
        )
        recordBySessionTask[dataTask.taskIdentifier] = taskKey
        lock.unlock()
        dataTask.resume()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let taskKey = ObjectIdentifier(urlSchemeTask as AnyObject)
        let dataTask: URLSessionDataTask?
        lock.lock()
        dataTask = records.removeValue(forKey: taskKey).map { record in
            recordBySessionTask.removeValue(forKey: record.dataTask.taskIdentifier)
            return record.dataTask
        }
        lock.unlock()
        dataTask?.cancel()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        // Redirects could move the capability-bearing request outside the fixed backend origin.
        completionHandler(nil)
        fail(dataTask: task)
    }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
      // Let the platform validate the configured HTTPS backend. Only application-level auth
      // challenges are rejected; accepting a server-trust challenge here would be unsafe, while
      // rejecting it would make every normal HTTPS deployment unusable.
      completionHandler(.performDefaultHandling, nil)
      return
    }
    completionHandler(.cancelAuthenticationChallenge, nil)
    fail(dataTask: task)
  }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let httpResponse = response as? HTTPURLResponse,
            let record = markResponseReceived(for: dataTask)
        else {
            completionHandler(.cancel)
            fail(dataTask: dataTask)
            return
        }

        guard !(300..<400).contains(httpResponse.statusCode),
            httpResponse.expectedContentLength <= Int64(Self.maximumResponseBytes),
            let safeResponse = sanitizedResponse(httpResponse, sourceURL: record.requestURL)
        else {
            completionHandler(.cancel)
            fail(dataTask: dataTask)
            return
        }

        record.schemeTask.didReceive(safeResponse)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let result: (WKURLSchemeTask, Bool)?
        let taskKey = lock.withLock {
            recordBySessionTask[dataTask.taskIdentifier]
        }
        guard let taskKey else { return }
        lock.lock()
        guard var record = records[taskKey] else {
            lock.unlock()
            return
        }
        record.byteCount += data.count
        if record.byteCount > Self.maximumResponseBytes {
            records.removeValue(forKey: taskKey)
            recordBySessionTask.removeValue(forKey: dataTask.taskIdentifier)
            result = (record.schemeTask, true)
        } else {
            records[taskKey] = record
            result = (record.schemeTask, false)
        }
        lock.unlock()

        guard let result else { return }
        if result.1 {
            dataTask.cancel()
            result.0.didFailWithError(NativeAppRunWebViewError.unavailable.safeNSError)
        } else {
            result.0.didReceive(data)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let record: Record?
        lock.lock()
        if let taskKey = recordBySessionTask.removeValue(forKey: task.taskIdentifier) {
            record = records.removeValue(forKey: taskKey)
        } else {
            record = nil
        }
        lock.unlock()
        guard let record else { return }
        if error == nil {
            record.schemeTask.didFinish()
        } else {
            record.schemeTask.didFailWithError(NativeAppRunWebViewError.unavailable.safeNSError)
        }
    }

    private struct PreparedRequest {
        let request: URLRequest
        let sourceURL: URL
        let resource: NativeAppRunResource
    }

    private func makeRequest(for schemeTask: WKURLSchemeTask) -> PreparedRequest? {
        let incoming = schemeTask.request
        guard let sourceURL = incoming.url,
            let resource = NativeAppRunResourcePolicy.resource(for: sourceURL, origin: originURL),
            validSegment(workspaceId), validSegment(appId),
            let destination = destinationURL(for: sourceURL, resource: resource),
            let incomingMethod = incoming.httpMethod?.uppercased() ?? Optional("GET"),
            allowedMethod(incomingMethod, resource: resource),
            incoming.httpBodyStream == nil,
            (incoming.httpBody?.count ?? 0) <= Self.maximumRequestBodyBytes,
            let credential = currentCredential()
        else { return nil }

        var request = URLRequest(url: destination)
        request.httpMethod = incomingMethod
        request.httpBody = incoming.httpBody
        for (name, value) in incoming.allHTTPHeaderFields ?? [:] {
            guard allowedHeader(name) else { continue }
            request.setValue(value, forHTTPHeaderField: name)
        }
        // This is the only credential added by the bridge, and it is never part of the synthetic
        // document, its URLs, WebKit history, or a response URL exposed back to App code.
        request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        return PreparedRequest(request: request, sourceURL: sourceURL, resource: resource)
    }

    private func destinationURL(for sourceURL: URL, resource: NativeAppRunResource) -> URL? {
        guard let scheme = backendURL.scheme?.lowercased(),
            ["http", "https"].contains(scheme),
            backendURL.host != nil,
            backendURL.user == nil,
            backendURL.password == nil,
            backendURL.query == nil,
            backendURL.fragment == nil,
            let sourceQuery = NativeAppRunResourcePolicy.queryItems(sourceURL)
        else { return nil }

        var components = URLComponents(url: backendURL, resolvingAgainstBaseURL: false)
        var basePath = components?.path ?? ""
        if basePath.hasSuffix("/") { basePath.removeLast() }
        let appPath = "\(basePath)/api/workspace/\(workspaceId)/apps/\(appId)"
        switch resource {
        case .client:
            guard NativeAppRunResourcePolicy.clientVersion(sourceURL) == clientCodeVersion else {
                return nil
            }
            components?.path = "\(appPath)/client.js"
            components?.queryItems = [URLQueryItem(name: "v", value: String(clientCodeVersion))]
        case .run(let path):
            components?.path = path.isEmpty ? "\(appPath)/run" : "\(appPath)/run/\(path)"
            components?.queryItems = sourceQuery
        }
        components?.fragment = nil
        return components?.url
    }

    private func currentCredential() -> String? {
        lock.withLock {
            guard active, let credential, !credential.isEmpty else { return nil }
            return credential
        }
    }

    private func markResponseReceived(for dataTask: URLSessionDataTask) -> Record? {
        lock.lock()
        defer { lock.unlock() }
        guard let taskKey = recordBySessionTask[dataTask.taskIdentifier],
            var record = records[taskKey], !record.didReceiveResponse
        else { return nil }
        record.didReceiveResponse = true
        records[taskKey] = record
        return record
    }

    private func fail(_ schemeTask: WKURLSchemeTask) {
        schemeTask.didFailWithError(NativeAppRunWebViewError.unavailable.safeNSError)
    }

    private func fail(dataTask: URLSessionTask) {
        let record: Record?
        lock.lock()
        if let taskKey = recordBySessionTask.removeValue(forKey: dataTask.taskIdentifier) {
            record = records.removeValue(forKey: taskKey)
        } else {
            record = nil
        }
        lock.unlock()
        guard let record else { return }
        dataTask.cancel()
        record.schemeTask.didFailWithError(NativeAppRunWebViewError.unavailable.safeNSError)
    }

    private func sanitizedResponse(_ response: HTTPURLResponse, sourceURL: URL) -> HTTPURLResponse? {
        let blocked = Set([
            "authorization", "connection", "content-location", "cookie", "keep-alive", "location",
            "proxy-authenticate", "proxy-authorization", "refresh", "set-cookie", "te", "trailer",
            "transfer-encoding", "upgrade", "www-authenticate",
        ])
        var fields: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            guard let name = key as? String,
                !blocked.contains(name.lowercased()),
                let stringValue = value as? String
            else { continue }
            fields[name] = stringValue
        }
        return HTTPURLResponse(
            url: sourceURL,
            statusCode: response.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: fields
        )
    }

    private func allowedMethod(_ method: String, resource: NativeAppRunResource) -> Bool {
        switch resource {
        case .client:
            return method == "GET" || method == "HEAD"
        case .run:
            return ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].contains(method)
        }
    }

    private func allowedHeader(_ name: String) -> Bool {
        [
            "accept", "accept-language", "cache-control", "content-type", "if-modified-since",
            "if-none-match", "range",
        ]
        .contains(name.lowercased())
    }

    private func validSegment(_ value: String) -> Bool {
        guard !value.isEmpty else { return false }
        return value.unicodeScalars.allSatisfy {
            $0.isASCII
                && ($0 == "-" || $0 == "_" || ($0.value >= 48 && $0.value <= 57)
                    || ($0.value >= 65 && $0.value <= 90) || ($0.value >= 97 && $0.value <= 122))
        }
    }
}

extension NSLock {
    fileprivate func withLock<T>(_ body: () -> T) -> T {
        lock()
        defer { unlock() }
        return body()
    }
}

private final class NativeAppRunWebViewCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    private let identity: NativeAppRunLaunchIdentity
    private let document: NativeAppRunDocument
    private let handler: NativeAppRunSchemeHandler
    private let onEvent: ((NativeAppRunWebViewEvent) -> Void)?
    private var active = true
    private var didFinishInitialDocument = false

    init(
        backendURL: URL,
        document: NativeAppRunDocument,
        credential: RPCAppRunCredential,
        identity: NativeAppRunLaunchIdentity,
        onEvent: ((NativeAppRunWebViewEvent) -> Void)?
    ) {
        self.identity = identity
        self.document = document
        self.handler = NativeAppRunSchemeHandler(
            backendURL: backendURL,
            workspaceId: document.workspaceId,
            appId: document.appId,
            clientCodeVersion: document.clientCodeVersion,
            originURL: document.originURL,
            credential: credential.credential
        )
        self.onEvent = onEvent
        super.init()
    }

    func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.setURLSchemeHandler(handler, forURLScheme: NativeAppRunDocument.scheme)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.loadHTMLString(document.html, baseURL: document.originURL)
        return webView
    }

    func invalidate() {
        guard active else { return }
        active = false
        handler.invalidate()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard active,
            navigationAction.navigationType == .other,
            let url = navigationAction.request.url,
            url == document.originURL,
            !didFinishInitialDocument
        else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        guard active, navigationResponse.response.url == document.originURL, !didFinishInitialDocument
        else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard active, webView.url == document.originURL, !didFinishInitialDocument else { return }
        didFinishInitialDocument = true
        onEvent?(.loaded(identity))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        emitFailure(webView)
    }

    func webView(
        _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        emitFailure(webView)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        nil
    }

    private func emitFailure(_ webView: WKWebView) {
        guard active else { return }
        active = false
        handler.invalidate()
        onEvent?(.failed(identity))
    }
}

#if os(macOS)
private struct NativeAppRunWebViewRepresentable: NSViewRepresentable {
    let backendURL: URL
    let document: NativeAppRunDocument
    let credential: RPCAppRunCredential
    let identity: NativeAppRunLaunchIdentity
    let onEvent: ((NativeAppRunWebViewEvent) -> Void)?

    func makeCoordinator() -> NativeAppRunWebViewCoordinator {
        NativeAppRunWebViewCoordinator(
            backendURL: backendURL,
            document: document,
            credential: credential,
            identity: identity,
            onEvent: onEvent
        )
    }

    func makeNSView(context: Context) -> WKWebView { context.coordinator.makeWebView() }

    func updateNSView(_ nsView: WKWebView, context: Context) {}

    static func dismantleNSView(_ nsView: WKWebView, coordinator: NativeAppRunWebViewCoordinator) {
        nsView.stopLoading()
        nsView.navigationDelegate = nil
        nsView.uiDelegate = nil
        coordinator.invalidate()
    }
}
#elseif os(iOS)
private struct NativeAppRunWebViewRepresentable: UIViewRepresentable {
    let backendURL: URL
    let document: NativeAppRunDocument
    let credential: RPCAppRunCredential
    let identity: NativeAppRunLaunchIdentity
    let onEvent: ((NativeAppRunWebViewEvent) -> Void)?

    func makeCoordinator() -> NativeAppRunWebViewCoordinator {
        NativeAppRunWebViewCoordinator(
            backendURL: backendURL,
            document: document,
            credential: credential,
            identity: identity,
            onEvent: onEvent
        )
    }

    func makeUIView(context: Context) -> WKWebView { context.coordinator.makeWebView() }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: NativeAppRunWebViewCoordinator) {
        uiView.stopLoading()
        uiView.navigationDelegate = nil
        uiView.uiDelegate = nil
        coordinator.invalidate()
    }
}
#endif

/// Cross-platform native App runner. The generated document has a synthetic origin and the
/// WebKit bridge owns the only path from that document to the app-scoped backend capability.
public struct AppRunWebView: View {
    private let backendURL: URL
    private let document: NativeAppRunDocument
    private let credential: RPCAppRunCredential
    private let identity: NativeAppRunLaunchIdentity
    private let onEvent: ((NativeAppRunWebViewEvent) -> Void)?

    public init(
        backendURL: URL,
        document: NativeAppRunDocument,
        credential: RPCAppRunCredential,
        identity: NativeAppRunLaunchIdentity,
        onEvent: ((NativeAppRunWebViewEvent) -> Void)? = nil
    ) {
        self.backendURL = backendURL
        self.document = document
        self.credential = credential
        self.identity = identity
        self.onEvent = onEvent
    }

    public var body: some View {
        #if canImport(WebKit)
        NativeAppRunWebViewRepresentable(
            backendURL: backendURL,
            document: document,
            credential: credential,
            identity: identity,
            onEvent: onEvent
        )
        #else
        Text("App runs are unavailable on this platform.")
            .foregroundStyle(.secondary)
        #endif
    }
}
#else

/// Fallback for platforms without WebKit. AthenaeumApp is currently built only for macOS and iOS;
/// keeping this branch makes the shared target explicit about its graceful degradation.
public struct AppRunWebView: View {
    public init(
        backendURL: URL,
        document: NativeAppRunDocument,
        credential: RPCAppRunCredential,
        identity: NativeAppRunLaunchIdentity,
        onEvent: ((NativeAppRunWebViewEvent) -> Void)? = nil
    ) {}

    public var body: some View { Text("App runs are unavailable on this platform.") }
}

public enum NativeAppRunWebViewEvent: Equatable, Sendable {
    case loaded(NativeAppRunLaunchIdentity)
    case failed(NativeAppRunLaunchIdentity)
}
#endif
