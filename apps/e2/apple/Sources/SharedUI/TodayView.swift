import ApsidesCore
import SwiftUI
import WebKit
import Combine

struct LocalDaybookView: View {
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize = 38
    @ObservedObject var store: WorkspaceStore
    let showAgenda: () -> Void
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center) { heading; Spacer(minLength: 18); dayPicker }
                VStack(alignment: .leading, spacing: 12) { heading; dayPicker }
            }
            if Calendar.current.isDateInToday(store.selectedDay), let snapshot = store.snapshot, snapshot.day == DayIdentity.key(.now), let event = snapshot.nextEvent(at: .now) {
                Button(action: showAgenda) { HStack(alignment: .top) {
                    Image(systemName: "calendar").foregroundStyle(theme.accent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(event.title).font(.subheadline.weight(.medium))
                        if let start = event.start { Text(start, format: .dateTime.hour().minute()).font(.caption).foregroundStyle(theme.secondary) }
                    }
                    Spacer()
                    if Date().timeIntervalSince(snapshot.fetchedAt) > 3600 { Text("Cached").font(.caption).foregroundStyle(theme.secondary) }
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(theme.secondary)
                }.padding(.vertical, 8).contentShape(Rectangle()) }.buttonStyle(.plain).accessibilityHint("Open the day calendar")
            }
            ZStack(alignment: .topLeading) {
                if store.dayText.isEmpty { Text("What’s on your mind?").foregroundStyle(theme.secondary).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false) }
                TextEditor(text: Binding(get: { store.dayText }, set: store.setDayText))
                    .font(.system(.body, design: .serif)).lineSpacing(7)
                    .scrollContentBackground(.hidden).disabled(store.isReadOnly)
                    .accessibilityLabel("Daybook editor").accessibilityIdentifier("daybookEditor")
            }
            HStack {
                Text(store.storageError == nil ? "Saved on this device" : "Changes need saving").font(.caption).foregroundStyle(theme.secondary).accessibilityIdentifier("saveStatus")
                Spacer()
                if !store.dayText.isEmpty { ShareLink(item: store.dayText) { Label("Share", systemImage: "square.and.arrow.up") }.labelStyle(.iconOnly) }
            }
        }
        .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(theme.canvas).foregroundStyle(theme.ink)
        #if os(macOS)
        .navigationTitle("Daybook")
        #else
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
    private var heading: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(store.selectedDay, format: .dateTime.weekday(.wide).day().month(.wide)).font(.subheadline).foregroundStyle(theme.secondary)
            Text(Calendar.current.isDateInToday(store.selectedDay) ? "Today" : "Daybook")
                .font(.system(size: titleSize, weight: .regular, design: .serif))
        }.fixedSize(horizontal: true, vertical: false)
    }
    private var dayPicker: some View {
        DatePicker("Day", selection: $store.selectedDay, displayedComponents: .date).labelsHidden().fixedSize()
    }
}


/// Uses the deployed editor and its existing persistence/entity contracts.
struct TodayView: View {
    @ObservedObject var store: WorkspaceStore
    let showAgenda: () -> Void
    @State private var localNotes = false
    @StateObject private var editor: WebEditorController
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn

    init(store: WorkspaceStore, showAgenda: @escaping () -> Void) {
        self.store = store
        self.showAgenda = showAgenda
        _editor = StateObject(wrappedValue: WebEditorController(session: store.session))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button("Device notes") { localNotes = true }
            }.font(.subheadline).padding(.horizontal).padding(.vertical, 8)
            if let error = editor.error {
                ContentUnavailableView {
                    Label("Editor unavailable", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(error + " Your device notes and quick capture are still available.")
                } actions: {
                    Button("Try again") { editor.load() }.buttonStyle(.borderedProminent)
                }
            } else {
                EditorWebSurface(webView: editor.webView)
                    .overlay(alignment: .top) { if editor.loading { ProgressView().padding(8).background(.regularMaterial, in: Capsule()) } }
            }
        }
        .background(theme.canvas)
        .onAppear { editor.applyTheme(theme); editor.start() }
        .onChange(of: theme) { _, value in editor.applyTheme(value) }
        .sheet(isPresented: $localNotes) {
            NavigationStack {
                LocalDaybookView(store: store, showAgenda: showAgenda)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { localNotes = false } } }
            }
        }
        .onChange(of: editor.finishedLoads) { _, _ in Task { await store.refresh() } }
    }
}

@MainActor
final class WebEditorController: NSObject, ObservableObject, WKNavigationDelegate {
    let webView: WKWebView
    private let session: NativeSession
    private var theme: ApsidesTheme = .dawn
    private var started = false
    @Published var loading = false
    @Published var error: String?
    @Published var canGoBack = false
    @Published var finishedLoads = 0

    init(session: NativeSession) {
        self.session = session
        webView = session.makeEditorWebView()
        super.init()
        webView.navigationDelegate = self
    }
    func start() {
        if webView.url?.scheme == "about" { load(); return }
        guard !started else { return }
        started = true
        if webView.url == nil { load() }
    }
    func load() {
        error = nil
        loading = true
        var components = URLComponents(url: session.origin, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "pane", value: "document:daily:" + DayIdentity.key(.now))]
        webView.load(URLRequest(url: components.url!))
    }
    func applyTheme(_ theme: ApsidesTheme) {
        self.theme = theme
        guard webView.url?.host == session.origin.host else { return }
        webView.evaluateJavaScript("document.documentElement.dataset.theme = '\(theme.rawValue)'; try { localStorage.setItem('apsides-theme', '\(theme.rawValue)'); } catch {}", completionHandler: nil)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loading = false
        error = "The editor stopped. Reconnect to reopen your saved workspace."
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        loading = true
        error = nil
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading = false
        canGoBack = webView.canGoBack
        applyTheme(theme)
        if webView.url?.host == session.origin.host { finishedLoads += 1 }
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
        guard url.scheme == "https" else { return .cancel }
        if action.targetFrame?.isMainFrame != false, !(await session.editorCanLeave()) {
            return .cancel
        }
        return .allow
    }
}

#if os(macOS)
private struct EditorWebSurface: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#else
private struct EditorWebSurface: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#endif
