import EnchiridionCore
import SwiftUI
import WebKit

/// An inline component as it appears in the flow of a paragraph.
struct NoteComponentCard: View {
    let component: NoteComponent
    let theme: EnchiridionTheme
    let edit: () -> Void
    let delete: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: symbol).foregroundStyle(theme.accent)
                Text(component.title).font(.subheadline.weight(.medium)).lineLimit(1)
                Spacer(minLength: 8)
                if component.kind == .link, let url = component.sourceURL {
                    Button { openURL(url) } label: { Image(systemName: "arrow.up.right.square") }
                        .buttonStyle(.borderless).accessibilityLabel("Open link")
                }
                Menu {
                    Button(component.kind == .drawing ? "Edit drawing" : component.kind == .link ? "Edit link" : "Edit source", systemImage: "pencil", action: edit)
                    Button("Delete", systemImage: "trash", role: .destructive, action: delete)
                } label: {
                    Image(systemName: "ellipsis.circle").frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .menuStyle(.button).buttonStyle(.plain).accessibilityLabel("Component actions")
            }
            .padding(.horizontal, 12).frame(height: 40)
            Divider()
            body(for: component)
                .contentShape(Rectangle())
                .onTapGesture(perform: edit)
        }
        .background(theme.base, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(theme.secondary.opacity(0.3)))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(kindLabel): \(component.title)")
    }

    private var symbol: String {
        switch component.kind {
        case .diagram, .mermaid: "point.3.connected.trianglepath.dotted"
        case .drawing: "pencil.tip.crop.circle"
        case .link: component.metadata?.playback != nil ? "play.rectangle" : "link"
        }
    }

    private var kindLabel: String {
        switch component.kind {
        case .diagram: "D2 diagram"
        case .mermaid: "Mermaid diagram"
        case .drawing: "Drawing"
        case .link: "Link"
        }
    }

    @ViewBuilder private func body(for component: NoteComponent) -> some View {
        switch component.kind {
        case .diagram, .mermaid:
            if let svg = component.svg, !svg.isEmpty {
                SVGView(svg: svg).frame(height: 240).allowsHitTesting(false)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text(component.source).font(.system(size: 13, design: .monospaced)).lineLimit(8)
                    Text("Not rendered yet. Open the note on the web to render this diagram; the source is saved.")
                        .font(.caption).foregroundStyle(theme.secondary)
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            }
        case .drawing:
            DrawingSurface(document: component.drawing ?? DrawingDocument(), theme: theme)
                .aspectRatio(DrawingDocument.worldWidth / DrawingDocument.worldHeight, contentMode: .fit)
                .allowsHitTesting(false)
                .accessibilityLabel("Drawing with \(component.drawing?.elements.count ?? 0) elements")
        case .link:
            HStack(alignment: .top, spacing: 12) {
                if let image = component.metadata?.imageURL.flatMap({ NoteValidation.httpURL($0) }) {
                    AsyncImage(url: image) { phase in
                        if let image = phase.image { image.resizable().scaledToFill() } else { Rectangle().fill(theme.ink.opacity(0.06)) }
                    }
                    .frame(width: 80, height: 62).clipShape(RoundedRectangle(cornerRadius: 6))
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(component.metadata?.title ?? component.title).font(.subheadline.weight(.medium)).lineLimit(2)
                    Text(component.sourceURL?.host() ?? component.source).font(.caption).foregroundStyle(theme.secondary).lineLimit(1)
                    if let summary = component.metadata?.summary { Text(summary).font(.caption).foregroundStyle(theme.secondary).lineLimit(2) }
                    if let playback = component.metadata?.playback {
                        Label(playback.url.contains("embed") ? "Embedded player opens in your browser" : "Video opens in your browser", systemImage: "play.rectangle")
                            .font(.caption).foregroundStyle(theme.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(12)
        }
    }
}

/// Renders cached SVG with scripting disabled. WebKit is the only SVG renderer common to both platforms.
@MainActor
struct SVGView {
    let svg: String

    private func configure() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = NoNavigation.shared
        #if os(iOS)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false
        web.scrollView.backgroundColor = .clear
        #else
        web.setValue(false, forKey: "drawsBackground")
        #endif
        return web
    }

    private func load(_ web: WKWebView, coordinator: Coordinator) {
        guard coordinator.loaded != svg else { return }
        coordinator.loaded = svg
        web.loadHTMLString("""
        <!doctype html><html><head><meta name="color-scheme" content="light dark"><meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
        <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}body{display:flex;align-items:center;justify-content:center}svg{max-width:96%;max-height:94%;width:100%;height:100%}</style></head><body>\(svg)</body></html>
        """, baseURL: nil)
    }

    final class Coordinator { var loaded: String? }

    @MainActor
    private final class NoNavigation: NSObject, WKNavigationDelegate {
        static let shared = NoNavigation()
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.navigationType == .other ? .allow : .cancel)
        }
    }
}

