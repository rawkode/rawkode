import ApsidesCore
import SwiftUI

struct CaptureSheet: View {
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @ObservedObject var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Keep the thought.").font(.system(.title, design: .serif))
                TextEditor(text: Binding(get: { store.vault.captureDraft }, set: { text in store.mutate { $0.captureDraft = text } }))
                    .scrollContentBackground(.hidden)
                    .focused($focused).font(.body).frame(minHeight: 180)
                    .accessibilityLabel("Capture text").accessibilityIdentifier("captureText")
                if let error = store.storageError { Text(error).foregroundStyle(.red).font(.callout) }
                Text("Your draft stays here if you close this window.").font(.caption).foregroundStyle(theme.secondary)
            }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(theme.canvas).foregroundStyle(theme.ink)
            .navigationTitle("Quick capture")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { if store.saveCapture() { dismiss() } }
                        .buttonStyle(.glassProminent)
                        .disabled(store.vault.captureDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isReadOnly)
                        .keyboardShortcut(.return, modifiers: .command).accessibilityIdentifier("saveCapture")
                }
            }
        }
        #if os(macOS)
        .frame(width: 520, height: 380)
        #endif
        .onAppear { focused = true }
    }
}
struct CaptureListView: View {
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @ObservedObject var store: WorkspaceStore
    @State private var query = ""
    var filtered: [Capture] { store.captures.filter { query.isEmpty || $0.text.localizedCaseInsensitiveContains(query) } }
    var body: some View {
        Group {
            if store.captures.isEmpty {
                ContentUnavailableView { Label("A place for passing thoughts", systemImage: "tray") } description: { Text("Capture now. Make sense of it when you have time.") } actions: { Button("Capture a thought") { store.capturePresented = true }.buttonStyle(.glassProminent) }
            } else {
                List(filtered) { capture in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(capture.text).textSelection(.enabled).font(.body)
                        Text(capture.createdAt.formatted(date: .abbreviated, time: .shortened) + " · " + capture.source.rawValue.capitalized)
                            .font(.caption).foregroundStyle(theme.secondary)
                        if store.vault.uploaded.contains(capture.id) { Text(capture.source == .workspace ? "From workspace" : "Sent to workspace").font(.caption).foregroundStyle(theme.secondary) }
                        HStack(spacing: 20) {
                            Button("Add to device notes") { store.addToToday(capture) }
                            Spacer()
                            Menu {
                                ShareLink(item: capture.text)
                                if capture.source != .workspace && !store.vault.uploaded.contains(capture.id) {
                                    Button(store.sending.contains(capture.id) ? "Sending…" : "Send to workspace", systemImage: "icloud.and.arrow.up") { Task { await store.send(capture) } }.disabled(store.sending.contains(capture.id))
                                }
                            } label: { Label("More actions", systemImage: "ellipsis") }.labelStyle(.iconOnly)
                        }.font(.callout).buttonStyle(.borderless)
                    }.padding(.vertical, 8).listRowBackground(theme.canvas)
                }.scrollContentBackground(.hidden).searchable(text: $query, prompt: "Find a thought")
            }
        }.background(theme.base).foregroundStyle(theme.ink).navigationTitle("Captures")
        .safeAreaInset(edge: .bottom) { if let error = store.connectionError { Text(error).font(.callout).padding().background(.regularMaterial) } }
    }
}
