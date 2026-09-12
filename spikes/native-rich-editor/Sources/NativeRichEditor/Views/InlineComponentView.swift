import SwiftUI
import WebKit

struct InlineComponentView: View {
    let component: Component
    var edit: () -> Void
    @State private var automaticSVG: String?
    @State private var renderError: String?

    var body: some View {
        Group {
            if component.kind == .link {
                InlineLinkView(component: component, edit: edit)
            } else {
                VStack(spacing: 0) {
                    HStack {
                        Label(component.title, systemImage: component.kind != .drawing ? "point.3.connected.trianglepath.dotted" : "pencil.tip.crop.circle")
                            .font(.system(size: 12, weight: .medium))
                        Spacer()
                        Button(action: edit) { Label(component.kind != .drawing ? "Edit source" : "Edit drawing", systemImage: "pencil") }
                            .buttonStyle(.borderless)
                    }
                    .padding(.horizontal, 16).frame(height: 40)
                    Divider()
                    ZStack {
                        if component.kind != .drawing {
                            if let svg = component.svg ?? automaticSVG {
                                SVGPreview(svg: svg).allowsHitTesting(false)
                            } else {
                                VStack(alignment: .leading, spacing: 12) {
                                    Text(component.source).font(.system(size: 13, design: .monospaced)).lineLimit(6)
                                    Label("Click to edit and render", systemImage: "pencil").font(.caption).foregroundStyle(.secondary)
                                    if let renderError { Text(renderError).font(.caption).foregroundStyle(.red).lineLimit(2) }
                                }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                            }
                        } else {
                            DrawingPreview(document: component.drawing ?? DrawingDocument()).allowsHitTesting(false)
                        }
                        Color.clear.contentShape(Rectangle()).onTapGesture(perform: edit)
                    }
                }
                .background(.background)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary, lineWidth: 1))
            }
        }
        .padding(.vertical, 5)
        .task(id: component.source) {
            guard component.svg == nil, component.kind == .diagram || component.kind == .mermaid else { return }
            do {
                automaticSVG = try await component.kind == .diagram ? D2Renderer.render(source: component.source) : MermaidRenderer.render(source: component.source)
            } catch is CancellationError {} catch { renderError = error.localizedDescription }
        }
    }
}

struct SVGPreview: NSViewRepresentable {
    let svg: String
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = context.coordinator
        web.setValue(false, forKey: "drawsBackground")
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        guard context.coordinator.lastSVG != svg else { return }
        context.coordinator.lastSVG = svg
        web.loadHTMLString("""
        <!doctype html><html><head><meta name="color-scheme" content="light dark">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
        <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}body{display:flex;align-items:center;justify-content:center}svg{max-width:96%;max-height:94%;width:100%;height:100%}</style></head><body>\(svg)</body></html>
        """, baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var lastSVG: String?
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.navigationType == .linkActivated ? .cancel : .allow)
        }
    }
}
