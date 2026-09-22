import SwiftUI
import WebKit
import UniformTypeIdentifiers

@main
struct FieldnotesWebApp: App {
    @StateObject private var session = WebSession()

    var body: some Scene {
        Window("Fieldnotes · Shared web editor", id: "editor") {
            Group {
                if let error = session.startupError {
                    Text(error).padding()
                } else {
                    EditorWebView(session: session)
                }
            }
            .frame(minWidth: 700, minHeight: 600)
        }
        .defaultSize(width: 1050, height: 850)
    }
}

struct EditorWebView: NSViewRepresentable {
    let session: WebSession
    func makeNSView(context: Context) -> WKWebView { session.webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}

@MainActor
final class WebSession: NSObject, ObservableObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    @Published var startupError: String?
    private(set) var webView: WKWebView!
    private var server: AssetServer?
    private var origin: URL?
    private let saveURL: URL

    override init() {
        let directory = ProcessInfo.processInfo.environment["FIELDNOTES_WEB_DATA_DIR"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Rawkode Fieldnotes Web")
        saveURL = directory.appendingPathComponent("draft.json")
        super.init()
        let configuration = WKWebViewConfiguration()
        // Native owns persistence. No browser draft survives on the changing loopback origin.
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "fieldnotes")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isInspectable = true
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("web") else {
            startupError = "Bundled editor assets are missing."; return
        }
        do {
            server = try AssetServer(root: root) { [weak self] result in
                Task { @MainActor in
                    switch result {
                    case .success(let url):
                        self?.origin = url
                        self?.webView.load(URLRequest(url: url))
                    case .failure(let error): self?.startupError = error.localizedDescription
                    }
                }
            }
        } catch { startupError = error.localizedDescription }
    }

    private func trusted(_ url: URL?) -> Bool {
        guard let url, let origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, trusted(message.frameInfo.request.url),
              let body = message.body as? [String: Any], body["version"] as? Int == 1,
              let action = body["action"] as? String else {
            replyHandler(nil, "Untrusted or unsupported editor message"); return
        }
        do {
            switch action {
            case "load":
                if FileManager.default.fileExists(atPath: saveURL.path) {
                    let attributes = try FileManager.default.attributesOfItem(atPath: saveURL.path)
                    guard (attributes[.size] as? NSNumber)?.intValue ?? Int.max <= 17 * 1024 * 1024 else {
                        replyHandler(nil, "Saved draft exceeds size limit"); return
                    }
                    replyHandler(try JSONSerialization.jsonObject(with: Data(contentsOf: saveURL)), nil)
                } else { replyHandler(NSNull(), nil) }
            case "save":
                guard let draft = body["draft"] as? [String: Any],
                      let filename = draft["filename"] as? String, filename.count <= 255,
                      let note = draft["note"] as? [String: Any], note["type"] as? String == "doc" else {
                    replyHandler(nil, "Invalid draft envelope"); return
                }
                let data = try JSONSerialization.data(withJSONObject: draft)
                guard data.count <= 17 * 1024 * 1024 else { replyHandler(nil, "Draft exceeds size limit"); return }
                try FileManager.default.createDirectory(at: saveURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: saveURL, options: .atomic)
                replyHandler(true, nil)
            case "export":
                guard let contents = body["contents"] as? String, contents.utf8.count <= 17 * 1024 * 1024 else {
                    replyHandler(nil, "Invalid export"); return
                }
                let panel = NSSavePanel()
                panel.nameFieldStringValue = (body["filename"] as? String).map { URL(fileURLWithPath: $0).lastPathComponent } ?? "Untitled.native-note"
                panel.canCreateDirectories = true
                panel.begin { response in
                    guard response == .OK, let url = panel.url else { replyHandler(nil, "Export cancelled"); return }
                    do { try Data(contents.utf8).write(to: url, options: .atomic); replyHandler(true, nil) }
                    catch { replyHandler(nil, error.localizedDescription) }
                }
            default: replyHandler(nil, "Unknown editor action")
            }
        } catch { replyHandler(nil, error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(.allow); return
        }
        if trusted(url) { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated, let url, ["https", "http", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame, trusted(frame.request.url) else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.begin { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        startupError = "The editor process stopped. Reopen the app to restore the last acknowledged save."
    }
}
