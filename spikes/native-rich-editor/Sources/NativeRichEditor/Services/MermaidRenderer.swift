import Foundation
import WebKit

@MainActor
enum MermaidRenderer {
    enum RenderError: LocalizedError {
        case missingLibrary, sourceTooLarge, timedOut, invalidOutput
        case compilation(String)

        var errorDescription: String? {
            switch self {
            case .missingLibrary:
                return "Mermaid is not installed. Run script/setup_mermaid.sh, then rebuild the app."
            case .sourceTooLarge:
                return "This spike supports diagrams up to 200 KB of source."
            case .timedOut:
                return "The Mermaid diagram took too long to render. Simplify it and try again."
            case .invalidOutput:
                return "Mermaid did not produce a supported SVG."
            case .compilation(let diagnostic):
                return diagnostic
            }
        }
    }

    static func render(source: String) async throws -> String {
        try Task.checkCancellation()
        guard source.utf8.count <= 200_000 else { throw RenderError.sourceTooLarge }
        let worker = Worker()
        return try await withTaskCancellationHandler {
            try await worker.render(source: source)
        } onCancel: {
            Task { @MainActor in worker.finish(.failure(CancellationError())) }
        }
    }

    private static func libraryURL() throws -> URL {
        var candidates: [URL] = []
        if let resources = Bundle.main.resourceURL {
            candidates.append(resources.appendingPathComponent("mermaid.min.js"))
        }
        candidates.append(URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent(".tools/mermaid.min.js"))
        guard let library = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
            throw RenderError.missingLibrary
        }
        return library
    }

    private final class Worker: NSObject, WKNavigationDelegate {
        private var webView: WKWebView?
        private var continuation: CheckedContinuation<String, Error>?
        private var timeout: Task<Void, Never>?
        private var source = ""

        func render(source: String) async throws -> String {
            let library = try String(contentsOf: MermaidRenderer.libraryURL(), encoding: .utf8)
            try Task.checkCancellation()
            self.source = source
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.userContentController.addUserScript(WKUserScript(
                source: library, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
            let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 900, height: 600), configuration: configuration)
            view.navigationDelegate = self
            webView = view
            return try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                timeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(15)) }
                    catch { return }
                    self?.finish(.failure(RenderError.timedOut))
                }
                view.loadHTMLString("""
                <!doctype html><html><head><meta charset="utf-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none';">
                <style>body { margin: 0; font-family: -apple-system, sans-serif; }</style>
                </head><body></body></html>
                """, baseURL: nil)
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard continuation != nil else { return }
            webView.callAsyncJavaScript("""
                try {
                mermaid.initialize({
                    startOnLoad: false, securityLevel: 'strict', theme: 'default',
                    maxTextSize: 200000, maxEdges: 1000,
                    flowchart: { htmlLabels: false },
                    fontFamily: '-apple-system, sans-serif',
                    secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering']
                });
                const result = await mermaid.render('nativeNoteDiagram', source);
                return result.svg;
                } catch (error) { return { error: String(error) }; }
                """, arguments: ["source": source], in: nil, in: .page) { [weak self] result in
                    guard let self else { return }
                    switch result {
                    case .success(let value):
                        if let diagnostic = value as? [String: String], let message = diagnostic["error"] {
                            self.finish(.failure(RenderError.compilation(message)))
                            return
                        }
                        guard let svg = value as? String, svg.utf8.count <= 8_000_000,
                              svg.contains("<svg"), svg.contains("</svg>") else {
                            self.finish(.failure(RenderError.invalidOutput))
                            return
                        }
                        self.finish(.success(svg))
                    case .failure(let error):
                        self.finish(.failure(RenderError.compilation(error.localizedDescription)))
                    }
                }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            finish(.failure(error))
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            finish(.failure(error))
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            finish(.failure(RenderError.compilation("The Mermaid renderer stopped. Try rendering again.")))
        }

        func finish(_ result: Result<String, Error>) {
            guard let pending = continuation else { return }
            continuation = nil
            timeout?.cancel()
            timeout = nil
            webView?.navigationDelegate = nil
            webView?.stopLoading()
            webView?.configuration.userContentController.removeAllUserScripts()
            webView = nil
            pending.resume(with: result)
        }
    }
}
