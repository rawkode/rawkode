import SwiftUI
import WebKit

/// The website owns document content; the app owns navigation and capture.
struct TodayView: View {
    @ObservedObject var store: WorkspaceStore
    let showAgenda: () -> Void
    @StateObject private var editor: WebEditorController
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn

    init(store: WorkspaceStore, showAgenda: @escaping () -> Void, editor: WebEditorController? = nil) {
        self.store = store
        self.showAgenda = showAgenda
        _editor = StateObject(wrappedValue: editor ?? WebEditorController(session: store.session))
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            theme.canvas.ignoresSafeArea()
            if let error = editor.error {
                ContentUnavailableView {
                    Label("Unable to open your notebook", systemImage: "book.closed")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try again") { editor.load() }.buttonStyle(.borderedProminent)
                    Button("Account settings") { store.settingsPresented = true }
                }
            } else {
                EditorWebSurface(webView: editor.webView)
                    .opacity(editor.loading ? 0 : 1)
                if editor.loading {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("Opening your notebook").font(.system(.title2, design: .serif))
                        ProgressView().tint(theme.accent)
                    }.padding(24).foregroundStyle(theme.ink)
                }
            }
        }
        .safeAreaInset(edge: .top) {
            if editor.previousDayNeedsSave {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Previous day’s note").font(.headline)
                    Text("Finish saving this note before opening today.").font(.caption)
                    Button("Open today") { editor.start() }
                }.padding().frame(maxWidth: .infinity, alignment: .leading).background(theme.base)
            }
        }
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(theme.canvas, for: .navigationBar)
        #endif
        .onAppear { editor.applyTheme(theme); editor.start() }
        .onChange(of: theme) { _, value in editor.applyTheme(value) }
        .onChange(of: editor.finishedLoads) { _, _ in Task { await store.refresh() } }
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
