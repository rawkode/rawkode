import ApsidesCore
import SwiftUI
import WebKit
import Combine

@MainActor
final class WebEditorController: NSObject, ObservableObject, WKNavigationDelegate {
    let webView: WKWebView
    private let session: NativeSession
    private var theme: ApsidesTheme = .dawn
    private var started = false
    private var navigationGeneration = 0
    private var hasEditorDocument = false
    @Published var loading = false
    @Published var error: String?
    @Published var finishedLoads = 0
    @Published var previousDayNeedsSave = false
    @Published private(set) var preview = ""
    private var previewIdentity: DailyNotePreview?
    private var previewSubscriptions = Set<AnyCancellable>()

    init(session: NativeSession) {
        self.session = session
        webView = session.makeEditorWebView()
        super.init()
        webView.navigationDelegate = self
        Publishers.CombineLatest(session.$accountID, session.$isConnected)
            .sink { [weak self] accountID, connected in
                guard let self else { return }
                if !connected || self.previewIdentity?.matches(accountID: accountID, day: DayIdentity.key(.now)) != true {
                    self.clearPreview()
                }
            }
            .store(in: &previewSubscriptions)
        NotificationCenter.default.publisher(for: .NSCalendarDayChanged)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.clearPreview() }
            .store(in: &previewSubscriptions)
    }

    private func clearPreview() {
        preview = ""
        previewIdentity = nil
    }

    /// Read only the currently loaded, authenticated shared note. Call after
    /// saving/closing the sheet; callers may persist the account/day-scoped result.
    @discardableResult
    func refreshPreview() async -> DailyNotePreview? {
        clearPreview()
        let day = DayIdentity.key(.now)
        guard session.isConnected, let accountID = session.accountID,
              hasEditorDocument, !loading, error == nil,
              let url = webView.url, isTodayEditor(url, day: day) else { return nil }
        let generation = navigationGeneration
        let script = """
        (() => {
          if (document.documentElement.dataset.nativeEditorVersion !== '1' ||
              document.documentElement.dataset.nativeEditor !== 'ready') return null;
          const pane = document.querySelector('.native-document.is-active');
          if (pane?.querySelector('.native-document-heading h1')?.textContent?.trim() !== 'Today') return null;
          const editor = pane.querySelector('.tiptap.ProseMirror');
          return editor instanceof HTMLElement ? editor.innerText.slice(0, 4096) : null;
        })()
        """
        let value = try? await webView.evaluateJavaScript(script)
        guard generation == navigationGeneration, session.isConnected,
              session.accountID == accountID, DayIdentity.key(.now) == day,
              webView.url == url, isTodayEditor(url, day: day),
              let text = value as? String,
              let result = DailyNotePreview(accountID: accountID, day: day, editorText: text) else { return nil }
        previewIdentity = result
        preview = result.text
        return result
    }

    private func isTodayEditor(_ url: URL, day: String) -> Bool {
        let origin = session.origin
        func port(_ value: URL) -> Int? { value.port ?? (value.scheme == "https" ? 443 : value.scheme == "http" ? 80 : nil) }
        guard url.scheme == origin.scheme, url.host == origin.host, port(url) == port(origin),
              ["/apple/editor", "/apple/editor/"].contains(url.path),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return components.queryItems?.first(where: { $0.name == "pane" })?.value == "document:daily:" + day
    }
    func start() {
        if webView.url?.scheme == "about" { load(); return }
        if started {
            Task { await refreshDayIfNeeded() }
            return
        }
        started = true
        if webView.url == nil { load() }
        else if !webView.isLoading {
            self.webView(webView, didFinish: nil)
            Task { await refreshDayIfNeeded() }
        }
    }
    private func refreshDayIfNeeded() async {
        guard let url = webView.url, url.host == session.origin.host,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let pane = components.queryItems?.first(where: { $0.name == "pane" })?.value,
              pane.hasPrefix("document:daily:"), pane != "document:daily:" + DayIdentity.key(.now) else { return }
        let generation = navigationGeneration
        guard await session.editorCanLeave() else {
            // Keep the previous day's editor visible so the user can finish saving.
            previousDayNeedsSave = true
            return
        }
        guard generation == navigationGeneration else { return }
        load()
    }
    func load() {
        clearPreview()
        previousDayNeedsSave = false
        error = nil
        loading = true
        var components = URLComponents(url: session.origin.appendingPathComponent("apple/editor"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "pane", value: "document:daily:" + DayIdentity.key(.now)), URLQueryItem(name: "theme", value: theme.rawValue)]
        webView.load(URLRequest(url: components.url!))
    }
    func applyTheme(_ theme: ApsidesTheme) {
        self.theme = theme
        #if os(iOS)
        let color = UIColor(theme.canvas)
        webView.backgroundColor = color
        webView.scrollView.backgroundColor = color
        webView.underPageBackgroundColor = color
        #endif
        guard webView.url?.host == session.origin.host else { return }
        webView.evaluateJavaScript("document.documentElement.dataset.theme = '\(theme.rawValue)'; try { localStorage.setItem('apsides-theme', '\(theme.rawValue)'); } catch {}", completionHandler: nil)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        clearPreview()
        loading = false
        error = "The editor stopped. Reconnect to reopen your saved workspace."
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        navigationGeneration += 1
        clearPreview()
        hasEditorDocument = false
        loading = true
        error = nil
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        applyTheme(theme)
        guard webView.url?.host == session.origin.host else { loading = false; return }
        let generation = navigationGeneration
        Task { @MainActor in
            let version = try? await webView.evaluateJavaScript("document.documentElement.dataset.nativeEditorVersion")
            guard generation == navigationGeneration, webView.url?.host == session.origin.host else { return }
            loading = false
            guard version as? String == "1" else {
                error = "The website needs the editor update before this app can open it. Your saved notes are unchanged."
                return
            }
            hasEditorDocument = true
            finishedLoads += 1
            await refreshPreview()
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        loading = false
        self.error = error.localizedDescription
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loading = false
        self.error = error.localizedDescription
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.absoluteString == "about:blank" { return .allow }
        if hasEditorDocument, action.navigationType == .linkActivated,
           url.host != session.origin.host || (url.path != "/apple/editor" && url.path != "/apple/editor/") {
            guard ["https", "http", "mailto"].contains(url.scheme ?? "") else { return .cancel }
            #if os(iOS)
            await UIApplication.shared.open(url)
            #else
            NSWorkspace.shared.open(url)
            #endif
            return .cancel
        }
        var allowed = url.scheme == "https"
        #if DEBUG
        allowed = allowed || (url.scheme == "http" && url.host == session.origin.host && url.port == session.origin.port)
        #endif
        guard allowed else { return .cancel }
        if action.targetFrame?.isMainFrame != false, !(await session.editorCanLeave()) {
            return .cancel
        }
        return .allow
    }
}
