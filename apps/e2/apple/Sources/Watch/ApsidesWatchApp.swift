import ApsidesCore
import SwiftUI

@main
struct ApsidesWatchApp: App {
    @StateObject private var store = WatchStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            WatchTodayView(store: store)
                .tint(Color(red: 0.61, green: 0.81, blue: 0.85))
                .task { store.start() }
                .onChange(of: scenePhase) { _, phase in if phase == .active { store.start() } }
        }
    }
}

private struct WatchTodayView: View {
    @ObservedObject var store: WatchStore

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { WatchCaptureView(store: store) } label: {
                        Label("Capture a thought", systemImage: "mic")
                    }
                    .disabled(!store.ready)
                    if store.lastSavedID != nil {
                        Label("Saved on Watch", systemImage: "checkmark.circle.fill")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("Up next") {
                    TimelineView(.periodic(from: .now, by: 60)) { timeline in
                        if let snapshot = store.vault.context, snapshot.day == DayIdentity.key(timeline.date) {
                            if let event = snapshot.nextEvent(at: timeline.date) {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(event.title).font(.headline)
                                    if let start = event.start { Text(start, style: .time).foregroundStyle(.secondary) }
                                }
                            } else { Text("No more timed events in this agenda.").foregroundStyle(.secondary) }
                            Text("Updated \(snapshot.fetchedAt.formatted(date: .omitted, time: .shortened)) on iPhone")
                                .font(.caption2).foregroundStyle(.secondary)
                        } else {
                            Text("Open Apsides on iPhone to send today’s agenda.").foregroundStyle(.secondary)
                        }
                    }
                }
                if !store.vault.captures.isEmpty {
                    Section("Recent captures") {
                        ForEach(store.vault.captures.sorted { $0.createdAt > $1.createdAt }.prefix(5)) { capture in
                            NavigationLink { WatchCaptureDetail(capture: capture, store: store) } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(capture.text).lineLimit(2)
                                    Text(store.vault.phoneReceipts.contains(capture.id) ? "Received on iPhone" : "Saved here · waiting for iPhone")
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                        if store.vault.captures.count > 5 {
                            NavigationLink("All captures") { WatchAllCaptures(store: store) }
                        }
                    }
                }
                if let error = store.error { Text(error).foregroundStyle(.red); Button("Retry") { store.start() } }
            }
            .navigationTitle("Today")
            .sensoryFeedback(.success, trigger: store.lastSavedID)
        }
    }
}

private struct WatchCaptureView: View {
    @ObservedObject var store: WatchStore
    @State private var text = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            TextField("What’s on your mind?", text: $text, axis: .vertical)
                .onChange(of: text) { _, value in store.updateDraft(value) }
            Button("Save capture", systemImage: "checkmark") {
                if store.capture(text) { dismiss() }
            }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.ready)
            Text("Saved on your watch first. Sent when iPhone is available.").font(.caption2).foregroundStyle(.secondary)
            if let error = store.error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Capture")
        .onAppear { text = store.vault.captureDraft }
    }
}

private struct WatchCaptureDetail: View {
    let capture: Capture
    @ObservedObject var store: WatchStore
    private var received: Bool { store.vault.phoneReceipts.contains(capture.id) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(capture.text)
                Text(capture.createdAt, format: .dateTime.month().day().hour().minute()).font(.caption2).foregroundStyle(.secondary)
                Label(received ? "Received on iPhone" : "Saved here · waiting for iPhone", systemImage: received ? "checkmark.circle" : "clock")
                    .font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading).padding()
        }.navigationTitle("Capture")
    }
}

private struct WatchAllCaptures: View {
    @ObservedObject var store: WatchStore
    var body: some View {
        List(store.vault.captures.sorted { $0.createdAt > $1.createdAt }) { capture in
            NavigationLink { WatchCaptureDetail(capture: capture, store: store) } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(capture.text).lineLimit(2)
                    Text(capture.createdAt, format: .dateTime.month().day()).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }.navigationTitle("Captures")
    }
}
