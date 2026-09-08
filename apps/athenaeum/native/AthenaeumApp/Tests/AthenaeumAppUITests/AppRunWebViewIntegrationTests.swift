#if canImport(WebKit)
import Foundation
import WebKit
@testable import AthenaeumAppUI
import XCTest

/// Host-level proof for the generated native App document. This deliberately uses a tiny in-memory
/// scheme handler rather than the production backend: it proves that WebKit accepts the per-launch
/// CSP nonce, executes the bootstrap before client code, and sends a relative POST to /run/*.
@MainActor
final class AppRunWebViewIntegrationTests: XCTestCase {
    func testDocumentExecutesRelativeGetAndPostThroughRunRoute() async throws {
        let document = NativeAppRunDocument(
            workspaceId: "workspace-1",
            appId: "app-1",
            clientCodeVersion: 3,
            launchID: "webkit-integration"
        )
        let schemeHandler = IntegrationSchemeHandler()
        let didFinishNavigation = expectation(description: "document navigation finishes")
        let didReceiveRunRequest = expectation(description: "relative GET and POST reach /run")
        didReceiveRunRequest.expectedFulfillmentCount = 2
        let capture = RunRequestCapture()
        schemeHandler.onRunRequest = { request in
            capture.store(request)
            didReceiveRunRequest.fulfill()
        }

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: NativeAppRunDocument.scheme)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let navigationDelegate = IntegrationNavigationDelegate {
            didFinishNavigation.fulfill()
        }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(document.html, baseURL: document.originURL)

        await fulfillment(of: [didFinishNavigation, didReceiveRunRequest], timeout: 10)

        let result = try await webView.evaluateJavaScript("document.body.dataset.result")
        XCTAssertEqual(result as? String, "ok:ok")
        let requests = capture.requests
        XCTAssertEqual(requests.count, 2)
        let getRequest = try XCTUnwrap(requests.first(where: { $0.httpMethod == "GET" }))
        XCTAssertEqual(getRequest.url?.path, "/run/health")
        let postRequest = try XCTUnwrap(requests.first(where: { $0.httpMethod == "POST" }))
        XCTAssertEqual(postRequest.url?.path, "/run/health")
        XCTAssertEqual(postRequest.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(
            postRequest.httpBody.flatMap { String(data: $0, encoding: .utf8) }, "{\"ping\":true}"
        )

        webView.stopLoading()
        webView.navigationDelegate = nil
    }
}

private final class IntegrationSchemeHandler: NSObject, WKURLSchemeHandler {
    var onRunRequest: ((URLRequest) -> Void)?

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(TestWebViewError.invalidRequest)
            return
        }

        switch url.path {
        case "/client.js":
            respond(
                to: urlSchemeTask,
                body: """
                    Promise.all([
                      fetch("/health"),
                      fetch("/health", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ping: true }) })
                    ])
                      .then(async ([read, write]) => (await read.text()) + ":" + (await write.text()))
                      .then((text) => { document.body.dataset.result = text })
                      .catch(() => { document.body.dataset.result = "failed" })
                    """,
                mimeType: "text/javascript"
            )
        case "/run/health":
            onRunRequest?(urlSchemeTask.request)
            respond(to: urlSchemeTask, body: "ok", mimeType: "text/plain")
        default:
            urlSchemeTask.didFailWithError(TestWebViewError.unexpectedPath)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func respond(to task: WKURLSchemeTask, body: String, mimeType: String) {
        guard let url = task.request.url, let data = body.data(using: .utf8) else {
            task.didFailWithError(TestWebViewError.invalidResponse)
            return
        }
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "\(mimeType); charset=utf-8"]
        )!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }
}

private final class IntegrationNavigationDelegate: NSObject, WKNavigationDelegate {
    let onFinish: () -> Void

    init(onFinish: @escaping () -> Void) {
        self.onFinish = onFinish
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        onFinish()
    }
}

private final class RunRequestCapture {
    private let lock = NSLock()
    private(set) var requests: [URLRequest] = []

    func store(_ request: URLRequest) {
        lock.lock()
        requests.append(request)
        lock.unlock()
    }
}

private enum TestWebViewError: Error {
    case invalidRequest
    case unexpectedPath
    case invalidResponse
}
#endif
