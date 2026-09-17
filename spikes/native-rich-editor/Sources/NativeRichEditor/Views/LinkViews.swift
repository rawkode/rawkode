import AppKit
import AVKit
import SwiftUI

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
                status = result.discoveryNote ?? (result.hasPlayableVideo ? "Player discovered. Open the link in your browser to play it." : "Preview ready. This page does not advertise a supported player.")
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
            if component.metadata?.playback != nil {
                Divider()
                InlinePlaybackView(open: openLink)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(.background)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
    }

    private func openLink() {
        if let url = LinkMetadataResolver.validatedURL(component.source),
           LinkMetadataResolver.publicURL(url) != nil { NSWorkspace.shared.open(url) }
    }
}

private struct LinkThumbnail: View {
    let url: URL?
    @State private var image: NSImage?
    var body: some View {
        Group {
            if let image { Image(nsImage: image).resizable().scaledToFill() }
            else { Rectangle().fill(.quaternary.opacity(0.5)).overlay { Image(systemName: "link").font(.title2).foregroundStyle(.secondary) } }
        }
        .clipped()
        .task(id: url) {
            image = nil
            guard let url else { return }
            do {
                let data = try await LinkMetadataResolver.fetchImage(url)
                guard !Task.isCancelled else { return }
                image = NSImage(data: data)
            } catch { image = nil }
        }
    }
}

private struct InlinePlaybackView: View {
    let open: () -> Void
    var body: some View {
        VStack(spacing: 8) {
            Label("Inline playback opens in your browser", systemImage: "play.rectangle")
                .foregroundStyle(.secondary)
            Button("Open Link", action: open)
        }
        .padding()
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
              url.isFileURL else { return }
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