#if os(macOS)
extension SVGView: NSViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> WKWebView { configure() }
    func updateNSView(_ web: WKWebView, context: Context) { load(web, coordinator: context.coordinator) }
}
#else
extension SVGView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView { configure() }
    func updateUIView(_ web: WKWebView, context: Context) { load(web, coordinator: context.coordinator) }
}
#endif

// MARK: - Editors

struct NoteComponentEditor: View {
    let component: NoteComponent
    let theme: EnchiridionTheme
    let onSave: (NoteComponent) -> Void
    let onCancel: () -> Void

    var body: some View {
        Group {
            switch component.kind {
            case .diagram, .mermaid: DiagramEditor(component: component, theme: theme, onSave: onSave, onCancel: onCancel)
            case .drawing: DrawingEditor(component: component, theme: theme, onSave: onSave, onCancel: onCancel)
            case .link: LinkEditor(component: component, onSave: onSave, onCancel: onCancel)
            }
        }
        .tint(theme.accent)
        #if os(macOS)
        .frame(minWidth: 640, minHeight: 520)
        #endif
    }
}

/// Edits diagram source. Rendering to SVG still happens on the web: changing the
/// source drops the cached image so the web renders it again, and the note says so.
struct DiagramEditor: View {
    let component: NoteComponent
    let theme: EnchiridionTheme
    let onSave: (NoteComponent) -> Void
    let onCancel: () -> Void
    @State private var title: String
    @State private var source: String

    init(component: NoteComponent, theme: EnchiridionTheme, onSave: @escaping (NoteComponent) -> Void, onCancel: @escaping () -> Void) {
        self.component = component; self.theme = theme; self.onSave = onSave; self.onCancel = onCancel
        _title = State(initialValue: component.title)
        _source = State(initialValue: component.source)
    }

    private var language: String { component.kind == .mermaid ? "Mermaid" : "D2" }
    private var sourceChanged: Bool { source != component.source }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                }
                Section("\(language) source") {
                    TextEditor(text: $source)
                        .font(.system(size: 13, design: .monospaced))
                        .autocorrectionDisabled()
                        .frame(minHeight: 180)
                        .accessibilityLabel("\(language) source")
                }
                Section("Preview") {
                    if let svg = component.svg, !svg.isEmpty, !sourceChanged {
                        SVGView(svg: svg).frame(height: 240)
                    } else {
                        Text(sourceChanged ? "Changed source is rendered the next time this note opens on the web. The source is saved now."
                             : "No rendered preview yet. The web editor renders \(language) and stores the image with the note.")
                            .font(.callout).foregroundStyle(theme.secondary)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Edit \(language) diagram")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var updated = component
                        updated.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
                        if updated.title.isEmpty { updated.title = "\(language) diagram" }
                        updated.source = source
                        if sourceChanged { updated.svg = nil }
                        onSave(updated)
                    }
                    .disabled(source.utf16.count > 200_000)
                }
            }
        }
    }
}

struct LinkEditor: View {
    let component: NoteComponent
    let onSave: (NoteComponent) -> Void
    let onCancel: () -> Void
    @State private var source: String
    @State private var title: String

    init(component: NoteComponent, onSave: @escaping (NoteComponent) -> Void, onCancel: @escaping () -> Void) {
        self.component = component; self.onSave = onSave; self.onCancel = onCancel
        _source = State(initialValue: component.source)
        _title = State(initialValue: component.title)
    }

    private var url: URL? { NoteValidation.httpURL(source.trimmingCharacters(in: .whitespacesAndNewlines)) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://example.com", text: $source)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL).textInputAutocapitalization(.never)
                        #endif
                    TextField("Title", text: $title)
                } footer: {
                    Text(url == nil && !source.isEmpty ? "Use an absolute HTTP(S) address without credentials."
                         : "Previews and players are discovered when the note is opened on the web; an existing preview is kept while the address is unchanged.")
                }
                if let metadata = component.metadata, source == component.source {
                    Section("Saved preview") {
                        Text(metadata.title).font(.headline)
                        if let summary = metadata.summary { Text(summary).font(.callout) }
                        if metadata.playback != nil { Label("Player available", systemImage: "play.rectangle").font(.caption) }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Embed a link")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard let url else { return }
                        var updated = component
                        updated.source = url.absoluteString
                        updated.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
                        if updated.title.isEmpty { updated.title = component.metadata?.title ?? url.host() ?? "Link" }
                        if source != component.source { updated.metadata = nil }
                        onSave(updated)
                    }
                    .disabled(url == nil)
                }
            }
        }
    }
}
