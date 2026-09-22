import SwiftUI

struct DiagramEditor: View {
    let component: Component
    let onSave: (Component) -> Void
    let onCancel: () -> Void

    @State private var title: String
    @State private var source: String
    @State private var renderedSource: String?
    @State private var renderedSVG: String?
    @State private var error: String?
    @State private var isRendering = false
    @State private var renderTask: Task<Void, Never>?

    init(component: Component, onSave: @escaping (Component) -> Void, onCancel: @escaping () -> Void) {
        self.component = component
        self.onSave = onSave
        self.onCancel = onCancel
        _title = State(initialValue: component.title)
        _source = State(initialValue: component.source)
        _renderedSource = State(initialValue: component.svg == nil ? nil : component.source)
        _renderedSVG = State(initialValue: component.svg)
    }

    private var canSave: Bool {
        renderedSVG != nil && renderedSource == source && !isRendering
    }

    private var language: String { component.kind == .mermaid ? "Mermaid" : "D2" }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.title2).foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Edit diagram").font(.headline)
                    Text("Write \(language) source, then preview your changes.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(20)
            Divider()
            HSplitView {
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Diagram title", text: $title).textFieldStyle(.roundedBorder)
                    Text("SOURCE").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    DiagramSourceEditor(source: $source, language: language)
                        .padding(8)
                        .background(.background, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
                        .accessibilityLabel("\(language) source")
                    HStack {
                        Text("⌘ Return to render").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("Render preview", systemImage: "play.fill", action: renderPreview)
                            .keyboardShortcut(.return, modifiers: .command)
                            .disabled(isRendering)
                    }
                }
                .padding(20)
                .frame(minWidth: 340, idealWidth: 400)

                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("PREVIEW").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Spacer()
                        if isRendering { ProgressView().controlSize(.small) }
                        else if renderedSource != source {
                            Text("Changes not rendered").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if let renderedSVG {
                        SVGPreview(svg: renderedSVG)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    } else {
                        ContentUnavailableView("Diagram preview", systemImage: "point.3.connected.trianglepath.dotted",
                                               description: Text("Render the source to see your diagram."))
                    }
                    if let error {
                        ScrollView {
                            Text(error).font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(.red).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 110)
                        .accessibilityLabel("\(language) error: \(error)")
                    }
                }
                .padding(20)
                .frame(minWidth: 340, maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider()
            HStack {
                Text("The source stays editable in your note.")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
                Button("Save diagram", action: save).buttonStyle(.borderedProminent)
                    .disabled(!canSave)
            }
            .padding(16)
        }
        .frame(width: 920, height: 620)
        .onAppear { if renderedSVG == nil { renderPreview() } }
        .onDisappear { renderTask?.cancel() }
        .onChange(of: source) { _, _ in error = nil }
    }

    private func renderPreview() {
        guard !isRendering else { return }
        let snapshot = source
        isRendering = true
        error = nil
        renderTask = Task { @MainActor in
            defer { isRendering = false }
            do {
                let svg: String
                if component.kind == .mermaid {
                    svg = try await MermaidRenderer.render(source: snapshot)
                } else {
                    svg = try await D2Renderer.render(source: snapshot)
                }
                guard !Task.isCancelled, source == snapshot else { return }
                renderedSource = snapshot
                renderedSVG = svg
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, source == snapshot else { return }
                self.error = error.localizedDescription
            }
        }
    }

    private func save() {
        guard canSave, let renderedSVG else { return }
        var updated = component
        updated.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if updated.title.isEmpty { updated.title = "Diagram" }
        updated.source = source
        updated.svg = renderedSVG
        onSave(updated)
    }
}

private struct DiagramSourceEditor: NSViewRepresentable {
    @Binding var source: String
    let language: String

    func makeCoordinator() -> Coordinator { Coordinator(source: $source) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        let textView = scrollView.documentView as! NSTextView
        textView.isRichText = false
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.textContainerInset = NSSize(width: 5, height: 7)
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isContinuousSpellCheckingEnabled = false
        textView.string = source
        textView.delegate = context.coordinator
        textView.setAccessibilityLabel("\(language) source")
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.source = $source
        guard let textView = scrollView.documentView as? NSTextView, textView.string != source else { return }
        textView.string = source
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var source: Binding<String>
        init(source: Binding<String>) { self.source = source }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            source.wrappedValue = textView.string
        }
    }
}
