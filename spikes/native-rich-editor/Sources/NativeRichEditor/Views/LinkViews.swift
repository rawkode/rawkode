import AppKit
import AVKit
import SwiftUI
import WebKit

struct LinkEditor: View {
    let component: Component
    let onSave: (Component) -> Void
    let onCancel: () -> Void
    @State private var source: String
    @State private var title: String
    @State private var metadata: LinkMetadata?
    @State private var status = "Fetch a preview to discover a title, image, and available player."
    @State private var isLoading = false
    @State private var fetchTask: Task<Void, Never>?

    init(component: Component, onSave: @escaping (Component) -> Void, onCancel: @escaping () -> Void) {
        self.component = component
        self.onSave = onSave
        self.onCancel = onCancel
        _source = State(initialValue: component.source)
        _title = State(initialValue: component.title)
        _metadata = State(initialValue: component.metadata)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Embed a link").font(.title2.weight(.semibold))
            Text("Web pages become preview cards. Links that advertise a video player can play inside your note.")
                .foregroundStyle(.secondary)
            TextField("https://example.com", text: $source)
                .textFieldStyle(.roundedBorder)
                .onChange(of: source) {
                    fetchTask?.cancel()
                    metadata = nil
                    isLoading = false
                    status = "URL changed. Fetch a new preview, or save as a plain link card."
                }
            TextField("Title", text: $title).textFieldStyle(.roundedBorder)
            HStack {
                Button("Fetch Preview", action: fetchPreview)
                    .disabled(LinkMetadataResolver.validatedURL(source) == nil || isLoading)
                if isLoading { ProgressView().controlSize(.small) }
                Spacer()
            }
            Text(status).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            if let metadata {
                HStack(alignment: .top, spacing: 12) {
                    LinkThumbnail(url: metadata.imageURL).frame(width: 88, height: 66)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(metadata.title).font(.headline).lineLimit(2)
                        if let summary = metadata.summary { Text(summary).font(.caption).lineLimit(3) }
                        Label(metadata.hasPlayableVideo ? "Inline player available" : "Link preview", systemImage: metadata.hasPlayableVideo ? "play.rectangle" : "link")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(12).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
            }
            Spacer(minLength: 0)
            HStack {
                Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
                Spacer()
                Button("Save Link") {
                    guard let url = LinkMetadataResolver.validatedURL(source) else { return }
                    var result = component
                    result.source = url.absoluteString
                    result.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
                    if result.title.isEmpty { result.title = metadata?.title ?? url.host ?? "Link" }
                    result.metadata = metadata
                    onSave(result)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(LinkMetadataResolver.validatedURL(source) == nil || isLoading)
            }
        }
        .padding(24)
        .frame(width: 540, height: 420)
        .onDisappear { fetchTask?.cancel() }
    }

    private func fetchPreview() {
        fetchTask?.cancel()
        let requestedSource = source
        isLoading = true
        status = "Reading the website’s metadata…"
        fetchTask = Task { @MainActor in
            do {
                let result = try await LinkMetadataResolver.resolve(requestedSource)
                guard !Task.isCancelled, source == requestedSource else { return }
                metadata = result
                if title.isEmpty || title == component.title { title = result.title }
                status = result.discoveryNote ?? (result.hasPlayableVideo ? "Player discovered. It will load only when you click Play in the note." : "Preview ready. This page does not advertise a supported inline player.")
            } catch {
                guard !Task.isCancelled, source == requestedSource else { return }
                status = "Preview unavailable: \(error.localizedDescription) You can still save the link."
            }
            isLoading = false
        }
    }
}

struct InlineLinkView: View {
    let component: Component
    let edit: () -> Void
    @State private var playerLoaded = false
    @State private var playbackError: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                if component.metadata?.hasPlayableVideo != true {
                    LinkThumbnail(url: component.metadata?.imageURL).frame(width: 80, height: 62)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(component.title).font(.headline).lineLimit(1)
                    Text(LinkMetadataResolver.validatedURL(component.source)?.host ?? component.source)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    if component.metadata?.hasPlayableVideo != true, let summary = component.metadata?.summary {
                        Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                Button("Edit", action: edit).buttonStyle(.borderless)
                Button(action: openLink) { Image(systemName: "arrow.up.right.square") }
                    .buttonStyle(.borderless).help("Open link in browser")
            }
            .padding(14)
            if let playback = component.metadata?.playback {
                Divider()
                if playerLoaded {
                    InlinePlaybackView(playback: playback, failure: $playbackError)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ZStack {
                        LinkThumbnail(url: component.metadata?.imageURL)
                        Button {
                            playbackError = nil
                            playerLoaded = true
                        } label: {
                            Label("Play video", systemImage: "play.fill").padding(.horizontal, 10).padding(.vertical, 5)
                        }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                if let playbackError {
                    HStack {
                        Text(playbackError).font(.caption).lineLimit(2)
                        Spacer()
                        Button("Open Link", action: openLink).controlSize(.small)
                    }.padding(8)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(.background)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
    }

    private func openLink() {
        if let url = LinkMetadataResolver.validatedURL(component.source) { NSWorkspace.shared.open(url) }
    }
}

private struct LinkThumbnail: View {
    let url: URL?
    var body: some View {
        AsyncImage(url: url.flatMap { LinkMetadataResolver.validatedURL($0.absoluteString) }) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                Rectangle().fill(.quaternary.opacity(0.5))
                    .overlay { Image(systemName: "link").font(.title2).foregroundStyle(.secondary) }
            }
        }
        .clipped()
    }
}

private struct InlinePlaybackView: View {
    let playback: LinkMetadata.Playback
    @Binding var failure: String?
    var body: some View {
        switch playback {
        case .directVideo(let url): NativeVideoPlayer(url: url, failure: $failure)
        case .embedURL(let url): EmbeddedWebPlayer(url: url, failure: $failure)
        }
    }
}

/// Use AppKit directly: the macOS 27 SwiftUI VideoPlayer overlay aborts during
/// superclass metadata initialization on the host used for this spike.
struct NativeVideoPlayer: NSViewRepresentable {
    let url: URL
    @Binding var failure: String?

    func makeCoordinator() -> Coordinator { Coordinator(failure: $failure) }

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = .inline
        view.showsFullScreenToggleButton = true
        view.videoGravity = .resizeAspect
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        context.coordinator.failure = $failure
        guard context.coordinator.loadedURL != url,
              LinkMetadataResolver.validatedURL(url.absoluteString) != nil else { return }
        context.coordinator.loadedURL = url
        context.coordinator.observation = nil
        view.player?.pause()
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        view.player = player
        context.coordinator.observation = item.observe(\.status, options: [.initial, .new]) { [weak coordinator = context.coordinator, weak player] item, _ in
            guard item.status == .failed else { return }
            let message = item.error?.localizedDescription ?? "Video playback failed."
            Task { @MainActor in
                guard player?.currentItem === item else { return }
                coordinator?.failure.wrappedValue = message
            }
        }
        player.play()
    }

    static func dismantleNSView(_ view: AVPlayerView, coordinator: Coordinator) {
        coordinator.observation = nil
        view.player?.pause()
        view.player = nil
    }

    final class Coordinator {
        var loadedURL: URL?
        var observation: NSKeyValueObservation?
        var failure: Binding<String?>
        init(failure: Binding<String?>) { self.failure = failure }
    }
}

private struct EmbeddedWebPlayer: NSViewRepresentable {
    let url: URL
    @Binding var failure: String?

    func makeCoordinator() -> Coordinator { Coordinator(failure: $failure) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loadedURL != url,
              LinkMetadataResolver.validatedURL(url.absoluteString) != nil else { return }
        context.coordinator.loadedURL = url
        var request = URLRequest(url: url)
        if let bundleID = Bundle.main.bundleIdentifier {
            request.setValue("https://" + bundleID.lowercased(), forHTTPHeaderField: "Referer")
        }
        view.load(request)
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.navigationDelegate = nil
        view.stopLoading()
        view.loadHTMLString("", baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedURL: URL?
        @Binding var failure: String?
        init(failure: Binding<String?>) { _failure = failure }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            failure = "Player could not load: \(error.localizedDescription)"
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            failure = "Player could not load: \(error.localizedDescription)"
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, LinkMetadataResolver.validatedURL(url.absoluteString) != nil else {
                decisionHandler(.cancel)
                return
            }
            if action.navigationType == .linkActivated, action.targetFrame?.isMainFrame != false {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
            } else { decisionHandler(.allow) }
        }
    }
}
